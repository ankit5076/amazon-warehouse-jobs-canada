/* Shared IST timestamp helpers for extension logs, telemetry, and storage. */
(function (root) {
  'use strict';

  if (root.AMZ_TIME) return;

  const IST_OFFSET = '+05:30';
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const IST_TIME_ZONE = 'Asia/Kolkata';

  function pad(value, width = 2) {
    return String(value).padStart(width, '0');
  }

  function safeEpochMs(value = Date.now()) {
    const parsed = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function istParts(value = Date.now()) {
    const shifted = new Date(safeEpochMs(value) + IST_OFFSET_MS);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      millisecond: shifted.getUTCMilliseconds(),
    };
  }

  function formatIstIso(value = Date.now(), options = {}) {
    const parts = istParts(value);
    const base = [
      pad(parts.year, 4),
      '-',
      pad(parts.month),
      '-',
      pad(parts.day),
      'T',
      pad(parts.hour),
      ':',
      pad(parts.minute),
      ':',
      pad(parts.second),
    ].join('');
    const millis = options.milliseconds === false ? '' : `.${pad(parts.millisecond, 3)}`;
    return `${base}${millis}${IST_OFFSET}`;
  }

  function formatIstDate(value = Date.now()) {
    const parts = istParts(value);
    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  function formatIstCompact(value = Date.now()) {
    const parts = istParts(value);
    return [
      pad(parts.year, 4),
      pad(parts.month),
      pad(parts.day),
      pad(parts.hour),
      pad(parts.minute),
      pad(parts.second),
    ].join('');
  }

  root.AMZ_TIME = Object.freeze({
    IST_OFFSET,
    IST_OFFSET_MS,
    IST_TIME_ZONE,
    formatIstCompact,
    formatIstDate,
    formatIstIso,
    nowIstCompact: () => formatIstCompact(Date.now()),
    nowIstDate: () => formatIstDate(Date.now()),
    nowIstIso: () => formatIstIso(Date.now()),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
