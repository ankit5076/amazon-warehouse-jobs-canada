import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_STORAGE", "AMZ_INTERVALS"]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/storage.js",
        "shared/utils/intervals.js",
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
        } else {
            result = { ...store };
        }
        if (typeof cb === "function") cb(result);
        return Promise.resolve(result);
    });
}

beforeEach(() => {
    reload();
});

describe("AMZ_INTERVALS", () => {
    it("uses API-compatible unit defaults", () => {
        expect(globalThis.AMZ_INTERVALS.getDefaultUnit()).toBe("ms");
        expect(globalThis.AMZ_INTERVALS.getDefaultValue("ms")).toBe("850");
        expect(globalThis.AMZ_INTERVALS.getDefaultValue("s")).toBe("1");
        expect(globalThis.AMZ_INTERVALS.getDefaultValue("")).toBe("");
    });

    it("resolves milliseconds from user-selected values without clamping to defaults", () => {
        expect(globalThis.AMZ_INTERVALS.resolveMilliseconds("1", "ms", 1000)).toBe(1);
        expect(globalThis.AMZ_INTERVALS.resolveMilliseconds("2500", "ms", 1000)).toBe(2500);
        expect(globalThis.AMZ_INTERVALS.resolveMilliseconds("2", "s", 1000)).toBe(2000);
    });

    it("reads stored interval settings", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "1",
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "ms",
            [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 1000,
        });

        await expect(globalThis.AMZ_INTERVALS.getStoredMilliseconds()).resolves.toBe(1);
    });
});
