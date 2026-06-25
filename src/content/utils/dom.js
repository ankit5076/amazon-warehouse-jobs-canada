/* DOM helpers used by content controllers. */
(function (root) {
  'use strict';

  if (root.AMZ_DOM) return;

  const text = root.AMZ_TEXT;
  const { DOM, SELECTORS, TEXT_LIMITS } = root.AMZ_CONSTANTS;
  const log = root.AMZ_LOGGER.create('[dom]', {
    workflow: 'dom-automation',
    source: 'content/utils/dom.js',
  });

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForSelector(
    selector,
    timeoutMs = DOM.WAIT_TIMEOUT_MS,
    intervalMs = DOM.WAIT_INTERVAL_MS
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = document.querySelector(selector);
      if (element) return element;
      await delay(intervalMs);
    }
    return null;
  }

  function setInputValue(inputElement, value) {
    if (!inputElement) return;

    const nextValue = String(value || '');
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputElement, nextValue);
    } else {
      inputElement.value = nextValue;
    }

    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    inputElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
  }

  function isClickable(element) {
    if (!element || element.disabled || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getClickableElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isClickable);
  }

  function describeButton(button) {
    if (!button) return null;
    return {
      text: text.compact(button.textContent || ''),
      ariaLabel: button.getAttribute('aria-label') || null,
      testId: button.getAttribute('data-test-id') || null,
      disabled: Boolean(button.disabled),
      className: text.compact(button.className || '', TEXT_LIMITS.BUTTON_CLASSNAME_LENGTH),
    };
  }

  function findButtonByText(targetText) {
    const target = text.normalizeForComparison(targetText);
    if (!target) return null;

    return Array.from(document.querySelectorAll(SELECTORS.BUTTONS)).find(button => {
      const rowText = button.querySelector(SELECTORS.CREATE_APPLICATION_ROW_TEXT)?.textContent;
      const candidates = [
        rowText,
        button.innerText,
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
      ].map(text.normalizeForComparison).filter(Boolean);
      return candidates.some(candidate => candidate === target || candidate.includes(target));
    }) || null;
  }

  function clickElement(element, label = 'element', options = {}) {
    if (!isClickable(element)) {
      log.debug(label + ': element is not clickable');
      return false;
    }

    const { nativeOnly = false } = options;
    if (nativeOnly && typeof element.click === 'function') {
      element.click();
      log.debug(label + ': native click dispatched');
      return true;
    }

    try {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_) {
      // Best-effort only; old browsers may not support option objects.
    }
    if (typeof element.focus === 'function') {
      try {
        element.focus({ preventScroll: true });
      } catch (_) {
        element.focus();
      }
    }

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
    };

    [
      ['pointerdown', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent],
      ['mousedown', MouseEvent],
      ['pointerup', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent],
      ['mouseup', MouseEvent],
    ].forEach(([type, EventCtor]) => {
      element.dispatchEvent(new EventCtor(type, eventInit));
    });

    if (typeof element.click === 'function') {
      element.click();
      log.debug(label + ': native click dispatched after pointer sequence');
      return true;
    }

    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
    }));
    log.debug(label + ': click dispatched');
    return true;
  }

  root.AMZ_DOM = Object.freeze({
    delay,
    waitForSelector,
    setInputValue,
    isClickable,
    getClickableElements,
    describeButton,
    findButtonByText,
    clickElement,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
