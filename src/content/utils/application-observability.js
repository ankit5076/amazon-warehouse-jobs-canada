/* Compact application-attempt observability traces for Amazon Shifts booking races. */
(function (root) {
  'use strict';

  if (root.AMZ_APPLICATION_OBSERVABILITY) return;

  const { AMAZON, DIRECT_APPLICATION, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const log = root.AMZ_LOGGER?.create?.('[application-observability]', {
    workflow: 'application-observability',
    source: 'content/utils/application-observability.js',
  }) || {
    debug: () => {},
    warn: () => {},
    error: () => {},
  };

  const TERMINAL_OUTCOMES = new Set([
    'BOOKED',
    'SCHEDULE_UNAVAILABLE',
    'SCHEDULE_DISAPPEARED_AFTER_MATCH',
    'RACE_LOST',
    'APPLICATION_CREATED_WITHOUT_SCHEDULE',
    'CAPTCHA_FAILED',
    'ALREADY_APPLIED',
    'ONE_ACTIVE_APPLICATION',
    'EXACT_DUPLICATE_ACCOUNT',
    'AUTH_REQUIRED',
    'NETWORK_TIMEOUT',
    'SERVER_OR_PROXY_ERROR',
    'MALFORMED_RESPONSE',
    'UNKNOWN_ERROR',
    'DEACTIVATED',
  ]);
  const PROGRESS_OUTCOMES = new Set([
    'JOB_MATCHED',
    'APPLICATION_CREATED',
    'CAPTCHA_REQUIRED',
  ]);
  const MAX_TIMELINE_EVENTS = 80;
  const MAX_SAMPLE_LENGTH = 220;
  const APPLICATION_FORM_OPENED_STORAGE_PREFIX = '__amz_application_form_opened__';
  const PENDING_TTL_MS = Math.max(
    60 * 1000,
    Number(DIRECT_APPLICATION.APPLICATION_OBSERVABILITY_PENDING_TTL_MS) || 10 * 60 * 1000
  );
  let activeTrace = null;

  function safePerformanceNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function normalizeText(value, limit = MAX_SAMPLE_LENGTH) {
    if (value === null || typeof value === 'undefined') return null;
    if (typeof value === 'object' || typeof value === 'function') return null;
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    if (!normalized || normalized === 'null' || normalized === 'undefined') return null;
    return normalized.length > limit ? normalized.slice(0, limit) + '...' : normalized;
  }

  function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function integerOrNull(value) {
    const parsed = numberOrNull(value);
    return parsed === null ? null : Math.max(0, Math.round(parsed));
  }

  function safeJson(value, depth = 0) {
    if (value === null || typeof value === 'undefined') return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return typeof value === 'string' ? normalizeText(value) : value;
    }
    if (value instanceof Error) return normalizeText(value.message);
    if (depth >= 2) return normalizeText(JSON.stringify(value).slice(0, MAX_SAMPLE_LENGTH));
    if (Array.isArray(value)) return value.slice(0, 5).map(item => safeJson(item, depth + 1));
    if (typeof value === 'object') {
      const cleaned = {};
      Object.entries(value).slice(0, 20).forEach(([key, item]) => {
        if (typeof item === 'function' || typeof item === 'undefined') return;
        const safe = safeJson(item, depth + 1);
        if (safe !== null && typeof safe !== 'undefined') cleaned[key] = safe;
      });
      return Object.keys(cleaned).length ? cleaned : null;
    }
    return normalizeText(value);
  }

  function sanitizeDetails(details) {
    const cleaned = safeJson(details);
    return cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : undefined;
  }

  function createAttemptId(jobId) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const token = normalizeText(jobId, 18)?.replace(/[^A-Za-z0-9]/g, '').slice(-12) || 'job';
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `AS-${stamp}-${token}-${rand}`;
  }

  function extensionVersion() {
    try {
      return root.chrome?.runtime?.getManifest?.()?.version || null;
    } catch (_) {
      return null;
    }
  }

  function recordMark(trace, phaseKey, perfMs, epochMs) {
    if (!trace || !phaseKey) return;
    if (!trace.marks) trace.marks = {};
    if (!trace.marksEpoch) trace.marksEpoch = {};
    trace.marks[phaseKey] = typeof perfMs === 'number' ? perfMs : safePerformanceNow();
    trace.marksEpoch[phaseKey] = typeof epochMs === 'number' ? epochMs : Date.now();
  }

  function timelineCategory(name) {
    const normalized = String(name || '');
    if (
      normalized.includes('api') ||
      normalized.includes('request') ||
      normalized.includes('candidate_resolve') ||
      normalized.includes('job_detail_prefetch') ||
      normalized.includes('schedule_detail_fetch') ||
      normalized.includes('schedule_recovery_fetch') ||
      normalized.includes('create_application_request') ||
      normalized.includes('confirm_job_request')
    ) {
      return 'amazon_api';
    }
    if (normalized.includes('captcha') || normalized.includes('waf')) return 'waf_captcha';
    if (
      normalized.includes('verify') ||
      normalized.includes('verified') ||
      normalized.includes('workflow')
    ) {
      return 'verification';
    }
    if (normalized.includes('observability')) return 'local_observability';
    if (normalized.includes('job_search')) return 'job_search';
    return 'extension_js';
  }

  function eventEpoch(event = {}) {
    if (typeof event.epoch_ms === 'number' && Number.isFinite(event.epoch_ms)) return event.epoch_ms;
    const parsed = Date.parse(event.at || '');
    return Number.isNaN(parsed) ? null : parsed;
  }

  function timelineForPayload(trace) {
    const events = Array.isArray(trace?.eventTimeline) ? trace.eventTimeline : [];
    const sorted = events.slice().sort((left, right) => {
      const leftEpoch = eventEpoch(left);
      const rightEpoch = eventEpoch(right);
      if (leftEpoch !== null && rightEpoch !== null && leftEpoch !== rightEpoch) {
        return leftEpoch - rightEpoch;
      }
      return events.indexOf(left) - events.indexOf(right);
    });
    return sorted.map((event, index) => {
      const currentEpoch = eventEpoch(event);
      const previousEpoch = index > 0 ? eventEpoch(sorted[index - 1]) : null;
      return {
        ...event,
        category: event.category || timelineCategory(event.name),
        since_previous_ms:
          currentEpoch !== null && previousEpoch !== null
            ? Math.max(0, Math.round(currentEpoch - previousEpoch))
            : (index === 0 ? 0 : null),
      };
    });
  }

  function recordApplicationEventAt(trace, name, details, phaseKey, timing = {}) {
    if (!trace || !name) return null;
    const epochMs = typeof timing.epochMs === 'number' ? timing.epochMs : Date.now();
    const perfMs = typeof timing.perfMs === 'number' ? timing.perfMs : safePerformanceNow();
    if (!Array.isArray(trace.eventTimeline)) trace.eventTimeline = [];
    if (phaseKey) recordMark(trace, phaseKey, perfMs, epochMs);
    const event = {
      name,
      at: new Date(epochMs).toISOString(),
      epoch_ms: epochMs,
      elapsed_ms: typeof trace.startEpochMs === 'number'
        ? Math.max(0, Math.round(epochMs - trace.startEpochMs))
        : null,
      category: timelineCategory(name),
    };
    const sanitized = sanitizeDetails(details);
    if (sanitized) event.details = sanitized;
    trace.eventTimeline.push(event);
    if (trace.eventTimeline.length > MAX_TIMELINE_EVENTS) {
      trace.eventTimeline.splice(0, trace.eventTimeline.length - MAX_TIMELINE_EVENTS);
    }
    return event;
  }

  function recordApplicationEvent(trace, name, details, phaseKey) {
    return recordApplicationEventAt(trace, name, details, phaseKey);
  }

  function summarizeJob(job = {}) {
    return {
      jobId: normalizeText(job.jobId, 80),
      scheduleId: normalizeText(job.scheduleId, 80),
      jobTitle: normalizeText(job.jobTitle),
      city: normalizeText(job.city, 80),
      state: normalizeText(job.state, 40),
      locationName: normalizeText(job.locationName),
      employmentType: normalizeText(job.employmentTypeL10N || job.employmentType, 80),
      jobType: normalizeText(job.jobTypeL10N || job.jobType, 80),
      pay: normalizeText(
        job.totalPayRateMaxL10N ||
        job.totalPayRateMinL10N ||
        job.totalPayRateMax ||
        job.totalPayRateMin,
        80
      ),
      scheduleCount: integerOrNull(job.scheduleCount),
    };
  }

  function createApplicationAttemptTrace({
    matchedJob,
    searchResult = {},
    searchContext = {},
    matchDiagnostics = null,
  } = {}) {
    const durationMs = integerOrNull(searchResult.durationMs) || 0;
    const searchEndEpochMs = Date.now();
    const searchStartEpochMs = searchEndEpochMs - durationMs;
    const searchEndPerfMs = safePerformanceNow();
    const searchStartPerfMs = searchEndPerfMs - durationMs;
    const job = summarizeJob(matchedJob || {});
    const trace = {
      attemptId: createAttemptId(job.jobId),
      startedAt: new Date(searchStartEpochMs).toISOString(),
      startEpochMs: searchStartEpochMs,
      startMs: searchStartPerfMs,
      expiresAt: searchEndEpochMs + PENDING_TTL_MS,
      outcome: 'JOB_MATCHED',
      observabilityStage: 'PROGRESS',
      isTerminal: false,
      detailedOutcome: 'JOB_MATCHED',
      extensionVersion: extensionVersion(),
      country: AMAZON.COUNTRY_CONFIG?.country || null,
      locale: AMAZON.COUNTRY_CONFIG?.locale || null,
      amazonDomain: AMAZON.COUNTRY_CONFIG?.domain || null,
      pageUrl: root.location?.href || null,
      jobId: job.jobId,
      scheduleId: job.scheduleId,
      confirmedScheduleId: null,
      applicationId: null,
      city: job.city,
      state: job.state,
      locationName: job.locationName,
      jobTitle: job.jobTitle,
      employmentType: job.employmentType,
      jobType: job.jobType,
      pay: job.pay,
      searchHttpStatus: integerOrNull(searchResult.status),
      searchJobCount: Array.isArray(searchResult.jobCards) ? searchResult.jobCards.length : null,
      matchedJobCount: matchDiagnostics?.counts?.matched ?? null,
      scheduleCount: integerOrNull(job.scheduleCount),
      searchDetails: normalizeText(searchResult.details),
      selectedCity: normalizeText(searchContext.selectedCity, 80),
      allCitiesSelected: searchContext.allCitiesSelected === true,
      selectedJobTypes: Array.isArray(searchContext.jobTypes) ? searchContext.jobTypes.slice(0, 8) : [],
      cityTagCount: integerOrNull(searchContext.cityTagCount),
      matchDiagnostics: safeJson(matchDiagnostics),
      searchFetchMs: durationMs || null,
      searchResponseToMatchMs: null,
      matchToJobDetailNavigationMs: null,
      matchToApplicationRouteMs: null,
      applicationRouteToDirectStartMs: null,
      scheduleRecoveryFetchMs: null,
      wafTokenMs: null,
      candidateResolveMs: null,
      jobDetailPrefetchMs: null,
      scheduleDetailFetchMs: null,
      scheduleVerifyMs: null,
      createApplicationRequestMs: null,
      applicationCreatedToConfirmDispatchMs: null,
      confirmJobRequestMs: null,
      captchaWaitMs: null,
      reservationVerifyMs: null,
      workflowWsMs: null,
      workflowUpdateMs: null,
      confirmToTerminalMs: null,
      pendingStatePersistMs: null,
      observabilityOverheadMs: 0,
      observabilityPostCount: 0,
      observabilityPostErrorCount: 0,
      observabilityLastPostMs: null,
      totalAttemptMs: null,
      createHttpStatus: null,
      confirmHttpStatus: null,
      reservationHttpStatus: null,
      scheduleDetailHttpStatus: null,
      jobDetailHttpStatus: null,
      scheduleRecoveryHttpStatus: null,
      workflowHttpStatus: null,
      errorCode: null,
      errorMessage: null,
      errorClassification: null,
      captchaRequired: false,
      fallbackWithoutSchedule: false,
      fallbackScheduleCount: null,
      extensionDeactivatedAt: null,
      postedOutcomes: [],
      eventTimeline: [],
      marks: {},
      marksEpoch: {},
    };
    recordApplicationEventAt(trace, 'job_search_fetch_start', {
      selected_city: trace.selectedCity,
      all_cities_selected: trace.allCitiesSelected,
    }, 'searchFetchStartAt', {
      epochMs: searchStartEpochMs,
      perfMs: searchStartPerfMs,
    });
    recordApplicationEventAt(trace, 'job_search_fetch_end', {
      status: trace.searchHttpStatus,
      duration_ms: durationMs,
      job_count: trace.searchJobCount,
    }, 'searchFetchEndAt', {
      epochMs: searchEndEpochMs,
      perfMs: searchEndPerfMs,
    });
    recordApplicationEventAt(trace, 'job_matched', {
      job_id: trace.jobId,
      city: trace.city,
      location_name: trace.locationName,
      schedule_count: job.scheduleCount,
    }, 'jobMatchedAt', {
      epochMs: searchEndEpochMs,
      perfMs: searchEndPerfMs,
    });
    activeTrace = trace;
    return trace;
  }

  function getActiveAttemptContext() {
    if (!activeTrace) return null;
    return {
      jobId: activeTrace.jobId || null,
      scheduleId: activeTrace.scheduleId || null,
      applicationId: activeTrace.applicationId || null,
      scheduleCount: activeTrace.scheduleCount ?? null,
      pageUrl: activeTrace.pageUrl || root.location?.href || null,
    };
  }

  async function updateActiveAttemptSchedule(context = {}, details = {}) {
    const trace = await loadPendingTrace(context);
    if (!trace) return null;
    const scheduleId = normalizeText(details.scheduleId, 80);
    if (!scheduleId) return trace;
    trace.scheduleId = scheduleId;
    trace.scheduleCount = integerOrNull(details.scheduleCount) ?? trace.scheduleCount ?? null;
    recordApplicationEvent(trace, 'matched_schedule_prefetched', {
      job_id: trace.jobId,
      schedule_id: trace.scheduleId,
      schedule_count: trace.scheduleCount,
      duration_ms: integerOrNull(details.durationMs),
      source: details.source || null,
    });
    return persistPendingTrace(trace);
  }

  function countryConfigForContext(context = {}) {
    const country = normalizeText(context.country, 10)?.toUpperCase();
    if (country === 'US') return AMAZON.COUNTRY_CONFIGS?.US || AMAZON.COUNTRY_CONFIG;
    if (country === 'CA') return AMAZON.COUNTRY_CONFIGS?.CA || AMAZON.COUNTRY_CONFIG;

    const origin = normalizeText(context.origin || context.href, 120) || '';
    if (origin.includes('hiring.amazon.com')) return AMAZON.COUNTRY_CONFIGS?.US || AMAZON.COUNTRY_CONFIG;
    if (origin.includes('hiring.amazon.ca')) return AMAZON.COUNTRY_CONFIGS?.CA || AMAZON.COUNTRY_CONFIG;
    return AMAZON.COUNTRY_CONFIG;
  }

  function amazonDomainForContext(context = {}, countryConfig = AMAZON.COUNTRY_CONFIG) {
    try {
      return context.origin ? new URL(context.origin).hostname : countryConfig?.domain || null;
    } catch (_) {
      return countryConfig?.domain || null;
    }
  }

  function createApplicationRouteTrace(context = {}, details = {}) {
    const startedAt = Date.now();
    const countryConfig = countryConfigForContext(context);
    const trace = {
      attemptId: createAttemptId(context.jobId),
      startedAt: new Date(startedAt).toISOString(),
      startEpochMs: startedAt,
      startMs: safePerformanceNow(),
      expiresAt: startedAt + PENDING_TTL_MS,
      outcome: 'APPLICATION_CREATED',
      observabilityStage: 'PROGRESS',
      isTerminal: false,
      detailedOutcome: 'APPLICATION_FORM_OPENED',
      extensionVersion: extensionVersion(),
      country: countryConfig?.country || context.country || null,
      locale: context.locale || countryConfig?.locale || null,
      amazonDomain: amazonDomainForContext(context, countryConfig),
      pageUrl: context.href || root.location?.href || null,
      jobId: normalizeText(context.jobId, 80),
      scheduleId: normalizeText(context.scheduleId, 80),
      confirmedScheduleId: null,
      applicationId: normalizeText(context.applicationId, 120),
      city: null,
      state: null,
      locationName: null,
      jobTitle: null,
      employmentType: null,
      jobType: null,
      pay: null,
      searchHttpStatus: null,
      searchJobCount: null,
      matchedJobCount: null,
      searchDetails: null,
      selectedCity: null,
      allCitiesSelected: false,
      selectedJobTypes: [],
      cityTagCount: null,
      matchDiagnostics: null,
      searchFetchMs: null,
      searchResponseToMatchMs: null,
      matchToJobDetailNavigationMs: null,
      matchToApplicationRouteMs: null,
      applicationRouteToDirectStartMs: null,
      scheduleRecoveryFetchMs: null,
      wafTokenMs: null,
      candidateResolveMs: null,
      jobDetailPrefetchMs: null,
      scheduleDetailFetchMs: null,
      scheduleVerifyMs: null,
      createApplicationRequestMs: null,
      applicationCreatedToConfirmDispatchMs: null,
      confirmJobRequestMs: null,
      captchaWaitMs: null,
      reservationVerifyMs: null,
      workflowWsMs: null,
      workflowUpdateMs: null,
      confirmToTerminalMs: null,
      pendingStatePersistMs: null,
      observabilityOverheadMs: 0,
      observabilityPostCount: 0,
      observabilityPostErrorCount: 0,
      observabilityLastPostMs: null,
      totalAttemptMs: null,
      createHttpStatus: null,
      confirmHttpStatus: null,
      reservationHttpStatus: null,
      scheduleDetailHttpStatus: null,
      jobDetailHttpStatus: null,
      scheduleRecoveryHttpStatus: null,
      workflowHttpStatus: null,
      errorCode: null,
      errorMessage: null,
      errorClassification: null,
      captchaRequired: false,
      fallbackWithoutSchedule: false,
      fallbackScheduleCount: null,
      extensionDeactivatedAt: null,
      postedOutcomes: [],
      eventTimeline: [],
      marks: {},
      marksEpoch: {},
    };
    recordApplicationEvent(trace, 'application_form_opened', {
      job_id: trace.jobId,
      schedule_id: trace.scheduleId,
      application_id: trace.applicationId,
      page_url: trace.pageUrl,
      route: details.route || null,
      source: details.source || null,
    }, 'applicationFormOpenedAt');
    activeTrace = trace;
    return trace;
  }

  function phaseDuration(trace, startKey, endKey) {
    if (!trace) return null;
    const startEpoch = trace.marksEpoch?.[startKey];
    const endEpoch = trace.marksEpoch?.[endKey];
    if (typeof startEpoch === 'number' && typeof endEpoch === 'number') {
      return Math.max(0, Math.round(endEpoch - startEpoch));
    }
    const startPerf = trace.marks?.[startKey];
    const endPerf = trace.marks?.[endKey];
    if (typeof startPerf === 'number' && typeof endPerf === 'number') {
      return Math.max(0, Math.round(endPerf - startPerf));
    }
    return null;
  }

  function refreshDurations(trace) {
    if (!trace) return trace;
    trace.searchFetchMs = phaseDuration(trace, 'searchFetchStartAt', 'searchFetchEndAt') || trace.searchFetchMs;
    trace.searchResponseToMatchMs = phaseDuration(trace, 'searchFetchEndAt', 'jobMatchedAt');
    trace.matchToJobDetailNavigationMs = phaseDuration(trace, 'jobMatchedAt', 'jobDetailNavigationAt');
    trace.matchToApplicationRouteMs = phaseDuration(trace, 'jobMatchedAt', 'applicationRouteAt');
    trace.applicationRouteToDirectStartMs = phaseDuration(trace, 'applicationRouteAt', 'directApplicationStartAt');
    trace.scheduleRecoveryFetchMs = phaseDuration(trace, 'scheduleRecoveryFetchStartAt', 'scheduleRecoveryFetchEndAt');
    trace.wafTokenMs = phaseDuration(trace, 'wafTokenStartAt', 'wafTokenEndAt');
    trace.candidateResolveMs = phaseDuration(trace, 'candidateResolveStartAt', 'candidateResolveEndAt');
    trace.jobDetailPrefetchMs = phaseDuration(trace, 'jobDetailPrefetchStartAt', 'jobDetailPrefetchEndAt');
    trace.scheduleDetailFetchMs = phaseDuration(trace, 'scheduleDetailFetchStartAt', 'scheduleDetailFetchEndAt');
    trace.scheduleVerifyMs = phaseDuration(trace, 'scheduleDetailFetchStartAt', 'scheduleVerifiedAt');
    trace.createApplicationRequestMs =
      phaseDuration(trace, 'createApplicationRequestStartAt', 'createApplicationRequestEndAt');
    trace.applicationCreatedToConfirmDispatchMs =
      phaseDuration(trace, 'applicationCreatedAt', 'confirmJobRequestStartAt');
    trace.confirmJobRequestMs = phaseDuration(trace, 'confirmJobRequestStartAt', 'confirmJobRequestEndAt');
    trace.captchaWaitMs = phaseDuration(trace, 'captchaRequiredAt', 'captchaResolvedAt');
    trace.reservationVerifyMs = phaseDuration(trace, 'reservationVerifyStartAt', 'reservationVerifyEndAt');
    trace.workflowWsMs = phaseDuration(trace, 'workflowWsStartAt', 'workflowWsEndAt');
    trace.workflowUpdateMs = phaseDuration(trace, 'workflowUpdateStartAt', 'workflowUpdateEndAt');
    trace.confirmToTerminalMs = phaseDuration(trace, 'confirmJobRequestEndAt', 'terminalAt');
    if (typeof trace.startEpochMs === 'number') {
      const endEpoch = trace.marksEpoch?.terminalAt || Date.now();
      trace.totalAttemptMs = Math.max(0, Math.round(endEpoch - trace.startEpochMs));
    }
    return trace;
  }

  function isTerminalOutcome(outcome) {
    return TERMINAL_OUTCOMES.has(outcome);
  }

  function observabilityStageForOutcome(outcome) {
    return isTerminalOutcome(outcome) ? 'TERMINAL' : 'PROGRESS';
  }

  function finalizeApplicationTrace(trace, outcome, extras = {}) {
    if (!trace) return null;
    Object.assign(trace, extras || {});
    trace.outcome = outcome || trace.outcome || 'UNKNOWN_ERROR';
    trace.observabilityStage = observabilityStageForOutcome(trace.outcome);
    trace.isTerminal = isTerminalOutcome(trace.outcome);
    trace.detailedOutcome = extras.detailedOutcome || trace.detailedOutcome || trace.outcome;
    if (trace.isTerminal) {
      recordApplicationEvent(trace, 'attempt_terminal', {
        outcome: trace.outcome,
        detailed_outcome: trace.detailedOutcome,
      }, 'terminalAt');
    }
    refreshDurations(trace);
    return trace;
  }

  async function readStorageContext() {
    try {
      const data = await storage.getLocal([
        STORAGE_KEYS.OPERATOR_USERNAME,
        STORAGE_KEYS.USERNAME,
        STORAGE_KEYS.SELECTED_CLIENT_ID,
        STORAGE_KEYS.SELECTED_CLIENT_LABEL,
        STORAGE_KEYS.AMAZON_LOGIN_USERNAME,
        STORAGE_KEYS.USER_EMAIL,
        STORAGE_KEYS.LEGACY_USER_EMAIL,
      ]);
      return {
        operatorUsername: normalizeText(data[STORAGE_KEYS.OPERATOR_USERNAME] || data[STORAGE_KEYS.USERNAME], 150),
        selectedClientId: normalizeText(data[STORAGE_KEYS.SELECTED_CLIENT_ID], 80),
        selectedClientLabel: normalizeText(data[STORAGE_KEYS.SELECTED_CLIENT_LABEL], 180),
        clientEmail: normalizeText(
          data[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] ||
          data[STORAGE_KEYS.USER_EMAIL] ||
          data[STORAGE_KEYS.LEGACY_USER_EMAIL],
          255
        ),
      };
    } catch (_) {
      return {};
    }
  }

  function contextMatches(trace, context = {}) {
    if (!trace) return false;
    const traceJobId = normalizeText(trace.jobId, 80);
    const contextJobId = normalizeText(context.jobId, 80);
    if (traceJobId && contextJobId && traceJobId !== contextJobId) return false;
    const traceScheduleId = normalizeText(trace.scheduleId, 80);
    const contextScheduleId = normalizeText(context.scheduleId, 80);
    return !(traceScheduleId && contextScheduleId && traceScheduleId !== contextScheduleId);
  }

  function pendingExpired(record) {
    return !record || Number(record.expiresAt || record.trace?.expiresAt || 0) <= Date.now();
  }

  async function getPendingRecord() {
    try {
      const data = storage.getSession
        ? await storage.getSession(STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE)
        : await storage.getLocal(STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE);
      return data?.[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE] || null;
    } catch (_) {
      return null;
    }
  }

  async function clearPendingTrace() {
    activeTrace = null;
    try {
      if (storage.removeSession) {
        await storage.removeSession(STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE);
      } else {
        await storage.removeLocal(STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE);
      }
    } catch (_) {
      // Observability cleanup is best-effort.
    }
  }

  async function loadPendingTrace(context = {}) {
    if (activeTrace && contextMatches(activeTrace, context)) return activeTrace;
    const record = await getPendingRecord();
    if (!record || pendingExpired(record)) {
      if (record) await clearPendingTrace();
      return null;
    }
    const trace = record.trace || record;
    if (!contextMatches(trace, context)) return null;
    activeTrace = trace;
    return activeTrace;
  }

  async function persistPendingTrace(trace) {
    if (!trace) return null;
    const started = Date.now();
    trace.expiresAt = Date.now() + PENDING_TTL_MS;
    refreshDurations(trace);
    const record = {
      trace,
      expiresAt: trace.expiresAt,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (storage.setSession) {
        await storage.setSession({ [STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]: record });
      } else {
        await storage.setLocal({ [STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]: record });
      }
      trace.pendingStatePersistMs = Math.max(0, Date.now() - started);
      trace.observabilityOverheadMs = (trace.observabilityOverheadMs || 0) + trace.pendingStatePersistMs;
    } catch (error) {
      log.debug('pending application observability persistence skipped', {
        error: error?.message || String(error),
      });
    }
    return trace;
  }

  function applicationFormOpenedDedupeKey(context = {}) {
    return [
      APPLICATION_FORM_OPENED_STORAGE_PREFIX,
      normalizeText(context.jobId, 80) || '',
      normalizeText(context.scheduleId, 80) || '',
      normalizeText(context.applicationId, 120) || '',
    ].join('::');
  }

  async function hasApplicationFormOpenedEvent(context = {}) {
    const key = applicationFormOpenedDedupeKey(context);
    try {
      const data = storage.getSession
        ? await storage.getSession(key)
        : await storage.getLocal(key);
      return data?.[key] === true;
    } catch (_) {
      return false;
    }
  }

  async function markApplicationFormOpenedEvent(context = {}) {
    const key = applicationFormOpenedDedupeKey(context);
    const value = { [key]: true };
    try {
      if (storage.setSession) {
        await storage.setSession(value);
      } else {
        await storage.setLocal(value);
      }
    } catch (_) {
      // Dedupe is best-effort; posting must not block on storage access.
    }
  }

  async function recordApplicationFormOpened(context = {}, details = {}) {
    if (await hasApplicationFormOpenedEvent(context)) {
      return { ok: true, skipped: 'already-recorded' };
    }
    await markApplicationFormOpenedEvent(context);

    let trace = await loadPendingTrace(context);
    const storageContext = await readStorageContext();
    if (!trace) {
      trace = createApplicationRouteTrace(context, details);
    } else {
      Object.assign(trace, storageContext);
      trace.pageUrl = context.href || root.location?.href || trace.pageUrl || null;
      trace.jobId = normalizeText(context.jobId, 80) || trace.jobId || null;
      trace.scheduleId = normalizeText(context.scheduleId, 80) || trace.scheduleId || null;
      trace.applicationId = normalizeText(context.applicationId, 120) || trace.applicationId || null;
      trace.locale = context.locale || trace.locale || null;
      const countryConfig = countryConfigForContext(context);
      trace.country = countryConfig?.country || trace.country || null;
      trace.amazonDomain = amazonDomainForContext(context, countryConfig) || trace.amazonDomain || null;
      recordApplicationEvent(trace, 'application_form_opened', {
        job_id: trace.jobId,
        schedule_id: trace.scheduleId,
        application_id: trace.applicationId,
        page_url: trace.pageUrl,
        route: details.route || null,
        source: details.source || null,
      }, 'applicationFormOpenedAt');
    }
    Object.assign(trace, storageContext);
    finalizeApplicationTrace(trace, 'APPLICATION_CREATED', {
      detailedOutcome: 'APPLICATION_FORM_OPENED',
      applicationId: normalizeText(context.applicationId, 120) || trace.applicationId || null,
    });
    return persistApplicationAttemptLocally(trace, context, {
      force: true,
      clearPending: false,
    });
  }

  async function ensureApplicationTrace(context = {}, details = {}) {
    const trace = await loadPendingTrace(context);
    if (!trace) return null;
    const storageContext = await readStorageContext();
    Object.assign(trace, storageContext);
    trace.pageUrl = context.href || root.location?.href || trace.pageUrl || null;
    trace.scheduleId = normalizeText(context.scheduleId, 80) || trace.scheduleId || null;
    trace.jobId = normalizeText(context.jobId, 80) || trace.jobId || null;
    trace.country = context.country || trace.country || AMAZON.COUNTRY_CONFIG?.country || null;
    trace.locale = context.locale || trace.locale || AMAZON.COUNTRY_CONFIG?.locale || null;
    trace.clientEmail = normalizeText(details.clientEmail, 255) || trace.clientEmail || null;
    recordApplicationEvent(trace, 'application_route_entered', {
      job_id: trace.jobId,
      schedule_id: trace.scheduleId,
      page_url: trace.pageUrl,
    }, 'applicationRouteAt');
    return persistPendingTrace(trace);
  }

  function posted(trace, outcome) {
    return Array.isArray(trace?.postedOutcomes) && trace.postedOutcomes.includes(outcome);
  }

  function localPayload(trace) {
    refreshDurations(trace);
    return {
      attempt_id: trace.attemptId,
      started_at: trace.startedAt,
      outcome: trace.outcome,
      observability_stage: trace.observabilityStage || observabilityStageForOutcome(trace.outcome),
      is_terminal: trace.isTerminal === true,
      detailed_outcome: trace.detailedOutcome || trace.outcome,
      extension_version: trace.extensionVersion || extensionVersion(),
      operator_username: trace.operatorUsername || null,
      selected_client_id: trace.selectedClientId || null,
      client_id: trace.selectedClientId || null,
      selected_client_label: trace.selectedClientLabel || null,
      client_label: trace.selectedClientLabel || null,
      client_email: trace.clientEmail || null,
      runner_host: trace.runnerHost || null,
      chrome_profile: trace.chromeProfile || null,
      country: trace.country || null,
      locale: trace.locale || null,
      amazon_domain: trace.amazonDomain || null,
      page_url: trace.pageUrl || null,
      job_id: trace.jobId || null,
      schedule_id: trace.scheduleId || null,
      confirmed_schedule_id: trace.confirmedScheduleId || null,
      application_id: trace.applicationId || null,
      city: trace.city || trace.selectedCity || null,
      state: trace.state || null,
      location_name: trace.locationName || null,
      job_title: trace.jobTitle || null,
      employment_type: trace.employmentType || null,
      job_type: trace.jobType || null,
      pay: trace.pay || null,
      selected_city: trace.selectedCity || null,
      all_cities_selected: trace.allCitiesSelected === true,
      selected_job_types: Array.isArray(trace.selectedJobTypes) ? trace.selectedJobTypes : [],
      city_tag_count: trace.cityTagCount ?? null,
      search_http_status: trace.searchHttpStatus ?? null,
      search_job_count: trace.searchJobCount ?? null,
      matched_job_count: trace.matchedJobCount ?? null,
      search_details: trace.searchDetails || null,
      search_fetch_ms: trace.searchFetchMs ?? null,
      search_response_to_match_ms: trace.searchResponseToMatchMs ?? null,
      match_to_job_detail_navigation_ms: trace.matchToJobDetailNavigationMs ?? null,
      match_to_application_route_ms: trace.matchToApplicationRouteMs ?? null,
      application_route_to_direct_start_ms: trace.applicationRouteToDirectStartMs ?? null,
      schedule_recovery_fetch_ms: trace.scheduleRecoveryFetchMs ?? null,
      waf_token_ms: trace.wafTokenMs ?? null,
      candidate_resolve_ms: trace.candidateResolveMs ?? null,
      job_detail_prefetch_ms: trace.jobDetailPrefetchMs ?? null,
      schedule_detail_fetch_ms: trace.scheduleDetailFetchMs ?? null,
      schedule_verify_ms: trace.scheduleVerifyMs ?? null,
      create_application_request_ms: trace.createApplicationRequestMs ?? null,
      application_created_to_confirm_dispatch_ms: trace.applicationCreatedToConfirmDispatchMs ?? null,
      confirm_job_request_ms: trace.confirmJobRequestMs ?? null,
      captcha_wait_ms: trace.captchaWaitMs ?? null,
      reservation_verify_ms: trace.reservationVerifyMs ?? null,
      workflow_ws_ms: trace.workflowWsMs ?? null,
      workflow_update_ms: trace.workflowUpdateMs ?? null,
      confirm_to_terminal_ms: trace.confirmToTerminalMs ?? null,
      pending_state_persist_ms: trace.pendingStatePersistMs ?? null,
      observability_overhead_ms: trace.observabilityOverheadMs ?? null,
      observability_post_count: trace.observabilityPostCount || 0,
      observability_post_error_count: trace.observabilityPostErrorCount || 0,
      observability_last_post_ms: trace.observabilityLastPostMs ?? null,
      total_attempt_ms: trace.totalAttemptMs ?? null,
      create_http_status: trace.createHttpStatus ?? null,
      confirm_http_status: trace.confirmHttpStatus ?? null,
      reservation_http_status: trace.reservationHttpStatus ?? null,
      schedule_detail_http_status: trace.scheduleDetailHttpStatus ?? null,
      job_detail_http_status: trace.jobDetailHttpStatus ?? null,
      schedule_recovery_http_status: trace.scheduleRecoveryHttpStatus ?? null,
      workflow_http_status: trace.workflowHttpStatus ?? null,
      error_code: trace.errorCode || null,
      error_message: trace.errorMessage || null,
      error_classification: trace.errorClassification || null,
      captcha_required: trace.captchaRequired === true,
      fallback_without_schedule: trace.fallbackWithoutSchedule === true,
      fallback_schedule_count: trace.fallbackScheduleCount ?? null,
      extension_deactivated_at: trace.extensionDeactivatedAt || null,
      match_diagnostics: trace.matchDiagnostics || null,
      event_timeline: timelineForPayload(trace),
    };
  }

  async function persistApplicationAttemptLocally(trace, context = {}, options = {}) {
    if (!trace || !PROGRESS_OUTCOMES.has(trace.outcome) && !TERMINAL_OUTCOMES.has(trace.outcome)) {
      return { ok: false, skipped: 'invalid-trace' };
    }
    const outcomeAtStart = trace.outcome;
    const isTerminalAtStart = isTerminalOutcome(outcomeAtStart);
    if (posted(trace, outcomeAtStart) && options.force !== true) {
      return { ok: true, skipped: 'already-posted' };
    }

    const started = Date.now();
    try {
      const snapshot = JSON.parse(JSON.stringify(trace));
      if (!isTerminalAtStart) {
        const storageContext = await readStorageContext();
        Object.assign(snapshot, storageContext);
        Object.assign(trace, storageContext);
      }
      snapshot.pageUrl = context.href || root.location?.href || snapshot.pageUrl || null;
      snapshot.extensionVersion = snapshot.extensionVersion || extensionVersion();
      snapshot.outcome = outcomeAtStart;
      snapshot.observabilityStage = trace.observabilityStage || observabilityStageForOutcome(outcomeAtStart);
      snapshot.isTerminal = isTerminalOutcome(outcomeAtStart);
      trace.pageUrl = context.href || root.location?.href || trace.pageUrl || null;
      trace.extensionVersion = trace.extensionVersion || extensionVersion();
      trace.observabilityPostCount = (trace.observabilityPostCount || 0) + 1;
      snapshot.observabilityPostCount = trace.observabilityPostCount;
      const payload = localPayload(snapshot);
      trace.observabilityLastPostMs = Math.max(0, Date.now() - started);
      trace.observabilityOverheadMs = (trace.observabilityOverheadMs || 0) + trace.observabilityLastPostMs;
      trace.postedOutcomes = Array.from(new Set([...(trace.postedOutcomes || []), outcomeAtStart]));
      log.debug('application observability stored locally', {
        outcome: trace.outcome,
        attemptId: trace.attemptId || null,
        isTerminal: snapshot.isTerminal === true,
      });
      return { ok: true, localOnly: true, payload };
    } catch (error) {
      trace.observabilityLastPostMs = Math.max(0, Date.now() - started);
      trace.observabilityOverheadMs = (trace.observabilityOverheadMs || 0) + trace.observabilityLastPostMs;
      trace.observabilityPostErrorCount = (trace.observabilityPostErrorCount || 0) + 1;
      log.debug('application observability local persistence threw', {
        outcome: trace.outcome,
        error: error?.message || String(error),
      });
      return { ok: false, error: error?.message || String(error) };
    } finally {
      if (isTerminalAtStart || options.clearPending === true) {
        await clearPendingTrace();
      } else if (!isTerminalOutcome(trace.outcome)) {
        await persistPendingTrace(trace);
      }
    }
  }

  function flushProgress(trace, outcome, extras = {}, context = {}) {
    if (!trace) return null;
    finalizeApplicationTrace(trace, outcome, {
      ...extras,
      detailedOutcome: extras.detailedOutcome || outcome,
    });
    trace.isTerminal = false;
    trace.observabilityStage = 'PROGRESS';
    void persistApplicationAttemptLocally(trace, context).catch(() => null);
    return trace;
  }

  function finalizeAndFlush(trace, outcome, extras = {}, context = {}) {
    if (!trace) return null;
    finalizeApplicationTrace(trace, outcome, extras);
    void persistApplicationAttemptLocally(trace, context, { force: true }).catch(() => null);
    return trace;
  }

  function finalizePendingScheduleDisappearedAfterMatch(context = {}, details = {}) {
    const timing = { epochMs: Date.now(), perfMs: safePerformanceNow() };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      const scheduleCount = integerOrNull(details.scheduleCount);
      const durationMs = integerOrNull(details.durationMs);
      const recoveryStartedTiming = durationMs === null
        ? timing
        : {
            epochMs: timing.epochMs - durationMs,
            perfMs: timing.perfMs - durationMs,
          };
      trace.pageUrl = details.pageUrl || context.href || root.location?.href || trace.pageUrl || null;
      trace.jobId = normalizeText(details.jobId || context.jobId, 80) || trace.jobId || null;
      trace.scheduleRecoveryHttpStatus = integerOrNull(details.status) ?? trace.scheduleRecoveryHttpStatus ?? null;
      trace.fallbackScheduleCount = scheduleCount ?? trace.fallbackScheduleCount ?? 0;
      trace.errorCode = normalizeText(details.errorCode, 80) || 'NO_SCHEDULE_FOUND';
      trace.errorMessage = normalizeText(
        details.errorMessage || details.details,
        255
      ) || 'Matched job schedule disappeared before application could start.';
      trace.errorClassification = normalizeText(
        details.errorClassification,
        80
      ) || 'schedule-disappeared-after-match';
      recordApplicationEventAt(trace, 'schedule_recovery_fetch_start', {
        operation: 'searchScheduleCards',
        source: details.source || null,
      }, 'scheduleRecoveryFetchStartAt', recoveryStartedTiming);
      recordApplicationEventAt(trace, 'schedule_recovery_fetch_end', {
        operation: 'searchScheduleCards',
        http_status: trace.scheduleRecoveryHttpStatus,
        schedule_count: scheduleCount ?? 0,
        failed: false,
      }, 'scheduleRecoveryFetchEndAt', timing);
      recordApplicationEventAt(trace, 'schedule_disappeared_after_match', {
        job_id: trace.jobId,
        page_url: trace.pageUrl,
        reason: details.reason || null,
        source: details.source || null,
        schedule_count: scheduleCount ?? 0,
        http_status: trace.scheduleRecoveryHttpStatus,
        duration_ms: durationMs,
        details: details.details || null,
      }, null, timing);
      return finalizeAndFlush(trace, 'SCHEDULE_DISAPPEARED_AFTER_MATCH', {
        detailedOutcome: 'SCHEDULE_DISAPPEARED_AFTER_MATCH',
        fallbackScheduleCount: scheduleCount ?? 0,
        errorCode: trace.errorCode,
        errorMessage: trace.errorMessage,
        errorClassification: trace.errorClassification,
      }, context);
    }).catch(() => null);
  }

  function recordJobDetailNavigation(trace, matchedJob, jobDetailUrl) {
    if (!trace) return null;
    trace.pageUrl = jobDetailUrl || trace.pageUrl;
    recordApplicationEvent(trace, 'job_detail_navigation', {
      job_id: trace.jobId,
      page_url: jobDetailUrl || null,
      job: summarizeJob(matchedJob || {}),
    }, 'jobDetailNavigationAt');
    return trace;
  }

  function recordScheduleClick(details = {}, source = 'schedule-automation') {
    const context = { jobId: details.jobId };
    const timing = { epochMs: Date.now(), perfMs: safePerformanceNow() };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      recordApplicationEventAt(trace, 'schedule_apply_clicked', {
        source,
        job_id: details.jobId || trace.jobId || null,
        page_url: details.pageUrl || null,
        button_text: details.buttonText || null,
        button_aria_label: details.buttonAriaLabel || null,
      }, 'scheduleApplyClickedAt', timing);
      trace.pageUrl = details.pageUrl || trace.pageUrl;
      return persistPendingTrace(trace);
    }).catch(() => null);
  }

  function apiPhase(operation) {
    const op = String(operation || '').trim();
    if (op === 'candidate') return ['candidateResolveStartAt', 'candidateResolveEndAt', 'candidate_resolve'];
    if (op === 'job-detail') return ['jobDetailPrefetchStartAt', 'jobDetailPrefetchEndAt', 'job_detail_prefetch'];
    if (op === 'schedule-detail') return ['scheduleDetailFetchStartAt', 'scheduleDetailFetchEndAt', 'schedule_detail_fetch'];
    if (op === 'schedule-list-fallback') {
      return ['scheduleRecoveryFetchStartAt', 'scheduleRecoveryFetchEndAt', 'schedule_recovery_fetch'];
    }
    if (op.startsWith('create-application')) {
      return ['createApplicationRequestStartAt', 'createApplicationRequestEndAt', 'create_application_request'];
    }
    if (op === 'job-confirm') return ['confirmJobRequestStartAt', 'confirmJobRequestEndAt', 'confirm_job_request'];
    if (op === 'reservation-verification') return ['reservationVerifyStartAt', 'reservationVerifyEndAt', 'reservation_verify'];
    if (op === 'workflow-step' || op === 'application-config') {
      return ['workflowUpdateStartAt', 'workflowUpdateEndAt', 'workflow_update'];
    }
    return [null, null, 'api_request'];
  }

  function recordApiRequest(context, operation, details = {}) {
    const timing = { epochMs: Date.now(), perfMs: safePerformanceNow() };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      const [startKey,, name] = apiPhase(operation);
      recordApplicationEventAt(trace, `${name}_start`, {
        operation,
        method: details.method || null,
        pathname: details.pathname || null,
      }, startKey, timing);
      return trace;
    }).catch(() => null);
  }

  function recordApiResponse(context, operation, details = {}) {
    const timing = { epochMs: Date.now(), perfMs: safePerformanceNow() };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      const [, endKey, name] = apiPhase(operation);
      recordApplicationEventAt(trace, `${name}_end`, {
        operation,
        http_status: details.httpStatus ?? null,
        error_code: details.errorCode || null,
        error_message: details.errorMessage || null,
        failed: details.failed === true,
      }, endKey, timing);
      const status = integerOrNull(details.httpStatus);
      if (operation === 'job-detail') trace.jobDetailHttpStatus = status;
      if (operation === 'schedule-detail') trace.scheduleDetailHttpStatus = status;
      if (operation === 'schedule-list-fallback') trace.scheduleRecoveryHttpStatus = status;
      if (String(operation || '').startsWith('create-application')) trace.createHttpStatus = status;
      if (operation === 'job-confirm') trace.confirmHttpStatus = status;
      if (operation === 'reservation-verification') trace.reservationHttpStatus = status;
      if (operation === 'workflow-step' || operation === 'application-config') trace.workflowHttpStatus = status;
      refreshDurations(trace);
      return trace;
    }).catch(() => null);
  }

  function recordCheckpoint(context = {}, name, details = {}, phaseKey = null, timing = {}) {
    const captured = {
      epochMs: typeof timing.epochMs === 'number' ? timing.epochMs : Date.now(),
      perfMs: typeof timing.perfMs === 'number' ? timing.perfMs : safePerformanceNow(),
    };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      recordApplicationEventAt(trace, name, details, phaseKey, captured);
      refreshDurations(trace);
      if (details?.persist === true) return persistPendingTrace(trace);
      return trace;
    }).catch(() => null);
  }

  function recordDirectStage(context, stage, result = {}) {
    const timing = { epochMs: Date.now(), perfMs: safePerformanceNow() };
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      trace.pageUrl = result.pageUrl || context.href || trace.pageUrl || null;
      trace.applicationId = result.applicationId || trace.applicationId || null;
      trace.scheduleId = result.scheduleId || context.scheduleId || trace.scheduleId || null;
      trace.confirmedScheduleId = result.confirmedScheduleId || result.reservedScheduleId || trace.confirmedScheduleId || null;
      trace.clientEmail = result.clientEmail || context.clientEmail || trace.clientEmail || null;
      trace.errorCode = result.errorCode || result.reservationErrorCode || trace.errorCode || null;
      trace.errorMessage = result.errorMessage || result.reservationErrorMessage || trace.errorMessage || null;
      trace.errorClassification =
        result.errorClassification ||
        result.reservationErrorClassification ||
        trace.errorClassification ||
        null;
      trace.captchaRequired = trace.captchaRequired ||
        trace.errorClassification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED;
      trace.fallbackWithoutSchedule = trace.fallbackWithoutSchedule || result.fallbackWithoutSchedule === true;
      trace.fallbackScheduleCount = result.fallbackScheduleCount ?? trace.fallbackScheduleCount ?? null;
      recordApplicationEventAt(trace, 'direct_application_stage', {
        stage,
        application_id: trace.applicationId,
        current_state: result.currentState || null,
        error_code: result.errorCode || null,
        error_classification: result.errorClassification || null,
      }, null, timing);
      if (stage === DIRECT_APPLICATION.STAGES.STARTED) {
        recordApplicationEventAt(trace, 'direct_application_start', {
          route_source: result.routeSource || null,
        }, 'directApplicationStartAt', timing);
      }
      if (stage === DIRECT_APPLICATION.STAGES.SCHEDULE_VERIFIED) {
        recordApplicationEventAt(trace, 'schedule_verified', {
          schedule_status: result.scheduleStatus || null,
          http_status: result.scheduleHttpStatus || null,
        }, 'scheduleVerifiedAt', timing);
      }
      if (stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED) {
        recordApplicationEventAt(trace, 'application_created', {
          application_id: trace.applicationId,
          current_state: result.currentState || null,
          http_status: result.createHttpStatus || null,
        }, 'applicationCreatedAt', timing);
        flushProgress(trace, 'APPLICATION_CREATED', {
          applicationId: trace.applicationId,
          detailedOutcome: 'APPLICATION_CREATED',
        }, context);
      }
      if (stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM) {
        recordApplicationEventAt(trace, 'confirm_dispatch_ready', {
          application_id: trace.applicationId,
        }, 'confirmDispatchReadyAt', timing);
      }
      if (stage === DIRECT_APPLICATION.STAGES.CAPTCHA_REQUIRED ||
          stage === DIRECT_APPLICATION.STAGES.CAPTCHA_PRESENTED ||
          result.errorClassification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED) {
        trace.captchaRequired = true;
        recordApplicationEventAt(trace, 'captcha_required', {
          stage,
          error_code: result.errorCode || null,
          reason: result.captchaReason || null,
        }, 'captchaRequiredAt', timing);
        flushProgress(trace, 'CAPTCHA_REQUIRED', {
          detailedOutcome: 'CAPTCHA_REQUIRED',
        }, context);
      }
      if (stage === DIRECT_APPLICATION.STAGES.CAPTCHA_SOLVED) {
        recordApplicationEventAt(trace, 'captcha_solved', {
          application_id: trace.applicationId,
        }, 'captchaResolvedAt', timing);
      }
      if (stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_STARTED) {
        recordApplicationEventAt(trace, 'workflow_ws_start', {
          application_id: trace.applicationId,
        }, 'workflowWsStartAt', timing);
      }
      if (
        stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_COMPLETED ||
        stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_SKIPPED ||
        stage === DIRECT_APPLICATION.STAGES.WORKFLOW_WS_FAILED
      ) {
        recordApplicationEventAt(trace, 'workflow_ws_end', {
          status: result.workflowWsStatus || stage,
        }, 'workflowWsEndAt', timing);
      }
      refreshDurations(trace);
      return trace;
    }).catch(() => null);
  }

  function outcomeForErrorClassification(classification) {
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED) return 'CAPTCHA_FAILED';
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.AUTH_REQUIRED) return 'AUTH_REQUIRED';
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ALREADY_APPLIED) return 'ALREADY_APPLIED';
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.RESETTABLE_EXISTING_APPLICATION) {
      return 'ALREADY_APPLIED';
    }
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ONE_ACTIVE_APPLICATION) {
      return 'ONE_ACTIVE_APPLICATION';
    }
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.EXACT_DUPLICATE_ACCOUNT) {
      return 'EXACT_DUPLICATE_ACCOUNT';
    }
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED) {
      return 'RACE_LOST';
    }
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT) return 'NETWORK_TIMEOUT';
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.SERVER_OR_PROXY_ERROR) return 'SERVER_OR_PROXY_ERROR';
    if (classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.MALFORMED_RESPONSE) return 'MALFORMED_RESPONSE';
    return 'UNKNOWN_ERROR';
  }

  function recordExtensionDeactivated(context = {}, details = {}) {
    void loadPendingTrace(context).then(trace => {
      if (!trace || trace.extensionDeactivatedAt) return null;
      trace.extensionDeactivatedAt = new Date().toISOString();
      recordApplicationEvent(trace, 'extension_deactivated', details, 'extensionDeactivatedAt');
      return persistPendingTrace(trace);
    }).catch(() => null);
  }

  function finalizePendingDeactivated(context = {}, details = {}) {
    void loadPendingTrace(context).then(trace => {
      if (!trace) return null;
      trace.extensionDeactivatedAt = trace.extensionDeactivatedAt || new Date().toISOString();
      recordApplicationEvent(trace, 'extension_deactivated', details, 'extensionDeactivatedAt');
      return finalizeAndFlush(trace, 'DEACTIVATED', {
        detailedOutcome: 'EXTENSION_DEACTIVATED_DURING_ATTEMPT',
      }, context);
    }).catch(() => null);
  }

  root.AMZ_APPLICATION_OBSERVABILITY = Object.freeze({
    createApplicationAttemptTrace,
    recordApplicationEvent,
    recordApplicationEventAt,
    finalizeApplicationTrace,
    persistApplicationAttemptLocally,
    persistPendingTrace,
    loadPendingTrace,
    clearPendingTrace,
    ensureApplicationTrace,
    flushProgress,
    finalizeAndFlush,
    finalizePendingScheduleDisappearedAfterMatch,
    recordApplicationFormOpened,
    getActiveAttemptContext,
    updateActiveAttemptSchedule,
    recordJobDetailNavigation,
    recordScheduleClick,
    recordApiRequest,
    recordApiResponse,
    recordCheckpoint,
    recordDirectStage,
    outcomeForErrorClassification,
    recordExtensionDeactivated,
    finalizePendingDeactivated,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
