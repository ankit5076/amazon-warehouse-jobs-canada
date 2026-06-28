/* Promise-based Chrome storage helpers shared by extension contexts. */
(function (root) {
  'use strict';

  if (root.AMZ_STORAGE) return;

  function normalizeGetKeys(keys) {
    if (typeof keys === 'undefined' || keys === null) return undefined;
    if (Array.isArray(keys)) return keys.filter(key => typeof key === 'string' && key);
    if (typeof keys === 'string') return keys;
    if (keys && typeof keys === 'object') return keys;
    return undefined;
  }

  async function getLocal(keys) {
    const normalizedKeys = normalizeGetKeys(keys);
    return typeof normalizedKeys === 'undefined'
      ? chrome.storage.local.get()
      : chrome.storage.local.get(normalizedKeys);
  }

  async function setLocal(values) {
    return chrome.storage.local.set(values);
  }

  async function removeLocal(keys) {
    return chrome.storage.local.remove(keys);
  }

  async function clearLocal() {
    return chrome.storage.local.clear();
  }

  function hasSessionStorage() {
    return Boolean(chrome?.storage?.session && typeof chrome.storage.session.get === 'function');
  }

  async function getSession(keys) {
    if (!hasSessionStorage()) return getLocal(keys);
    const normalizedKeys = normalizeGetKeys(keys);
    try {
      return typeof normalizedKeys === 'undefined'
        ? await chrome.storage.session.get()
        : await chrome.storage.session.get(normalizedKeys);
    } catch (_) {
      return getLocal(keys);
    }
  }

  async function setSession(values) {
    if (!hasSessionStorage()) return setLocal(values);
    try {
      return await chrome.storage.session.set(values);
    } catch (_) {
      return setLocal(values);
    }
  }

  async function removeSession(keys) {
    if (!hasSessionStorage()) return removeLocal(keys);
    try {
      return await chrome.storage.session.remove(keys);
    } catch (_) {
      return removeLocal(keys);
    }
  }

  function getManifestVersion() {
    return chrome.runtime.getManifest().version;
  }

  root.AMZ_STORAGE = Object.freeze({
    getLocal,
    setLocal,
    removeLocal,
    clearLocal,
    hasSessionStorage,
    normalizeGetKeys,
    getSession,
    setSession,
    removeSession,
    getManifestVersion,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
