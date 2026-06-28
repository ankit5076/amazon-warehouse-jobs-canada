/* Telegram delivery channel for normalized notification events. */
(function (root) {
  'use strict';

  if (root.AMZ_TELEGRAM_CHANNEL) return;

  const { AMAZON, NOTIFICATIONS } = root.AMZ_CONSTANTS;
  const text = root.AMZ_TEXT;
  const log = root.AMZ_LOGGER?.create?.('[telegram-channel]', {
    workflow: 'telegram-delivery',
    source: 'background/telegram.js',
  }) || Object.assign(() => {}, {
    error: () => {},
    warn: () => {},
    debug: () => {},
  });

  function normalizeText(value) {
    if (Array.isArray(value)) return normalizeText(value.find(Boolean));
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized === 'null' || normalized === 'undefined') return '';
    return normalized;
  }

  function addLine(lines, icon, value) {
    const normalized = normalizeText(value);
    if (!normalized) return;
    lines.push(`${icon} ${text.escapeHtml(normalized)}`);
  }

  function addCodeLine(lines, icon, value) {
    const normalized = normalizeText(value);
    if (!normalized) return;
    lines.push(`${icon} <code>${text.escapeHtml(normalized)}</code>`);
  }

  function getExtensionVersion() {
    try {
      return normalizeText(root.chrome?.runtime?.getManifest?.()?.version);
    } catch (_) {
      return '';
    }
  }

  function formatExtensionVersion(value) {
    const normalized = normalizeText(value || getExtensionVersion());
    if (!normalized) return '';
    return 'Extension v' + normalized.replace(/^v/i, '');
  }

  function formatMode(value) {
    const normalized = normalizeText(value);
    const lower = normalized.toLowerCase();
    if (!normalized) return '';
    if (['direct', 'automated', 'auto', 'true', 'enabled'].includes(lower)) {
      return 'Mode: Direct';
    }
    if (['manual', 'false', 'disabled'].includes(lower)) {
      return 'Mode: Manual';
    }
    return 'Mode: ' + normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function headerFor(eventName) {
    const headers = {
      [NOTIFICATIONS.EVENTS.JOB_MATCHED]: '🔎 <b>Job Matched</b>',
      [NOTIFICATIONS.EVENTS.BOOKED]: '🏆 <b>Booked</b>',
    };
    return headers[eventName] || `🔔 <b>${text.escapeHtml(eventName || 'Notification')}</b>`;
  }

  function buildJobMeta(details) {
    const parts = [];
    if (details.jobType) parts.push(`Job Type: ${details.jobType}`);
    if (details.employmentType && details.employmentType !== details.jobType) {
      parts.push(`Employment: ${details.employmentType}`);
    }
    if (details.pay) parts.push(`Pay: ${details.pay}`);
    return parts.join(' · ');
  }

  function shouldShowDiagnostics(eventName) {
    return eventName !== NOTIFICATIONS.EVENTS.JOB_MATCHED
      && eventName !== NOTIFICATIONS.EVENTS.BOOKED;
  }

  function formatNotificationText(event = {}, details = {}) {
    const lines = [headerFor(event.eventName)];
    const showDiagnostics = shouldShowDiagnostics(event.eventName);

    addLine(lines, '👤', details.clientEmail);
    addLine(lines, '⚙️', formatMode(details.mode));
    const location = [details.locationName, details.city, details.state].filter(Boolean).join(' — ');
    addLine(lines, '📍', location);
    addLine(lines, '🏷️', details.jobTitle);
    addLine(lines, '🧾', buildJobMeta(details));
    addCodeLine(lines, '🆔', details.jobId);
    addCodeLine(lines, '🗓️', details.scheduleId);
    addCodeLine(lines, '🧾', details.applicationId);
    addLine(lines, '📌', details.currentState);
    addCodeLine(lines, '🎯', details.selectedScheduleId);
    addLine(lines, '🪜', details.workflowStepName);

    if (showDiagnostics) {
      addLine(lines, '🧭', details.errorClassification || details.reasonCode);
      addCodeLine(lines, '🏷️', details.errorCode);
      if (details.httpStatus) addLine(lines, '🌐', `HTTP ${details.httpStatus}`);
      addLine(lines, '⚠️', details.message);
    }

    addLine(lines, '➡️', details.redirectUrl);
    addLine(lines, '🔗', details.pageUrl);
    addLine(lines, '🧩', formatExtensionVersion(details.extensionVersion));

    return lines.join('\n');
  }

  function normalizeTelegramMessageId(value) {
    const numberValue = Number(value ?? 0);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
  }

  async function send(event, details) {
    const notificationText = formatNotificationText(event, details);
    log.debug('sending telegram notification', {
      eventName: event?.eventName || null,
      jobId: details?.jobId || null,
      scheduleId: details?.scheduleId || null,
      applicationId: details?.applicationId || null,
    });

    const result = await root.AMZ_API.apiSendTelegramNotification({
      text: notificationText,
      country: AMAZON?.COUNTRY_CONFIG?.country || null,
      event_name: event?.eventName || null,
      attempt_id: event?.attemptId || null,
      extension_version: details?.extensionVersion || getExtensionVersion() || null,
      operator_username: details?.operatorUsername || null,
      client_email: details?.clientEmail || null,
      job_id: details?.jobId || event?.jobId || null,
      schedule_id: details?.scheduleId || event?.scheduleId || null,
      confirmed_schedule_id: details?.selectedScheduleId || null,
      application_id: details?.applicationId || event?.applicationId || null,
      city: details?.city || null,
      state: details?.state || null,
      location_name: details?.locationName || null,
      job_title: details?.jobTitle || null,
      employment_type: details?.employmentType || null,
      job_type: details?.jobType || null,
      pay: details?.pay || null,
      page_url: details?.pageUrl || event?.pageUrl || null,
      current_state: details?.currentState || null,
      selected_schedule_id: details?.selectedScheduleId || null,
      workflow_step_name: details?.workflowStepName || null,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const messageId = normalizeTelegramMessageId(result?.message_id ?? result?.messageId);
    if (!result || result.delivered !== true) {
      throw new Error(result?.error || 'telegram relay failed');
    }
    if (!messageId) {
      throw new Error('telegram relay returned delivered=true without a Telegram message id');
    }
    return { ...result, messageId };
  }

  root.AMZ_TELEGRAM_CHANNEL = Object.freeze({
    formatNotificationText,
    send,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
