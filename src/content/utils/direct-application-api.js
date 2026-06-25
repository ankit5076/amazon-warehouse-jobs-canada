/* Pure API parsing and error classification helpers for direct booking. */
(function (root) {
  'use strict';

  if (root.AMZ_DIRECT_API) return;

  const { DIRECT_APPLICATION } = root.AMZ_CONSTANTS;

  function responseData(payload) {
    return payload?.data || payload || null;
  }

  function parseRequestBody(options = {}) {
    try {
      return options.body ? JSON.parse(options.body) : null;
    } catch (_) {
      return null;
    }
  }

  function requestBodySummary(options = {}) {
    const body = parseRequestBody(options);
    if (!body || typeof body !== 'object') return null;

    return {
      jobId: body.jobId || body.payload?.jobId || null,
      scheduleId: body.scheduleId || body.payload?.scheduleId || null,
      applicationId: body.applicationId || null,
      type: body.type || null,
      workflowStepName: body.workflowStepName || null,
      dspEnabled: body.dspEnabled ?? null,
      activeApplicationCheckEnabled: body.activeApplicationCheckEnabled ?? null,
      pageSize: body.pageSize ?? null,
      hasCandidateId: Boolean(body.candidateId),
    };
  }

  function getErrorCode(payload) {
    const data = responseData(payload);
    return (
      data?.errorCode ||
      payload?.errorCode ||
      data?.code ||
      payload?.code ||
      null
    );
  }

  function getErrorMessage(payload) {
    const data = responseData(payload);
    return (
      data?.errorMessage ||
      payload?.errorMessage ||
      data?.error ||
      payload?.error ||
      data?.message ||
      payload?.message ||
      null
    );
  }

  function getErrorMetadata(payload) {
    const data = responseData(payload);
    return data?.errorMetadata || payload?.errorMetadata || null;
  }

  function isCaptchaResponse(response) {
    return Boolean(
      response &&
      response.status === DIRECT_APPLICATION.WAF.CAPTCHA_HTTP_STATUS &&
      String(response.headers.get(DIRECT_APPLICATION.WAF.CAPTCHA_HEADER_NAME) || '').toLowerCase() ===
        DIRECT_APPLICATION.WAF.CAPTCHA_HEADER_VALUE
    );
  }

  function objectKeys(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).slice(0, 30)
      : [];
  }

  function responseShape(payload, data) {
    return {
      payloadType: Array.isArray(payload) ? 'array' : typeof payload,
      payloadKeys: objectKeys(payload),
      hasDataWrapper: Boolean(payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')),
      dataType: Array.isArray(data) ? 'array' : typeof data,
      dataKeys: objectKeys(data),
      nestedDataKeys: objectKeys(data?.data),
      jobScheduleSelectedKeys: objectKeys(data?.jobScheduleSelected),
      jobSelectedKeys: objectKeys(data?.jobSelected),
    };
  }

  function responseSummary(response, payload, data) {
    return {
      httpStatus: response?.status || null,
      ok: response?.ok === true,
      errorCode: getErrorCode(payload),
      errorMessage: getErrorMessage(payload),
      applicationId: data?.applicationId || null,
      currentState: data?.currentState || null,
      workflowStepName: data?.workflowStepName || null,
      selectedScheduleId: data?.jobScheduleSelected?.scheduleId || null,
      captchaRequired: isCaptchaResponse(response),
      responseShape: responseShape(payload, data),
    };
  }

  function includesHint(errorCode, hints = []) {
    const normalized = String(errorCode || '').toUpperCase();
    return hints.some(hint => normalized.includes(String(hint).toUpperCase()));
  }

  function classifyError({ response, payload, forcedClassification, error }) {
    if (forcedClassification) return forcedClassification;

    const httpStatus = response?.status || error?.httpStatus || null;
    const errorCode = getErrorCode(payload) || error?.errorCode || null;

    if (isCaptchaResponse(response)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.CAPTCHA_REQUIRED;
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.AUTH_REQUIRED;
    }

    if (includesHint(errorCode, DIRECT_APPLICATION.ERROR_CODE_HINTS.RESETTABLE_EXISTING_APPLICATION)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.RESETTABLE_EXISTING_APPLICATION;
    }
    if (includesHint(errorCode, DIRECT_APPLICATION.ERROR_CODE_HINTS.ALREADY_APPLIED)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ALREADY_APPLIED;
    }
    if (includesHint(errorCode, DIRECT_APPLICATION.ERROR_CODE_HINTS.ONE_ACTIVE_APPLICATION)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.ONE_ACTIVE_APPLICATION;
    }
    if (includesHint(errorCode, DIRECT_APPLICATION.ERROR_CODE_HINTS.EXACT_DUPLICATE_ACCOUNT)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.EXACT_DUPLICATE_ACCOUNT;
    }
    if (includesHint(errorCode, DIRECT_APPLICATION.ERROR_CODE_HINTS.UNAVAILABLE_OR_RESERVATION_FAILED)) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNAVAILABLE_OR_RESERVATION_FAILED;
    }
    if (httpStatus && httpStatus >= 500) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.SERVER_OR_PROXY_ERROR;
    }
    if (error?.name === 'AbortError' || error?.classification === DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT) {
      return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.NETWORK_OR_TIMEOUT;
    }

    return DIRECT_APPLICATION.ERROR_CLASSIFICATIONS.UNKNOWN;
  }

  root.AMZ_DIRECT_API = Object.freeze({
    classifyError,
    getErrorCode,
    getErrorMessage,
    getErrorMetadata,
    includesHint,
    isCaptchaResponse,
    parseRequestBody,
    requestBodySummary,
    responseData,
    responseShape,
    responseSummary,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
