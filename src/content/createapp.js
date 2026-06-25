/* Create Application page controller. */
(async function (root) {
  'use strict';

  if (root.__amazonCreateAppAutomation?.initialized) {
    root.__amazonCreateAppAutomation.setEnabled(true);
    return;
  }

  const { CREATE_APPLICATION } = root.AMZ_CONSTANTS;
  const dom = root.AMZ_DOM;
  let enabled = false;
  let redirectTimer = null;
  let postNextTimer = null;
  let observer = null;
  let nextClicked = false;
  let createClicked = false;
  const log = root.AMZ_LOGGER.create('[create-application]', {
    enabled: () => enabled,
    workflow: 'create-application-ui',
    source: 'content/createapp.js',
  });
  const directApplicationMode = root.AMZ_DIRECT_APPLICATION_MODE.create({ log });
  const directGuard = root.AMZ_DIRECT_GUARD.create({
    prefix: root.AMZ_CONSTANTS.DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
  });

  function directBookingShouldSuppressUiFallback() {
    if (!directApplicationMode.isEnabled()) return false;

    const context = root.AMZ_URL.getApplicationContextFromUrl();
    const guard = directGuard.readForJob(context);
    return Boolean(
      (context.applicationId && !context.scheduleId) ||
      directGuard.suppressesUiFallback(guard)
    );
  }

  function clickButton(button, label) {
    if (!enabled || !button || !dom.isClickable(button)) return false;
    log.info(label + ' click requested', dom.describeButton(button));

    const clickUrl = window.location.href;
    const clicked = dom.clickElement(button, label);
    if (!clicked) return false;
    if (label === 'create application') {
      log.debug(label + ' delayed native retry skipped after primary click', dom.describeButton(button));
      return true;
    }

    setTimeout(() => {
      if (!enabled || !button.isConnected || !dom.isClickable(button)) return;
      if (window.location.href !== clickUrl) {
        log.debug(label + ' native click retry skipped after navigation', dom.describeButton(button));
        return;
      }
      button.click();
      log.debug(label + ' native click retry dispatched', dom.describeButton(button));
    }, CREATE_APPLICATION.NATIVE_CLICK_DELAY_MS);
    return true;
  }

  function scheduleRedirect() {
    if (!directApplicationMode.isEnabled()) {
      log.debug('post-create redirect skipped because direct application is disabled');
      return;
    }

    clearTimeout(redirectTimer);
    redirectTimer = setTimeout(() => {
      if (enabled) window.location.href = CREATE_APPLICATION.REDIRECT_URL;
    }, CREATE_APPLICATION.REDIRECT_DELAY_MS);
  }

  function cleanup() {
    observer?.disconnect();
    observer = null;
    if (redirectTimer) clearTimeout(redirectTimer);
    if (postNextTimer) clearTimeout(postNextTimer);
    redirectTimer = null;
    postNextTimer = null;
  }

  function attemptAutomation(trigger = 'scan') {
    if (!enabled || createClicked) return;
    if (directBookingShouldSuppressUiFallback()) {
      log.debug('direct application exists or is being confirmed; skipping UI Create Application automation');
      cleanup();
      return;
    }

    const nextButton = nextClicked
      ? null
      : dom.findButtonByText(CREATE_APPLICATION.BUTTON_TEXT.NEXT);
    const createButton = dom.findButtonByText(CREATE_APPLICATION.BUTTON_TEXT.CREATE_APPLICATION);

    log.debug('automation scan: ' + trigger, {
      nextButton: dom.describeButton(nextButton),
      createButton: dom.describeButton(createButton),
      nextClicked,
      createClicked,
    });

    if (nextButton && clickButton(nextButton, 'next')) {
      nextClicked = true;
      clearTimeout(postNextTimer);
      postNextTimer = setTimeout(
        () => attemptAutomation('post-next rescan'),
        CREATE_APPLICATION.POST_NEXT_RESCAN_MS
      );
      return;
    }

    if (createButton && clickButton(createButton, 'create application')) {
      createClicked = true;
      cleanup();
      scheduleRedirect();
    }
  }

  function ensureObserver() {
    if (!document.body) return;
    if (!observer) {
      observer = new MutationObserver(mutations => {
        if (enabled) attemptAutomation('mutation ' + mutations.length);
      });
    }
    observer.observe(document.body, { childList: true, subtree: true });
    attemptAutomation('initial scan');
  }

  function setEnabled(nextEnabled) {
    const wasEnabled = enabled;
    enabled = nextEnabled === true;
    if (!enabled) {
      cleanup();
      return;
    }

    if (!wasEnabled) {
      nextClicked = false;
      createClicked = false;
    }
    ensureObserver();
  }

  root.__amazonCreateAppAutomation = Object.freeze({
    initialized: true,
    cleanup,
    setEnabled,
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === root.AMZ_CONSTANTS.MESSAGE_ACTIONS.EXTENSION_STATE_CHANGED) {
      setEnabled(message.status === true);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[root.AMZ_CONSTANTS.STORAGE_KEYS.USE_DIRECT_APPLICATION]) return;
    directApplicationMode.setEnabled(
      changes[root.AMZ_CONSTANTS.STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue
    );
    if (!enabled) return;
    if (directApplicationMode.isEnabled()) {
      cleanup();
      return;
    }
    ensureObserver();
  });

  const storage = await root.AMZ_STORAGE.getLocal([
    root.AMZ_CONSTANTS.STORAGE_KEYS.ACTIVE,
    root.AMZ_CONSTANTS.STORAGE_KEYS.USE_DIRECT_APPLICATION,
  ]);
  directApplicationMode.setEnabled(storage[root.AMZ_CONSTANTS.STORAGE_KEYS.USE_DIRECT_APPLICATION]);
  setEnabled(storage[root.AMZ_CONSTANTS.STORAGE_KEYS.ACTIVE] === true);
})(typeof globalThis !== 'undefined' ? globalThis : self);
