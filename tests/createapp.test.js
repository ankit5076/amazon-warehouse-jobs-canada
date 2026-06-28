import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function tick() {
    return Promise.resolve();
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

    const buttonLabels = options.buttons || ["Create Application"];
    const body = options.body || buttonLabels
        .map(label => `<button>${label}</button>`)
        .join("");
    const dom = new JSDOM(
        `<!doctype html><html><body>${body}</body></html>`,
        {
            url: options.url || "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1",
        }
    );

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.chrome.runtime.onMessage = { addListener: vi.fn() };

    const { DIRECT_APPLICATION, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
    const storageValues = {
        [STORAGE_KEYS.ACTIVE]: true,
    };
    if (typeof options.storedUseDirectApplication === "boolean") {
        storageValues[STORAGE_KEYS.USE_DIRECT_APPLICATION] = options.storedUseDirectApplication;
    }
    const guardKey = [
        DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
        "JOB-1",
        "SCH-1",
    ].join("::");

    if (guard !== null && guard !== undefined) {
        dom.window.sessionStorage.setItem(guardKey, JSON.stringify(guard));
    }

    const clickElement = vi.fn(() => true);
    globalThis.AMZ_DOM = {
        isClickable: () => true,
        describeButton: button => button && { text: button.textContent },
        clickElement,
        findButtonByText: text => {
            const target = String(text || "").trim().toLowerCase();
            return [...dom.window.document.querySelectorAll("button")].find(button => {
                const candidate = button.textContent.trim().toLowerCase();
                return candidate === target || candidate.includes(target);
            }) || null;
        },
    };
    globalThis.AMZ_LOGGER = { create: createTestLogger };
    globalThis.AMZ_URL = {
        isApplicationFormPage: () => options.applicationFormPage === true,
        isFinalApplicationFormPage: () => options.finalApplicationFormPage === true,
        getJobIdFromUrl: () => "JOB-1",
        getApplicationContextFromUrl: () => ({
            applicationId: options.applicationId || null,
            jobId: "JOB-1",
            scheduleId: options.scheduleId === undefined ? "SCH-1" : options.scheduleId,
        }),
    };
    globalThis.AMZ_STORAGE = {
        getLocal: vi.fn(async keys => {
            if (Array.isArray(keys)) {
                return keys.reduce((result, key) => {
                    if (Object.prototype.hasOwnProperty.call(storageValues, key)) {
                        result[key] = storageValues[key];
                    }
                    return result;
                }, {});
            }
            return Object.prototype.hasOwnProperty.call(storageValues, keys)
                ? { [keys]: storageValues[keys] }
                : {};
        }),
        setLocal: vi.fn(async values => {
            Object.assign(storageValues, values);
        }),
        removeLocal: vi.fn(async keys => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storageValues[key];
        }),
    };
    globalThis.AMZ_NOTIFICATIONS = {
        emit: vi.fn(() => Promise.resolve({ ok: true, queued: true })),
    };

    const button = dom.window.document.querySelector("button");
    const nativeClick = vi.spyOn(button, "click");

    return { clickElement, nativeClick, storageValues };
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
        globalThis.__amazonCreateAppAutomation?.cleanup?.();
        globalThis.window?.close?.();
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

    it("clicks Start application as a native create button in manual mode", async () => {
        const { clickElement } = setupCreateAppHarness(null, {
            useDirectApplication: false,
            buttons: ["Start application"],
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).toHaveBeenCalledOnce();
        expect(clickElement.mock.calls[0][1]).toBe("create application");
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

    it("does not schedule an automatic My Applications redirect after native UI click", async () => {
        vi.useFakeTimers();
        try {
            setupCreateAppHarness(null, {
                useDirectApplication: true,
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

    it("uses the fast manual post-action rescan instead of the legacy two second fallback", async () => {
        vi.useFakeTimers();
        try {
            setupCreateAppHarness(null, {
                useDirectApplication: false,
            });
            const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
            const { POST_ACTION_RESCAN_MS, POST_NEXT_RESCAN_MS } = globalThis.AMZ_CONSTANTS.CREATE_APPLICATION;

            loadCreateAppScripts();
            await Promise.resolve();
            await Promise.resolve();

            expect(globalThis.AMZ_DOM.clickElement).toHaveBeenCalledOnce();
            expect(timeoutSpy.mock.calls.some(call => call[1] === POST_ACTION_RESCAN_MS)).toBe(true);
            expect(timeoutSpy.mock.calls.some(call => call[1] === POST_NEXT_RESCAN_MS)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("continues manual automation from Create Application to Select this job", async () => {
        vi.useFakeTimers();
        try {
            const { clickElement } = setupCreateAppHarness(null, {
                useDirectApplication: false,
                buttons: ["Create Application"],
            });

            loadCreateAppScripts();
            await Promise.resolve();
            await Promise.resolve();

            expect(clickElement).toHaveBeenCalledTimes(1);
            expect(clickElement.mock.calls[0][1]).toBe("create application");

            globalThis.window.history.pushState(
                {},
                "",
                "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1#/job-opportunities?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1"
            );
            globalThis.document.body.innerHTML = "<button>Select this job</button>";
            vi.advanceTimersByTime(globalThis.AMZ_CONSTANTS.CREATE_APPLICATION.POST_ACTION_RESCAN_MS);
            await Promise.resolve();
            await Promise.resolve();

            expect(clickElement).toHaveBeenCalledTimes(2);
            expect(clickElement.mock.calls[1][1]).toBe("select this job");

            globalThis.window.history.pushState(
                {},
                "",
                "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1#/job-opportunities/job-confirmation?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1"
            );
            globalThis.document.body.innerHTML = "<button>Select this job</button>";
            vi.advanceTimersByTime(globalThis.AMZ_CONSTANTS.CREATE_APPLICATION.POST_ACTION_RESCAN_MS);
            await Promise.resolve();
            await Promise.resolve();

            expect(clickElement).toHaveBeenCalledTimes(3);
            expect(clickElement.mock.calls[2][1]).toBe("select this job");
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops manual UI automation once the final application form opens", async () => {
        const { clickElement } = setupCreateAppHarness(null, {
            useDirectApplication: false,
            finalApplicationFormPage: true,
            buttons: ["Next"],
            url: "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1#/general-questions?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1",
        });

        loadCreateAppScripts();
        await tick();
        await tick();

        expect(clickElement).not.toHaveBeenCalled();
    });
});
