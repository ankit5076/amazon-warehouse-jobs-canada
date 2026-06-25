/* Popup controller: local form state, refresh, and reset flows. */
document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const {
    LOCAL_DEFAULTS,
    LOGGING,
    MESSAGE_ACTIONS,
    POPUP,
    RESET_DEFAULTS,
    STORAGE_KEYS,
  } = globalThis.AMZ_CONSTANTS;
  const state = globalThis.AMZ_STATE;
  const storage = globalThis.AMZ_STORAGE;
  const runtimeControlUtils = globalThis.AMZ_RUNTIME_CONTROLS;
  const log = globalThis.AMZ_LOGGER.create('[popup]', {
    workflow: 'popup-settings',
    source: 'popup/content.js',
  });
  const USER_LOG_OPTIONS = Object.freeze({});
  const localControls = LOCAL_DEFAULTS.CONTROLS;

  document.getElementById('version').textContent = '(version v' + storage.getManifestVersion() + ')';

  let cityCoordinates = localControls.cityCoordinates || {};
  let resetInProgress = false;

  const elements = {
    city: document.getElementById('city'),
    distance: document.getElementById('distance'),
    jobType: document.getElementById('jobType'),
    activate: document.getElementById('activate'),
    logMode: document.getElementById('log_mode'),
    useDirectApplication: document.getElementById('use_direct_application'),
    directApplicationModeLabel: document.getElementById('direct_application_mode_label'),
    intervalValue: document.getElementById('fetch_interval_value'),
    intervalUnit: document.getElementById('fetch_interval_unit'),
    addAllCitiesButton: document.getElementById('add-all-cities'),
    cityScopeStatus: document.getElementById('city-scope-status'),
    cityFilterContainer: document.querySelector('.tag-input-container'),
    selectAllJobTypesButton: document.getElementById('select-all-job-types'),
    refreshForm: document.getElementById('refresh_info'),
    resetForm: document.getElementById('ais_visa_info'),
    resetButton: document.getElementById('reset_info'),
    refreshButton: document.getElementById('refresh_btn'),
  };

  function normalizeSelectOption(option) {
    if (typeof option === 'string' || typeof option === 'number') {
      const value = runtimeControlUtils.normalizeOptionValue(option);
      return value ? { value, label: value } : null;
    }
    if (!option || typeof option !== 'object') return null;

    const value = runtimeControlUtils.normalizeOptionValue(option.value);
    if (!value) return null;

    return {
      value,
      label: runtimeControlUtils.normalizeOptionValue(option.label) || value,
    };
  }

  function populateSelect(selectElement, options, fallbackValue = '', preferredValue = '') {
    if (!selectElement) return;
    const currentValue = runtimeControlUtils.normalizeOptionValue(selectElement.value);
    const preferred = runtimeControlUtils.normalizeOptionValue(preferredValue);
    selectElement.replaceChildren();
    const seenValues = new Set();
    (options || []).forEach(option => {
      const normalized = normalizeSelectOption(option);
      if (!normalized || seenValues.has(normalized.value)) return;
      seenValues.add(normalized.value);

      const optionElement = document.createElement('option');
      optionElement.value = normalized.value;
      optionElement.textContent = normalized.label;
      selectElement.append(optionElement);
    });
    const optionValues = [...selectElement.options].map(option => option.value);
    const nextValue = [
      currentValue,
      preferred,
      runtimeControlUtils.normalizeOptionValue(fallbackValue),
    ].find(value => optionValues.includes(value));
    if (nextValue) {
      selectElement.value = nextValue;
    } else if (selectElement.options.length > 0) {
      selectElement.selectedIndex = 0;
    } else {
      selectElement.value = '';
    }
  }

  function populateCitySelect(options, fallbackValue = '', preferredValue = '', allCitiesSelected = false) {
    if (!elements.city) return;
    elements.city.replaceChildren();

    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All cities';
    elements.city.append(allOption);

    const seenValues = new Set(['']);
    (options || []).forEach(option => {
      const normalized = normalizeSelectOption(option);
      if (!normalized || seenValues.has(normalized.value)) return;
      seenValues.add(normalized.value);

      const optionElement = document.createElement('option');
      optionElement.value = normalized.value;
      optionElement.textContent = normalized.label;
      elements.city.append(optionElement);
    });

    if (allCitiesSelected === true) {
      elements.city.value = '';
      return;
    }

    const optionValues = [...elements.city.options].map(option => option.value);
    const nextValue = [
      runtimeControlUtils.normalizeOptionValue(preferredValue),
      runtimeControlUtils.normalizeOptionValue(fallbackValue),
    ].find(value => optionValues.includes(value));
    elements.city.value = nextValue || '';
  }

  function getSelectedValues(selectElement) {
    if (!selectElement) return [];
    return Array.from(selectElement.selectedOptions || [])
      .map(option => option.value)
      .filter(Boolean);
  }

  function setSelectedValues(selectElement, values) {
    if (!selectElement) return;
    const normalizedValues = selectElement === elements.jobType
      ? runtimeControlUtils.normalizeJobTypeList(values)
      : runtimeControlUtils.normalizeStringList(values);
    const selectedValues = new Set(normalizedValues);
    Array.from(selectElement.options || []).forEach(option => {
      option.selected = selectedValues.has(option.value);
    });
  }

  function getAllowedSelection(options, values) {
    const allowed = new Set((options || [])
      .map(normalizeSelectOption)
      .filter(Boolean)
      .map(option => option.value));
    return runtimeControlUtils.normalizeStringList(values)
      .filter(value => allowed.has(value));
  }

  function populateMultiSelect(selectElement, options, fallbackValues = [], preferredValues = []) {
    if (!selectElement) return;
    const currentValues = getSelectedValues(selectElement);
    selectElement.replaceChildren();
    const seenValues = new Set();
    (options || []).forEach(option => {
      const normalized = normalizeSelectOption(option);
      if (!normalized || seenValues.has(normalized.value)) return;
      seenValues.add(normalized.value);

      const optionElement = document.createElement('option');
      optionElement.value = normalized.value;
      optionElement.textContent = normalized.label;
      selectElement.append(optionElement);
    });

    const nextValues = [
      getAllowedSelection(options, currentValues),
      getAllowedSelection(options, preferredValues),
      getAllowedSelection(options, fallbackValues),
    ].find(values => values.length) || [];
    setSelectedValues(selectElement, nextValues);
  }

  function applyControls(preferredValues = {}) {
    cityCoordinates = localControls.cityCoordinates || {};
    populateCitySelect(
      localControls.cityOptions || [],
      localControls.defaultInputs?.selectedCity,
      preferredValues.selectedCity,
      preferredValues.allCitiesSelected === true
    );
    populateSelect(
      elements.distance,
      localControls.distanceOptions || [],
      localControls.defaultInputs?.distance,
      preferredValues.distance
    );
    populateMultiSelect(
      elements.jobType,
      localControls.jobTypeOptions || [],
      localControls.defaultInputs?.jobType,
      preferredValues.jobType
    );
    updateAllCitiesUi(preferredValues.allCitiesSelected === true);
    log.debug('local controls applied to popup', {
      cityOptionCount: Array.isArray(localControls.cityOptions) ? localControls.cityOptions.length : 0,
      defaultCityTagCount: Array.isArray(localControls.defaultCityTags) ? localControls.defaultCityTags.length : 0,
      distanceOptionCount: Array.isArray(localControls.distanceOptions) ? localControls.distanceOptions.length : 0,
      jobTypeOptions: runtimeControlUtils.normalizeJobTypeList(localControls.jobTypeOptions || []),
    });
  }

  function getAllCityTags() {
    const cityOptionLabels = (localControls.cityOptions || [])
      .map(normalizeSelectOption)
      .filter(Boolean)
      .flatMap(option => [option.label, option.value]);
    return runtimeControlUtils.normalizeStringList([
      ...(localControls.defaultCityTags || []),
      ...cityOptionLabels,
      ...Object.keys(localControls.cityCoordinates || {}),
    ]);
  }

  function getAllJobTypes() {
    return runtimeControlUtils.normalizeJobTypeList(localControls.jobTypeOptions || []);
  }

  function setDirectApplicationModeUi(enabled) {
    const automated = enabled !== false;
    if (elements.useDirectApplication) elements.useDirectApplication.checked = automated;
    if (elements.directApplicationModeLabel) {
      elements.directApplicationModeLabel.textContent = automated ? 'Automated' : 'Manual';
    }
  }

  function updateAllCitiesUi(allCitiesSelected) {
    const active = allCitiesSelected === true;
    elements.addAllCitiesButton?.classList.toggle('active', active);
    elements.addAllCitiesButton?.setAttribute('aria-pressed', active ? 'true' : 'false');
    elements.cityFilterContainer?.classList.toggle('all-cities-active', active);
    const distanceField = elements.distance?.closest('.field');
    distanceField?.classList.toggle('all-cities-disabled', active);
    if (elements.distance) {
      elements.distance.disabled = active;
      elements.distance.title = active
        ? 'Distance is ignored while All cities is selected'
        : '';
    }
    if (elements.cityScopeStatus) {
      elements.cityScopeStatus.textContent = active ? 'All cities' : 'City specific';
      elements.cityScopeStatus.classList.toggle('active', active);
    }
  }

  function resolveLogModeFromStorage(stored = {}) {
    if (typeof globalThis.AMZ_LOGGER?.normalizeMode === 'function') {
      const explicitMode = stored[STORAGE_KEYS.LOG_MODE];
      if (explicitMode) return globalThis.AMZ_LOGGER.normalizeMode(explicitMode);
      return globalThis.AMZ_LOGGER.normalizeMode(LOGGING.DEFAULT_MODE);
    }
    return LOGGING.DEFAULT_MODE;
  }

  function setLogModeUi(value) {
    const mode = resolveLogModeFromStorage({ [STORAGE_KEYS.LOG_MODE]: value });
    if (elements.logMode) elements.logMode.value = mode;
    globalThis.AMZ_LOGGER?.setMode?.(mode);
  }

  async function syncCoordinatesForCity(city) {
    const coordinates = runtimeControlUtils.getCoordinates(cityCoordinates, city);
    if (!coordinates) return;
    await state.setCitySelection(city, coordinates);
  }

  function getIntervalDefaultValueForUnit(unit) {
    const normalizedUnit = runtimeControlUtils.normalizeOptionValue(unit);
    const defaultUnit = runtimeControlUtils.normalizeOptionValue(localControls.fetchInterval?.defaultUnit);
    const unitDefaultValue = runtimeControlUtils.getFetchIntervalDefaultValue(
      localControls.fetchInterval || {},
      normalizedUnit
    );

    if (normalizedUnit && normalizedUnit === defaultUnit && unitDefaultValue) {
      return unitDefaultValue;
    }
    if (unitDefaultValue) return unitDefaultValue;
    return globalThis.AMZ_INTERVALS.getDefaultValue(normalizedUnit);
  }

  function normalizeIntervalValueForUnit(value, unit) {
    const normalizedUnit = runtimeControlUtils.normalizeOptionValue(unit);
    const parsedValue = runtimeControlUtils.normalizePositiveInteger(value);
    if (!parsedValue) return getIntervalDefaultValueForUnit(normalizedUnit);
    return String(parsedValue);
  }

  async function syncLocalControlsToStorage(options = {}) {
    const forceDefaults = options.forceDefaults === true;
    const intervalUnit = elements.intervalUnit?.value || '';
    const intervalValue = normalizeIntervalValueForUnit(
      elements.intervalValue?.value || '',
      intervalUnit
    );
    if (!forceDefaults && elements.intervalValue) elements.intervalValue.value = intervalValue;

    const { snapshot } = await state.syncRuntimeControls(localControls, {
      selectedCity: forceDefaults ? '' : elements.city?.value || '',
      allCitiesSelected: forceDefaults ? true : elements.city?.value === '',
      distance: forceDefaults ? '' : elements.distance?.value || '',
      jobType: forceDefaults ? [] : getSelectedValues(elements.jobType),
      fetchIntervalUnit: forceDefaults ? '' : intervalUnit,
      fetchIntervalValue: forceDefaults ? '' : intervalValue,
    }, {
      missingOnlyKeys: forceDefaults ? [] : [STORAGE_KEYS.CITY_TAGS],
      useStoredCurrent: !forceDefaults,
    });
    const currentCity = snapshot[STORAGE_KEYS.SELECTED_CITY];
    const currentAllCitiesSelected = snapshot[STORAGE_KEYS.ALL_CITIES_SELECTED] === true;
    const currentDistance = snapshot[STORAGE_KEYS.DISTANCE];
    const currentJobType = snapshot[STORAGE_KEYS.JOB_TYPE];
    if (elements.city) elements.city.value = currentCity;
    if (elements.distance) elements.distance.value = currentDistance;
    updateAllCitiesUi(currentAllCitiesSelected);
    setSelectedValues(elements.jobType, currentJobType);
    if (elements.intervalUnit) elements.intervalUnit.value = snapshot[STORAGE_KEYS.FETCH_INTERVAL_UNIT];
    if (elements.intervalValue) elements.intervalValue.value = snapshot[STORAGE_KEYS.FETCH_INTERVAL_VALUE];

    if (currentAllCitiesSelected) {
      await state.setAllCitiesSelection(getAllCityTags());
    }
    await tagManager.renderFromStorage();
  }

  function hasSearchScope(stored = {}) {
    return Boolean(
      stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true ||
      stored[STORAGE_KEYS.SELECTED_CITY] ||
      (Array.isArray(stored[STORAGE_KEYS.CITY_TAGS]) && stored[STORAGE_KEYS.CITY_TAGS].length > 0)
    );
  }

  async function refreshActivationGate() {
    if (!elements.activate) return;
    const stored = await state.getPopupFormState();
    const valid = hasSearchScope(stored);
    elements.activate.disabled = !valid;
    elements.activate.title = valid ? '' : 'Choose a city or All cities to activate';
    if (!valid && elements.activate.checked) {
      elements.activate.checked = false;
      await state.setActive(false);
    }
  }

  async function applyStoredState() {
    const stored = await state.getPopupFormState();

    const selectedCity = stored[STORAGE_KEYS.SELECTED_CITY] || '';
    const allCitiesSelected =
      stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true ||
      (!selectedCity &&
        Array.isArray(stored[STORAGE_KEYS.CITY_TAGS]) &&
        stored[STORAGE_KEYS.CITY_TAGS].length > 0);
    const savedDistance = stored[STORAGE_KEYS.DISTANCE] || '';
    const savedJobType = runtimeControlUtils.normalizeJobTypeList(stored[STORAGE_KEYS.JOB_TYPE]);
    const intervalUnit = stored[STORAGE_KEYS.FETCH_INTERVAL_UNIT] || globalThis.AMZ_INTERVALS.getDefaultUnit();
    const intervalValue = stored[STORAGE_KEYS.FETCH_INTERVAL_VALUE] || getIntervalDefaultValueForUnit(intervalUnit);
    const active = stored[STORAGE_KEYS.ACTIVE] === true && hasSearchScope(stored);
    const logMode = resolveLogModeFromStorage(stored);
    const useDirectApplication = stored[STORAGE_KEYS.USE_DIRECT_APPLICATION] !== false;

    applyControls({ selectedCity, allCitiesSelected, distance: savedDistance, jobType: savedJobType });
    if (elements.city) elements.city.value = selectedCity;
    if (elements.distance) elements.distance.value = savedDistance || elements.distance.value;
    updateAllCitiesUi(allCitiesSelected);
    setSelectedValues(elements.jobType, savedJobType);
    if (elements.activate) elements.activate.checked = active;
    setLogModeUi(logMode);
    setDirectApplicationModeUi(useDirectApplication);
    if (elements.intervalValue) elements.intervalValue.value = intervalValue;
    if (elements.intervalUnit) elements.intervalUnit.value = intervalUnit;

    if (stored[STORAGE_KEYS.ACTIVE] === true && !active) {
      await state.setActive(false);
    }
    await tagManager.renderFromStorage();
    if (!allCitiesSelected) await syncCoordinatesForCity(selectedCity);
    if (!hasSearchScope(stored)) {
      await syncLocalControlsToStorage({ forceDefaults: true });
    }
    await refreshActivationGate();
  }

  async function applyLiveStorageChange(changes, areaName) {
    if (areaName !== 'local') return;
    if (resetInProgress) return;

    let shouldRefreshGate = false;
    let shouldRenderTags = false;

    if (changes[STORAGE_KEYS.SELECTED_CITY] && elements.city) {
      elements.city.value = changes[STORAGE_KEYS.SELECTED_CITY].newValue || '';
      shouldRenderTags = true;
      shouldRefreshGate = true;
    }
    if (changes[STORAGE_KEYS.ALL_CITIES_SELECTED]) {
      updateAllCitiesUi(changes[STORAGE_KEYS.ALL_CITIES_SELECTED].newValue === true);
      shouldRefreshGate = true;
    }
    if (changes[STORAGE_KEYS.DISTANCE] && elements.distance) {
      elements.distance.value = changes[STORAGE_KEYS.DISTANCE].newValue || '';
    }
    if (changes[STORAGE_KEYS.JOB_TYPE] && elements.jobType) {
      setSelectedValues(elements.jobType, changes[STORAGE_KEYS.JOB_TYPE].newValue);
    }
    if (changes[STORAGE_KEYS.FETCH_INTERVAL_UNIT] && elements.intervalUnit) {
      elements.intervalUnit.value = changes[STORAGE_KEYS.FETCH_INTERVAL_UNIT].newValue || '';
    }
    if (changes[STORAGE_KEYS.FETCH_INTERVAL_VALUE] && elements.intervalValue) {
      elements.intervalValue.value = changes[STORAGE_KEYS.FETCH_INTERVAL_VALUE].newValue ||
        getIntervalDefaultValueForUnit(elements.intervalUnit?.value);
    }
    if (changes[STORAGE_KEYS.ACTIVE] && elements.activate) {
      elements.activate.checked = changes[STORAGE_KEYS.ACTIVE].newValue === true;
    }
    if (changes[STORAGE_KEYS.LOG_MODE] && elements.logMode) {
      setLogModeUi(changes[STORAGE_KEYS.LOG_MODE].newValue);
    }
    if (changes[STORAGE_KEYS.USE_DIRECT_APPLICATION]) {
      setDirectApplicationModeUi(changes[STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue !== false);
    }
    if (changes[STORAGE_KEYS.CITY_TAGS]) {
      shouldRenderTags = true;
      shouldRefreshGate = true;
    }
    if (shouldRenderTags) await tagManager.renderFromStorage();
    if (shouldRefreshGate) await refreshActivationGate();
  }

  applyControls();

  const tagManager = globalThis.AMZ_POPUP_TAGS.create({
    defaultSelectedCity: '',
  });
  tagManager.bind();

  await applyStoredState();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    applyLiveStorageChange(changes, areaName).catch(error => {
      log.error('live storage sync failed:', error);
    });
  });

  elements.city?.addEventListener('change', async event => {
    const city = event.target.value;
    if (!city) {
      await state.setAllCitiesSelection(getAllCityTags());
      updateAllCitiesUi(true);
      await tagManager.renderFromStorage();
      await refreshActivationGate();
      log.debug('city dropdown changed to all cities', {
        cityTagCount: getAllCityTags().length,
      }, USER_LOG_OPTIONS);
      return;
    }
    const coordinates = runtimeControlUtils.getCoordinates(cityCoordinates, city);
    await state.setCitySelection(city, coordinates, { allCitiesSelected: false });
    updateAllCitiesUi(false);
    await tagManager.renderFromStorage();
    await refreshActivationGate();
    log.debug('city dropdown changed to specific city', {
      selectedCity: city,
      coordinatesFound: Boolean(coordinates),
    }, USER_LOG_OPTIONS);
  });

  elements.distance?.addEventListener('change', event => {
    state.setDistance(event.target.value);
  });
  elements.jobType?.addEventListener('change', event => {
    state.setJobType(getSelectedValues(event.target));
  });
  elements.intervalValue?.addEventListener('change', event => {
    const normalizedValue = normalizeIntervalValueForUnit(event.target.value, elements.intervalUnit?.value);
    event.target.value = normalizedValue;
    state.setFetchIntervalValue(normalizedValue);
  });
  elements.intervalUnit?.addEventListener('change', async event => {
    const unit = event.target.value;
    const defaultValue = getIntervalDefaultValueForUnit(unit);
    if (elements.intervalValue) elements.intervalValue.value = defaultValue;
    await state.setFetchInterval(unit, defaultValue);
  });

  elements.logMode?.addEventListener('change', async event => {
    const mode = resolveLogModeFromStorage({ [STORAGE_KEYS.LOG_MODE]: event.target.value });
    globalThis.AMZ_LOGGER?.setMode?.(mode);
    await storage.setLocal({
      [STORAGE_KEYS.LOG_MODE]: mode,
    });
    log.info('log mode changed', { mode }, USER_LOG_OPTIONS);
  });

  elements.useDirectApplication?.addEventListener('change', async event => {
    const enabled = event.target.checked === true;
    setDirectApplicationModeUi(enabled);
    await storage.setLocal({ [STORAGE_KEYS.USE_DIRECT_APPLICATION]: enabled });
    log.info('direct application mode changed', { enabled }, USER_LOG_OPTIONS);
  });

  elements.addAllCitiesButton?.addEventListener('click', async () => {
    if (elements.city) elements.city.value = '';
    const allCityTags = getAllCityTags();
    await state.setAllCitiesSelection(allCityTags);
    updateAllCitiesUi(true);
    await tagManager.renderFromStorage();
    await refreshActivationGate();
    log.debug('all cities button selected', {
      cityTagCount: allCityTags.length,
    }, USER_LOG_OPTIONS);
  });

  elements.selectAllJobTypesButton?.addEventListener('click', async () => {
    const jobTypes = getAllJobTypes();
    setSelectedValues(elements.jobType, jobTypes);
    await state.setJobType(jobTypes);
    log.debug('all job types selected', { jobTypes }, USER_LOG_OPTIONS);
  });

  elements.activate?.addEventListener('change', async event => {
    await syncLocalControlsToStorage();
    const stored = await state.getPopupFormState();
    if (event.target.checked && !hasSearchScope(stored)) {
      event.preventDefault();
      event.target.checked = false;
      await state.setActive(false);
      return;
    }

    const active = await state.setActive(event.target.checked);
    if (event.target.checked && !active) {
      event.target.checked = false;
      return;
    }
    log.info('automation active setting changed', { active }, USER_LOG_OPTIONS);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, {
        action: MESSAGE_ACTIONS.ACTIVATE,
        status: active,
      });
    }
  });

  async function refreshLocalDefaults() {
    if (!elements.refreshButton) return;
    elements.refreshButton.disabled = true;
    elements.refreshButton.innerText = 'Refreshing...';

    try {
      await syncLocalControlsToStorage();
      elements.refreshButton.classList.add('btn-success');
      elements.refreshButton.innerText = 'Success';
      await new Promise(resolve => setTimeout(resolve, POPUP.REFRESH_SUCCESS_DELAY_MS));
    } catch (error) {
      log.error('refresh failed:', error);
    } finally {
      elements.refreshButton.classList.remove('btn-success');
      elements.refreshButton.innerText = 'Refresh';
      elements.refreshButton.disabled = false;
    }
  }

  elements.refreshForm?.addEventListener('submit', event => {
    event.preventDefault();
    refreshLocalDefaults();
  });

  elements.resetForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (elements.resetButton) {
      elements.resetButton.disabled = true;
      elements.resetButton.innerText = 'Resetting...';
    }

    try {
      resetInProgress = true;
      const preserved = await state.getResetPreservedCredentials();
      const resetValues = {
        ...RESET_DEFAULTS,
        [STORAGE_KEYS.ALL_CITIES_SELECTED]: true,
        [STORAGE_KEYS.CITY_TAGS]: getAllCityTags(),
      };
      if (preserved[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]) {
        resetValues[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] = preserved[STORAGE_KEYS.AMAZON_LOGIN_USERNAME];
      }
      if (preserved[STORAGE_KEYS.PASSWORD]) {
        resetValues[STORAGE_KEYS.PASSWORD] = preserved[STORAGE_KEYS.PASSWORD];
      }

      await state.resetLocal(resetValues);

      applyControls({
        selectedCity: '',
        allCitiesSelected: true,
        distance: RESET_DEFAULTS[STORAGE_KEYS.DISTANCE],
        jobType: RESET_DEFAULTS[STORAGE_KEYS.JOB_TYPE],
      });
      setLogModeUi(RESET_DEFAULTS[STORAGE_KEYS.LOG_MODE]);
      setDirectApplicationModeUi(RESET_DEFAULTS[STORAGE_KEYS.USE_DIRECT_APPLICATION] !== false);
      if (elements.intervalValue) elements.intervalValue.value = RESET_DEFAULTS[STORAGE_KEYS.FETCH_INTERVAL_VALUE];
      if (elements.intervalUnit) elements.intervalUnit.value = RESET_DEFAULTS[STORAGE_KEYS.FETCH_INTERVAL_UNIT];
      if (elements.activate) elements.activate.checked = false;
      await syncLocalControlsToStorage({ forceDefaults: true });
      await refreshActivationGate();
    } finally {
      resetInProgress = false;
      if (elements.resetButton) {
        elements.resetButton.disabled = false;
        elements.resetButton.innerText = 'Reset';
      }
    }
  });
});
