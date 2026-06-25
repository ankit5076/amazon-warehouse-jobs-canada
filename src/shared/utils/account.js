/* Canonical operator/login username storage helpers shared across contexts. */
(function (root) {
  'use strict';

  if (root.AMZ_ACCOUNT) return;

  const { STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;

  function normalizeUsername(value) {
    return String(value || '').trim();
  }

  function normalizeEmail(value) {
    return normalizeUsername(value);
  }

  async function getStoredOperatorUsername(options = {}) {
    const migrateLegacy = options.migrateLegacy !== false;
    const data = await storage.getLocal([
      STORAGE_KEYS.OPERATOR_USERNAME,
      STORAGE_KEYS.USERNAME,
    ]);

    const operatorUsername = normalizeUsername(data[STORAGE_KEYS.OPERATOR_USERNAME]);
    const legacyOperatorUsername = normalizeUsername(data[STORAGE_KEYS.USERNAME]);

    if (operatorUsername) return operatorUsername;
    if (!legacyOperatorUsername) return '';

    if (migrateLegacy) {
      await storage.setLocal({ [STORAGE_KEYS.OPERATOR_USERNAME]: legacyOperatorUsername });
      await storage.removeLocal(STORAGE_KEYS.USERNAME);
    }
    return legacyOperatorUsername;
  }

  async function setStoredOperatorUsername(value) {
    const username = normalizeUsername(value);
    await storage.setLocal({ [STORAGE_KEYS.OPERATOR_USERNAME]: username });
    await storage.removeLocal(STORAGE_KEYS.USERNAME);
    return username;
  }

  async function clearStoredOperatorUsername() {
    return setStoredOperatorUsername('');
  }

  async function getStoredLoginUsername(options = {}) {
    const migrateLegacy = options.migrateLegacy !== false;
    const data = await storage.getLocal([
      STORAGE_KEYS.AMAZON_LOGIN_USERNAME,
      STORAGE_KEYS.USER_EMAIL,
      STORAGE_KEYS.LEGACY_USER_EMAIL,
    ]);

    const loginUsername = normalizeUsername(data[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]);
    const email = normalizeEmail(data[STORAGE_KEYS.USER_EMAIL]);
    const legacyEmail = normalizeEmail(data[STORAGE_KEYS.LEGACY_USER_EMAIL]);

    if (loginUsername) return loginUsername;
    const legacyLogin = email || legacyEmail;
    if (!legacyLogin) return '';

    if (migrateLegacy) {
      await storage.setLocal({ [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: legacyLogin });
      await storage.removeLocal([STORAGE_KEYS.USER_EMAIL, STORAGE_KEYS.LEGACY_USER_EMAIL]);
    }
    return legacyLogin;
  }

  async function setStoredLoginUsername(value) {
    const username = normalizeUsername(value);
    await storage.setLocal({ [STORAGE_KEYS.AMAZON_LOGIN_USERNAME]: username });
    await storage.removeLocal([STORAGE_KEYS.USER_EMAIL, STORAGE_KEYS.LEGACY_USER_EMAIL]);
    return username;
  }

  async function clearStoredLoginUsername() {
    return setStoredLoginUsername('');
  }

  root.AMZ_ACCOUNT = Object.freeze({
    normalizeUsername,
    normalizeEmail,
    getStoredOperatorUsername,
    setStoredOperatorUsername,
    clearStoredOperatorUsername,
    getStoredLoginUsername,
    setStoredLoginUsername,
    clearStoredLoginUsername,
    // Backward-compatible aliases. New code should use the explicit helpers.
    getStoredUsername: getStoredOperatorUsername,
    setStoredUsername: setStoredOperatorUsername,
    clearStoredUsername: clearStoredOperatorUsername,
    getStoredEmail: getStoredLoginUsername,
    setStoredEmail: setStoredLoginUsername,
    clearStoredEmail: clearStoredLoginUsername,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
