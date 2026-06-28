import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_STORAGE",
        "AMZ_ACCOUNT",
        "AMZ_LICENSE_API",
        "AMZ_LICENSE_STATE",
        "AMZ_VALIDATION",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/storage.js",
        "shared/utils/account.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/validation.js",
    ]);
}

function useLocalStore(initial = {}) {
    const store = { ...initial };
    globalThis.chrome.storage.local.get = vi.fn((keys, cb) => {
        let result = {};
        if (Array.isArray(keys)) {
            keys.forEach(key => {
                if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
            });
        } else if (typeof keys === "string") {
            if (Object.prototype.hasOwnProperty.call(store, keys)) result[keys] = store[keys];
        } else if (keys && typeof keys === "object") {
            Object.keys(keys).forEach(key => {
                result[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : keys[key];
            });
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

function mockFetchLicense(body, options = {}) {
    globalThis.fetch = vi.fn(() =>
        Promise.resolve({
            ok: options.ok !== false,
            status: options.status || 200,
            json: () => Promise.resolve(body),
        })
    );
}

beforeEach(() => {
    reload();
});

describe("AMZ_VALIDATION paid-license adapter", () => {
    it("exposes the documented runtime surface and starts fail-closed", () => {
        expect(typeof globalThis.AMZ_VALIDATION.isAllowed).toBe("function");
        expect(typeof globalThis.AMZ_VALIDATION.check).toBe("function");
        expect(typeof globalThis.AMZ_VALIDATION.refreshFromServer).toBe("function");
        expect(globalThis.AMZ_VALIDATION.check()).toEqual({ ok: false });
    });

    it("allows a fresh paid-access license", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.LICENSE_EMAIL]: "paid@example.com" });
        mockFetchLicense({ allowed: true, isProUser: false, syncIntervalMs: 60000 });

        const policy = await globalThis.AMZ_VALIDATION.refreshFromServer("paid@example.com");

        expect(policy.valid).toBe(true);
        expect(policy.username).toBe("paid@example.com");
        expect(globalThis.AMZ_VALIDATION.isAllowed()).toBe(true);
        expect(globalThis.AMZ_VALIDATION.isAllowedForUsername("paid@example.com")).toBe(true);
    });

    it("disables activation when the backend denies paid access", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.LICENSE_EMAIL]: "empty@example.com",
            [STORAGE_KEYS.ACTIVE]: true,
        });
        mockFetchLicense({ allowed: false, isProUser: false, message: "No active paid access" });

        const policy = await globalThis.AMZ_VALIDATION.refreshFromServer("empty@example.com");

        expect(policy.valid).toBe(false);
        expect(store[STORAGE_KEYS.ACTIVE]).toBe(false);
        expect(globalThis.AMZ_VALIDATION.isAllowed()).toBe(false);
    });

    it("keeps automation fail-closed when no license email exists", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({ [STORAGE_KEYS.ACTIVE]: true });

        const policy = await globalThis.AMZ_VALIDATION.refreshFromServer();

        expect(policy.valid).toBe(false);
        expect(store[STORAGE_KEYS.ACTIVE]).toBe(false);
    });
});
