import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function flush() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function installStorageStores() {
    const localStore = {};
    const sessionStore = {};
    const installArea = store => ({
        get: vi.fn((keys, cb) => {
            let result = {};
            if (Array.isArray(keys)) {
                keys.forEach(key => {
                    if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
                });
            } else if (typeof keys === "string") {
                if (Object.prototype.hasOwnProperty.call(store, keys)) result[keys] = store[keys];
            } else {
                result = { ...store };
            }
            if (typeof cb === "function") cb(result);
            return Promise.resolve(result);
        }),
        set: vi.fn((values, cb) => {
            Object.assign(store, values);
            if (typeof cb === "function") cb();
            return Promise.resolve();
        }),
        remove: vi.fn((keys, cb) => {
            (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]);
            if (typeof cb === "function") cb();
            return Promise.resolve();
        }),
    });
    globalThis.chrome.storage.local = installArea(localStore);
    globalThis.chrome.storage.session = installArea(sessionStore);
    return { localStore, sessionStore };
}

function reload() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_STORAGE",
        "AMZ_MESSAGING",
        "AMZ_APPLICATION_OBSERVABILITY",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/storage.js",
        "shared/utils/messaging.js",
        "content/utils/application-observability.js",
    ]);
}

beforeEach(() => {
    reload();
    globalThis.chrome.runtime.getManifest = () => ({ version: "2.30.0" });
});

describe("AMZ_APPLICATION_OBSERVABILITY", () => {
    it("persists a compact local trace only after a matched job", async () => {
        const { localStore, sessionStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        localStore[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] = "client@example.com";

        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: {
                jobId: "JOB-1",
                jobTitle: "Warehouse Associate",
                city: "Toronto",
                locationName: "YYZ",
                scheduleCount: 2,
            },
            searchResult: {
                status: 200,
                durationMs: 120,
                jobCards: [{ jobId: "JOB-1" }],
            },
            searchContext: {
                selectedCity: "Toronto",
                jobTypes: ["PART_TIME"],
            },
        });

        await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);
        const result = await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistApplicationAttemptLocally(
            trace,
            { jobId: "JOB-1" }
        );

        expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE].trace.jobId).toBe("JOB-1");
        expect(result).toEqual(expect.objectContaining({ ok: true, localOnly: true }));
        expect(result.payload).toEqual(expect.objectContaining({
            outcome: "JOB_MATCHED",
            extension_version: "2.30.0",
            client_email: "client@example.com",
            job_id: "JOB-1",
            is_terminal: false,
        }));
    });

    it("clears local pending trace on terminal outcomes without a backend API", async () => {
        const { sessionStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: { jobId: "JOB-2", city: "Vancouver" },
            searchResult: { status: 200, durationMs: 80, jobCards: [{ jobId: "JOB-2" }] },
        });
        await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeAndFlush(
            trace,
            "BOOKED",
            {},
            { jobId: "JOB-2" }
        );
        await flush();
        await flush();

        expect(trace.postedOutcomes).toContain("BOOKED");
        expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
    });

    it("falls back to local storage when content scripts cannot access session storage", async () => {
        const { localStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        globalThis.chrome.storage.session.get = vi.fn(() => Promise.reject(new Error("session unavailable")));
        globalThis.chrome.storage.session.set = vi.fn(() => Promise.reject(new Error("session unavailable")));
        globalThis.chrome.storage.session.remove = vi.fn(() => Promise.reject(new Error("session unavailable")));
        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: { jobId: "JOB-3", city: "Whitby" },
            searchResult: { status: 200, durationMs: 60, jobCards: [{ jobId: "JOB-3" }] },
        });

        await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);
        expect(localStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE].trace.jobId).toBe("JOB-3");

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeAndFlush(trace, "APPLICATION_CREATED_WITHOUT_SCHEDULE", {
            detailedOutcome: "APPLICATION_CREATED_WITHOUT_SCHEDULE",
            errorCode: "SELECTED_SCHEDULE_NOT_AVAILABLE",
        }, { jobId: "JOB-3" });
        await flush();
        await flush();

        expect(trace.postedOutcomes).toContain("APPLICATION_CREATED_WITHOUT_SCHEDULE");
        expect(localStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
    });

    it("returns sorted categorized timeline data from local persistence", async () => {
        installStorageStores();
        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: { jobId: "JOB-4", city: "Toronto" },
            searchResult: { status: 200, durationMs: 50, jobCards: [{ jobId: "JOB-4" }] },
        });
        const base = trace.startEpochMs;

        globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationEventAt(
            trace,
            "confirm_job_request_end",
            { operation: "job-confirm" },
            null,
            { epochMs: base + 400, perfMs: trace.startMs + 400 }
        );
        globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationEventAt(
            trace,
            "attempt_lock_acquired",
            {},
            null,
            { epochMs: base + 175, perfMs: trace.startMs + 175 }
        );
        globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationEventAt(
            trace,
            "captcha_required",
            {},
            null,
            { epochMs: base + 300, perfMs: trace.startMs + 300 }
        );

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeApplicationTrace(trace, "BOOKED", {});
        const result = await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistApplicationAttemptLocally(
            trace,
            { jobId: "JOB-4" },
            { force: true }
        );
        const timeline = result.payload.event_timeline;
        const names = timeline.map(event => event.name);

        expect(names.indexOf("attempt_lock_acquired")).toBeLessThan(names.indexOf("captcha_required"));
        expect(names.indexOf("captcha_required")).toBeLessThan(names.indexOf("confirm_job_request_end"));
        expect(timeline.find(event => event.name === "attempt_lock_acquired").category).toBe("extension_js");
        expect(timeline.find(event => event.name === "captcha_required").category).toBe("waf_captcha");
        expect(timeline.find(event => event.name === "confirm_job_request_end").category).toBe("amazon_api");
        expect(timeline.find(event => event.name === "captcha_required").since_previous_ms).toBe(125);
    });
});
