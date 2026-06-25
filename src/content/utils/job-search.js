/* GraphQL request construction and job-card fetching. */
(function (root) {
  'use strict';

  if (root.AMZ_JOB_SEARCH) return;

  const { AMAZON } = root.AMZ_CONSTANTS;
  const state = root.AMZ_STATE;
  const runtimeControls = root.AMZ_RUNTIME_CONTROLS;
  const log = root.AMZ_LOGGER?.create?.('[amazon-shift][job-search-api]', {
    workflow: 'job-search',
    source: 'content/utils/job-search.js',
  }) || Object.freeze({
    debug: () => {},
  });

  async function readJobSearchControls() {
    return state.getJobSearchControls();
  }

  function resolveDistanceKm(distance, controls = {}) {
    return runtimeControls.normalizePositiveInteger(distance) ||
      runtimeControls.normalizePositiveInteger(controls.fallbackDistanceKm) ||
      0;
  }

  function shouldIncludeGeoQueryClause() {
    return AMAZON.COUNTRY_CONFIG.search?.includeGeoQueryClause !== false;
  }

  function clonePlainObjectList(items) {
    return Array.isArray(items)
      ? items.map(item => ({ ...item }))
      : [];
  }

  function getJobTypeContainFilter(jobType, isCanada = AMAZON.isCanada) {
    return null;
  }

  function buildContainFilters(parameters = {}) {
    const searchConfig = AMAZON.GRAPHQL.SEARCH_CONFIG;
    const containFilters = [
      {
        key: searchConfig.PRIVATE_SCHEDULE_FILTER_KEY,
        val: [searchConfig.PRIVATE_SCHEDULE_FILTER_VALUE],
      },
    ];
    const jobTypeFilter = getJobTypeContainFilter(parameters.jobType);
    if (jobTypeFilter) containFilters.push(jobTypeFilter);
    return containFilters;
  }

  function shouldIncludeHoursPerWeekRange() {
    return AMAZON.COUNTRY_CONFIG.search?.includeHoursPerWeekRange !== false;
  }

  function shouldIncludeConsolidateSchedule() {
    return AMAZON.COUNTRY_CONFIG.search?.includeConsolidateSchedule !== false;
  }

  function isAllCitiesSearch(parameters = {}) {
    if (AMAZON.isCanada !== true) return false;
    if (parameters.allCitiesSelected === true) return true;

    const selectedCity = root.AMZ_TEXT.normalizeWhitespace(parameters.selectedCity || '');
    const cityTags = root.AMZ_RUNTIME_CONTROLS.normalizeStringList(parameters.cityTags);
    return !selectedCity && cityTags.length > 0;
  }

  function shouldIncludeGeoQueryClauseForRequest(parameters = {}) {
    return shouldIncludeGeoQueryClause() && !isAllCitiesSearch(parameters);
  }

  function shouldIncludeHoursPerWeekRangeForRequest(parameters = {}) {
    return shouldIncludeHoursPerWeekRange() && !isAllCitiesSearch(parameters);
  }

  function shouldIncludeConsolidateScheduleForRequest(parameters = {}) {
    return shouldIncludeConsolidateSchedule() && !isAllCitiesSearch(parameters);
  }

  function getRequestValidationError(parameters = {}, controls = {}) {
    if (!shouldIncludeGeoQueryClauseForRequest(parameters)) return '';

    if (
      runtimeControls.normalizeNumber(parameters.lat) === null ||
      runtimeControls.normalizeNumber(parameters.lng) === null
    ) {
      return 'Missing location coordinates. Refresh settings or choose a city before polling.';
    }
    if (!resolveDistanceKm(parameters.distance, controls)) {
      return 'Missing search distance. Refresh settings or choose a distance before polling.';
    }
    return '';
  }

  function isAuthRelatedFailure(status, details) {
    const authConfig = root.AMZ_CONSTANTS.POLLING.AUTH_BACKOFF;
    if (authConfig.AUTH_HTTP_STATUSES.includes(status)) return true;

    const normalizedDetails = String(details || '').toLowerCase();
    return authConfig.AUTH_ERROR_PATTERNS.some(pattern =>
      normalizedDetails.includes(pattern)
    );
  }

  function getAuthorizationHeader() {
    const sessionToken = window.localStorage.getItem('sessionToken') || '';
    const candidateId = window.localStorage.getItem('bbCandidateId') || '';
    const loginStatus = candidateId ? 'logged-in' : 'unauthenticated';
    return `Bearer Status|${loginStatus}|Session|${sessionToken}`;
  }

  function buildRequestBody(parameters = {}) {
    const { lat, lng, distance, jobSearch } = parameters;
    const searchConfig = AMAZON.GRAPHQL.SEARCH_CONFIG;
    const countrySearchConfig = AMAZON.COUNTRY_CONFIG.search || {};
    const today = new Date().toISOString().split('T')[0];
    const dateFilters = [{
      key: searchConfig.FIRST_DAY_FILTER_KEY,
      range: { startDate: today },
    }];
    const baseSearchJobRequest = {
      locale: AMAZON.COUNTRY_CONFIG.locale,
      country: AMAZON.COUNTRY_CONFIG.country,
      pageSize: AMAZON.GRAPHQL.PAGE_SIZE,
      sorters: clonePlainObjectList(countrySearchConfig.sorters),
      dateFilters,
    };
    const searchJobRequest = isAllCitiesSearch(parameters)
      ? baseSearchJobRequest
      : {
          ...baseSearchJobRequest,
          keyWords: searchConfig.EMPTY_KEYWORDS,
          equalFilters: clonePlainObjectList(countrySearchConfig.equalFilters),
          containFilters: buildContainFilters(parameters),
          rangeFilters: shouldIncludeHoursPerWeekRangeForRequest(parameters)
            ? [{
                key: searchConfig.HOURS_PER_WEEK_FILTER_KEY,
                range: AMAZON.GRAPHQL.HOURS_PER_WEEK_RANGE,
              }]
            : [],
          orFilters: [],
        };

    if (shouldIncludeConsolidateScheduleForRequest(parameters)) {
      searchJobRequest.consolidateSchedule = searchConfig.CONSOLIDATE_SCHEDULE;
    }

    if (shouldIncludeGeoQueryClauseForRequest(parameters)) {
      searchJobRequest.geoQueryClause = {
        lat: runtimeControls.normalizeNumber(lat),
        lng: runtimeControls.normalizeNumber(lng),
        unit: AMAZON.GRAPHQL.GEO_UNIT,
        distance: resolveDistanceKm(distance, jobSearch),
      };
    }

    return {
      operationName: AMAZON.GRAPHQL.OPERATION_NAME,
      variables: {
        searchJobRequest,
      },
      query: AMAZON.GRAPHQL.QUERY,
    };
  }

  function buildScheduleRequestBody(parameters = {}) {
    const jobId = String(parameters.jobId || '').trim();
    const searchConfig = AMAZON.GRAPHQL.SEARCH_CONFIG;
    const countrySearchConfig = AMAZON.COUNTRY_CONFIG.search || {};
    const today = new Date().toISOString().split('T')[0];
    const dateFilters = [{
      key: searchConfig.FIRST_DAY_FILTER_KEY,
      range: { startDate: today },
    }];
    const searchScheduleRequest = {
      locale: AMAZON.COUNTRY_CONFIG.locale,
      country: AMAZON.COUNTRY_CONFIG.country,
      keyWords: searchConfig.EMPTY_KEYWORDS,
      equalFilters: clonePlainObjectList(countrySearchConfig.equalFilters),
      containFilters: buildContainFilters(parameters),
      rangeFilters: [],
      orFilters: [],
      dateFilters,
      sorters: clonePlainObjectList(countrySearchConfig.sorters),
      pageSize: parameters.pageSize || AMAZON.GRAPHQL.SCHEDULE_PAGE_SIZE,
      jobId,
    };

    return {
      operationName: AMAZON.GRAPHQL.SCHEDULE_OPERATION_NAME,
      variables: {
        searchScheduleRequest,
      },
      query: AMAZON.GRAPHQL.SCHEDULE_QUERY,
    };
  }

  function summarizeFilter(filter = {}) {
    return {
      key: filter.key || null,
      val: Array.isArray(filter.val) ? filter.val : filter.val ?? null,
      range: filter.range || null,
    };
  }

  function summarizeRequestBody(body, parameters = {}, controls = {}) {
    const request = body?.variables?.searchJobRequest || {};
    const geoQueryClause = request.geoQueryClause || null;
    return {
      url: AMAZON.GRAPHQL.URL,
      operationName: body?.operationName || null,
      country: request.country || null,
      locale: request.locale || null,
      pageSize: request.pageSize || null,
      allCitiesSearch: isAllCitiesSearch(parameters),
      selectedCity: parameters.selectedCity || null,
      selectedJobTypes: runtimeControls.normalizeJobTypeList(parameters.jobType),
      cityTagCount: runtimeControls.normalizeStringList(parameters.cityTags).length,
      geoQueryClauseSent: Boolean(geoQueryClause),
      geoQueryClause,
      fallbackDistanceKm: controls.fallbackDistanceKm || '',
      timeoutMs: runtimeControls.normalizePositiveInteger(controls.fetchTimeoutMs),
      consolidateSchedule: request.consolidateSchedule === true,
      equalFilters: clonePlainObjectList(request.equalFilters).map(summarizeFilter),
      containFilters: clonePlainObjectList(request.containFilters).map(summarizeFilter),
      rangeFilters: clonePlainObjectList(request.rangeFilters).map(summarizeFilter),
      dateFilters: clonePlainObjectList(request.dateFilters).map(summarizeFilter),
      sorters: clonePlainObjectList(request.sorters),
    };
  }

  function summarizeScheduleRequestBody(body, controls = {}) {
    const request = body?.variables?.searchScheduleRequest || {};
    return {
      url: AMAZON.GRAPHQL.URL,
      operationName: body?.operationName || null,
      jobId: request.jobId || null,
      country: request.country || null,
      locale: request.locale || null,
      pageSize: request.pageSize || null,
      timeoutMs: runtimeControls.normalizePositiveInteger(controls.fetchTimeoutMs),
      equalFilters: clonePlainObjectList(request.equalFilters).map(summarizeFilter),
      containFilters: clonePlainObjectList(request.containFilters).map(summarizeFilter),
      rangeFilters: clonePlainObjectList(request.rangeFilters).map(summarizeFilter),
      dateFilters: clonePlainObjectList(request.dateFilters).map(summarizeFilter),
      sorters: clonePlainObjectList(request.sorters),
    };
  }

  function getRoutinePollLogOptions(name, summary = {}) {
    const logging = root.AMZ_CONSTANTS.LOGGING || {};
    const selectedJobTypes = Array.isArray(summary.selectedJobTypes)
      ? summary.selectedJobTypes.join(',')
      : '';
    return {
      throttleKey: [
        name,
        summary.allCitiesSearch ? 'all-cities' : summary.selectedCity || 'city',
        summary.cityTagCount ?? 0,
        summary.geoQueryClauseSent ? 'geo' : 'no-geo',
        selectedJobTypes,
        summary.timeoutMs || '',
      ].join('::'),
      throttleMs: Number(logging.POLLING_SUCCESS_THROTTLE_MS || logging.HIGH_FREQUENCY_THROTTLE_MS || 30000),
    };
  }

  function summarizeJobCard(job = {}) {
    return {
      jobId: job.jobId || null,
      jobTitle: job.jobTitle || null,
      city: job.city || null,
      state: job.state || null,
      locationName: job.locationName || null,
      geoClusterDescription: job.geoClusterDescription || null,
      jobType: job.jobType || job.jobTypeL10N || null,
      employmentType: job.employmentTypeL10N || job.employmentType || null,
      pay: job.totalPayRateMaxL10N || job.totalPayRateMinL10N || job.totalPayRateMax || null,
      scheduleCount: job.scheduleCount ?? null,
    };
  }

  function summarizeJobCards(jobCards, limit = 5) {
    return (Array.isArray(jobCards) ? jobCards : [])
      .slice(0, limit)
      .map(summarizeJobCard);
  }

  function summarizeScheduleCard(schedule = {}) {
    return {
      scheduleId: schedule.scheduleId || null,
      jobId: schedule.jobId || null,
      city: schedule.city || null,
      state: schedule.state || null,
      employmentType: schedule.employmentTypeL10N || schedule.employmentType || null,
      scheduleType: schedule.scheduleTypeL10N || schedule.scheduleType || null,
      scheduleText: schedule.scheduleText || null,
      firstDayOnSite: schedule.firstDayOnSiteL10N || schedule.firstDayOnSite || null,
      hoursPerWeek: schedule.hoursPerWeek ?? null,
      pay: schedule.totalPayRateL10N || schedule.totalPayRate || null,
    };
  }

  function summarizeScheduleCards(scheduleCards, limit = 5) {
    return (Array.isArray(scheduleCards) ? scheduleCards : [])
      .slice(0, limit)
      .map(summarizeScheduleCard);
  }

  async function fetchWithTimeout(url, options = {}, controls = {}) {
    const maxJitterMs = runtimeControls.normalizePositiveInteger(AMAZON.GRAPHQL.REQUEST_JITTER_MS);
    const jitterMs = maxJitterMs > 0
      ? Math.floor(Math.random() * (maxJitterMs + 1))
      : 0;
    if (jitterMs > 0) {
      await new Promise(resolve => window.setTimeout(resolve, jitterMs));
    }

    const timeoutMs = runtimeControls.normalizePositiveInteger(controls.fetchTimeoutMs);
    if (!timeoutMs) {
      return fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
      });
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

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

  async function parseResponseJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  function getGraphqlError(payload) {
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      return payload.errors[0] || {};
    }
    return {};
  }

  function getFailureDetails(payload, fallback) {
    const error = getGraphqlError(payload);
    const errorType = error.errorType || payload?.errorType || '';
    const message = error.message || payload?.message || payload?.errorMessage || '';
    return [errorType, message].filter(Boolean).join(': ') || fallback;
  }

  function isWafForbiddenFailure(status, payload, details = '') {
    const error = getGraphqlError(payload);
    const signal = [
      error.errorType,
      error.message,
      payload?.errorType,
      payload?.message,
      details,
    ].filter(Boolean).join(' ');

    return status === 403 && /WAFForbiddenException|WAF.*Forbidden|403 Forbidden/i.test(signal);
  }

  async function fetchJobCards(parameters) {
    const startedAt = Date.now();
    const controls = parameters?.jobSearch && typeof parameters.jobSearch === 'object'
      ? parameters.jobSearch
      : await readJobSearchControls();
    const timeoutMs = runtimeControls.normalizePositiveInteger(controls.fetchTimeoutMs);
    const requestValidationError = getRequestValidationError(parameters, controls);
    if (requestValidationError) {
      log.debug('graphql request skipped: invalid search controls', {
        details: requestValidationError,
        selectedCity: parameters?.selectedCity || null,
        allCitiesSearch: isAllCitiesSearch(parameters),
        hasLatitude: runtimeControls.normalizeNumber(parameters?.lat) !== null,
        hasLongitude: runtimeControls.normalizeNumber(parameters?.lng) !== null,
        distance: parameters?.distance || '',
        fallbackDistanceKm: controls.fallbackDistanceKm || '',
      });
      return {
        state: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        jobCards: [],
        details: requestValidationError,
        isAuthError: false,
      };
    }

    try {
      const requestBody = buildRequestBody({ ...parameters, jobSearch: controls });
      const requestSummary = summarizeRequestBody(requestBody, parameters, controls);
      log.debug(
        'graphql request prepared',
        requestSummary,
        getRoutinePollLogOptions('graphql-request-prepared', requestSummary)
      );
      const response = await fetchWithTimeout(AMAZON.GRAPHQL.URL, {
        method: 'POST',
        headers: {
          ...AMAZON.GRAPHQL.REQUEST_HEADERS,
          Authorization: getAuthorizationHeader(),
          country: AMAZON.COUNTRY_CONFIG.country,
        },
        body: JSON.stringify(requestBody),
      }, controls);

      const durationMs = Date.now() - startedAt;
      const responseSummary = {
        status: response.status,
        ok: response.ok === true,
        durationMs,
      };
      log.debug(
        'graphql response received',
        responseSummary,
        response.ok ? getRoutinePollLogOptions('graphql-response-ok', requestSummary) : undefined
      );
      if (!response.ok) {
        const payload = await parseResponseJson(response);
        const details = getFailureDetails(payload, 'Request returned a non-success HTTP status.');
        const isWafBlocked = isWafForbiddenFailure(response.status, payload, details);
        log.debug('graphql request failed', {
          status: response.status,
          durationMs,
          details: isWafBlocked
            ? 'Amazon WAF temporarily blocked the GraphQL request.'
            : details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        });
        return {
          state: 'failed',
          status: response.status,
          durationMs,
          jobCards: [],
          details: isWafBlocked
            ? 'Amazon WAF temporarily blocked the GraphQL request. Polling will retry after a short backoff.'
            : details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        };
      }

      const payload = await parseResponseJson(response);
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const details = getFailureDetails(payload, 'GraphQL returned errors.');
        const isWafBlocked = isWafForbiddenFailure(response.status, payload, details);
        log.debug('graphql response contained errors', {
          status: response.status,
          durationMs,
          details,
          errorCount: payload.errors.length,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        });
        return {
          state: 'failed',
          status: response.status,
          durationMs,
          jobCards: [],
          details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        };
      }

      const jobCards = payload?.data?.searchJobCardsByLocation?.jobCards || [];
      const successSummary = {
        status: response.status,
        durationMs,
        jobCount: jobCards.length,
        nextToken: payload?.data?.searchJobCardsByLocation?.nextToken || null,
        sampleJobs: summarizeJobCards(jobCards),
      };
      log.debug(
        'graphql request succeeded',
        successSummary,
        jobCards.length === 0 ? getRoutinePollLogOptions('graphql-success-empty', requestSummary) : undefined
      );
      return {
        state: 'success',
        status: response.status,
        durationMs,
        jobCards,
        details: 'Jobs received: ' + jobCards.length,
        isAuthError: false,
      };
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      log.debug('graphql request exception', {
        timedOut,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        errorName: error?.name || null,
        message: timedOut
          ? 'Request timed out after ' + timeoutMs + ' ms.'
          : (error?.message || 'Unexpected error while calling API.'),
      });
      return {
        state: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        jobCards: [],
        details: timedOut
          ? 'Request timed out after ' + timeoutMs + ' ms.'
          : (error?.message || 'Unexpected error while calling API.'),
        isAuthError: isAuthRelatedFailure(null, error?.message),
        error,
      };
    }
  }

  async function fetchScheduleCards(parameters = {}) {
    const startedAt = Date.now();
    const controls = parameters?.jobSearch && typeof parameters.jobSearch === 'object'
      ? parameters.jobSearch
      : await readJobSearchControls();
    const timeoutMs = runtimeControls.normalizePositiveInteger(controls.fetchTimeoutMs);
    const jobId = String(parameters.jobId || '').trim();
    if (!jobId) {
      return {
        state: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        scheduleCards: [],
        nextToken: null,
        details: 'Missing jobId for schedule search.',
        isAuthError: false,
        isWafBlocked: false,
      };
    }

    try {
      const requestBody = buildScheduleRequestBody({ ...parameters, jobId });
      const requestSummary = summarizeScheduleRequestBody(requestBody, controls);
      log.debug('schedule graphql request prepared', requestSummary);
      const response = await fetchWithTimeout(AMAZON.GRAPHQL.URL, {
        method: 'POST',
        headers: {
          ...AMAZON.GRAPHQL.REQUEST_HEADERS,
          Authorization: getAuthorizationHeader(),
          country: AMAZON.COUNTRY_CONFIG.country,
        },
        body: JSON.stringify(requestBody),
      }, controls);

      const durationMs = Date.now() - startedAt;
      const responseSummary = {
        status: response.status,
        ok: response.ok === true,
        durationMs,
        jobId,
      };
      log.debug('schedule graphql response received', responseSummary);
      if (!response.ok) {
        const payload = await parseResponseJson(response);
        const details = getFailureDetails(payload, 'Schedule request returned a non-success HTTP status.');
        const isWafBlocked = isWafForbiddenFailure(response.status, payload, details);
        log.debug('schedule graphql request failed', {
          status: response.status,
          durationMs,
          details: isWafBlocked
            ? 'Amazon WAF temporarily blocked the schedule GraphQL request.'
            : details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
          jobId,
        });
        return {
          state: 'failed',
          status: response.status,
          durationMs,
          scheduleCards: [],
          nextToken: null,
          details: isWafBlocked
            ? 'Amazon WAF temporarily blocked the schedule GraphQL request. Polling will retry after a short backoff.'
            : details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        };
      }

      const payload = await parseResponseJson(response);
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const details = getFailureDetails(payload, 'Schedule GraphQL returned errors.');
        const isWafBlocked = isWafForbiddenFailure(response.status, payload, details);
        log.debug('schedule graphql response contained errors', {
          status: response.status,
          durationMs,
          details,
          errorCount: payload.errors.length,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
          jobId,
        });
        return {
          state: 'failed',
          status: response.status,
          durationMs,
          scheduleCards: [],
          nextToken: null,
          details,
          isAuthError: !isWafBlocked && isAuthRelatedFailure(response.status, details),
          isWafBlocked,
        };
      }

      const scheduleResult = payload?.data?.searchScheduleCards || {};
      const scheduleCards = Array.isArray(scheduleResult.scheduleCards)
        ? scheduleResult.scheduleCards
        : [];
      const successSummary = {
        status: response.status,
        durationMs,
        jobId,
        scheduleCount: scheduleCards.length,
        nextToken: scheduleResult.nextToken || null,
        sampleSchedules: summarizeScheduleCards(scheduleCards),
      };
      log.debug('schedule graphql request succeeded', successSummary);
      return {
        state: 'success',
        status: response.status,
        durationMs,
        scheduleCards,
        nextToken: scheduleResult.nextToken || null,
        details: 'Schedules received: ' + scheduleCards.length,
        isAuthError: false,
        isWafBlocked: false,
      };
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      log.debug('schedule graphql request exception', {
        timedOut,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        errorName: error?.name || null,
        message: timedOut
          ? 'Request timed out after ' + timeoutMs + ' ms.'
          : (error?.message || 'Unexpected error while calling schedule API.'),
        jobId,
      });
      return {
        state: 'failed',
        status: null,
        durationMs: Date.now() - startedAt,
        scheduleCards: [],
        nextToken: null,
        details: timedOut
          ? 'Request timed out after ' + timeoutMs + ' ms.'
          : (error?.message || 'Unexpected error while calling schedule API.'),
        isAuthError: isAuthRelatedFailure(null, error?.message),
        isWafBlocked: false,
        error,
      };
    }
  }

  root.AMZ_JOB_SEARCH = Object.freeze({
    getAuthorizationHeader,
    buildRequestBody,
    buildScheduleRequestBody,
    summarizeRequestBody,
    summarizeScheduleRequestBody,
    fetchJobCards,
    fetchScheduleCards,
    getJobTypeContainFilter,
    getRequestValidationError,
    isAllCitiesSearch,
    isAuthRelatedFailure,
    readJobSearchControls,
    shouldIncludeConsolidateSchedule,
    shouldIncludeConsolidateScheduleForRequest,
    shouldIncludeGeoQueryClause,
    shouldIncludeGeoQueryClauseForRequest,
    shouldIncludeHoursPerWeekRange,
    shouldIncludeHoursPerWeekRangeForRequest,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
