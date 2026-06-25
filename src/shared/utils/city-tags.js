/* City tag normalization, merging, and matching. */
(function (root) {
  'use strict';

  if (root.AMZ_CITY_TAGS) return;

  const text = root.AMZ_TEXT;

  function normalizeCityTag(value) {
    return text.normalizeForComparison(value);
  }

  function mergeWithSelectedCity(tags, selectedCityName) {
    const merged = [];
    const seen = new Set();

    (tags || []).forEach(tag => {
      const trimmed = text.normalizeWhitespace(tag);
      const normalized = normalizeCityTag(trimmed);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      merged.push(trimmed);
    });

    const selectedCity = text.normalizeWhitespace(selectedCityName);
    const normalizedSelectedCity = normalizeCityTag(selectedCity);
    if (normalizedSelectedCity && !seen.has(normalizedSelectedCity)) {
      merged.push(selectedCity);
    }

    return merged;
  }

  function normalizeForMatching(value) {
    return text.normalizeLetters(value);
  }

  function findMatchingJob(jobCards, tags, options = {}) {
    const normalizedTags = (tags || [])
      .map(normalizeForMatching)
      .filter(Boolean);

    if (normalizedTags.length === 0) return null;
    const matchesJob = typeof options.matchesJob === 'function'
      ? options.matchesJob
      : () => true;

    return (jobCards || []).find(job => {
      const city = normalizeForMatching(job?.city);
      return Boolean(city && normalizedTags.some(tag => city.includes(tag)) && matchesJob(job));
    }) || null;
  }

  root.AMZ_CITY_TAGS = Object.freeze({
    normalizeCityTag,
    mergeWithSelectedCity,
    normalizeForMatching,
    findMatchingJob,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
