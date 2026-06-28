import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function flush() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushMicrotasks(count = 8) {
    for (let i = 0; i < count; i += 1) {
        await Promise.resolve();
    }
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
        "AMZ_TIME",
        "AMZ_MESSAGING",
        "AMZ_API",
        "AMZ_APPLICATION_OBSERVABILITY",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/time.js",
        "shared/utils/storage.js",
        "shared/utils/messaging.js",
        "shared/api-client.js",
        "content/utils/application-observability.js",
    ]);
}

beforeEach(() => {
    reload();
    globalThis.chrome.runtime.getManifest = () => ({ version: "2.30.0" });
});

describe("AMZ_APPLICATION_OBSERVABILITY", () => {
    it("persists a compact trace only after a matched job and posts JOB_MATCHED progress", async () => {
        const { localStore, sessionStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        localStore[STORAGE_KEYS.OPERATOR_USERNAME] = "operator@example.com";
        localStore[STORAGE_KEYS.SELECTED_CLIENT_ID] = "9";
        localStore[STORAGE_KEYS.SELECTED_CLIENT_LABEL] = "Client One";
        localStore[STORAGE_KEYS.AMAZON_LOGIN_USERNAME] = "client@example.com";
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });

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
        globalThis.AMZ_APPLICATION_OBSERVABILITY.flushProgress(trace, "JOB_MATCHED", {}, { jobId: "JOB-1" });
        await flush();
        await flush();

        expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE].trace.jobId).toBe("JOB-1");
        expect(post).toHaveBeenCalled();
        expect(post.mock.calls[0][0]).toEqual(expect.objectContaining({
            started_at: expect.stringMatching(/\+05:30$/),
            outcome: "JOB_MATCHED",
            extension_version: "2.30.0",
            operator_username: "operator@example.com",
            client_id: "9",
            client_email: "client@example.com",
        }));
    });

    it("sends a terminal DEACTIVATED observability row even when automation is toggled off", async () => {
        const { sessionStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: { jobId: "JOB-2", city: "Vancouver" },
            searchResult: { status: 200, durationMs: 80, jobCards: [{ jobId: "JOB-2" }] },
        });
        await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizePendingDeactivated(
            { jobId: "JOB-2", href: "https://hiring.amazon.ca/jobs/JOB-2" },
            { source: "active-toggle" }
        );
        await flush();
        await flush();

        expect(post).toHaveBeenCalled();
        const terminalPayload = post.mock.calls.at(-1)[0];
        expect(terminalPayload.outcome).toBe("DEACTIVATED");
        expect(terminalPayload.is_terminal).toBe(true);
        expect(terminalPayload.event_timeline.some(event => event.name === "extension_deactivated")).toBe(true);
        expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
    });

    it("retains and retries terminal tracker posts when delivery fails", async () => {
        vi.useFakeTimers();
        try {
            const { sessionStore } = installStorageStores();
            const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
            const post = vi.fn()
                .mockResolvedValueOnce({ ok: false, status: 503, error: "offline" })
                .mockResolvedValueOnce({ ok: true, status: 201 });
            globalThis.AMZ_API = Object.freeze({
                ...globalThis.AMZ_API,
                apiPostApplicationAttempt: post,
            });
            const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
                matchedJob: { jobId: "JOB-RETRY", city: "Toronto" },
                searchResult: { status: 200, durationMs: 80, jobCards: [{ jobId: "JOB-RETRY" }] },
            });
            await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);

            globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeAndFlush(trace, "BOOKED", {}, { jobId: "JOB-RETRY" });
            await flushMicrotasks();

            expect(post).toHaveBeenCalledTimes(1);
            expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeTruthy();
            expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE].trace.outcome).toBe("BOOKED");

            await vi.advanceTimersByTimeAsync(1500);
            await flushMicrotasks();

            expect(post).toHaveBeenCalledTimes(2);
            expect(post.mock.calls[1][0]).toEqual(expect.objectContaining({
                outcome: "BOOKED",
                is_terminal: true,
                job_id: "JOB-RETRY",
            }));
            expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("falls back to local storage when content scripts cannot access session storage", async () => {
        const { localStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        globalThis.chrome.storage.session.get = vi.fn(() => Promise.reject(new Error("session unavailable")));
        globalThis.chrome.storage.session.set = vi.fn(() => Promise.reject(new Error("session unavailable")));
        globalThis.chrome.storage.session.remove = vi.fn(() => Promise.reject(new Error("session unavailable")));
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
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

        expect(post).toHaveBeenCalled();
        expect(post.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
            outcome: "APPLICATION_CREATED_WITHOUT_SCHEDULE",
            is_terminal: true,
            error_code: "SELECTED_SCHEDULE_NOT_AVAILABLE",
        }));
        expect(localStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
    });

    it("posts SCHEDULE_DISAPPEARED_AFTER_MATCH when matched job schedules vanish before application", async () => {
        const { sessionStore } = installStorageStores();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: {
                jobId: "JOB-GONE",
                city: "Whitby",
                jobType: "PART_TIME",
                scheduleCount: 1,
            },
            searchResult: { status: 200, durationMs: 90, jobCards: [{ jobId: "JOB-GONE" }] },
        });
        await globalThis.AMZ_APPLICATION_OBSERVABILITY.persistPendingTrace(trace);

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizePendingScheduleDisappearedAfterMatch(
            { jobId: "JOB-GONE", href: "https://hiring.amazon.ca/app#/jobDetail?jobId=JOB-GONE" },
            {
                reason: "schedule-options-missing-after-select",
                source: "schedule-graphql-recovery",
                status: 200,
                durationMs: 712,
                scheduleCount: 0,
                details: "Schedules received: 0",
            }
        );
        await flush();
        await flush();

        const payload = post.mock.calls.at(-1)[0];
        expect(payload).toEqual(expect.objectContaining({
            outcome: "SCHEDULE_DISAPPEARED_AFTER_MATCH",
            detailed_outcome: "SCHEDULE_DISAPPEARED_AFTER_MATCH",
            is_terminal: true,
            error_code: "NO_SCHEDULE_FOUND",
            error_classification: "schedule-disappeared-after-match",
            schedule_recovery_http_status: 200,
            schedule_recovery_fetch_ms: 712,
            fallback_schedule_count: 0,
        }));
        expect(payload.event_timeline.some(event => event.name === "schedule_disappeared_after_match")).toBe(true);
        expect(sessionStore[STORAGE_KEYS.APPLICATION_ATTEMPT_TRACE]).toBeUndefined();
    });

    it("posts APPLICATION_FORM_OPENED once when the Amazon form route opens", async () => {
        installStorageStores();
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
        const context = {
            href: "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-US-1&scheduleId=SCH-US-1#/general-questions?applicationId=app-1",
            origin: "https://hiring.amazon.com",
            country: "us",
            locale: "en-US",
            jobId: "JOB-US-1",
            scheduleId: "SCH-US-1",
            applicationId: "app-1",
        };

        await globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationFormOpened(context, {
            route: "general-questions",
            source: "application-form-route",
        });
        await globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationFormOpened(context, {
            route: "general-questions",
            source: "application-form-route",
        });
        await flush();
        await flush();

        expect(post).toHaveBeenCalledOnce();
        const payload = post.mock.calls[0][0];
        expect(payload).toEqual(expect.objectContaining({
            outcome: "APPLICATION_CREATED",
            observability_stage: "PROGRESS",
            is_terminal: false,
            detailed_outcome: "APPLICATION_FORM_OPENED",
            country: "United States",
            locale: "en-US",
            amazon_domain: "hiring.amazon.com",
            job_id: "JOB-US-1",
            schedule_id: "SCH-US-1",
            application_id: "app-1",
        }));
        expect(payload.event_timeline.some(event => event.name === "application_form_opened")).toBe(true);
    });

    it("can mark manual form-opened observability as terminal booked", async () => {
        installStorageStores();
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
        const context = {
            href: "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-CA-1&locale=en-CA&scheduleId=SCH-CA-1#/general-questions?applicationId=app-1&country=ca&jobId=JOB-CA-1&locale=en-CA&scheduleId=SCH-CA-1",
            origin: "https://hiring.amazon.ca",
            country: "ca",
            locale: "en-CA",
            jobId: "JOB-CA-1",
            scheduleId: "SCH-CA-1",
            applicationId: "app-1",
        };

        await globalThis.AMZ_APPLICATION_OBSERVABILITY.recordApplicationFormOpened(context, {
            route: "general-questions",
            source: "application-form-route",
            terminal: true,
            outcome: "BOOKED",
        });
        await flush();
        await flush();

        expect(post).toHaveBeenCalledOnce();
        const payload = post.mock.calls[0][0];
        expect(payload).toEqual(expect.objectContaining({
            outcome: "BOOKED",
            observability_stage: "TERMINAL",
            is_terminal: true,
            detailed_outcome: "APPLICATION_FORM_OPENED",
            country: "Canada",
            locale: "en-CA",
            amazon_domain: "hiring.amazon.ca",
            job_id: "JOB-CA-1",
            schedule_id: "SCH-CA-1",
            confirmed_schedule_id: "SCH-CA-1",
            application_id: "app-1",
        }));
        expect(payload.event_timeline.some(event => event.name === "attempt_terminal")).toBe(true);
    });

    it("starts terminal tracker posts before waiting on storage enrichment", async () => {
        installStorageStores();
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
        globalThis.chrome.storage.local.get = vi.fn(() => new Promise(() => {}));

        const trace = globalThis.AMZ_APPLICATION_OBSERVABILITY.createApplicationAttemptTrace({
            matchedJob: { jobId: "JOB-FAST", city: "Toronto" },
            searchResult: { status: 200, durationMs: 40, jobCards: [{ jobId: "JOB-FAST" }] },
        });

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeAndFlush(trace, "BOOKED", {}, { jobId: "JOB-FAST" });

        expect(post).toHaveBeenCalledOnce();
        expect(post.mock.calls[0][0]).toEqual(expect.objectContaining({
            outcome: "BOOKED",
            is_terminal: true,
            job_id: "JOB-FAST",
        }));
    });

    it("posts a sorted categorized timeline with captured async event timings", async () => {
        installStorageStores();
        const post = vi.fn(async () => ({ ok: true, status: 201 }));
        globalThis.AMZ_API = Object.freeze({
            ...globalThis.AMZ_API,
            apiPostApplicationAttempt: post,
        });
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

        globalThis.AMZ_APPLICATION_OBSERVABILITY.finalizeAndFlush(trace, "BOOKED", {}, { jobId: "JOB-4" });
        await flush();
        await flush();

        const timeline = post.mock.calls.at(-1)[0].event_timeline;
        const names = timeline.map(event => event.name);
        expect(names.indexOf("attempt_lock_acquired")).toBeLessThan(names.indexOf("captcha_required"));
        expect(names.indexOf("captcha_required")).toBeLessThan(names.indexOf("confirm_job_request_end"));
        expect(timeline.find(event => event.name === "attempt_lock_acquired").category).toBe("extension_js");
        expect(timeline.find(event => event.name === "captcha_required").category).toBe("waf_captcha");
        expect(timeline.find(event => event.name === "confirm_job_request_end").category).toBe("amazon_api");
        expect(timeline.find(event => event.name === "captcha_required").since_previous_ms).toBe(125);
    });
});
