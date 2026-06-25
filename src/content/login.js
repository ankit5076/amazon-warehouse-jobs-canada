/* Auth-page login controller. */
(function (root) {
  'use strict';

  if (root.AMZ_LOGIN) return;

  const { DOM, SELECTORS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const dom = root.AMZ_DOM;
  const storage = root.AMZ_STORAGE;
  const account = root.AMZ_ACCOUNT;
  const log = root.AMZ_LOGGER.create('[login]', {
    workflow: 'auth-login',
    source: 'content/login.js',
  });
  let loginFlowInProgress = false;

  function clickContinueButton() {
    const button = document.querySelector(SELECTORS.CONTINUE_BUTTON);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  async function promptForCredentials() {
    const [storedLogin, stored] = await Promise.all([
      account.getStoredLoginUsername(),
      storage.getLocal(STORAGE_KEYS.PASSWORD),
    ]);
    const result = await Swal.fire({
      title: 'Amazon Login Required',
      html:
        '<div style="text-align:left">' +
        '<label for="amz-login-username" style="display:block;margin-bottom:6px;">Username / Email</label>' +
        '<input id="amz-login-username" class="swal2-input" style="display:block;width:100%;max-width:100%;box-sizing:border-box;margin:0 0 12px 0;" placeholder="Username or email" autocomplete="username" />' +
        '<label for="amz-login-password" style="display:block;margin-bottom:6px;">Password / PIN</label>' +
        '<input id="amz-login-password" class="swal2-input" style="display:block;width:100%;max-width:100%;box-sizing:border-box;margin:0;" type="text" placeholder="Password or PIN" autocomplete="current-password" />' +
        '</div>',
      allowEscapeKey: false,
      allowEnterKey: true,
      allowOutsideClick: false,
      icon: 'info',
      confirmButtonText: 'Continue',
      didOpen: () => {
        const usernameInput = document.getElementById('amz-login-username');
        const passwordInput = document.getElementById('amz-login-password');
        if (usernameInput) usernameInput.value = storedLogin || '';
        if (passwordInput) passwordInput.value = stored[STORAGE_KEYS.PASSWORD] || '';
      },
      preConfirm: () => {
        const username = String(document.getElementById('amz-login-username')?.value || '').trim();
        const pin = String(document.getElementById('amz-login-password')?.value || '').trim();
        if (!username) {
          Swal.showValidationMessage('Username is required');
          return null;
        }
        if (!pin) {
          Swal.showValidationMessage('Password is required');
          return null;
        }
        return { username, pin };
      },
    });

    return result.isConfirmed && result.value ? result.value : null;
  }

  async function handleAuthLoginFlow() {
    if (loginFlowInProgress) return null;
    loginFlowInProgress = true;

    try {
      const credentials = await promptForCredentials();
      if (!credentials) return null;

      await Promise.all([
        account.setStoredLoginUsername(credentials.username),
        storage.setLocal({ [STORAGE_KEYS.PASSWORD]: credentials.pin }),
      ]);

      const loginInput = await dom.waitForSelector(
        SELECTORS.LOGIN_INPUT,
        DOM.WAIT_TIMEOUT_MS,
        DOM.WAIT_INTERVAL_MS
      );
      if (!loginInput) return credentials;
      dom.setInputValue(loginInput, credentials.username);
      if (!clickContinueButton()) return credentials;

      const pinInput = await dom.waitForSelector(
        SELECTORS.PIN_INPUT,
        DOM.WAIT_TIMEOUT_MS,
        DOM.WAIT_INTERVAL_MS
      );
      if (!pinInput) return credentials;
      dom.setInputValue(pinInput, credentials.pin);
      clickContinueButton();
      return credentials;
    } catch (error) {
      log.error('auth flow failed:', error);
      return null;
    } finally {
      loginFlowInProgress = false;
    }
  }


  function syncOpenLoginUsername(username) {
    const usernameInput = document.getElementById('amz-login-username');
    if (!usernameInput || document.activeElement === usernameInput) return;
    usernameInput.value = String(username || '').trim();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]) {
      syncOpenLoginUsername(changes[STORAGE_KEYS.AMAZON_LOGIN_USERNAME].newValue);
    }
  });

  root.AMZ_LOGIN = Object.freeze({ handleAuthLoginFlow });
})(typeof globalThis !== 'undefined' ? globalThis : self);
