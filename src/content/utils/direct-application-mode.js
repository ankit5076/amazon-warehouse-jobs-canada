/* Shared direct-application mode state for booking and native UI fallback controllers. */
(function (root) {
  'use strict';

  if (root.AMZ_DIRECT_APPLICATION_MODE) return;

  const { DIRECT_APPLICATION } = root.AMZ_CONSTANTS;

  function defaultEnabled() {
    return DIRECT_APPLICATION.useDirectApplication !== false;
  }

  function normalize(value) {
    return typeof value === 'boolean' ? value : defaultEnabled();
  }

  function label(enabled) {
    return enabled ? 'automated' : 'manual';
  }

  function create(options = {}) {
    const log = options.log || { debug: () => {} };
    let enabled = normalize(options.initialEnabled);

    function isEnabled() {
      return enabled !== false;
    }

    function setEnabled(value) {
      const nextEnabled = normalize(value);
      if (enabled === nextEnabled) return enabled;
      enabled = nextEnabled;
      log.debug('direct application mode updated', {
        useDirectApplication: enabled,
        mode: label(enabled),
      });
      return enabled;
    }

    function mode() {
      return label(enabled);
    }

    return Object.freeze({
      isEnabled,
      setEnabled,
      mode,
    });
  }

  root.AMZ_DIRECT_APPLICATION_MODE = Object.freeze({
    normalize,
    label,
    create,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
