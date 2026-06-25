/* Shared text utilities. */
(function (root) {
  'use strict';

  if (root.AMZ_TEXT) return;

  const { TEXT_LIMITS } = root.AMZ_CONSTANTS;

  function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function compact(value, maxLength = TEXT_LIMITS.DEFAULT_COMPACT_LENGTH) {
    const normalized = normalizeWhitespace(value);
    if (!maxLength || normalized.length <= maxLength) return normalized;
    return normalized.slice(0, maxLength) + '...';
  }

  function normalizeForComparison(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function normalizeLetters(value) {
    return normalizeWhitespace(value).toLowerCase().replace(/[^a-z]/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  root.AMZ_TEXT = Object.freeze({
    normalizeWhitespace,
    compact,
    normalizeForComparison,
    normalizeLetters,
    escapeHtml,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
