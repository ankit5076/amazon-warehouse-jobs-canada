/* Popup controller: paid license gate plus local booking settings. */
document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const {
    BACKEND,
    LOGGING,
    MESSAGE_ACTIONS,
    POPUP,
    RESET_DEFAULTS,
    STORAGE_KEYS,
  } = globalThis.AMZ_CONSTANTS;
  const state = globalThis.AMZ_STATE;
  const storage = globalThis.AMZ_STORAGE;
  const account = globalThis.AMZ_ACCOUNT;
  const runtimeControlUtils = globalThis.AMZ_RUNTIME_CONTROLS;
  const licenseState = globalThis.AMZ_LICENSE_STATE;
  const licenseApi = globalThis.AMZ_LICENSE_API;
  const paymentGate = globalThis.AMZ_PAYMENT_GATE;
  const log = globalThis.AMZ_LOGGER.create('[popup]', {
    workflow: 'popup-settings',
    source: 'popup/content.js',
  });
  const USER_LOG_OPTIONS = Object.freeze({});

  document.getElementById('version').innerText = '(version v' + storage.getManifestVersion() + ')';

  let runtimeControls = BACKEND.FALLBACK_DEFAULTS;
  let cityCoordinates = runtimeControls.cityCoordinates || {};
  let resetInProgress = false;
  let currentLicense = null;

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
    checkoutButton: document.getElementById('checkout_btn'),
    checkoutProButton: document.getElementById('checkout_pro_btn'),
    licenseStatus: document.getElementById('license-status'),
    authenticatedSections: Array.from(document.querySelectorAll('[data-authenticated-section]')),
    addAllCitiesButton: document.getElementById('add-all-cities'),
    cityScopeStatus: document.getElementById('city-scope-status'),
    cityFilterContainer: document.querySelector('.tag-input-container'),
    selectAllJobTypesButton: document.getElementById('select-all-job-types'),
    refreshForm: document.getElementById('refresh_info'),
    resetForm: document.getElementById('ais_visa_info'),
    resetButton: document.getElementById('reset_info'),
    refreshButton: document.getElementById('refresh_btn'),
  };

  function normalizeEmail(value) {
    return licenseState.normalizeEmail(value);
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
  }

  function setUsernameError(message) {
    if (message) setLicenseStatus(message, 'error');
  }

  function setLicenseStatus(message, tone = '') {
    if (!elements.licenseStatus) return;
    elements.licenseStatus.textContent = message || '';
    elements.licenseStatus.className = ['license-status', tone].filter(Boolean).join(' ');
  }

  function setPaidUiEnabled() {
    document.body?.classList.toggle('auth-complete', true);
    document.body?.classList.toggle('auth-required', false);
    elements.authenticatedSections.forEach(section => {
      section.hidden = false;
    });
  }

  function formatLicenseMessage(license) {
    if (!license) return 'Search is free. Paid access unlocks unlimited booking.';
    if (license.isProUser) {
      return license.accessExpiresAt ? `Unlimited booking active until ${new Date(license.accessExpiresAt).toLocaleDateString()}.` : 'Unlimited booking active.';
    }
    return license.message || 'Search is free. Buy access to book matched jobs.';
  }

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
      runtimeControlUtils.normalizeOptionValue(preferredValue),
      runtimeControlUtils.normalizeOptionValue(fallbackValue),
    ].find(value => optionValues.includes(value));
    if (nextValue) selectElement.value = nextValue;
    else if (selectElement.options.length > 0) selectElement.selectedIndex = 0;
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

  function applyControls(controls, preferredValues = {}) {
    runtimeControls = controls || BACKEND.FALLBACK_DEFAULTS;
    cityCoordinates = runtimeControls.cityCoordinates || {};
    populateCitySelect(
      runtimeControls.cityOptions || [],
      runtimeControls.defaultInputs?.selectedCity,
      preferredValues.selectedCity,
      preferredValues.allCitiesSelected === true
    );
    populateSelect(
      elements.distance,
      runtimeControls.distanceOptions || [],
      runtimeControls.defaultInputs?.distance,
      preferredValues.distance
    );
    populateMultiSelect(
      elements.jobType,
      runtimeControls.jobTypeOptions || [],
      runtimeControls.defaultInputs?.jobType,
      preferredValues.jobType
    );
    updateAllCitiesUi(preferredValues.allCitiesSelected === true);
  }

  function getAllCityTags() {
    const cityOptionLabels = (runtimeControls.cityOptions || [])
      .map(normalizeSelectOption)
      .filter(Boolean)
      .flatMap(option => [option.label, option.value]);
    return runtimeControlUtils.normalizeStringList([
      ...(runtimeControls.defaultCityTags || []),
      ...cityOptionLabels,
      ...Object.keys(runtimeControls.cityCoordinates || {}),
    ]);
  }

  function getAllJobTypes() {
    return runtimeControlUtils.normalizeJobTypeList(
      (runtimeControls.jobTypeOptions || []).map(option => normalizeSelectOption(option)?.value)
    );
  }

  function setDirectApplicationModeUi(enabled) {
    const automated = enabled !== false;
    if (elements.useDirectApplication) elements.useDirectApplication.checked = automated;
    if (elements.directApplicationModeLabel) {
      elements.directApplicationModeLabel.textContent = automated ? 'Enabled' : 'Off';
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
      elements.distance.title = active ? 'Distance is ignored while All cities is selected' : '';
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

  function getIntervalDefaultValueForUnit(unit) {
    const normalizedUnit = runtimeControlUtils.normalizeOptionValue(unit);
    const runtimeDefault = runtimeControls?.fetchInterval || {};
    const runtimeDefaultUnit = runtimeControlUtils.normalizeOptionValue(runtimeDefault.defaultUnit);
    const unitDefaultValue = runtimeControlUtils.getFetchIntervalDefaultValue(runtimeDefault, normalizedUnit);

    if (normalizedUnit && normalizedUnit === runtimeDefaultUnit && unitDefaultValue) return unitDefaultValue;
    if (unitDefaultValue) return unitDefaultValue;
    return globalThis.AMZ_INTERVALS.getDefaultValue(normalizedUnit);
  }

  function normalizeIntervalValueForUnit(value, unit) {
    const normalizedUnit = runtimeControlUtils.normalizeOptionValue(unit);
    const parsedValue = runtimeControlUtils.normalizePositiveInteger(value);
    if (!parsedValue) return getIntervalDefaultValueForUnit(normalizedUnit);
    return String(parsedValue);
  }

  async function syncCoordinatesForCity(city) {
    const coordinates = runtimeControlUtils.getCoordinates(cityCoordinates, city);
    if (!coordinates) return;
    await state.setCitySelection(city, coordinates);
  }

  async function getStoredSearchInputs() {
    const stored = await state.getPopupFormState();
    return {
      selectedCity: stored[STORAGE_KEYS.SELECTED_CITY] || '',
      allCitiesSelected: stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true,
      distance: stored[STORAGE_KEYS.DISTANCE] || '',
      jobType: runtimeControlUtils.normalizeJobTypeList(stored[STORAGE_KEYS.JOB_TYPE]),
    };
  }

  async function syncRuntimeControlsToStorage(options = {}) {
    const forceDefaults = options.forceDefaults === true;
    const intervalUnit = elements.intervalUnit?.value || '';
    const intervalValue = normalizeIntervalValueForUnit(elements.intervalValue?.value || '', intervalUnit);
    if (!forceDefaults && elements.intervalValue) elements.intervalValue.value = intervalValue;

    const { snapshot } = await state.syncRuntimeControls(runtimeControls, {
      selectedCity: forceDefaults ? '' : elements.city?.value || '',
      allCitiesSelected: forceDefaults ? false : elements.city?.value === '',
      distance: forceDefaults ? '' : elements.distance?.value || '',
      jobType: forceDefaults ? [] : getSelectedValues(elements.jobType),
      fetchIntervalUnit: forceDefaults ? '' : intervalUnit,
      fetchIntervalValue: forceDefaults ? '' : intervalValue,
    }, {
      missingOnlyKeys: forceDefaults ? [] : [STORAGE_KEYS.CITY_TAGS],
      useStoredCurrent: !forceDefaults,
    });
    if (elements.city) elements.city.value = snapshot[STORAGE_KEYS.SELECTED_CITY];
    if (elements.distance) elements.distance.value = snapshot[STORAGE_KEYS.DISTANCE];
    updateAllCitiesUi(snapshot[STORAGE_KEYS.ALL_CITIES_SELECTED] === true);
    setSelectedValues(elements.jobType, snapshot[STORAGE_KEYS.JOB_TYPE]);
    if (elements.intervalUnit) elements.intervalUnit.value = snapshot[STORAGE_KEYS.FETCH_INTERVAL_UNIT];
    if (elements.intervalValue) elements.intervalValue.value = snapshot[STORAGE_KEYS.FETCH_INTERVAL_VALUE];
    await tagManager.renderFromStorage();
  }

  function popupIdentity() {
    return {
      emailId: '',
      amazonEmailId: '',
    };
  }

  async function storedOrPopupIdentity() {
    const stored = await licenseState.getStoredEmails();
    return {
      emailId: stored.emailId,
      amazonEmailId: stored.amazonEmailId,
    };
  }

  async function getResetPreservedCredentials() {
    if (typeof state.getResetPreservedCredentials === 'function') {
      return state.getResetPreservedCredentials();
    }
    return {};
  }

  async function refreshActivationGate() {
    const identity = await storedOrPopupIdentity();
    const licenseAllowed = licenseState.isAllowedState(currentLicense) && licenseState.isFresh(currentLicense);
    const searchScopeReady = await paymentGate.getSearchScopeReady();
    const canActivate = searchScopeReady;

    setPaidUiEnabled();
    if (elements.activate) {
      elements.activate.disabled = !canActivate;
      elements.activate.title = canActivate ? '' : 'Select a city or All cities';
    }
    if (!canActivate && elements.activate?.checked) {
      elements.activate.checked = false;
      await state.setActive(false);
    }
    if (elements.checkoutButton) {
      elements.checkoutButton.disabled = false;
    }
    if (elements.checkoutProButton) {
      elements.checkoutProButton.disabled = false;
    }
    setLicenseStatus(formatLicenseMessage(currentLicense), licenseAllowed ? 'success' : 'warning');
  }

  async function refreshLicense(options = {}) {
    const identity = await storedOrPopupIdentity();
    if (options.email || options.amazonEmailId) {
      identity.amazonEmailId = normalizeEmail(options.amazonEmailId || options.email);
    }
    if (!isValidEmail(identity.amazonEmailId)) {
      currentLicense = null;
      await refreshActivationGate();
      return null;
    }
    if (elements.validateButton) {
      elements.validateButton.disabled = true;
      elements.validateButton.innerText = 'Validating...';
    }
    try {
      currentLicense = await licenseState.refresh(identity, { allowCache: options.allowCache !== false });
      setLicenseStatus(formatLicenseMessage(currentLicense), licenseState.isAllowedState(currentLicense) ? 'success' : 'warning');
      return currentLicense;
    } catch (error) {
      currentLicense = null;
      setLicenseStatus(error?.message || 'Unable to validate license.', 'error');
      return null;
    } finally {
      if (elements.validateButton) elements.validateButton.innerText = 'Validate';
      await refreshActivationGate();
    }
  }

  async function startCheckout(plan = 'credits', button = elements.checkoutButton) {
    const purchaseType = button?.dataset?.plan === 'pro' || plan === 'pro' ? 'pro' : 'credits';
    const originalText = button?.innerText || '';
    if (button) {
      button.disabled = true;
      button.innerText = 'Opening...';
    }
    try {
      const checkoutUrl = licenseApi.checkoutPageUrl({ purchaseType });
      await openCheckoutUrl(checkoutUrl);
    } catch (error) {
      setLicenseStatus(error?.message || 'Unable to start checkout.', 'error');
    } finally {
      if (button) {
        button.innerText = originalText || (purchaseType === 'pro' ? 'Go Pro' : 'Get 30 days');
      }
      await refreshActivationGate();
    }
  }

  async function openCheckoutUrl(checkoutUrl) {
    if (chrome?.tabs?.create) {
      await chrome.tabs.create({ url: checkoutUrl });
      return;
    }
    window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
  }

  async function notifyActiveTab(active) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, {
        action: MESSAGE_ACTIONS.ACTIVATE,
        status: active,
      });
    }
  }

  async function applyStoredState() {
    const [stored, savedEmail, cachedLicense] = await Promise.all([
      state.getPopupFormState(),
      licenseState.getStoredEmails(),
      licenseState.loadCachedState(),
    ]);
    currentLicense = cachedLicense;

    const selectedCity = stored[STORAGE_KEYS.SELECTED_CITY] || '';
    const allCitiesSelected =
      stored[STORAGE_KEYS.ALL_CITIES_SELECTED] === true ||
      (!selectedCity && Array.isArray(stored[STORAGE_KEYS.CITY_TAGS]) && stored[STORAGE_KEYS.CITY_TAGS].length > 0);
    const savedDistance = stored[STORAGE_KEYS.DISTANCE] || '';
    const savedJobType = runtimeControlUtils.normalizeJobTypeList(stored[STORAGE_KEYS.JOB_TYPE]);
    const intervalUnit = stored[STORAGE_KEYS.FETCH_INTERVAL_UNIT] || globalThis.AMZ_INTERVALS.getDefaultUnit();
    const intervalValue = stored[STORAGE_KEYS.FETCH_INTERVAL_VALUE] || getIntervalDefaultValueForUnit(intervalUnit);
    const useDirectApplication = stored[STORAGE_KEYS.USE_DIRECT_APPLICATION] !== false;

    applyControls(BACKEND.FALLBACK_DEFAULTS, {
      selectedCity,
      allCitiesSelected,
      distance: savedDistance,
      jobType: savedJobType,
    });
    if (elements.city) elements.city.value = selectedCity;
    if (elements.distance) elements.distance.value = savedDistance;
    updateAllCitiesUi(allCitiesSelected);
    setSelectedValues(elements.jobType, savedJobType);
    if (elements.activate) elements.activate.checked = stored[STORAGE_KEYS.ACTIVE] === true;
    setLogModeUi(resolveLogModeFromStorage(stored));
    setDirectApplicationModeUi(useDirectApplication);
    if (elements.intervalValue) elements.intervalValue.value = intervalValue;
    if (elements.intervalUnit) elements.intervalUnit.value = intervalUnit;
    await tagManager.renderFromStorage();
    if (!allCitiesSelected) await syncCoordinatesForCity(selectedCity);
    await refreshActivationGate();

    if (savedEmail.amazonEmailId) {
      await refreshLicense({ amazonEmailId: savedEmail.amazonEmailId, allowCache: true });
    }
  }

  async function applyLiveStorageChange(changes, areaName) {
    if (areaName !== 'local' || resetInProgress) return;
    let shouldRenderTags = false;

    if (changes[STORAGE_KEYS.LICENSE_STATE]) {
      currentLicense = changes[STORAGE_KEYS.LICENSE_STATE].newValue || null;
      await refreshActivationGate();
    }
    if (changes[STORAGE_KEYS.SELECTED_CITY] && elements.city) {
      elements.city.value = changes[STORAGE_KEYS.SELECTED_CITY].newValue || '';
      shouldRenderTags = true;
    }
    if (changes[STORAGE_KEYS.ALL_CITIES_SELECTED]) {
      updateAllCitiesUi(changes[STORAGE_KEYS.ALL_CITIES_SELECTED].newValue === true);
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
      const gate = await paymentGate.canActivate({ allowCache: true });
      elements.activate.checked = changes[STORAGE_KEYS.ACTIVE].newValue === true && gate.ok === true;
    }
    if (changes[STORAGE_KEYS.LOG_MODE] && elements.logMode) {
      setLogModeUi(changes[STORAGE_KEYS.LOG_MODE].newValue);
    }
    if (changes[STORAGE_KEYS.USE_DIRECT_APPLICATION]) {
      setDirectApplicationModeUi(changes[STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue !== false);
    }
    if (changes[STORAGE_KEYS.CITY_TAGS]) shouldRenderTags = true;
    if (shouldRenderTags) await tagManager.renderFromStorage();
    await refreshActivationGate();
  }

  applyControls(BACKEND.FALLBACK_DEFAULTS);
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
      return;
    }
    const coordinates = runtimeControlUtils.getCoordinates(cityCoordinates, city);
    await state.setCitySelection(city, coordinates, { allCitiesSelected: false });
    updateAllCitiesUi(false);
    await tagManager.renderFromStorage();
    await refreshActivationGate();
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
    await storage.setLocal({ [STORAGE_KEYS.LOG_MODE]: mode });
    log.info('log mode changed', { mode }, USER_LOG_OPTIONS);
  });

  elements.useDirectApplication?.addEventListener('change', async event => {
    const enabled = event.target.checked === true;
    setDirectApplicationModeUi(enabled);
    await storage.setLocal({ [STORAGE_KEYS.USE_DIRECT_APPLICATION]: enabled });
    log.info('api mode changed', { enabled }, USER_LOG_OPTIONS);
  });

  elements.addAllCitiesButton?.addEventListener('click', async () => {
    if (elements.city) elements.city.value = '';
    await state.setAllCitiesSelection(getAllCityTags());
    updateAllCitiesUi(true);
    await tagManager.renderFromStorage();
    await refreshActivationGate();
  });

  elements.selectAllJobTypesButton?.addEventListener('click', async () => {
    const jobTypes = getAllJobTypes();
    setSelectedValues(elements.jobType, jobTypes);
    await state.setJobType(jobTypes);
  });

  elements.checkoutButton?.addEventListener('click', () => {
    startCheckout('credits', elements.checkoutButton).catch(error => log.error('checkout failed:', error));
  });

  elements.checkoutProButton?.addEventListener('click', () => {
    startCheckout('pro', elements.checkoutProButton).catch(error => log.error('checkout failed:', error));
  });

  elements.activate?.addEventListener('change', async event => {
    if (!event.target.checked) {
      const active = await state.setActive(false);
      await notifyActiveTab(active);
      return;
    }

    const gate = await paymentGate.canActivate({ allowCache: true });
    if (!gate.ok) {
      event.preventDefault();
      event.target.checked = false;
      await state.setActive(false);
      setLicenseStatus('Select a city or All cities before activating.', 'warning');
      await refreshActivationGate();
      return;
    }

    const active = await state.setActive(true);
    event.target.checked = active;
    await notifyActiveTab(active);
    log.info('automation active setting changed', { active }, USER_LOG_OPTIONS);
  });

  elements.refreshForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!elements.refreshButton) return;
      elements.refreshButton.disabled = true;
      elements.refreshButton.innerText = 'Refreshing...';
    try {
      const identity = await storedOrPopupIdentity();
      if (identity.amazonEmailId) await refreshLicense({ allowCache: false });
      await syncRuntimeControlsToStorage();
      elements.refreshButton.classList.add('btn-success');
      elements.refreshButton.innerText = 'Success';
      await new Promise(resolve => setTimeout(resolve, POPUP.REFRESH_SUCCESS_DELAY_MS));
    } finally {
      elements.refreshButton.classList.remove('btn-success');
      elements.refreshButton.innerText = 'Refresh';
      elements.refreshButton.disabled = false;
    }
  });

  elements.resetForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (elements.resetButton) {
      elements.resetButton.disabled = true;
      elements.resetButton.innerText = 'Resetting...';
    }

    try {
      resetInProgress = true;
      const [licenseEmails, preserved] = await Promise.all([
        licenseState.getStoredEmails(),
        getResetPreservedCredentials(),
      ]);
      const resetValues = {
        ...RESET_DEFAULTS,
        [STORAGE_KEYS.LICENSE_BUYER_EMAIL]: licenseEmails.emailId,
        [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: licenseEmails.amazonEmailId,
        [STORAGE_KEYS.LICENSE_EMAIL]: licenseEmails.amazonEmailId,
        [STORAGE_KEYS.OPERATOR_USERNAME]: licenseEmails.amazonEmailId,
        [STORAGE_KEYS.USER_EMAIL]: licenseEmails.emailId || licenseEmails.amazonEmailId,
      };
      if (preserved[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]) {
        resetValues[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] = preserved[STORAGE_KEYS.AMAZON_LOGIN_USERNAME];
      }
      if (preserved[STORAGE_KEYS.PASSWORD]) {
        resetValues[STORAGE_KEYS.PASSWORD] = preserved[STORAGE_KEYS.PASSWORD];
      }

      await state.resetLocal(resetValues);
      currentLicense = null;
      if (elements.city) elements.city.value = RESET_DEFAULTS[STORAGE_KEYS.SELECTED_CITY];
      if (elements.distance) elements.distance.value = RESET_DEFAULTS[STORAGE_KEYS.DISTANCE];
      setSelectedValues(elements.jobType, RESET_DEFAULTS[STORAGE_KEYS.JOB_TYPE]);
      setLogModeUi(RESET_DEFAULTS[STORAGE_KEYS.LOG_MODE]);
      setDirectApplicationModeUi(RESET_DEFAULTS[STORAGE_KEYS.USE_DIRECT_APPLICATION] !== false);
      if (elements.intervalValue) elements.intervalValue.value = RESET_DEFAULTS[STORAGE_KEYS.FETCH_INTERVAL_VALUE];
      if (elements.intervalUnit) elements.intervalUnit.value = RESET_DEFAULTS[STORAGE_KEYS.FETCH_INTERVAL_UNIT];
      if (elements.activate) elements.activate.checked = false;
      await syncRuntimeControlsToStorage({ forceDefaults: true });
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
