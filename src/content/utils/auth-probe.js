/* Refresh-triggered Amazon Hiring authenticity probe. */
(function (root) {
  'use strict';

  if (root.AMZ_AUTH_PROBE) return;

  const { AUTH_PROBE } = root.AMZ_CONSTANTS;
  const state = root.AMZ_STATE;
  const log = root.AMZ_LOGGER.create('[amazon-shift][auth-probe]', {
    workflow: 'auth-probe',
    source: 'content/utils/auth-probe.js',
  });
  let lastProbeSnapshot = Object.freeze({
    startedAt: 0,
    completedAt: 0,
    pageUrl: '',
    status: '',
  });

  async function persistStatus(status, metadata = {}) {
    await state.persistAuthProbeStatus(status, metadata);
  }

  function getAuthorizationHeader() {
    const sessionToken = window.localStorage.getItem('sessionToken') || '';
    const candidateId = window.localStorage.getItem('bbCandidateId') || '';
    const loginStatus = candidateId ? 'AUTHENTICATED' : 'UNAUTHENTICATED';
    return `Status|${loginStatus}|Session|${sessionToken}`;
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), AUTH_PROBE.FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function parseJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async function persistAndReturn(status, metadata = {}) {
    await persistStatus(status, metadata);
    lastProbeSnapshot = Object.freeze({
      ...lastProbeSnapshot,
      completedAt: Date.now(),
      status,
    });
    return status;
  }

  async function runRefreshTriggeredProbe() {
    if (!root.AMZ_URL.isJobSearchPage()) return AUTH_PROBE.STATUSES.UNKNOWN;

    lastProbeSnapshot = Object.freeze({
      startedAt: Date.now(),
      completedAt: 0,
      pageUrl: window.location.href,
      status: AUTH_PROBE.STATUSES.CHECKING,
    });
    await persistStatus(AUTH_PROBE.STATUSES.CHECKING);

    try {
      const csrfResponse = await fetchWithTimeout(AUTH_PROBE.CSRF_URL, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });
      const csrfPayload = await parseJson(csrfResponse);
      const csrfToken = csrfPayload?.token || '';

      if (AUTH_PROBE.NOT_AUTHENTICATED_HTTP_STATUSES.includes(csrfResponse.status)) {
        return persistAndReturn(AUTH_PROBE.STATUSES.NOT_AUTHENTICATED, {
          httpStatus: csrfResponse.status,
          detail: 'CSRF token request returned an unauthorized status.',
        });
      }

      if (!csrfResponse.ok || !csrfToken) {
        return persistAndReturn(AUTH_PROBE.STATUSES.UNKNOWN, {
          httpStatus: csrfResponse.status,
          detail: 'CSRF token request did not return a usable token.',
        });
      }

      const authorizeResponse = await fetchWithTimeout(AUTH_PROBE.AUTHORIZE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'csrf-token': csrfToken,
          Authorization: getAuthorizationHeader(),
        },
        body: JSON.stringify({
          redirectUrl: AUTH_PROBE.REDIRECT_URL,
          token: csrfToken,
        }),
      });
      const authorizePayload = await parseJson(authorizeResponse);
      const candidateId = authorizePayload?.candidateId || '';

      if (AUTH_PROBE.NOT_AUTHENTICATED_HTTP_STATUSES.includes(authorizeResponse.status)) {
        return persistAndReturn(AUTH_PROBE.STATUSES.NOT_AUTHENTICATED, {
          httpStatus: authorizeResponse.status,
          detail: 'Authorize check returned an unauthorized status.',
        });
      }

      if (authorizeResponse.ok && candidateId) {
        return persistAndReturn(AUTH_PROBE.STATUSES.AUTHENTICATED, {
          httpStatus: authorizeResponse.status,
          detail: 'Authorize check returned a candidate id.',
        });
      }

      if (authorizeResponse.ok) {
        return persistAndReturn(AUTH_PROBE.STATUSES.NOT_AUTHENTICATED, {
          httpStatus: authorizeResponse.status,
          detail: 'Authorize check completed without a candidate id.',
        });
      }

      return persistAndReturn(AUTH_PROBE.STATUSES.UNKNOWN, {
        httpStatus: authorizeResponse.status,
        detail: 'Authorize check returned an unexpected status.',
      });
    } catch (error) {
      return persistAndReturn(AUTH_PROBE.STATUSES.UNKNOWN, {
        detail: error?.name === 'AbortError'
          ? 'Authorize check timed out.'
          : (error?.message || 'Authorize check failed.'),
      });
    }
  }

  function getLastProbeSnapshot() {
    return lastProbeSnapshot;
  }

  // One probe per job-search document load/refresh. Consumers can await
  // `ready` so GraphQL polling never races ahead of session verification.
  const ready = runRefreshTriggeredProbe().catch(error => {
    log.error('refresh-triggered auth probe failed:', error);
  });

  root.AMZ_AUTH_PROBE = Object.freeze({
    ready,
    getLastProbeSnapshot,
    runRefreshTriggeredProbe,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
