/* Shared Supabase credit gate. Keep this file byte-identical across paid extensions. */
(function (root) {
  'use strict';

  if (root.AMZ_PAYMENT_GATE) return;

  const { STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const licenseState = root.AMZ_LICENSE_STATE;
  const licenseApi = root.AMZ_LICENSE_API;

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function hasSearchScope(settings = {}) {
    return Boolean(
      settings[STORAGE_KEYS.ALL_CITIES_SELECTED] === true ||
      normalizeText(settings[STORAGE_KEYS.SELECTED_CITY]) ||
      (Array.isArray(settings[STORAGE_KEYS.CITY_TAGS]) && settings[STORAGE_KEYS.CITY_TAGS].length > 0)
    );
  }

  async function getSearchScopeReady() {
    const settings = await storage.getLocal([
      STORAGE_KEYS.ALL_CITIES_SELECTED,
      STORAGE_KEYS.SELECTED_CITY,
      STORAGE_KEYS.CITY_TAGS,
    ]);
    return hasSearchScope(settings);
  }

  async function canActivate(options = {}) {
    const searchScopeReady = await getSearchScopeReady();
    const license = await licenseState.loadCachedState();
    return {
      ok: searchScopeReady,
      license,
      searchScopeReady,
    };
  }

  async function failClosed(reason, license) {
    return {
      ok: false,
      reason: reason || 'credits-required',
      license: license || null,
    };
  }

  async function requireAllowed(options = {}) {
    const license = await licenseState.getAllowedState({ allowCache: options.allowCache !== false });
    if (!licenseState.isAllowedState(license) || !licenseState.isFresh(license)) {
      return failClosed('credits-required', license);
    }
    return { ok: true, license };
  }

  function buildUsageIdempotencyKey(details = {}) {
    const config = licenseApi.gateConfig();
    return [
      config.productId || 'unknown-product',
      normalizeText(details.amazonEmailId || details.amazonEmail || 'unknown-amazon-email').toLowerCase(),
      normalizeText(details.jobId || details.job_id || 'unknown-job'),
      normalizeText(details.scheduleId || details.schedule_id || 'unknown-schedule'),
    ].join(':');
  }

  async function readUsageKeys() {
    const key = STORAGE_KEYS.LICENSE_USAGE_KEYS || '__amz_license_usage_keys';
    const stored = await storage.getLocal(key);
    const value = stored[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function markUsageKey(idempotencyKey, value) {
    const key = STORAGE_KEYS.LICENSE_USAGE_KEYS || '__amz_license_usage_keys';
    const keys = await readUsageKeys();
    keys[idempotencyKey] = value || Date.now();
    await storage.setLocal({ [key]: keys });
  }

  async function consumeBookingCredit(details = {}) {
    const gate = await requireAllowed({ allowCache: true });
    if (!gate.ok) return gate;

    const identity = {
      emailId: details.emailId || details.buyerEmail || gate.license.emailId,
      amazonEmailId: details.amazonEmailId || details.amazonEmail || gate.license.amazonEmailId || gate.license.email,
    };
    const idempotencyKey = normalizeText(details.idempotencyKey) || buildUsageIdempotencyKey({
      ...details,
      amazonEmailId: identity.amazonEmailId,
    });
    const keys = await readUsageKeys();
    if (keys[idempotencyKey]) {
      return { ok: true, skipped: 'already-consumed', license: gate.license, idempotencyKey };
    }
    if (gate.license.isProUser === true) {
      await markUsageKey(idempotencyKey, 'pro-user');
      return { ok: true, skipped: 'pro-user', license: gate.license, idempotencyKey };
    }

    const response = await licenseApi.consumeUsage({
      ...identity,
      idempotencyKey,
      jobId: details.jobId || null,
      scheduleId: details.scheduleId || null,
      metadata: details.metadata || {},
    });
    const nextState = await licenseState.updateFromUsage(response, identity);
    await markUsageKey(idempotencyKey);
    return {
      ok: true,
      depleted: !licenseState.isAllowedState(nextState),
      license: nextState,
      idempotencyKey,
    };
  }

  root.AMZ_PAYMENT_GATE = Object.freeze({
    hasSearchScope,
    getSearchScopeReady,
    canActivate,
    requireAllowed,
    buildUsageIdempotencyKey,
    consumeBookingCredit,
    consumeForBookingAttempt: consumeBookingCredit,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
