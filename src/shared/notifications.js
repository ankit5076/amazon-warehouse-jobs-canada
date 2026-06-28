/* Channel-neutral notification event emitter for content scripts. */
(function (root) {
  'use strict';

  if (root.AMZ_NOTIFICATIONS) return;

  const { MESSAGE_ACTIONS, NOTIFICATIONS } = root.AMZ_CONSTANTS;
  const urls = root.AMZ_URL;
  const log = root.AMZ_LOGGER?.create?.('[notifications]', {
    workflow: 'notification-emitter',
    source: 'shared/notifications.js',
  }) || Object.assign(() => {}, {
    error: () => {},
    warn: () => {},
    debug: () => {},
  });

  function normalizeText(value) {
    const normalized = String(value ?? '').trim();
    return normalized && normalized !== 'null' && normalized !== 'undefined'
      ? normalized
      : '';
  }

  function sanitizeUrl(value) {
    const rawUrl = normalizeText(value) || urls?.currentUrl?.() || '';
    return typeof urls?.sanitizeNotificationUrl === 'function'
      ? urls.sanitizeNotificationUrl(rawUrl)
      : rawUrl;
  }

  function pad(value, width = 2) {
    return String(value).padStart(width, '0');
  }

  function fallbackNowIstIso() {
    const shifted = new Date(Date.now() + (330 * 60 * 1000));
    return [
      pad(shifted.getUTCFullYear(), 4),
      '-',
      pad(shifted.getUTCMonth() + 1),
      '-',
      pad(shifted.getUTCDate()),
      'T',
      pad(shifted.getUTCHours()),
      ':',
      pad(shifted.getUTCMinutes()),
      ':',
      pad(shifted.getUTCSeconds()),
      '.',
      pad(shifted.getUTCMilliseconds(), 3),
      '+05:30',
    ].join('');
  }

  function nowIstIso() {
    return root.AMZ_TIME?.nowIstIso?.() || root.AMZ_TIME?.formatIstIso?.(Date.now()) || fallbackNowIstIso();
  }

  function defaultAttemptId(payload = {}) {
    return [
      payload.jobId || '',
      payload.scheduleId || '',
      payload.applicationId || '',
    ].filter(Boolean).join('::') || '';
  }

  function canonicalEventName(eventName) {
    const name = normalizeText(eventName);
    return name ? (NOTIFICATIONS.EVENT_ALIASES?.[name] || name) : '';
  }

  function normalizeEvent(eventName, payload = {}, options = {}) {
    const name = canonicalEventName(eventName);
    if (!name) return null;

    const event = {
      eventName: name,
      attemptId: normalizeText(payload.attemptId || defaultAttemptId(payload)),
      jobId: payload.jobId || null,
      scheduleId: payload.scheduleId || null,
      applicationId: payload.applicationId || null,
      severity:
        payload.severity ||
        NOTIFICATIONS.SEVERITY_BY_EVENT[name] ||
        NOTIFICATIONS.SEVERITY.INFO,
      phase: payload.phase || NOTIFICATIONS.PHASE_BY_EVENT[name] || null,
      status: payload.status || NOTIFICATIONS.STATUS_BY_EVENT[name] || null,
      reasonCode: payload.reasonCode || payload.errorCode || null,
      errorCode: payload.errorCode || null,
      errorClassification: payload.errorClassification || null,
      httpStatus: payload.httpStatus || null,
      message: payload.message || payload.errorMessage || null,
      clientEmail: payload.clientEmail || null,
      mode: normalizeText(payload.mode || payload.applicationMode || payload.directApplicationMode) || null,
      jobTitle: payload.jobTitle || null,
      city: payload.city || null,
      state: payload.state || null,
      locationName: payload.locationName || null,
      employmentType: payload.employmentType || null,
      jobType: payload.jobType || null,
      pay: payload.pay || null,
      pageUrl: sanitizeUrl(payload.pageUrl),
      jobSnapshot: payload.jobSnapshot || null,
      currentState: payload.currentState || null,
      selectedScheduleId: payload.selectedScheduleId || null,
      workflowStepName: payload.workflowStepName || null,
      redirectUrl: payload.redirectUrl || null,
      createdAt: nowIstIso(),
      source: options.source || payload.source || null,
      channel: options.channel || payload.channel || NOTIFICATIONS.CHANNELS.TELEGRAM,
      dedupeKey: payload.dedupeKey || null,
    };

    return event;
  }

  function emit(eventName, payload = {}, options = {}) {
    const event = normalizeEvent(eventName, payload, options);
    if (!event) return Promise.resolve({ ok: false, skipped: 'missing-event' });

    return new Promise(resolve => {
      let settled = false;
      const timeoutMs = Number(NOTIFICATIONS.DISPATCH_ACK_TIMEOUT_MS) || 1000;
      const timeoutId = globalThis.setTimeout?.(() => {
        if (settled) return;
        settled = true;
        log.warn('event queue acknowledgement timed out', {
          eventName: event.eventName,
          timeoutMs,
        });
        resolve({ ok: true, queued: false, timeout: true, event });
      }, timeoutMs);

      const finish = result => {
        if (settled) return;
        settled = true;
        if (timeoutId) globalThis.clearTimeout?.(timeoutId);
        resolve(result);
      };

      log.debug('event queued', {
        eventName: event.eventName,
        jobId: event.jobId,
        scheduleId: event.scheduleId,
        applicationId: event.applicationId,
        attemptId: event.attemptId,
      });
      root.AMZ_MESSAGING.sendRuntimeMessage({
        action: MESSAGE_ACTIONS.NOTIFICATION_EVENT,
        event,
      })
        .then(result => {
          if (!result.ok || result.data?.ok === false) {
            const errorMessage = result.error || result.data?.error || 'unknown error';
            log.error('event relay failed:', {
              eventName: event.eventName,
              errorMessage,
            });
            finish({ ok: false, error: errorMessage, event });
            return;
          }
          const response = result.data;
          if (response?.result?.queued) {
            log.debug('event queued by service worker', {
              eventName: event.eventName,
              envelopeId: response.result.envelopeId || null,
            });
          } else if (response?.result?.muted || response?.result?.deduped || response?.result?.skipped) {
            log.debug('event not sent', {
              eventName: event.eventName,
              result: response.result,
            });
          }
          finish({ ok: true, queued: response?.result?.queued === true, result: response?.result || null, event });
        })
        .catch(error => {
          log.error('event dispatch error:', error);
          finish({ ok: false, error: error?.message || String(error), event });
        });
    });
  }

  root.AMZ_NOTIFICATIONS = Object.freeze({
    EVENTS: NOTIFICATIONS.EVENTS,
    emit,
    normalizeEvent,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
