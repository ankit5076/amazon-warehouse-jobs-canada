/* Background notification router: policy, enrichment, dedupe, queue, channels. */
(function (root) {
  'use strict';

  if (root.AMZ_BACKGROUND_NOTIFICATIONS) return;

  const { NOTIFICATIONS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const storage = root.AMZ_STORAGE;
  const account = root.AMZ_ACCOUNT;
  const urls = root.AMZ_URL;
  const log = root.AMZ_LOGGER?.create?.('[notification-service]', {
    workflow: 'notification-routing',
    source: 'background/notification-service.js',
  }) || Object.assign(() => {}, {
    error: () => {},
    warn: () => {},
    debug: () => {},
  });
  const recentNotifications = new Map();
  let flushInFlight = null;

  function normalizeText(value) {
    if (Array.isArray(value)) return normalizeText(value.find(Boolean));
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized === 'null' || normalized === 'undefined') return '';
    return normalized;
  }

  function firstText(...values) {
    for (const value of values) {
      const normalized = normalizeText(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function getExtensionVersion() {
    try {
      return normalizeText(root.chrome?.runtime?.getManifest?.()?.version);
    } catch (_) {
      return '';
    }
  }

  function sanitizeUrl(value) {
    const normalized = normalizeText(value);
    if (!normalized) return '';
    return typeof urls?.sanitizeNotificationUrl === 'function'
      ? urls.sanitizeNotificationUrl(normalized)
      : normalized;
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

  function normalizeEvent(event = {}) {
    const rawEventName = normalizeText(event.eventName);
    const eventName = rawEventName ? (NOTIFICATIONS.EVENT_ALIASES?.[rawEventName] || rawEventName) : '';
    if (!eventName) return null;
    return {
      ...event,
      eventName,
      attemptId: normalizeText(event.attemptId) ||
        [event.jobId, event.scheduleId, event.applicationId].map(normalizeText).filter(Boolean).join('::'),
      jobId: normalizeText(event.jobId) || null,
      scheduleId: normalizeText(event.scheduleId) || null,
      applicationId: normalizeText(event.applicationId) || null,
      mode: normalizeText(event.mode || event.applicationMode || event.directApplicationMode) || null,
      severity:
        event.severity ||
        NOTIFICATIONS.SEVERITY_BY_EVENT[eventName] ||
        NOTIFICATIONS.SEVERITY.INFO,
      phase: event.phase || NOTIFICATIONS.PHASE_BY_EVENT[eventName] || null,
      status: event.status || NOTIFICATIONS.STATUS_BY_EVENT[eventName] || null,
      reasonCode: normalizeText(event.reasonCode || event.errorCode) || null,
      channel: event.channel || NOTIFICATIONS.CHANNELS.TELEGRAM,
      createdAt: event.createdAt || nowIstIso(),
    };
  }

  function queueId(event) {
    return [
      Date.now(),
      event.eventName,
      event.jobId || '',
      event.scheduleId || '',
      Math.random().toString(36).slice(2, 8),
    ].join('::');
  }

  async function readQueue() {
    const stored = await storage.getLocal(STORAGE_KEYS.NOTIFICATION_QUEUE);
    const queue = stored[STORAGE_KEYS.NOTIFICATION_QUEUE];
    return Array.isArray(queue) ? queue.filter(Boolean) : [];
  }

  async function writeQueue(queue) {
    const limit = Number(NOTIFICATIONS.QUEUE_LIMIT) || 30;
    await storage.setLocal({
      [STORAGE_KEYS.NOTIFICATION_QUEUE]: queue.slice(-limit),
    });
  }

  async function removeQueuedEnvelope(id) {
    const queue = await readQueue();
    await writeQueue(queue.filter(item => item?.id !== id));
  }

  async function updateQueuedEnvelope(id, patch) {
    const queue = await readQueue();
    await writeQueue(queue.map(item => item?.id === id ? { ...item, ...patch } : item));
  }

  async function enqueueEvent(event, sender = {}) {
    const envelope = {
      id: queueId(event),
      queuedAt: nowIstIso(),
      attempts: 0,
      event,
      sender: {
        tabUrl: sender?.tab?.url || null,
      },
    };
    const queue = await readQueue();
    await writeQueue([...queue, envelope]);
    return envelope;
  }

  function clearExpiredDedupeEntries(now) {
    for (const [key, entry] of recentNotifications.entries()) {
      if (now - entry.at > entry.ttl) recentNotifications.delete(key);
    }
  }

  function getFirstDetectedEmail(storageData) {
    const detectedEmails = storageData[STORAGE_KEYS.DETECTED_EMAILS];
    if (!Array.isArray(detectedEmails)) return '';
    return detectedEmails.find(email => normalizeText(email)) || '';
  }

  function selectMatchedJob(event, storageData) {
    const explicit = event.jobSnapshot && typeof event.jobSnapshot === 'object'
      ? event.jobSnapshot
      : null;
    const stored = storageData[STORAGE_KEYS.LAST_MATCHED_JOB] || {};
    const candidate = explicit || stored;
    const eventJobId = normalizeText(event.jobId);
    if (!candidate?.jobId || !eventJobId || candidate.jobId === eventJobId) return candidate || {};
    return {};
  }

  function createDetails(event, senderData, storageData, clientEmail, operatorUsername) {
    const matched = selectMatchedJob(event, storageData);

    return {
      clientEmail: firstText(event.clientEmail, clientEmail, getFirstDetectedEmail(storageData)),
      operatorUsername: firstText(event.operatorUsername, operatorUsername),
      extensionVersion: firstText(event.extensionVersion, getExtensionVersion()),
      mode: firstText(event.mode, event.applicationMode, event.directApplicationMode),
      jobId: firstText(event.jobId, matched.jobId),
      jobTitle: firstText(event.jobTitle, matched.jobTitle),
      city: firstText(event.city, matched.city),
      state: firstText(event.state, matched.state),
      locationName: firstText(event.locationName, matched.locationName),
      employmentType: firstText(event.employmentType, matched.employmentTypeL10N, matched.employmentType),
      jobType: firstText(event.jobType, matched.jobType, matched.jobTypeL10N),
      pay: firstText(
        event.pay,
        matched.totalPayRateMaxL10N,
        matched.totalPayRateMinL10N,
        matched.totalPayRateMax
      ),
      pageUrl: firstText(sanitizeUrl(event.pageUrl), sanitizeUrl(senderData?.tabUrl)),
      scheduleId: firstText(event.scheduleId),
      applicationId: firstText(event.applicationId),
      currentState: firstText(event.currentState),
      selectedScheduleId: firstText(event.selectedScheduleId),
      workflowStepName: firstText(event.workflowStepName),
      redirectUrl: firstText(event.redirectUrl),
      errorCode: firstText(event.errorCode),
      errorClassification: firstText(event.errorClassification),
      reasonCode: firstText(event.reasonCode),
      httpStatus: firstText(event.httpStatus),
      message: firstText(event.message),
    };
  }

  function shouldDeliverEvent(event) {
    if (event.channel && event.channel !== NOTIFICATIONS.CHANNELS.TELEGRAM) {
      return { deliver: false, result: { skipped: 'unsupported-channel' } };
    }
    if (!NOTIFICATIONS.STANDARD_EVENTS.includes(event.eventName)) {
      return { deliver: false, result: { muted: true, eventName: event.eventName } };
    }
    return { deliver: true };
  }

  function dedupeKey(event, username, clientEmail) {
    return [
      event.eventName,
      event.dedupeKey || '',
      event.attemptId || '',
      event.jobId || '',
      event.scheduleId || '',
      event.applicationId || '',
      event.mode || '',
      event.reasonCode || event.errorCode || '',
      clientEmail || '',
      username || '',
    ].join('::');
  }

  async function deliverEnvelope(envelope) {
    const event = normalizeEvent(envelope.event);
    if (!event) return { skipped: 'invalid-event' };

    const summary = {
      eventName: event.eventName,
      jobId: event.jobId,
      scheduleId: event.scheduleId,
      applicationId: event.applicationId,
      attemptId: event.attemptId,
    };
    log.debug('notification received', summary);

    const policyDecision = shouldDeliverEvent(event);
    if (!policyDecision.deliver) {
      log.debug('notification muted/skipped by policy', { ...summary, result: policyDecision.result });
      return policyDecision.result;
    }

    const [storageData, username, clientEmail] = await Promise.all([
      storage.getLocal([STORAGE_KEYS.LAST_MATCHED_JOB, STORAGE_KEYS.DETECTED_EMAILS]),
      account.getStoredOperatorUsername(),
      account.getStoredLoginUsername(),
    ]);

    if (!username) {
      log.warn('notification skipped: no operator username', summary);
      return { skipped: 'no-username' };
    }

    const runtimePolicy = await root.AMZ_VALIDATION?.refreshFromServer?.(username);
    if (
      runtimePolicy?.valid !== true ||
      runtimePolicy?.controls?.features?.telegram === false
    ) {
      log.warn('notification skipped: runtime denied', {
        ...summary,
        policyValid: runtimePolicy?.valid === true,
        telegramEnabled: runtimePolicy?.controls?.features?.telegram === true,
      });
      return { skipped: 'runtime-denied' };
    }

    const now = Date.now();
    clearExpiredDedupeEntries(now);
    const ttl = NOTIFICATIONS.DEDUPE_TTL_MS[event.eventName] ?? NOTIFICATIONS.DEFAULT_DEDUPE_TTL_MS;
    const eventClientEmail = firstText(event.clientEmail, clientEmail);
    const key = dedupeKey(event, username, eventClientEmail);
    if (ttl > 0 && recentNotifications.has(key)) {
      log.debug('notification deduped', summary);
      return { deduped: true };
    }
    if (ttl > 0) recentNotifications.set(key, { at: now, ttl });

    try {
      const details = createDetails(event, envelope.sender || {}, storageData, clientEmail, username);
      const result = await root.AMZ_TELEGRAM_CHANNEL.send(event, details);
      log.debug('notification delivered', {
        ...summary,
        messageId: result.messageId || result.message_id || result.messageId || null,
      });
      return { ...result, delivered: true };
    } catch (error) {
      if (ttl > 0) recentNotifications.delete(key);
      log.error('notification delivery failed:', {
        ...summary,
        errorMessage: error?.message || String(error),
      });
      throw error;
    }
  }

  async function flushQueue() {
    if (flushInFlight) return flushInFlight;
    flushInFlight = (async () => {
      const processedIds = new Set();

      while (true) {
        const queue = await readQueue();
        const pending = queue.filter(envelope => envelope?.id && !processedIds.has(envelope.id));
        if (pending.length === 0) break;

        for (const envelope of pending) {
          processedIds.add(envelope.id);
          try {
            const result = await deliverEnvelope(envelope);
            await removeQueuedEnvelope(envelope.id);
            log.debug('queued notification processed', {
              id: envelope.id,
              eventName: envelope.event?.eventName || null,
              result,
            });
          } catch (error) {
            const attempts = Number(envelope.attempts || 0) + 1;
            const failedPatch = {
              attempts,
              lastError: error?.message || String(error),
              lastAttemptAt: nowIstIso(),
            };
            if (attempts >= (Number(NOTIFICATIONS.MAX_DELIVERY_ATTEMPTS) || 3)) {
              await removeQueuedEnvelope(envelope.id);
              log.error('queued notification dropped after retries:', failedPatch);
            } else {
              await updateQueuedEnvelope(envelope.id, failedPatch);
            }
          }
        }
      }
    })().finally(() => {
      flushInFlight = null;
    });
    return flushInFlight;
  }

  async function sendEvent(event, sender = {}) {
    const normalized = normalizeEvent(event);
    if (!normalized) return { skipped: 'missing-event' };
    const policyDecision = shouldDeliverEvent(normalized);
    if (!policyDecision.deliver) return policyDecision.result;
    const envelope = await enqueueEvent(normalized, sender);
    void flushQueue().catch(error => {
      log.error('notification queue flush failed:', error);
    });
    return {
      queued: true,
      envelopeId: envelope.id,
      eventName: normalized.eventName,
    };
  }

  root.AMZ_BACKGROUND_NOTIFICATIONS = Object.freeze({
    flushQueue,
    normalizeEvent,
    sendEvent,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
