/*
 * Static configuration for the Amazon shift automation extension.
 *
 * This file is intentionally configuration-only. Runtime behavior lives in
 * shared services, content controllers, popup controllers, and background
 * services. Every execution context loads this file before using config.
 */
(function (root) {
  'use strict';

  if (root.AMZ_CONSTANTS) return;

  const STORAGE_KEYS = Object.freeze({
    ACTIVE: '__ap',
    OPERATOR_USERNAME: '__amz_operator_username',
    ADMIN_SESSION_TOKEN: '__amz_admin_session_token',
    USERNAME: '__amz_username',
    USER_EMAIL: '__un',
    LICENSE_BUYER_EMAIL: '__amz_license_buyer_email',
    LICENSE_AMAZON_EMAIL: '__amz_license_amazon_email',
    LICENSE_EMAIL: '__amz_license_email',
    LICENSE_STATE: '__amz_license_state',
    LICENSE_USAGE_KEYS: '__amz_license_usage_keys',
    LEGACY_USER_EMAIL: 'userEmail',
    AMAZON_LOGIN_USERNAME: '__amz_login_username',
    PASSWORD: '__pw',
    SELECTED_CLIENT_ID: '__amz_selected_client_id',
    SELECTED_CLIENT_LABEL: '__amz_selected_client_label',
    SELECTED_CITY: 'selectedCity',
    ALL_CITIES_SELECTED: 'allCitiesSelected',
    LATITUDE: 'lat',
    LONGITUDE: 'lng',
    DISTANCE: 'distance',
    JOB_TYPE: 'jobType',
    CITY_TAGS: 'cityTags',
    FETCH_INTERVAL_VALUE: 'fetchIntervalValue',
    FETCH_INTERVAL_UNIT: 'fetchIntervalUnit',
    FETCH_INTERVAL_MIN_MS: 'fetchIntervalMinMs',
    JOB_SEARCH_FALLBACK_DISTANCE_KM: 'jobSearchFallbackDistanceKm',
    JOB_SEARCH_FETCH_TIMEOUT_MS: 'jobSearchFetchTimeoutMs',
    PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS: 'pageRefreshJobSearchIntervalMs',
    LAST_MATCHED_JOB: 'lastMatchedJob',
    LAST_SELECTED_SCHEDULE: 'lastSelectedSchedule',
    DETECTED_EMAILS: 'detectedEmails',
    AUTH_PROBE_STATUS: 'authProbeStatus',
    AUTH_PROBE_UPDATED_AT: 'authProbeUpdatedAt',
    AUTH_PROBE_HTTP_STATUS: 'authProbeHttpStatus',
    AUTH_PROBE_DETAIL: 'authProbeDetail',
    LOG_MODE: 'logMode',
    USE_DIRECT_APPLICATION: 'useDirectApplication',
    DIRECT_APPLICATION_RESULT: 'directApplicationResult',
    APPLICATION_ATTEMPT_TRACE: 'applicationAttemptTrace',
    NOTIFICATION_QUEUE: 'notificationQueue',
  });

  const MESSAGE_ACTIONS = Object.freeze({
    ACTIVATE: 'activate',
    BACKEND_REQUEST: 'backend_request',
    EXTENSION_STATE_CHANGED: 'extension_state_changed',
    NOTIFICATION_EVENT: 'notification_event',
  });

  const USERNAME_REGEX = /\S/;
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const isCanada = true;

  const COUNTRY_CONFIGS = Object.freeze({
    CA: Object.freeze({
      domain: 'hiring.amazon.ca',
      authDomain: 'auth.hiring.amazon.ca',
      loginUrl: 'https://hiring.amazon.ca/app#/login',
      applicationCountryPath: 'ca',
      locale: 'en-CA',
      country: 'Canada',
      countryCode: 'CA',
      search: Object.freeze({
        includeGeoQueryClause: true,
        includeHoursPerWeekRange: false,
        includeConsolidateSchedule: false,
        equalFilters: Object.freeze([]),
        sorters: Object.freeze([
          Object.freeze({ fieldName: 'totalPayRateMax', ascending: 'false' }),
        ]),
      }),
    }),
    US: Object.freeze({
      domain: 'hiring.amazon.com',
      authDomain: 'auth.hiring.amazon.com',
      loginUrl: 'https://auth.hiring.amazon.com/#/login',
      applicationCountryPath: 'us',
      locale: 'en-US',
      country: 'United States',
      countryCode: 'US',
      search: Object.freeze({
        includeGeoQueryClause: false,
        includeHoursPerWeekRange: true,
        includeConsolidateSchedule: true,
        equalFilters: Object.freeze([
          Object.freeze({ key: 'scheduleRequiredLanguage', val: 'en-US' }),
        ]),
        sorters: Object.freeze([
          Object.freeze({ fieldName: 'totalPayRateMax', ascending: 'false' }),
        ]),
      }),
    }),
  });

  const ACTIVE_COUNTRY_CONFIG = isCanada ? COUNTRY_CONFIGS.CA : COUNTRY_CONFIGS.US;

  const JOB_TYPE_VALUES = Object.freeze([
    'FULL_TIME',
    'PART_TIME',
    'FLEX_TIME',
    'REDUCED_TIME',
  ]);

  const CA_CITY_COORDINATES = Object.freeze({
    'Acheson': Object.freeze({ lat: 53.548701, lng: -113.76261 }),
    'Ajax': Object.freeze({ lat: 43.850814, lng: -79.020296 }),
    'Balzac': Object.freeze({ lat: 51.212985, lng: -114.007862 }),
    'Barrhaven': Object.freeze({ lat: 45.274975, lng: -75.741947 }),
    'Belleville': Object.freeze({ lat: 44.162758, lng: -77.383232 }),
    'Bolton': Object.freeze({ lat: 43.875473, lng: -79.734437 }),
    'Brampton': Object.freeze({ lat: 43.685271, lng: -79.759924 }),
    'Burnaby': Object.freeze({ lat: 49.248809, lng: -122.980511 }),
    'Calgary': Object.freeze({ lat: 51.045113, lng: -114.057141 }),
    'Cambridge': Object.freeze({ lat: 43.361621, lng: -80.314429 }),
    'Concord': Object.freeze({ lat: 43.80011, lng: -79.48291 }),
    'Coquitlam': Object.freeze({ lat: 49.283762, lng: -122.793206 }),
    'Dartmouth': Object.freeze({ lat: 44.67134, lng: -63.57719 }),
    'Delta': Object.freeze({ lat: 49.084721, lng: -123.058626 }),
    'Edmonton': Object.freeze({ lat: 53.54545, lng: -113.49014 }),
    'Etobicoke': Object.freeze({ lat: 43.65421, lng: -79.56711 }),
    'Hamilton': Object.freeze({ lat: 43.25549, lng: -79.873376 }),
    'Kitchener': Object.freeze({ lat: 43.45164, lng: -80.492533 }),
    'Langley': Object.freeze({ lat: 49.104177, lng: -122.660351 }),
    'London': Object.freeze({ lat: 42.984923, lng: -81.245277 }),
    'Mississauga': Object.freeze({ lat: 43.58882, lng: -79.644378 }),
    'New Westminster': Object.freeze({ lat: 49.205718, lng: -122.910956 }),
    'Nisku': Object.freeze({ lat: 53.337845, lng: -113.531304 }),
    'Oakville': Object.freeze({ lat: 43.467517, lng: -79.687666 }),
    'Ottawa': Object.freeze({ lat: 45.425226, lng: -75.699963 }),
    'Pitt Meadows': Object.freeze({ lat: 49.219322, lng: -122.68973 }),
    'Richmond': Object.freeze({ lat: 49.166589, lng: -123.133569 }),
    'Richmond Hill': Object.freeze({ lat: 43.88284, lng: -79.44028 }),
    'Rocky View': Object.freeze({ lat: 51.18341, lng: -113.93527 }),
    'Rocky View County': Object.freeze({ lat: 51.18341, lng: -113.93527 }),
    'Scarborough': Object.freeze({ lat: 43.773077, lng: -79.257774 }),
    'Sidney': Object.freeze({ lat: 48.650629, lng: -123.398604 }),
    'ST. Thomas': Object.freeze({ lat: 42.777414, lng: -81.182973 }),
    'Stoney Creek': Object.freeze({ lat: 43.21681, lng: -79.76633 }),
    'Toronto': Object.freeze({ lat: 43.653524, lng: -79.383907 }),
    'Tsawwassen First Nation': Object.freeze({ lat: 49.032088, lng: -123.085579 }),
    'Vancouver': Object.freeze({ lat: 49.261636, lng: -123.11335 }),
    'Vaughan': Object.freeze({ lat: 43.849270138, lng: -79.535136594 }),
    'Whitby': Object.freeze({ lat: 43.897858, lng: -78.943434 }),
    'Windsor': Object.freeze({ lat: 42.317438, lng: -83.035225 }),
    'Winnipeg': Object.freeze({ lat: 49.895422, lng: -97.138514 }),
    'Belgrade': Object.freeze({ lat: 45.776196, lng: -111.177155 }),
  });

  const CA_DEFAULT_CITY_TAGS = Object.freeze([
    'Bolton',
    'Brampton',
    'Burnaby',
    'Cambridge',
    'Concord',
    'Toronto',
    'Sidney',
    'Balzac',
    'Acheson',
    'Barrhaven',
    'Belleville',
    'Dartmouth',
    'Delta',
    'Vancouver',
    'Windsor',
    'Ottawa',
    'Rocky View',
    'Rocky View County',
    'Coquitlam',
    'Edmonton',
    'Calgary',
    'Etobicoke',
    'Hamilton',
    'Kitchener',
    'Langley',
    'London',
    'Mississauga',
    'New Westminster',
    'Nisku',
    'Oakville',
    'Pitt Meadows',
    'Richmond',
    'Richmond Hill',
    'Scarborough',
    'ST. Thomas',
    'Stoney Creek',
    'Tsawwassen First Nation',
    'Whitby',
    'Winnipeg',
  ]);

  const DISTANCE_OPTIONS = Object.freeze([
    Object.freeze({ value: '5', label: '5' }),
    Object.freeze({ value: '15', label: '15' }),
    Object.freeze({ value: '25', label: '25' }),
    Object.freeze({ value: '35', label: '35' }),
    Object.freeze({ value: '50', label: '50' }),
    Object.freeze({ value: '75', label: '75' }),
    Object.freeze({ value: '150', label: '150' }),
    Object.freeze({ value: '25000', label: 'Entire Country' }),
  ]);

  const LOCAL_RUNTIME_DEFAULTS = Object.freeze({
    cityCoordinates: CA_CITY_COORDINATES,
    defaultCityTags: CA_DEFAULT_CITY_TAGS,
    cityOptions: Object.freeze(Object.keys(CA_CITY_COORDINATES).sort()),
    distanceOptions: DISTANCE_OPTIONS,
    jobTypeOptions: JOB_TYPE_VALUES,
    defaultInputs: Object.freeze({
      selectedCity: 'Sidney',
      distance: '150',
      jobType: JOB_TYPE_VALUES,
    }),
    fetchInterval: Object.freeze({
      defaultUnit: 'ms',
      defaultSValue: '1',
      defaultMsValue: 650,
    }),
    jobSearch: Object.freeze({
      fallbackDistanceKm: 5,
      fetchTimeoutMs: 15000,
    }),
    pageRefresh: Object.freeze({
      jobSearchIntervalMs: 120000,
    }),
    features: Object.freeze({
      polling: true,
      scheduleAutomation: true,
      directApplication: true,
      telegram: true,
    }),
  });

  const AUTH_PROBE = Object.freeze({
    COUNTRY_CODE: ACTIVE_COUNTRY_CONFIG.countryCode,
    CSRF_URL: 'https://' + ACTIVE_COUNTRY_CONFIG.domain +
      '/authorize/api/csrf?countryCode=' + ACTIVE_COUNTRY_CONFIG.countryCode,
    AUTHORIZE_URL: 'https://' + ACTIVE_COUNTRY_CONFIG.domain +
      '/authorize/api/authorize?countryCode=' + ACTIVE_COUNTRY_CONFIG.countryCode,
    REDIRECT_URL: ACTIVE_COUNTRY_CONFIG.domain,
    FETCH_TIMEOUT_MS: 15000,
    ROUTE_RECHECK_DELAY_MS: 750,
    NOT_AUTHENTICATED_HTTP_STATUSES: Object.freeze([401, 403]),
    STATUSES: Object.freeze({
      CHECKING: 'checking',
      AUTHENTICATED: 'authenticated',
      NOT_AUTHENTICATED: 'not_authenticated',
      UNKNOWN: 'unknown',
    }),
    LABELS: Object.freeze({
      checking: 'Checking Amazon session…',
      authenticated: 'Amazon session authenticated',
      not_authenticated: 'Amazon session not authenticated',
      unknown: 'Unable to verify Amazon session',
    }),
    HINTS: Object.freeze({
      checking: 'Authenticity is checked after each job-search page refresh.',
      authenticated: 'The latest refresh-based authorize check succeeded.',
      not_authenticated: 'Polling stops and the Amazon login page opens until the session recovers.',
      unknown: 'Polling stops until the Amazon session can be verified again.',
    }),
  });

  const IDENTITY = Object.freeze({
    EMAIL_DISCOVERY_REGEX: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  });

  const TEXT_LIMITS = Object.freeze({
    DEFAULT_COMPACT_LENGTH: 140,
    BUTTON_CLASSNAME_LENGTH: 120,
  });

  const LOGGING = Object.freeze({
    DEFAULT_MODE: 'standard',
    HIGH_FREQUENCY_THROTTLE_MS: 2000,
    POLLING_SUCCESS_THROTTLE_MS: 30000,
    MODES: Object.freeze({
      OFF: 'off',
      STANDARD: 'standard',
      DEBUG: 'debug',
    }),
    LEVELS: Object.freeze({
      EVENT: 'event',
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
      DEBUG: 'debug',
      TRACE: 'trace',
    }),
    CONSOLE_METHOD_BY_LEVEL: Object.freeze({
      event: 'log',
      info: 'info',
      warn: 'warn',
      error: 'error',
      debug: 'debug',
      trace: 'debug',
    }),
    STANDARD_LEVELS: Object.freeze([
      'event',
      'info',
      'warn',
      'error',
    ]),
    DEBUG_LEVELS: Object.freeze([
      'event',
      'info',
      'warn',
      'error',
      'debug',
      'trace',
    ]),
  });

  const INSTALL_DEFAULTS = Object.freeze({
    $active: false,
    [STORAGE_KEYS.ACTIVE]: false,
    __fq: 0.5,
    __gp: 3,
    __tdgp: 3,
    [STORAGE_KEYS.SELECTED_CITY]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.selectedCity,
    [STORAGE_KEYS.ALL_CITIES_SELECTED]: false,
    [STORAGE_KEYS.DISTANCE]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.distance,
    [STORAGE_KEYS.JOB_TYPE]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.jobType,
    [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: String(LOCAL_RUNTIME_DEFAULTS.fetchInterval.defaultMsValue),
    [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: LOCAL_RUNTIME_DEFAULTS.fetchInterval.defaultUnit,
    [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 0,
    [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: String(LOCAL_RUNTIME_DEFAULTS.jobSearch.fallbackDistanceKm),
    [STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]: LOCAL_RUNTIME_DEFAULTS.jobSearch.fetchTimeoutMs,
    [STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]: LOCAL_RUNTIME_DEFAULTS.pageRefresh.jobSearchIntervalMs,
    [STORAGE_KEYS.OPERATOR_USERNAME]: '',
    [STORAGE_KEYS.ADMIN_SESSION_TOKEN]: '',
    [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: '',
    [STORAGE_KEYS.SELECTED_CLIENT_ID]: '',
    [STORAGE_KEYS.SELECTED_CLIENT_LABEL]: '',
    [STORAGE_KEYS.CITY_TAGS]: LOCAL_RUNTIME_DEFAULTS.defaultCityTags,
    [STORAGE_KEYS.LOG_MODE]: LOGGING.DEFAULT_MODE,
    [STORAGE_KEYS.USE_DIRECT_APPLICATION]: true,
    [STORAGE_KEYS.NOTIFICATION_QUEUE]: [],
  });

  const RESET_DEFAULTS = Object.freeze({
    [STORAGE_KEYS.ACTIVE]: false,
    [STORAGE_KEYS.OPERATOR_USERNAME]: '',
    [STORAGE_KEYS.ADMIN_SESSION_TOKEN]: '',
    [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: '',
    [STORAGE_KEYS.SELECTED_CLIENT_ID]: '',
    [STORAGE_KEYS.SELECTED_CLIENT_LABEL]: '',
    [STORAGE_KEYS.SELECTED_CITY]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.selectedCity,
    [STORAGE_KEYS.ALL_CITIES_SELECTED]: false,
    [STORAGE_KEYS.LATITUDE]: null,
    [STORAGE_KEYS.LONGITUDE]: null,
    [STORAGE_KEYS.DISTANCE]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.distance,
    [STORAGE_KEYS.JOB_TYPE]: LOCAL_RUNTIME_DEFAULTS.defaultInputs.jobType,
    [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: String(LOCAL_RUNTIME_DEFAULTS.fetchInterval.defaultMsValue),
    [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: LOCAL_RUNTIME_DEFAULTS.fetchInterval.defaultUnit,
    [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 0,
    [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: String(LOCAL_RUNTIME_DEFAULTS.jobSearch.fallbackDistanceKm),
    [STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]: LOCAL_RUNTIME_DEFAULTS.jobSearch.fetchTimeoutMs,
    [STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]: LOCAL_RUNTIME_DEFAULTS.pageRefresh.jobSearchIntervalMs,
    [STORAGE_KEYS.CITY_TAGS]: LOCAL_RUNTIME_DEFAULTS.defaultCityTags,
    [STORAGE_KEYS.LOG_MODE]: LOGGING.DEFAULT_MODE,
    [STORAGE_KEYS.USE_DIRECT_APPLICATION]: true,
    [STORAGE_KEYS.NOTIFICATION_QUEUE]: [],
  });

  const BACKEND = Object.freeze({
    BASE_URL: 'https://getslotnow.com/administrator-api/api/amazon-warehouse-jobs-canada',
    PRODUCT_ID: 'amazon-warehouse-jobs-canada',
    PRODUCT_NAME: 'Amazon Warehouse Jobs Canada',
    COUNTRY: 'Canada',
    DEFAULT_LICENSE_SYNC_INTERVAL_MS: 15 * 60 * 1000,
    DEFAULTS_CACHE_KEY: '__amz_defaults_v1',
    RUNTIME_CACHE_KEY: '__amz_runtime_policy_v1',
    AUTH_HEADER: 'X-Tracker-Admin-Session',
    AUTH_ENDPOINTS: Object.freeze({
      LOGIN: '/auth/login',
      SESSION: '/auth/session',
    }),
    ENDPOINTS: Object.freeze({
      LICENSE_CHECK: '/license/check',
      CHECKOUT: '/license/checkout',
      USAGE: '/license/usage',
      RUNTIME: '/runtime',
      DEFAULTS: '/config/defaults',
      TELEGRAM: '/notifications/telegram',
      CLIENTS: '/clients',
      APPLICATION_ATTEMPTS: '/application-attempts',
      SCHEDULE_COOLDOWN: '/application-attempts/schedule-cooldown',
    }),
    FALLBACK_DEFAULTS: LOCAL_RUNTIME_DEFAULTS,
  });

  const AMAZON = Object.freeze({
    isCanada,
    JOB_TYPE_VALUES,
    PAGE_PATTERNS: Object.freeze([
      'https://hiring.amazon.ca/*',
      'https://hiring.amazon.com/*',
      '*://auth.hiring.amazon.com/*',
      '*://auth.hiring.amazon.ca/*',
    ]),
    APPLICATION_PATH_SEGMENTS: Object.freeze(['/application/ca/', '/application/us/']),
    SKIP_PAGE_FRAGMENTS: Object.freeze(['already-applied-but-can-be-reset', 'consent']),
    URLS: Object.freeze({
      JOB_SEARCH: 'https://' + ACTIVE_COUNTRY_CONFIG.domain + '/app#/jobSearch',
      LOGIN: ACTIVE_COUNTRY_CONFIG.loginUrl,
      CREATE_APPLICATION:
        'https://' +
        ACTIVE_COUNTRY_CONFIG.domain +
        '/application/' +
        ACTIVE_COUNTRY_CONFIG.applicationCountryPath +
        '/?country=' +
        ACTIVE_COUNTRY_CONFIG.applicationCountryPath,
    }),
    COUNTRY_CONFIGS,
    COUNTRY_CONFIG: ACTIVE_COUNTRY_CONFIG,
    GRAPHQL: Object.freeze({
      URL: 'https://' + ACTIVE_COUNTRY_CONFIG.domain + '/graphql',
      OPERATION_NAME: 'searchJobCardsByLocation',
      SCHEDULE_OPERATION_NAME: 'searchScheduleCards',
      PAGE_SIZE: 100,
      SCHEDULE_PAGE_SIZE: 1000,
      REQUEST_JITTER_MS: 50,
      GEO_UNIT: 'km',
      HOURS_PER_WEEK_RANGE: Object.freeze({ minimum: 0, maximum: 80 }),
      SEARCH_CONFIG: Object.freeze({
        EMPTY_KEYWORDS: '',
        PRIVATE_SCHEDULE_FILTER_KEY: 'isPrivateSchedule',
        PRIVATE_SCHEDULE_FILTER_VALUE: 'false',
        JOB_TYPE_FILTER_KEY: 'jobType',
        JOB_TYPE_FILTER_VALUES: Object.freeze({
          FULL_TIME: 'Full-time',
          PART_TIME: 'Part-time',
        }),
        HOURS_PER_WEEK_FILTER_KEY: 'hoursPerWeek',
        FIRST_DAY_FILTER_KEY: 'firstDayOnSite',
        CONSOLIDATE_SCHEDULE: true,
      }),
      REQUEST_HEADERS: Object.freeze({
        accept: '*/*',
        'content-type': 'application/json',
        iscanary: 'false',
      }),
      QUERY: `query searchJobCardsByLocation($searchJobRequest: SearchJobRequest!) {
        searchJobCardsByLocation(searchJobRequest: $searchJobRequest) {
          nextToken
          jobCards {
            jobId
            jobTitle
            jobType
            jobTypeL10N
            employmentType
            employmentTypeL10N
            city
            state
            postalCode
            locationName
            totalPayRateMin
            totalPayRateMax
            totalPayRateMinL10N
            totalPayRateMaxL10N
            distance
            scheduleCount
            currencyCode
            geoClusterDescription
            payFrequency
            jobLocationType
          }
        }
      }`,
      SCHEDULE_QUERY: `query searchScheduleCards($searchScheduleRequest: SearchScheduleRequest!) {
        searchScheduleCards(searchScheduleRequest: $searchScheduleRequest) {
          nextToken
          scheduleCards {
            hireStartDate
            address
            basePay
            bonusSchedule
            city
            currencyCode
            dataSource
            distance
            employmentType
            employmentTypeL10N
            externalJobTitle
            featuredSchedule
            firstDayOnSite
            firstDayOnSiteL10N
            hoursPerWeek
            image
            jobId
            jobPreviewVideo
            language
            postalCode
            priorityRank
            scheduleBannerText
            scheduleBusinessCategory
            scheduleBusinessCategoryL10N
            scheduleDescription
            scheduleId
            scheduleText
            scheduleType
            scheduleTypeL10N
            signOnBonus
            signOnBonusL10N
            state
            surgePay
            tagLine
            totalPayRate
            totalPayRateL10N
            payFrequency
            requiredLanguage
            siteId
            vendorId
            vendorName
          }
        }
      }`,
    }),
  });

  const SELECTORS = Object.freeze({
    LOGIN_INPUT: 'input[data-test-id="input-test-id-login"]',
    PIN_INPUT: 'input[data-test-id="input-test-id-pin"]',
    CONTINUE_BUTTON: 'button[data-test-id="button-continue"]',
    EMAIL_INPUTS: 'input[type="email"], input[data-test-id="input-test-id-emailId"]',
    MAILTO_LINKS: 'a[href^="mailto:"]',
    BUTTONS: 'button',
    CREATE_APPLICATION_ROW_TEXT: 'div[data-test-component="StencilReactRow"]',
    SCHEDULE_CARD_ROOT: '[data-test-component="StencilReactCard"]',
    SCHEDULE_APPLY_BUTTON: 'button[data-test-id="ScheduleCardSelectScheduleLink"]',
    SCHEDULE_SELECT_BUTTON: 'button[data-test-id="jobDetailSelectScheduleButton"]',
    DESKTOP_APPLY_BUTTON: 'button[data-test-id="jobDetailApplyButtonDesktop"]',
    APPLY_BUTTONS:
      'button[data-test-id="ScheduleCardSelectScheduleLink"], button[data-test-id="jobDetailApplyButtonDesktop"]',
    SCHEDULE_LABEL: '.scheduleCardLabelText',
    SCHEDULE_EXPAND_LINK: 'div[data-test-component="StencilText"] em',
  });

  const DOM = Object.freeze({
    WAIT_TIMEOUT_MS: 10000,
    WAIT_INTERVAL_MS: 150,
  });

  const POPUP = Object.freeze({
    REFRESH_SUCCESS_DELAY_MS: 600,
  });

  const POLLING = Object.freeze({
    FALLBACK_DELAY_MS: 850,
    SCHEDULE_JITTER_MIN_MS: 200,
    SCHEDULE_JITTER_MAX_MS: 800,
    WAF_FORBIDDEN_BACKOFF_MS: 5000,
    AUTH_BACKOFF: Object.freeze({
      ERROR_THRESHOLD: 3,
      INTERVAL_MS: 2000,
      DURATION_MS: 60000,
      RECOVERY_SUCCESS_THRESHOLD: 2,
      AUTH_HTTP_STATUSES: Object.freeze([401]),
      AUTH_ERROR_PATTERNS: Object.freeze([
        'unauthorized',
        'forbidden',
        'not authorized',
        'not authenticated',
        'authentication',
        'authorization',
        'session',
        'token',
      ]),
    }),
  });

  const CREATE_APPLICATION = Object.freeze({
    NATIVE_CLICK_DELAY_MS: 500,
    POST_NEXT_RESCAN_MS: 2000,
    POST_ACTION_RESCAN_MS: 250,
    ROUTE_CHANGE_RESCAN_MS: 50,
    ROUTE_SCAN_INTERVAL_MS: 250,
    ROUTE_SCAN_TIMEOUT_MS: 15000,
    BUTTON_TEXT: Object.freeze({
      NEXT: 'Next',
      CREATE_APPLICATION: 'Create Application',
      START_APPLICATION: 'Start application',
      SELECT_THIS_JOB: 'Select this job',
    }),
    INJECTION_FILES: Object.freeze([
      'shared/constants.js',
      'shared/utils/logger.js',
      'shared/utils/text.js',
      'shared/utils/url.js',
      'shared/utils/storage.js',
      'content/utils/dom.js',
      'content/utils/direct-application-guard.js',
      'content/utils/direct-application-mode.js',
      'shared/utils/license-api.js',
      'shared/utils/license-state.js',
      'shared/utils/payment-gate.js',
      'shared/api-client.js',
      'shared/validation.js',
      'shared/notifications.js',
      'content/createapp.js',
    ]),
  });

  const DIRECT_APPLICATION = Object.freeze({
    useDirectApplication: true,
    FETCH_TIMEOUT_MS: 15000,
    WAF_PREFLIGHT_ENABLED: true,
    WAF_PREFLIGHT_BLOCKING_ENABLED: false,
    RESERVATION_VERIFY_BEFORE_SUCCESS: false,
    SCHEDULE_VERIFY_BEFORE_CREATE: true,
    SCHEDULE_DETAIL_PREFETCH_ENABLED: true,
    JOB_DETAIL_PREFETCH_ENABLED: true,
    SCHEDULE_DETAIL_WORKFLOW_WAIT_MS: 250,
    WORKFLOW_WEBSOCKET_ENABLED: true,
    WORKFLOW_WEBSOCKET_OPEN_TIMEOUT_MS: 5000,
    WORKFLOW_WEBSOCKET_CLOSE_DELAY_MS: 250,
    WORKFLOW_EVENT_SOURCE: 'HVH-CA-UI',
    WORKFLOW_CURRENT_STEP_NAME: 'job-opportunities',
    WORKFLOW_DOMAIN_TYPE: 'CS',
    REDIRECT_AFTER_JOB_CONFIRM: true,
    REDIRECT_AFTER_SUCCESS: true,
    SELECTED_SCHEDULE_CONSENT_HANDOFF_ENABLED: true,
    POST_CREATE_CONFIRM_FAILURE_CONSENT_HANDOFF_ENABLED: true,
    CREATE_WITHOUT_SCHEDULE_FALLBACK_ENABLED: true,
    CONSENT_REDIRECT_DELAY_MS: 0,
    NO_AVAILABLE_SHIFT_REDIRECT_DELAY_MS: 0,
    FALLBACK_SELECTED_SCHEDULE_SESSION_KEY: 'scheduleNotAvailable',
    UNAVAILABLE_JOB_SEARCH_REDIRECT_DELAY_MS: 250,
    NAVIGATION_PAUSE_TTL_MS: 4 * 60 * 1000,
    ACTIVE_ATTEMPT_LOCK_TTL_MS: 4 * 60 * 1000,
    APPLICATION_OBSERVABILITY_PENDING_TTL_MS: 10 * 60 * 1000,
    ATTEMPT_LOCK_STORAGE_PREFIX: '__amz_direct_application_attempt_lock__',
    UNAVAILABLE_SCHEDULE_COOLDOWN_MS: 30 * 1000,
    UNAVAILABLE_SCHEDULE_STORAGE_PREFIX: '__amz_unavailable_schedule__',
    EXISTING_APPLICATION_COOLDOWN_MS: 10 * 60 * 1000,
    EXISTING_APPLICATION_STORAGE_PREFIX: '__amz_existing_application__',
    WORKFLOW_STEP_NAME: 'general-questions',
    WORKFLOW_STEP_UPDATE_ENABLED: true,
    CANDIDATE_ID_LOCAL_STORAGE_KEY: 'bbCandidateId',
    GUARD_STORAGE_PREFIX: '__amz_direct_application__',
    WAF: Object.freeze({
      PAGE_BRIDGE_RESOURCE: 'content/utils/direct-waf-bridge-page.js',
      MESSAGE_TYPES: Object.freeze({
        BRIDGE_PING: 'AMZ_DIRECT_WAF_BRIDGE_PING',
        BRIDGE_READY: 'AMZ_DIRECT_WAF_BRIDGE_READY',
        REQUEST_TOKEN: 'AMZ_DIRECT_WAF_TOKEN_REQUEST',
        TOKEN_RESULT: 'AMZ_DIRECT_WAF_TOKEN_RESULT',
        REQUEST_CAPTCHA: 'AMZ_DIRECT_WAF_CAPTCHA_REQUEST',
        CAPTCHA_STATUS: 'AMZ_DIRECT_WAF_CAPTCHA_STATUS',
        CAPTCHA_RESULT: 'AMZ_DIRECT_WAF_CAPTCHA_RESULT',
      }),
      INTEGRATION_WAIT_MS: 1200,
      RESPONSE_TIMEOUT_MS: 10000,
      BRIDGE_READY_TIMEOUT_MS: 1500,
      CAPTCHA_SOLVE_TIMEOUT_MS: 180000,
      CAPTCHA_DOM_WAIT_MS: 8000,
      CAPTCHA_SDK_LOAD_TIMEOUT_MS: 8000,
      CAPTCHA_CONFIG_BY_ORIGIN: Object.freeze({
        'https://hiring.amazon.ca': Object.freeze({
          sdkUrl: 'https://00480ef49626.edge.captcha-sdk.awswaf.com/00480ef49626/jsapi.js',
          apiKey: 'xn7Dx1luWAAETgXrk+n1hiAABgeYazrQ24toPRAfx3cqpJZ/QH+6eaC+p8hJKj6cK2tZCMyzApVHbVDV7O4lAsbkQxkMxFLcmwq2RmqjfZabVJfaEwPybYwif2aTIbig+9+6djN1+pYZaZDbu7I31swuyUaBDunwFFcrnIQ41FpLuAhpYtAV4Xd+QECfpejIcWX83J3eP8AU4M3vayLV20AobdlaGr1UBHFh5gOKHzg4NRiyBzxzFmHfScypslRkOW7JCM2L7OF5pdztRM/o56zPtejLi4bTnwM7nhrqZSKR6WZjNNk8Y3WzxLpV1jLrkEkD0SWTDkAHk2z7z///16OhM74RmyA/yW/9uHiMuXMEGPqzQC2hdVeZSN6QOdNhsMC8Mh+R34vEIARRpOUgAE6WP6pMiIdGi0HdMhgyPsx8uk022aGGKHSBB+o9fQYvRoy6E9v8K9BZAQMwai1WtodoV/G7B+ge09O8RtgC7iMd7Gk52iwm6qNTgNpfROUA9nu87PnxdPh4kmu7+kthTZRvzdWVSJrgFNIKT/qQ68x9ik0LE/ClFvZzFIq+kILzE4nrUUPH14+G9gp13t4LdbXae/jm7LObmvVDV/SPgBRIdsVOobjX/xfpbsuypUmHhvVo1Q20BYetViXkizLsvbIyfRu5Gh1QZ11p+yihyzc=_1_1',
        }),
      }),
      CAPTCHA_HTTP_STATUS: 405,
      CAPTCHA_HEADER_NAME: 'x-amzn-waf-action',
      CAPTCHA_HEADER_VALUE: 'captcha',
    }),
    JOB_CONFIRM_CAPTCHA_RECOVERY: Object.freeze({
      MAX_RETRIES: 2,
      RETRY_DELAY_MS: 0,
      TOKEN_WAIT_AFTER_CAPTCHA_MS: 0,
    }),
    STAGES: Object.freeze({
      STARTED: 'started',
      WAF_TOKEN_READY: 'waf-token-ready',
      WAF_TOKEN_UNAVAILABLE: 'waf-token-unavailable',
      CAPTCHA_REQUIRED: 'captcha-required',
      CAPTCHA_RENDER_REQUESTED: 'captcha-render-requested',
      CAPTCHA_PRESENTED: 'captcha-presented',
      CAPTCHA_SOLVED: 'captcha-solved',
      CAPTCHA_FAILED: 'captcha-failed',
      CANDIDATE_RESOLVED: 'candidate-resolved',
      SCHEDULE_VERIFIED: 'schedule-verified',
      SCHEDULE_UNAVAILABLE: 'schedule-unavailable',
      SCHEDULE_FALLBACK_CHECKED: 'schedule-fallback-checked',
      APPLICATION_CREATED: 'application-created',
      APPLICATION_CREATED_WITHOUT_SCHEDULE: 'application-created-without-schedule',
      APPLICATION_CREATED_WAITING_FOR_CONFIRM: 'application-created-waiting-for-confirm',
      JOB_CONFIRM_CAPTCHA_RETRYING: 'job-confirm-captcha-retrying',
      JOB_CONFIRMED: 'job-confirmed',
      RESERVATION_VERIFIED: 'reservation-verified',
      RESERVATION_VERIFICATION_FAILED: 'reservation-verification-failed',
      WORKFLOW_WS_STARTED: 'workflow-ws-started',
      WORKFLOW_WS_COMPLETED: 'workflow-ws-completed',
      WORKFLOW_WS_SKIPPED: 'workflow-ws-skipped',
      WORKFLOW_WS_FAILED: 'workflow-ws-failed',
      WORKFLOW_UPDATED: 'workflow-updated',
      WORKFLOW_UPDATE_SKIPPED: 'workflow-update-skipped',
      WORKFLOW_UPDATE_FAILED: 'workflow-update-failed',
      FAILED: 'failed',
    }),
    UI_FALLBACK_SUPPRESSION_STAGES: Object.freeze([
      'application-created',
      'application-created-waiting-for-confirm',
      'job-confirm-captcha-retrying',
      'captcha-render-requested',
      'captcha-presented',
      'captcha-solved',
      'captcha-failed',
      'schedule-verified',
      'schedule-unavailable',
      'schedule-fallback-checked',
      'job-confirmed',
      'application-created-without-schedule',
      'reservation-verified',
      'reservation-verification-failed',
      'workflow-ws-started',
      'workflow-ws-completed',
      'workflow-ws-skipped',
      'workflow-ws-failed',
      'workflow-updated',
      'workflow-update-skipped',
      'workflow-update-failed',
    ]),
    NAVIGATION_PAUSE_STAGES: Object.freeze([
      'application-created',
      'application-created-waiting-for-confirm',
      'job-confirm-captcha-retrying',
      'captcha-render-requested',
      'captcha-presented',
      'captcha-solved',
      'schedule-fallback-checked',
    ]),
    TERMINAL_SUCCESS_STAGES: Object.freeze([
      'job-confirmed',
      'application-created-without-schedule',
      'reservation-verified',
      'reservation-verification-failed',
      'workflow-ws-started',
      'workflow-ws-completed',
      'workflow-ws-skipped',
      'workflow-ws-failed',
      'workflow-updated',
      'workflow-update-skipped',
      'workflow-update-failed',
    ]),
    API_PATHS: Object.freeze({
      CANDIDATE: '/application/api/candidate-application/candidate',
      CREATE_APPLICATION: '/application/api/candidate-application/ds/create-application/',
      UPDATE_APPLICATION: '/application/api/candidate-application/update-application',
      UPDATE_WORKFLOW_STEP_NAME: '/application/api/candidate-application/update-workflow-step-name',
      APPLICATION_DETAILS: '/application/api/candidate-application/applications/',
      RESERVED_APPLICATION: '/application/api/candidate-application/applications/reserved/',
      CONFIG: '/application/api/config/',
      JOB_DETAIL: '/application/api/job/',
      SCHEDULE_DETAIL: '/application/api/job/get-schedule-details/',
      SCHEDULE_LIST: '/application/api/job/get-all-schedules/',
    }),
    REQUEST_FLAGS: Object.freeze({
      DSP_ENABLED: true,
      ACTIVE_APPLICATION_CHECK_ENABLED: true,
    }),
    REQUEST_HEADERS: Object.freeze({
      CANDIDATE: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
      }),
      APPLICATION: Object.freeze({
        accept: '*/*',
        'bb-ui-version': 'bb-ui-v2',
        'content-type': 'application/json;charset=UTF-8',
      }),
      WORKFLOW: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'content-type': 'application/json;charset=UTF-8',
      }),
      RESERVED_APPLICATION: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'Cache-Control': 'no-cache',
      }),
      CONFIG: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'Cache-Control': 'no-cache',
      }),
      SCHEDULE_DETAIL: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'Cache-Control': 'no-cache',
      }),
      SCHEDULE_LIST: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'content-type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-cache',
      }),
      JOB_DETAIL: Object.freeze({
        accept: 'application/json, text/plain, */*',
        'bb-ui-version': 'bb-ui-v2',
        'Cache-Control': 'no-cache',
      }),
    }),
    ERROR_CLASSIFICATIONS: Object.freeze({
      CAPTCHA_REQUIRED: 'captcha-required',
      AUTH_REQUIRED: 'auth-required',
      ALREADY_APPLIED: 'already-applied',
      RESETTABLE_EXISTING_APPLICATION: 'resettable-existing-application',
      ONE_ACTIVE_APPLICATION: 'one-active-application',
      EXACT_DUPLICATE_ACCOUNT: 'exact-duplicate-account',
      UNAVAILABLE_OR_RESERVATION_FAILED: 'unavailable-or-reservation-failed',
      SERVER_OR_PROXY_ERROR: 'server-or-proxy-error',
      NETWORK_OR_TIMEOUT: 'network-or-timeout',
      MALFORMED_RESPONSE: 'malformed-response',
      UNKNOWN: 'unknown',
    }),
    ERROR_CODE_HINTS: Object.freeze({
      ALREADY_APPLIED: Object.freeze(['APPLICATION_ALREADY_EXIST']),
      RESETTABLE_EXISTING_APPLICATION: Object.freeze([
        'APPLICATION_ALREADY_EXIST_CAN_BE_RESET',
      ]),
      ONE_ACTIVE_APPLICATION: Object.freeze([
        'ONE_ACTIVE_APPLICATION_PER_CANDIDATE_ALLOWED',
      ]),
      EXACT_DUPLICATE_ACCOUNT: Object.freeze(['EXACT_DUPLICATE_ACCOUNT']),
      UNAVAILABLE_OR_RESERVATION_FAILED: Object.freeze([
        'NO_AVAILABLE_SHIFT',
        'NO_ELIGIBLE_SCHEDULE',
        'NO_POSITION_IN_LOCATION',
        'CAN_NOT_OFFER_JOB',
        'SCHEDULE',
        'RESERV',
        'UNAVAILABLE',
      ]),
    }),
  });

  const SCHEDULE_AUTOMATION = Object.freeze({
    ATTEMPT_QUEUE_FALLBACK_MS: 100,
    FALLBACK_DELAY_MS: 3000,
    HARD_STOP_DELAY_MS: 12000,
    NO_APPLY_JOB_SEARCH_REDIRECT_DELAY_MS: 1500,
    POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS: 1500,
    POST_SCHEDULE_LABEL_APPLY_GRACE_MS: 1500,
    SCHEDULE_GRAPHQL_RECOVERY_ENABLED: true,
    RETRY_INTERVAL_MS: 500,
    APPLY_CLICK_GUARD_TTL_MS: 8000,
    SELECT_SCHEDULE_MAX_ATTEMPTS: 6,
    EXPAND_TO_LABEL_DELAY_MS: 150,
    LABEL_SELECTION_STRATEGIES: Object.freeze({
      RANDOM: 'random',
      FIRST: 'first',
    }),
    LABEL_SELECTION_STRATEGY: 'random',
  });

  const NOTIFICATIONS = Object.freeze({
    DEFAULT_DEDUPE_TTL_MS: 120000,
    QUEUE_LIMIT: 30,
    MAX_DELIVERY_ATTEMPTS: 3,
    DISPATCH_ACK_TIMEOUT_MS: 1000,
    CHANNELS: Object.freeze({
      TELEGRAM: 'telegram',
    }),
    SEVERITY: Object.freeze({
      INFO: 'info',
      SUCCESS: 'success',
      ERROR: 'error',
    }),
    EVENTS: Object.freeze({
      JOB_MATCHED: 'job_matched',
      JOB_FOUND: 'job_matched',
      BOOKED: 'booked',
      BOOKING_SUCCEEDED: 'booked',
      FORM_OPENED: 'form.opened',
      BOOKING_FAILED: 'booking.failed',
    }),
    STANDARD_EVENTS: Object.freeze([
      'job_matched',
      'booked',
    ]),
    EVENT_ALIASES: Object.freeze({
      'job.found': 'job_matched',
      'job.matched': 'job_matched',
      'booking.succeeded': 'booked',
      'booking.booked': 'booked',
    }),
    PHASE_BY_EVENT: Object.freeze({
      'job_matched': 'search',
      'job.matched': 'search',
      'job.found': 'search',
      'booked': 'verify',
      'booking.booked': 'verify',
      'booking.succeeded': 'verify',
      'form.opened': 'application',
      'booking.failed': 'application',
    }),
    STATUS_BY_EVENT: Object.freeze({
      'job_matched': 'succeeded',
      'job.matched': 'succeeded',
      'job.found': 'succeeded',
      'booked': 'succeeded',
      'booking.booked': 'succeeded',
      'booking.succeeded': 'succeeded',
      'form.opened': 'succeeded',
      'booking.failed': 'failed',
    }),
    SEVERITY_BY_EVENT: Object.freeze({
      'job_matched': 'info',
      'job.matched': 'info',
      'job.found': 'info',
      'booked': 'success',
      'booking.booked': 'success',
      'booking.succeeded': 'success',
      'form.opened': 'success',
      'booking.failed': 'error',
    }),
    DEDUPE_TTL_MS: Object.freeze({
      'job_matched': 5 * 60 * 1000,
      'job.matched': 5 * 60 * 1000,
      'job.found': 5 * 60 * 1000,
      'booked': 10 * 60 * 1000,
      'booking.booked': 10 * 60 * 1000,
      'booking.succeeded': 10 * 60 * 1000,
      'form.opened': 10 * 60 * 1000,
      'booking.failed': 2 * 60 * 1000,
    }),
  });

  const ALERTS = Object.freeze({
    JOB_FOUND_TOAST_DURATION_MS: 10000,
    MATCHING_PROGRESS_LABEL: 'Amazon returned jobs, checking filters',
    SOUND_FILE: 'assets/sounds/alert_long.wav',
    SESSION_UNAUTHORIZED_SOUND_FILE: 'assets/sounds/alert.wav',
    BOOKING_TERMINAL_SOUND_FILE: 'assets/sounds/alert.wav',
    JOB_FOUND_SOUND_VOLUME: 1,
    SESSION_UNAUTHORIZED_SOUND_VOLUME: 1,
    BOOKING_TERMINAL_SOUND_VOLUME: 1,
    SESSION_UNAUTHORIZED_LOGIN_REDIRECT_DELAY_MS: 2000,
  });

  const PAYMENT_GATE = Object.freeze({
    API_BASE_URL: 'https://getslotnow.com/extension-usage-tracker/api/amazon-warehouse-jobs-canada',
    PRODUCT_ID: 'amazon-warehouse-jobs-canada',
    COUNTRY: ACTIVE_COUNTRY_CONFIG.countryCode,
    EXTENSION_NAME: 'Amazon Warehouse Jobs Canada',
    DEFAULT_SYNC_INTERVAL_MS: 15 * 60 * 1000,
    RETRY_SYNC_INTERVAL_MS: 60 * 1000,
    BOOKING_CACHE_MAX_AGE_MS: 5 * 60 * 1000,
    ENDPOINTS: Object.freeze({
      CHECK: '/license/check',
      CHECKOUT: '/license/checkout',
      PLANS: '/license/plans',
      USAGE: '/license/usage',
    }),
  });

  root.AMZ_CONSTANTS = Object.freeze({
    isCanada,
    STORAGE_KEYS,
    MESSAGE_ACTIONS,
    USERNAME_REGEX,
    EMAIL_REGEX,
    AUTH_PROBE,
    IDENTITY,
    TEXT_LIMITS,
    LOGGING,
    INSTALL_DEFAULTS,
    RESET_DEFAULTS,
    BACKEND,
    AMAZON,
    SELECTORS,
    DOM,
    POPUP,
    POLLING,
    CREATE_APPLICATION,
    DIRECT_APPLICATION,
    SCHEDULE_AUTOMATION,
    NOTIFICATIONS,
    PAYMENT_GATE,
    ALERTS,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
