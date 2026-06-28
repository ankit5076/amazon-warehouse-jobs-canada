/* Shared Supabase paid-access API client. Keep this file byte-identical across paid extensions. */
(function (root) {
  'use strict';

  if (root.AMZ_LICENSE_API) return;

  const constants = root.AMZ_CONSTANTS || {};

  function gateConfig() {
    const backend = constants.BACKEND || {};
    const payment = constants.PAYMENT_GATE || {};
    const endpoints = payment.ENDPOINTS || backend.ENDPOINTS || {};
    return {
      baseUrl: payment.API_BASE_URL || backend.BASE_URL || '',
      productId: payment.PRODUCT_ID || backend.PRODUCT_ID || '',
      country: payment.COUNTRY || backend.COUNTRY || '',
      extensionName: payment.EXTENSION_NAME || backend.PRODUCT_NAME || '',
      defaultSyncIntervalMs: payment.DEFAULT_SYNC_INTERVAL_MS || backend.DEFAULT_LICENSE_SYNC_INTERVAL_MS || 15 * 60 * 1000,
      endpoints: {
        check: endpoints.CHECK || endpoints.LICENSE_CHECK || '/license/check',
        checkout: endpoints.CHECKOUT || '/license/checkout',
        usage: endpoints.USAGE || '/license/usage',
      },
    };
  }

  function trimRightSlash(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function checkoutRootUrl() {
    const config = gateConfig();
    return trimRightSlash(config.baseUrl).replace(/\/api\/.*$/, '');
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeInteger(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeSyncIntervalMs(value) {
    const config = gateConfig();
    const parsed = normalizeInteger(value, 0);
    return parsed > 0 ? parsed : Number(config.defaultSyncIntervalMs || 15 * 60 * 1000);
  }

  function normalizeLicenseResponse(raw, fallback = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      allowed: source.allowed === true,
      isProUser: source.isProUser === true,
      accessExpiresAt: String(source.accessExpiresAt || fallback.accessExpiresAt || '').trim(),
      checkoutUrl: String(source.checkoutUrl || fallback.checkoutUrl || '').trim(),
      message: String(source.message || fallback.message || '').trim(),
      syncIntervalMs: normalizeSyncIntervalMs(source.syncIntervalMs),
    };
  }

  async function parseJsonResponse(response) {
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  }

  async function request(path, init = {}) {
    const config = gateConfig();
    const response = await fetch(trimRightSlash(config.baseUrl) + path, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    return parseJsonResponse(response);
  }

  async function checkLicense(input) {
    const amazonEmailId = normalizeEmail(typeof input === 'object' ? input.amazonEmailId || input.amazonEmail : input);
    if (!amazonEmailId) {
      return normalizeLicenseResponse(null, {
        message: 'Enter the Amazon booking email.',
      });
    }
    const config = gateConfig();
    const query = new URLSearchParams({ amazonEmail: amazonEmailId });
    const result = await request(`${config.endpoints.check}?${query.toString()}`, {
      method: 'GET',
    });
    return normalizeLicenseResponse(result.body, {
      message: result.ok ? '' : 'Unable to validate booking access.',
    });
  }

  async function createCheckout(input = {}) {
    const config = gateConfig();
    const emailId = normalizeEmail(input.emailId || input.buyerEmail || input.email);
    const amazonEmailId = normalizeEmail(input.amazonEmailId || input.amazonEmail);
    if (!emailId || !amazonEmailId) {
      return normalizeLicenseResponse(null, {
        message: 'Enter both buyer and Amazon booking emails.',
      });
    }
    const result = await request(config.endpoints.checkout, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        emailId,
        amazonEmailId,
        purchaseType: 'access',
        productId: config.productId,
        country: config.country,
        extension: config.extensionName,
      }),
    });
    return normalizeLicenseResponse(result.body, {
      message: result.ok ? '' : 'Unable to start checkout.',
    });
  }

  function checkoutPageUrl(input = {}) {
    const config = gateConfig();
    const purchaseType = String(input.purchaseType || input.plan || 'access').trim() === 'pro' ? 'pro' : 'access';
    const query = new URLSearchParams({ plan: purchaseType });
    return `${checkoutRootUrl()}/checkout/${encodeURIComponent(config.productId)}?${query.toString()}`;
  }

  async function recordUsage(payload = {}) {
    const config = gateConfig();
    const emailId = normalizeEmail(payload.emailId || payload.buyerEmail || payload.email);
    const amazonEmailId = normalizeEmail(payload.amazonEmailId || payload.amazonEmail);
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    if (!amazonEmailId || !idempotencyKey) {
      return normalizeLicenseResponse(null, {
        message: 'Amazon booking email and usage id are required.',
      });
    }
    const result = await request(config.endpoints.usage, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        emailId,
        amazonEmailId,
        idempotencyKey,
        jobId: payload.jobId || null,
        scheduleId: payload.scheduleId || null,
        metadata: payload.metadata || {},
      }),
    });
    return normalizeLicenseResponse(result.body, {
      message: result.ok ? '' : 'Unable to record booking usage.',
    });
  }

  root.AMZ_LICENSE_API = Object.freeze({
    gateConfig,
    normalizeEmail,
    normalizeLicenseResponse,
    checkoutPageUrl,
    checkLicense,
    createCheckout,
    recordUsage,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
