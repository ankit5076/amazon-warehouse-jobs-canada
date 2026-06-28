/* Direct candidate-application workflow for application URLs. */
(async function (root) {
  'use strict';

  if (root.AMZ_DIRECT_APPLICATION?.initialized) return;

  const { AMAZON, DIRECT_APPLICATION, NOTIFICATIONS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const urls = root.AMZ_URL;
  const directApi = root.AMZ_DIRECT_API;
  const observability = root.AMZ_APPLICATION_OBSERVABILITY;
  const log = root.AMZ_LOGGER.create('[direct-application]', {
    workflow: 'direct-booking',
    source: 'content/utils/direct-application.js',
  });
  const directApplicationMode = root.AMZ_DIRECT_APPLICATION_MODE.create({ log });
  let runInFlight = null;
  const attemptLockOwnerId = [
    'direct-attempt',
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('::');
  let activeAttemptLockKey = null;
  let wafWarmupPromise = null;
  let wafWarmupContextKey = null;
  let activeAttemptClientEmail = null;

  class DirectApplicationError extends Error {
    constructor(message, metadata = {}) {
      super(message);
      this.name = 'DirectApplicationError';
      Object.assign(this, metadata);
    }
  }

  const {
    classifyError,
    getErrorCode,
    getErrorMessage,
    getErrorMetadata,
    isCaptchaResponse,
    requestBodySummary,
    responseData,
    responseShape,
    responseSummary,
  } = directApi;

  function currentContext() {
    return urls.getApplicationContextFromUrl();
  }

  function shouldPreflightWaf() {
    return DIRECT_APPLICATION.WAF_PREFLIGHT_ENABLED === true;
  }

  function queueRun(trigger = 'manual') {
    if (runInFlight) return runInFlight;
    runInFlight = run(trigger)
      .catch(error => {
        log.error('Unexpected direct application failure:', error);
      })
      .finally(() => {
        runInFlight = null;
      });
    return runInFlight;
  }

  function apiUrl(path) {
    const context = currentContext();
    return context.origin ? new URL(path, context.origin).toString() : null;
  }

  function apiUrlWithSuffix(path, suffix) {
    const base = apiUrl(path);
    return base && suffix ? base + encodeURIComponent(suffix) : base;
  }

  const PRESERVED_GUARD_FIELDS = Object.freeze([
    'applicationId',
    'candidateId',
    'currentState',
    'createHttpStatus',
    'confirmHttpStatus',
    'confirmedScheduleId',
    'reservedScheduleId',
    'clientEmail',
    'withoutSelectedSchedule',
    'fallbackWithoutSchedule',
    'fallbackOriginalScheduleId',
    'softReserveExpirationTimestamp',
  ]);
  const guardStore = root.AMZ_DIRECT_GUARD.create({
    prefix: DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
    preservedFields: PRESERVED_GUARD_FIELDS,
  });
  const BOOKING_CONFIRMED_TOAST_SESSION_KEY =
    DIRECT_APPLICATION.GUARD_STORAGE_PREFIX + '::booking-confirmed-toast';
  const BOOKING_CONFIRMED_TOAST_TTL_MS = 2 * 60 * 1000;
  const BOOKING_CONFIRMED_TOAST_DURATION_MS = 20000;
  const FORM_OPENED_NOTIFICATION_TTL_MS = 10 * 60 * 1000;
  const SUCCESS_HANDOFF_NAVIGATION_TTL_MS = 10 * 60 * 1000;
  const TERMINAL_BOOKING_SUCCESS_TTL_MS = 10 * 60 * 1000;

  function readSessionJson(key) {
    try {
      const raw = window.sessionStorage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeSessionJson(key, value) {
    try {
      window.sessionStorage?.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function removeSessionKey(key) {
    try {
      window.sessionStorage?.removeItem(key);
    } catch (_) {
      // Session storage is best-effort and must never block booking.
    }
  }

  function normalizeClientEmail(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized === 'null' || normalized === 'undefined') return '';
    return normalized;
  }

  async function resolveAttemptClientEmail() {
    try {
      const data = await storage.getLocal([
        STORAGE_KEYS.AMAZON_LOGIN_USERNAME,
        STORAGE_KEYS.USER_EMAIL,
        STORAGE_KEYS.LEGACY_USER_EMAIL,
        STORAGE_KEYS.DETECTED_EMAILS,
      ]);
      const detectedEmails = Array.isArray(data[STORAGE_KEYS.DETECTED_EMAILS])
        ? data[STORAGE_KEYS.DETECTED_EMAILS]
        : [];
      return normalizeClientEmail(
        data[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] ||
        data[STORAGE_KEYS.USER_EMAIL] ||
        data[STORAGE_KEYS.LEGACY_USER_EMAIL] ||
        detectedEmails.find(normalizeClientEmail)
      );
    } catch (error) {
      log.debug('attempt client email capture skipped', {
        error: error?.message || String(error),
      });
      return '';
    }
  }

  function attemptLockKey(context, applicationId = null) {
    return [
      DIRECT_APPLICATION.ATTEMPT_LOCK_STORAGE_PREFIX,
      context.jobId || '',
      context.scheduleId || '',
      applicationId || 'pending',
    ].join('::');
  }

  function lockTtlMs() {
    return Math.max(1000, Number(DIRECT_APPLICATION.ACTIVE_ATTEMPT_LOCK_TTL_MS) || 0);
  }

  function acquireAttemptLock(context, applicationId = null, stage = 'started') {
    const key = attemptLockKey(context, applicationId);
    const now = Date.now();
    const existing = readSessionJson(key);
    if (
      existing &&
      existing.ownerId &&
      existing.ownerId !== attemptLockOwnerId &&
      Number(existing.expiresAt) > now
    ) {
      return {
        ok: false,
        key,
        existing,
      };
    }

    writeSessionJson(key, {
      ownerId: attemptLockOwnerId,
      stage,
      jobId: context.jobId || null,
      scheduleId: context.scheduleId || null,
      applicationId: applicationId || null,
      pageUrl: context.href || window.location.href,
      updatedAt: now,
      expiresAt: now + lockTtlMs(),
    });
    activeAttemptLockKey = key;
    return { ok: true, key };
  }

  function releaseAttemptLock(key = activeAttemptLockKey) {
    if (!key) return;
    const existing = readSessionJson(key);
    if (!existing || existing.ownerId === attemptLockOwnerId) {
      removeSessionKey(key);
    }
    if (activeAttemptLockKey === key) activeAttemptLockKey = null;
  }

  function refreshAttemptLock(context, applicationId = null, stage = 'started') {
    const key = attemptLockKey(context, applicationId);
    if (activeAttemptLockKey && activeAttemptLockKey !== key) {
      releaseAttemptLock(activeAttemptLockKey);
    }
    acquireAttemptLock(context, applicationId, stage);
  }

  function isTerminalAttemptStage(stage) {
    return (
      isTerminalSuccessStage(stage) ||
      [
        DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
        DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED,
        DIRECT_APPLICATION.STAGES.FAILED,
      ].includes(stage)
    );
  }

  function updateAttemptLockForStage(context, stage, result = {}) {
    if (!context?.jobId || !context?.scheduleId) return;
    if (isTerminalAttemptStage(stage)) {
      releaseAttemptLock();
      return;
    }
    refreshAttemptLock(context, result.applicationId || context.applicationId || null, stage);
  }

  function unavailableScheduleKey(jobId, scheduleId = '*') {
    return [
      DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
      jobId || '',
      scheduleId || '*',
    ].join('::');
  }

  function readUnavailableScheduleCooldown(jobId, scheduleId = '*') {
    const key = unavailableScheduleKey(jobId, scheduleId);
    const entry = readSessionJson(key);
    if (!entry) return null;
    if (Number(entry.expiresAt) <= Date.now()) {
      removeSessionKey(key);
      return null;
    }
    return entry;
  }

  function markUnavailableScheduleCooldown(context, normalized = {}, applicationId = null) {
    if (!context?.jobId) return;
    const now = Date.now();
    const expiresAt = now + Math.max(1000, Number(DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_COOLDOWN_MS) || 0);
    const payload = {
      jobId: context.jobId || null,
      scheduleId: context.scheduleId || null,
      applicationId: applicationId || null,
      errorCode: normalized.errorCode || null,
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification || null,
      source: 'direct-application',
      createdAt: now,
      expiresAt,
    };
    writeSessionJson(unavailableScheduleKey(context.jobId, context.scheduleId || '*'), payload);
    writeSessionJson(unavailableScheduleKey(context.jobId, '*'), payload);
    log.warn('schedule marked unavailable for cooldown', {
      jobId: context.jobId,
      scheduleId: context.scheduleId || null,
      applicationId,
      errorCode: normalized.errorCode || null,
      cooldownMs: Math.max(0, expiresAt - now),
    });
  }

  function isCurrentScheduleCoolingDown(context) {
    return Boolean(
      readUnavailableScheduleCooldown(context.jobId, context.scheduleId || '*') ||
      readUnavailableScheduleCooldown(context.jobId, '*')
    );
  }

  function parseGuard(context) {
    const exact = guardStore.read(context);
    if (exact) return exact;
    if (context.scheduleId && !context.applicationId) return null;

    const jobGuard = guardStore.readForJob?.(context);
    if (!jobGuard) return null;
    if (
      context.applicationId &&
      jobGuard.applicationId &&
      context.applicationId !== jobGuard.applicationId
    ) {
      return null;
    }
    return jobGuard;
  }

  function hydrateContextFromGuard(context, guard) {
    if (!context || !guard) return context;
    if (!context.scheduleId && guard.scheduleId) context.scheduleId = guard.scheduleId;
    if (!context.applicationId && guard.applicationId) context.applicationId = guard.applicationId;
    if (!context.country && guard.country) context.country = guard.country;
    if (!context.locale && guard.locale) context.locale = guard.locale;
    return context;
  }

  function preservedGuardFields(context, extras = {}) {
    return guardStore.preserve(context, extras);
  }

  function isWafStatusStage(stage) {
    return [
      DIRECT_APPLICATION.STAGES.WAF_TOKEN_READY,
      DIRECT_APPLICATION.STAGES.WAF_TOKEN_UNAVAILABLE,
    ].includes(stage);
  }

  function writeGuard(context, stage, extras = {}) {
    const existing = guardStore.read(context);
    const guardStage =
      isWafStatusStage(stage) &&
      existing?.applicationId &&
      guardStore.shouldSuppressUiFallback(existing.stage)
        ? existing.stage
        : stage;
    guardStore.write(context, guardStage, extras);
  }

  function isTerminalSuccessStage(stage) {
    return DIRECT_APPLICATION.TERMINAL_SUCCESS_STAGES.includes(stage);
  }

  function isStaleFailureStageAfterSuccess(stage) {
    return [
      DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE,
      DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE,
      DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
      DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED,
      DIRECT_APPLICATION.STAGES.FAILED,
    ].includes(stage);
  }

  function shouldSuppressUiFallback(stage) {
    return guardStore.shouldSuppressUiFallback(stage);
  }

  function bookingConfirmedToastLabel(payload = {}) {
    const parts = [];
    if (payload.jobId) parts.push(payload.jobId);
    if (payload.scheduleId) parts.push(payload.scheduleId);
    return parts.join(' · ');
  }

  function renderNativeBookingConfirmedToast(payload = {}, attempts = 0) {
    if (!document?.body) {
      if (attempts < 20) {
        window.setTimeout(() => renderNativeBookingConfirmedToast(payload, attempts + 1), 100);
      }
      return;
    }

    document.querySelector('.amazon-booking-confirmed-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'amazon-booking-confirmed-toast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = [
      'position:fixed',
      'top:18px',
      'right:18px',
      'z-index:2147483647',
      'width:min(360px,calc(100vw - 36px))',
      'padding:14px 16px',
      'border-radius:8px',
      'background:#0f5132',
      'color:#fff',
      'box-shadow:0 14px 38px rgba(0,0,0,.28)',
      'font-family:Arial,sans-serif',
      'line-height:1.35',
      'letter-spacing:0',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Booking confirmed';
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:5px;';
    toast.appendChild(title);

    const meta = document.createElement('div');
    meta.textContent = bookingConfirmedToastLabel(payload) || 'Amazon booking succeeded';
    meta.style.cssText = 'font-size:13px;opacity:.94;overflow-wrap:anywhere;';
    toast.appendChild(meta);

    if (payload.applicationId) {
      const app = document.createElement('div');
      app.textContent = payload.applicationId;
      app.style.cssText = 'font-size:12px;opacity:.82;margin-top:5px;overflow-wrap:anywhere;';
      toast.appendChild(app);
    }

    document.body.appendChild(toast);
    window.setTimeout(() => {
      toast.style.transition = 'opacity .25s ease, transform .25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      window.setTimeout(() => toast.remove(), 300);
    }, BOOKING_CONFIRMED_TOAST_DURATION_MS);
  }

  function renderBookingConfirmedToast(payload = {}) {
    if (root.AMZ_TOASTS?.showBookingConfirmedToast) {
      root.AMZ_TOASTS.showBookingConfirmedToast(payload);
      return;
    }
    renderNativeBookingConfirmedToast(payload);
  }

  function queueBookingConfirmedToast(context, details = {}) {
    const payload = {
      jobId: context.jobId || details.jobId || null,
      scheduleId: details.selectedScheduleId || details.scheduleId || context.scheduleId || null,
      applicationId: details.applicationId || null,
      currentState: details.currentState || 'JOB_SELECTED',
      message: details.message || 'Booking confirmed.',
      expiresAt: Date.now() + BOOKING_CONFIRMED_TOAST_TTL_MS,
    };
    writeSessionJson(BOOKING_CONFIRMED_TOAST_SESSION_KEY, payload);
    if (DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS === false) {
      renderBookingConfirmedToast(payload);
      removeSessionKey(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
    }
  }

  function showQueuedBookingConfirmedToast(context = {}) {
    const payload = readSessionJson(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
    if (!payload) return;
    if (Number(payload.expiresAt || 0) <= Date.now()) {
      removeSessionKey(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
      return;
    }
    if (payload.jobId && context.jobId && payload.jobId !== context.jobId) return;

    renderBookingConfirmedToast(payload);
    removeSessionKey(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
  }

  function formOpenedNotificationKey(context = {}, mode = '') {
    return [
      DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
      'form-opened-notification',
      mode || '',
      context.jobId || '',
      context.scheduleId || '',
      context.applicationId || '',
    ].join('::');
  }

  function claimFormOpenedNotification(context = {}, mode = '') {
    if (!context.applicationId || !context.jobId) return false;
    const key = formOpenedNotificationKey(context, mode);
    const existing = readSessionJson(key);
    if (Number(existing?.expiresAt || 0) > Date.now()) return false;
    writeSessionJson(key, {
      mode: mode || null,
      jobId: context.jobId,
      scheduleId: context.scheduleId || null,
      applicationId: context.applicationId,
      expiresAt: Date.now() + FORM_OPENED_NOTIFICATION_TTL_MS,
    });
    return true;
  }

  function successHandoffNavigationKey(context = {}, applicationId = null) {
    return [
      DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
      'success-handoff-navigation',
      context.jobId || '',
      context.scheduleId || '',
      applicationId || context.applicationId || '',
    ].join('::');
  }

  function claimSuccessHandoffNavigation(context = {}, applicationId = null, redirectUrl = null) {
    const effectiveApplicationId = applicationId || context.applicationId || null;
    if (!context.jobId || !effectiveApplicationId) return true;
    const key = successHandoffNavigationKey(context, effectiveApplicationId);
    const existing = readSessionJson(key);
    if (Number(existing?.expiresAt || 0) > Date.now()) return false;
    writeSessionJson(key, {
      jobId: context.jobId || null,
      scheduleId: context.scheduleId || null,
      applicationId: effectiveApplicationId,
      redirectUrl: redirectUrl || null,
      expiresAt: Date.now() + SUCCESS_HANDOFF_NAVIGATION_TTL_MS,
    });
    return true;
  }

  function terminalBookingSuccessKeys(context = {}, details = {}) {
    const jobId = details.jobId || context.jobId || '';
    const scheduleId = details.selectedScheduleId || details.scheduleId || context.scheduleId || '';
    const applicationId = details.applicationId || context.applicationId || '';
    if (!jobId || !scheduleId) return [];
    const keyForApplication = appId => [
      DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
      'terminal-booking-success',
      jobId,
      scheduleId,
      appId || '*',
    ].join('::');
    return Array.from(new Set([
      applicationId ? keyForApplication(applicationId) : null,
      keyForApplication('*'),
    ].filter(Boolean)));
  }

  function markTerminalBookingSuccess(context = {}, details = {}) {
    const keys = terminalBookingSuccessKeys(context, details);
    if (!keys.length) return;
    const payload = {
      jobId: details.jobId || context.jobId || null,
      scheduleId: details.selectedScheduleId || details.scheduleId || context.scheduleId || null,
      applicationId: details.applicationId || context.applicationId || null,
      currentState: details.currentState || null,
      source: details.source || null,
      expiresAt: Date.now() + TERMINAL_BOOKING_SUCCESS_TTL_MS,
    };
    keys.forEach(key => writeSessionJson(key, payload));
  }

  function hasTerminalBookingSuccess(context = {}, details = {}) {
    const keys = terminalBookingSuccessKeys(context, details);
    for (const key of keys) {
      const existing = readSessionJson(key);
      if (!existing) continue;
      if (Number(existing.expiresAt || 0) <= Date.now()) {
        removeSessionKey(key);
        continue;
      }
      return true;
    }
    return false;
  }

  function selectedScheduleIdFromRecord(record = {}) {
    return (
      record.confirmedScheduleId ||
      record.reservedScheduleId ||
      record.selectedScheduleId ||
      record.raw?.jobScheduleSelected?.scheduleId ||
      null
    );
  }

  function isJobSelectedApplication(record = {}) {
    return (
      record.currentState === 'JOB_SELECTED' ||
      record.raw?.currentState === 'JOB_SELECTED'
    );
  }

  async function finishAlreadySelectedApplication(context, created = {}, options = {}) {
    if (!created?.applicationId || !isJobSelectedApplication(created)) return false;

    const confirmedScheduleId = selectedScheduleIdFromRecord(created) || context.scheduleId || null;
    persistResult(context, DIRECT_APPLICATION.STAGES.JOB_CONFIRMED, {
      applicationId: created.applicationId,
      candidateId: created.candidateId || null,
      currentState: created.currentState || created.raw?.currentState || 'JOB_SELECTED',
      confirmedScheduleId,
      softReserveExpirationTimestamp: created.softReserveExpirationTimestamp || null,
      confirmHttpStatus: created.confirmHttpStatus || created.responseStatus || null,
      resumedFromSelectedApplication: true,
      resumeReason: options.reason || null,
    });
    finalizeObservabilityOutcome(context, 'BOOKED', {
      detailedOutcome: options.reason || 'ALREADY_SELECTED_APPLICATION',
      applicationId: created.applicationId,
      confirmedScheduleId,
      confirmHttpStatus: created.confirmHttpStatus || created.responseStatus || null,
    });
    queueBookingConfirmedToast(context, {
      applicationId: created.applicationId,
      currentState: created.currentState || created.raw?.currentState || 'JOB_SELECTED',
      selectedScheduleId: confirmedScheduleId,
      message: options.message || 'Booking already confirmed on Amazon for this application.',
    });
    const handoff = successHandoffInfo(context, created.applicationId, {
      scheduleId: confirmedScheduleId,
    });
    notify(NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED, {
      jobId: context.jobId,
      scheduleId: confirmedScheduleId || context.scheduleId,
      applicationId: created.applicationId,
      currentState: created.currentState || created.raw?.currentState || 'JOB_SELECTED',
      selectedScheduleId: confirmedScheduleId,
      message: options.message || 'Booking already confirmed on Amazon for this application.',
      redirectUrl: notificationRedirectUrl(handoff.redirectUrl),
      pageUrl: context.href,
    });
    if (
      DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS &&
      handoff.routeName === DIRECT_APPLICATION.WORKFLOW_STEP_NAME
    ) {
      try {
        const workflow = await updateWorkflowStep(created.applicationId);
        persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED, {
          applicationId: created.applicationId,
          currentState: workflow.currentState,
          workflowStepName: workflow.workflowStepName,
          workflowHttpStatus: workflow.responseStatus,
          formHandoff: true,
          resumedFromSelectedApplication: true,
        });
      } catch (workflowError) {
        const normalizedWorkflowError = normalizeCaughtError(workflowError);
        persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATE_FAILED, {
          applicationId: created.applicationId,
          currentState: created.currentState || created.raw?.currentState || 'JOB_SELECTED',
          errorCode: normalizedWorkflowError.errorCode,
          errorMessage: normalizedWorkflowError.errorMessage,
          errorClassification: normalizedWorkflowError.classification,
          httpStatus: normalizedWorkflowError.httpStatus,
          formHandoff: true,
          resumedFromSelectedApplication: true,
        });
        log.debug('workflow step update failed before existing application form handoff', {
          jobId: context.jobId,
          scheduleId: confirmedScheduleId || context.scheduleId || null,
          applicationId: created.applicationId,
          errorCode: normalizedWorkflowError.errorCode,
          errorMessage: normalizedWorkflowError.errorMessage,
          errorClassification: normalizedWorkflowError.classification,
          httpStatus: normalizedWorkflowError.httpStatus,
        });
      }
    }
    scheduleSuccessHandoff(context, created.applicationId, {
      handoff,
      scheduleId: confirmedScheduleId,
    });
    return true;
  }

  function stageLogMessage(stage, result = {}) {
    const stages = DIRECT_APPLICATION.STAGES;
    if (result.errorClassification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED) {
      return 'booking captcha required';
    }
    const messages = {
      [stages.STARTED]: 'direct booking started',
      [stages.CAPTCHA_REQUIRED]: 'booking captcha required',
      [stages.CAPTCHA_PRESENTED]: 'booking captcha visible',
      [stages.CAPTCHA_SOLVED]: 'booking captcha solved',
      [stages.CAPTCHA_FAILED]: 'booking captcha failed',
      [stages.SCHEDULE_VERIFIED]: 'schedule verified',
      [stages.SCHEDULE_UNAVAILABLE]: 'schedule unavailable',
      [stages.SCHEDULE_FALLBACK_CHECKED]: 'official schedule fallback checked',
      [stages.APPLICATION_CREATED_WITHOUT_SCHEDULE]:
        'application created without selected schedule',
      [stages.JOB_CONFIRMED]: 'job confirmed',
      [stages.RESERVATION_VERIFIED]: 'reservation verified',
      [stages.RESERVATION_VERIFICATION_FAILED]: 'reservation verification failed',
      [stages.WORKFLOW_WS_STARTED]: 'workflow websocket started',
      [stages.WORKFLOW_WS_COMPLETED]: 'workflow websocket completed',
      [stages.WORKFLOW_WS_SKIPPED]: 'workflow websocket skipped',
      [stages.WORKFLOW_WS_FAILED]: 'workflow websocket failed',
      [stages.WORKFLOW_UPDATED]: 'workflow step updated',
      [stages.WORKFLOW_UPDATE_FAILED]: 'workflow step update failed',
      [stages.FAILED]: 'direct booking failed',
    };
    return messages[stage] || 'direct booking stage updated';
  }

  function persistResult(context, stage, metadata = {}) {
    if (
      isStaleFailureStageAfterSuccess(stage) &&
      hasTerminalBookingSuccess(context, metadata)
    ) {
      log.warn('stale failure stage suppressed because this application is already booked', {
        stage,
        jobId: context.jobId,
        scheduleId: metadata.selectedScheduleId || metadata.scheduleId || context.scheduleId || null,
        applicationId: metadata.applicationId || context.applicationId || null,
        errorCode: metadata.errorCode || null,
        errorClassification: metadata.errorClassification || null,
      });
      const existing = parseGuard(context);
      return {
        stage: existing?.stage || DIRECT_APPLICATION.STAGES.JOB_CONFIRMED,
        jobId: context.jobId || null,
        scheduleId: context.scheduleId || null,
        applicationId: metadata.applicationId || context.applicationId || existing?.applicationId || null,
        suppressedAfterTerminalSuccess: true,
        ...metadata,
      };
    }

    const preserved = preservedGuardFields(context, metadata);
    const result = {
      stage,
      jobId: context.jobId || null,
      scheduleId: context.scheduleId || null,
      country: context.country || null,
      locale: context.locale || null,
      clientEmail: metadata.clientEmail || context.clientEmail || null,
      pageUrl: context.href || window.location.href,
      updatedAt: root.AMZ_TIME?.nowIstIso?.() || new Date().toISOString(),
      ...preserved,
      ...metadata,
    };

    const stageSummary = stageObservabilitySummary(stage, result);
    const importantStages = [
      DIRECT_APPLICATION.STAGES.STARTED,
      DIRECT_APPLICATION.STAGES.CAPTCHA_REQUIRED,
      DIRECT_APPLICATION.STAGES.CAPTCHA_PRESENTED,
      DIRECT_APPLICATION.STAGES.CAPTCHA_SOLVED,
      DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
      DIRECT_APPLICATION.STAGES.SCHEDULE_VERIFIED,
      DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE,
      DIRECT_APPLICATION.STAGES.SCHEDULE_FALLBACK_CHECKED,
      DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE,
      DIRECT_APPLICATION.STAGES.JOB_CONFIRMED,
      DIRECT_APPLICATION.STAGES.RESERVATION_VERIFIED,
      DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED,
      DIRECT_APPLICATION.STAGES.WORKFLOW_WS_STARTED,
      DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED,
      DIRECT_APPLICATION.STAGES.WORKFLOW_WS_SKIPPED,
      DIRECT_APPLICATION.STAGES.WORKFLOW_WS_FAILED,
      DIRECT_APPLICATION.STAGES.FAILED,
    ];
    const isCaptchaRequired = result.errorClassification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED;
    const isTerminalFailure = [
      DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
      DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED,
      DIRECT_APPLICATION.STAGES.FAILED,
    ].includes(stage);
    if (isTerminalFailure || isCaptchaRequired) {
      log.warn(stageLogMessage(stage, result), stageSummary);
    } else if (importantStages.includes(stage)) {
      log.info(stageLogMessage(stage, result), stageSummary);
    } else {
      log.debug('stage updated', stageSummary);
    }
    observability?.recordDirectStage?.(context, stage, result);

    void storage.setLocal({ [STORAGE_KEYS.DIRECT_APPLICATION_RESULT]: result }).catch(error => {
      log.error('Unable to persist direct application result:', error);
    });

    writeGuard(context, stage, metadata);
    updateAttemptLockForStage(context, stage, result);
    if (stage === DIRECT_APPLICATION.STAGES.JOB_CONFIRMED) {
      markTerminalBookingSuccess(context, result);
    }
    return result;
  }

  function emitNotification(eventName, payload = {}, options = {}) {
    if (!root.AMZ_NOTIFICATIONS?.emit) return Promise.resolve(null);
    try {
      return root.AMZ_NOTIFICATIONS.emit(eventName, payload, options).catch(error => {
        log.debug('notification delivery skipped after emit failure', {
          eventName,
          error: error?.message || String(error),
        });
        return null;
      });
    } catch (error) {
      log.debug('notification emit failed synchronously', {
        eventName,
        error: error?.message || String(error),
      });
      return Promise.resolve(null);
    }
  }

  function playBookingTerminalAlert(eventName) {
    if (
      eventName !== NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED &&
      eventName !== NOTIFICATIONS.EVENTS.BOOKING_FAILED
    ) {
      return;
    }
    const alerts = root.AMZ_ALERTS;
    if (!alerts?.playBookingTerminalSound) return;
    const outcome = eventName === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED ? 'success' : 'failed';
    void alerts.playBookingTerminalSound(outcome).catch(error => {
      log.debug('booking terminal sound skipped:', error?.message || String(error));
    });
  }

  function currentNotificationMode() {
    return directApplicationMode.isEnabled() ? 'direct' : 'manual';
  }

  function notify(eventName, details = {}) {
    const pageContext = currentContext();
    const notificationContext = {
      ...pageContext,
      jobId: details.jobId || pageContext.jobId || null,
      scheduleId: details.selectedScheduleId || details.scheduleId || pageContext.scheduleId || null,
      applicationId: details.applicationId || pageContext.applicationId || null,
    };
    if (
      eventName === NOTIFICATIONS.EVENTS.BOOKING_FAILED &&
      hasTerminalBookingSuccess(notificationContext, details)
    ) {
      log.warn('stale failure notification suppressed because this application is already booked', {
        jobId: notificationContext.jobId,
        scheduleId: notificationContext.scheduleId,
        applicationId: notificationContext.applicationId,
        errorCode: details.errorCode || null,
        errorClassification: details.errorClassification || null,
      });
      return Promise.resolve({ ok: true, skipped: 'terminal-success-recorded' });
    }
    if (
      eventName === NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED ||
      eventName === NOTIFICATIONS.EVENTS.FORM_OPENED
    ) {
      markTerminalBookingSuccess(notificationContext, {
        ...details,
        source: eventName,
      });
    }
    playBookingTerminalAlert(eventName);
    return emitNotification(eventName, {
      ...details,
      clientEmail: details.clientEmail || activeAttemptClientEmail || null,
      mode: details.mode || currentNotificationMode(),
      source: details.source || eventName,
      message: details.message || details.errorMessage || null,
      dedupeKey: details.observabilityKey || details.dedupeKey || null,
    }, {
      source: eventName,
    });
  }

  function finalizeObservabilityOutcome(context, outcome, extras = {}) {
    if (!observability?.loadPendingTrace || !observability?.finalizeAndFlush) return;
    if (outcome === 'BOOKED') {
      markTerminalBookingSuccess(context, extras);
    } else if (hasTerminalBookingSuccess(context, extras)) {
      log.warn('stale observability outcome suppressed because this application is already booked', {
        outcome,
        jobId: context.jobId,
        scheduleId: extras.confirmedScheduleId || extras.scheduleId || context.scheduleId || null,
        applicationId: extras.applicationId || context.applicationId || null,
        errorCode: extras.errorCode || null,
        errorClassification: extras.errorClassification || null,
      });
      return;
    }
    void observability.loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      return observability.finalizeAndFlush(trace, outcome, extras, context);
    }).catch(error => {
      log.debug('application observability finalization skipped', {
        outcome,
        error: error?.message || String(error),
      });
    });
  }

  function makeObservabilityKey(...parts) {
    return [
      ...parts.filter(Boolean),
      Date.now(),
      Math.random().toString(36).slice(2, 8),
    ].join('::');
  }

  function observabilityTiming() {
    return {
      epochMs: Date.now(),
      perfMs: typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    };
  }

  function stageObservabilitySummary(stage, result = {}) {
    return {
      stage,
      jobId: result.jobId || null,
      scheduleId: result.scheduleId || null,
      applicationId: result.applicationId || null,
      currentState: result.currentState || null,
      workflowStepName: result.workflowStepName || null,
      scheduleStatus: result.scheduleStatus || null,
      workflowWsStatus: result.workflowWsStatus || null,
      errorCode: result.errorCode || result.reservationErrorCode || null,
      errorClassification:
        result.errorClassification ||
        result.reservationErrorClassification ||
        result.errorClassification ||
        null,
      httpStatus:
        result.httpStatus ||
        result.createHttpStatus ||
        result.confirmHttpStatus ||
        result.reservationHttpStatus ||
        result.workflowHttpStatus ||
        null,
      hasCandidateId: Boolean(result.candidateId),
      fallbackAllowed: result.fallbackAllowed ?? null,
      withoutSelectedSchedule: result.withoutSelectedSchedule ?? null,
      captchaReason: result.captchaReason || null,
    };
  }

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  const wafBridge = root.AMZ_DIRECT_WAF.create({
    notify,
    persistResult,
  });

  async function requestWafToken(context, reason, options = {}) {
    return wafBridge.requestToken(context, reason, options);
  }

  async function requestCaptchaChallenge(context, reason, metadata = {}) {
    return wafBridge.requestCaptcha(context, reason, metadata);
  }

  function wafContextKey(context) {
    return [
      context?.origin || '',
      context?.jobId || '',
      context?.scheduleId || '',
    ].join('::');
  }

  function warmWafToken(context, reason = 'warmup') {
    if (!shouldPreflightWaf()) return null;
    const contextKey = wafContextKey(context);
    if (wafWarmupPromise && wafWarmupContextKey === contextKey) return wafWarmupPromise;
    wafWarmupContextKey = contextKey;
    wafWarmupPromise = requestWafToken(context, reason, {
      waitMs: 0,
    }).then(result => {
      if (observability?.loadPendingTrace) {
        void observability.loadPendingTrace(context).then(trace => {
          if (!trace) return null;
          observability.recordApplicationEvent(trace, 'waf_token_ready', { reason }, 'wafTokenEndAt');
          return null;
        }).catch(() => null);
      }
      return result;
    }).catch(error => {
      log.debug('background WAF token warmup failed', {
        reason,
        error: error?.message || String(error),
      });
      if (observability?.loadPendingTrace) {
        void observability.loadPendingTrace(context).then(trace => {
          if (!trace) return null;
          observability.recordApplicationEvent(trace, 'waf_token_failed', {
            reason,
            error: error?.message || String(error),
          }, 'wafTokenEndAt');
          return null;
        }).catch(() => null);
      }
      return null;
    });
    if (observability?.loadPendingTrace) {
      void observability.loadPendingTrace(context).then(trace => {
        if (!trace) return null;
        observability.recordApplicationEvent(trace, 'waf_token_start', { reason }, 'wafTokenStartAt');
        return null;
      }).catch(() => null);
    }
    return wafWarmupPromise;
  }

  async function preflightWaf(context, reason, options = {}) {
    if (!shouldPreflightWaf()) return null;
    const requestOptions = {
      preferRefresh: Boolean(options.preferRefreshToken),
      waitMs: options.wafWaitMs,
    };
    if (DIRECT_APPLICATION.WAF_PREFLIGHT_BLOCKING_ENABLED === false) {
      void requestWafToken(context, reason, requestOptions).catch(error => {
        log.debug('non-blocking WAF token request failed', {
          reason,
          error: error?.message || String(error),
        });
      });
      return null;
    }
    return requestWafToken(context, reason, requestOptions);
  }

  async function fetchWithTimeout(url, options = {}) {
    if (!url) {
      throw new DirectApplicationError('Missing direct application API URL.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.MALFORMED_RESPONSE,
      });
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      DIRECT_APPLICATION.FETCH_TIMEOUT_MS
    );

    try {
      return await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function parseJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  function logApiRequest(url, options = {}, requestContext = {}) {
    let pathname = null;
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      pathname = String(url || '');
    }

    const observabilityKey = requestContext.observabilityKey || makeObservabilityKey(
      requestContext.operation,
      options.method || 'GET',
      pathname
    );
    requestContext.observabilityKey = observabilityKey;

    const details = {
      operation: requestContext.operation || null,
      method: options.method || 'GET',
      pathname,
      body: requestBodySummary(options),
      observabilityKey,
    };
    log.debug('api request', details);
  }

  function observabilityApiDetails(url, options = {}) {
    let pathname = null;
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      pathname = String(url || '');
    }
    return {
      method: options.method || 'GET',
      pathname,
    };
  }

  function logApiResponse(response, payload, data, requestContext = {}) {
    const summary = {
      operation: requestContext.operation || null,
      ...responseSummary(response, payload, data),
      observabilityKey: requestContext.observabilityKey || null,
    };
    log.debug('api response', summary);
  }

  async function requestJson(path, options, requestContext = {}) {
    const url = apiUrl(path);
    observability?.recordApiRequest?.(currentContext(), requestContext.operation, observabilityApiDetails(url, options));
    logApiRequest(url, options, requestContext);
    let response;
    let payload;
    let data;
    try {
      response = await fetchWithTimeout(url, options);
      payload = await parseJson(response);
      data = responseData(payload);
      logApiResponse(response, payload, data, requestContext);
      observability?.recordApiResponse?.(currentContext(), requestContext.operation, {
        httpStatus: response.status,
        errorCode: getErrorCode(payload),
        errorMessage: getErrorMessage(payload),
      });
    } catch (error) {
      observability?.recordApiResponse?.(currentContext(), requestContext.operation, {
        failed: true,
        httpStatus: error?.httpStatus || null,
        errorCode: error?.errorCode || null,
        errorMessage: error?.message || String(error),
      });
      throw error;
    }

    if (isCaptchaResponse(response)) {
      throw new DirectApplicationError('Amazon WAF CAPTCHA is required for direct booking.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
        httpStatus: response.status,
        errorCode: getErrorCode(payload),
        errorMessage: getErrorMessage(payload),
        errorMetadata: getErrorMetadata(payload),
        requestContext,
      });
    }

    return { response, payload, data };
  }

  async function requestJsonAbsolute(url, options, requestContext = {}) {
    observability?.recordApiRequest?.(currentContext(), requestContext.operation, observabilityApiDetails(url, options));
    logApiRequest(url, options, requestContext);
    let response;
    let payload;
    let data;
    try {
      response = await fetchWithTimeout(url, options);
      payload = await parseJson(response);
      data = responseData(payload);
      logApiResponse(response, payload, data, requestContext);
      observability?.recordApiResponse?.(currentContext(), requestContext.operation, {
        httpStatus: response.status,
        errorCode: getErrorCode(payload),
        errorMessage: getErrorMessage(payload),
      });
    } catch (error) {
      observability?.recordApiResponse?.(currentContext(), requestContext.operation, {
        failed: true,
        httpStatus: error?.httpStatus || null,
        errorCode: error?.errorCode || null,
        errorMessage: error?.message || String(error),
      });
      throw error;
    }

    if (isCaptchaResponse(response)) {
      throw new DirectApplicationError('Amazon WAF CAPTCHA is required for direct booking.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
        httpStatus: response.status,
        errorCode: getErrorCode(payload),
        errorMessage: getErrorMessage(payload),
        errorMetadata: getErrorMetadata(payload),
        requestContext,
      });
    }

    return { response, payload, data };
  }

  function errorFromResult(label, result, options = {}) {
    const errorCode = getErrorCode(result?.payload);
    const errorMessage = getErrorMessage(result?.payload);
    const errorMetadata = getErrorMetadata(result?.payload);
    const classification = classifyError({
      response: result?.response,
      payload: result?.payload,
      forcedClassification: options.classification || options.forcedClassification,
    });

    const statusText = result?.response?.status ? ` HTTP ${result.response.status}.` : '';
    const codeText = errorCode ? ` ${errorCode}.` : '';
    const messageText = errorMessage ? ` ${errorMessage}` : '';
    return new DirectApplicationError(`${label} failed.${statusText}${codeText}${messageText}`.trim(), {
      classification,
      httpStatus: result?.response?.status || null,
      errorCode,
      errorMessage,
      errorMetadata,
      fallbackAllowed:
        classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED ||
        classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT ||
        classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.SERVER_OR_PROXY_ERROR ||
        classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNKNOWN,
    });
  }

  async function resolveCandidateId() {
    const localCandidateId =
      window.localStorage.getItem(DIRECT_APPLICATION.CANDIDATE_ID_LOCAL_STORAGE_KEY) || '';
    if (localCandidateId) return localCandidateId;

    const candidateResult = await requestJson(DIRECT_APPLICATION.API_PATHS.CANDIDATE, {
      method: 'GET',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.CANDIDATE,
    }, { operation: 'candidate' });

    if (!candidateResult.response.ok) {
      throw errorFromResult('Candidate lookup', candidateResult);
    }

    const candidateId = candidateResult.data?.candidateId || '';
    if (!candidateId) {
      throw new DirectApplicationError('Candidate lookup did not return candidateId.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.MALFORMED_RESPONSE,
      });
    }
    return candidateId;
  }

  function absoluteUrlWithSuffix(path, suffix, query = {}) {
    const base = apiUrlWithSuffix(path, suffix);
    if (!base) return null;
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  function normalizeScheduleStatus(scheduleDetail = {}) {
    return (
      scheduleDetail.scheduleStatus ||
      scheduleDetail.status ||
      scheduleDetail.availabilityStatus ||
      scheduleDetail.currentStatus ||
      null
    );
  }

  function scheduleDetailLooksUnavailable(scheduleDetail = {}) {
    if (!scheduleDetail || typeof scheduleDetail !== 'object') return false;
    if (scheduleDetail.isAvailable === false || scheduleDetail.available === false) return true;
    const status = String(normalizeScheduleStatus(scheduleDetail) || '').toUpperCase();
    if (!status) return false;
    return [
      'NOT_AVAILABLE',
      'UNAVAILABLE',
      'NO_LONGER_AVAILABLE',
      'FULL',
      'CLOSED',
      'CANCEL',
      'INACTIVE',
    ].some(fragment => status.includes(fragment));
  }

  async function verifySelectedSchedule(context, options = {}) {
    if (!options.force && !DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!context.scheduleId) {
      return { skipped: true, reason: 'missing-schedule-id' };
    }

    const url = absoluteUrlWithSuffix(
      DIRECT_APPLICATION.API_PATHS.SCHEDULE_DETAIL,
      context.scheduleId,
      {
        locale: context.locale || AMAZON.COUNTRY_CONFIG?.locale || null,
      }
    );
    const result = await requestJsonAbsolute(url, {
      method: 'GET',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.SCHEDULE_DETAIL,
    }, { operation: 'schedule-detail' });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      if (options.failOnUnavailable === false) {
        return {
          verified: false,
          unavailable: true,
          httpStatus: result.response.status,
          scheduleStatus: null,
          errorCode: getErrorCode(result.payload),
          errorMessage: getErrorMessage(result.payload),
          raw: result.data,
        };
      }
      const verificationError = errorFromResult('Schedule verification', result, {
        forcedClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      });
      verificationError.failedStage = DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE;
      verificationError.fallbackAllowed = false;
      throw verificationError;
    }

    const scheduleDetail = result.data?.schedule || result.data?.jobSchedule || result.data || {};
    const scheduleStatus = normalizeScheduleStatus(scheduleDetail);
    if (scheduleDetailLooksUnavailable(scheduleDetail)) {
      if (options.failOnUnavailable === false) {
        return {
          verified: false,
          unavailable: true,
          httpStatus: result.response.status,
          scheduleStatus,
          state: scheduleDetail.state || scheduleDetail.address?.state || null,
          employmentType: scheduleDetail.employmentType || null,
          raw: scheduleDetail,
        };
      }
      throw new DirectApplicationError('Selected schedule is no longer available before create application.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
        httpStatus: result.response.status,
        errorCode: 'SELECTED_SCHEDULE_NOT_AVAILABLE',
        errorMessage: 'The selected schedule is no longer available.',
        failedStage: DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE,
        fallbackAllowed: false,
        errorMetadata: {
          scheduleStatus,
        },
      });
    }

    return {
      verified: true,
      httpStatus: result.response.status,
      scheduleStatus,
      state: scheduleDetail.state || scheduleDetail.address?.state || null,
      employmentType: scheduleDetail.employmentType || null,
      raw: scheduleDetail,
    };
  }

  function shouldPrefetchScheduleDetail() {
    return (
      DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE ||
      DIRECT_APPLICATION.SCHEDULE_DETAIL_PREFETCH_ENABLED !== false
    );
  }

  function startScheduleDetailPrefetch(context) {
    if (!shouldPrefetchScheduleDetail() || !context.scheduleId) return null;
    return verifySelectedSchedule(context, {
      failOnUnavailable: DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE,
      force: true,
    }).catch(error => {
      if (DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE) {
        return {
          blockingFailure: true,
          error,
        };
      }
      const normalized = normalizeCaughtError(error);
      log.debug('schedule detail prefetch failed', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorMessage,
        errorClassification: normalized.classification,
        httpStatus: normalized.httpStatus,
      });
      return {
        skipped: true,
        reason: 'prefetch-failed',
        error,
      };
    });
  }

  async function loadJobDetail(context) {
    if (!context.jobId) return { skipped: true, reason: 'missing-job-id' };
    const url = absoluteUrlWithSuffix(
      DIRECT_APPLICATION.API_PATHS.JOB_DETAIL,
      context.jobId,
      {
        locale: context.locale || AMAZON.COUNTRY_CONFIG?.locale || null,
      }
    );
    const result = await requestJsonAbsolute(url, {
      method: 'GET',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.JOB_DETAIL,
    }, { operation: 'job-detail' });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      throw errorFromResult('Job detail prefetch', result);
    }

    return {
      verified: true,
      httpStatus: result.response.status,
      dspEnabled:
        typeof result.data?.dspEnabled === 'boolean'
          ? result.data.dspEnabled
          : null,
      partitionAttributes: result.data?.partitionAttributes || null,
      raw: result.data,
    };
  }

  function startJobDetailPrefetch(context) {
    if (DIRECT_APPLICATION.JOB_DETAIL_PREFETCH_ENABLED === false || !context.jobId) return null;
    return loadJobDetail(context).catch(error => {
      const normalized = normalizeCaughtError(error);
      log.debug('job detail prefetch failed', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorMessage,
        errorClassification: normalized.classification,
        httpStatus: normalized.httpStatus,
      });
      return {
        skipped: true,
        reason: 'prefetch-failed',
        error,
      };
    });
  }

  async function waitForWorkflowPrefetch(prefetchPromise) {
    if (!prefetchPromise) return null;
    const waitMs = Math.max(
      0,
      Number(DIRECT_APPLICATION.SCHEDULE_DETAIL_WORKFLOW_WAIT_MS) || 0
    );
    if (waitMs <= 0) return null;
    return Promise.race([
      prefetchPromise,
      sleep(waitMs).then(() => null),
    ]);
  }

  function dspEnabledFrom(...records) {
    for (const record of records) {
      const direct = record?.dspEnabled;
      if (typeof direct === 'boolean') return direct;
      const raw = record?.raw?.dspEnabled;
      if (typeof raw === 'boolean') return raw;
    }
    return DIRECT_APPLICATION.REQUEST_FLAGS.DSP_ENABLED;
  }

  function createApplicationPayload(context, candidateId, options = {}) {
    const includeSchedule = options.includeSchedule !== false;
    const includeCandidate = options.includeCandidate !== false;
    const payload = {
      jobId: context.jobId,
      dspEnabled: dspEnabledFrom(options.jobDetail, options),
    };
    if (includeSchedule) payload.scheduleId = context.scheduleId;
    if (includeCandidate) payload.candidateId = candidateId;
    payload.activeApplicationCheckEnabled =
      DIRECT_APPLICATION.REQUEST_FLAGS.ACTIVE_APPLICATION_CHECK_ENABLED;
    return payload;
  }

  async function createApplication(context, candidateId, options = {}) {
    const operation = options.operation || 'create-application';
    await preflightWaf(context, operation);

    const result = await requestJson(DIRECT_APPLICATION.API_PATHS.CREATE_APPLICATION, {
      method: 'POST',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.APPLICATION,
      body: JSON.stringify(createApplicationPayload(context, candidateId, options)),
    }, { operation });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      throw errorFromResult('Create application', result);
    }

    const applicationId = result.data?.applicationId || '';
    if (!applicationId) {
      throw new DirectApplicationError('Create application response did not include applicationId.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.MALFORMED_RESPONSE,
        httpStatus: result.response.status,
      });
    }

    return {
      applicationId,
      candidateId: result.data?.candidateId || candidateId,
      currentState: result.data?.currentState || null,
      dspEnabled: Boolean(result.data?.dspEnabled),
      responseStatus: result.response.status,
      withoutSelectedSchedule: options.includeSchedule === false,
      raw: result.data,
    };
  }

  function createApplicationWithoutSelectedSchedule(context, options = {}) {
    const dspEnabled = dspEnabledFrom(options.jobDetail, options);
    log.info('[Application Create][Create DS application without schedule] Create the DS application without scheduleId in payload', {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      dspEnabled,
      activeApplicationCheckEnabled:
        DIRECT_APPLICATION.REQUEST_FLAGS.ACTIVE_APPLICATION_CHECK_ENABLED,
    });
    return createApplication(context, null, {
      includeSchedule: false,
      includeCandidate: false,
      operation: 'create-application-without-schedule',
      jobDetail: options.jobDetail || null,
      dspEnabled,
    });
  }

  function extractSchedulesFromListResponse(data = {}) {
    if (Array.isArray(data)) return data;
    const candidates = [
      data?.availableSchedules?.schedules,
      data?.schedules,
      data?.scheduleList,
      data?.jobSchedules,
      data?.data?.availableSchedules?.schedules,
      data?.data?.schedules,
      data?.data?.scheduleList,
    ];
    return candidates.find(Array.isArray) || [];
  }

  function extractScheduleListTotal(data = {}, schedules = []) {
    const totalCandidates = [
      data?.availableSchedules?.total,
      data?.total,
      data?.count,
      data?.data?.availableSchedules?.total,
      data?.data?.total,
    ];
    const explicitTotal = totalCandidates
      .map(value => Number(value))
      .find(value => Number.isFinite(value));
    return explicitTotal ?? schedules.length;
  }

  async function getFallbackScheduleList(context) {
    const url = absoluteUrlWithSuffix(
      DIRECT_APPLICATION.API_PATHS.SCHEDULE_LIST,
      context.jobId
    );
    const locale = context.locale || AMAZON.COUNTRY_CONFIG?.locale || null;
    const body = {
      jobId: context.jobId,
      locale,
      pageSize: 1,
    };

    const result = await requestJsonAbsolute(url, {
      method: 'POST',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.SCHEDULE_LIST,
      body: JSON.stringify(body),
    }, { operation: 'schedule-list-fallback' });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      return {
        checked: true,
        hasSchedules: false,
        httpStatus: result.response.status,
        errorCode: getErrorCode(result.payload),
        errorMessage: getErrorMessage(result.payload),
        raw: result.data,
      };
    }

    const schedules = extractSchedulesFromListResponse(result.data);
    const total = extractScheduleListTotal(result.data, schedules);
    return {
      checked: true,
      hasSchedules: total > 0 || schedules.length > 0,
      total,
      schedules,
      httpStatus: result.response.status,
      raw: result.data,
    };
  }

  function isSelectedScheduleUnavailable(normalized = {}) {
    if (
      normalized.classification !==
      DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED
    ) {
      return false;
    }
    const code = String(normalized.errorCode || '').toUpperCase();
    const message = String(normalized.errorMessage || '').toUpperCase();
    return (
      code.includes('SELECTED_SCHEDULE_NOT_AVAILABLE') ||
      code.includes('SCHEDULE') ||
      code.includes('UNAVAILABLE') ||
      message.includes('SCHEDULE') ||
      message.includes('NO LONGER AVAILABLE')
    );
  }

  async function tryCreateWithoutScheduleFallback(context, normalized, options = {}) {
    if (DIRECT_APPLICATION.CREATE_WITHOUT_SCHEDULE_FALLBACK_ENABLED === false) {
      return null;
    }
    if (!context?.jobId || !context?.scheduleId || !isSelectedScheduleUnavailable(normalized)) {
      return null;
    }
    log.info('[Application Create] Current schedule is not available, checking if there is any other schedule available', {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      scheduleStatus: options.scheduleStatus || normalized.errorCode || null,
      candidateId: options.candidateId || null,
      previousApplicationId: options.previousApplicationId || null,
    });

    let scheduleList;
    try {
      scheduleList = await getFallbackScheduleList(context);
    } catch (error) {
      const scheduleListError = normalizeCaughtError(error);
      persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_FALLBACK_CHECKED, {
        applicationId: options.previousApplicationId || null,
        candidateId: options.candidateId || null,
        errorCode: scheduleListError.errorCode,
        errorMessage: scheduleListError.errorMessage,
        errorClassification: scheduleListError.classification,
        httpStatus: scheduleListError.httpStatus,
        fallbackWithoutSchedule: false,
        fallbackOriginalErrorCode: normalized.errorCode || null,
      });
      return null;
    }

    persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_FALLBACK_CHECKED, {
      applicationId: options.previousApplicationId || null,
      candidateId: options.candidateId || null,
      scheduleStatus: options.scheduleStatus || null,
      scheduleListHttpStatus: scheduleList.httpStatus || null,
      fallbackScheduleCount: scheduleList.total ?? scheduleList.schedules?.length ?? 0,
      fallbackWithoutSchedule: Boolean(scheduleList.hasSchedules),
      fallbackOriginalErrorCode: normalized.errorCode || null,
      fallbackOriginalErrorMessage: normalized.errorMessage || null,
      errorCode: scheduleList.errorCode || null,
      errorMessage: scheduleList.errorMessage || null,
    });

    if (!scheduleList.hasSchedules) {
      log.info('[Application Create] Current schedule is not available, no other schedules available either, redirecting to no available shift page', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        scheduleStatus: options.scheduleStatus || normalized.errorCode || null,
        candidateId: options.candidateId || null,
        errorCode: scheduleList.errorCode || null,
        errorMessage: scheduleList.errorMessage || null,
      });
      scheduleNoAvailableShiftHandoff(context, normalized, scheduleList);
      return {
        handled: true,
        noAvailableShift: true,
        scheduleList,
      };
    }

    log.info('[Application Create] Current schedule is not available, but there are other schedules available, creating the application without selected schedule', {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      scheduleStatus: options.scheduleStatus || normalized.errorCode || null,
      fallbackScheduleCount: scheduleList.total ?? scheduleList.schedules.length,
      candidateId: options.candidateId || null,
    });

    let created;
    try {
      created = await createApplicationWithoutSelectedSchedule(context, {
        jobDetail: options.jobDetail || null,
        dspEnabled: options.dspEnabled,
      });
    } catch (error) {
      const createError = normalizeCaughtError(error);
      const existingGuard = parseGuard(context);
      const existingApplicationId =
        options.previousApplicationId ||
        existingGuard?.applicationId ||
        context.applicationId ||
        null;
      if (
        createError.classification ===
          DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ALREADY_APPLIED &&
        existingApplicationId
      ) {
        log.info('[Application Create][Create DS application without schedule] Application already exists; continuing fallback with existing application', {
          jobId: context.jobId,
          scheduleId: context.scheduleId,
          applicationId: existingApplicationId,
          errorCode: createError.errorCode,
          errorMessage: createError.errorMessage,
        });
        persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_FALLBACK_CHECKED, {
          applicationId: existingApplicationId,
          candidateId: options.candidateId || existingGuard?.candidateId || null,
          currentState: existingGuard?.currentState || 'APPLICATION_CREATED',
          createHttpStatus: existingGuard?.createHttpStatus || createError.httpStatus || null,
          errorCode: createError.errorCode,
          errorMessage: createError.errorMessage,
          errorClassification: createError.classification,
          httpStatus: createError.httpStatus,
          fallbackWithoutSchedule: true,
          fallbackCreateAlreadyExists: true,
          fallbackReusedExistingApplication: true,
          fallbackOriginalErrorCode: normalized.errorCode || null,
        });
        return {
          created: {
            applicationId: existingApplicationId,
            candidateId: options.candidateId || existingGuard?.candidateId || null,
            currentState: existingGuard?.currentState || 'APPLICATION_CREATED',
            responseStatus: existingGuard?.createHttpStatus || createError.httpStatus || null,
            withoutSelectedSchedule: true,
            raw: existingGuard?.raw || {},
          },
          scheduleList,
          reusedExistingApplication: true,
        };
      }
      persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_FALLBACK_CHECKED, {
        applicationId: options.previousApplicationId || null,
        candidateId: options.candidateId || null,
        errorCode: createError.errorCode,
        errorMessage: createError.errorMessage,
        errorClassification: createError.classification,
        httpStatus: createError.httpStatus,
        fallbackWithoutSchedule: false,
        fallbackCreateFailed: true,
        fallbackOriginalErrorCode: normalized.errorCode || null,
      });
      if (scheduleApplicationErrorHandoff(context, createError, { notifyFailure: true })) {
        return {
          handled: true,
          applicationErrorRoute: true,
          scheduleList,
        };
      }
      return null;
    }
    if (!created.candidateId && options.candidateId) {
      created.candidateId = options.candidateId;
    }
    return {
      created,
      scheduleList,
    };
  }

  function applicationIdFrom(applicationRef) {
    return typeof applicationRef === 'object' && applicationRef
      ? applicationRef.applicationId
      : applicationRef;
  }

  async function confirmJobOnce(context, applicationRef, options = {}) {
    const applicationId = applicationIdFrom(applicationRef);
    await preflightWaf(context, 'job-confirm', options);

    const result = await requestJson(DIRECT_APPLICATION.API_PATHS.UPDATE_APPLICATION, {
      method: 'PUT',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.APPLICATION,
      body: JSON.stringify({
        applicationId,
        payload: {
          jobId: context.jobId,
          scheduleId: context.scheduleId,
        },
        type: 'job-confirm',
        dspEnabled: Boolean(dspEnabledFrom(applicationRef, options)),
      }),
    }, { operation: 'job-confirm' });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      throw errorFromResult('Job confirm', result);
    }

    const currentState = result.data?.currentState || null;
    const confirmedScheduleId = result.data?.jobScheduleSelected?.scheduleId || null;
    log.debug('job-confirm response shape', {
      applicationId,
      currentState,
      confirmedScheduleId,
      responseStatus: result.response.status,
      provisionalCandidate:
        result.response.ok === true &&
        !currentState &&
        !confirmedScheduleId,
      shape: responseShape(result.payload, result.data),
    });
    const scheduleConfirmed = confirmedScheduleId === context.scheduleId;
    const jobSelected = currentState === 'JOB_SELECTED' || scheduleConfirmed;
    if (confirmedScheduleId && confirmedScheduleId !== context.scheduleId) {
      throw new DirectApplicationError('Job confirm response returned a different scheduleId.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
        httpStatus: result.response.status,
        currentState,
      });
    }

    return {
      currentState: currentState || (jobSelected ? 'JOB_SELECTED' : 'JOB_CONFIRM_PROVISIONAL'),
      confirmedScheduleId,
      provisional: !scheduleConfirmed,
      softReserveExpirationTimestamp:
        result.data?.softReserveExpirationTimestamp || null,
      responseStatus: result.response.status,
      raw: result.data,
    };
  }

  async function confirmJobWithCaptchaRecovery(context, applicationRef) {
    const applicationId = applicationIdFrom(applicationRef);
    const recovery = DIRECT_APPLICATION.JOB_CONFIRM_CAPTCHA_RECOVERY;
    let lastCaptchaError = null;
    let captchaSolved = false;

    for (let attempt = 0; attempt <= recovery.MAX_RETRIES; attempt += 1) {
      try {
        if (attempt > 0) {
          persistResult(context, DIRECT_APPLICATION.STAGES.JOB_CONFIRM_CAPTCHA_RETRYING, {
            applicationId,
            retryAttempt: attempt,
            retryMax: recovery.MAX_RETRIES,
            captchaSolved,
          });
          if (recovery.RETRY_DELAY_MS > 0) {
            await sleep(recovery.RETRY_DELAY_MS);
          }
        }

        return await confirmJobOnce(context, applicationRef, {
          preferRefreshToken: true,
          wafWaitMs: attempt > 0 || captchaSolved
            ? recovery.TOKEN_WAIT_AFTER_CAPTCHA_MS
            : undefined,
        });
      } catch (error) {
        const normalized = normalizeCaughtError(error);
        if (
          normalized.classification !== DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED
        ) {
          throw error;
        }

        lastCaptchaError = error;
        persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM, {
          applicationId,
          errorClassification: normalized.classification,
          errorCode: normalized.errorCode,
          errorMessage: normalized.errorMessage,
          httpStatus: normalized.httpStatus,
          retryAttempt: attempt,
          retryMax: recovery.MAX_RETRIES,
        });

        const captchaResult = await requestCaptchaChallenge(context, 'job-confirm', {
          applicationId,
        });
        if (!captchaResult.ok) {
          throw new DirectApplicationError('Amazon WAF CAPTCHA recovery failed.', {
            classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
            errorCode: normalized.errorCode,
            errorMessage:
              captchaResult.errorMessage ||
              normalized.errorMessage ||
              'Amazon WAF CAPTCHA recovery failed.',
            errorMetadata: normalized.errorMetadata,
            httpStatus: normalized.httpStatus,
            fallbackAllowed: false,
            failedStage: DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED,
            captchaReason: captchaResult.reason || 'captcha-failed',
          });
        }

        captchaSolved = true;
        if (attempt >= recovery.MAX_RETRIES) {
          throw lastCaptchaError;
        }
      }
    }

    throw lastCaptchaError || new DirectApplicationError('Job confirmation CAPTCHA recovery exhausted.', {
      classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
    });
  }

  async function requestApplicationVerification(applicationId) {
    const paths = [
      {
        path: DIRECT_APPLICATION.API_PATHS.APPLICATION_DETAILS,
        operation: 'application-details-verification',
        source: 'application-details',
      },
      {
        path: DIRECT_APPLICATION.API_PATHS.RESERVED_APPLICATION,
        operation: 'reservation-verification',
        source: 'reserved-application',
      },
    ].filter(entry => entry.path);

    let lastResult = null;
    for (const entry of paths) {
      const url = apiUrlWithSuffix(entry.path, applicationId);
      const result = await requestJsonAbsolute(url, {
        method: 'GET',
        headers: DIRECT_APPLICATION.REQUEST_HEADERS.RESERVED_APPLICATION,
      }, { operation: entry.operation });
      result.verificationSource = entry.source;
      lastResult = result;
      if (
        result.response.ok &&
        !result.data?.errorCode &&
        !result.data?.error &&
        !result.data?.errorMessage
      ) {
        return result;
      }
    }
    return lastResult;
  }

  async function verifyReservation(context, applicationId, options = {}) {
    const result = await requestApplicationVerification(applicationId);

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      return {
        verified: false,
        httpStatus: result.response.status,
        errorCode: getErrorCode(result.payload),
        errorMessage: getErrorMessage(result.payload),
        raw: result.data,
      };
    }

    const reservedScheduleId = result.data?.jobScheduleSelected?.scheduleId || null;
    const scheduleMatched = Boolean(reservedScheduleId && reservedScheduleId === context.scheduleId);
    const softVerified =
      options.requireScheduleMatch !== true &&
      !reservedScheduleId &&
      result.data?.currentState === 'JOB_SELECTED';
    const verified = scheduleMatched || softVerified;
    return {
      verified,
      httpStatus: result.response.status,
      reservedScheduleId,
      scheduleMatched,
      verificationMode: options.requireScheduleMatch === true ? 'strict-schedule' : 'soft-state',
      verificationSource: result.verificationSource || null,
      workflowStepName: result.data?.workflowStepName || null,
      currentState: result.data?.currentState || null,
      softReserveExpirationTimestamp:
        result.data?.softReserveExpirationTimestamp || null,
      raw: result.data,
    };
  }

  function isSuccessfulHttpStatus(value) {
    const status = Number(value);
    return Number.isFinite(status) && status >= 200 && status < 300;
  }

  function provisionalConfirmCanContinue(context, confirmed = {}) {
    return Boolean(
      context?.scheduleId &&
      confirmed?.provisional &&
      isSuccessfulHttpStatus(confirmed.responseStatus)
    );
  }

  function selectedScheduleForSuccess(context, confirmed = {}, verification = null) {
    return (
      confirmed?.confirmedScheduleId ||
      verification?.reservedScheduleId ||
      verification?.raw?.jobScheduleSelected?.scheduleId ||
      context?.scheduleId ||
      null
    );
  }

  async function verifyReservationBeforeSuccess(context, created, confirmed) {
    if (!DIRECT_APPLICATION.RESERVATION_VERIFY_BEFORE_SUCCESS && !confirmed?.provisional) {
      return null;
    }

    let verification;
    try {
      verification = await verifyReservation(context, created.applicationId, {
        requireScheduleMatch: Boolean(confirmed?.provisional),
      });
    } catch (verificationError) {
      if (!provisionalConfirmCanContinue(context, confirmed)) {
        throw verificationError;
      }
      const normalizedVerificationError = normalizeCaughtError(verificationError);
      persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId || null,
        currentState: confirmed.currentState || 'JOB_SELECTED',
        reservedScheduleId: context.scheduleId || null,
        confirmHttpStatus: confirmed.responseStatus || null,
        errorCode: normalizedVerificationError.errorCode,
        errorMessage:
          normalizedVerificationError.errorMessage ||
          'Reservation verification failed after successful job-confirm.',
        errorClassification: normalizedVerificationError.classification,
        httpStatus: normalizedVerificationError.httpStatus,
        fallbackAllowed: false,
        nonBlockingProvisional: true,
        provisionalConfirm: true,
      });
      return {
        verified: false,
        currentState: 'JOB_SELECTED',
        reservedScheduleId: context.scheduleId || null,
        provisionalAccepted: true,
        errorCode: normalizedVerificationError.errorCode,
        errorMessage: normalizedVerificationError.errorMessage,
      };
    }
    if (!verification.verified) {
      if (provisionalConfirmCanContinue(context, confirmed)) {
        persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED, {
          applicationId: created.applicationId,
          candidateId: created.candidateId || null,
          currentState: verification.currentState || confirmed.currentState || 'JOB_SELECTED',
          reservedScheduleId: verification.reservedScheduleId || context.scheduleId || null,
          confirmHttpStatus: confirmed.responseStatus || null,
          reservationHttpStatus: verification.httpStatus || null,
          reservationVerificationSource: verification.verificationSource || null,
          errorCode: verification.errorCode || null,
          errorMessage:
            verification.errorMessage ||
            'Reserved application did not contain the selected schedule yet.',
          errorClassification:
            DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
          fallbackAllowed: false,
          nonBlockingProvisional: true,
          provisionalConfirm: true,
          verificationMode: verification.verificationMode || null,
        });
        return {
          ...verification,
          verified: false,
          currentState: 'JOB_SELECTED',
          reservedScheduleId: verification.reservedScheduleId || context.scheduleId || null,
          provisionalAccepted: true,
        };
      }
      throw new DirectApplicationError('Reservation verification did not confirm selected schedule after job-confirm.', {
        classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
        httpStatus: verification.httpStatus || null,
        errorCode: verification.errorCode || null,
        errorMessage: verification.errorMessage || 'Reserved application did not contain the selected schedule.',
        failedStage: DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED,
        fallbackAllowed: false,
        errorMetadata: {
          reservedScheduleId: verification.reservedScheduleId || null,
          provisionalConfirm: Boolean(confirmed?.provisional),
          verificationMode: verification.verificationMode || null,
        },
      });
    }

    persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFIED, {
      applicationId: created.applicationId,
      candidateId: created.candidateId || null,
      currentState: verification.currentState || confirmed.currentState,
      reservedScheduleId: verification.reservedScheduleId,
      softReserveExpirationTimestamp:
        verification.softReserveExpirationTimestamp ||
        confirmed.softReserveExpirationTimestamp,
      reservationHttpStatus: verification.httpStatus,
      reservationVerificationSource: verification.verificationSource || null,
      provisionalConfirm: Boolean(confirmed?.provisional),
    });
    return verification;
  }

  function getWorkflowStepName(...records) {
    for (const record of records) {
      const direct = record?.workflowStepName || record?.raw?.workflowStepName;
      if (direct) return normalizeWorkflowStepName(direct);
    }
    return null;
  }

  function normalizeWorkflowStepName(value) {
    let normalized = String(value || '').trim();
    while (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    return normalized;
  }

  function shouldUpdateWorkflowStep(verification, confirmation) {
    if (!DIRECT_APPLICATION.WORKFLOW_STEP_UPDATE_ENABLED) return false;
    const currentWorkflowStep = getWorkflowStepName(verification, confirmation);
    return currentWorkflowStep !== DIRECT_APPLICATION.WORKFLOW_STEP_NAME;
  }

  async function updateWorkflowStep(applicationId) {
    const result = await requestJson(
      DIRECT_APPLICATION.API_PATHS.UPDATE_WORKFLOW_STEP_NAME,
      {
        method: 'PUT',
        headers: DIRECT_APPLICATION.REQUEST_HEADERS.WORKFLOW,
        body: JSON.stringify({
          applicationId,
          workflowStepName: DIRECT_APPLICATION.WORKFLOW_STEP_NAME,
        }),
      },
      { operation: 'workflow-step' }
    );

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      throw errorFromResult('Workflow step update', result);
    }

    return {
      currentState: result.data?.currentState || null,
      workflowStepName: result.data?.workflowStepName || null,
      responseStatus: result.response.status,
      raw: result.data,
    };
  }

  async function loadApplicationConfig() {
    const result = await requestJson(DIRECT_APPLICATION.API_PATHS.CONFIG, {
      method: 'GET',
      headers: DIRECT_APPLICATION.REQUEST_HEADERS.CONFIG,
    }, { operation: 'application-config' });

    if (!result.response.ok || result.data?.errorCode || result.data?.error || result.data?.errorMessage) {
      throw errorFromResult('Application config', result);
    }
    return result.data?.envConfig || result.data || {};
  }

  function getRouteBooleanParam(name) {
    try {
      const parsed = new URL(window.location.href);
      const hashParams = (() => {
        const queryStart = parsed.hash.indexOf('?');
        return queryStart >= 0
          ? new URLSearchParams(parsed.hash.slice(queryStart + 1))
          : new URLSearchParams();
      })();
      return (parsed.searchParams.get(name) || hashParams.get(name)) === 'true';
    } catch (_) {
      return false;
    }
  }

  function getStoredQueryParam(name) {
    try {
      const raw = window.sessionStorage?.getItem('query-params');
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed?.[name] ?? null;
    } catch (_) {
      return null;
    }
  }

  function isTruthyRouteOrStoredParam(name) {
    const storedValue = getStoredQueryParam(name);
    return (
      getRouteBooleanParam(name) ||
      storedValue === true ||
      String(storedValue || '').toLowerCase() === 'true'
    );
  }

  function findStoredAuthToken() {
    try {
      const parsed = new URL(window.location.href);
      const queryStart = parsed.hash.indexOf('?');
      const hashParams = queryStart >= 0
        ? new URLSearchParams(parsed.hash.slice(queryStart + 1))
        : new URLSearchParams();
      const routeToken = parsed.searchParams.get('token') || hashParams.get('token');
      if (routeToken) return routeToken;
    } catch (_) {
      // Fall back to browser storage below.
    }

    const stores = [window.sessionStorage, window.localStorage].filter(Boolean);
    const keyHints = ['auth', 'token', 'session'];
    for (const storeRef of stores) {
      for (let index = 0; index < storeRef.length; index += 1) {
        const key = storeRef.key(index);
        const raw = key ? storeRef.getItem(key) : null;
        if (!raw || raw.length < 8) continue;
        const normalizedKey = String(key || '').toLowerCase();
        if (keyHints.some(hint => normalizedKey.includes(hint))) return raw;
        if (/Status\|[^|]+\|Session\|/.test(raw)) return raw;
      }
    }
    return null;
  }

  function normalizeWebSocketProtocol(urlText) {
    if (urlText.startsWith('wss://') || urlText.startsWith('ws://')) return urlText;
    if (urlText.startsWith('https://')) return 'wss://' + urlText.slice('https://'.length);
    if (urlText.startsWith('http://')) return 'ws://' + urlText.slice('http://'.length);
    return urlText;
  }

  function getStoredAsoId() {
    try {
      const organizationRaw = window.sessionStorage?.getItem('organization');
      if (!organizationRaw) return null;
      const organization = JSON.parse(organizationRaw);
      if (
        organization?.staffingOrganizationType === 'ASO' &&
        organization?.organizationId
      ) {
        return organization.organizationId;
      }
    } catch (_) {
      // Optional official query parameter.
    }
    return null;
  }

  function decorateWorkflowSocketUrl(urlText, applicationId, candidateId) {
    let decorated = String(urlText || '')
      .replaceAll('{applicationId}', encodeURIComponent(applicationId))
      .replaceAll('{candidateId}', encodeURIComponent(candidateId || ''))
      .replaceAll(':applicationId', encodeURIComponent(applicationId))
      .replaceAll(':candidateId', encodeURIComponent(candidateId || ''));
    decorated = normalizeWebSocketProtocol(decorated);

    const url = new URL(decorated);
    if (!url.searchParams.has('authToken')) {
      url.searchParams.set('authToken', findStoredAuthToken() || 'dummy');
    }
    const asoId = getStoredAsoId();
    if (asoId && !url.searchParams.has('asoId')) {
      url.searchParams.set('asoId', asoId);
    }
    if (isTruthyRouteOrStoredParam('bypasscorp') && !url.searchParams.has('bypasscorp')) {
      url.searchParams.set('bypasscorp', 'true');
    }
    return url.toString();
  }

  function buildWorkflowSocketUrlCandidates(envConfig, applicationId, candidateId) {
    const endpoint =
      envConfig.stepFunctionEndpoint ||
      envConfig.stepfunctionEndpoint ||
      envConfig.stepFunctionUrl ||
      null;
    const queryPath =
      envConfig.stepFunctionQueryPath ||
      envConfig.stepfunctionQueryPath ||
      null;
    const domain =
      envConfig.CSDomain ||
      envConfig.csDomain ||
      envConfig.domain ||
      window.location.origin;

    const candidates = [];
    if (queryPath) {
      let queryUrl = null;
      if (String(queryPath).startsWith('http') || String(queryPath).startsWith('ws')) {
        queryUrl = queryPath;
      } else {
        const normalizedDomain = String(domain || window.location.origin).startsWith('http')
          ? String(domain || window.location.origin)
          : 'https://' + String(domain || window.location.host);
        const hostname = new URL(normalizedDomain).hostname;
        const suffix = String(queryPath).startsWith('/') || String(queryPath).startsWith('?')
          ? String(queryPath)
          : '/' + String(queryPath);
        queryUrl = 'wss://' + hostname + suffix;
      }
      candidates.push(queryUrl);
    }
    if (endpoint) candidates.push(endpoint);

    const decorated = [];
    for (const candidate of candidates) {
      try {
        const socketUrl = decorateWorkflowSocketUrl(candidate, applicationId, candidateId);
        if (!decorated.includes(socketUrl)) decorated.push(socketUrl);
      } catch (error) {
        log.debug('workflow websocket URL candidate skipped', {
          reason: error?.message || String(error),
        });
      }
    }
    return decorated;
  }

  function buildWorkflowSocketUrl(envConfig, applicationId, candidateId) {
    return buildWorkflowSocketUrlCandidates(envConfig, applicationId, candidateId)[0] || null;
  }

  function buildWorkflowMessages(context, created, confirmed, scheduleVerification, jobDetail) {
    const candidateId = created.candidateId || '';
    const partitionAttributes =
      confirmed.raw?.partitionAttributes ||
      created.raw?.partitionAttributes ||
      jobDetail?.partitionAttributes ||
      jobDetail?.raw?.partitionAttributes ||
      {};
    const scheduleDetail = scheduleVerification?.raw || {};
    const jobSelectedOn =
      confirmed.raw?.jobSelected?.jobSelectedOn ||
      confirmed.raw?.jobScheduleSelected?.jobScheduleSelectedTime ||
      '';
    const common = {
      applicationId: created.applicationId,
      candidateId,
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      partitionAttributes,
      filteringSeasonal: getRouteBooleanParam('filteringSeasonal'),
      filteringRegular: getRouteBooleanParam('filteringRegular'),
      domainType: DIRECT_APPLICATION.WORKFLOW_DOMAIN_TYPE,
    };

    return [
      {
        action: 'startWorkflow',
        ...common,
      },
      {
        action: 'completeTask',
        ...common,
        requisitionId: '',
        state: scheduleDetail.state || scheduleVerification?.state || '',
        employmentType:
          scheduleDetail.employmentType ||
          scheduleVerification?.employmentType ||
          '',
        eventSource: DIRECT_APPLICATION.WORKFLOW_EVENT_SOURCE,
        jobSelectedOn,
        currentWorkflowStep: DIRECT_APPLICATION.WORKFLOW_CURRENT_STEP_NAME,
        workflowStepName: '',
      },
    ];
  }

  function openWorkflowSocket(socketUrl, messages) {
    return new Promise((resolve, reject) => {
      let socket = null;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(result);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(error);
      };
      const timeoutId = window.setTimeout(() => {
        try {
          socket?.close?.();
        } catch (_) {
          // Ignore close errors.
        }
        fail(new DirectApplicationError('Workflow WebSocket did not open in time.', {
          classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT,
        }));
      }, DIRECT_APPLICATION.WORKFLOW_WEBSOCKET_OPEN_TIMEOUT_MS);

      try {
        socket = new window.WebSocket(socketUrl);
      } catch (error) {
        fail(error);
        return;
      }

      socket.onopen = () => {
        try {
          messages.forEach(message => socket.send(JSON.stringify(message)));
          window.setTimeout(() => {
            try {
              socket.close();
            } catch (_) {
              // Ignore close errors.
            }
            finish({
              skipped: false,
              socketUrl,
              messageCount: messages.length,
            });
          }, DIRECT_APPLICATION.WORKFLOW_WEBSOCKET_CLOSE_DELAY_MS);
        } catch (error) {
          fail(error);
        }
      };
      socket.onerror = () => {
        fail(new DirectApplicationError('Workflow WebSocket failed.', {
          classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT,
        }));
      };
    });
  }

  async function sendWorkflowWebSocket(context, created, confirmed, scheduleVerification, jobDetail) {
    if (!DIRECT_APPLICATION.WORKFLOW_WEBSOCKET_ENABLED) {
      return { skipped: true, reason: 'disabled' };
    }
    if (typeof window.WebSocket !== 'function') {
      return { skipped: true, reason: 'websocket-unavailable' };
    }

    const envConfig = await loadApplicationConfig();
    const socketUrls = buildWorkflowSocketUrlCandidates(envConfig, created.applicationId, created.candidateId);
    if (!socketUrls.length) {
      return { skipped: true, reason: 'missing-stepfunction-endpoint' };
    }

    const messages = buildWorkflowMessages(context, created, confirmed, scheduleVerification, jobDetail);
    let lastError = null;
    for (const socketUrl of socketUrls) {
      try {
        return await openWorkflowSocket(socketUrl, messages);
      } catch (error) {
        lastError = error;
        log.debug('workflow websocket candidate failed', {
          candidateIndex: socketUrls.indexOf(socketUrl),
          candidateCount: socketUrls.length,
          error: error?.message || String(error),
        });
      }
    }
    throw lastError || new DirectApplicationError('Workflow WebSocket failed.', {
      classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT,
    });
  }

  async function runWorkflowWebSocketObservability(context, created, confirmed, scheduleVerification, jobDetail) {
    try {
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_WS_STARTED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId || null,
        currentState: confirmed.currentState,
        workflowWsStatus: 'started',
      });
      const result = await sendWorkflowWebSocket(context, created, confirmed, scheduleVerification, jobDetail);
      if (result?.skipped) {
        persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_WS_SKIPPED, {
          applicationId: created.applicationId,
          candidateId: created.candidateId || null,
          currentState: confirmed.currentState,
          workflowWsStatus: result.reason || 'skipped',
        });
      } else {
        persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED, {
          applicationId: created.applicationId,
          candidateId: created.candidateId || null,
          currentState: confirmed.currentState,
          workflowWsStatus: 'completed',
          workflowWsMessageCount: result.messageCount || null,
        });
      }
      return result;
    } catch (error) {
      const normalized = normalizeCaughtError(error);
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_WS_FAILED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId || null,
        currentState: confirmed.currentState,
        workflowWsStatus: 'failed',
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorMessage,
        errorClassification: normalized.classification,
        httpStatus: normalized.httpStatus,
      });
      return null;
    }
  }

  function hashSearchParams(parsed) {
    const hash = parsed?.hash || '';
    const queryStart = hash.indexOf('?');
    return queryStart >= 0
      ? new URLSearchParams(hash.slice(queryStart + 1))
      : new URLSearchParams();
  }

  function applicationCountryPathForContext(context = {}, parsed = null) {
    const country = String(context.country || '').trim().toLowerCase();
    const locale = String(context.locale || '').trim().toLowerCase();
    const hostname = String(parsed?.hostname || '').trim().toLowerCase();
    const configs = Object.values(AMAZON.COUNTRY_CONFIGS || {});
    const config = configs.find(item => {
      if (!item) return false;
      return (
        hostname === String(item.domain || '').toLowerCase() ||
        country === String(item.applicationCountryPath || '').toLowerCase() ||
        country === String(item.countryCode || '').toLowerCase() ||
        country === String(item.country || '').toLowerCase() ||
        locale === String(item.locale || '').toLowerCase()
      );
    }) || AMAZON.COUNTRY_CONFIG;
    return String(config?.applicationCountryPath || context.country || '').trim().toLowerCase();
  }

  function normalizeApplicationRoutePath(parsed, context = {}) {
    if (!parsed) return;
    const pathname = parsed.pathname || '';
    const normalizedPathname = pathname.endsWith('/') ? pathname : pathname + '/';
    if ((AMAZON.APPLICATION_PATH_SEGMENTS || []).includes(normalizedPathname)) return;
    if (pathname !== '/application' && pathname !== '/application/') return;

    const countryPath = applicationCountryPathForContext(context, parsed);
    if (!countryPath) return;
    parsed.pathname = '/application/' + countryPath + '/';
  }

  function buildApplicationRouteHandoffUrl(context, routeName, options = {}) {
    const includeScheduleId = options.includeScheduleId === true;
    const applicationId = options.applicationId || null;
    const parsed = new URL(context.href || window.location.href);
    normalizeApplicationRoutePath(parsed, context);
    const mergedParams = new URLSearchParams();
    const copyParam = (key, value) => {
      if (!key || value === undefined || value === null || value === '') return;
      if (!includeScheduleId && String(key).toLowerCase() === 'scheduleid') return;
      mergedParams.set(key, value);
    };

    const country = applicationCountryPathForContext(context, parsed);
    const locale = context.locale || AMAZON.COUNTRY_CONFIG?.locale || null;
    parsed.searchParams.forEach((value, key) => copyParam(key, value));
    hashSearchParams(parsed).forEach((value, key) => copyParam(key, value));
    copyParam('country', country || null);
    copyParam('locale', context.locale || AMAZON.COUNTRY_CONFIG?.locale || null);
    copyParam('jobId', context.jobId || null);
    copyParam('applicationId', applicationId || null);
    if (includeScheduleId) copyParam('scheduleId', context.scheduleId || null);

    if (country) parsed.searchParams.set('country', country);
    if (locale) parsed.searchParams.set('locale', locale);
    if (context.jobId) parsed.searchParams.set('jobId', context.jobId);
    if (applicationId) parsed.searchParams.set('applicationId', applicationId);
    if (includeScheduleId && context.scheduleId) {
      parsed.searchParams.set('scheduleId', context.scheduleId);
    } else {
      parsed.searchParams.delete('scheduleId');
    }
    parsed.hash = '#/' + routeName + '?' + mergedParams.toString();
    return parsed.toString();
  }

  function buildConsentHandoffUrl(context, applicationId, options = {}) {
    return buildApplicationRouteHandoffUrl(context, 'consent', {
      ...options,
      applicationId,
    });
  }

  function notificationRedirectUrl(value) {
    try {
      const parsed = new URL(value);
      const removeSensitive = searchParams => {
        [...searchParams.keys()].forEach(key => {
          const normalized = String(key || '').toLowerCase();
          if (
            normalized.includes('token') ||
            normalized.includes('captcha') ||
            normalized.includes('csrf') ||
            normalized.includes('secret') ||
            normalized.includes('session') ||
            normalized.includes('waf')
          ) {
            searchParams.delete(key);
          }
        });
      };
      removeSensitive(parsed.searchParams);
      const hash = parsed.hash || '';
      const queryStart = hash.indexOf('?');
      if (queryStart >= 0) {
        const route = hash.slice(1, queryStart);
        const params = new URLSearchParams(hash.slice(queryStart + 1));
        removeSensitive(params);
        const serialized = params.toString();
        parsed.hash = '#' + route + (serialized ? '?' + serialized : '');
      }
      return parsed.toString();
    } catch (_) {
      return value || null;
    }
  }

  function successHandoffInfo(context, applicationId, options = {}) {
    const handoffContext = {
      ...context,
      scheduleId: options.scheduleId || context.scheduleId || null,
    };
    const useApplicationHandoff = Boolean(applicationId);
    const routeName = handoffContext.scheduleId
      ? DIRECT_APPLICATION.WORKFLOW_STEP_NAME
      : 'consent';
    const redirectUrl = useApplicationHandoff
      ? buildApplicationRouteHandoffUrl(handoffContext, routeName, {
        applicationId,
        includeScheduleId: Boolean(handoffContext.scheduleId),
      })
      : AMAZON.URLS.JOB_SEARCH;
    return {
      context: handoffContext,
      redirectUrl,
      routeName: useApplicationHandoff ? routeName : null,
      useConsentHandoff: useApplicationHandoff && routeName === 'consent',
      useApplicationHandoff,
      redirectDelay: useApplicationHandoff
        ? DIRECT_APPLICATION.CONSENT_REDIRECT_DELAY_MS
        : DIRECT_APPLICATION.UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS,
    };
  }

  function scheduleConsentHandoff(context, applicationId, options = {}) {
    const markSelectedScheduleUnavailable = options.markSelectedScheduleUnavailable !== false;
    if (markSelectedScheduleUnavailable && context.scheduleId) {
      try {
        window.sessionStorage?.setItem(
          DIRECT_APPLICATION.FALLBACK_SELECTED_SCHEDULE_SESSION_KEY,
          context.scheduleId
        );
      } catch (_) {
        // Official UI uses this session marker only to show a banner later.
      }
    }

    if (!DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS) return;

    const redirectUrl = buildConsentHandoffUrl(context, applicationId, {
      includeScheduleId: options.includeScheduleId === true,
    });
    log.info(options.logMessage || 'official fallback consent redirect scheduled', {
      redirectUrl,
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId,
    });

    window.setTimeout(() => {
      window.location.assign(redirectUrl);
    }, DIRECT_APPLICATION.CONSENT_REDIRECT_DELAY_MS);
  }

  function scheduleNoAvailableShiftHandoff(context, normalized = {}, scheduleList = {}) {
    const redirectUrl = buildApplicationRouteHandoffUrl(context, 'no-available-shift', {
      includeScheduleId: false,
    });

    persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_UNAVAILABLE, {
      scheduleStatus: normalized.errorMetadata?.scheduleStatus || normalized.errorCode || null,
      errorCode: normalized.errorCode || 'NO_SCHEDULE_FOUND',
      errorMessage: normalized.errorMessage || 'No available schedules were found for this job.',
      errorClassification:
        normalized.classification ||
        DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      scheduleListHttpStatus: scheduleList.httpStatus || null,
      fallbackScheduleCount: scheduleList.total ?? scheduleList.schedules?.length ?? 0,
      noAvailableShift: true,
      redirectUrl,
    });
    finalizeObservabilityOutcome(context, 'SCHEDULE_UNAVAILABLE', {
      detailedOutcome: 'NO_AVAILABLE_SHIFT',
      errorCode: normalized.errorCode || 'NO_SCHEDULE_FOUND',
      errorMessage: normalized.errorMessage || 'No available schedules were found for this job.',
      errorClassification:
        normalized.classification ||
        DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      scheduleRecoveryHttpStatus: scheduleList.httpStatus || null,
      fallbackScheduleCount: scheduleList.total ?? scheduleList.schedules?.length ?? 0,
    });

    notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      errorCode: normalized.errorCode || 'NO_SCHEDULE_FOUND',
      errorMessage: normalized.errorMessage || 'No available schedules were found for this job.',
      errorClassification:
        normalized.classification ||
        DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      httpStatus: normalized.httpStatus || scheduleList.httpStatus || null,
      noAvailableShift: true,
      redirectUrl: notificationRedirectUrl(redirectUrl),
      pageUrl: context.href,
    });

    if (!DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS) return;
    window.setTimeout(() => {
      window.location.assign(redirectUrl);
    }, DIRECT_APPLICATION.NO_AVAILABLE_SHIFT_REDIRECT_DELAY_MS);
  }

  function applicationErrorRoute(normalized = {}) {
    if (normalized.classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ALREADY_APPLIED) {
      return {
        route: 'already-applied',
      };
    }
    if (
      normalized.classification ===
      DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.RESETTABLE_EXISTING_APPLICATION
    ) {
      return {
        route: 'already-applied-but-can-be-reset',
      };
    }
    return null;
  }

  function notifyApplicationErrorFailure(context, normalized = {}, redirectUrl = null) {
    notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId: context.applicationId || null,
      errorCode: normalized.errorCode || null,
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification || null,
      httpStatus: normalized.httpStatus || null,
      redirectUrl: notificationRedirectUrl(redirectUrl),
      pageUrl: context.href,
    });
  }

  function scheduleApplicationErrorHandoff(context, normalized = {}, options = {}) {
    const routeInfo = applicationErrorRoute(normalized);
    if (!routeInfo) return false;

    const redirectUrl = buildApplicationRouteHandoffUrl(context, routeInfo.route, {
      includeScheduleId: true,
    });
    if (options.notifyFailure) {
      notifyApplicationErrorFailure(context, normalized, redirectUrl);
    }
    persistResult(context, DIRECT_APPLICATION.STAGES.FAILED, {
      errorCode: normalized.errorCode || null,
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification,
      errorMetadata: normalized.errorMetadata || null,
      httpStatus: normalized.httpStatus || null,
      officialErrorRoute: routeInfo.route,
      redirectUrl,
    });
    finalizeObservabilityOutcome(
      context,
      observability?.outcomeForErrorClassification?.(normalized.classification) || 'ALREADY_APPLIED',
      {
        detailedOutcome: routeInfo.route || 'EXISTING_APPLICATION',
        errorCode: normalized.errorCode || null,
        errorMessage: normalized.errorMessage || null,
        errorClassification: normalized.classification || null,
        httpStatus: normalized.httpStatus || null,
      }
    );

    if (!DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS) return true;
    window.setTimeout(() => {
      window.location.assign(redirectUrl);
    }, DIRECT_APPLICATION.CONSENT_REDIRECT_DELAY_MS);
    return true;
  }

  async function finishWithoutScheduleFallback(
    context,
    fallback,
    scheduleDetailPromise,
    jobDetailPromise,
    scheduleVerification = null
  ) {
    const created = fallback.created;
    if (await finishAlreadySelectedApplication(context, created, {
      reason: fallback.reusedExistingApplication
        ? 'fallback-reused-existing-job-selected'
        : 'fallback-create-returned-job-selected',
      message: 'Booking already confirmed on Amazon for this application.',
    })) {
      return;
    }

    const confirmed = {
      currentState: created.currentState || 'APPLICATION_CREATED',
      confirmedScheduleId: null,
      provisional: false,
      softReserveExpirationTimestamp: null,
      responseStatus: created.responseStatus,
      withoutSelectedSchedule: true,
      raw: created.raw || {},
    };
    if (!scheduleVerification) {
      scheduleVerification = await waitForWorkflowPrefetch(scheduleDetailPromise);
    }
    const jobDetail = await waitForWorkflowPrefetch(jobDetailPromise);

    persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE, {
      applicationId: created.applicationId,
      candidateId: created.candidateId || null,
      currentState: created.currentState,
      createHttpStatus: created.responseStatus,
      withoutSelectedSchedule: true,
      fallbackWithoutSchedule: true,
      fallbackScheduleCount:
        fallback.scheduleList?.total ?? fallback.scheduleList?.schedules?.length ?? null,
      fallbackOriginalScheduleId: context.scheduleId || null,
    });

    await runWorkflowWebSocketObservability(context, created, confirmed, scheduleVerification, jobDetail);
    finalizeObservabilityOutcome(context, 'APPLICATION_CREATED_WITHOUT_SCHEDULE', {
      detailedOutcome: 'APPLICATION_CREATED_WITHOUT_SCHEDULE',
      applicationId: created.applicationId,
      createHttpStatus: created.responseStatus || null,
      fallbackWithoutSchedule: true,
      fallbackScheduleCount:
        fallback.scheduleList?.total ?? fallback.scheduleList?.schedules?.length ?? null,
      errorCode: 'SELECTED_SCHEDULE_NOT_AVAILABLE',
      errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
    });
    const redirectUrl = AMAZON.URLS.JOB_SEARCH;
    const unavailableFailure = {
      classification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      errorCode: 'SELECTED_SCHEDULE_NOT_AVAILABLE',
      errorMessage: 'Selected schedule was not available before create application.',
      httpStatus: scheduleVerification?.httpStatus || null,
    };
    notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId: created.applicationId,
      currentState: confirmed.currentState,
      withoutSelectedSchedule: true,
      errorCode: 'SELECTED_SCHEDULE_NOT_AVAILABLE',
      errorClassification:
        DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      message:
        'Application was created, but the selected schedule was not booked. Returning to job search.',
      redirectUrl: notificationRedirectUrl(redirectUrl),
      pageUrl: context.href,
    });
    scheduleFailureHandoff(context, unavailableFailure, created.applicationId);
  }

  async function schedulePostCreateConfirmFailureHandoff(context, created, normalized) {
    if (
      DIRECT_APPLICATION.POST_CREATE_CONFIRM_FAILURE_CONSENT_HANDOFF_ENABLED === false ||
      !created?.applicationId ||
      normalized.failedStage === DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED ||
      normalized.classification !==
        DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED
    ) {
      return false;
    }

    if (await finishAlreadySelectedApplication(context, created, {
      reason: 'post-create-confirm-failed-existing-job-selected',
      message: 'Booking already confirmed on Amazon for this application.',
    })) {
      return true;
    }
    if (hasTerminalBookingSuccess(context, { applicationId: created.applicationId })) {
      log.warn('post-create confirm failure suppressed because this application is already booked', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: created.applicationId,
        errorCode: normalized.errorCode || null,
        errorClassification: normalized.classification || null,
      });
      return true;
    }

    persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE, {
      applicationId: created.applicationId,
      candidateId: created.candidateId || null,
      currentState: created.currentState || 'APPLICATION_CREATED',
      createHttpStatus: created.responseStatus || null,
      withoutSelectedSchedule: true,
      fallbackWithoutSchedule: true,
      postCreateConfirmFailed: true,
      fallbackOriginalScheduleId: context.scheduleId || null,
      errorCode: normalized.errorCode || null,
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification,
      httpStatus: normalized.httpStatus || null,
    });
    finalizeObservabilityOutcome(context, 'APPLICATION_CREATED_WITHOUT_SCHEDULE', {
      detailedOutcome: 'POST_CREATE_CONFIRM_FAILED',
      applicationId: created.applicationId,
      createHttpStatus: created.responseStatus || null,
      fallbackWithoutSchedule: true,
      errorCode: normalized.errorCode || 'SELECTED_SCHEDULE_NOT_AVAILABLE',
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification,
      confirmHttpStatus: normalized.httpStatus || null,
    });
    const redirectUrl = AMAZON.URLS.JOB_SEARCH;
    notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId: created.applicationId,
      currentState: created.currentState || 'APPLICATION_CREATED',
      withoutSelectedSchedule: true,
      postCreateConfirmFailed: true,
      errorCode: normalized.errorCode || 'SELECTED_SCHEDULE_NOT_AVAILABLE',
      errorMessage: normalized.errorMessage || null,
      errorClassification: normalized.classification,
      httpStatus: normalized.httpStatus || null,
      message:
        'Application was created, but the selected schedule could not be confirmed. Returning to job search.',
      redirectUrl: notificationRedirectUrl(redirectUrl),
      pageUrl: context.href,
    });
    scheduleFailureHandoff(context, normalized, created.applicationId);
    return true;
  }

  function scheduleSuccessHandoff(context, applicationId, options = {}) {
    const handoff = options.handoff || successHandoffInfo(context, applicationId, options);
    const handoffContext = handoff.context || context;
    if (!DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS) return handoff;
    if (!claimSuccessHandoffNavigation(handoffContext, applicationId, handoff.redirectUrl)) {
      log.debug('selected-schedule application form redirect already scheduled; suppressing duplicate handoff', {
        redirectUrl: handoff.redirectUrl,
        routeName: handoff.routeName || null,
        jobId: handoffContext.jobId,
        scheduleId: handoffContext.scheduleId,
        applicationId,
      });
      return handoff;
    }

    const handoffMessage = handoff.routeName === DIRECT_APPLICATION.WORKFLOW_STEP_NAME
      ? 'official selected-schedule application form redirect scheduled'
      : handoff.useConsentHandoff
        ? 'official selected-schedule consent redirect scheduled'
        : 'direct success redirect scheduled';
    log.info(handoffMessage, {
      redirectUrl: handoff.redirectUrl,
      routeName: handoff.routeName || null,
      jobId: handoffContext.jobId,
      scheduleId: handoffContext.scheduleId,
      applicationId,
    });

    window.setTimeout(() => {
      window.location.assign(handoff.redirectUrl);
    }, handoff.redirectDelay);
    return handoff;
  }

  function scheduleFailureHandoff(context, normalized, applicationId) {
    if (hasTerminalBookingSuccess(context, { applicationId })) {
      log.warn('schedule failure handoff suppressed because this application is already booked', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId,
        errorCode: normalized.errorCode,
        errorClassification: normalized.classification,
      });
      return;
    }

    const isUnavailableOrReservationFailure =
      normalized.classification ===
      DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED;
    if (isUnavailableOrReservationFailure) {
      markUnavailableScheduleCooldown(context, normalized, applicationId);
    }
    if (
      !isUnavailableOrReservationFailure
    ) {
      return;
    }

    log.warn('schedule unavailable after direct create; returning to job search', {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId,
      errorCode: normalized.errorCode,
      errorMessage: normalized.errorMessage,
      redirectUrl: AMAZON.URLS.JOB_SEARCH,
    });

    window.setTimeout(() => {
      window.location.assign(AMAZON.URLS.JOB_SEARCH);
    }, DIRECT_APPLICATION.UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS);
  }

  function normalizeCaughtError(error) {
    if (error instanceof DirectApplicationError) {
      return {
        classification: error.classification || DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNKNOWN,
        errorCode: error.errorCode || null,
        errorMessage: error.errorMessage || error.message || String(error),
        errorMetadata: error.errorMetadata || null,
        httpStatus: error.httpStatus || null,
        fallbackAllowed: error.fallbackAllowed !== false,
        failedStage: error.failedStage || null,
        captchaReason: error.captchaReason || null,
      };
    }

    const classification = classifyError({ error });
    return {
      classification,
      errorCode: null,
      errorMessage:
        error?.name === 'AbortError'
          ? 'Direct application request timed out.'
          : (error?.message || String(error)),
      errorMetadata: null,
      httpStatus: null,
      fallbackAllowed: true,
      failedStage: null,
      captchaReason: null,
    };
  }

  async function runPostConfirmObservability(context, created, confirmed, knownVerification = null) {
    let verification = knownVerification;
    try {
      if (!verification) verification = await verifyReservation(context, created.applicationId);
      if (verification.verified) {
        persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFIED, {
          applicationId: created.applicationId,
          currentState: verification.currentState || confirmed.currentState,
          reservedScheduleId: verification.reservedScheduleId,
          softReserveExpirationTimestamp:
            verification.softReserveExpirationTimestamp ||
            confirmed.softReserveExpirationTimestamp,
          reservationHttpStatus: verification.httpStatus,
          reservationVerificationSource: verification.verificationSource || null,
        });
      } else {
        log.debug('reservation verification did not confirm selected schedule after job-confirm success', {
          jobId: context.jobId,
          scheduleId: context.scheduleId,
          applicationId: created.applicationId,
          currentState: confirmed.currentState,
          httpStatus: verification.httpStatus || null,
          errorCode: verification.errorCode || null,
          errorMessage: verification.errorMessage || null,
        });
      }
    } catch (verificationError) {
      const normalizedVerificationError = normalizeCaughtError(verificationError);
      log.debug('reservation verification observability failed after job-confirm success', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: created.applicationId,
        currentState: confirmed.currentState,
        errorCode: normalizedVerificationError.errorCode,
        errorMessage: normalizedVerificationError.errorMessage,
        errorClassification: normalizedVerificationError.classification,
        httpStatus: normalizedVerificationError.httpStatus,
      });
    }

    if (!shouldUpdateWorkflowStep(verification, confirmed)) {
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATE_SKIPPED, {
        applicationId: created.applicationId,
        currentState: verification?.currentState || confirmed.currentState,
        workflowStepName: getWorkflowStepName(verification, confirmed),
      });
      return;
    }

    try {
      const workflow = await updateWorkflowStep(created.applicationId);
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED, {
        applicationId: created.applicationId,
        currentState: workflow.currentState,
        workflowStepName: workflow.workflowStepName,
        workflowHttpStatus: workflow.responseStatus,
      });
    } catch (workflowError) {
      const normalizedWorkflowError = normalizeCaughtError(workflowError);
      log.debug('workflow step observability update failed after job-confirm success', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: created.applicationId,
        currentState: confirmed.currentState,
        errorCode: normalizedWorkflowError.errorCode,
        errorMessage: normalizedWorkflowError.errorMessage,
        errorClassification: normalizedWorkflowError.classification,
        httpStatus: normalizedWorkflowError.httpStatus,
      });
    }
  }

  async function prepareSelectedScheduleFormHandoff(
    context,
    created,
    confirmed,
    knownVerification,
    scheduleVerification,
    scheduleDetailPromise,
    jobDetail,
    jobDetailPromise
  ) {
    let verification = knownVerification;
    if (!verification) {
      try {
        verification = await verifyReservation(context, created.applicationId);
      } catch (verificationError) {
        const normalizedVerificationError = normalizeCaughtError(verificationError);
        verification = {
          verified: false,
          httpStatus: normalizedVerificationError.httpStatus || null,
          errorCode: normalizedVerificationError.errorCode || null,
          errorMessage:
            normalizedVerificationError.errorMessage ||
            'Application details verification failed before form handoff.',
          currentState: confirmed.currentState || null,
          reservedScheduleId: null,
          verificationMode: 'form-handoff-exception',
          verificationSource: null,
          raw: null,
        };
      }
    }

    if (verification.verified) {
      persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFIED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId || null,
        currentState: verification.currentState || confirmed.currentState,
        reservedScheduleId: verification.reservedScheduleId,
        softReserveExpirationTimestamp:
          verification.softReserveExpirationTimestamp ||
          confirmed.softReserveExpirationTimestamp,
        reservationHttpStatus: verification.httpStatus,
        reservationVerificationSource: verification.verificationSource || null,
        formHandoff: true,
      });
    } else {
      persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId || null,
        currentState: verification.currentState || confirmed.currentState || 'JOB_SELECTED',
        reservedScheduleId: verification.reservedScheduleId || context.scheduleId || null,
        reservationHttpStatus: verification.httpStatus || null,
        reservationVerificationSource: verification.verificationSource || null,
        errorCode: verification.errorCode || null,
        errorMessage:
          verification.errorMessage ||
          'Application details did not contain the selected schedule before form handoff.',
        errorClassification:
          DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
        fallbackAllowed: false,
        verificationMode: verification.verificationMode || null,
        formHandoff: true,
        nonBlockingFormHandoff: true,
      });
    }

    const [workflowScheduleVerification, workflowJobDetail] = await Promise.all([
      scheduleVerification || waitForWorkflowPrefetch(scheduleDetailPromise),
      jobDetail || waitForWorkflowPrefetch(jobDetailPromise),
    ]);
    await runWorkflowWebSocketObservability(
      context,
      created,
      confirmed,
      workflowScheduleVerification,
      workflowJobDetail
    );

    let workflow = null;
    try {
      workflow = await updateWorkflowStep(created.applicationId);
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATED, {
        applicationId: created.applicationId,
        currentState: workflow.currentState,
        workflowStepName: workflow.workflowStepName,
        workflowHttpStatus: workflow.responseStatus,
        formHandoff: true,
      });
    } catch (workflowError) {
      const normalizedWorkflowError = normalizeCaughtError(workflowError);
      persistResult(context, DIRECT_APPLICATION.STAGES.WORKFLOW_UPDATE_FAILED, {
        applicationId: created.applicationId,
        currentState: verification.currentState || confirmed.currentState,
        errorCode: normalizedWorkflowError.errorCode,
        errorMessage: normalizedWorkflowError.errorMessage,
        errorClassification: normalizedWorkflowError.classification,
        httpStatus: normalizedWorkflowError.httpStatus,
        formHandoff: true,
      });
      throw workflowError;
    }

    try {
      const postWorkflowVerification = await verifyReservation(context, created.applicationId);
      if (postWorkflowVerification.verified) {
        persistResult(context, DIRECT_APPLICATION.STAGES.RESERVATION_VERIFIED, {
          applicationId: created.applicationId,
          candidateId: created.candidateId || null,
          currentState: postWorkflowVerification.currentState || workflow.currentState || confirmed.currentState,
          reservedScheduleId: postWorkflowVerification.reservedScheduleId,
          softReserveExpirationTimestamp:
            postWorkflowVerification.softReserveExpirationTimestamp ||
            verification.softReserveExpirationTimestamp ||
            confirmed.softReserveExpirationTimestamp,
          reservationHttpStatus: postWorkflowVerification.httpStatus,
          reservationVerificationSource: postWorkflowVerification.verificationSource || null,
          workflowStepName: getWorkflowStepName(postWorkflowVerification, workflow, verification),
          formHandoff: true,
          postWorkflowUpdate: true,
        });
        return postWorkflowVerification;
      }
    } catch (verificationError) {
      const normalizedVerificationError = normalizeCaughtError(verificationError);
      log.debug('post-workflow application rehydrate failed before form handoff', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: created.applicationId,
        errorCode: normalizedVerificationError.errorCode,
        errorMessage: normalizedVerificationError.errorMessage,
        errorClassification: normalizedVerificationError.classification,
        httpStatus: normalizedVerificationError.httpStatus,
      });
    }

    return {
      ...verification,
      currentState: workflow.currentState || verification.currentState || confirmed.currentState || 'JOB_SELECTED',
      workflowStepName:
        workflow.workflowStepName ||
        verification.workflowStepName ||
        DIRECT_APPLICATION.WORKFLOW_STEP_NAME,
      reservedScheduleId: verification.reservedScheduleId || context.scheduleId || null,
      raw: workflow.raw || verification.raw,
    };
  }

  function runSuccessPostConfirmObservability(
    context,
    created,
    confirmed,
    knownVerification,
    scheduleVerification,
    scheduleDetailPromise,
    jobDetail,
    jobDetailPromise
  ) {
    void (async () => {
      const [workflowScheduleVerification, workflowJobDetail] = await Promise.all([
        scheduleVerification || waitForWorkflowPrefetch(scheduleDetailPromise),
        jobDetail || waitForWorkflowPrefetch(jobDetailPromise),
      ]);
      await runWorkflowWebSocketObservability(
        context,
        created,
        confirmed,
        workflowScheduleVerification,
        workflowJobDetail
      );
      await runPostConfirmObservability(context, created, confirmed, knownVerification);
    })().catch(error => {
      log.debug('post-confirm success observability failed:', error?.message || String(error));
    });
  }

  async function handleApplicationFormOpened(context) {
    const route = urls.getApplicationRouteName?.(context.href) || null;
    const finalFormOpened = urls.isFinalApplicationFormPage?.(context.href) === true;
    const manualMode = !directApplicationMode.isEnabled();
    const mode = manualMode ? 'manual' : 'direct';
    const claimedFinalFormOpened = finalFormOpened
      ? claimFormOpenedNotification(context, mode)
      : false;
    if (finalFormOpened && !claimedFinalFormOpened) {
      removeSessionKey(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
      return;
    }
    log.info('application form opened; recording observability and clearing handoff state', {
      jobId: context.jobId,
      scheduleId: context.scheduleId,
      applicationId: context.applicationId || null,
      route,
      finalFormOpened,
      mode,
      pageUrl: notificationRedirectUrl(context.href),
    });
    if (finalFormOpened) {
      try {
        const terminalFormOpened = manualMode || Boolean(context.scheduleId);
        const recordFormOpened = observability?.recordApplicationFormOpened?.(context, {
          route,
          source: 'application-form-route',
          terminal: terminalFormOpened,
          outcome: terminalFormOpened ? 'BOOKED' : 'APPLICATION_CREATED',
        });
        if (recordFormOpened?.catch) {
          void recordFormOpened.catch(error => {
            log.debug('application form opened observability failed:', error?.message || String(error));
          });
        }
      } catch (error) {
        log.debug('application form opened observability failed:', error?.message || String(error));
      }
    }
    if (finalFormOpened && claimedFinalFormOpened) {
      const formOpenedPayload = {
        jobId: context.jobId,
        scheduleId: context.scheduleId || null,
        applicationId: context.applicationId || null,
        currentState: 'APPLICATION_FORM_OPENED',
        selectedScheduleId: context.scheduleId || null,
        workflowStepName: route,
        mode,
        message: mode === 'manual'
          ? 'Manual application form opened.'
          : 'Direct application form opened.',
        redirectUrl: notificationRedirectUrl(context.href),
        pageUrl: context.href,
        dedupeKey: [
          'form-opened',
          mode,
          context.jobId || '',
          context.scheduleId || '',
          context.applicationId || '',
        ].join('::'),
      };
      if (manualMode) {
        notify(NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED, {
          ...formOpenedPayload,
          message: 'Booking confirmed after manual application form opened.',
          dedupeKey: [
            'manual-booked-form-opened',
            context.jobId || '',
            context.scheduleId || '',
            context.applicationId || '',
          ].join('::'),
        });
      }
      notify(NOTIFICATIONS.EVENTS.FORM_OPENED, formOpenedPayload);
      try {
        const usage = await root.AMZ_PAYMENT_GATE?.recordBookingUsage?.({
          jobId: context.jobId || null,
          scheduleId: context.scheduleId || context.applicationId || null,
          metadata: {
            source: 'application-form-opened',
            route,
            mode,
            applicationId: context.applicationId || null,
            pageUrl: context.href,
          },
        });
        if (!usage?.ok) {
          log.warn('booking usage recording failed after application form opened', {
            reason: usage?.reason || 'usage-denied',
            jobId: context.jobId || null,
            scheduleId: context.scheduleId || null,
          });
        }
      } catch (error) {
        log.warn('booking usage recording failed after application form opened', {
          message: error?.message || String(error),
          jobId: context.jobId || null,
          scheduleId: context.scheduleId || null,
        });
      }
    }
    removeSessionKey(BOOKING_CONFIRMED_TOAST_SESSION_KEY);
  }

  async function run(trigger = 'initial') {
    const runEnteredTiming = observabilityTiming();
    const context = currentContext();
    if (!urls.isApplicationPage(context.href) || !context.jobId) return;

    const activeState = await storage.getLocal([
      STORAGE_KEYS.ACTIVE,
      STORAGE_KEYS.USE_DIRECT_APPLICATION,
    ]);
    directApplicationMode.setEnabled(activeState[STORAGE_KEYS.USE_DIRECT_APPLICATION]);
    context.clientEmail = await resolveAttemptClientEmail();
    activeAttemptClientEmail = context.clientEmail || null;
    const existingGuard = parseGuard(context);
    hydrateContextFromGuard(context, existingGuard);
    if (activeState[STORAGE_KEYS.ACTIVE] !== true) {
      observability?.finalizePendingDeactivated?.(context, {
        source: 'application-route-inactive',
        page_url: context.href,
      });
      return;
    }

    const paidGate = root.AMZ_PAYMENT_GATE?.requireAllowed
      ? await root.AMZ_PAYMENT_GATE.requireAllowed({ allowCache: true })
      : (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test' ? { ok: true } : { ok: false });
    if (!paidGate.ok) {
      log.warn('direct booking blocked because paid license is not valid', {
        reason: paidGate?.reason || 'license-denied',
        jobId: context.jobId || null,
        scheduleId: context.scheduleId || null,
      });
      root.AMZ_TOASTS?.showCreditsRequiredPopup?.({
        jobId: context.jobId || null,
        scheduleId: context.scheduleId || null,
        reason: paidGate?.reason || 'access-required',
      });
      observability?.finalizePendingDeactivated?.(context, {
        source: 'paid-license-denied',
        page_url: context.href,
      });
      return;
    }

    if (urls.isApplicationFormPage?.(context.href)) {
      await handleApplicationFormOpened(context);
      return;
    }

    showQueuedBookingConfirmedToast(context);
    if (existingGuard && isTerminalSuccessStage(existingGuard.stage)) {
      if (
        existingGuard.withoutSelectedSchedule ||
        existingGuard.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WITHOUT_SCHEDULE
      ) {
        scheduleConsentHandoff(context, existingGuard.applicationId || context.applicationId || null);
      } else {
        await scheduleSuccessHandoff(context, existingGuard.applicationId || null);
      }
      return;
    }

    if (!context.scheduleId) return;

    if (!directApplicationMode.isEnabled()) {
      log.debug('direct application disabled by mode; native UI automation will handle create application', {
        trigger,
      });
      return;
    }

    await observability?.ensureApplicationTrace?.(context, {
      clientEmail: context.clientEmail || null,
    });
    observability?.recordCheckpoint?.(context, 'direct_application_run_entered', {
      trigger,
      route_source: urls.isCountryApplicationPage(context.href)
        ? 'country-application-route'
        : 'early-application-route',
      client_email_present: Boolean(context.clientEmail),
    }, 'directApplicationRunEnteredAt', runEnteredTiming);

    const scheduleCooldown = await isCurrentScheduleCoolingDown(context);
    if (scheduleCooldown) {
      log.warn('direct booking skipped because schedule is cooling down after an unavailable response', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        source: scheduleCooldown.source || null,
        errorCode: scheduleCooldown.errorCode || null,
        redirectUrl: AMAZON.URLS.JOB_SEARCH,
      });
      window.setTimeout(() => {
        window.location.assign(AMAZON.URLS.JOB_SEARCH);
      }, DIRECT_APPLICATION.UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS);
      finalizeObservabilityOutcome(context, 'SCHEDULE_UNAVAILABLE', {
        detailedOutcome: 'SCHEDULE_COOLDOWN_ACTIVE',
        errorCode: 'SCHEDULE_COOLDOWN_ACTIVE',
        errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED,
      });
      return;
    }

    const attemptLock = acquireAttemptLock(
      context,
      existingGuard?.applicationId || context.applicationId || null,
      'run-start'
    );
    if (!attemptLock.ok) {
      log.warn('direct booking skipped because another navigation context owns this attempt', {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: existingGuard?.applicationId || context.applicationId || null,
        lockStage: attemptLock.existing?.stage || null,
        lockUpdatedAt: attemptLock.existing?.updatedAt || null,
        lockExpiresAt: attemptLock.existing?.expiresAt || null,
      });
      observability?.recordCheckpoint?.(context, 'attempt_lock_rejected', {
        application_id: existingGuard?.applicationId || context.applicationId || null,
        lock_stage: attemptLock.existing?.stage || null,
        lock_updated_at: attemptLock.existing?.updatedAt || null,
        persist: true,
      }, null);
      return;
    }

    observability?.recordCheckpoint?.(context, 'attempt_lock_acquired', {
      application_id: existingGuard?.applicationId || context.applicationId || null,
      lock_reason: 'run-start',
    });
    void warmWafToken(context, 'run-start');
    observability?.recordCheckpoint?.(context, 'parallel_prefetch_dispatched', {
      waf_warmup_requested: shouldPreflightWaf(),
      schedule_detail_prefetch: true,
      job_detail_prefetch: true,
    });
    const scheduleDetailPromise = startScheduleDetailPrefetch(context);
    const jobDetailPromise = startJobDetailPrefetch(context);
    persistResult(context, DIRECT_APPLICATION.STAGES.STARTED, {
      routeSource: urls.isCountryApplicationPage(context.href)
        ? 'country-application-route'
        : 'early-application-route',
    });

    try {
      const reusableApplicationId =
        shouldSuppressUiFallback(existingGuard?.stage) && existingGuard?.applicationId
          ? existingGuard.applicationId
          : null;

      let created;
      let scheduleVerification = null;
      let jobDetail = null;
      if (reusableApplicationId) {
        created = {
          applicationId: reusableApplicationId,
          candidateId: existingGuard?.candidateId || null,
          currentState: existingGuard?.currentState || null,
          responseStatus: existingGuard?.createHttpStatus || null,
          resumedFromGuard: true,
        };
        persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM, {
          applicationId: created.applicationId,
          candidateId: created.candidateId,
          currentState: created.currentState,
          resumedFromGuard: true,
        });
      } else {
        const candidateId = await resolveCandidateId();
        persistResult(context, DIRECT_APPLICATION.STAGES.CANDIDATE_RESOLVED, { candidateId });
        if (!jobDetail) {
          jobDetail = await jobDetailPromise;
          if (jobDetail?.skipped) jobDetail = null;
        }
        if (DIRECT_APPLICATION.SCHEDULE_VERIFY_BEFORE_CREATE) {
          scheduleVerification = await scheduleDetailPromise;
          if (scheduleVerification?.blockingFailure) {
            const normalizedScheduleError = normalizeCaughtError(scheduleVerification.error);
            const fallback = await tryCreateWithoutScheduleFallback(
              context,
              normalizedScheduleError,
              {
                candidateId,
                scheduleStatus:
                  normalizedScheduleError.errorMetadata?.scheduleStatus ||
                  normalizedScheduleError.errorCode ||
                  null,
                jobDetail,
                dspEnabled: dspEnabledFrom(jobDetail),
              }
            );
            if (fallback) {
              if (fallback.handled) return;
              await finishWithoutScheduleFallback(
                context,
                fallback,
                scheduleDetailPromise,
                jobDetailPromise,
                scheduleVerification
              );
              return;
            }
            throw scheduleVerification.error;
          }
        }
        if (scheduleVerification?.verified) {
          persistResult(context, DIRECT_APPLICATION.STAGES.SCHEDULE_VERIFIED, {
            candidateId,
            scheduleStatus: scheduleVerification.scheduleStatus || null,
            scheduleHttpStatus: scheduleVerification.httpStatus || null,
          });
        }

        created = await createApplication(context, candidateId, {
          jobDetail,
          dspEnabled: dspEnabledFrom(jobDetail),
        });
        persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED, {
          applicationId: created.applicationId,
          candidateId: created.candidateId,
          currentState: created.currentState,
          createHttpStatus: created.responseStatus,
          dspEnabled: created.dspEnabled,
        });
        persistResult(context, DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM, {
          applicationId: created.applicationId,
          candidateId: created.candidateId,
          currentState: created.currentState,
          createHttpStatus: created.responseStatus,
          dspEnabled: created.dspEnabled,
        });
      }

      let confirmed;
      let verification;
      try {
        confirmed = await confirmJobWithCaptchaRecovery(context, created);
        verification = await verifyReservationBeforeSuccess(context, created, confirmed);
      } catch (confirmError) {
        const normalizedConfirmError = normalizeCaughtError(confirmError);
        if (
          normalizedConfirmError.failedStage ===
          DIRECT_APPLICATION.STAGES.RESERVATION_VERIFICATION_FAILED
        ) {
          throw confirmError;
        }
        if (await schedulePostCreateConfirmFailureHandoff(context, created, normalizedConfirmError)) {
          return;
        }
        const fallback = await tryCreateWithoutScheduleFallback(
          context,
          normalizedConfirmError,
          {
            candidateId: created.candidateId || null,
            previousApplicationId: created.applicationId,
            scheduleStatus:
              normalizedConfirmError.errorMetadata?.scheduleStatus ||
              normalizedConfirmError.errorCode ||
              null,
            jobDetail,
            dspEnabled: dspEnabledFrom(jobDetail, created),
          }
        );
        if (fallback) {
          if (fallback.handled) return;
          await finishWithoutScheduleFallback(
            context,
            fallback,
            scheduleDetailPromise,
            jobDetailPromise,
            scheduleVerification
          );
          return;
        }
        throw confirmError;
      }
      if (verification) {
        confirmed.currentState = verification.currentState || confirmed.currentState;
        confirmed.confirmedScheduleId = verification.reservedScheduleId || confirmed.confirmedScheduleId;
        confirmed.softReserveExpirationTimestamp =
          verification.softReserveExpirationTimestamp ||
          confirmed.softReserveExpirationTimestamp;
      }
      const successScheduleId = selectedScheduleForSuccess(context, confirmed, verification);
      if (successScheduleId && (!confirmed.confirmedScheduleId || verification?.provisionalAccepted)) {
        confirmed.confirmedScheduleId = successScheduleId;
        confirmed.provisionalScheduleFallback = Boolean(confirmed.provisional);
      }
      if (successScheduleId && confirmed.provisional && confirmed.currentState !== 'JOB_SELECTED') {
        confirmed.currentState = 'JOB_SELECTED';
      }
      persistResult(context, DIRECT_APPLICATION.STAGES.JOB_CONFIRMED, {
        applicationId: created.applicationId,
        candidateId: created.candidateId,
        currentState: confirmed.currentState,
        confirmedScheduleId: successScheduleId,
        softReserveExpirationTimestamp: confirmed.softReserveExpirationTimestamp,
        confirmHttpStatus: confirmed.responseStatus,
        provisionalConfirm: Boolean(confirmed.provisional),
        provisionalScheduleFallback: Boolean(confirmed.provisionalScheduleFallback),
      });
      finalizeObservabilityOutcome(context, 'BOOKED', {
        detailedOutcome: 'JOB_CONFIRMED',
        applicationId: created.applicationId,
        confirmedScheduleId: successScheduleId,
        confirmHttpStatus: confirmed.responseStatus || null,
      });
      queueBookingConfirmedToast(context, {
        applicationId: created.applicationId,
        currentState: confirmed.currentState,
        selectedScheduleId: successScheduleId,
        message: verification
          ? 'Booking confirmed after reservation verification.'
          : 'Booking confirmed after job-confirm.',
      });
      const handoff = successHandoffInfo(context, created.applicationId, {
        scheduleId: successScheduleId,
      });
      notify(NOTIFICATIONS.EVENTS.BOOKING_SUCCEEDED, {
        jobId: context.jobId,
        scheduleId: successScheduleId,
        applicationId: created.applicationId,
        currentState: confirmed.currentState,
        selectedScheduleId: successScheduleId,
        message: verification
          ? 'Booking confirmed after reservation verification.'
          : 'Booking confirmed after job-confirm.',
        redirectUrl: notificationRedirectUrl(handoff.redirectUrl),
        pageUrl: context.href,
      });
      let finalHandoffVerification = verification;
      let formHandoffPrepared = false;
      const shouldPrepareFormHandoff =
        DIRECT_APPLICATION.REDIRECT_AFTER_SUCCESS &&
        handoff.routeName === DIRECT_APPLICATION.WORKFLOW_STEP_NAME;
      if (shouldPrepareFormHandoff) {
        try {
          finalHandoffVerification = await prepareSelectedScheduleFormHandoff(
            context,
            created,
            confirmed,
            verification,
            scheduleVerification,
            scheduleDetailPromise,
            jobDetail,
            jobDetailPromise
          );
          formHandoffPrepared = true;
        } catch (handoffError) {
          const normalizedHandoffError = normalizeCaughtError(handoffError);
          log.warn('selected-schedule form handoff preparation failed; continuing with final route', {
            jobId: context.jobId,
            scheduleId: successScheduleId,
            applicationId: created.applicationId,
            errorCode: normalizedHandoffError.errorCode,
            errorMessage: normalizedHandoffError.errorMessage,
            errorClassification: normalizedHandoffError.classification,
            httpStatus: normalizedHandoffError.httpStatus,
          });
        }
      }
      if (!formHandoffPrepared) {
        runSuccessPostConfirmObservability(
          context,
          created,
          confirmed,
          finalHandoffVerification,
          scheduleVerification,
          scheduleDetailPromise,
          jobDetail,
          jobDetailPromise
        );
      }
      scheduleSuccessHandoff(context, created.applicationId, {
        handoff,
        scheduleId: successScheduleId,
      });
    } catch (error) {
      const normalized = normalizeCaughtError(error);
      const existingGuard = parseGuard(context);
      const hasCreatedApplication = Boolean(existingGuard?.applicationId);
      const failedStage =
        normalized.failedStage ||
        (normalized.classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED &&
          hasCreatedApplication
          ? DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM
          : normalized.classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED
            ? DIRECT_APPLICATION.STAGES.CAPTCHA_REQUIRED
            : DIRECT_APPLICATION.STAGES.FAILED);

      persistResult(context, failedStage, {
        applicationId: existingGuard?.applicationId || null,
        candidateId: existingGuard?.candidateId || null,
        currentState: existingGuard?.currentState || null,
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorMessage,
        errorClassification: normalized.classification,
        errorMetadata: normalized.errorMetadata,
        httpStatus: normalized.httpStatus,
        fallbackAllowed: hasCreatedApplication ? false : normalized.fallbackAllowed,
        captchaReason: normalized.captchaReason || null,
      });
      finalizeObservabilityOutcome(
        context,
        observability?.outcomeForErrorClassification?.(normalized.classification) || 'UNKNOWN_ERROR',
        {
          detailedOutcome: failedStage === DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED
            ? 'CAPTCHA_FAILED'
            : (normalized.errorCode || normalized.classification || 'DIRECT_APPLICATION_FAILED'),
          applicationId: existingGuard?.applicationId || null,
          errorCode: normalized.errorCode || null,
          errorMessage: normalized.errorMessage || null,
          errorClassification: normalized.classification || null,
          createHttpStatus: existingGuard?.createHttpStatus || null,
          confirmHttpStatus: existingGuard?.confirmHttpStatus || null,
        }
      );

      const appRouteInfo = applicationErrorRoute(normalized);
      const failureRedirectUrl = appRouteInfo
        ? buildApplicationRouteHandoffUrl(context, appRouteInfo.route, { includeScheduleId: true })
        : null;
      notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
        jobId: context.jobId,
        scheduleId: context.scheduleId,
        applicationId: existingGuard?.applicationId || null,
        errorCode: normalized.errorCode,
        errorMessage: normalized.errorMessage,
        errorClassification: normalized.classification,
        httpStatus: normalized.httpStatus,
        redirectUrl: notificationRedirectUrl(failureRedirectUrl),
        pageUrl: context.href,
      });
      if (!scheduleApplicationErrorHandoff(context, normalized)) {
        scheduleFailureHandoff(context, normalized, existingGuard?.applicationId || null);
      }
      // UI fallback is controlled by the persisted guard so post-create CAPTCHA recovery is not duplicated.
    }
  }

  root.AMZ_DIRECT_APPLICATION = Object.freeze({
    initialized: true,
    run,
    queueRun,
    useDirectApplication: directApplicationMode.isEnabled,
    isTerminalSuccessStage,
    shouldSuppressUiFallback,
  });

  function installLifecycleCleanup() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const releaseOwnedLock = () => releaseAttemptLock();
    window.addEventListener('pagehide', releaseOwnedLock);
    window.addEventListener('beforeunload', releaseOwnedLock);
  }

  function installApplicationRouteWatcher() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    let lastHref = window.location.href;
    const scheduleRouteRun = trigger => {
      window.setTimeout(() => {
        if (window.location.href === lastHref) return;
        lastHref = window.location.href;
        queueRun(trigger);
      }, 0);
    };

    window.addEventListener('popstate', () => scheduleRouteRun('route-popstate'));
    window.addEventListener('hashchange', () => scheduleRouteRun('route-hashchange'));

    const historyRef = window.history;
    if (!historyRef || historyRef.__amzDirectApplicationPatched) return;
    ['pushState', 'replaceState'].forEach(method => {
      const original = historyRef[method];
      if (typeof original !== 'function') return;
      historyRef[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        scheduleRouteRun(`route-${method}`);
        return result;
      };
    });
    try {
      Object.defineProperty(historyRef, '__amzDirectApplicationPatched', {
        value: true,
        configurable: true,
      });
    } catch (_) {
      historyRef.__amzDirectApplicationPatched = true;
    }
  }

  installLifecycleCleanup();
  installApplicationRouteWatcher();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEYS.ACTIVE]?.newValue === false) {
      const context = currentContext();
      observability?.recordExtensionDeactivated?.(context, {
        source: 'active-toggle',
        page_url: context.href,
      });
      if (!runInFlight) {
        observability?.finalizePendingDeactivated?.(context, {
          source: 'active-toggle',
          page_url: context.href,
        });
      }
    }
    if (!changes[STORAGE_KEYS.USE_DIRECT_APPLICATION]) return;
    directApplicationMode.setEnabled(changes[STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue);
    if (directApplicationMode.isEnabled()) queueRun('mode changed');
  });

  queueRun('initial');
})(typeof globalThis !== 'undefined' ? globalThis : self);
