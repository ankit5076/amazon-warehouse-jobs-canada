/* Domain-level app state. Keep Chrome storage keys and shapes centralized here. */
(function (root) {
  'use strict';

  if (root.AMZ_STATE) return;

  const { AUTH_PROBE, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const runtimeControls = root.AMZ_RUNTIME_CONTROLS;
  const cityTags = root.AMZ_CITY_TAGS;

  const POLLING_SETTINGS_KEYS = Object.freeze([
    STORAGE_KEYS.SELECTED_CITY,
    STORAGE_KEYS.ALL_CITIES_SELECTED,
    STORAGE_KEYS.LATITUDE,
    STORAGE_KEYS.LONGITUDE,
    STORAGE_KEYS.DISTANCE,
    STORAGE_KEYS.JOB_TYPE,
    STORAGE_KEYS.CITY_TAGS,
    STORAGE_KEYS.ACTIVE,
    STORAGE_KEYS.AUTH_PROBE_STATUS,
    STORAGE_KEYS.FETCH_INTERVAL_VALUE,
    STORAGE_KEYS.FETCH_INTERVAL_UNIT,
    STORAGE_KEYS.FETCH_INTERVAL_MIN_MS,
    STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM,
    STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS,
    STORAGE_KEYS.USE_DIRECT_APPLICATION,
  ]);

  const RUNTIME_SYNC_KEYS = Object.freeze([
    STORAGE_KEYS.SELECTED_CITY,
    STORAGE_KEYS.ALL_CITIES_SELECTED,
    STORAGE_KEYS.LATITUDE,
    STORAGE_KEYS.LONGITUDE,
    STORAGE_KEYS.DISTANCE,
    STORAGE_KEYS.JOB_TYPE,
    STORAGE_KEYS.CITY_TAGS,
    STORAGE_KEYS.FETCH_INTERVAL_VALUE,
    STORAGE_KEYS.FETCH_INTERVAL_UNIT,
    STORAGE_KEYS.FETCH_INTERVAL_MIN_MS,
    STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM,
    STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS,
    STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS,
  ]);

  const POPUP_FORM_KEYS = Object.freeze([
    STORAGE_KEYS.SELECTED_CITY,
    STORAGE_KEYS.ALL_CITIES_SELECTED,
    STORAGE_KEYS.DISTANCE,
    STORAGE_KEYS.JOB_TYPE,
    STORAGE_KEYS.ACTIVE,
    STORAGE_KEYS.CITY_TAGS,
    STORAGE_KEYS.FETCH_INTERVAL_VALUE,
    STORAGE_KEYS.FETCH_INTERVAL_UNIT,
    STORAGE_KEYS.FETCH_INTERVAL_MIN_MS,
    STORAGE_KEYS.LOG_MODE,
    STORAGE_KEYS.USE_DIRECT_APPLICATION,
  ]);

  function normalizeAuthProbeStatus(value) {
    return Object.values(AUTH_PROBE.STATUSES).includes(value)
      ? value
      : AUTH_PROBE.STATUSES.UNKNOWN;
  }

  function hasClientId(value) {
    return normalizeClientText(value).length > 0;
  }

  async function getSelectedClientId() {
    const stored = await storage.getLocal(STORAGE_KEYS.SELECTED_CLIENT_ID);
    return normalizeClientText(stored[STORAGE_KEYS.SELECTED_CLIENT_ID]);
  }

  async function hasSelectedClient() {
    return true;
  }

  async function setActive(active) {
    const requestedActive = active === true;
    await storage.setLocal({ [STORAGE_KEYS.ACTIVE]: requestedActive });
    return requestedActive;
  }

  async function getActive() {
    const stored = await storage.getLocal(STORAGE_KEYS.ACTIVE);
    return stored[STORAGE_KEYS.ACTIVE] === true;
  }

  async function getAuthProbeStatus() {
    const stored = await storage.getLocal(STORAGE_KEYS.AUTH_PROBE_STATUS);
    return stored[STORAGE_KEYS.AUTH_PROBE_STATUS] || '';
  }

  async function persistAuthProbeStatus(status, metadata = {}) {
    await storage.setLocal({
      [STORAGE_KEYS.AUTH_PROBE_STATUS]: normalizeAuthProbeStatus(status),
      [STORAGE_KEYS.AUTH_PROBE_UPDATED_AT]: Date.now(),
      [STORAGE_KEYS.AUTH_PROBE_HTTP_STATUS]:
        typeof metadata.httpStatus === 'number' ? metadata.httpStatus : null,
      [STORAGE_KEYS.AUTH_PROBE_DETAIL]: metadata.detail || '',
    });
  }

  async function getPopupFormState() {
    return storage.getLocal(POPUP_FORM_KEYS);
  }

  async function getPollingSettings() {
    return storage.getLocal(POLLING_SETTINGS_KEYS);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  async function setCitySelection(city, coordinates, options = {}) {
    const updates = {
      [STORAGE_KEYS.SELECTED_CITY]: city || '',
      [STORAGE_KEYS.LATITUDE]: coordinates?.lat ?? null,
      [STORAGE_KEYS.LONGITUDE]: coordinates?.lng ?? null,
    };
    if (hasOwn(options, 'allCitiesSelected')) {
      updates[STORAGE_KEYS.ALL_CITIES_SELECTED] = options.allCitiesSelected === true;
    } else if (city) {
      updates[STORAGE_KEYS.ALL_CITIES_SELECTED] = false;
    }
    await storage.setLocal(updates);
  }

  async function setAllCitiesSelection(tags) {
    await storage.setLocal({
      [STORAGE_KEYS.SELECTED_CITY]: '',
      [STORAGE_KEYS.ALL_CITIES_SELECTED]: true,
      [STORAGE_KEYS.LATITUDE]: null,
      [STORAGE_KEYS.LONGITUDE]: null,
      [STORAGE_KEYS.CITY_TAGS]: Array.isArray(tags) ? tags : [],
    });
  }

  async function setDistance(distance) {
    await storage.setLocal({ [STORAGE_KEYS.DISTANCE]: distance || '' });
  }

  async function setJobType(jobType) {
    await storage.setLocal({ [STORAGE_KEYS.JOB_TYPE]: runtimeControls.normalizeJobTypeList(jobType) });
  }

  async function setFetchIntervalValue(value) {
    await storage.setLocal({ [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: value || '' });
  }

  async function setFetchInterval(unit, value) {
    await storage.setLocal({
      [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: unit || '',
      [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: value || '',
    });
  }

  async function getCityTags() {
    const stored = await storage.getLocal(STORAGE_KEYS.CITY_TAGS);
    return Array.isArray(stored[STORAGE_KEYS.CITY_TAGS])
      ? stored[STORAGE_KEYS.CITY_TAGS]
      : [];
  }

  async function setCityTags(tags) {
    await storage.setLocal({
      [STORAGE_KEYS.CITY_TAGS]: Array.isArray(tags) ? tags : [],
    });
  }

  async function getSelectedCity(defaultSelectedCity = '') {
    const stored = await storage.getLocal([
      STORAGE_KEYS.SELECTED_CITY,
      STORAGE_KEYS.ALL_CITIES_SELECTED,
    ]);
    if (stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true) return '';
    return stored[STORAGE_KEYS.SELECTED_CITY] || defaultSelectedCity;
  }

  async function upsertCityTags(tags, selectedCityName = '') {
    const selectedCity = await getSelectedCity(selectedCityName);
    const merged = cityTags.mergeWithSelectedCity(tags, selectedCity);
    const current = await getCityTags();
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      await setCityTags(merged);
    }
    return merged;
  }

  async function getTagRenderState(defaultSelectedCity = '') {
    const stored = await storage.getLocal([
      STORAGE_KEYS.CITY_TAGS,
      STORAGE_KEYS.SELECTED_CITY,
      STORAGE_KEYS.ALL_CITIES_SELECTED,
    ]);
    return {
      selectedCity: stored[STORAGE_KEYS.SELECTED_CITY] || defaultSelectedCity,
      allCitiesSelected: stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true,
      cityTags: Array.isArray(stored[STORAGE_KEYS.CITY_TAGS])
        ? stored[STORAGE_KEYS.CITY_TAGS]
        : [],
    };
  }

  async function syncRuntimeControls(controls, current = {}, options = {}) {
    const stored = await storage.getLocal(RUNTIME_SYNC_KEYS);
    const useStoredCurrent = options.useStoredCurrent !== false;
    const allCitiesSelected = hasOwn(current, 'allCitiesSelected')
      ? current.allCitiesSelected === true
      : (useStoredCurrent ? stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true : false);
    const selectedCity = allCitiesSelected
      ? ''
      : (hasOwn(current, 'selectedCity')
          ? current.selectedCity
          : (useStoredCurrent ? stored[STORAGE_KEYS.SELECTED_CITY] : ''));
    const currentJobType = Array.isArray(current.jobType)
      ? (current.jobType.length ? current.jobType : (useStoredCurrent ? stored[STORAGE_KEYS.JOB_TYPE] : []))
      : (current.jobType || (useStoredCurrent ? stored[STORAGE_KEYS.JOB_TYPE] : ''));
    const snapshot = runtimeControls.buildStorageSnapshot(controls, {
      selectedCity,
      allCitiesSelected,
      distance: current.distance || (useStoredCurrent ? stored[STORAGE_KEYS.DISTANCE] : ''),
      jobType: currentJobType,
      fetchIntervalUnit:
        current.fetchIntervalUnit || (useStoredCurrent ? stored[STORAGE_KEYS.FETCH_INTERVAL_UNIT] : ''),
      fetchIntervalValue:
        current.fetchIntervalValue || (useStoredCurrent ? stored[STORAGE_KEYS.FETCH_INTERVAL_VALUE] : ''),
    });
    const updates = runtimeControls.pickStorageUpdates(snapshot, stored, {
      missingOnlyKeys: options.missingOnlyKeys || [],
      skipKeys: options.skipKeys || [],
    });
    if (Object.keys(updates).length > 0) await storage.setLocal(updates);
    return { stored, snapshot, updates };
  }

  function normalizeClientText(value) {
    return String(value || '').trim();
  }

  function getClientJobType(client) {
    return runtimeControls.normalizeJobTypeList(client?.job_type || client?.jobType);
  }

  function getClientLocations(client) {
    return runtimeControls.normalizeStringList(client?.location);
  }

  function buildClientLabel(client) {
    const name = normalizeClientText(client?.name);
    const email = normalizeClientText(client?.emailid);
    const status = normalizeClientText(client?.status).toUpperCase();
    const base = name || email || 'Amazon Shifts client';
    return status ? `${base} (${status})` : base;
  }

  function splitClientLocations(client, controls = {}) {
    const coordinates = controls?.cityCoordinates || {};
    const validLocations = [];
    const unmappedLocations = [];
    getClientLocations(client).forEach(location => {
      if (runtimeControls.getCoordinates(coordinates, location)) {
        validLocations.push(location);
      } else {
        unmappedLocations.push(location);
      }
    });
    return { validLocations, unmappedLocations };
  }

  function getConfiguredCityTags(controls = {}) {
    const defaultTags = runtimeControls.normalizeStringList(controls.defaultCityTags);
    if (defaultTags.length) return defaultTags;

    return runtimeControls.normalizeStringList([
      ...(controls.cityOptions || []),
      ...Object.keys(controls.cityCoordinates || {}),
    ]);
  }

  function getAllCityTags(controls = {}) {
    return runtimeControls.normalizeStringList([
      ...(controls.defaultCityTags || []),
      ...(controls.cityOptions || []),
      ...Object.keys(controls.cityCoordinates || {}),
    ]);
  }

  function coversConfiguredCityTags(validLocations = [], controls = {}) {
    const requiredTags = getConfiguredCityTags(controls);
    if (requiredTags.length === 0) return false;

    const selected = new Set(
      runtimeControls.normalizeStringList(validLocations)
        .map(tag => cityTags.normalizeCityTag(tag))
    );
    return requiredTags.every(tag => selected.has(cityTags.normalizeCityTag(tag)));
  }

  function buildClientHydrationSnapshot(client, controls = {}) {
    const { validLocations, unmappedLocations } = splitClientLocations(client, controls);
    const allCitiesSelected = coversConfiguredCityTags(validLocations, controls);
    const selectedCity = allCitiesSelected ? '' : (validLocations[0] || '');
    const snapshot = runtimeControls.buildStorageSnapshot(controls, {
      selectedCity,
      allCitiesSelected,
      distance: '',
      jobType: getClientJobType(client),
      fetchIntervalUnit: '',
      fetchIntervalValue: '',
    });
    const label = buildClientLabel(client);
    const writes = {
      ...snapshot,
      [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: normalizeClientText(client?.emailid),
      [STORAGE_KEYS.PASSWORD]: normalizeClientText(client?.pin),
      [STORAGE_KEYS.SELECTED_CLIENT_ID]: normalizeClientText(client?.id),
      [STORAGE_KEYS.SELECTED_CLIENT_LABEL]: label,
    };

    if (allCitiesSelected) {
      writes[STORAGE_KEYS.CITY_TAGS] = getAllCityTags(controls);
    } else if (validLocations.length > 0) {
      writes[STORAGE_KEYS.CITY_TAGS] = validLocations;
    }

    return {
      writes,
      label,
      selectedCity: writes[STORAGE_KEYS.SELECTED_CITY],
      allCitiesSelected: writes[STORAGE_KEYS.ALL_CITIES_SELECTED] === true,
      validLocations,
      unmappedLocations,
    };
  }

  async function hydrateClientSelection(client, controls = {}) {
    const hydration = buildClientHydrationSnapshot(client, controls);
    await storage.setLocal(hydration.writes);
    return hydration;
  }

  async function getJobSearchControls() {
    const stored = await storage.getLocal([
      STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM,
      STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS,
    ]);
    return {
      fallbackDistanceKm: stored[STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM] || '',
      fetchTimeoutMs: runtimeControls.normalizePositiveInteger(
        stored[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]
      ),
    };
  }

  async function getPageRefreshIntervalMs() {
    const stored = await storage.getLocal([
      STORAGE_KEYS.ACTIVE,
      STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS,
    ]);
    if (stored[STORAGE_KEYS.ACTIVE] !== true) return 0;
    return runtimeControls.normalizePositiveInteger(
      stored[STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]
    );
  }

  async function setLastMatchedJob(value) {
    await storage.setLocal({ [STORAGE_KEYS.LAST_MATCHED_JOB]: value || null });
  }

  async function getDirectSelectShiftsPending() {
    const stored = await storage.getLocal(STORAGE_KEYS.DIRECT_SELECT_SHIFTS_PENDING);
    return stored[STORAGE_KEYS.DIRECT_SELECT_SHIFTS_PENDING] || null;
  }

  async function setDirectSelectShiftsPending(value) {
    await storage.setLocal({ [STORAGE_KEYS.DIRECT_SELECT_SHIFTS_PENDING]: value || null });
  }

  async function clearDirectSelectShiftsPending() {
    await storage.removeLocal(STORAGE_KEYS.DIRECT_SELECT_SHIFTS_PENDING);
  }

  async function getResetPreservedCredentials() {
    return storage.getLocal([
      STORAGE_KEYS.AMAZON_LOGIN_USERNAME,
      STORAGE_KEYS.PASSWORD,
    ]);
  }

  async function resetLocal(values) {
    await storage.clearLocal();
    await storage.setLocal(values || {});
  }

  root.AMZ_STATE = Object.freeze({
    getActive,
    getSelectedClientId,
    hasSelectedClient,
    setActive,
    getAuthProbeStatus,
    persistAuthProbeStatus,
    getPopupFormState,
    getPollingSettings,
    setCitySelection,
    setAllCitiesSelection,
    setDistance,
    setJobType,
    setFetchIntervalValue,
    setFetchInterval,
    getCityTags,
    setCityTags,
    getSelectedCity,
    upsertCityTags,
    getTagRenderState,
    syncRuntimeControls,
    buildClientHydrationSnapshot,
    hydrateClientSelection,
    getJobSearchControls,
    getPageRefreshIntervalMs,
    setLastMatchedJob,
    getDirectSelectShiftsPending,
    setDirectSelectShiftsPending,
    clearDirectSelectShiftsPending,
    getResetPreservedCredentials,
    resetLocal,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
