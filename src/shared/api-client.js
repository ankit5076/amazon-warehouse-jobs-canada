/* Backend API client for license checks, defaults, and Telegram notification relays. */
(function (root) {
  'use strict';

  if (root.AMZ_API) return;

  const { AMAZON, BACKEND, MESSAGE_ACTIONS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const CANONICAL_JOB_TYPES = new Set(AMAZON.JOB_TYPE_VALUES || []);
  const API_ERROR_CODES = Object.freeze({
    MISSING_OPERATOR_USERNAME: 'missing_operator_username',
    MISSING_ADMIN_SESSION: 'missing_admin_session',
    INVALID_ADMIN_SESSION: 'invalid_admin_session',
  });
  const OPERATOR_REQUIRED_ENDPOINTS = Object.freeze([
    BACKEND.ENDPOINTS.CLIENTS,
  ]);
  const RUNTIME_POLICY_CACHE_VERSION = 2;
  const RUNTIME_POLICY_CACHE_TTL_MS = 60 * 60 * 1000;
  const CLIENT_STATUSES_EXCLUDED_FROM_PICKER = new Set(['BOOKED', 'SETTLED']);
  const backendRequests = new Map();
  const runtimePolicyRequests = new Map();

  function isServiceWorkerContext() {
    return Boolean(
      root.AMZ_IS_SERVICE_WORKER === true ||
      (typeof ServiceWorkerGlobalScope !== 'undefined' && root instanceof ServiceWorkerGlobalScope)
    );
  }

  function canProxyThroughServiceWorker() {
    return Boolean(
      !isServiceWorkerContext() &&
      root.chrome?.runtime?.id &&
      typeof root.chrome.runtime.sendMessage === 'function'
    );
  }

  function isAllowedBackendPath(path) {
    const value = String(path || '');
    return Object.values(BACKEND.ENDPOINTS).some(endpoint => value === endpoint || value.startsWith(endpoint + '?'));
  }

  function normalizeOperatorUsername(value) {
    return String(value || '').trim();
  }

  function getAuthBaseUrl() {
    return String(BACKEND.BASE_URL || '').replace(/\/amazon-shifts\/?$/, '');
  }

  function normalizeAdminSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sessionToken = String(raw.session_token || '').trim();
    const username = normalizeOperatorUsername(raw.username);
    if (!sessionToken || !username) return null;
    return {
      admin_id: raw.admin_id || null,
      username,
      phone_number: raw.phone_number || null,
      email_address: raw.email_address || null,
      session_token: sessionToken,
    };
  }

  async function getStoredOperatorUsername(options = {}) {
    const account = root.AMZ_ACCOUNT;
    if (account && typeof account.getStoredOperatorUsername === 'function') {
      return normalizeOperatorUsername(await account.getStoredOperatorUsername(options));
    }

    const data = await storage.getLocal([
      STORAGE_KEYS.OPERATOR_USERNAME,
      STORAGE_KEYS.USERNAME,
    ]);
    return normalizeOperatorUsername(
      data[STORAGE_KEYS.OPERATOR_USERNAME] ||
      data[STORAGE_KEYS.USERNAME]
    );
  }

  function createApiError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isMissingOperatorUsernameError(error) {
    return error?.code === API_ERROR_CODES.MISSING_OPERATOR_USERNAME;
  }

  function isMissingAdminSessionError(error) {
    return error?.code === API_ERROR_CODES.MISSING_ADMIN_SESSION;
  }

  function isAdminSessionUnauthorizedError(error) {
    return error?.code === API_ERROR_CODES.MISSING_ADMIN_SESSION ||
      error?.code === API_ERROR_CODES.INVALID_ADMIN_SESSION ||
      error?.status === 401;
  }

  async function requireOperatorUsername(options = {}) {
    const username = normalizeOperatorUsername(
      options.operatorUsername || await getStoredOperatorUsername()
    );
    if (username) return username;

    throw createApiError(
      API_ERROR_CODES.MISSING_OPERATOR_USERNAME,
      'Operator username is required before using the extension.'
    );
  }

  async function getStoredAdminSession() {
    const data = await storage.getLocal([
      STORAGE_KEYS.OPERATOR_USERNAME,
      STORAGE_KEYS.ADMIN_SESSION_TOKEN,
    ]);
    const username = normalizeOperatorUsername(data[STORAGE_KEYS.OPERATOR_USERNAME]);
    const sessionToken = String(data[STORAGE_KEYS.ADMIN_SESSION_TOKEN] || '').trim();
    return username && sessionToken
      ? { username, session_token: sessionToken }
      : null;
  }

  async function getStoredAdminSessionToken() {
    return (await getStoredAdminSession())?.session_token || '';
  }

  async function setStoredAdminSession(session) {
    const normalized = normalizeAdminSession(session);
    if (!normalized) {
      throw createApiError(API_ERROR_CODES.INVALID_ADMIN_SESSION, 'Admin login response did not include a usable session.');
    }
    await storage.setLocal({
      [STORAGE_KEYS.OPERATOR_USERNAME]: normalized.username,
      [STORAGE_KEYS.ADMIN_SESSION_TOKEN]: normalized.session_token,
    });
    await storage.removeLocal(STORAGE_KEYS.USERNAME);
    return normalized;
  }

  async function clearAdminSession(options = {}) {
    const updates = {
      [STORAGE_KEYS.ADMIN_SESSION_TOKEN]: '',
    };
    if (options.clearUsername === true) {
      updates[STORAGE_KEYS.OPERATOR_USERNAME] = '';
    }
    await storage.setLocal(updates);
    await clearRuntimePolicyCache();
  }

  async function requireAdminSessionToken(options = {}) {
    const token = String(options.sessionToken || await getStoredAdminSessionToken()).trim();
    if (token) return token;

    throw createApiError(
      API_ERROR_CODES.MISSING_ADMIN_SESSION,
      'Admin username and password are required before using the extension.'
    );
  }

  async function addAdminSessionHeader(init = {}, options = {}) {
    const token = await requireAdminSessionToken(options);
    const normalized = normalizeInit(init);
    return {
      ...normalized,
      headers: {
        ...(normalized.headers || {}),
        [BACKEND.AUTH_HEADER]: token,
      },
    };
  }

  async function handleUnauthorizedAdminSession(result) {
    return result;
  }

  function isOperatorRequiredBackendPath(path) {
    const value = String(path || '');
    return OPERATOR_REQUIRED_ENDPOINTS.some(endpoint => value === endpoint || value.startsWith(endpoint + '?'));
  }

  function getBackendRequestMethod(init = {}) {
    return String(init?.method || 'GET').trim().toUpperCase() || 'GET';
  }

  function isRuntimePolicyBackendPath(path) {
    const value = String(path || '');
    return value === BACKEND.ENDPOINTS.RUNTIME || value.startsWith(BACKEND.ENDPOINTS.RUNTIME + '?');
  }

  function getBackendRequestDedupeKey(path, init = {}) {
    const method = getBackendRequestMethod(init);
    if (method !== 'GET' || !isRuntimePolicyBackendPath(path)) return '';
    return `${method} ${String(path || '')}`;
  }

  function normalizeInit(init = {}) {
    const normalized = { ...init };
    if (normalized.headers && typeof normalized.headers.forEach === 'function') {
      const headers = {};
      normalized.headers.forEach((value, key) => {
        headers[key] = value;
      });
      normalized.headers = headers;
    }
    return normalized;
  }

  async function sendBackendRequestToServiceWorker(path, init) {
    const result = await root.AMZ_MESSAGING.sendRuntimeMessage({
      action: MESSAGE_ACTIONS.BACKEND_REQUEST,
      path,
      init: normalizeInit(init),
    });
    if (!result.ok) {
      return {
        ok: false,
        status: 0,
        error: result.error || 'service worker unavailable',
      };
    }
    return result.data || { ok: false, status: 0, error: 'empty service worker response' };
  }

  async function runBackendRequest(path, init) {
    if (canProxyThroughServiceWorker()) {
      return sendBackendRequestToServiceWorker(path, init);
    }

    try {
      const response = await fetch(BACKEND.BASE_URL + path, normalizeInit(init));
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, error: error?.message || 'fetch failed' };
    }
  }

  async function backendRequest(path, init, options = {}) {
    if (!isAllowedBackendPath(path)) {
      return { ok: false, status: 0, error: 'backend path not allowed' };
    }

    if (options.requiresOperatorUsername === true || isOperatorRequiredBackendPath(path)) {
      await requireOperatorUsername(options);
    }

    let protectedInit;
    try {
      protectedInit = await addAdminSessionHeader(init, options);
    } catch (error) {
      return { ok: false, status: 401, error: error?.message || 'admin session missing', code: error?.code };
    }

    const dedupeKey = getBackendRequestDedupeKey(path, protectedInit);
    if (!dedupeKey) return handleUnauthorizedAdminSession(await runBackendRequest(path, protectedInit));
    if (backendRequests.has(dedupeKey)) {
      return backendRequests.get(dedupeKey);
    }

    const request = runBackendRequest(path, protectedInit).then(handleUnauthorizedAdminSession);
    backendRequests.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      backendRequests.delete(dedupeKey);
    }
  }

  async function fetchJson(path, init, options = {}) {
    const result = await backendRequest(path, init, options);
    if (!result.ok) {
      return null;
    }
    return result.body;
  }

  async function apiLoginAdmin(credentials = {}) {
    const username = normalizeOperatorUsername(credentials.username);
    const password = String(credentials.password || '');
    if (!username || !password) {
      throw createApiError(
        API_ERROR_CODES.MISSING_ADMIN_SESSION,
        'Admin username and password are required.'
      );
    }

    try {
      const response = await fetch(getAuthBaseUrl() + BACKEND.AUTH_ENDPOINTS.LOGIN, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw createApiError(
          API_ERROR_CODES.INVALID_ADMIN_SESSION,
          body?.message || 'Admin login failed.'
        );
      }
      return setStoredAdminSession(body);
    } catch (error) {
      if (error?.code) throw error;
      throw createApiError(
        API_ERROR_CODES.INVALID_ADMIN_SESSION,
        error?.message || 'Admin login failed.'
      );
    }
  }

  async function apiCheckLicense() {
    return fetchJson(BACKEND.ENDPOINTS.LICENSE_CHECK, { method: 'GET' });
  }

  async function apiGetDefaults() {
    return fetchJson(BACKEND.ENDPOINTS.DEFAULTS, { method: 'GET' });
  }

  async function apiGetClients() {
    const excludedStatuses = Array.from(CLIENT_STATUSES_EXCLUDED_FROM_PICKER).join(',');
    const path = `${BACKEND.ENDPOINTS.CLIENTS}?excludeStatuses=${encodeURIComponent(excludedStatuses)}`;
    const body = await fetchJson(path, { method: 'GET' }, {
      requiresOperatorUsername: true,
    });
    return Array.isArray(body)
      ? body.map(normalizeClient).filter(Boolean).filter(isSelectableClient)
      : null;
  }

  async function apiGetRuntimePolicy(username) {
    const value = String(username || '').trim();
    if (!value) return null;
    return fetchJson(
      BACKEND.ENDPOINTS.RUNTIME,
      { method: 'GET' }
    );
  }

  async function apiSendTelegramNotification(payload) {
    const result = await backendRequest(BACKEND.ENDPOINTS.TELEGRAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!result.ok) {
      return { delivered: false, error: result.error || 'http ' + result.status };
    }
    return result.body;
  }

  async function apiPostApplicationAttempt(payload) {
    const result = await backendRequest(BACKEND.ENDPOINTS.APPLICATION_ATTEMPTS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        status: result.status || 0,
        error: result.error || 'http ' + result.status,
      };
    }
    return {
      ok: true,
      status: result.status || 200,
      body: result.body || null,
    };
  }

  async function apiGetScheduleCooldown({ country, jobId, scheduleId, cooldownMs } = {}) {
    const params = new URLSearchParams();
    if (country) params.set('country', country);
    if (jobId) params.set('jobId', jobId);
    if (scheduleId) params.set('scheduleId', scheduleId);
    if (cooldownMs) params.set('cooldownMs', String(cooldownMs));
    if (!params.get('jobId') || !params.get('scheduleId')) return null;
    return fetchJson(
      `${BACKEND.ENDPOINTS.SCHEDULE_COOLDOWN}?${params.toString()}`,
      { method: 'GET' }
    );
  }

  function emptyDefaults() {
    return {
      cityCoordinates: {},
      defaultCityTags: [],
    };
  }

  function normalizeListValue(value) {
    if (value === null || typeof value === 'undefined') return '';
    if (typeof value === 'object' || typeof value === 'function') return '';
    const normalized = String(value ?? '').trim();
    const lower = normalized.toLowerCase();
    return !normalized || lower === 'null' || lower === 'undefined' ? '' : normalized;
  }

  function pushUnique(list, seen, value) {
    const normalized = normalizeListValue(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  }

  function normalizeStringList(rawValues) {
    const values = [];
    const seen = new Set();
    const source = Array.isArray(rawValues)
      ? rawValues
      : (typeof rawValues === 'undefined' || rawValues === null ? [] : [rawValues]);
    source.forEach(value => {
      pushUnique(values, seen, value);
    });
    return values;
  }

  function normalizeJobTypeValue(value) {
    const normalized = normalizeListValue(value)
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (!normalized) return '';
    if (normalized === 'FLEXIBLE') return 'FLEX_TIME';
    return CANONICAL_JOB_TYPES.has(normalized) ? normalized : '';
  }

  function normalizeJobTypeList(rawValues) {
    const values = [];
    const seen = new Set();
    const source = Array.isArray(rawValues)
      ? rawValues
      : (typeof rawValues === 'undefined' || rawValues === null ? [] : [rawValues]);
    source.forEach(value => {
      String(value ?? '').split(/[;,]/).forEach(part => {
        const normalized = normalizeJobTypeValue(part);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        values.push(normalized);
      });
    });
    return values;
  }

  function normalizeClientStatus(value) {
    return normalizeListValue(value)
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
  }

  function isSelectableClient(client) {
    const status = normalizeClientStatus(client?.status);
    return !CLIENT_STATUSES_EXCLUDED_FROM_PICKER.has(status);
  }

  function normalizeClient(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id === null || typeof raw.id === 'undefined' ? '' : String(raw.id).trim();
    const name = normalizeListValue(raw.name);
    const emailid = normalizeListValue(raw.emailid);
    const pin = normalizeListValue(raw.pin);
    const status = normalizeClientStatus(raw.status);
    const jobType = normalizeJobTypeList(raw.job_type || raw.jobType);
    return {
      ...raw,
      id,
      name,
      emailid,
      pin,
      status,
      location: normalizeStringList(raw.location),
      jobType,
      job_type: jobType,
      createdAt: normalizeListValue(raw.created_at || raw.createdAt),
      updatedAt: normalizeListValue(raw.updated_at || raw.updatedAt),
    };
  }

  function normalizeDefaults(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const cityCoordinates = {};
    Object.entries(raw.city_coordinates || {}).forEach(([city, coordinates]) => {
      const cityName = normalizeListValue(city);
      const lat = coordinates?.lat;
      const lng = coordinates?.lng;
      if (cityName && typeof lat === 'number' && typeof lng === 'number') {
        cityCoordinates[cityName] = { lat, lng };
      }
    });

    return {
      cityCoordinates,
      defaultCityTags: normalizeStringList(raw.default_city_tags),
    };
  }

  function normalizeOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return [];
    const seen = new Set();
    return rawOptions
      .map(option => {
        if (typeof option === 'string' || typeof option === 'number') {
          return normalizeListValue(option);
        }
        if (!option || typeof option !== 'object') return null;
        const value = normalizeListValue(option.value);
        if (!value) return null;
        return {
          value,
          label: normalizeListValue(option.label) || value,
        };
      })
      .filter(option => {
        if (!option) return false;
        const key = typeof option === 'string' ? option : option.value;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function normalizeJobTypeOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return [];
    const seen = new Set();
    return rawOptions
      .map(option => {
        const value = typeof option === 'object' && option !== null
          ? normalizeJobTypeValue(option.value)
          : normalizeJobTypeValue(option);
        if (!value || seen.has(value)) return null;
        seen.add(value);
        return value;
      })
      .filter(Boolean);
  }

  function normalizeDefaultInputs(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      selectedCity: normalizeListValue(source.selected_city),
      distance: normalizeListValue(source.distance),
      jobType: normalizeJobTypeList(source.job_type),
    };
  }

  function normalizeMinMs(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalizeFetchInterval(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      defaultUnit: normalizeListValue(source.default_unit),
      defaultSValue: normalizeListValue(source.default_s_value || source.default_value),
      defaultMsValue: normalizeMinMs(source.default_ms_value || source.min_ms),
    };
  }

  function normalizeJobSearch(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      fallbackDistanceKm: normalizeListValue(source.fallback_distance_km),
      fetchTimeoutMs: normalizeMinMs(source.fetch_timeout_ms),
    };
  }

  function normalizePageRefresh(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      jobSearchIntervalMs: normalizeMinMs(source.job_search_interval_ms),
    };
  }

  function normalizeRuntimePolicy(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.valid !== true) {
      return {
        valid: false,
        serverTime: raw.server_time || null,
      };
    }

    const controls = raw.controls && typeof raw.controls === 'object' ? raw.controls : {};
    const defaults = normalizeDefaults({
      city_coordinates: controls.city_coordinates,
      default_city_tags: controls.default_city_tags,
    }) || emptyDefaults();
    const features = controls.features || {};

    return {
      valid: true,
      serverTime: raw.server_time || null,
      controls: {
        cityCoordinates: defaults.cityCoordinates,
        defaultCityTags: defaults.defaultCityTags,
        cityOptions: normalizeOptions(controls.city_options),
        distanceOptions: normalizeOptions(controls.distance_options),
        jobTypeOptions: normalizeJobTypeOptions(controls.job_type_options),
        defaultInputs: normalizeDefaultInputs(controls.default_inputs),
        fetchInterval: normalizeFetchInterval(controls.fetch_interval),
        jobSearch: normalizeJobSearch(controls.job_search),
        pageRefresh: normalizePageRefresh(controls.page_refresh),
        features: {
          polling: features.polling === true,
          scheduleAutomation: features.schedule_automation === true,
          directApplication: features.direct_application === true,
          telegram: features.telegram === true,
        },
      },
    };
  }

  function normalizeRuntimeUsername(value) {
    return String(value || '').trim();
  }

  function getRuntimeCacheKey(username) {
    return normalizeRuntimeUsername(username).toLowerCase();
  }

  function isFreshRuntimePolicyCache(entry, username, now = Date.now()) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.version !== RUNTIME_POLICY_CACHE_VERSION) return false;
    if (entry.usernameKey !== getRuntimeCacheKey(username)) return false;
    if (!entry.policy || typeof entry.policy !== 'object') return false;
    const cachedAt = Number(entry.cachedAt || 0);
    return Number.isFinite(cachedAt) &&
      cachedAt > 0 &&
      now - cachedAt < RUNTIME_POLICY_CACHE_TTL_MS;
  }

  async function readRuntimePolicyCache(username) {
    const items = await storage.getLocal(BACKEND.RUNTIME_CACHE_KEY);
    const entry = items?.[BACKEND.RUNTIME_CACHE_KEY];
    if (!isFreshRuntimePolicyCache(entry, username)) return null;
    return {
      ...entry.policy,
      username: normalizeRuntimeUsername(entry.policy.username || username),
      cache: {
        hit: true,
        cachedAt: entry.cachedAt,
        expiresAt: entry.cachedAt + RUNTIME_POLICY_CACHE_TTL_MS,
      },
    };
  }

  async function writeRuntimePolicyCache(policy, username) {
    if (!policy || typeof policy !== 'object') return;
    await storage.setLocal({
      [BACKEND.RUNTIME_CACHE_KEY]: {
        username: normalizeRuntimeUsername(policy.username || username),
        version: RUNTIME_POLICY_CACHE_VERSION,
        usernameKey: getRuntimeCacheKey(policy.username || username),
        cachedAt: Date.now(),
        policy,
      },
    });
  }

  async function readDefaultsFromSession() {
    const items = await storage.getSession(BACKEND.DEFAULTS_CACHE_KEY);
    return items?.[BACKEND.DEFAULTS_CACHE_KEY] || null;
  }

  async function writeDefaultsToSession(value) {
    await storage.setSession({ [BACKEND.DEFAULTS_CACHE_KEY]: value });
  }

  async function loadDefaults() {
    const cached = await readDefaultsFromSession();
    if (cached?.cityCoordinates && Array.isArray(cached.defaultCityTags)) {
      return cached;
    }

    const fresh = normalizeDefaults(await apiGetDefaults());
    if (fresh) {
      await writeDefaultsToSession(fresh);
      return fresh;
    }

    return emptyDefaults();
  }

  async function clearDefaultsCache() {
    await storage.removeSession(BACKEND.DEFAULTS_CACHE_KEY);
  }

  async function loadRuntimePolicy(username, options = {}) {
    const resolvedUsername = normalizeRuntimeUsername(username);
    if (!resolvedUsername) return null;

    if (options.allowCache !== false) {
      const cached = await readRuntimePolicyCache(resolvedUsername);
      if (cached) return cached;
    }

    const requestKey = getRuntimeCacheKey(resolvedUsername);
    if (runtimePolicyRequests.has(requestKey)) {
      return runtimePolicyRequests.get(requestKey);
    }

    const request = (async () => {
      const normalized = normalizeRuntimePolicy(await apiGetRuntimePolicy(resolvedUsername));
      if (!normalized) return null;
      const policy = { ...normalized, username: resolvedUsername };
      await writeRuntimePolicyCache(policy, resolvedUsername);
      return policy;
    })();

    runtimePolicyRequests.set(requestKey, request);
    try {
      return await request;
    } finally {
      runtimePolicyRequests.delete(requestKey);
    }
  }

  async function getCachedRuntimePolicy(username) {
    const resolvedUsername = normalizeRuntimeUsername(username);
    if (!resolvedUsername) return null;
    return readRuntimePolicyCache(resolvedUsername);
  }

  async function clearRuntimePolicyCache() {
    runtimePolicyRequests.clear();
    await storage.removeLocal(BACKEND.RUNTIME_CACHE_KEY);
  }

  root.AMZ_API = Object.freeze({
    BASE_URL: BACKEND.BASE_URL,
    ERROR_CODES: API_ERROR_CODES,
    DEFAULTS_CACHE_KEY: BACKEND.DEFAULTS_CACHE_KEY,
    RUNTIME_CACHE_KEY: BACKEND.RUNTIME_CACHE_KEY,
    RUNTIME_POLICY_CACHE_VERSION,
    RUNTIME_POLICY_CACHE_TTL_MS,
    FALLBACK_DEFAULTS: BACKEND.FALLBACK_DEFAULTS,
    backendRequest,
    apiLoginAdmin,
    getStoredAdminSession,
    setStoredAdminSession,
    clearAdminSession,
    requireAdminSessionToken,
    requireOperatorUsername,
    isMissingOperatorUsernameError,
    isMissingAdminSessionError,
    isAdminSessionUnauthorizedError,
    apiCheckLicense,
    apiGetRuntimePolicy,
    apiGetDefaults,
    apiGetClients,
    apiSendTelegramNotification,
    apiPostApplicationAttempt,
    apiGetScheduleCooldown,
    loadDefaults,
    loadRuntimePolicy,
    getCachedRuntimePolicy,
    clearDefaultsCache,
    clearRuntimePolicyCache,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
