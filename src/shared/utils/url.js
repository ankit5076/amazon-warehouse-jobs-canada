/* URL helpers for Amazon hiring routes. */
(function (root) {
  'use strict';

  if (root.AMZ_URL) return;

  const { AMAZON } = root.AMZ_CONSTANTS || {};
  const SENSITIVE_URL_PARAM_NAMES = Object.freeze([
    'applicationid',
    'candidateid',
    'email',
    'username',
    'password',
    'pin',
  ]);
  const SENSITIVE_URL_PARAM_FRAGMENTS = Object.freeze([
    'captcha',
    'csrf',
    'secret',
    'session',
    'token',
    'waf',
  ]);

  function currentUrl() {
    return typeof window !== 'undefined' ? window.location.href : '';
  }

  function includesAny(value, fragments) {
    return typeof value === 'string' && (fragments || []).some(fragment => value.includes(fragment));
  }

  function getParsedUrl(url = currentUrl()) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  function hasAppHashRoute(url, route) {
    if (typeof url !== 'string') return false;
    if (url.includes('/app#' + route)) return true;

    const parsed = getParsedUrl(url);
    return Boolean(
      parsed &&
      parsed.pathname.endsWith('/app') &&
      (parsed.hash === '#' + route || parsed.hash.startsWith('#' + route + '?'))
    );
  }

  function isApplicationPage(url = currentUrl()) {
    const parsed = getParsedUrl(url);
    return Boolean(
      typeof url === 'string' &&
      (
        includesAny(url, AMAZON?.APPLICATION_PATH_SEGMENTS || []) ||
        parsed?.pathname === '/application' ||
        parsed?.pathname?.startsWith('/application/')
      ) &&
      url.includes('jobId=')
    );
  }

  function isCountryApplicationPage(url = currentUrl()) {
    const parsed = getParsedUrl(url);
    const pathname = parsed?.pathname || '';
    const normalizedPathname = pathname.endsWith('/') ? pathname : pathname + '/';
    return Boolean(
      parsed &&
      (AMAZON?.APPLICATION_PATH_SEGMENTS || []).includes(normalizedPathname) &&
      getJobIdFromUrl(url)
    );
  }

  function getApplicationRouteName(url = currentUrl()) {
    const parsed = getParsedUrl(url);
    const hash = parsed?.hash || '';
    return hash.replace(/^#\/?/, '').split('?')[0].toLowerCase();
  }

  function isApplicationFormPage(url = currentUrl()) {
    if (!isApplicationPage(url)) return false;

    const route = getApplicationRouteName(url);
    if (route === 'consent' || route.startsWith('consent/')) return true;
    if (!isCountryApplicationPage(url)) return false;
    return /^(general-questions|self-identification|application-experience)(\/|$)/i
      .test(route);
  }

  function isFinalApplicationFormPage(url = currentUrl()) {
    if (!isApplicationPage(url)) return false;
    const context = getApplicationContextFromUrl(url);
    if (!context.applicationId) return false;
    return /^(general-questions|self-identification|application-experience)(\/|$)/i
      .test(getApplicationRouteName(url));
  }

  function isSensitiveUrlParamName(name) {
    const normalized = String(name || '').trim().toLowerCase().replace(/[-_]/g, '');
    return Boolean(
      SENSITIVE_URL_PARAM_NAMES.includes(normalized) ||
      SENSITIVE_URL_PARAM_FRAGMENTS.some(fragment => normalized.includes(fragment))
    );
  }

  function removeSensitiveUrlParams(searchParams) {
    [...searchParams.keys()].forEach(key => {
      if (isSensitiveUrlParamName(key)) searchParams.delete(key);
    });
  }

  function sanitizeNotificationUrl(url = currentUrl()) {
    const parsed = getParsedUrl(url);
    if (!parsed) return String(url || '');

    removeSensitiveUrlParams(parsed.searchParams);

    const hash = parsed.hash || '';
    const queryStart = hash.indexOf('?');
    if (queryStart >= 0) {
      const hashRoute = hash.slice(1, queryStart);
      const hashParams = new URLSearchParams(hash.slice(queryStart + 1));
      removeSensitiveUrlParams(hashParams);
      const sanitizedHashQuery = hashParams.toString();
      parsed.hash = '#' + hashRoute + (sanitizedHashQuery ? '?' + sanitizedHashQuery : '');
    }

    return parsed.toString();
  }

  function isJobSearchPage(url = currentUrl()) {
    return hasAppHashRoute(url, '/jobSearch');
  }

  function isJobDetailPage(url = currentUrl()) {
    return hasAppHashRoute(url, '/jobDetail') && typeof url === 'string' && url.includes('jobId=');
  }

  function isLoginPage(url = currentUrl()) {
    return typeof url === 'string' && url.includes('#/login');
  }

  function isContactInfoPage(url = currentUrl()) {
    return typeof url === 'string' && url.includes('#/contactInformation');
  }

  function isSkipPage(url = currentUrl()) {
    return includesAny(url, AMAZON?.SKIP_PAGE_FRAGMENTS || []);
  }

  function getJobIdFromUrl(url = currentUrl()) {
    try {
      const parsed = new URL(url);
      const direct = parsed.searchParams.get('jobId');
      if (direct) return direct;

      const hash = parsed.hash || '';
      const queryStart = hash.indexOf('?');
      if (queryStart < 0) return null;

      return new URLSearchParams(hash.slice(queryStart + 1)).get('jobId');
    } catch (_) {
      return null;
    }
  }

  function getHashSearchParams(parsed) {
    const hash = parsed?.hash || '';
    const queryStart = hash.indexOf('?');
    if (queryStart < 0) return new URLSearchParams();
    return new URLSearchParams(hash.slice(queryStart + 1));
  }

  function getUrlParam(parsed, hashParams, name) {
    return parsed.searchParams.get(name) || hashParams.get(name) || null;
  }

  function getApplicationContextFromUrl(url = currentUrl()) {
    try {
      const parsed = getParsedUrl(url);
      if (!parsed) throw new Error('Invalid URL');
      const hashParams = getHashSearchParams(parsed);
      return {
        href: parsed.href,
        origin: parsed.origin,
        pathname: parsed.pathname,
        country: getUrlParam(parsed, hashParams, 'country'),
        locale: getUrlParam(parsed, hashParams, 'locale'),
        applicationId: getUrlParam(parsed, hashParams, 'applicationId'),
        jobId: getUrlParam(parsed, hashParams, 'jobId'),
        page: getUrlParam(parsed, hashParams, 'page'),
        scheduleId: getUrlParam(parsed, hashParams, 'scheduleId'),
      };
    } catch (_) {
      return {
        href: String(url || ''),
        origin: null,
        pathname: null,
        country: null,
        locale: null,
        applicationId: null,
        jobId: null,
        page: null,
        scheduleId: null,
      };
    }
  }

  function getScheduleIdFromUrl(url = currentUrl()) {
    return getApplicationContextFromUrl(url).scheduleId;
  }

  function buildJobDetailUrl(jobId, countryConfig = AMAZON?.COUNTRY_CONFIG) {
    if (!jobId || !countryConfig) return null;
    return (
      'https://' +
      countryConfig.domain +
      '/app#/jobDetail?jobId=' +
      encodeURIComponent(jobId) +
      '&locale=' +
      encodeURIComponent(countryConfig.locale)
    );
  }

  function buildApplicationPreConsentUrl(jobId, scheduleId, countryConfig = AMAZON?.COUNTRY_CONFIG) {
    if (!jobId || !scheduleId || !countryConfig) return null;
    return (
      'https://' +
      countryConfig.domain +
      '/application/?jobId=' +
      encodeURIComponent(jobId) +
      '&page=pre-consent&scheduleId=' +
      encodeURIComponent(scheduleId) +
      '&locale=' +
      encodeURIComponent(countryConfig.locale) +
      '&country=' +
      encodeURIComponent(countryConfig.applicationCountryPath)
    );
  }

  root.AMZ_URL = Object.freeze({
    currentUrl,
    includesAny,
    isApplicationPage,
    isCountryApplicationPage,
    getApplicationRouteName,
    isApplicationFormPage,
    isFinalApplicationFormPage,
    sanitizeNotificationUrl,
    isJobSearchPage,
    isJobDetailPage,
    isLoginPage,
    isContactInfoPage,
    isSkipPage,
    getJobIdFromUrl,
    getApplicationContextFromUrl,
    getScheduleIdFromUrl,
    buildJobDetailUrl,
    buildApplicationPreConsentUrl,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
