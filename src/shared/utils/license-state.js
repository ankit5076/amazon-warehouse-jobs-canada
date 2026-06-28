/* Shared Supabase credit-gate state helpers. Keep this file byte-identical across paid extensions. */
(function (root) {
  'use strict';

  if (root.AMZ_LICENSE_STATE) return;

  const { STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const api = root.AMZ_LICENSE_API;

  const BUYER_EMAIL_KEY = STORAGE_KEYS.LICENSE_BUYER_EMAIL || STORAGE_KEYS.LICENSE_EMAIL || '__amz_license_buyer_email';
  const AMAZON_EMAIL_KEY = STORAGE_KEYS.LICENSE_AMAZON_EMAIL || STORAGE_KEYS.LICENSE_EMAIL || '__amz_license_amazon_email';

  let memoryState = null;

  function now() {
    return Date.now();
  }

  function normalizeEmail(value) {
    return api.normalizeEmail(value);
  }

  function storageKeys(keys) {
    return keys.filter(key => typeof key === 'string' && key);
  }

  function assignIfKey(target, key, value) {
    if (typeof key === 'string' && key) target[key] = value;
  }

  function expiryFor(response) {
    const interval = Number(response?.syncIntervalMs || api.gateConfig().defaultSyncIntervalMs || 15 * 60 * 1000);
    return now() + Math.max(60 * 1000, interval);
  }

  function isAllowedState(state) {
    return Boolean(
      state &&
      state.allowed === true &&
      (state.isProUser === true || Number(state.credits || 0) > 0)
    );
  }

  function isFresh(state) {
    return Boolean(state && Number(state.expiresAt || 0) > now());
  }

  function normalizeIdentity(input = {}) {
    if (typeof input === 'string') {
      return {
        emailId: '',
        amazonEmailId: normalizeEmail(input),
      };
    }
    return {
      emailId: normalizeEmail(input.emailId || input.buyerEmail || input.email || ''),
      amazonEmailId: normalizeEmail(input.amazonEmailId || input.amazonEmail || input.email || ''),
    };
  }

  function withCacheMetadata(response, identity) {
    const normalized = normalizeIdentity(identity);
    return {
      ...api.normalizeLicenseResponse(response),
      emailId: normalized.emailId,
      amazonEmailId: normalized.amazonEmailId,
      email: normalized.amazonEmailId,
      checkedAt: now(),
      expiresAt: expiryFor(response),
    };
  }

  async function getStoredEmails() {
    const stored = await storage.getLocal(storageKeys([
      BUYER_EMAIL_KEY,
      AMAZON_EMAIL_KEY,
      STORAGE_KEYS.LICENSE_EMAIL,
      STORAGE_KEYS.OPERATOR_USERNAME,
      STORAGE_KEYS.USER_EMAIL,
    ]));
    const legacy = normalizeEmail(
      stored[STORAGE_KEYS.LICENSE_EMAIL] ||
      stored[STORAGE_KEYS.OPERATOR_USERNAME] ||
      stored[STORAGE_KEYS.USER_EMAIL]
    );
    return {
      emailId: normalizeEmail(stored[BUYER_EMAIL_KEY] || stored[STORAGE_KEYS.USER_EMAIL] || legacy),
      amazonEmailId: normalizeEmail(stored[AMAZON_EMAIL_KEY] || legacy),
    };
  }

  async function getStoredEmail() {
    return (await getStoredEmails()).amazonEmailId;
  }

  async function setStoredEmails(identity = {}) {
    const normalized = normalizeIdentity(identity);
    const values = {};
    assignIfKey(values, BUYER_EMAIL_KEY, normalized.emailId);
    assignIfKey(values, AMAZON_EMAIL_KEY, normalized.amazonEmailId);
    assignIfKey(values, STORAGE_KEYS.OPERATOR_USERNAME, normalized.amazonEmailId);
    assignIfKey(values, STORAGE_KEYS.USER_EMAIL, normalized.emailId || normalized.amazonEmailId);
    assignIfKey(values, STORAGE_KEYS.LICENSE_EMAIL, normalized.amazonEmailId);
    await storage.setLocal(values);
    return normalized;
  }

  async function setStoredEmail(email) {
    const normalized = normalizeEmail(email);
    await setStoredEmails({ emailId: normalized, amazonEmailId: normalized });
    return normalized;
  }

  async function loadCachedState() {
    if (memoryState) return memoryState;
    const stored = await storage.getLocal(STORAGE_KEYS.LICENSE_STATE);
    const state = stored[STORAGE_KEYS.LICENSE_STATE] || null;
    memoryState = state && typeof state === 'object' ? state : null;
    return memoryState;
  }

  async function saveState(state) {
    memoryState = state || null;
    await storage.setLocal({ [STORAGE_KEYS.LICENSE_STATE]: memoryState });
    return memoryState;
  }

  async function clearState(options = {}) {
    memoryState = null;
    const values = {
      [STORAGE_KEYS.LICENSE_STATE]: null,
    };
    if (options.preserveEmails !== true) {
      assignIfKey(values, BUYER_EMAIL_KEY, '');
      assignIfKey(values, AMAZON_EMAIL_KEY, '');
      assignIfKey(values, STORAGE_KEYS.LICENSE_EMAIL, '');
    }
    await storage.setLocal(values);
  }

  async function resolveIdentity(input) {
    const stored = await getStoredEmails();
    const supplied = normalizeIdentity(input || {});
    return {
      emailId: supplied.emailId || stored.emailId,
      amazonEmailId: supplied.amazonEmailId || stored.amazonEmailId,
    };
  }

  async function refresh(identity, options = {}) {
    const resolved = await resolveIdentity(identity);
    if (!resolved.amazonEmailId) {
      await clearState({ preserveEmails: true });
      return null;
    }
    if (options.persistEmail !== false) {
      await setStoredEmails(resolved);
    }
    try {
      const response = await api.checkLicense(resolved);
      const state = withCacheMetadata(response, resolved);
      await saveState(state);
      return state;
    } catch (error) {
      const cached = await loadCachedState();
      if (
        options.allowCache !== false &&
        cached?.amazonEmailId === resolved.amazonEmailId &&
        isFresh(cached) &&
        isAllowedState(cached)
      ) {
        return cached;
      }
      await clearState({ preserveEmails: true });
      return {
        allowed: false,
        credits: 0,
        isProUser: false,
        checkoutUrl: '',
        message: error?.message || 'Unable to validate credits.',
        syncIntervalMs: Number(api.gateConfig().defaultSyncIntervalMs || 15 * 60 * 1000),
        emailId: resolved.emailId,
        amazonEmailId: resolved.amazonEmailId,
        email: resolved.amazonEmailId,
        checkedAt: now(),
        expiresAt: 0,
      };
    }
  }

  async function getAllowedState(options = {}) {
    const identity = await resolveIdentity(options);
    if (!identity.amazonEmailId) return null;
    const cached = await loadCachedState();
    if (
      options.allowCache !== false &&
      cached?.amazonEmailId === identity.amazonEmailId &&
      isFresh(cached) &&
      isAllowedState(cached)
    ) {
      return cached;
    }
    return refresh(identity, options);
  }

  async function isAllowed(options = {}) {
    const state = await getAllowedState(options);
    return isAllowedState(state) && isFresh(state);
  }

  async function updateFromUsage(response, identity) {
    const resolved = await resolveIdentity(identity);
    const state = withCacheMetadata(response, resolved);
    await saveState(state);
    return state;
  }

  root.AMZ_LICENSE_STATE = Object.freeze({
    normalizeEmail,
    getStoredEmails,
    getStoredEmail,
    setStoredEmails,
    setStoredEmail,
    loadCachedState,
    saveState,
    clearState,
    refresh,
    getAllowedState,
    isAllowed,
    isAllowedState,
    isFresh,
    updateFromUsage,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
