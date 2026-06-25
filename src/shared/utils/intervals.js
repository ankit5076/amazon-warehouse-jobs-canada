/* Fetch interval helpers shared by popup and content scripts. */
(function (root) {
  'use strict';

  if (root.AMZ_INTERVALS) return;

  const { POLLING, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const DEFAULT_UNIT = 'ms';

  function getDefaultUnit() {
    return DEFAULT_UNIT;
  }

  function getDefaultValue(unit) {
    if (unit === 'ms') return String(POLLING.FALLBACK_DELAY_MS);
    if (unit === 's') return '1';
    return '';
  }

  function resolveMilliseconds(value, unit) {
    const normalizedUnit = unit || '';
    const parsed = Number.parseInt(value, 10);
    const defaultParsed = Number.parseInt(getDefaultValue(normalizedUnit), 10);
    const fallback = Number.isFinite(defaultParsed) && defaultParsed > 0 ? defaultParsed : 0;
    const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    const resolved = normalizedUnit === 's' ? safeValue * 1000 : safeValue;
    return Number.isFinite(resolved) && resolved > 0
      ? resolved
      : POLLING.FALLBACK_DELAY_MS;
  }

  async function getStoredMilliseconds() {
    const data = await root.AMZ_STORAGE.getLocal([
      STORAGE_KEYS.FETCH_INTERVAL_VALUE,
      STORAGE_KEYS.FETCH_INTERVAL_UNIT,
      STORAGE_KEYS.FETCH_INTERVAL_MIN_MS,
    ]);
    return resolveMilliseconds(
      data[STORAGE_KEYS.FETCH_INTERVAL_VALUE],
      data[STORAGE_KEYS.FETCH_INTERVAL_UNIT],
      data[STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]
    );
  }

  root.AMZ_INTERVALS = Object.freeze({
    getDefaultUnit,
    getDefaultValue,
    resolveMilliseconds,
    getStoredMilliseconds,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
