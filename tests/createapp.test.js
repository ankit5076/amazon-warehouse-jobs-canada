import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function tick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

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

function setupCreateAppHarness(guard, options = {}) {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_GUARD", "AMZ_DIRECT_APPLICATION_MODE", "__amazonCreateAppAutomation"]);
    loadSharedScripts(["shared/constants.js"]);
    if (typeof options.useDirectApplication === "boolean") {
        const constants = globalThis.AMZ_CONSTANTS;
        globalThis.AMZ_CONSTANTS = Object.freeze({
            ...constants,
            DIRECT_APPLICATION: Object.freeze({
                ...constants.DIRECT_APPLICATION,
                useDirectApplication: options.useDirectApplication,
            }),
        });
    }

    const dom = new JSDOM(
        '<!doctype html><html><body><button>Create Application</button></body></html>',
        {
            url: options.url || "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1",
        }
    );

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.chrome.runtime.onMessage = { addListener: vi.fn() };

    const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
    const guardKey = [
        DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
        "JOB-1",
        "SCH-1",
    ].join("::");

    dom.window.sessionStorage.setItem(guardKey, JSON.stringify(guard));

    const clickElement = vi.fn(() => true);
    globalThis.AMZ_DOM = {
        isClickable: () => true,
        describeButton: button => button && { text: button.textContent },
        clickElement,
        findButtonByText: text =>
            [...dom.window.document.querySelectorAll("button")].find(
                button => button.textContent.trim() === text
            ) || null,
    };
    globalThis.AMZ_LOGGER = { create: createTestLogger };
    globalThis.AMZ_URL = {
        isApplicationFormPage: () => options.applicationFormPage === true,
        getJobIdFromUrl: () => "JOB-1",
        getApplicationContextFromUrl: () => ({
            applicationId: options.applicationId || null,
            jobId: "JOB-1",
            scheduleId: options.scheduleId === undefined ? "SCH-1" : options.scheduleId,
        }),
    };
    globalThis.AMZ_STORAGE = {
        getLocal: vi.fn(async keys => {
            const values = {
                [STORAGE_KEYS.ACTIVE]: true,
            };
            if (typeof options.storedUseDirectApplication === "boolean") {
                values[STORAGE_KEYS.USE_DIRECT_APPLICATION] = options.storedUseDirectApplication;
            }
            if (Array.isArray(keys)) {
                return keys.reduce((result, key) => {
                    if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
                    return result;
                }, {});
            }
            return Object.prototype.hasOwnProperty.call(values, keys) ? { [keys]: values[keys] } : {};
        }),
    };
    globalThis.AMZ_NOTIFICATIONS = {
        emit: vi.fn(() => Promise.resolve({ ok: true, queued: true })),
    };

    const button = dom.window.document.querySelector("button");
    const nativeClick = vi.spyOn(button, "click");

    return { clickElement, button, nativeClick };
}

function loadCreateAppScripts() {
    loadSharedScripts([
        "content/utils/direct-application-guard.js",
        "content/utils/direct-application-mode.js",
        "content/createapp.js",
    ]);
}

describe("Create Application automation", () => {
    beforeEach(() => {
        vi.useRealTimers();
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_GUARD", "AMZ_DIRECT_APPLICATION_MODE", "__amazonCreateAppAutomation"]);
    });

    afterEach(() => {
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.MutationObserver;
        delete globalThis.AMZ_DOM;
        delete globalThis.AMZ_LOGGER;
        delete globalThis.AMZ_URL;
        delete globalThis.AMZ_STORAGE;
        delete globalThis.AMZ_NOTIFICATIONS;
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_GUARD", "AMZ_DIRECT_APPLICATION_MODE", "__amazonCreateAppAutomation"]);
    });

    it("does not click Create Application after direct create produced an application id", async () => {
        const { clickElement } = setupCreateAppHarness({
            stage: "failed",
            applicationId: "app-1",
            fallbackAllowed: false,
        }, {
            useDirectApplication: true,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).not.toHaveBeenCalled();
    });

    it("does not click Create Application when direct booking explicitly disallows fallback", async () => {
        const { clickElement } = setupCreateAppHarness({
            stage: "failed",
            fallbackAllowed: false,
        }, {
            useDirectApplication: true,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).not.toHaveBeenCalled();
    });

    it("suppresses Create Application scans on resume URLs without a schedule id", async () => {
        const { clickElement } = setupCreateAppHarness({
            stage: "failed",
            applicationId: "app-1",
            fallbackAllowed: false,
        }, {
            applicationId: "app-1",
            scheduleId: null,
            url: "https://hiring.amazon.ca/application/ca/?applicationId=app-1&jobId=JOB-1",
            useDirectApplication: true,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).not.toHaveBeenCalled();
    });

    it("keeps the 6d1a472 native Create Application behavior on country-scoped form routes", async () => {
        const { clickElement } = setupCreateAppHarness(null, {
            applicationFormPage: true,
            applicationId: "app-1",
            scheduleId: "SCH-1",
            url: "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&scheduleId=SCH-1#/general-questions?applicationId=app-1",
            useDirectApplication: true,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).toHaveBeenCalledOnce();
    });

    it("clicks Create Application when direct application is disabled", async () => {
        const { clickElement } = setupCreateAppHarness({
            stage: "application-created-waiting-for-confirm",
            applicationId: "app-1",
            fallbackAllowed: false,
        }, {
            useDirectApplication: false,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).toHaveBeenCalledOnce();
    });

    it("uses the stored manual mode without requiring a page refresh", async () => {
        const { clickElement } = setupCreateAppHarness({
            stage: "application-created-waiting-for-confirm",
            applicationId: "app-1",
            fallbackAllowed: false,
        }, {
            useDirectApplication: true,
            storedUseDirectApplication: false,
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).toHaveBeenCalledOnce();
    });

    it("does not schedule an automatic redirect after native UI click when direct application is disabled", async () => {
        vi.useFakeTimers();
        try {
            setupCreateAppHarness(null, {
                useDirectApplication: false,
            });
            const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

            loadCreateAppScripts();
            await Promise.resolve();
            await Promise.resolve();

            expect(globalThis.AMZ_DOM.clickElement).toHaveBeenCalledOnce();
            expect(timeoutSpy.mock.calls.some(call => String(call[0]).includes("window.location"))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("schedules a My Applications redirect after UI click only when direct application is enabled", async () => {
        vi.useFakeTimers();
        try {
            setupCreateAppHarness(null, {
                useDirectApplication: true,
            });
            const redirectDelayMs = globalThis.AMZ_CONSTANTS.CREATE_APPLICATION.REDIRECT_DELAY_MS;
            const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

            loadCreateAppScripts();
            await Promise.resolve();
            await Promise.resolve();

            expect(globalThis.AMZ_DOM.clickElement).toHaveBeenCalledOnce();
            expect(timeoutSpy.mock.calls.filter(call => call[1] === redirectDelayMs)).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("clicks manual Create Application without notification or delayed duplicate native click", async () => {
        vi.useFakeTimers();
        try {
            const { nativeClick } = setupCreateAppHarness(null, {
                useDirectApplication: false,
            });

            loadCreateAppScripts();
            await Promise.resolve();
            await Promise.resolve();

            expect(globalThis.AMZ_DOM.clickElement).toHaveBeenCalledOnce();

            vi.advanceTimersByTime(globalThis.AMZ_CONSTANTS.CREATE_APPLICATION.NATIVE_CLICK_DELAY_MS);

            expect(globalThis.AMZ_NOTIFICATIONS.emit).not.toHaveBeenCalled();
            expect(nativeClick).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
