import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_STORAGE",
        "AMZ_LICENSE_API",
        "AMZ_LICENSE_STATE",
        "AMZ_PAYMENT_GATE",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/storage.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
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

function mockFetchJson(body, options = {}) {
    globalThis.fetch = vi.fn(() =>
        Promise.resolve({
            ok: options.ok !== false,
            status: options.status || 200,
            json: () => Promise.resolve(body),
        })
    );
}

beforeEach(() => {
    vi.useRealTimers();
    reload();
});

describe("license API", () => {
    it("normalizes the shared backend response shape", () => {
        const normalized = globalThis.AMZ_LICENSE_API.normalizeLicenseResponse({
            allowed: true,
            isProUser: false,
            accessExpiresAt: "2026-02-01T00:00:00.000Z",
            checkoutUrl: " https://checkout.example ",
            message: "ok",
            syncIntervalMs: "60000",
        });

        expect(normalized).toEqual({
            allowed: true,
            isProUser: false,
            accessExpiresAt: "2026-02-01T00:00:00.000Z",
            checkoutUrl: "https://checkout.example",
            message: "ok",
            syncIntervalMs: 60000,
        });
    });

    it("checks a country-specific license endpoint with normalized Amazon email", async () => {
        mockFetchJson({ allowed: true, isProUser: false, accessExpiresAt: "2026-02-01T00:00:00.000Z" });

        const response = await globalThis.AMZ_LICENSE_API.checkLicense({ amazonEmailId: " Paid@Example.COM " });

        expect(response.allowed).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://getslotnow.com/extension-usage-tracker/api/amazon-warehouse-jobs-canada/license/check?amazonEmail=paid%40example.com",
            expect.objectContaining({ method: "GET" })
        );
    });

    it("starts hosted checkout through the backend", async () => {
        mockFetchJson({ checkoutUrl: "https://checkout.dodo/session", allowed: false });

        const response = await globalThis.AMZ_LICENSE_API.createCheckout({ purchaseType: "pro" });

        expect(response.checkoutUrl).toBe("https://checkout.dodo/session");
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://getslotnow.com/extension-usage-tracker/api/amazon-warehouse-jobs-canada/license/checkout",
            expect.objectContaining({
                method: "POST",
                body: expect.stringContaining('"purchaseType":"pro"'),
            })
        );
    });
});

describe("license state", () => {
    it("caches valid paid license state until expiry", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.LICENSE_BUYER_EMAIL]: "buyer@example.com",
            [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: "paid@example.com",
        });
        mockFetchJson({ allowed: true, isProUser: true, syncIntervalMs: 60000 });

        const state = await globalThis.AMZ_LICENSE_STATE.refresh("paid@example.com");

        expect(state.allowed).toBe(true);
        expect(store[STORAGE_KEYS.LICENSE_STATE].isProUser).toBe(true);
        expect(await globalThis.AMZ_LICENSE_STATE.isAllowed()).toBe(true);
    });

    it("treats expired cached licenses as denied", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({
            [STORAGE_KEYS.LICENSE_EMAIL]: "paid@example.com",
            [STORAGE_KEYS.LICENSE_STATE]: {
                allowed: true,
                isProUser: true,
                emailId: "buyer@example.com",
                amazonEmailId: "paid@example.com",
                email: "paid@example.com",
                expiresAt: Date.now() - 1,
            },
        });
        globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));

        expect(await globalThis.AMZ_LICENSE_STATE.isAllowed()).toBe(false);
    });

    it("denies booking on inactive paid-access responses without disabling free job search", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: "empty@example.com",
            [STORAGE_KEYS.ACTIVE]: true,
        });
        mockFetchJson({ allowed: false, isProUser: false, message: "No active paid access" });

        const state = await globalThis.AMZ_LICENSE_STATE.refresh("empty@example.com");

        expect(globalThis.AMZ_LICENSE_STATE.isAllowedState(state)).toBe(false);
        expect(store[STORAGE_KEYS.ACTIVE]).toBe(true);
    });
});

describe("payment gate usage", () => {
    it("allows pro users without recording usage through the backend", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({
            [STORAGE_KEYS.LICENSE_BUYER_EMAIL]: "buyer@example.com",
            [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: "pro@example.com",
            [STORAGE_KEYS.LICENSE_STATE]: {
                allowed: true,
                isProUser: true,
                emailId: "buyer@example.com",
                amazonEmailId: "pro@example.com",
                email: "pro@example.com",
                expiresAt: Date.now() + 60000,
            },
        });
        globalThis.fetch = vi.fn();

        const result = await globalThis.AMZ_PAYMENT_GATE.recordUsageForBookingAttempt({ jobId: "JOB1" });

        expect(result.ok).toBe(true);
        expect(result.skipped).toBe("pro-user");
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not call usage for active unlimited paid access", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.LICENSE_BUYER_EMAIL]: "buyer@example.com",
            [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: "access@example.com",
            [STORAGE_KEYS.LICENSE_STATE]: {
                allowed: true,
                isProUser: true,
                emailId: "buyer@example.com",
                amazonEmailId: "access@example.com",
                email: "access@example.com",
                expiresAt: Date.now() + 60000,
            },
        });
        globalThis.fetch = vi.fn();

        const first = await globalThis.AMZ_PAYMENT_GATE.recordUsageForBookingAttempt({ jobId: "JOB1" });
        const second = await globalThis.AMZ_PAYMENT_GATE.recordUsageForBookingAttempt({ jobId: "JOB1" });

        expect(first.ok).toBe(true);
        expect(second.skipped).toBe("already-recorded");
        expect(first.skipped).toBe("pro-user");
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(Object.keys(store[STORAGE_KEYS.LICENSE_USAGE_KEYS])).toEqual(["amazon-warehouse-jobs-canada:access@example.com:JOB1:unknown-schedule"]);
    });
});
