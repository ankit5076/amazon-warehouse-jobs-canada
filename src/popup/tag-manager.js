/* Popup city-tag rendering and persistence. */
(function (root) {
  'use strict';

  if (root.AMZ_POPUP_TAGS) return;

  const state = root.AMZ_STATE;
  const cityTags = root.AMZ_CITY_TAGS;

  function create({ defaultSelectedCity }) {
    const tagInputBox = document.getElementById('tag-input-box');
    const cityInput = document.getElementById('city-input');
    const clearAllButton = document.getElementById('clear-all');
    let renderSequence = 0;

    async function getSelectedCity(explicitCity) {
      if (explicitCity) return explicitCity;
      return state.getSelectedCity(defaultSelectedCity);
    }

    async function upsert(tags, selectedCityName) {
      const selectedCity = await getSelectedCity(selectedCityName);
      return state.upsertCityTags(tags, selectedCity);
    }

    function updateClearAllVisibility() {
      if (!clearAllButton) return;
      clearAllButton.style.display = tagInputBox?.querySelector('.tag') ? 'inline' : 'none';
    }

    async function save(tagText) {
      await upsert([...(await state.getCityTags()), tagText]);
    }

    async function remove(tagText) {
      const remaining = (await state.getCityTags()).filter(tag => {
        return cityTags.normalizeCityTag(tag) !== cityTags.normalizeCityTag(tagText);
      });
      await upsert(remaining);
    }

    function renderTag(tagText, persist = false) {
      if (!tagInputBox || !cityInput) return;
      const normalizedTag = cityTags.normalizeCityTag(tagText);
      const alreadyRendered = Array.from(tagInputBox.querySelectorAll('.tag'))
        .some(tag => cityTags.normalizeCityTag(tag.dataset.tagValue) === normalizedTag);
      if (alreadyRendered) return;

      const tag = document.createElement('div');
      tag.classList.add('tag');
      tag.dataset.tagValue = tagText;
      tag.append(document.createTextNode(tagText + ' '));
      const removeButton = document.createElement('span');
      removeButton.className = 'remove-tag';
      removeButton.textContent = 'x';
      tag.append(removeButton);
      tagInputBox.insertBefore(tag, cityInput);
      updateClearAllVisibility();

      removeButton.addEventListener('click', async () => {
        tag.remove();
        await remove(tagText);
        updateClearAllVisibility();
      });

      if (persist) save(tagText);
    }

    async function renderFromStorage() {
      if (!tagInputBox) return;
      const sequence = ++renderSequence;
      const stored = await state.getTagRenderState(defaultSelectedCity);
      const merged = await upsert(
        stored.cityTags,
        stored.selectedCity
      );
      if (sequence !== renderSequence) return;
      tagInputBox.querySelectorAll('.tag').forEach(tag => tag.remove());
      merged.forEach(tag => renderTag(tag, false));
      updateClearAllVisibility();
    }

    async function clearAll() {
      if (tagInputBox) tagInputBox.querySelectorAll('.tag').forEach(tag => tag.remove());
      await upsert([]);
      await renderFromStorage();
    }

    async function addAll(tags) {
      const merged = cityTags.mergeWithSelectedCity(tags, '');
      if (merged.length === 0) return;
      await upsert(merged);
      await renderFromStorage();
    }

    function bind() {
      clearAllButton?.addEventListener('click', clearAll);
      cityInput?.addEventListener('keyup', event => {
        if (event.key !== 'Enter') return;
        const tagText = cityInput.value.trim();
        if (!tagText) return;
        renderTag(tagText, true);
        cityInput.value = '';
      });
    }

    return Object.freeze({
      upsert,
      addAll,
      renderFromStorage,
      clearAll,
      bind,
    });
  }

  root.AMZ_POPUP_TAGS = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : self);
