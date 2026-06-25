/* Session-scoped direct-application guard helpers. */
(function (root) {
  'use strict';

  if (root.AMZ_DIRECT_GUARD) return;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function isUiFallbackSuppressionStage(stage) {
    return Boolean(
      root.AMZ_CONSTANTS?.DIRECT_APPLICATION?.UI_FALLBACK_SUPPRESSION_STAGES?.includes(stage)
    );
  }

  function sessionStorageRef() {
    return root.window?.sessionStorage || root.sessionStorage || null;
  }

  function create(options = {}) {
    const prefix = options.prefix || 'direct-application';
    const preservedFields = Array.isArray(options.preservedFields)
      ? options.preservedFields
      : [];

    function key(context = {}) {
      return [
        prefix,
        context.jobId || '',
        context.scheduleId || '',
      ].join('::');
    }

    function readKey(storageKey) {
      try {
        const raw = sessionStorageRef()?.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }

    function read(context) {
      return readKey(key(context));
    }

    function readForJob(context = {}) {
      const exact = read(context);
      if (exact) return exact;
      if (!context.jobId) return null;

      const jobPrefix = [
        prefix,
        context.jobId,
        '',
      ].join('::');

      try {
        const session = sessionStorageRef();
        if (!session) return null;
        for (let index = 0; index < session.length; index += 1) {
          const storageKey = session.key(index);
          if (!storageKey || !storageKey.startsWith(jobPrefix)) continue;
          const guard = readKey(storageKey);
          if (guard) return guard;
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    function preserve(context, extras = {}) {
      const previous = read(context);
      if (!previous || typeof previous !== 'object') return {};

      return preservedFields.reduce((preserved, field) => {
        if (!hasOwn(extras, field) && previous[field] !== undefined && previous[field] !== null) {
          preserved[field] = previous[field];
        }
        return preserved;
      }, {});
    }

    function write(context, stage, extras = {}) {
      try {
        const preserved = preserve(context, extras);
        sessionStorageRef()?.setItem(
          key(context),
          JSON.stringify({
            stage,
            updatedAt: Date.now(),
            jobId: context.jobId || null,
            scheduleId: context.scheduleId || null,
            ...preserved,
            ...extras,
          })
        );
      } catch (_) {
        // Session storage is best-effort and must never block booking.
      }
    }

    function suppressesUiFallback(record) {
      return Boolean(
        record &&
        (
          record.fallbackAllowed === false ||
          record.applicationId ||
          isUiFallbackSuppressionStage(record.stage)
        )
      );
    }

    return Object.freeze({
      key,
      preserve,
      read,
      readForJob,
      shouldSuppressUiFallback: isUiFallbackSuppressionStage,
      suppressesUiFallback,
      write,
    });
  }

  root.AMZ_DIRECT_GUARD = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : self);
