/* Content-side sound alerts. */
(function (root) {
  'use strict';

  if (root.AMZ_ALERTS) return;

  const { ALERTS } = root.AMZ_CONSTANTS;
  const log = root.AMZ_LOGGER.create('[alerts]', {
    workflow: 'alerts',
    source: 'content/utils/alerts.js',
  });
  let activeAlertAudio = null;

  async function playSound(file, volume, label) {
    try {
      const audio = new Audio(chrome.runtime.getURL(file));
      audio.volume = volume;
      audio.preload = 'auto';
      activeAlertAudio = audio;
      audio.addEventListener('ended', () => {
        if (activeAlertAudio === audio) activeAlertAudio = null;
      }, { once: true });
      await audio.play();
      log.debug(label + ' sound playback started');
      return true;
    } catch (error) {
      activeAlertAudio = null;
      log.error('Unable to play ' + label + ' sound:', error?.message || error);
      return false;
    }
  }

  async function playJobFoundSound() {
    return playSound(ALERTS.SOUND_FILE, ALERTS.JOB_FOUND_SOUND_VOLUME, 'Job-found');
  }

  async function playSessionUnauthorizedSound() {
    return playSound(
      ALERTS.SESSION_UNAUTHORIZED_SOUND_FILE || ALERTS.SOUND_FILE,
      ALERTS.SESSION_UNAUTHORIZED_SOUND_VOLUME || ALERTS.JOB_FOUND_SOUND_VOLUME,
      'Session-unauthorized'
    );
  }

  async function playBookingTerminalSound(outcome = 'terminal') {
    return playSound(
      ALERTS.BOOKING_TERMINAL_SOUND_FILE ||
        ALERTS.SESSION_UNAUTHORIZED_SOUND_FILE ||
        ALERTS.SOUND_FILE,
      ALERTS.BOOKING_TERMINAL_SOUND_VOLUME ||
        ALERTS.SESSION_UNAUTHORIZED_SOUND_VOLUME ||
        ALERTS.JOB_FOUND_SOUND_VOLUME,
      'Booking-' + outcome
    );
  }

  root.AMZ_ALERTS = Object.freeze({
    playJobFoundSound,
    playSessionUnauthorizedSound,
    playBookingTerminalSound,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
