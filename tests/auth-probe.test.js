import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function ensureChromeStub() {
    if (globalThis.chrome) return;
    globalThis.chrome = {
        runtime: {
            lastError: null,
            sendMessage: () => {},
            getManifest: () => ({ version: "1.0.0" }),
        },
        tabs: {
            query: (_q, cb) => cb && cb([]),
            sendMessage: () => {},
        },
        storage: {
            onChanged: {
                addListener: () => {},
            },
            local: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve(),
                remove: () => Promise.resolve(),
                clear: () => Promise.resolve(),
            },
            session: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve(),
                remove: () => Promise.resolve(),
            },
        },
    };
}

function useLocalStore(initial = {}) {
    ensureChromeStub();
    const store = { ...initial };
    globalThis.chrome.storage.local.get = vi.fn((keys, cb) => {
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
    });
    globalThis.chrome.storage.local.set = vi.fn((values, cb) => {
        Object.assign(store, values);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    return store;
}

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn().mockResolvedValue(payload),
    };
}

function reloadAuthProbe(url) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
    globalThis.window = dom.window;
    globalThis.localStorage = dom.window.localStorage;
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_TEXT",
        "AMZ_STORAGE",
        "AMZ_CITY_TAGS",
        "AMZ_RUNTIME_CONTROLS",
        "AMZ_STATE",
        "AMZ_LOGGER",
        "AMZ_URL",
        "AMZ_AUTH_PROBE",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/city-tags.js",
        "shared/utils/runtime-controls.js",
        "shared/utils/state-store.js",
        "shared/utils/logger.js",
        "shared/utils/url.js",
        "content/utils/auth-probe.js",
    ]);
}

describe("AMZ_AUTH_PROBE", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        useLocalStore();
    });

    afterEach(() => {
        delete globalThis.window;
        delete globalThis.localStorage;
        unloadSharedNamespaces([
            "AMZ_CONSTANTS",
            "AMZ_TEXT",
            "AMZ_STORAGE",
            "AMZ_CITY_TAGS",
            "AMZ_RUNTIME_CONTROLS",
            "AMZ_STATE",
            "AMZ_LOGGER",
            "AMZ_URL",
            "AMZ_AUTH_PROBE",
        ]);
    });

    it("does not consume a stale auth-return load as the job-search probe", async () => {
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;
        reloadAuthProbe("https://hiring.amazon.ca/app#/auth-return?access_token=fake");

        await globalThis.AMZ_AUTH_PROBE.ready;

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(globalThis.AMZ_AUTH_PROBE.getLastProbeSnapshot().startedAt).toBe(0);
    });

    it("can rerun the probe after Amazon routes from auth-return to job search", async () => {
        const store = useLocalStore({
            authProbeStatus: "not_authenticated",
        });
        const fetchSpy = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, { token: "csrf-token" }))
            .mockResolvedValueOnce(jsonResponse(200, { candidateId: "candidate-1" }));
        globalThis.fetch = fetchSpy;
        reloadAuthProbe("https://hiring.amazon.ca/app#/auth-return?access_token=fake");
        const { AUTH_PROBE, STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        window.localStorage.setItem("sessionToken", "session-token");
        window.localStorage.setItem("bbCandidateId", "candidate-1");

        await globalThis.AMZ_AUTH_PROBE.ready;
        window.history.pushState({}, "", "https://hiring.amazon.ca/app#/jobSearch");
        const status = await globalThis.AMZ_AUTH_PROBE.runRefreshTriggeredProbe();

        expect(status).toBe(AUTH_PROBE.STATUSES.AUTHENTICATED);
        expect(store[STORAGE_KEYS.AUTH_PROBE_STATUS]).toBe(AUTH_PROBE.STATUSES.AUTHENTICATED);
        expect(globalThis.AMZ_AUTH_PROBE.getLastProbeSnapshot().pageUrl)
            .toBe("https://hiring.amazon.ca/app#/jobSearch");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});
