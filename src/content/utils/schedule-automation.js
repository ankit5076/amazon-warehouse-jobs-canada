/* Job-detail schedule selection and apply-button automation. */
(function (root) {
  'use strict';

  if (root.AMZ_SCHEDULE_AUTOMATION) return;

  const { SCHEDULE_AUTOMATION, SELECTORS, STORAGE_KEYS } = root.AMZ_CONSTANTS;
  const dom = root.AMZ_DOM;
  const storage = root.AMZ_STORAGE;
  const urls = root.AMZ_URL;
  const text = root.AMZ_TEXT;
  const log = root.AMZ_LOGGER.create('[amazon-shift][schedule-automation]', {
    workflow: 'schedule-automation',
    source: 'content/utils/schedule-automation.js',
  });
  const APPLY_CLICK_SESSION_GUARD_KEY = '__amz_schedule_apply_click_guard_v1';

  function create({ isActive, onNoApplyPath } = {}) {
    let cleanupCurrent = null;
    let applyClickGuard = null;

    function active() {
      return typeof isActive === 'function' && isActive() === true;
    }

    function applyClickGuardKey() {
      return [
        urls.getJobIdFromUrl() || '',
        urls.currentUrl() || '',
      ].join('::');
    }

    function getSessionStorage() {
      try {
        return root.window?.sessionStorage || root.sessionStorage || null;
      } catch {
        return null;
      }
    }

    function clearStoredApplyClickGuard() {
      try {
        getSessionStorage()?.removeItem?.(APPLY_CLICK_SESSION_GUARD_KEY);
      } catch {
        // Session storage is best-effort only.
      }
    }

    function readStoredApplyClickGuard() {
      try {
        const raw = getSessionStorage()?.getItem?.(APPLY_CLICK_SESSION_GUARD_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    function writeStoredApplyClickGuard(guard) {
      try {
        getSessionStorage()?.setItem?.(APPLY_CLICK_SESSION_GUARD_KEY, JSON.stringify(guard));
      } catch {
        // Session storage is best-effort only.
      }
    }

    function applyClickInFlight(source) {
      const guard = applyClickGuard || readStoredApplyClickGuard();
      if (!guard) return false;

      const now = Date.now();
      if (now > guard.expiresAt) {
        applyClickGuard = null;
        clearStoredApplyClickGuard();
        return false;
      }

      if (guard.key !== applyClickGuardKey()) return false;
      applyClickGuard = guard;

      if (!guard.reported) {
        guard.reported = true;
        writeStoredApplyClickGuard(guard);
        log.info('apply click skipped because Amazon application navigation is already in flight', {
          source,
          originalSource: guard.source,
          jobId: urls.getJobIdFromUrl(),
          clickedAt: guard.clickedAtIso,
          expiresAt: guard.expiresAtIso,
        });
      }
      return true;
    }

    function rememberApplyClick(source, clicked) {
      if (!clicked) return;
      const now = Date.now();
      const expiresAt = now + SCHEDULE_AUTOMATION.APPLY_CLICK_GUARD_TTL_MS;
      applyClickGuard = {
        key: applyClickGuardKey(),
        source,
        clickedAtIso: new Date(now).toISOString(),
        expiresAt,
        expiresAtIso: new Date(expiresAt).toISOString(),
        reported: false,
      };
      writeStoredApplyClickGuard(applyClickGuard);
    }

    function getScheduleCardDetails(button) {
      const scheduleCard = button?.closest(SELECTORS.SCHEDULE_CARD_ROOT);
      return {
        selectedAt: root.AMZ_TIME?.nowIstIso?.() || new Date().toISOString(),
        pageUrl: urls.currentUrl(),
        jobId: urls.getJobIdFromUrl(),
        buttonText: text.normalizeWhitespace(button?.textContent || '') || null,
        buttonAriaLabel: button?.getAttribute('aria-label') || null,
        scheduleCardText: scheduleCard?.innerText
          ? text.normalizeWhitespace(scheduleCard.innerText)
          : null,
      };
    }

    function getScheduleClickSummary(button, source) {
      const details = getScheduleCardDetails(button);
      return {
        source,
        jobId: details.jobId,
        pageUrl: details.pageUrl,
        buttonText: details.buttonText,
        buttonAriaLabel: details.buttonAriaLabel,
      };
    }

    function chooseScheduleLabel(labels) {
      if (!Array.isArray(labels) || labels.length === 0) return null;

      if (
        SCHEDULE_AUTOMATION.LABEL_SELECTION_STRATEGY ===
        SCHEDULE_AUTOMATION.LABEL_SELECTION_STRATEGIES.FIRST
      ) {
        return labels[0];
      }

      const index = Math.floor(Math.random() * labels.length);
      return labels[index];
    }

    function chooseClickable(elements) {
      return chooseScheduleLabel(elements);
    }

    function compactText(value, limit = 180) {
      const normalized = text.normalizeWhitespace(value || '');
      if (!normalized) return null;
      return normalized.length > limit ? normalized.slice(0, limit) + '...' : normalized;
    }

    function summarizeElement(element) {
      if (!element) return null;
      const getAttribute = typeof element.getAttribute === 'function'
        ? element.getAttribute.bind(element)
        : () => null;
      const className = typeof element.className === 'string'
        ? compactText(element.className, 120)
        : null;
      return {
        tagName: element.tagName || element.nodeName || null,
        dataTestId: getAttribute('data-test-id') || null,
        ariaLabel: getAttribute('aria-label') || null,
        disabled: element.disabled === true || getAttribute('aria-disabled') === 'true',
        className,
        text: compactText(element.innerText || element.textContent || ''),
      };
    }

    function queryElementSummaries(selector, limit = 3) {
      try {
        return Array.from(document.querySelectorAll(selector))
          .slice(0, limit)
          .map(summarizeElement);
      } catch {
        return [];
      }
    }

    function getPageTextHints() {
      const pageText = text.normalizeWhitespace(document.body?.innerText || document.body?.textContent || '');
      const lowerText = pageText.toLowerCase();
      const hintTerms = [
        'no shifts',
        'no schedules',
        'not available',
        'no longer available',
        'currently unavailable',
        'try again',
        'select schedule',
        'apply',
        'schedule',
      ];
      return {
        hints: hintTerms.filter(term => lowerText.includes(term)),
        sample: compactText(pageText, 360),
      };
    }

    function selectScheduleCard() {
      if (!active()) {
        log.debug('selectScheduleCard skipped: inactive');
        return;
      }
      log.debug('selectScheduleCard started');

      const observer = new MutationObserver((_, currentObserver) => {
        const labels = dom.getClickableElements(SELECTORS.SCHEDULE_LABEL);
        const selectedLabel = chooseScheduleLabel(labels);
        log.trace('schedule label observer scan', { labelCount: labels.length, selected: !!selectedLabel }, {
          throttleKey: 'schedule-label-observer-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (!selectedLabel) return;
        if (dom.clickElement(selectedLabel, 'selectScheduleCard label')) {
          log.info('schedule label clicked from observer', {
            labelText: text.normalizeWhitespace(selectedLabel.textContent || ''),
          });
          currentObserver.disconnect();
          clickApplyButton();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const labels = dom.getClickableElements(SELECTORS.SCHEDULE_LABEL);
      const selectedLabel = chooseScheduleLabel(labels);
      log.debug('schedule label initial scan', { labelCount: labels.length, selected: !!selectedLabel });
      if (selectedLabel) {
        if (dom.clickElement(selectedLabel, 'selectScheduleCard existing label')) {
          log.info('schedule label clicked from initial scan', {
            labelText: text.normalizeWhitespace(selectedLabel.textContent || ''),
          });
          observer.disconnect();
          clickApplyButton();
        }
      }
    }

    function clickApplyButton() {
      if (!active()) {
        log.debug('clickApplyButton skipped: inactive');
        return;
      }
      log.debug('clickApplyButton started');

      const observer = new MutationObserver((_, currentObserver) => {
        const buttons = dom.getClickableElements(SELECTORS.APPLY_BUTTONS);
        const button = chooseClickable(buttons);
        log.trace('apply button observer scan', {
          buttonCount: buttons.length,
          selected: !!button,
        }, {
          throttleKey: 'apply-button-observer-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (!button) return;
        if (applyClickInFlight('observer')) {
          currentObserver.disconnect();
          return;
        }
        root.AMZ_APPLICATION_OBSERVABILITY?.recordScheduleClick?.(
          getScheduleCardDetails(button),
          'observer'
        );
        const clicked = dom.clickElement(button, 'clickApplyButton');
        rememberApplyClick('observer', clicked);
        log.info('apply button clicked', {
          clicked,
          ...getScheduleClickSummary(button, 'observer'),
        });
        currentObserver.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const buttons = dom.getClickableElements(SELECTORS.APPLY_BUTTONS);
      const button = chooseClickable(buttons);
      log.debug('apply button initial scan', {
        buttonCount: buttons.length,
        selected: !!button,
      });
      if (button) {
        if (applyClickInFlight('initial')) {
          observer.disconnect();
          return;
        }
        root.AMZ_APPLICATION_OBSERVABILITY?.recordScheduleClick?.(
          getScheduleCardDetails(button),
          'initial'
        );
        const clicked = dom.clickElement(button, 'clickApplyButton existing');
        rememberApplyClick('initial', clicked);
        log.info('apply button clicked', {
          clicked,
          ...getScheduleClickSummary(button, 'initial'),
        });
        observer.disconnect();
      }
    }

    function start() {
      if (!active()) {
        log.debug('start skipped: inactive');
        return;
      }
      log.debug('start called', { pageUrl: urls.currentUrl(), jobId: urls.getJobIdFromUrl() });
      stop('restart');

      let finished = false;
      let scheduleDrawerOpened = false;
      let scheduleLabelSelected = false;
      let selectScheduleClickAttempts = 0;
      let fallbackTimer = null;
      let hardStopTimer = null;
      let retryTimer = null;
      let queuedAttemptTimer = null;
      let postSelectOptionsTimer = null;
      let postLabelApplyTimer = null;
      let observer = null;
      let attemptQueued = false;
      let queuedAttemptSequence = 0;
      let activeQueuedAttemptId = 0;
      const startedAt = Date.now();
      let selectScheduleClickedAt = null;
      let scheduleLabelClickedAt = null;

      const getScheduleSnapshot = (stage, extra = {}) => {
        const scheduleApplyButtons = dom.getClickableElements(SELECTORS.SCHEDULE_APPLY_BUTTON);
        const scheduleLabels = dom.getClickableElements(SELECTORS.SCHEDULE_LABEL);
        const selectScheduleButtons = dom.getClickableElements(SELECTORS.SCHEDULE_SELECT_BUTTON);
        const desktopApplyButtons = dom.getClickableElements(SELECTORS.DESKTOP_APPLY_BUTTON);
        const scheduleCards = queryElementSummaries(SELECTORS.SCHEDULE_CARD_ROOT, 3);
        const expandLinks = queryElementSummaries(SELECTORS.SCHEDULE_EXPAND_LINK, 3);
        return {
          stage,
          pageUrl: urls.currentUrl(),
          jobId: urls.getJobIdFromUrl(),
          elapsedMs: Date.now() - startedAt,
          elapsedSinceSelectScheduleMs: selectScheduleClickedAt ? Date.now() - selectScheduleClickedAt : null,
          elapsedSinceScheduleLabelMs: scheduleLabelClickedAt ? Date.now() - scheduleLabelClickedAt : null,
          scheduleDrawerOpened,
          scheduleLabelSelected,
          selectScheduleClickAttempts,
          counts: {
            scheduleApplyButtons: scheduleApplyButtons.length,
            scheduleLabels: scheduleLabels.length,
            selectScheduleButtons: selectScheduleButtons.length,
            desktopApplyButtons: desktopApplyButtons.length,
            scheduleCards: scheduleCards.length,
            expandLinks: expandLinks.length,
          },
          samples: {
            scheduleApplyButtons: scheduleApplyButtons.slice(0, 3).map(summarizeElement),
            scheduleLabels: scheduleLabels.slice(0, 3).map(summarizeElement),
            selectScheduleButtons: selectScheduleButtons.slice(0, 3).map(summarizeElement),
            desktopApplyButtons: desktopApplyButtons.slice(0, 3).map(summarizeElement),
            scheduleCards,
            expandLinks,
            activeElement: summarizeElement(document.activeElement),
          },
          pageText: getPageTextHints(),
          ...extra,
        };
      };

      const hasVisibleScheduleOptions = snapshot => (
        snapshot.counts.scheduleApplyButtons > 0 ||
        snapshot.counts.scheduleLabels > 0 ||
        snapshot.counts.desktopApplyButtons > 0
      );

      const clearPostSelectOptionsTimer = () => {
        if (postSelectOptionsTimer) clearTimeout(postSelectOptionsTimer);
        postSelectOptionsTimer = null;
      };

      const clearPostLabelApplyTimer = () => {
        if (postLabelApplyTimer) clearTimeout(postLabelApplyTimer);
        postLabelApplyTimer = null;
      };

      const reportNoApplyPath = (reason, diagnostics = null) => {
        if (typeof onNoApplyPath !== 'function') return;

        const details = {
          reason,
          pageUrl: urls.currentUrl(),
          jobId: urls.getJobIdFromUrl(),
          scheduleDrawerOpened,
          scheduleLabelSelected,
          selectScheduleClickAttempts,
          diagnostics,
        };
        log.warn('no apply path detected', details);
        Promise.resolve(onNoApplyPath(details)).catch(error => {
          log.error('no apply path handler failed:', error);
        });
      };

      const schedulePostSelectOptionsCheck = () => {
        clearPostSelectOptionsTimer();
        postSelectOptionsTimer = setTimeout(() => {
          postSelectOptionsTimer = null;
          if (!active() || finished) return;
          const snapshot = getScheduleSnapshot('post-select-schedule-options-grace-expired');
          if (hasVisibleScheduleOptions(snapshot)) {
            log.debug('schedule options appeared after Select schedule', snapshot);
            return;
          }
          log.warn('schedule options missing after Select schedule; treating job as unavailable', snapshot);
          reportNoApplyPath('schedule-options-missing-after-select', snapshot);
          cleanup();
        }, SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS);
        log.debug('scheduled post-select schedule options check', {
          delayMs: SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS,
          snapshot: getScheduleSnapshot('post-select-schedule-options-check-scheduled'),
        });
      };

      const schedulePostLabelApplyCheck = () => {
        clearPostLabelApplyTimer();
        postLabelApplyTimer = setTimeout(() => {
          postLabelApplyTimer = null;
          if (!active() || finished) return;
          const snapshot = getScheduleSnapshot('post-schedule-label-apply-grace-expired');
          if (snapshot.counts.scheduleApplyButtons > 0 || snapshot.counts.desktopApplyButtons > 0) {
            log.debug('apply button appeared after schedule label selection', snapshot);
            return;
          }
          log.warn('apply button missing after schedule label selection; treating job as unavailable', snapshot);
          reportNoApplyPath('apply-button-missing-after-schedule-label', snapshot);
          cleanup();
        }, SCHEDULE_AUTOMATION.POST_SCHEDULE_LABEL_APPLY_GRACE_MS);
        log.debug('scheduled post-label apply button check', {
          delayMs: SCHEDULE_AUTOMATION.POST_SCHEDULE_LABEL_APPLY_GRACE_MS,
          snapshot: getScheduleSnapshot('post-label-apply-check-scheduled'),
        });
      };

      const cleanup = () => {
        log.debug('cleanup called', {
          finished,
          scheduleDrawerOpened,
          scheduleLabelSelected,
          selectScheduleClickAttempts,
        });
        observer?.disconnect();
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (hardStopTimer) clearTimeout(hardStopTimer);
        if (retryTimer) clearInterval(retryTimer);
        if (queuedAttemptTimer) clearTimeout(queuedAttemptTimer);
        clearPostSelectOptionsTimer();
        clearPostLabelApplyTimer();
        fallbackTimer = null;
        hardStopTimer = null;
        retryTimer = null;
        queuedAttemptTimer = null;
        observer = null;
        attemptQueued = false;
        activeQueuedAttemptId = 0;
        if (cleanupCurrent === cleanup) cleanupCurrent = null;
      };
      cleanupCurrent = cleanup;
      log.debug('schedule automation initial snapshot', getScheduleSnapshot('start'));
      const attemptAutoApply = () => {
        if (!active() || finished) {
          log.trace('attemptAutoApply skipped', { active: active(), finished }, {
            throttleKey: 'attempt-skip',
            throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
          });
          return;
        }

        const scheduleApplyButtons = dom.getClickableElements(SELECTORS.SCHEDULE_APPLY_BUTTON);
        const scheduleApplyButton = chooseClickable(scheduleApplyButtons);
        log.trace('attemptAutoApply scan: schedule apply', {
          buttonCount: scheduleApplyButtons.length,
          selected: !!scheduleApplyButton,
        }, {
          throttleKey: 'schedule-apply-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (scheduleApplyButton) {
          if (applyClickInFlight('schedule-apply')) {
            finished = true;
            cleanup();
            return;
          }
          clearPostSelectOptionsTimer();
          clearPostLabelApplyTimer();
          const button = scheduleApplyButton;
          const scheduleDetails = getScheduleCardDetails(button);
          storage.setLocal({ [STORAGE_KEYS.LAST_SELECTED_SCHEDULE]: scheduleDetails });
          root.AMZ_APPLICATION_OBSERVABILITY?.recordScheduleClick?.(scheduleDetails, 'schedule-apply');
          finished = dom.clickElement(button, 'schedule apply');
          rememberApplyClick('schedule-apply', finished);
          log.info('schedule apply clicked', {
            clicked: finished,
            ...getScheduleClickSummary(button, 'schedule-apply'),
          });
          log.debug('schedule apply click detail', { finished, button: getScheduleCardDetails(button) });
          if (finished) cleanup();
          return;
        }

        const scheduleLabels = dom.getClickableElements(SELECTORS.SCHEDULE_LABEL);
        const selectedLabel = chooseScheduleLabel(scheduleLabels);
        log.trace('attemptAutoApply scan: schedule label', {
          labelCount: scheduleLabels.length,
          scheduleLabelSelected,
          selected: !!selectedLabel,
        }, {
          throttleKey: 'schedule-label-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (!scheduleLabelSelected && selectedLabel) {
          clearPostSelectOptionsTimer();
          scheduleLabelClickedAt = Date.now();
          scheduleLabelSelected = dom.clickElement(selectedLabel, 'schedule label');
          log.info('schedule label click result', {
            scheduleLabelSelected,
            labelText: text.normalizeWhitespace(selectedLabel.textContent || ''),
            snapshot: getScheduleSnapshot('schedule-label-clicked', { scheduleLabelSelected }),
          });
          if (scheduleLabelSelected) schedulePostLabelApplyCheck();
          return;
        }

        const selectScheduleButtons = dom.getClickableElements(SELECTORS.SCHEDULE_SELECT_BUTTON);
        log.trace('attemptAutoApply scan: select schedule', {
          buttonCount: selectScheduleButtons.length,
          scheduleDrawerOpened,
          selectScheduleClickAttempts,
        }, {
          throttleKey: 'select-schedule-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (
          selectScheduleButtons.length > 0 &&
          !scheduleDrawerOpened &&
          selectScheduleClickAttempts < SCHEDULE_AUTOMATION.SELECT_SCHEDULE_MAX_ATTEMPTS
        ) {
          selectScheduleClickAttempts += 1;
          const clicked = dom.clickElement(chooseClickable(selectScheduleButtons), 'select schedule');
          scheduleDrawerOpened = scheduleDrawerOpened || clicked;
          if (clicked) selectScheduleClickedAt = Date.now();
          log.info('select schedule click result', {
            clicked,
            scheduleDrawerOpened,
            selectScheduleClickAttempts,
            snapshot: getScheduleSnapshot('select-schedule-clicked', { clicked }),
          });
          if (clicked) schedulePostSelectOptionsCheck();
          return;
        }
        if (scheduleDrawerOpened && selectScheduleButtons.length > 0) {
          log.debug('select schedule click skipped: drawer already opened', {
            selectScheduleClickAttempts,
          });
        }

        const desktopApplyButtons = dom.getClickableElements(SELECTORS.DESKTOP_APPLY_BUTTON);
        const desktopApplyButton = chooseClickable(desktopApplyButtons);
        log.trace('attemptAutoApply scan: desktop apply', {
          buttonCount: desktopApplyButtons.length,
          selected: !!desktopApplyButton,
        }, {
          throttleKey: 'desktop-apply-scan',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });
        if (desktopApplyButton) {
          if (applyClickInFlight('desktop-apply')) {
            finished = true;
            cleanup();
            return;
          }
          clearPostSelectOptionsTimer();
          clearPostLabelApplyTimer();
          const button = desktopApplyButton;
          const scheduleDetails = getScheduleCardDetails(button);
          storage.setLocal({ [STORAGE_KEYS.LAST_SELECTED_SCHEDULE]: scheduleDetails });
          root.AMZ_APPLICATION_OBSERVABILITY?.recordScheduleClick?.(scheduleDetails, 'desktop-apply');
          finished = dom.clickElement(button, 'desktop apply');
          rememberApplyClick('desktop-apply', finished);
          log.info('desktop apply clicked', {
            clicked: finished,
            ...getScheduleClickSummary(button, 'desktop-apply'),
          });
          log.debug('desktop apply click detail', { finished, button: getScheduleCardDetails(button) });
          if (finished) cleanup();
        }
      };

      const queueAttempt = () => {
        if (!active() || finished || attemptQueued) {
          log.trace('queueAttempt skipped', { active: active(), finished, attemptQueued }, {
            throttleKey: 'queue-attempt-skip',
            throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
          });
          return;
        }
        attemptQueued = true;
        const attemptId = ++queuedAttemptSequence;
        activeQueuedAttemptId = attemptId;
        log.trace('queueAttempt scheduled', undefined, {
          throttleKey: 'queue-attempt-scheduled',
          throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
        });

        const runQueuedAttempt = source => {
          if (attemptId !== activeQueuedAttemptId) {
            log.trace('queued attempt skipped: stale callback', { source }, {
              throttleKey: 'queued-attempt-stale',
              throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
            });
            return;
          }

          activeQueuedAttemptId = 0;
          if (queuedAttemptTimer) clearTimeout(queuedAttemptTimer);
          queuedAttemptTimer = null;
          attemptQueued = false;
          log.trace('queued attempt running', { source }, {
            throttleKey: 'queued-attempt-running',
            throttleMs: root.AMZ_CONSTANTS.LOGGING.HIGH_FREQUENCY_THROTTLE_MS,
          });
          attemptAutoApply();
        };

        queuedAttemptTimer = setTimeout(() => {
          runQueuedAttempt('timeout-fallback');
        }, SCHEDULE_AUTOMATION.ATTEMPT_QUEUE_FALLBACK_MS);

        const scheduleFrame = typeof root.requestAnimationFrame === 'function'
          ? root.requestAnimationFrame.bind(root)
          : callback => setTimeout(callback, 0);
        scheduleFrame(() => runQueuedAttempt('animation-frame'));
      };

      observer = new MutationObserver(queueAttempt);
      observer.observe(document.body, { childList: true, subtree: true });
      retryTimer = setInterval(queueAttempt, SCHEDULE_AUTOMATION.RETRY_INTERVAL_MS);

      fallbackTimer = setTimeout(() => {
        if (!active() || finished) {
          log.debug('fallback skipped', { active: active(), finished });
          return;
        }
        const expandLink = document.querySelector(SELECTORS.SCHEDULE_EXPAND_LINK);
        log.debug('fallback scan', { expandLinkFound: !!expandLink });
        if (expandLink && dom.clickElement(expandLink, 'expand schedule')) {
          log.debug('fallback expand clicked');
          setTimeout(selectScheduleCard, SCHEDULE_AUTOMATION.EXPAND_TO_LABEL_DELAY_MS);
        }
      }, SCHEDULE_AUTOMATION.FALLBACK_DELAY_MS);

      hardStopTimer = setTimeout(() => {
        log.debug('hard stop timer fired');
        if (!finished && active()) reportNoApplyPath('hard-stop', getScheduleSnapshot('hard-stop'));
        cleanup();
      }, SCHEDULE_AUTOMATION.HARD_STOP_DELAY_MS);
      queueAttempt();
    }

    function stop() {
      log.debug('stop called');
      cleanupCurrent?.();
    }

    return Object.freeze({
      start,
      stop,
    });
  }

  root.AMZ_SCHEDULE_AUTOMATION = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : self);
