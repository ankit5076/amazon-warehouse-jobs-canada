/* Background tab synchronization and create-application injection. */
(function (root) {
  'use strict';

  if (root.AMZ_TAB_SERVICE) return;

  const { AMAZON, CREATE_APPLICATION, MESSAGE_ACTIONS } = root.AMZ_CONSTANTS;
  const urls = root.AMZ_URL;

  async function injectCreateApplicationScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...CREATE_APPLICATION.INJECTION_FILES],
    });
  }

  async function syncExtensionStateToTabs(isActive) {
    const tabs = await chrome.tabs.query({ url: AMAZON.PAGE_PATTERNS });

    await Promise.all(tabs.map(async tab => {
      if (!tab.id) return;

      await root.AMZ_MESSAGING.sendTabMessage(tab.id, {
        action: MESSAGE_ACTIONS.EXTENSION_STATE_CHANGED,
        status: isActive,
      });

      if (isActive && urls.isApplicationPage(tab.url)) {
        try {
          await injectCreateApplicationScript(tab.id);
        } catch (_) {
          // The tab can navigate away before script injection completes.
        }
      }
    }));
  }

  root.AMZ_TAB_SERVICE = Object.freeze({
    injectCreateApplicationScript,
    syncExtensionStateToTabs,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
