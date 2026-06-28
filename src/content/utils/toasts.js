/* SweetAlert rendering for polling and job-match feedback. */
(function (root) {
  'use strict';

  if (root.AMZ_TOASTS) return;

  const { ALERTS, AUTH_PROBE } = root.AMZ_CONSTANTS;
  const text = root.AMZ_TEXT;

  function getApiStatusLabel(apiMeta = {}) {
    const status = typeof apiMeta.status === 'number' ? String(apiMeta.status) : 'N/A';
    const duration = typeof apiMeta.durationMs === 'number' ? apiMeta.durationMs + ' ms' : 'N/A';
    const details = apiMeta.details ? ' | ' + text.escapeHtml(apiMeta.details) : '';

    if (apiMeta.state === 'success') {
      return '✅ Success | HTTP: ' + status + ' | Time: ' + duration + details;
    }
    if (apiMeta.state === 'failed') {
      return '❌ Failed | HTTP: ' + status + ' | Time: ' + duration + details;
    }
    if (apiMeta.state === 'idle') {
      return 'Polling active; next request queued...';
    }
    return '⏳ Request in progress...';
  }


  function normalizeAuthProbeStatus(value) {
    return Object.values(AUTH_PROBE.STATUSES).includes(value)
      ? value
      : AUTH_PROBE.STATUSES.CHECKING;
  }

  function getAuthProbeStatusMeta(status) {
    const normalized = normalizeAuthProbeStatus(status);
    const label = AUTH_PROBE.LABELS[normalized] || AUTH_PROBE.LABELS.checking;

    const colorByStatus = {
      [AUTH_PROBE.STATUSES.CHECKING]: '#aaa',
      [AUTH_PROBE.STATUSES.AUTHENTICATED]: '#8fd19e',
      [AUTH_PROBE.STATUSES.NOT_AUTHENTICATED]: '#ff9b92',
      [AUTH_PROBE.STATUSES.UNKNOWN]: '#ffcc66',
    };

    return {
      label,
      color: colorByStatus[normalized] || '#aaa',
    };
  }

  function formatInterval(ms, unit) {
    const intervalMs = Number(ms || 0);
    if (unit === 'ms') {
      return String(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0) + 'ms';
    }
    return (intervalMs / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  }

  function formatJobType(value) {
    if (Array.isArray(value)) {
      return value.length ? value.join(', ') : 'N/A';
    }
    return value || 'N/A';
  }

  function buildPollingToastHtml(options = {}) {
    const configuredIntervalLabel = formatInterval(options.intervalMs, options.intervalUnit);
    const effectiveIntervalLabel = formatInterval(
      options.effectiveIntervalMs || options.intervalMs,
      options.intervalUnit
    );
    const jobType = formatJobType(options.jobType);
    const cityLabel = options.cityTags?.length
      ? options.cityTags.join(', ')
      : options.selectedCity || 'N/A';
    const apiStatus = getApiStatusLabel(options.apiMeta);
    const authProbeMeta = getAuthProbeStatusMeta(options.authProbeStatus);
    const authBackoffLine = options.authBackoffActive
      ? '<br><span style="color:#ffcc66;font-size:0.8em;">⚠ Auth backoff active: polling every ' +
        text.escapeHtml(effectiveIntervalLabel) + '. User setting remains ' +
        text.escapeHtml(configuredIntervalLabel) + '.</span>'
      : '';

    return (
      '<div style="text-align:left;line-height:1.45;">' +
      '<span style="color:#fff;font-weight:bold;">🔍 Fetching Jobs...</span><br>' +
      '<span style="color:#ccc;font-size:0.85em;">📍 ' + text.escapeHtml(cityLabel) +
      ' &nbsp;|&nbsp; 📏 ' + text.escapeHtml(options.distance || 'N/A') +
      ' km &nbsp;|&nbsp; 💼 ' + text.escapeHtml(jobType) + '</span><br>' +
      '<span style="color:#aaa;font-size:0.8em;">⏱ Poll every ' +
      text.escapeHtml(effectiveIntervalLabel) + '</span>' +
      authBackoffLine + '<br>' +
      '<span style="color:' + authProbeMeta.color + ';font-size:0.8em;">🔐 Auth: ' +
      text.escapeHtml(authProbeMeta.label) + '</span><br>' +
      '<span style="color:#d7d7d7;font-size:0.8em;">📡 API: ' + apiStatus + '</span>' +
      '</div>'
    );
  }

  function renderPollingToast(options = {}) {
    const html = buildPollingToastHtml(options);
    const existingToast = document.querySelector('.swal2-toast.amazon-polling-toast');
    if (Swal.isVisible() && existingToast) {
      Swal.update({ html });
      return;
    }

    Swal.fire({
      toast: true,
      position: 'bottom-start',
      showConfirmButton: false,
      allowEscapeKey: false,
      allowEnterKey: false,
      allowOutsideClick: false,
      html,
      customClass: { popup: 'amazon-polling-toast' },
    });
  }

  function showJobsReceivedToast(intervalMs) {
    Swal.fire({
      toast: true,
      position: 'bottom-start',
      timer: intervalMs,
      showConfirmButton: false,
      timerProgressBar: true,
      html: '<span style="color: green;">' + text.escapeHtml(ALERTS.MATCHING_PROGRESS_LABEL) + '</span>',
    });
  }

  function showJobFoundToast(city) {
    Swal.fire({
      title: 'Job Matched!',
      text: 'Matching job in ' + city,
      icon: 'success',
      timer: ALERTS.JOB_FOUND_TOAST_DURATION_MS,
      timerProgressBar: true,
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
    });
  }

  function showCreditsRequiredPopup(details = {}) {
    const jobLine = details.city || details.jobId
      ? '<br><span style="font-size:0.86em;opacity:.78;">' +
        text.escapeHtml([details.city, details.jobId].filter(Boolean).join(' · ')) +
        '</span>'
      : '';

    Swal.fire({
      title: 'Job search is free',
      html:
        '<span style="font-size:0.95em;">A matching job was found, but booking requires paid access. ' +
        'Open the extension and choose <strong>30-Day</strong> or <strong>Pro</strong> access to continue.</span>' +
        jobLine,
      icon: 'info',
      confirmButtonText: 'OK',
    });
  }

  function showBookingConfirmedToast(details = {}) {
    const meta = [details.jobId, details.scheduleId].filter(Boolean).join(' · ');
    const applicationLine = details.applicationId
      ? '<br><span style="font-size:0.82em;opacity:.78;">' +
        text.escapeHtml(details.applicationId) + '</span>'
      : '';

    Swal.fire({
      title: 'Booking confirmed',
      html:
        '<span style="font-size:0.92em;">' +
        text.escapeHtml(meta || 'Amazon booking succeeded') +
        '</span>' +
        applicationLine,
      icon: 'success',
      timer: 20000,
      timerProgressBar: true,
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
    });
  }

  function closePollingToast() {
    const existingToast = document.querySelector('.swal2-toast.amazon-polling-toast');
    if (existingToast && Swal.isVisible()) Swal.close();
  }

  root.AMZ_TOASTS = Object.freeze({
    renderPollingToast,
    showJobsReceivedToast,
    showJobFoundToast,
    showCreditsRequiredPopup,
    showBookingConfirmedToast,
    closePollingToast,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
