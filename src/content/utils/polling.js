/* Single-flight polling controller. */
(function (root) {
  'use strict';

  if (root.AMZ_POLLING) return;

  const { POLLING } = root.AMZ_CONSTANTS;

  function createSingleFlightPoller({ run, canRun, getDelayMs }) {
    let timerId = null;
    let inFlight = false;
    let enabled = false;

    function clearTimer() {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }

    function resolveDelay(delayMs) {
      const parsed = Number.parseInt(delayMs, 10);
      const baseDelayMs = Number.isFinite(parsed) && parsed > 0 ? parsed : POLLING.FALLBACK_DELAY_MS;
      const minJitterMs = Math.max(0, Number.parseInt(POLLING.SCHEDULE_JITTER_MIN_MS, 10) || 0);
      const maxJitterMs = Math.max(
        minJitterMs,
        Number.parseInt(POLLING.SCHEDULE_JITTER_MAX_MS, 10) || minJitterMs
      );
      return baseDelayMs + minJitterMs + Math.floor(Math.random() * (maxJitterMs - minJitterMs + 1));
    }

    function schedule(delayMs = getDelayMs()) {
      if (!enabled || !canRun()) return;
      clearTimer();
      timerId = setTimeout(loop, resolveDelay(delayMs));
    }

    async function loop() {
      timerId = null;
      if (!enabled || !canRun()) return;
      if (inFlight) {
        schedule();
        return;
      }

      inFlight = true;
      try {
        await run();
      } finally {
        inFlight = false;
        if (enabled && canRun()) schedule();
      }
    }

    function start() {
      if (enabled) return;
      enabled = true;
      if (!inFlight) loop();
    }

    function stop() {
      enabled = false;
      clearTimer();
    }

    function restart() {
      if (!enabled) return;
      schedule();
    }

    return Object.freeze({
      start,
      stop,
      restart,
      isEnabled: () => enabled,
      isInFlight: () => inFlight,
    });
  }

  root.AMZ_POLLING = Object.freeze({
    createSingleFlightPoller,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
