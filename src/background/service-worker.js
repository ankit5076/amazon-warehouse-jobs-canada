/* Service worker event routing. Domain behavior lives in imported services. */
globalThis.AMZ_IS_SERVICE_WORKER = true;

try {
  importScripts(
    '../shared/constants.js',
    '../shared/utils/logger.js',
    '../shared/utils/text.js',
    '../shared/utils/storage.js',
    '../shared/utils/account.js',
    '../shared/utils/url.js',
    '../shared/utils/messaging.js',
    './tab-service.js'
  );
} catch (error) {
  const prefix = globalThis.AMZ_LOGGER?.formatLoggerPrefix?.('[service-worker]', {
    workflow: 'background-routing',
    source: 'background/service-worker.js',
  }) || '[service-worker]';
  globalThis.AMZ_LOGGER?.error(prefix, 'shared script load failed:', error);
}

const {
  AMAZON,
  INSTALL_DEFAULTS,
  STORAGE_KEYS,
} = globalThis.AMZ_CONSTANTS;
const log = globalThis.AMZ_LOGGER.create('[service-worker]', {
  workflow: 'background-routing',
  source: 'background/service-worker.js',
});

function configureSessionStorageAccessLevel() {
  const sessionStorage = chrome?.storage?.session;
  if (!sessionStorage || typeof sessionStorage.setAccessLevel !== 'function') return;
  try {
    const result = sessionStorage.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // Older Chrome versions or restricted contexts can reject this. Storage
    // helpers still fall back to local storage for cross-navigation observability traces.
  }
}

configureSessionStorageAccessLevel();

function configureActionVisibility() {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: {} })],
      actions: [new chrome.declarativeContent.ShowAction()],
    }]);
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  configureActionVisibility();

  if (reason === 'install') {
    await globalThis.AMZ_STORAGE.setLocal(INSTALL_DEFAULTS);
    chrome.tabs.create({ url: AMAZON.URLS.JOB_SEARCH });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !globalThis.AMZ_URL.isApplicationPage(tab.url)) {
    return;
  }

  globalThis.AMZ_STORAGE.getLocal(STORAGE_KEYS.ACTIVE).then(async storage => {
    if (storage[STORAGE_KEYS.ACTIVE] !== true) return;
    return globalThis.AMZ_TAB_SERVICE.injectCreateApplicationScript(tabId);
  }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes[STORAGE_KEYS.ACTIVE]) return;
  globalThis.AMZ_TAB_SERVICE.syncExtensionStateToTabs(
    changes[STORAGE_KEYS.ACTIVE].newValue === true
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void sender;
  void sendResponse;
  log.debug('unhandled runtime message', { action: message?.action || null });
  return false;
});
