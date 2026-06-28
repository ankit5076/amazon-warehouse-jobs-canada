/* Create Application page controller. */
(async function (root) {
  'use strict';

  if (root.__amazonCreateAppAutomation?.initialized) {
    root.__amazonCreateAppAutomation.setEnabled(true);
    return;
  }

  const { CREATE_APPLICATION, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const dom = root.AMZ_DOM;
  const storage = root.AMZ_STORAGE;
  let enabled = false;
  let postNextTimer = null;
  let manualScanInterval = null;
  let manualScanDeadlineMs = 0;
  let observer = null;
  let routeWatcherInstalled = false;
  let lastObservedUrl = '';
  let nextClicked = false;
  let createClicked = false;
  let lastAutomationUrl = '';
  let selectThisJobClickUrl = '';
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

  function resetRouteClickState() {
    const currentUrl = window.location.href;
    if (currentUrl === lastAutomationUrl) return;
    lastAutomationUrl = currentUrl;
    nextClicked = false;
    createClicked = false;
    selectThisJobClickUrl = '';
  }

  function isManualMode() {
    return !directApplicationMode.isEnabled();
  }

  function isManualFinalApplicationFormRoute() {
    return (
      isManualMode() &&
      root.AMZ_URL.isFinalApplicationFormPage?.() === true
    );
  }

  function findButtonByTexts(...labels) {
    for (const label of labels.flat().filter(Boolean)) {
      const button = dom.findButtonByText(label);
      if (button) return button;
    }
    return null;
  }

  function scheduleRescan(trigger, delayMs = CREATE_APPLICATION.POST_ACTION_RESCAN_MS) {
    clearTimeout(postNextTimer);
    postNextTimer = setTimeout(
      () => attemptAutomation(trigger),
      delayMs
    );
  }

  function stopManualResponsiveScan() {
    if (manualScanInterval) clearInterval(manualScanInterval);
    manualScanInterval = null;
    manualScanDeadlineMs = 0;
  }

  function startManualResponsiveScanWindow(trigger = 'manual responsive scan') {
    if (!enabled || !isManualMode()) return;
    if (isManualFinalApplicationFormRoute()) return;

    manualScanDeadlineMs = Date.now() + CREATE_APPLICATION.ROUTE_SCAN_TIMEOUT_MS;
    if (manualScanInterval) return;

    manualScanInterval = setInterval(() => {
      if (!enabled || !isManualMode()) {
        stopManualResponsiveScan();
        return;
      }
      if (Date.now() > manualScanDeadlineMs) {
        stopManualResponsiveScan();
        return;
      }
      attemptAutomation(trigger);
    }, CREATE_APPLICATION.ROUTE_SCAN_INTERVAL_MS);
  }

  function handleRouteChanged(trigger) {
    const currentUrl = window.location.href;
    if (currentUrl === lastObservedUrl) return;
    lastObservedUrl = currentUrl;
    if (!enabled || !isManualMode()) return;

    startManualResponsiveScanWindow(trigger + ' poll');
    scheduleRescan(trigger, CREATE_APPLICATION.ROUTE_CHANGE_RESCAN_MS);
  }

  function installRouteWatcher() {
    if (routeWatcherInstalled || typeof window === 'undefined') return;
    routeWatcherInstalled = true;
    lastObservedUrl = window.location.href;

    const wrapHistoryMethod = method => {
      const original = window.history?.[method];
      if (typeof original !== 'function') return;
      try {
        window.history[method] = function (...args) {
          const result = original.apply(this, args);
          handleRouteChanged('route ' + method);
          return result;
        };
      } catch (error) {
        log.debug('route watcher history hook failed', {
          method,
          message: error?.message || String(error),
        });
      }
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener?.('hashchange', () => handleRouteChanged('route hashchange'));
    window.addEventListener?.('popstate', () => handleRouteChanged('route popstate'));
  }

  function cleanup() {
    observer?.disconnect();
    observer = null;
    if (postNextTimer) clearTimeout(postNextTimer);
    stopManualResponsiveScan();
    postNextTimer = null;
  }

  function attemptAutomation(trigger = 'scan') {
    if (!enabled) return;
    resetRouteClickState();
    if (isManualFinalApplicationFormRoute()) {
      log.info('manual application form route opened; stopping native UI automation', {
        url: window.location.href,
      });
      cleanup();
      return;
    }
    if (directBookingShouldSuppressUiFallback()) {
      log.debug('direct application exists or is being confirmed; skipping UI Create Application automation');
      cleanup();
      return;
    }

    const nextButton = nextClicked
      ? null
      : findButtonByTexts(CREATE_APPLICATION.BUTTON_TEXT.NEXT);
    const createButton = createClicked
      ? null
      : findButtonByTexts(
        CREATE_APPLICATION.BUTTON_TEXT.CREATE_APPLICATION,
        CREATE_APPLICATION.BUTTON_TEXT.START_APPLICATION
      );
    const selectThisJobButton = selectThisJobClickUrl === window.location.href
      ? null
      : findButtonByTexts(CREATE_APPLICATION.BUTTON_TEXT.SELECT_THIS_JOB);

    log.debug('automation scan: ' + trigger, {
      nextButton: dom.describeButton(nextButton),
      createButton: dom.describeButton(createButton),
      selectThisJobButton: dom.describeButton(selectThisJobButton),
      nextClicked,
      createClicked,
      selectThisJobClickUrl,
    });

    if (nextButton && clickButton(nextButton, 'next')) {
      nextClicked = true;
      startManualResponsiveScanWindow('post-next poll');
      scheduleRescan('post-next rescan');
      return;
    }

    if (createButton && clickButton(createButton, 'create application')) {
      createClicked = true;
      if (directApplicationMode.isEnabled()) {
        cleanup();
      } else {
        startManualResponsiveScanWindow('post-create poll');
        scheduleRescan('post-create rescan');
      }
      return;
    }

    if (selectThisJobButton && clickButton(selectThisJobButton, 'select this job')) {
      selectThisJobClickUrl = window.location.href;
      startManualResponsiveScanWindow('post-select-this-job poll');
      scheduleRescan('post-select-this-job rescan');
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
    installRouteWatcher();
    startManualResponsiveScanWindow('initial manual poll');
  }

  function setEnabled(nextEnabled) {
    const wasEnabled = enabled;
    enabled = nextEnabled === true;
    if (!enabled) {
      cleanup();
      return;
    }

    if (!wasEnabled) {
      lastObservedUrl = window.location.href;
      lastAutomationUrl = '';
      nextClicked = false;
      createClicked = false;
      selectThisJobClickUrl = '';
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
      if (message.status !== true) {
        setEnabled(false);
        return;
      }
      if (!root.AMZ_PAYMENT_GATE?.requireAllowed && typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
        setEnabled(true);
        return;
      }
      root.AMZ_PAYMENT_GATE?.requireAllowed?.({ allowCache: true })
        .then(result => setEnabled(result?.ok === true))
        .catch(() => setEnabled(false));
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (!changes[STORAGE_KEYS.USE_DIRECT_APPLICATION]) return;
    directApplicationMode.setEnabled(
      changes[STORAGE_KEYS.USE_DIRECT_APPLICATION].newValue
    );
    if (!enabled) return;
    if (directApplicationMode.isEnabled()) {
      cleanup();
      return;
    }
    ensureObserver();
  });

  const initialStorage = await root.AMZ_STORAGE.getLocal([
    STORAGE_KEYS.ACTIVE,
    STORAGE_KEYS.USE_DIRECT_APPLICATION,
  ]);
  directApplicationMode.setEnabled(initialStorage[STORAGE_KEYS.USE_DIRECT_APPLICATION]);
  const paidGate = initialStorage[STORAGE_KEYS.ACTIVE] === true
    ? (root.AMZ_PAYMENT_GATE?.requireAllowed
      ? await root.AMZ_PAYMENT_GATE.requireAllowed({ allowCache: true }).catch(() => null)
      : (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test' ? { ok: true } : null))
    : null;
  setEnabled(paidGate?.ok === true);
})(typeof globalThis !== 'undefined' ? globalThis : self);
