/* Page-world WAF/CAPTCHA bridge orchestration for direct booking. */
(function (root) {
  'use strict';

  if (root.AMZ_DIRECT_WAF) return;

  const { DIRECT_APPLICATION, NOTIFICATIONS } = root.AMZ_CONSTANTS;
  const page = root.window || root;
  const documentRef = root.document || page.document;
  const log = root.AMZ_LOGGER?.create?.('[direct-waf]', {
    workflow: 'direct-booking',
    source: 'content/utils/direct-application-waf.js',
    scope: 'waf-bridge',
  }) || Object.freeze({
    debug: () => {},
    warn: () => {},
  });

  function createRequestId(prefix) {
    return [
      prefix,
      Date.now(),
      Math.random().toString(36).slice(2),
    ].join('-');
  }

  function waitForBridgeReady(requestId, timeoutMs) {
    const { MESSAGE_TYPES } = DIRECT_APPLICATION.WAF;
    return new Promise(resolve => {
      const timeoutId = root.setTimeout(() => {
        page.removeEventListener('message', onMessage);
        resolve({ ok: false, reason: 'bridge-ready-timeout' });
      }, Math.max(1, Number(timeoutMs) || 1500));

      function onMessage(event) {
        if (event.source && event.source !== page) return;
        const data = event.data;
        if (!data || data.type !== MESSAGE_TYPES.BRIDGE_READY) return;
        if (data.requestId && data.requestId !== requestId) return;

        root.clearTimeout(timeoutId);
        page.removeEventListener('message', onMessage);
        resolve({
          ok: data.ok !== false,
          reason: data.reason || 'bridge-ready',
          alreadyReady: Boolean(data.alreadyReady),
        });
      }

      page.addEventListener('message', onMessage);
    });
  }

  async function ensurePageBridge() {
    const { MESSAGE_TYPES } = DIRECT_APPLICATION.WAF;
    const parent = documentRef?.documentElement || documentRef?.head || documentRef?.body;
    if (!parent) {
      log.warn('page bridge injection parent unavailable');
      return { ok: false, reason: 'bridge-injection-parent-unavailable' };
    }

    const requestId = createRequestId('bridge');
    const timeoutMs = DIRECT_APPLICATION.WAF.BRIDGE_READY_TIMEOUT_MS;
    const existingScript = Boolean(documentRef?.querySelector?.('script[data-amz-direct-waf-bridge="true"]'));
    const readyPromise = waitForBridgeReady(requestId, timeoutMs);
    let scriptAppended = false;

    if (!existingScript) {
      const script = documentRef.createElement('script');
      script.src = root.chrome.runtime.getURL(DIRECT_APPLICATION.WAF.PAGE_BRIDGE_RESOURCE);
      script.async = false;
      script.dataset.amzDirectWafBridge = 'true';
      script.onload = () => script.remove();
      script.onerror = () => {
        log.warn('page bridge script load failed', {
          requestId,
          resource: DIRECT_APPLICATION.WAF.PAGE_BRIDGE_RESOURCE,
        });
        script.remove();
      };
      parent.appendChild(script);
      scriptAppended = true;
    }

    log.debug('page bridge readiness probe sent', {
      requestId,
      existingScript,
      scriptAppended,
      timeoutMs,
    });
    page.postMessage({
      type: MESSAGE_TYPES.BRIDGE_PING,
      requestId,
    }, '*');

    const ready = await readyPromise;
    if (ready.ok) {
      log.debug('page bridge ready', {
        requestId,
        existingScript,
        scriptAppended,
        alreadyReady: ready.alreadyReady,
      });
      return {
        ok: true,
        reason: ready.reason || 'bridge-ready',
        requestId,
        existingScript,
        scriptAppended,
        alreadyReady: ready.alreadyReady,
      };
    }

    log.warn('page bridge readiness timed out', {
      requestId,
      existingScript,
      scriptAppended,
      timeoutMs,
      reason: ready.reason || 'bridge-ready-timeout',
    });
    return {
      ok: false,
      reason: ready.reason || 'bridge-ready-timeout',
      requestId,
      existingScript,
      scriptAppended,
    };
  }

  async function injectPageScript() {
    const bridge = await ensurePageBridge();
    return bridge.ok;
  }

  function create(options = {}) {
    const persistResult = typeof options.persistResult === 'function'
      ? options.persistResult
      : () => {};
    const notify = typeof options.notify === 'function'
      ? options.notify
      : () => Promise.resolve(null);

    async function requestToken(context, reason, requestOptions = {}) {
      const { MESSAGE_TYPES, CAPTCHA_CONFIG_BY_ORIGIN } = DIRECT_APPLICATION.WAF;
      const config = CAPTCHA_CONFIG_BY_ORIGIN[context.origin || page.location.origin];
      const bridge = await ensurePageBridge();
      if (!bridge.ok) {
        persistResult(context, DIRECT_APPLICATION.STAGES.WAF_TOKEN_UNAVAILABLE, {
          wafReason: bridge.reason || 'bridge-ready-timeout',
          requestReason: reason,
        });
        return { ok: false, reason: bridge.reason || 'bridge-ready-timeout' };
      }

      const requestId = createRequestId('waf');
      return new Promise(resolve => {
        const timeoutId = root.setTimeout(() => {
          page.removeEventListener('message', onMessage);
          persistResult(context, DIRECT_APPLICATION.STAGES.WAF_TOKEN_UNAVAILABLE, {
            wafReason: 'bridge-response-timeout',
            requestReason: reason,
          });
          resolve({ ok: false, reason: 'bridge-response-timeout' });
        }, DIRECT_APPLICATION.WAF.RESPONSE_TIMEOUT_MS);

        function onMessage(event) {
          if (event.source && event.source !== page) return;
          const data = event.data;
          if (
            !data ||
            data.type !== MESSAGE_TYPES.TOKEN_RESULT ||
            data.requestId !== requestId
          ) {
            return;
          }

          root.clearTimeout(timeoutId);
          page.removeEventListener('message', onMessage);
          persistResult(
            context,
            data.ok
              ? DIRECT_APPLICATION.STAGES.WAF_TOKEN_READY
              : DIRECT_APPLICATION.STAGES.WAF_TOKEN_UNAVAILABLE,
            {
              wafReason: data.reason || null,
              wafMethod: data.method || null,
              wafErrorMessage: data.errorMessage || null,
              requestReason: reason,
            }
          );
          resolve({
            ok: Boolean(data.ok),
            reason: data.reason || null,
            method: data.method || null,
            errorMessage: data.errorMessage || null,
          });
        }

        page.addEventListener('message', onMessage);
        log.debug('waf token request posted', {
          requestId,
          requestReason: reason,
          preferRefresh: Boolean(requestOptions.preferRefresh),
          sdkConfigured: Boolean(config?.sdkUrl),
          sdkLoadTimeoutMs: DIRECT_APPLICATION.WAF.CAPTCHA_SDK_LOAD_TIMEOUT_MS,
        });
        page.postMessage({
          type: MESSAGE_TYPES.REQUEST_TOKEN,
          requestId,
          waitMs: Number(requestOptions.waitMs) || DIRECT_APPLICATION.WAF.INTEGRATION_WAIT_MS,
          preferRefresh: Boolean(requestOptions.preferRefresh),
          sdkUrl: config?.sdkUrl || null,
          sdkLoadTimeoutMs: DIRECT_APPLICATION.WAF.CAPTCHA_SDK_LOAD_TIMEOUT_MS,
        }, '*');
      });
    }

    async function requestCaptcha(context, reason, metadata = {}) {
      const { MESSAGE_TYPES, CAPTCHA_CONFIG_BY_ORIGIN } = DIRECT_APPLICATION.WAF;
      const config = CAPTCHA_CONFIG_BY_ORIGIN[context.origin || page.location.origin];

      if (!config?.apiKey || !config?.sdkUrl) {
        persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED, {
          ...metadata,
          captchaReason: 'captcha-config-unavailable',
          requestReason: reason,
        });
        return { ok: false, reason: 'captcha-config-unavailable' };
      }

      const bridge = await ensurePageBridge();
      if (!bridge.ok) {
        persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED, {
          ...metadata,
          captchaReason: bridge.reason || 'bridge-ready-timeout',
          requestReason: reason,
        });
        return { ok: false, reason: bridge.reason || 'bridge-ready-timeout' };
      }

      const requestId = createRequestId('captcha');
      persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_RENDER_REQUESTED, {
        ...metadata,
        captchaReason: 'captcha-requested',
        requestReason: reason,
        bridgeReady: true,
        bridgeReadyReason: bridge.reason || 'bridge-ready',
      });

      return new Promise(resolve => {
        let visibleNotified = false;
        let renderFailedNotified = false;
        const timeoutId = root.setTimeout(() => {
          page.removeEventListener('message', onMessage);
          log.warn('captcha bridge solve timed out', {
            requestId,
            requestReason: reason,
            timeoutMs: DIRECT_APPLICATION.WAF.CAPTCHA_SOLVE_TIMEOUT_MS,
          });
          persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED, {
            ...metadata,
            captchaReason: 'captcha-solve-timeout',
            requestReason: reason,
          });
          resolve({ ok: false, reason: 'captcha-solve-timeout' });
        }, DIRECT_APPLICATION.WAF.CAPTCHA_SOLVE_TIMEOUT_MS);

        function onMessage(event) {
          if (event.source && event.source !== page) return;
          const data = event.data;
          if (!data || data.requestId !== requestId) return;

          if (data.type === MESSAGE_TYPES.CAPTCHA_STATUS) {
            log.debug('captcha bridge status received', {
              requestId,
              stage: data.stage || null,
              source: data.source || null,
              errorMessage: data.errorMessage || null,
            });
            if (data.stage === 'visible' && !visibleNotified) {
              visibleNotified = true;
              persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_PRESENTED, {
                ...metadata,
                captchaReason: 'captcha-visible',
                captchaSource: data.source || null,
                requestReason: reason,
              });
            } else if (data.stage === 'render-failed' && !renderFailedNotified) {
              renderFailedNotified = true;
              persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED, {
                ...metadata,
                captchaReason: 'captcha-render-failed',
                captchaErrorMessage: data.errorMessage || null,
                requestReason: reason,
              });
              notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
                jobId: context.jobId,
                scheduleId: context.scheduleId,
                applicationId: metadata.applicationId || null,
                errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
                errorMessage: data.errorMessage || 'Amazon WAF CAPTCHA render failed.',
                pageUrl: context.href,
              });
            }
            return;
          }

          if (data.type !== MESSAGE_TYPES.CAPTCHA_RESULT) return;

          root.clearTimeout(timeoutId);
          page.removeEventListener('message', onMessage);
          log.debug('captcha bridge result received', {
            requestId,
            ok: Boolean(data.ok),
            reason: data.reason || null,
            errorMessage: data.errorMessage || null,
          });

          if (data.ok) {
            persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_SOLVED, {
              ...metadata,
              captchaReason: data.reason || 'captcha-solved',
              requestReason: reason,
            });
            resolve({ ok: true, reason: data.reason || 'captcha-solved' });
            return;
          }

          persistResult(context, DIRECT_APPLICATION.STAGES.CAPTCHA_FAILED, {
            ...metadata,
            captchaReason: data.reason || 'captcha-failed',
            captchaErrorMessage: data.errorMessage || null,
            requestReason: reason,
          });
          if (!renderFailedNotified) {
            notify(NOTIFICATIONS.EVENTS.BOOKING_FAILED, {
              jobId: context.jobId,
              scheduleId: context.scheduleId,
              applicationId: metadata.applicationId || null,
              errorClassification: DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED,
              errorMessage: data.errorMessage || data.reason || 'Amazon WAF CAPTCHA could not be displayed.',
              pageUrl: context.href,
            });
          }
          resolve({
            ok: false,
            reason: data.reason || 'captcha-failed',
            errorMessage: data.errorMessage || null,
          });
        }

        page.addEventListener('message', onMessage);
        log.debug('captcha bridge request posted', {
          requestId,
          requestReason: reason,
          domWaitMs: DIRECT_APPLICATION.WAF.CAPTCHA_DOM_WAIT_MS,
          sdkLoadTimeoutMs: DIRECT_APPLICATION.WAF.CAPTCHA_SDK_LOAD_TIMEOUT_MS,
        });
        page.postMessage({
          type: MESSAGE_TYPES.REQUEST_CAPTCHA,
          requestId,
          sdkUrl: config.sdkUrl,
          apiKey: config.apiKey,
          domWaitMs: DIRECT_APPLICATION.WAF.CAPTCHA_DOM_WAIT_MS,
          sdkLoadTimeoutMs: DIRECT_APPLICATION.WAF.CAPTCHA_SDK_LOAD_TIMEOUT_MS,
        }, '*');
      });
    }

    return Object.freeze({
      requestCaptcha,
      requestToken,
    });
  }

  root.AMZ_DIRECT_WAF = Object.freeze({
    create,
    injectPageScript,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
