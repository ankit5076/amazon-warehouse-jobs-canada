/* Page-world WAF bridge for the direct application content script. */
(function () {
  'use strict';

  const BRIDGE_PING_TYPE = 'AMZ_DIRECT_WAF_BRIDGE_PING';
  const BRIDGE_READY_TYPE = 'AMZ_DIRECT_WAF_BRIDGE_READY';
  const REQUEST_TYPE = 'AMZ_DIRECT_WAF_TOKEN_REQUEST';
  const RESULT_TYPE = 'AMZ_DIRECT_WAF_TOKEN_RESULT';
  const CAPTCHA_REQUEST_TYPE = 'AMZ_DIRECT_WAF_CAPTCHA_REQUEST';
  const CAPTCHA_STATUS_TYPE = 'AMZ_DIRECT_WAF_CAPTCHA_STATUS';
  const CAPTCHA_RESULT_TYPE = 'AMZ_DIRECT_WAF_CAPTCHA_RESULT';
  const BLOCKING_LOADER_SELECTORS = [
    '.AppLoader',
    '[class*="AppLoader"]',
    '[class*="appLoader"]',
    '[class*="Loader"]',
    '[class*="loader"]',
    '[class*="Loading"]',
    '[class*="loading"]',
    '[class*="Spinner"]',
    '[class*="spinner"]',
    '[data-test-component*="Loader"]',
    '[data-test-component*="Spinner"]',
    '[role="progressbar"]',
  ];
  const hiddenLoaderStyles = new Map();
  let loaderSuppressionTimer = null;

  function postBridgeReady(requestId = null, extras = {}) {
    window.postMessage({
      type: BRIDGE_READY_TYPE,
      requestId,
      ok: true,
      ...extras,
    }, '*');
  }

  if (window.__AMZ_DIRECT_WAF_BRIDGE__) {
    postBridgeReady(null, { alreadyReady: true });
    return;
  }
  window.__AMZ_DIRECT_WAF_BRIDGE__ = true;

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function waitForIntegration(waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() <= deadline) {
      if (window.AwsWafIntegration) return window.AwsWafIntegration;
      await sleep(50);
    }
    return window.AwsWafIntegration || null;
  }

  async function handleTokenRequest(requestId, waitMs, preferRefresh, sdkUrl, sdkLoadTimeoutMs) {
    if (!window.AwsWafIntegration && sdkUrl) {
      await ensureWafSdk(
        sdkUrl,
        Number(sdkLoadTimeoutMs) || Math.max(8000, Number(waitMs) || 0),
        () => window.AwsWafIntegration
      ).catch(() => false);
    }
    const integration = await waitForIntegration(waitMs);
    if (!integration) {
      window.postMessage({
        type: RESULT_TYPE,
        requestId,
        ok: false,
        reason: 'waf-integration-unavailable',
      }, '*');
      return;
    }

    try {
      let token = null;
      let method = null;

      if (preferRefresh && typeof integration.forceRefreshToken === 'function') {
        token = await integration.forceRefreshToken();
        method = 'forceRefreshToken';
      }

      if (!token && typeof integration.getToken === 'function') {
        token = await integration.getToken();
        method = method || 'getToken';
      }

      if (!token && typeof integration.forceRefreshToken === 'function') {
        token = await integration.forceRefreshToken();
        method = method || 'forceRefreshToken';
      }

      window.postMessage({
        type: RESULT_TYPE,
        requestId,
        ok: Boolean(token),
        reason: token ? 'waf-token-ready' : 'waf-token-empty',
        method,
      }, '*');
    } catch (error) {
      window.postMessage({
        type: RESULT_TYPE,
        requestId,
        ok: false,
        reason: 'waf-token-error',
        errorMessage: error?.message || String(error),
      }, '*');
    }
  }

  function visible(element) {
    if (!element || typeof window.getComputedStyle !== 'function') return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function elementSignature(element) {
    return [
      element.id,
      element.className,
      element.getAttribute?.('data-test-component'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('role'),
    ].filter(Boolean).join(' ');
  }

  function isInsideCaptcha(element, elements = {}) {
    return Boolean(elements.form && elements.form.contains(element));
  }

  function isLikelyBlockingLoader(element, elements = {}) {
    if (!visible(element) || isInsideCaptcha(element, elements)) return false;

    const signature = elementSignature(element);
    if (!/loader|loading|spinner|progress/i.test(signature)) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const zIndex = Number.parseInt(style.zIndex, 10);
    const coversMuchOfViewport =
      rect.width >= window.innerWidth * 0.35 &&
      rect.height >= window.innerHeight * 0.25;
    const positioned = ['fixed', 'absolute', 'sticky'].includes(style.position);

    return (
      style.pointerEvents !== 'none' &&
      (coversMuchOfViewport || positioned || zIndex >= 1000)
    );
  }

  function findBlockingLoaders(elements = {}) {
    const candidates = new Set();
    for (const selector of BLOCKING_LOADER_SELECTORS) {
      document.querySelectorAll(selector).forEach(element => candidates.add(element));
    }
    return Array.from(candidates).filter(element => isLikelyBlockingLoader(element, elements));
  }

  function hideBlockingLoaders(elements = {}) {
    findBlockingLoaders(elements).forEach(element => {
      if (!hiddenLoaderStyles.has(element)) {
        hiddenLoaderStyles.set(element, element.getAttribute('style') || '');
      }
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
    });
  }

  function restoreBlockingLoaders() {
    if (loaderSuppressionTimer) {
      window.clearInterval(loaderSuppressionTimer);
      loaderSuppressionTimer = null;
    }
    hiddenLoaderStyles.forEach((style, element) => {
      if (!document.contains(element)) return;
      if (style) {
        element.setAttribute('style', style);
      } else {
        element.removeAttribute('style');
      }
    });
    hiddenLoaderStyles.clear();
  }

  function suppressBlockingLoaders(elements = {}) {
    hideBlockingLoaders(elements);
    if (loaderSuppressionTimer) window.clearInterval(loaderSuppressionTimer);
    loaderSuppressionTimer = window.setInterval(() => {
      hideBlockingLoaders(elements);
    }, 250);
  }

  function findCaptchaElements() {
    return {
      overlay: document.getElementById('captchaModalOverlay'),
      form: document.getElementById('captchaForm'),
      source: 'official',
    };
  }

  async function waitForCaptchaElements(waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() <= deadline) {
      const elements = findCaptchaElements();
      if (elements.overlay && elements.form) return elements;
      await sleep(100);
    }
    return findCaptchaElements();
  }

  function createFallbackCaptchaElements() {
    let overlay = document.getElementById('__amzDirectCaptchaOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '__amzDirectCaptchaOverlay';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:none',
        'align-items:center',
        'justify-content:center',
        'background:rgba(8, 15, 25, 0.72)',
      ].join(';');

      const panel = document.createElement('div');
      panel.style.cssText = [
        'width:min(92vw, 520px)',
        'min-height:220px',
        'padding:24px',
        'border-radius:8px',
        'background:#fff',
        'box-shadow:0 24px 80px rgba(0, 0, 0, 0.35)',
      ].join(';');

      const form = document.createElement('div');
      form.id = '__amzDirectCaptchaForm';
      form.style.cssText = [
        'min-height:120px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'color:#111827',
        'font:14px Arial, sans-serif',
        'text-align:center',
      ].join(';');
      panel.appendChild(form);
      overlay.appendChild(panel);
      (document.body || document.documentElement).appendChild(overlay);
    }

    return {
      overlay,
      form: document.getElementById('__amzDirectCaptchaForm'),
      source: 'fallback',
    };
  }

  function setCaptchaMessage(elements, message) {
    if (elements.source !== 'fallback' || !elements.form) return;
    elements.form.textContent = message || '';
  }

  async function waitForCaptchaSdk(timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() <= deadline) {
      if (window.AwsWafCaptcha) return true;
      await sleep(50);
    }
    return Boolean(window.AwsWafCaptcha);
  }

  async function loadCaptchaSdkScript(sdkUrl, timeoutMs) {
    if (!sdkUrl) return false;

    const existing = document.querySelector('script[data-amz-direct-captcha-sdk="true"]');
    if (existing) {
      return true;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = sdkUrl;
      script.async = true;
      script.dataset.amzDirectCaptchaSdk = 'true';
      const timeoutId = window.setTimeout(() => {
        reject(new Error('CAPTCHA SDK load timed out.'));
      }, Math.max(1, Number(timeoutMs) || 8000));
      script.onload = () => {
        window.clearTimeout(timeoutId);
        resolve();
      };
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        reject(new Error('Failed to load CAPTCHA SDK.'));
      };
      document.head.appendChild(script);
    });

    return true;
  }

  async function ensureWafSdk(sdkUrl, timeoutMs, readyPredicate) {
    const isReady = typeof readyPredicate === 'function'
      ? readyPredicate
      : () => window.AwsWafCaptcha || window.AwsWafIntegration;
    if (isReady()) return true;
    const loaded = await loadCaptchaSdkScript(sdkUrl, timeoutMs);
    if (!loaded) return false;

    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() <= deadline) {
      if (isReady()) return true;
      await sleep(50);
    }
    return Boolean(isReady());
  }

  async function ensureCaptchaSdk(sdkUrl, timeoutMs) {
    if (window.AwsWafCaptcha) return true;
    const loaded = await loadCaptchaSdkScript(sdkUrl, timeoutMs);
    return loaded ? waitForCaptchaSdk(timeoutMs) : false;
  }

  function showCaptchaOverlay(elements) {
    suppressBlockingLoaders(elements);
    if (elements.overlay) {
      elements.overlay.classList.add('captcha-visible');
      elements.overlay.style.setProperty('z-index', '2147483647', 'important');
      elements.overlay.style.setProperty('pointer-events', 'auto', 'important');
      elements.overlay.style.display = elements.source === 'fallback' ? 'flex' : 'block';
    }
    if (elements.form) {
      elements.form.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  function hideCaptchaOverlay(elements) {
    if (elements.overlay) {
      elements.overlay.classList.remove('captcha-visible');
      elements.overlay.style.display = 'none';
    }
    restoreBlockingLoaders();
  }

  function postCaptchaStatus(requestId, stage, extras = {}) {
    window.postMessage({
      type: CAPTCHA_STATUS_TYPE,
      requestId,
      stage,
      ...extras,
    }, '*');
  }

  async function handleCaptchaRequest(requestId, sdkUrl, apiKey, domWaitMs, sdkLoadTimeoutMs) {
    postCaptchaStatus(requestId, 'render-requested');
    postCaptchaStatus(requestId, 'sdk-loading', { source: 'preload' });
    let sdkError = null;
    const sdkPromise = ensureCaptchaSdk(
      sdkUrl,
      Number(sdkLoadTimeoutMs) || 8000
    ).catch(error => {
      sdkError = error;
      return false;
    });

    let elements = await waitForCaptchaElements(domWaitMs);
    if (!elements.overlay || !elements.form) {
      elements = createFallbackCaptchaElements();
    }

    if (!elements.overlay || !elements.form) {
      window.postMessage({
        type: CAPTCHA_RESULT_TYPE,
        requestId,
        ok: false,
        reason: 'captcha-dom-unavailable',
      }, '*');
      return;
    }

    try {
      showCaptchaOverlay(elements);
      setCaptchaMessage(elements, 'Loading human verification...');
      postCaptchaStatus(requestId, 'sdk-loading', { source: elements.source });
      const sdkReady = await sdkPromise;
      if (!sdkReady || !window.AwsWafCaptcha) {
        setCaptchaMessage(elements, 'Human verification could not load. Refresh this Amazon page and try again.');
        postCaptchaStatus(requestId, 'render-failed', {
          errorMessage: sdkError?.message || 'CAPTCHA SDK unavailable.',
        });
        window.postMessage({
          type: CAPTCHA_RESULT_TYPE,
          requestId,
          ok: false,
          reason: 'captcha-sdk-unavailable',
          errorMessage: sdkError?.message || 'CAPTCHA SDK unavailable.',
        }, '*');
        return;
      }

      postCaptchaStatus(requestId, 'sdk-ready', { source: elements.source });
      setCaptchaMessage(elements, '');
      const renderResult = window.AwsWafCaptcha.renderCaptcha(elements.form, {
        apiKey,
        onSuccess: () => {
          hideCaptchaOverlay(elements);
          window.postMessage({
            type: CAPTCHA_RESULT_TYPE,
            requestId,
            ok: true,
            reason: 'captcha-solved',
          }, '*');
        },
        onError: error => {
          hideCaptchaOverlay(elements);
          window.postMessage({
            type: CAPTCHA_RESULT_TYPE,
            requestId,
            ok: false,
            reason: 'captcha-error',
            errorMessage: error?.message || String(error),
          }, '*');
        },
      });
      if (renderResult && typeof renderResult.then === 'function') await renderResult;
      postCaptchaStatus(requestId, 'visible', { source: elements.source });
    } catch (error) {
      hideCaptchaOverlay(elements);
      postCaptchaStatus(requestId, 'render-failed', {
        errorMessage: error?.message || String(error),
      });
      window.postMessage({
        type: CAPTCHA_RESULT_TYPE,
        requestId,
        ok: false,
        reason: 'captcha-bridge-error',
        errorMessage: error?.message || String(error),
      }, '*');
    }
  }

  window.addEventListener('message', event => {
    if (event.source && event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.type === BRIDGE_PING_TYPE) {
      postBridgeReady(data.requestId || null, { alreadyReady: true });
      return;
    }

    if (!data.requestId) return;

    if (data.type === REQUEST_TYPE) {
      handleTokenRequest(
        data.requestId,
        data.waitMs,
        Boolean(data.preferRefresh),
        data.sdkUrl,
        data.sdkLoadTimeoutMs
      ).catch(error => {
        window.postMessage({
          type: RESULT_TYPE,
          requestId: data.requestId,
          ok: false,
          reason: 'waf-bridge-error',
          errorMessage: error?.message || String(error),
        }, '*');
      });
      return;
    }

    if (data.type === CAPTCHA_REQUEST_TYPE) {
      handleCaptchaRequest(
        data.requestId,
        data.sdkUrl,
        data.apiKey,
        data.domWaitMs,
        data.sdkLoadTimeoutMs
      ).catch(error => {
        window.postMessage({
          type: CAPTCHA_RESULT_TYPE,
          requestId: data.requestId,
          ok: false,
          reason: 'captcha-handler-error',
          errorMessage: error?.message || String(error),
        }, '*');
      });
    }
  });

  postBridgeReady(null, { alreadyReady: false });
})();
