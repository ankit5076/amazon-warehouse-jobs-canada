import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function createTestLogger() {
    const log = vi.fn();
    log.event = log;
    log.log = log;
    log.info = vi.fn();
    log.warn = vi.fn();
    log.error = vi.fn();
    log.debug = vi.fn();
    log.trace = vi.fn();
    return log;
}

function setupHarness({
    elementsBySelector = {},
    onNoApplyPath = vi.fn(),
    requestAnimationFrameImpl,
} = {}) {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_TEXT",
        "AMZ_SCHEDULE_AUTOMATION",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
    ]);

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "https://hiring.amazon.ca/app#/jobDetail?jobId=JOB-1&locale=en-CA",
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = requestAnimationFrameImpl || (callback => setTimeout(callback, 0));

    const clickElement = vi.fn(() => true);
    globalThis.AMZ_DOM = {
        getClickableElements: selector => {
            const value = elementsBySelector[selector];
            return typeof value === "function" ? value() : value || [];
        },
        clickElement,
    };
    globalThis.AMZ_STORAGE = {
        setLocal: vi.fn(() => Promise.resolve()),
    };
    globalThis.AMZ_URL = {
        currentUrl: () => window.location.href,
        getJobIdFromUrl: () => "JOB-1",
    };
    globalThis.AMZ_LOGGER = { create: createTestLogger };
    loadSharedScripts(["content/utils/schedule-automation.js"]);

    const automation = globalThis.AMZ_SCHEDULE_AUTOMATION.create({
        isActive: () => true,
        onNoApplyPath,
    });

    return {
        automation,
        clickElement,
        dom,
        onNoApplyPath,
    };
}

