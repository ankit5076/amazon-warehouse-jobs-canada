/* Paid-license validation adapter. Fail closed when the paid license is absent. */
(function (root) {
  'use strict';

  if (root.AMZ_VALIDATION) return;

  const { BACKEND, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;

  let cachedPolicy = { valid: false, controls: BACKEND.FALLBACK_DEFAULTS };

  function normalizeUsername(value) {
    return root.AMZ_LICENSE_STATE?.normalizeEmail?.(value) || String(value || '').trim().toLowerCase();
  }

  async function getStoredOperatorUsername(options = {}) {
    if (root.AMZ_LICENSE_STATE?.getStoredEmail) {
      return root.AMZ_LICENSE_STATE.getStoredEmail(options);
    }
    const stored = await storage.getLocal([STORAGE_KEYS.LICENSE_EMAIL, STORAGE_KEYS.OPERATOR_USERNAME]);
    return normalizeUsername(stored[STORAGE_KEYS.LICENSE_EMAIL] || stored[STORAGE_KEYS.OPERATOR_USERNAME]);
  }

  async function disableAutomation() {
    return false;
  }

  async function disableAutomationIfCurrentUsername(username) {
    const checkedUsername = normalizeUsername(username);
    if (!checkedUsername) return false;

    const currentUsername = normalizeUsername(
      await getStoredOperatorUsername({ migrateLegacy: false })
    );
    if (checkedUsername !== currentUsername) return false;

    await disableAutomation();
    return true;
  }

  async function isCurrentOperatorUsername(username) {
    const currentUsername = normalizeUsername(
      await getStoredOperatorUsername({ migrateLegacy: false })
    );
    return normalizeUsername(username) === currentUsername;
  }

  function isPolicyFresh(policy) {
    return policy?.valid === true && root.AMZ_LICENSE_STATE?.isFresh?.(policy.license || policy) !== false;
  }

  function isPolicyForUsername(policy, username) {
    return normalizeUsername(policy?.username) === normalizeUsername(username);
  }

  function toPolicy(license) {
    const valid = root.AMZ_LICENSE_STATE?.isAllowedState?.(license) === true &&
      root.AMZ_LICENSE_STATE?.isFresh?.(license) === true;
    return {
      valid,
      username: license?.email || '',
      serverTime: license?.checkedAt ? new Date(license.checkedAt).toISOString() : null,
      license: license || null,
      controls: BACKEND.FALLBACK_DEFAULTS,
    };
  }

  async function refreshFromServer(username, options = {}) {
    const resolvedUsername = normalizeUsername(username || await getStoredOperatorUsername());
    if (!root.AMZ_LICENSE_STATE?.refresh || !resolvedUsername) {
      cachedPolicy = { valid: false };
      await disableAutomation();
      return cachedPolicy;
    }

    const next = toPolicy(await root.AMZ_LICENSE_STATE.refresh(resolvedUsername, options));
    if (!await isCurrentOperatorUsername(resolvedUsername)) {
      return {
        valid: false,
        stale: true,
        serverTime: next?.serverTime || null,
      };
    }

    if (!next || next.valid !== true) {
      cachedPolicy = next || { valid: false };
      await disableAutomationIfCurrentUsername(resolvedUsername);
      return cachedPolicy;
    }

    cachedPolicy = next;
    return cachedPolicy;
  }

  function startup() {
    Promise.resolve(refreshFromServer()).catch(() => {
      cachedPolicy = { valid: false, controls: BACKEND.FALLBACK_DEFAULTS };
      return disableAutomation().catch(() => {});
    });
  }

  function check() {
    return { ok: isPolicyFresh(cachedPolicy) };
  }

  function isAllowed() {
    return isPolicyFresh(cachedPolicy);
  }

  function isAllowedForUsername(username) {
    return isPolicyFresh(cachedPolicy) && isPolicyForUsername(cachedPolicy, username);
  }

  function getPolicy() {
    return cachedPolicy;
  }

  function getControls() {
    return cachedPolicy.valid === true ? cachedPolicy.controls || null : null;
  }

  root.AMZ_VALIDATION = Object.freeze({
    check,
    isAllowed,
    isAllowedForUsername,
    getPolicy,
    getControls,
    refreshFromServer,
    startup,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
