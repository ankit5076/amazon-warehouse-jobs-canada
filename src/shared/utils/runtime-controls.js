/* Runtime-control normalization shared by popup and content scripts. */
(function (root) {
  'use strict';

  if (root.AMZ_RUNTIME_CONTROLS) return;

  const { AMAZON, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const CANONICAL_JOB_TYPES = new Set(AMAZON.JOB_TYPE_VALUES || []);

  function normalizeString(value) {
    return String(value ?? '').trim();
  }

  function normalizeOptionValue(value) {
    if (value === null || typeof value === 'undefined') return '';
    if (typeof value === 'object' || typeof value === 'function') return '';
    const normalized = normalizeString(value);
    const lower = normalized.toLowerCase();
    return !normalized || lower === 'null' || lower === 'undefined' ? '' : normalized;
  }

  function normalizeStringList(values) {
    const seen = new Set();
    const result = [];
    const source = Array.isArray(values)
      ? values
      : (typeof values === 'undefined' || values === null ? [] : [values]);
    source.forEach(value => {
      const normalized = normalizeOptionValue(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      result.push(normalized);
    });
    return result;
  }

  function normalizeJobTypeValue(value) {
    const normalized = normalizeOptionValue(value)
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (!normalized) return '';
    if (normalized === 'FLEXIBLE') return 'FLEX_TIME';
    return CANONICAL_JOB_TYPES.has(normalized) ? normalized : '';
  }

  function normalizeJobTypeList(values) {
    const seen = new Set();
    const result = [];
    const source = Array.isArray(values)
      ? values
      : (typeof values === 'undefined' || values === null ? [] : [values]);
    source.forEach(value => {
      String(value ?? '').split(/[;,]/).forEach(part => {
        const normalized = normalizeJobTypeValue(part);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
    });
    return result;
  }

  function jobMatchesSelectedTypes(jobTypes, selectedJobTypes) {
    const selected = normalizeJobTypeList(selectedJobTypes);
    if (selected.length === 0) return true;

    const returned = normalizeJobTypeList(jobTypes);
    if (returned.length === 0) return false;

    const selectedSet = new Set(selected);
    return returned.some(jobType => selectedSet.has(jobType));
  }

  function normalizePositiveInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalizeNumber(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeBoolean(value) {
    return value === true || value === 'true';
  }

  function getOptionValue(option) {
    if (typeof option === 'string' || typeof option === 'number') {
      return normalizeOptionValue(option);
    }
    if (!option || typeof option !== 'object') return '';
    return normalizeOptionValue(option.value);
  }

  function getAllowedValue(options, value) {
    const normalizedValue = normalizeString(value);
    if (!normalizedValue) return '';
    return (options || []).some(option => getOptionValue(option) === normalizedValue)
      ? normalizedValue
      : '';
  }

  function getControlValue(options, currentValue, defaultValue) {
    return getAllowedValue(options, currentValue) || getAllowedValue(options, defaultValue);
  }

  function getAllowedValues(options, values) {
    const optionValues = new Set((options || []).map(getOptionValue).filter(Boolean));
    return normalizeStringList(values).filter(value => optionValues.has(value));
  }

  function getControlValues(options, currentValues, defaultValues) {
    const allowedCurrent = getAllowedValues(options, currentValues);
    if (allowedCurrent.length) return allowedCurrent;
    return getAllowedValues(options, defaultValues);
  }

  function getCoordinates(cityCoordinates, city) {
    const coordinates = cityCoordinates?.[city];
    const lat = normalizeNumber(coordinates?.lat);
    const lng = normalizeNumber(coordinates?.lng);
    return lat === null || lng === null ? null : { lat, lng };
  }

  function getFetchIntervalDefaultValue(fetchInterval = {}, unit = '') {
    const normalizedUnit = normalizeOptionValue(unit);
    if (normalizedUnit === 'ms') {
      const msValue = normalizePositiveInteger(fetchInterval.defaultMsValue ?? fetchInterval.minMs);
      return msValue ? String(msValue) : '';
    }
    if (normalizedUnit === 's') {
      return normalizeOptionValue(fetchInterval.defaultSValue ?? fetchInterval.defaultValue);
    }
    return '';
  }

  function normalizeControls(controls) {
    return controls && typeof controls === 'object' ? controls : {};
  }

  function resolveSearchInputs(controls = {}, current = {}) {
    const source = normalizeControls(controls);
    const defaultInputs = source.defaultInputs || {};
    const cityCoordinates = source.cityCoordinates || {};
    const allCitiesSelected = normalizeBoolean(current.allCitiesSelected);
    const currentCity = normalizeOptionValue(current.selectedCity);
    const defaultCity = normalizeOptionValue(defaultInputs.selectedCity);
    const currentCoordinates = getCoordinates(cityCoordinates, currentCity);
    const defaultCoordinates = getCoordinates(cityCoordinates, defaultCity);
    const selectedCity = allCitiesSelected
      ? ''
      : (currentCoordinates ? currentCity : (defaultCoordinates ? defaultCity : ''));
    const coordinates = allCitiesSelected
      ? null
      : (currentCoordinates || defaultCoordinates);

    const currentDistance = normalizeOptionValue(current.distance);
    const distance = getControlValue(
      source.distanceOptions,
      currentDistance,
      defaultInputs.distance
    ) ||
      normalizeString(normalizePositiveInteger(currentDistance) || '') ||
      normalizeString(normalizePositiveInteger(defaultInputs.distance) || '') ||
      normalizeString(normalizePositiveInteger(source.jobSearch?.fallbackDistanceKm) || '');

    const currentJobTypes = normalizeJobTypeList(current.jobType);
    const defaultJobTypes = normalizeJobTypeList(defaultInputs.jobType);
    const jobType = normalizeJobTypeList(getControlValues(
      source.jobTypeOptions,
      currentJobTypes,
      defaultJobTypes
    ));

    return {
      allCitiesSelected,
      selectedCity,
      lat: coordinates ? coordinates.lat : null,
      lng: coordinates ? coordinates.lng : null,
      distance,
      jobType,
    };
  }

  function buildStorageSnapshot(controls = {}, current = {}) {
    const source = normalizeControls(controls);
    const searchInputs = resolveSearchInputs(source, current);
    const fetchInterval = source.fetchInterval || {};
    const jobSearch = source.jobSearch || {};
    const pageRefresh = source.pageRefresh || {};
    const fetchIntervalUnit =
      normalizeOptionValue(current.fetchIntervalUnit) || normalizeOptionValue(fetchInterval.defaultUnit);
    const fetchIntervalValue =
      normalizeOptionValue(current.fetchIntervalValue) ||
      getFetchIntervalDefaultValue(fetchInterval, fetchIntervalUnit);

    return {
      [STORAGE_KEYS.SELECTED_CITY]: searchInputs.selectedCity,
      [STORAGE_KEYS.ALL_CITIES_SELECTED]: searchInputs.allCitiesSelected,
      [STORAGE_KEYS.LATITUDE]: searchInputs.lat,
      [STORAGE_KEYS.LONGITUDE]: searchInputs.lng,
      [STORAGE_KEYS.DISTANCE]: searchInputs.distance,
      [STORAGE_KEYS.JOB_TYPE]: searchInputs.jobType,
      [STORAGE_KEYS.CITY_TAGS]: normalizeStringList(source.defaultCityTags),
      [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: fetchIntervalUnit,
      [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: fetchIntervalValue,
      [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 0,
      [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]:
        normalizeString(normalizePositiveInteger(jobSearch.fallbackDistanceKm) || ''),
      [STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]: normalizePositiveInteger(jobSearch.fetchTimeoutMs),
      [STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]:
        normalizePositiveInteger(pageRefresh.jobSearchIntervalMs),
    };
  }

  function isMissingStoredValue(value) {
    return value === null ||
      typeof value === 'undefined' ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
  }

  function areStorageValuesEqual(left, right) {
    if (Array.isArray(left) || Array.isArray(right)) {
      return JSON.stringify(left || []) === JSON.stringify(right || []);
    }
    return left === right;
  }

  function pickStorageUpdates(snapshot, stored = {}, options = {}) {
    const skipKeys = new Set(options.skipKeys || []);
    const missingOnlyKeys = new Set(options.missingOnlyKeys || []);
    const updates = {};

    Object.entries(snapshot || {}).forEach(([key, value]) => {
      if (skipKeys.has(key)) return;
      if (missingOnlyKeys.has(key) && !isMissingStoredValue(stored[key])) return;
      if (!areStorageValuesEqual(stored[key], value)) updates[key] = value;
    });

    return updates;
  }

  root.AMZ_RUNTIME_CONTROLS = Object.freeze({
    normalizeString,
    normalizeOptionValue,
    normalizeStringList,
    normalizeJobTypeValue,
    normalizeJobTypeList,
    jobMatchesSelectedTypes,
    normalizePositiveInteger,
    normalizeNumber,
    normalizeBoolean,
    getOptionValue,
    getAllowedValue,
    getControlValue,
    getAllowedValues,
    getControlValues,
    getCoordinates,
    getFetchIntervalDefaultValue,
    resolveSearchInputs,
    buildStorageSnapshot,
    pickStorageUpdates,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