describe("schedule automation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.MutationObserver;
        delete globalThis.requestAnimationFrame;
        delete globalThis.AMZ_DOM;
        delete globalThis.AMZ_STORAGE;
        delete globalThis.AMZ_URL;
        delete globalThis.AMZ_LOGGER;
        unloadSharedNamespaces([
            "AMZ_CONSTANTS",
            "AMZ_TEXT",
            "AMZ_SCHEDULE_AUTOMATION",
        ]);
    });

    it("does not repeatedly click Select schedule after the drawer opens", () => {
        const selectScheduleSelector = 'button[data-test-id="jobDetailSelectScheduleButton"]';
        const button = { textContent: "Select schedule" };

        const harness = setupHarness({
            elementsBySelector: {
                [selectScheduleSelector]: [button],
            },
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.RETRY_INTERVAL_MS * 5);

        const selectScheduleClicks = harness.clickElement.mock.calls.filter(
            call => call[1] === "select schedule"
        );
        expect(selectScheduleClicks).toHaveLength(1);

        harness.automation.stop();
    });

    it("runs a queued attempt through the timeout fallback when animation frames stall", () => {
        const scheduleApplySelector = 'button[data-test-id="ScheduleCardSelectScheduleLink"]';
        const button = {
            textContent: "Apply",
            getAttribute: vi.fn(() => null),
            closest: vi.fn(() => ({ innerText: "Shift card" })),
        };
        const requestAnimationFrameImpl = vi.fn();
        const harness = setupHarness({
            elementsBySelector: {
                [scheduleApplySelector]: [button],
            },
            requestAnimationFrameImpl,
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        expect(requestAnimationFrameImpl).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.ATTEMPT_QUEUE_FALLBACK_MS);

        expect(harness.clickElement).toHaveBeenCalledWith(button, "schedule apply");
    });

    it("does not synthesize an application route after clicking Apply", () => {
        const scheduleApplySelector = 'button[data-test-id="ScheduleCardSelectScheduleLink"]';
        const button = {
            textContent: "Apply",
            getAttribute: vi.fn(() => null),
            closest: vi.fn(() => ({ innerText: "Shift card" })),
        };
        const harness = setupHarness({
            elementsBySelector: {
                [scheduleApplySelector]: [button],
            },
        });
        const initialUrl = globalThis.window.location.href;

        harness.automation.start();
        vi.advanceTimersByTime(0);
        vi.advanceTimersByTime(globalThis.AMZ_CONSTANTS.SCHEDULE_AUTOMATION.HARD_STOP_MS + 1000);

        expect(harness.clickElement).toHaveBeenCalledWith(button, "schedule apply");
        expect(globalThis.window.location.href).toBe(initialUrl);
    });

    it("ignores queued animation-frame callbacks after stop", () => {
        const scheduleApplySelector = 'button[data-test-id="ScheduleCardSelectScheduleLink"]';
        const button = {
            textContent: "Apply",
            getAttribute: vi.fn(() => null),
            closest: vi.fn(() => ({ innerText: "Shift card" })),
        };
        let frameCallback = null;
        const requestAnimationFrameImpl = vi.fn(callback => {
            frameCallback = callback;
        });
        const harness = setupHarness({
            elementsBySelector: {
                [scheduleApplySelector]: [button],
            },
            requestAnimationFrameImpl,
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        harness.automation.stop();
        frameCallback?.();
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.ATTEMPT_QUEUE_FALLBACK_MS);

        expect(harness.clickElement).not.toHaveBeenCalled();
    });

    it("reports the job as unavailable when no schedule options appear after Select schedule", () => {
        const selectScheduleSelector = 'button[data-test-id="jobDetailSelectScheduleButton"]';
        const onNoApplyPath = vi.fn();
        const harness = setupHarness({
            elementsBySelector: {
                [selectScheduleSelector]: [{ textContent: "Select schedule" }],
            },
            onNoApplyPath,
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        vi.advanceTimersByTime(1);
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS);

        expect(onNoApplyPath).toHaveBeenCalledWith(expect.objectContaining({
            reason: "schedule-options-missing-after-select",
            scheduleDrawerOpened: true,
            selectScheduleClickAttempts: 1,
            diagnostics: expect.objectContaining({
                stage: "post-select-schedule-options-grace-expired",
                counts: expect.objectContaining({
                    scheduleApplyButtons: 0,
                    scheduleLabels: 0,
                    desktopApplyButtons: 0,
                }),
            }),
        }));
    });

    it("waits when schedule options appear after Select schedule", () => {
        const selectScheduleSelector = 'button[data-test-id="jobDetailSelectScheduleButton"]';
        const scheduleApplySelector = 'button[data-test-id="ScheduleCardSelectScheduleLink"]';
        const onNoApplyPath = vi.fn();
        let applyVisible = false;
        const applyButton = {
            textContent: "Apply",
            getAttribute: vi.fn(() => null),
            closest: vi.fn(() => ({ innerText: "Shift card" })),
        };
        const harness = setupHarness({
            elementsBySelector: {
                [selectScheduleSelector]: [{ textContent: "Select schedule" }],
                [scheduleApplySelector]: () => (applyVisible ? [applyButton] : []),
            },
            onNoApplyPath,
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        vi.advanceTimersByTime(1);
        applyVisible = true;
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.POST_SELECT_SCHEDULE_OPTIONS_GRACE_MS);

        expect(onNoApplyPath).not.toHaveBeenCalled();
    });

    it("reports the job as unavailable when no apply button appears after schedule label selection", () => {
        const scheduleLabelSelector = ".scheduleCardLabelText";
        const onNoApplyPath = vi.fn();
        const harness = setupHarness({
            elementsBySelector: {
                [scheduleLabelSelector]: [{ textContent: "Mon, Tue 8:30 AM" }],
            },
            onNoApplyPath,
        });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        vi.advanceTimersByTime(1);
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.POST_SCHEDULE_LABEL_APPLY_GRACE_MS);

        expect(onNoApplyPath).toHaveBeenCalledWith(expect.objectContaining({
            reason: "apply-button-missing-after-schedule-label",
            scheduleLabelSelected: true,
            diagnostics: expect.objectContaining({
                stage: "post-schedule-label-apply-grace-expired",
            }),
        }));
    });

    it("reports the no-apply path when the hard stop fires", () => {
        const onNoApplyPath = vi.fn();
        const harness = setupHarness({ onNoApplyPath });
        const { SCHEDULE_AUTOMATION } = globalThis.AMZ_CONSTANTS;

        harness.automation.start();
        vi.advanceTimersByTime(SCHEDULE_AUTOMATION.HARD_STOP_DELAY_MS);

        expect(onNoApplyPath).toHaveBeenCalledWith(expect.objectContaining({
            reason: "hard-stop",
            jobId: "JOB-1",
            scheduleDrawerOpened: false,
        }));
    });
});
