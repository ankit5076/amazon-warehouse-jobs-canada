/* Job search page controller. */
(async function (root) {
  'use strict';

  const {
    AMAZON,
    MESSAGE_ACTIONS,
    AUTH_PROBE,
    DIRECT_APPLICATION,
    POLLING,
    SCHEDULE_AUTOMATION,
    STORAGE_KEYS,
  } = root.AMZ_CONSTANTS;

  if (root.AMZ_URL.isSkipPage()) return;

  const state = root.AMZ_STATE;
  const account = root.AMZ_ACCOUNT;
  const cityTagsUtil = root.AMZ_CITY_TAGS;
  const jobMatcher = root.AMZ_JOB_MATCH;
  const toasts = root.AMZ_TOASTS;
  const dom = root.AMZ_DOM;
  const log = root.AMZ_LOGGER.create('[amazon-shift][fetch]', {
    workflow: 'job-search',
    source: 'content/fetch.js',
  });

  const pollerState = {
    selectedCity: '',
    allCitiesSelected: false,
    lat: null,
    lng: null,
    distance: '',
    jobType: [],
    cityTags: [],
    selectedClientId: '',
    isActive: false,
    intervalValue: '',
    intervalUnit: '',
    intervalMinMs: 0,
    intervalMs: await root.AMZ_INTERVALS.getStoredMilliseconds(),
    jobSearch: {
      fallbackDistanceKm: '',
      fetchTimeoutMs: 0,
    },
    authProbeStatus: AUTH_PROBE.STATUSES.CHECKING,
    useDirectApplication: DIRECT_APPLICATION.useDirectApplication !== false,
    runtimeAllowed: false,
    runtimePolicyCheckedAt: 0,
    lastApiMeta: { state: 'idle' },
    graphqlWafBackoffUntil: 0,
  };

  const scheduleAutomation = root.AMZ_SCHEDULE_AUTOMATION.create({
    isActive: () => pollerState.isActive,
    onNoApplyPath: handleNoApplyPath,
  });
  let noApplyJobSearchRedirectTimer = null;
  let noApplyScheduleRecoveryInProgress = false;
  let authRedirectInProgress = false;
  let authProbeRefreshPromise = null;
  let authProbeDeniedRetryPageUrl = '';
  const JOB_DETAIL_NAVIGATION_FALLBACK_DELAY_MS = 1200;

  function applyIntervalSettings(source = {}) {
    pollerState.intervalValue = source[STORAGE_KEYS.FETCH_INTERVAL_VALUE] || '';
    pollerState.intervalUnit = source[STORAGE_KEYS.FETCH_INTERVAL_UNIT] || '';
    pollerState.intervalMinMs = source[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS] || 0;
    pollerState.intervalMs = root.AMZ_INTERVALS.resolveMilliseconds(
      pollerState.intervalValue,
      pollerState.intervalUnit,
      pollerState.intervalMinMs
    );
  }

  function summarizeSettings() {
    return {
      isActive: pollerState.isActive,
      selectedCity: pollerState.selectedCity || null,
      allCitiesSelected: pollerState.allCitiesSelected,
      distance: pollerState.distance || null,
      jobTypes: pollerState.jobType,
      cityTagCount: Array.isArray(pollerState.cityTags) ? pollerState.cityTags.length : 0,
      hasSelectedClient: hasSelectedClient(),
      intervalMs: pollerState.intervalMs,
      jobSearch: pollerState.jobSearch,
      authProbeStatus: pollerState.authProbeStatus,
      directApplicationMode: pollerState.useDirectApplication ? 'automated' : 'manual',
    };
  }

  function summarizeSearchContext() {
    return {
      selectedCity: pollerState.selectedCity || null,
      allCitiesSelected: pollerState.allCitiesSelected,
      hasCoordinates: pollerState.lat !== null && pollerState.lng !== null,
      distance: pollerState.distance || null,
      jobTypes: pollerState.jobType,
      cityTagCount: Array.isArray(pollerState.cityTags) ? pollerState.cityTags.length : 0,
      hasSelectedClient: hasSelectedClient(),
      intervalMs: pollerState.intervalMs,
      jobSearch: pollerState.jobSearch,
      authProbeStatus: pollerState.authProbeStatus,
    };
  }

  function getRoutinePollLogOptions(name, context = summarizeSearchContext()) {
    const logging = root.AMZ_CONSTANTS.LOGGING || {};
    return {
      throttleKey: [
        name,
        context.allCitiesSelected ? 'all-cities' : context.selectedCity || 'city',
        context.cityTagCount ?? 0,
        context.hasCoordinates ? 'geo' : 'no-geo',
        Array.isArray(context.jobTypes) ? context.jobTypes.join(',') : '',
        context.intervalMs || '',
        context.jobSearch?.fallbackDistanceKm || '',
        context.jobSearch?.fetchTimeoutMs || '',
      ].join('::'),
      throttleMs: Number(logging.POLLING_SUCCESS_THROTTLE_MS || logging.HIGH_FREQUENCY_THROTTLE_MS || 30000),
    };
  }

  async function syncRuntimeControlsToPollingState(controls) {
    if (!controls || typeof controls !== 'object') return;

    const { stored, snapshot, updates } = await state.syncRuntimeControls(controls, {
      selectedCity: pollerState.selectedCity,
      allCitiesSelected: pollerState.allCitiesSelected,
      distance: pollerState.distance,
      jobType: pollerState.jobType,
    }, {
      missingOnlyKeys: [
        STORAGE_KEYS.CITY_TAGS,
        STORAGE_KEYS.FETCH_INTERVAL_VALUE,
        STORAGE_KEYS.FETCH_INTERVAL_UNIT,
      ],
    });
    const storedTags = Array.isArray(stored[STORAGE_KEYS.CITY_TAGS])
      ? stored[STORAGE_KEYS.CITY_TAGS]
      : [];

    pollerState.selectedCity = snapshot[STORAGE_KEYS.SELECTED_CITY] || '';
    pollerState.allCitiesSelected = snapshot[STORAGE_KEYS.ALL_CITIES_SELECTED] === true;
    pollerState.lat = snapshot[STORAGE_KEYS.LATITUDE] ?? null;
    pollerState.lng = snapshot[STORAGE_KEYS.LONGITUDE] ?? null;
    pollerState.distance = snapshot[STORAGE_KEYS.DISTANCE] || '';
    pollerState.jobType = root.AMZ_RUNTIME_CONTROLS.normalizeJobTypeList(snapshot[STORAGE_KEYS.JOB_TYPE]);
    pollerState.cityTags = storedTags.length
      ? storedTags
      : snapshot[STORAGE_KEYS.CITY_TAGS] || [];
    applyIntervalSettings({
      [STORAGE_KEYS.FETCH_INTERVAL_VALUE]:
        stored[STORAGE_KEYS.FETCH_INTERVAL_VALUE] || snapshot[STORAGE_KEYS.FETCH_INTERVAL_VALUE],
      [STORAGE_KEYS.FETCH_INTERVAL_UNIT]:
        stored[STORAGE_KEYS.FETCH_INTERVAL_UNIT] || snapshot[STORAGE_KEYS.FETCH_INTERVAL_UNIT],
      [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: snapshot[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS],
    });
    pollerState.jobSearch = {
      fallbackDistanceKm:
        stored[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM] ||
        snapshot[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM] ||
        '',
      fetchTimeoutMs: root.AMZ_RUNTIME_CONTROLS.normalizePositiveInteger(
        stored[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS] ??
        snapshot[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]
      ),
    };

    if (Object.keys(updates).length > 0) {
      log.debug('runtime controls synced to polling state', updates);
    }
  }

  async function ensureRuntimeAllowed(options = {}) {
    pollerState.runtimeAllowed = true;
    pollerState.runtimePolicyCheckedAt = Date.now();
    return true;
  }

  async function ensureSelectedCityTag() {
    log.debug('ensureSelectedCityTag started', {
      selectedCity: pollerState.selectedCity,
      cityTags: pollerState.cityTags,
    });
    const merged = cityTagsUtil.mergeWithSelectedCity(
      pollerState.cityTags,
      ''
    );
    const changed = JSON.stringify(pollerState.cityTags || []) !== JSON.stringify(merged);
    pollerState.cityTags = merged;
    if (changed) await state.setCityTags(merged);
    log.debug('ensureSelectedCityTag stored', { cityTags: merged });
  }

  async function loadSettings() {
    log.debug('loadSettings started');
    const stored = await state.getPollingSettings();

    pollerState.selectedCity = stored[STORAGE_KEYS.SELECTED_CITY] || '';
    pollerState.allCitiesSelected =
      stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true ||
      (!stored[STORAGE_KEYS.SELECTED_CITY] &&
        Array.isArray(stored[STORAGE_KEYS.CITY_TAGS]) &&
        stored[STORAGE_KEYS.CITY_TAGS].length > 0);
    pollerState.lat = stored[STORAGE_KEYS.LATITUDE] ?? null;
    pollerState.lng = stored[STORAGE_KEYS.LONGITUDE] ?? null;
    pollerState.distance = stored[STORAGE_KEYS.DISTANCE] || '';
    pollerState.jobType = root.AMZ_RUNTIME_CONTROLS.normalizeJobTypeList(stored[STORAGE_KEYS.JOB_TYPE]);
    pollerState.cityTags = stored[STORAGE_KEYS.CITY_TAGS] || [];
    pollerState.selectedClientId = String(stored[STORAGE_KEYS.SELECTED_CLIENT_ID] || '').trim();
    pollerState.isActive = stored[STORAGE_KEYS.ACTIVE] === true;
    pollerState.useDirectApplication = stored[STORAGE_KEYS.USE_DIRECT_APPLICATION] !== false;
    pollerState.jobSearch = {
      fallbackDistanceKm: stored[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM] || '',
      fetchTimeoutMs: root.AMZ_RUNTIME_CONTROLS.normalizePositiveInteger(
        stored[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]
      ),
    };
    pollerState.authProbeStatus =
      stored[STORAGE_KEYS.AUTH_PROBE_STATUS] || AUTH_PROBE.STATUSES.CHECKING;
    applyIntervalSettings(stored);
    await ensureSelectedCityTag();
    log.info('runtime settings loaded', summarizeSettings());
    log.debug('runtime settings detail', {
      ...summarizeSettings(),
      lat: pollerState.lat,
      lng: pollerState.lng,
      intervalValue: pollerState.intervalValue,
      intervalUnit: pollerState.intervalUnit,
      cityTags: pollerState.cityTags,
      allCitiesSelected: pollerState.allCitiesSelected,
    });
  }

  function hasSelectedClient() {
    return true;
  }

  async function refreshAuthProbeStatusFromStorage() {
    const status = await state.getAuthProbeStatus();
    pollerState.authProbeStatus = status || AUTH_PROBE.STATUSES.CHECKING;
    return pollerState.authProbeStatus;
  }

  function isAmazonSessionAuthenticated() {
    return pollerState.authProbeStatus === AUTH_PROBE.STATUSES.AUTHENTICATED;
  }

  function isAmazonSessionDenied(status = pollerState.authProbeStatus) {
    return status === AUTH_PROBE.STATUSES.NOT_AUTHENTICATED ||
      status === AUTH_PROBE.STATUSES.UNKNOWN;
  }

  function hasCurrentPageAuthProbeAttempt() {
    const snapshot = root.AMZ_AUTH_PROBE?.getLastProbeSnapshot?.();
    if (!snapshot?.startedAt) return false;
    return snapshot.pageUrl === window.location.href;
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function runFreshAmazonAuthProbe(reason) {
    if (!root.AMZ_URL.isJobSearchPage()) return;

    const runProbe = root.AMZ_AUTH_PROBE?.runRefreshTriggeredProbe;
    if (typeof runProbe !== 'function') return;

    if (!authProbeRefreshPromise) {
      log.debug('running Amazon auth probe before GraphQL polling', { reason });
      renderPollingStatus({
        state: 'pending',
        details: 'Checking Amazon session before polling.',
      });
      authProbeRefreshPromise = Promise.resolve(runProbe()).finally(() => {
        authProbeRefreshPromise = null;
      });
    }

    await authProbeRefreshPromise;
    await refreshAuthProbeStatusFromStorage();
  }

  async function retryDeniedAmazonAuthProbeOnce(reason) {
    if (!root.AMZ_URL.isJobSearchPage()) return;

    const pageUrl = window.location.href;
    if (authProbeDeniedRetryPageUrl === pageUrl) return;

    authProbeDeniedRetryPageUrl = pageUrl;
    const delayMs = Number(AUTH_PROBE.ROUTE_RECHECK_DELAY_MS) || 750;
    log.debug('retrying Amazon auth probe before stopping polling', {
      reason,
      delayMs,
    });
    await wait(delayMs);
    await runFreshAmazonAuthProbe(`${reason}:route-recheck`);
  }

  async function ensureAmazonSessionAuthenticated(reason) {
    let hasFreshProbeAttempt = hasCurrentPageAuthProbeAttempt();
    if (isAmazonSessionAuthenticated() && hasFreshProbeAttempt) return true;

    if (
      pollerState.authProbeStatus === AUTH_PROBE.STATUSES.CHECKING &&
      root.AMZ_AUTH_PROBE?.ready
    ) {
      log.debug('waiting for Amazon auth probe before GraphQL polling', { reason });
      renderPollingStatus({
        state: 'pending',
        details: 'Checking Amazon session before polling.',
      });
      await root.AMZ_AUTH_PROBE.ready;
      await refreshAuthProbeStatusFromStorage();
      hasFreshProbeAttempt = hasCurrentPageAuthProbeAttempt();
    }

    if (!hasFreshProbeAttempt) {
      await runFreshAmazonAuthProbe(reason);
      hasFreshProbeAttempt = hasCurrentPageAuthProbeAttempt();
    }

    if (!isAmazonSessionAuthenticated() && isAmazonSessionDenied()) {
      await retryDeniedAmazonAuthProbeOnce(reason);
    }

    if (isAmazonSessionAuthenticated()) return true;

    const status = pollerState.authProbeStatus || AUTH_PROBE.STATUSES.UNKNOWN;
    const details = isAmazonSessionDenied(status)
      ? `Amazon session status is ${status}.`
      : 'Amazon session could not be verified before polling.';

    await handleUnauthorizedSession(`auth-probe:${reason}`, {
      details,
    });
    return false;
  }

  async function ensureSelectedClientForAutomation(reason) {
    return true;
  }

  function getEffectiveIntervalMs() {
    const wafBackoffMs = Math.max(0, pollerState.graphqlWafBackoffUntil - Date.now());
    return Math.max(pollerState.intervalMs, wafBackoffMs);
  }

  function renderPollingStatus(apiMeta) {
    if (apiMeta) {
      pollerState.lastApiMeta = apiMeta;
    }
    toasts.renderPollingToast({
      intervalMs: pollerState.intervalMs,
      intervalValue: pollerState.intervalValue,
      intervalUnit: pollerState.intervalUnit,
      effectiveIntervalMs: getEffectiveIntervalMs(),
      authBackoffActive: false,
      jobType: pollerState.jobType,
      cityTags: pollerState.cityTags,
      selectedCity: pollerState.selectedCity,
      allCitiesSelected: pollerState.allCitiesSelected,
      distance: pollerState.distance,
      authProbeStatus: pollerState.authProbeStatus,
      apiMeta: pollerState.lastApiMeta,
    });
  }

  function isOnMatchedJobDetail(matchedJob) {
    return root.AMZ_URL.isJobDetailPage() &&
      root.AMZ_URL.getJobIdFromUrl() === String(matchedJob?.jobId || '');
  }

  function assignJobDetailUrl(jobDetailUrl) {
    if (typeof window.location.assign === 'function') {
      window.location.assign(jobDetailUrl);
      return;
    }
    window.location.href = jobDetailUrl;
  }

  function clearNoApplyJobSearchRedirect() {
    if (!noApplyJobSearchRedirectTimer) return;
    clearTimeout(noApplyJobSearchRedirectTimer);
    noApplyJobSearchRedirectTimer = null;
  }

  function navigateToLogin() {
    if (root.AMZ_URL.isLoginPage()) return;
    window.location.assign(AMAZON.URLS.LOGIN);
  }

  async function handleUnauthorizedSession(source, metadata = {}) {
    if (authRedirectInProgress) return;
    authRedirectInProgress = true;

    pollerState.authProbeStatus = AUTH_PROBE.STATUSES.NOT_AUTHENTICATED;
    log.warn('amazon session unauthorized; stopping polling and navigating to login', {
      source,
      status: metadata.status ?? null,
      details: metadata.details || null,
      loginUrl: AMAZON.URLS.LOGIN,
      redirectDelayMs: root.AMZ_CONSTANTS.ALERTS.SESSION_UNAUTHORIZED_LOGIN_REDIRECT_DELAY_MS,
    });

    stopAutomation();
    renderPollingStatus({
      state: 'failed',
      status: metadata.status ?? null,
      durationMs: metadata.durationMs ?? null,
      details: metadata.details || 'Amazon session is not authorized.',
      isAuthError: true,
    });
    void root.AMZ_ALERTS.playSessionUnauthorizedSound?.();

    window.setTimeout(() => {
      navigateToLogin();
    }, root.AMZ_CONSTANTS.ALERTS.SESSION_UNAUTHORIZED_LOGIN_REDIRECT_DELAY_MS);
  }

  function chooseRecoveredSchedule(scheduleCards, jobId) {
    return (Array.isArray(scheduleCards) ? scheduleCards : []).find(schedule => (
      schedule?.scheduleId &&
      (!schedule.jobId || String(schedule.jobId) === String(jobId))
    )) || null;
  }

  function persistRecoveredSchedule(schedule, details = {}) {
    if (!schedule?.scheduleId) return;
    void root.AMZ_STORAGE?.setLocal?.({
      [STORAGE_KEYS.LAST_SELECTED_SCHEDULE]: {
        selectedAt: root.AMZ_TIME?.nowIstIso?.() || new Date().toISOString(),
        source: 'schedule-graphql-recovery',
        pageUrl: window.location.href,
        jobId: schedule.jobId || details.jobId || root.AMZ_URL.getJobIdFromUrl(),
        scheduleId: schedule.scheduleId,
        scheduleText: schedule.scheduleText || null,
        city: schedule.city || null,
        state: schedule.state || null,
        employmentType: schedule.employmentTypeL10N || schedule.employmentType || null,
        scheduleType: schedule.scheduleTypeL10N || schedule.scheduleType || null,
        firstDayOnSite: schedule.firstDayOnSiteL10N || schedule.firstDayOnSite || null,
        reason: details.reason || null,
      },
    }).catch(error => {
      log.debug('schedule recovery selection persistence skipped', {
        error: error?.message || String(error),
      });
    });
  }

  async function recoverNoApplyPathWithScheduleSearch(details = {}) {
    if (SCHEDULE_AUTOMATION.SCHEDULE_GRAPHQL_RECOVERY_ENABLED === false) {
      return 'disabled';
    }
    if (pollerState.useDirectApplication === false) {
      return 'disabled';
    }
    if (typeof root.AMZ_JOB_SEARCH?.fetchScheduleCards !== 'function') {
      return 'disabled';
    }

    const jobId = details.jobId || root.AMZ_URL.getJobIdFromUrl();
    if (!jobId) return 'disabled';

    log.info('verifying no-apply job detail with schedule GraphQL before cooldown', {
      ...details,
      jobId,
    });
    const result = await root.AMZ_JOB_SEARCH.fetchScheduleCards({
      jobId,
      jobSearch: pollerState.jobSearch,
    });
    const scheduleCards = Array.isArray(result.scheduleCards) ? result.scheduleCards : [];
    log.info('schedule GraphQL recovery completed', {
      jobId,
      state: result.state,
      status: result.status ?? null,
      durationMs: result.durationMs ?? null,
      scheduleCount: scheduleCards.length,
      details: result.details || null,
      isAuthError: result.isAuthError === true,
      isWafBlocked: result.isWafBlocked === true,
    });

    if (result.isAuthError) {
      await handleUnauthorizedSession('schedule-search-api', result);
      return 'auth-handled';
    }
    if (result.isWafBlocked) {
      const backoffMs = Number(POLLING.WAF_FORBIDDEN_BACKOFF_MS) || 5000;
      pollerState.graphqlWafBackoffUntil = Date.now() + backoffMs;
      log.warn('schedule GraphQL WAF forbidden; returning to search without unavailable cooldown', {
        jobId,
        status: result.status,
        details: result.details,
        backoffMs,
      });
      return 'failed';
    }
    if (result.state !== 'success') {
      log.warn('schedule GraphQL recovery failed; returning to search without unavailable cooldown', {
        jobId,
        status: result.status ?? null,
        details: result.details || null,
      });
      return 'failed';
    }
    if (scheduleCards.length === 0) {
      root.AMZ_APPLICATION_OBSERVABILITY?.finalizePendingScheduleDisappearedAfterMatch?.({
        href: window.location.href,
        jobId,
      }, {
        ...details,
        jobId,
        pageUrl: window.location.href,
        status: result.status ?? null,
        durationMs: result.durationMs ?? null,
        scheduleCount: 0,
        details: result.details || null,
        source: 'schedule-graphql-recovery',
      });
      return 'unavailable';
    }

    const selectedSchedule = chooseRecoveredSchedule(scheduleCards, jobId);
    const scheduleId = selectedSchedule?.scheduleId || null;
    const applicationUrl = root.AMZ_URL.buildApplicationPreConsentUrl(
      jobId,
      scheduleId,
      AMAZON.COUNTRY_CONFIG
    );
    if (!scheduleId || !applicationUrl) {
      log.warn('schedule GraphQL recovery found schedules but could not build application URL', {
        jobId,
        scheduleCount: scheduleCards.length,
        scheduleId,
      });
      return 'failed';
    }

    persistRecoveredSchedule(selectedSchedule, { ...details, jobId });
    log.info('schedule GraphQL recovery found schedule; routing to direct application', {
      jobId,
      scheduleId,
      scheduleCount: scheduleCards.length,
      applicationUrl,
    });
    clearNoApplyJobSearchRedirect();
    scheduleAutomation.stop('schedule-graphql-recovery');
    window.location.assign(applicationUrl);
    return 'routed';
  }

  function scheduleReturnToJobSearchAfterNoApply(details = {}, options = {}) {
    if (noApplyJobSearchRedirectTimer) return;
    const shouldMarkUnavailable = options.markUnavailable !== false;
    if (shouldMarkUnavailable) {
      markUnavailableScheduleCooldown(details.jobId || root.AMZ_URL.getJobIdFromUrl(), {
        ...details,
        source: 'schedule-automation',
      });
    }

    log.warn('no apply/schedule path found; returning to job search soon', {
      ...details,
      unavailableCooldownMarked: shouldMarkUnavailable,
      redirectDelayMs: SCHEDULE_AUTOMATION.NO_APPLY_JOB_SEARCH_REDIRECT_DELAY_MS,
    });

    noApplyJobSearchRedirectTimer = setTimeout(() => {
      noApplyJobSearchRedirectTimer = null;
      if (!pollerState.isActive || !root.AMZ_URL.isJobDetailPage()) return;
      log.info('returning to job search after no apply/schedule path', {
        currentUrl: window.location.href,
      });
      window.location.assign(AMAZON.URLS.JOB_SEARCH);
    }, SCHEDULE_AUTOMATION.NO_APPLY_JOB_SEARCH_REDIRECT_DELAY_MS);
  }

  async function handleNoApplyPath(details = {}) {
    if (!pollerState.isActive || !root.AMZ_URL.isJobDetailPage()) return;
    if (noApplyJobSearchRedirectTimer || noApplyScheduleRecoveryInProgress) return;

    noApplyScheduleRecoveryInProgress = true;
    let recovery = 'failed';
    try {
      recovery = await recoverNoApplyPathWithScheduleSearch(details);
    } catch (error) {
      log.error('schedule GraphQL recovery failed unexpectedly:', error);
      recovery = 'failed';
    } finally {
      noApplyScheduleRecoveryInProgress = false;
    }

    if (!pollerState.isActive || !root.AMZ_URL.isJobDetailPage()) return;
    if (recovery === 'routed' || recovery === 'auth-handled') return;

    scheduleReturnToJobSearchAfterNoApply(details, {
      markUnavailable: recovery === 'unavailable' || recovery === 'disabled',
    });
  }

  function openMatchedJobDetail(matchedJob, jobDetailUrl) {
    if (!jobDetailUrl) return false;

    log.info('navigating to matched job detail by URL', {
      jobDetailUrl,
      jobId: matchedJob.jobId,
    });
    assignJobDetailUrl(jobDetailUrl);

    window.setTimeout(() => {
      if (isOnMatchedJobDetail(matchedJob)) return;

      log.warn('matched job detail fallback URL navigation', {
        jobDetailUrl,
        jobId: matchedJob.jobId,
        currentUrl: window.location.href,
      });
      assignJobDetailUrl(jobDetailUrl);
    }, JOB_DETAIL_NAVIGATION_FALLBACK_DELAY_MS);

    return true;
  }

  function unavailableScheduleKey(jobId, scheduleId = '*') {
    return [
      DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_STORAGE_PREFIX,
      jobId || '',
      scheduleId || '*',
    ].join('::');
  }

  function readUnavailableScheduleCooldown(jobId, scheduleId = '*') {
    try {
      const key = unavailableScheduleKey(jobId, scheduleId);
      const raw = window.sessionStorage?.getItem(key);
      const entry = raw ? JSON.parse(raw) : null;
      if (!entry) return null;
      if (Number(entry.expiresAt) <= Date.now()) {
        window.sessionStorage?.removeItem(key);
        return null;
      }
      return entry;
    } catch (_) {
      return null;
    }
  }

  function removeUnavailableScheduleCooldown(jobId, scheduleId = '*') {
    try {
      window.sessionStorage?.removeItem(unavailableScheduleKey(jobId, scheduleId));
    } catch (_) {
      // Session storage cooldown cleanup is best-effort.
    }
  }

  function writeUnavailableScheduleCooldown(jobId, scheduleId = '*', details = {}) {
    if (!jobId) return;
    try {
      const now = Date.now();
      const cooldownMs = Math.max(1000, Number(DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_COOLDOWN_MS) || 0);
      const entry = {
        jobId,
        scheduleId: scheduleId || '*',
        source: details.source || 'job-search',
        reason: details.reason || null,
        errorCode: details.errorCode || null,
        pageUrl: details.pageUrl || window.location.href,
        createdAt: now,
        expiresAt: now + cooldownMs,
      };
      window.sessionStorage?.setItem(
        unavailableScheduleKey(jobId, scheduleId || '*'),
        JSON.stringify(entry)
      );
      void root.AMZ_STORAGE?.setLocal?.({
        [unavailableScheduleKey(jobId, scheduleId || '*')]: entry,
      }).catch(() => {});
      log.warn('job marked unavailable for cooldown', {
        jobId,
        scheduleId: scheduleId || null,
        reason: entry.reason,
        source: entry.source,
        cooldownMs,
      });
    } catch (_) {
      // Session storage cooldown is best-effort; never block polling.
    }
  }

  function markUnavailableScheduleCooldown(jobId, details = {}) {
    if (!jobId) return;
    writeUnavailableScheduleCooldown(jobId, '*', details);
  }

  function filterUnavailableCooldownJobs(jobCards) {
    if (!Array.isArray(jobCards) || jobCards.length === 0) return jobCards;

    const skipped = [];
    const filtered = jobCards.filter(job => {
      const jobId = job?.jobId;
      if (!jobId) return true;
      const cooldown = readUnavailableScheduleCooldown(jobId, '*');
      if (!cooldown) return true;
      if (
        cooldown.source === 'schedule-automation' ||
        cooldown.source === 'schedule-graphql-recovery'
      ) {
        removeUnavailableScheduleCooldown(jobId, '*');
        log.info('cleared stale job-level schedule cooldown so matching can retry', {
          jobId,
          source: cooldown.source,
          reason: cooldown.reason || null,
        });
        return true;
      }
      skipped.push({
        jobId,
        scheduleId: cooldown.scheduleId || null,
        errorCode: cooldown.errorCode || null,
        source: cooldown.source || null,
        expiresAt: cooldown.expiresAt || null,
      });
      return false;
    });

    if (skipped.length > 0) {
      log.warn('skipping jobs cooling down after unavailable schedule response', {
        skippedCount: skipped.length,
        remainingCount: filtered.length,
        cooldownMs: DIRECT_APPLICATION.UNAVAILABLE_SCHEDULE_COOLDOWN_MS,
        skippedJobs: skipped.slice(0, 5),
      });
    }
    return filtered;
  }

  async function matchJobsToCity(jobCards, requestResult = {}) {
    const searchableJobCards = filterUnavailableCooldownJobs(jobCards);
    log.debug('matchJobsToCity started', {
      jobCount: Array.isArray(searchableJobCards) ? searchableJobCards.length : null,
      originalJobCount: Array.isArray(jobCards) ? jobCards.length : null,
      selectedCity: pollerState.selectedCity,
      cityTags: pollerState.cityTags,
      selectedJobTypes: pollerState.jobType,
    });
    const matchDiagnostics = jobMatcher.buildMatchDiagnostics(searchableJobCards, {
      cityTags: pollerState.cityTags,
      selectedCity: pollerState.selectedCity,
      selectedJobTypes: pollerState.jobType,
      sampleLimit: 5,
    });
    const { storedTags, matchingTags, matchedJob } = jobMatcher.findMatchingJob(searchableJobCards, {
      cityTags: pollerState.cityTags,
      selectedCity: pollerState.selectedCity,
      selectedJobTypes: pollerState.jobType,
    });
    pollerState.cityTags = storedTags;

    // Keep match evaluation on the critical path; persistence is background-only.
    void state.setCityTags(storedTags).catch(error => {
      log.error('Unable to persist merged city tags:', error);
    });

    if (matchedJob) {
      log.info('matching job found', {
        ...jobMatcher.summarizeJob(matchedJob),
        selectedCity: pollerState.selectedCity || null,
        matchingTagCount: matchingTags.length,
      });
      log.debug('matchJobsToCity result detail', {
        matched: true,
        diagnostics: matchDiagnostics,
        matchedJob,
      });
    } else {
      log.debug('matchJobsToCity result', {
        matched: false,
        diagnostics: matchDiagnostics,
        storedTags,
        matchingTags,
      });
    }
    if (!matchedJob) return null;

    const paidGate = await root.AMZ_PAYMENT_GATE?.requireAllowed?.({ allowCache: false });
    if (!paidGate?.ok) {
      log.warn('matched job blocked by paid license gate', {
        jobId: matchedJob.jobId || null,
        reason: paidGate?.reason || 'license-denied',
      });
      toasts.showCreditsRequiredPopup({
        city: matchedJob.city,
        jobId: matchedJob.jobId || null,
        reason: paidGate?.reason || 'credits-required',
      });
      return null;
    }

    // Sound and metadata are optional side effects and must not delay navigation.
    void root.AMZ_ALERTS.playJobFoundSound();
    toasts.showJobFoundToast(matchedJob.city);

    const jobDetailUrl = root.AMZ_URL.buildJobDetailUrl(matchedJob.jobId, AMAZON.COUNTRY_CONFIG);
    const observabilityTrace = root.AMZ_APPLICATION_OBSERVABILITY?.createApplicationAttemptTrace?.({
      matchedJob,
      searchResult: requestResult,
      searchContext: summarizeSearchContext(),
      matchDiagnostics,
    }) || null;
    if (observabilityTrace) {
      root.AMZ_APPLICATION_OBSERVABILITY.flushProgress(observabilityTrace, 'JOB_MATCHED', {
        detailedOutcome: 'JOB_MATCHED',
      }, { href: window.location.href, jobId: matchedJob.jobId });
      root.AMZ_APPLICATION_OBSERVABILITY.recordJobDetailNavigation(observabilityTrace, matchedJob, jobDetailUrl);
      await root.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(observabilityTrace);
    }
    void state.setLastMatchedJob(jobMatcher.buildLastMatchedJobMetadata(matchedJob, {
      selectedCity: pollerState.selectedCity,
      matchingTags,
      distance: pollerState.distance,
      selectedJobTypes: pollerState.jobType,
      country: AMAZON.COUNTRY_CONFIG.country,
      pageUrl: window.location.href,
    })).catch(error => {
      log.error('Unable to persist last matched job metadata:', error);
    });

    if (root.AMZ_VALIDATION?.getControls?.()?.features?.telegram !== false) {
      void account.getStoredLoginUsername().then(clientEmail => {
        return root.AMZ_NOTIFICATIONS?.emit(root.AMZ_CONSTANTS.NOTIFICATIONS.EVENTS.JOB_FOUND, {
          jobId: matchedJob.jobId || null,
          jobTitle: matchedJob.jobTitle || null,
          city: matchedJob.city || null,
          state: matchedJob.state || null,
          locationName: matchedJob.locationName || null,
          employmentType: matchedJob.employmentTypeL10N || matchedJob.employmentType || null,
          jobType: matchedJob.jobType || matchedJob.jobTypeL10N || null,
          pay:
            matchedJob.totalPayRateMaxL10N ||
            matchedJob.totalPayRateMinL10N ||
            matchedJob.totalPayRateMax ||
            null,
          clientEmail: clientEmail || null,
          mode: pollerState.useDirectApplication ? 'direct' : 'manual',
          pageUrl: jobDetailUrl,
          jobSnapshot: matchedJob,
        }, {
          source: 'job-search-match',
        });
      }).catch(error => {
        log.debug('job-found notification skipped after emit failure', {
          error: error?.message || String(error),
        });
      });
    }
    if (jobDetailUrl) {
      log.info('opening matched job detail and starting schedule automation', {
        jobDetailUrl,
        job: jobMatcher.summarizeJob(matchedJob),
      });
      if (openMatchedJobDetail(matchedJob, jobDetailUrl)) {
        scheduleAutomation.start();
      }
    }
    return matchedJob;
  }

  async function fetchJobs() {
    if (!await ensureSelectedClientForAutomation('fetch-jobs')) return;
    if (!await ensureAmazonSessionAuthenticated('fetch-jobs')) return;

    if (!pollerState.runtimeAllowed && root.AMZ_VALIDATION?.isAllowed?.() !== true) {
      log.warn('fetch skipped because runtime policy is not allowed');
      stopAutomation();
      return;
    }

    if (!pollerState.isActive || !root.AMZ_URL.isJobSearchPage()) {
      log.trace('fetchJobs skipped', {
        isActive: pollerState.isActive,
        isJobSearchPage: root.AMZ_URL.isJobSearchPage(),
        url: window.location.href,
      }, {
        throttleKey: 'fetch-jobs-skipped',
        throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
      });
      return;
    }

    renderPollingStatus({ state: 'pending' });
    const requestContext = summarizeSearchContext();
    log.debug(
      'fetchJobs request started',
      requestContext,
      getRoutinePollLogOptions('fetch-jobs-started', requestContext)
    );
    const result = await root.AMZ_JOB_SEARCH.fetchJobCards({
      lat: pollerState.lat,
      lng: pollerState.lng,
      distance: pollerState.distance,
      jobType: pollerState.jobType,
      selectedCity: pollerState.selectedCity,
      allCitiesSelected: pollerState.allCitiesSelected,
      cityTags: pollerState.cityTags,
      jobSearch: pollerState.jobSearch,
    });
    const jobCount = Array.isArray(result.jobCards) ? result.jobCards.length : 0;
    const completionContext = summarizeSearchContext();
    const isRoutineEmptySuccess = (
      result.state === 'success' &&
      jobCount === 0 &&
      result.isAuthError !== true &&
      result.isWafBlocked !== true
    );
    log.debug('fetchJobs request completed', {
      state: result.state,
      status: result.status,
      durationMs: result.durationMs,
      details: result.details,
      jobCount,
      isAuthError: result.isAuthError === true,
      isWafBlocked: result.isWafBlocked === true,
      context: completionContext,
    }, isRoutineEmptySuccess ? getRoutinePollLogOptions('fetch-jobs-empty-completed', completionContext) : undefined);
    if (result.isWafBlocked) {
      const backoffMs = Number(POLLING.WAF_FORBIDDEN_BACKOFF_MS) || 5000;
      pollerState.graphqlWafBackoffUntil = Date.now() + backoffMs;
      log.warn('graphql WAF forbidden; backing off before retry', {
        status: result.status,
        details: result.details,
        backoffMs,
      });
    } else {
      pollerState.graphqlWafBackoffUntil = 0;
    }

    renderPollingStatus(result);

    if (result.isAuthError) {
      await handleUnauthorizedSession('job-search-api', result);
      return;
    }

    if (result.state !== 'success') {
      log.debug('fetchJobs stopped before matching because request failed', {
        status: result.status,
        details: result.details,
        isAuthError: result.isAuthError === true,
        isWafBlocked: result.isWafBlocked === true,
      });
      return;
    }

    if (result.jobCards.length === 0) {
      return;
    }

    log.debug('jobs fetched', {
      jobCount: result.jobCards.length,
      sampleJobs: result.jobCards.slice(0, 5).map(jobMatcher.summarizeJob),
    });

    toasts.showJobsReceivedToast(pollerState.intervalMs);
    const matchedJob = await matchJobsToCity(result.jobCards, result);
    if (matchedJob) {
      poller.stop();
      toasts.closePollingToast();
    }
  }

  const poller = root.AMZ_POLLING.createSingleFlightPoller({
    run: fetchJobs,
    canRun: () => pollerState.isActive && hasSelectedClient() && root.AMZ_URL.isJobSearchPage(),
    getDelayMs: getEffectiveIntervalMs,
  });

  async function readDirectApplicationResult() {
    const stored = await root.AMZ_STORAGE.getLocal(STORAGE_KEYS.DIRECT_APPLICATION_RESULT);
    return stored[STORAGE_KEYS.DIRECT_APPLICATION_RESULT] || null;
  }

  function useDirectApplication() {
    return pollerState.useDirectApplication !== false;
  }

  function getUpdatedAtMs(result) {
    if (!result?.updatedAt) return 0;
    const parsed = Date.parse(result.updatedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function isFreshDirectApplicationResult(result) {
    const updatedAtMs = getUpdatedAtMs(result);
    if (!updatedAtMs) return false;
    return Date.now() - updatedAtMs <= DIRECT_APPLICATION.NAVIGATION_PAUSE_TTL_MS;
  }

  function isDirectApplicationNavigationPauseStage(result) {
    if (!result?.stage) return false;
    if (
      result.stage === DIRECT_APPLICATION.STAGES.FAILED ||
      result.stage === DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED ||
      (
        result.stage === DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM &&
        result.errorClassification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED &&
        result.fallbackAllowed === false
      )
    ) {
      return false;
    }
    if (DIRECT_APPLICATION.NAVIGATION_PAUSE_STAGES.includes(result.stage)) return true;

    const postCreateStages = [
      DIRECT_APPLICATION.STAGES.WAF_TOKEN_READY,
      DIRECT_APPLICATION.STAGES.WAF_TOKEN_UNAVAILABLE,
      DIRECT_APPLICATION.STAGES.CAPTCHA_REQUIRED,
    ];
    return Boolean(
      result.applicationId &&
      postCreateStages.includes(result.stage)
    );
  }

  function getDirectApplicationResumeUrl(result) {
    const pageUrl = result?.pageUrl || '';
    return root.AMZ_URL.isApplicationPage(pageUrl) ? pageUrl : '';
  }

  function restoreDirectApplicationPage(result) {
    const resumeUrl = getDirectApplicationResumeUrl(result);
    if (!resumeUrl || root.AMZ_URL.isApplicationPage()) return;

    log.info('returning to direct application page while confirmation is pending', {
      resumeUrl,
      stage: result.stage,
      applicationId: result.applicationId || null,
    });
    window.setTimeout(() => {
      if (!root.AMZ_URL.isApplicationPage()) {
        window.location.assign(resumeUrl);
      }
    }, 250);
  }

  async function pauseForDirectApplicationIfNeeded() {
    if (!useDirectApplication()) return false;

    const result = await readDirectApplicationResult();
    if (
      !isFreshDirectApplicationResult(result) ||
      !isDirectApplicationNavigationPauseStage(result)
    ) {
      return false;
    }

    log.info('direct application confirmation pending; pausing page automation', {
      stage: result.stage,
      jobId: result.jobId,
      scheduleId: result.scheduleId,
      applicationId: result.applicationId || null,
      updatedAt: result.updatedAt,
    }, {
      throttleKey: `direct-application-pending:${result.jobId || ''}:${result.scheduleId || ''}:${result.stage || ''}`,
      throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
    });
    poller.stop();
    scheduleAutomation.stop();
    restoreDirectApplicationPage(result);
    return true;
  }

  async function handlePageNavigation() {
    log.debug('handlePageNavigation started', {
      url: window.location.href,
      isActive: pollerState.isActive,
      isLoginPage: root.AMZ_URL.isLoginPage(),
      isJobSearchPage: root.AMZ_URL.isJobSearchPage(),
      isJobDetailPage: root.AMZ_URL.isJobDetailPage(),
    });
    void root.AMZ_IDENTITY.syncEmailFromPage().catch(error => {
      log.debug('identity sync skipped after navigation', { error: error?.message || String(error) });
    });

    if (root.AMZ_URL.isLoginPage() && pollerState.isActive) {
      authProbeDeniedRetryPageUrl = '';
      if (!await ensureSelectedClientForAutomation('login-page')) return;
      log.info('login page detected; starting auth login flow without runtime gate');
      await root.AMZ_LOGIN?.handleAuthLoginFlow?.();
      return;
    }

    if (pollerState.isActive && !await ensureSelectedClientForAutomation('page-navigation')) {
      return;
    }

    if (
      pollerState.isActive &&
      root.AMZ_URL.isJobSearchPage() &&
      !await ensureAmazonSessionAuthenticated('page-navigation')
    ) {
      return;
    }

    if (
      pollerState.isActive &&
      !pollerState.runtimeAllowed &&
      root.AMZ_VALIDATION?.isAllowed?.() !== true
    ) {
      log.warn('page automation paused because cached runtime policy is not allowed');
      stopAutomation();
      return;
    }
    if (pollerState.isActive && await pauseForDirectApplicationIfNeeded()) return;

    if (root.AMZ_URL.isJobSearchPage() && pollerState.isActive) {
      clearNoApplyJobSearchRedirect();
      log.debug('job search page active; starting poller');
      poller.start();
    }

    if (root.AMZ_URL.isJobDetailPage() && pollerState.isActive) {
      log.debug('job detail page active; starting schedule automation');
      scheduleAutomation.start();
    }
  }

  function stopAutomation() {
    log.debug('stopAutomation called');
    clearNoApplyJobSearchRedirect();
    poller.stop();
    scheduleAutomation.stop();
    toasts.closePollingToast();
  }

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local') return;
    const changedKeys = Object.keys(changes || {});
    if (changedKeys.length === 0) return;

    let shouldRenderPollingStatus = false;
    log.debug('storage changed', {
      keys: changedKeys,
      areaName,
    });

    if (changes[STORAGE_KEYS.SELECTED_CITY]) {
      pollerState.selectedCity = changes[STORAGE_KEYS.SELECTED_CITY].newValue;
      shouldRenderPollingStatus = true;
    }
    if (changes[STORAGE_KEYS.ALL_CITIES_SELECTED]) {
      pollerState.allCitiesSelected = changes[STORAGE_KEYS.ALL_CITIES_SELECTED].newValue === true;
      shouldRenderPollingStatus = true;
    }
    if (changes[STORAGE_KEYS.LATITUDE]) pollerState.lat = changes[STORAGE_KEYS.LATITUDE].newValue;
    if (changes[STORAGE_KEYS.LONGITUDE]) pollerState.lng = changes[STORAGE_KEYS.LONGITUDE].newValue;
    if (changes[STORAGE_KEYS.DISTANCE]) {
      pollerState.distance = changes[STORAGE_KEYS.DISTANCE].newValue;
      shouldRenderPollingStatus = true;
    }
    if (changes[STORAGE_KEYS.JOB_TYPE]) {
      pollerState.jobType = root.AMZ_RUNTIME_CONTROLS.normalizeJobTypeList(
        changes[STORAGE_KEYS.JOB_TYPE].newValue
      );
      shouldRenderPollingStatus = true;
    }
    if (changes[STORAGE_KEYS.CITY_TAGS]) {
      pollerState.cityTags = changes[STORAGE_KEYS.CITY_TAGS].newValue || [];
      shouldRenderPollingStatus = true;
    }
    if (changes[STORAGE_KEYS.SELECTED_CLIENT_ID]) {
      pollerState.selectedClientId = String(changes[STORAGE_KEYS.SELECTED_CLIENT_ID].newValue || '').trim();
      if (pollerState.isActive && !await ensureSelectedClientForAutomation('selected-client-cleared')) {
        return;
      }
    }
    if (changes[STORAGE_KEYS.AUTH_PROBE_STATUS]) {
      pollerState.authProbeStatus =
        changes[STORAGE_KEYS.AUTH_PROBE_STATUS].newValue || AUTH_PROBE.STATUSES.CHECKING;
      shouldRenderPollingStatus = true;
      if (
        pollerState.isActive &&
        isAmazonSessionDenied(pollerState.authProbeStatus)
      ) {
        if (root.AMZ_URL.isJobSearchPage()) {
          await retryDeniedAmazonAuthProbeOnce('auth-probe-storage-change');
          if (isAmazonSessionAuthenticated()) {
            await handlePageNavigation();
            return;
          }
        }
        await handleUnauthorizedSession('auth-probe', {
          status: changes[STORAGE_KEYS.AUTH_PROBE_HTTP_STATUS]?.newValue ?? null,
          details: changes[STORAGE_KEYS.AUTH_PROBE_DETAIL]?.newValue || 'Amazon authorize probe failed.',
        });
        return;
      }
      if (
        pollerState.isActive &&
        pollerState.authProbeStatus === AUTH_PROBE.STATUSES.AUTHENTICATED &&
        root.AMZ_URL.isJobSearchPage()
      ) {
        authProbeDeniedRetryPageUrl = '';
        await handlePageNavigation();
      }
    }
    if (changes[STORAGE_KEYS.USE_DIRECT_APPLICATION]) {
      pollerState.useDirectApplication = changes[STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue !== false;
      log.info('direct application mode changed from storage', {
        useDirectApplication: pollerState.useDirectApplication,
        mode: pollerState.useDirectApplication ? 'automated' : 'manual',
      });
      if (pollerState.isActive) {
        void handlePageNavigation().catch(error => {
          log.error('page navigation after direct application mode change failed:', error);
        });
      }
    }

    if (
      changes[STORAGE_KEYS.SELECTED_CITY] ||
      changes[STORAGE_KEYS.ALL_CITIES_SELECTED] ||
      changes[STORAGE_KEYS.CITY_TAGS]
    ) {
      await ensureSelectedCityTag();
    }

    if (changes[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]) {
      pollerState.jobSearch.fallbackDistanceKm =
        changes[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM].newValue || '';
    }
    if (changes[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]) {
      pollerState.jobSearch.fetchTimeoutMs = root.AMZ_RUNTIME_CONTROLS.normalizePositiveInteger(
        changes[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS].newValue
      );
    }

    if (
      changes[STORAGE_KEYS.FETCH_INTERVAL_VALUE] ||
      changes[STORAGE_KEYS.FETCH_INTERVAL_UNIT] ||
      changes[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]
    ) {
      if (changes[STORAGE_KEYS.FETCH_INTERVAL_VALUE]) {
        pollerState.intervalValue = changes[STORAGE_KEYS.FETCH_INTERVAL_VALUE].newValue || '';
      }
      if (changes[STORAGE_KEYS.FETCH_INTERVAL_UNIT]) {
        pollerState.intervalUnit = changes[STORAGE_KEYS.FETCH_INTERVAL_UNIT].newValue || '';
      }
      if (changes[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]) {
        pollerState.intervalMinMs = changes[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS].newValue || 0;
      }
      pollerState.intervalMs = root.AMZ_INTERVALS.resolveMilliseconds(
        pollerState.intervalValue,
        pollerState.intervalUnit,
        pollerState.intervalMinMs
      );
      poller.restart();
      shouldRenderPollingStatus = true;
    }

    if (changes[STORAGE_KEYS.ACTIVE]) {
      pollerState.isActive = changes[STORAGE_KEYS.ACTIVE].newValue === true;
      log.info('active state changed from storage', { isActive: pollerState.isActive });
      if (pollerState.isActive) {
        if (
          await ensureSelectedClientForAutomation('active-storage-change') &&
          await ensureRuntimeAllowed({ allowCache: false, refresh: true })
        ) {
          await handlePageNavigation();
        }
      } else {
        root.AMZ_APPLICATION_OBSERVABILITY?.finalizePendingDeactivated?.({
          href: window.location.href,
          jobId: root.AMZ_URL.getJobIdFromUrl(),
        }, {
          source: 'active-toggle',
          page_url: window.location.href,
        });
        stopAutomation();
      }
    }

    if (changes[STORAGE_KEYS.OPERATOR_USERNAME] && pollerState.isActive) {
      if (await ensureRuntimeAllowed({ allowCache: false, refresh: true })) {
        await handlePageNavigation();
      }
    }

    if (shouldRenderPollingStatus && pollerState.isActive && root.AMZ_URL.isJobSearchPage()) {
      renderPollingStatus();
    }
  });

  chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (
      message?.action === MESSAGE_ACTIONS.ACTIVATE ||
      message?.action === MESSAGE_ACTIONS.EXTENSION_STATE_CHANGED
    ) {
      pollerState.isActive = message.status === true;
      log.debug('runtime message received', {
        action: message.action,
        status: message.status,
        isActive: pollerState.isActive,
      });
      if (pollerState.isActive) {
        void (async () => {
          const hasClient = await ensureSelectedClientForAutomation('runtime-message');
          if (!hasClient) return;
          const allowed = await ensureRuntimeAllowed({ allowCache: false, refresh: true });
          if (allowed) handlePageNavigation();
        })();
      } else {
        stopAutomation();
      }
    }
    sendResponse(true);
  });

  const handleRouteMutation = () => {
    handlePageNavigation().catch(error => {
      log.error('route transition handling failed:', error);
    });
  };

  window.addEventListener('hashchange', handleRouteMutation);
  window.addEventListener('popstate', handleRouteMutation);

  await loadSettings();
  void root.AMZ_IDENTITY.syncEmailFromPage().catch(error => {
    log.debug('initial identity sync failed', { error: error?.message || String(error) });
  });
  if (pollerState.isActive && await ensureSelectedClientForAutomation('initial-load')) {
    await ensureRuntimeAllowed({ refresh: true });
  }
  await handlePageNavigation();
})(typeof globalThis !== 'undefined' ? globalThis : self);
