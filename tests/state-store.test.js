import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_TEXT",
        "AMZ_STORAGE",
        "AMZ_CITY_TAGS",
        "AMZ_RUNTIME_CONTROLS",
        "AMZ_STATE",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/city-tags.js",
        "shared/utils/runtime-controls.js",
        "shared/utils/state-store.js",
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
    globalThis.chrome.storage.local.remove = vi.fn((keys, cb) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    globalThis.chrome.storage.local.clear = vi.fn(cb => {
        Object.keys(store).forEach(key => delete store[key]);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    return store;
}

beforeEach(() => {
    reload();
});

describe("AMZ_STATE", () => {
    it("syncs backend runtime controls through a single storage boundary", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "2",
        });

        const result = await globalThis.AMZ_STATE.syncRuntimeControls({
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
            },
            defaultCityTags: ["Sidney"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            },
            fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
            jobSearch: { fallbackDistanceKm: "5", fetchTimeoutMs: 15000 },
            pageRefresh: { jobSearchIntervalMs: 120000 },
        }, {}, {
            missingOnlyKeys: [
                STORAGE_KEYS.CITY_TAGS,
                STORAGE_KEYS.FETCH_INTERVAL_VALUE,
            ],
        });

        expect(result.snapshot[STORAGE_KEYS.SELECTED_CITY]).toBe("Sidney");
        expect(result.snapshot[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(false);
        expect(result.snapshot[STORAGE_KEYS.LATITUDE]).toBe(48.650629);
        expect(result.snapshot[STORAGE_KEYS.DISTANCE]).toBe("150");
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Toronto"]);
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_VALUE]).toBe("2");
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_UNIT]).toBe("s");
        expect(store[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]).toBe(15000);
    });

    it("can force backend defaults over existing stored popup values", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "Toronto",
            [STORAGE_KEYS.DISTANCE]: "50",
            [STORAGE_KEYS.JOB_TYPE]: ["PART_TIME"],
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "ms",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "250",
        });

        await globalThis.AMZ_STATE.syncRuntimeControls({
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
            },
            defaultCityTags: ["Sidney", "Ottawa"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            },
            fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
            jobSearch: { fallbackDistanceKm: "5", fetchTimeoutMs: 15000 },
            pageRefresh: { jobSearchIntervalMs: 120000 },
        }, {}, {
            useStoredCurrent: false,
        });

        expect(store[STORAGE_KEYS.SELECTED_CITY]).toBe("Sidney");
        expect(store[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(false);
        expect(store[STORAGE_KEYS.DISTANCE]).toBe("150");
        expect(store[STORAGE_KEYS.JOB_TYPE]).toEqual([
            "FULL_TIME",
            "PART_TIME",
            "FLEX_TIME",
            "REDUCED_TIME",
        ]);
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Sidney", "Ottawa"]);
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_UNIT]).toBe("s");
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_VALUE]).toBe("1");
    });

    it("owns city tag merging and persistence", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
        });

        const merged = await globalThis.AMZ_STATE.upsertCityTags(["Toronto"], "");

        expect(merged).toEqual(["Toronto", "Sidney"]);
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Toronto", "Sidney"]);
    });

    it("keeps all-cities mode through runtime control sync", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "",
            [STORAGE_KEYS.ALL_CITIES_SELECTED]: true,
            [STORAGE_KEYS.CITY_TAGS]: ["Sidney", "Toronto"],
            [STORAGE_KEYS.DISTANCE]: "150",
        });

        const result = await globalThis.AMZ_STATE.syncRuntimeControls({
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
                Toronto: { lat: 43.653524, lng: -79.383907 },
            },
            defaultCityTags: ["Sidney", "Toronto"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME"],
            },
        }, {
            selectedCity: "",
            allCitiesSelected: true,
            distance: "150",
            jobType: ["FULL_TIME"],
        });

        expect(result.snapshot[STORAGE_KEYS.SELECTED_CITY]).toBe("");
        expect(result.snapshot[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(true);
        expect(result.snapshot[STORAGE_KEYS.LATITUDE]).toBeNull();
        expect(result.snapshot[STORAGE_KEYS.LONGITUDE]).toBeNull();
        expect(store[STORAGE_KEYS.SELECTED_CITY]).toBe("");
        expect(store[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(true);
    });

    it("hydrates a selected client with first valid city, all valid city tags, and runtime defaults", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "Stale City",
            [STORAGE_KEYS.DISTANCE]: "999",
            [STORAGE_KEYS.JOB_TYPE]: ["FULL_TIME"],
            [STORAGE_KEYS.CITY_TAGS]: ["Stale City"],
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "ms",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "250",
        });

        const hydration = await globalThis.AMZ_STATE.hydrateClientSelection({
            id: 7,
            name: "Test Client",
            emailid: "client@example.com",
            pin: "123456",
            status: "PENDING",
            location: ["Toronto", "Unknown", "Vancouver"],
            job_type: ["PART_TIME", "FLEX_TIME"],
        }, {
            cityCoordinates: {
                Toronto: { lat: 43.653524, lng: -79.383907 },
                Vancouver: { lat: 49.261636, lng: -123.11335 },
                Sidney: { lat: 48.650629, lng: -123.398604 },
            },
            defaultCityTags: ["Sidney"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            },
            fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
            jobSearch: { fallbackDistanceKm: "5", fetchTimeoutMs: 15000 },
            pageRefresh: { jobSearchIntervalMs: 120000 },
        });

        expect(hydration.validLocations).toEqual(["Toronto", "Vancouver"]);
        expect(hydration.unmappedLocations).toEqual(["Unknown"]);
        expect(store[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]).toBe("client@example.com");
        expect(store[STORAGE_KEYS.PASSWORD]).toBe("123456");
        expect(store[STORAGE_KEYS.SELECTED_CLIENT_ID]).toBe("7");
        expect(store[STORAGE_KEYS.SELECTED_CLIENT_LABEL]).toBe("Test Client (PENDING)");
        expect(store[STORAGE_KEYS.SELECTED_CITY]).toBe("Toronto");
        expect(store[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(false);
        expect(store[STORAGE_KEYS.LATITUDE]).toBe(43.653524);
        expect(store[STORAGE_KEYS.LONGITUDE]).toBe(-79.383907);
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Toronto", "Vancouver"]);
        expect(store[STORAGE_KEYS.DISTANCE]).toBe("150");
        expect(store[STORAGE_KEYS.JOB_TYPE]).toEqual(["PART_TIME", "FLEX_TIME"]);
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_UNIT]).toBe("s");
        expect(store[STORAGE_KEYS.FETCH_INTERVAL_VALUE]).toBe("1");
        expect(store[STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]).toBe(15000);
        expect(store[STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]).toBe(120000);
    });

    it("keeps runtime city defaults when client locations cannot be mapped", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore();

        const hydration = await globalThis.AMZ_STATE.hydrateClientSelection({
            id: 8,
            emailid: "nomap@example.com",
            pin: "999999",
            location: ["Unknown"],
            job_type: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
        }, {
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
            },
            defaultCityTags: ["Sidney"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
            },
            fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
        });

        expect(hydration.validLocations).toEqual([]);
        expect(hydration.unmappedLocations).toEqual(["Unknown"]);
        expect(store[STORAGE_KEYS.SELECTED_CITY]).toBe("Sidney");
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Sidney"]);
        expect(store[STORAGE_KEYS.AMAZON_LOGIN_USERNAME]).toBe("nomap@example.com");
        expect(store[STORAGE_KEYS.PASSWORD]).toBe("999999");
    });

    it("hydrates all-cities clients without choosing a geo anchor city", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.LATITUDE]: 48.650629,
            [STORAGE_KEYS.LONGITUDE]: -123.398604,
        });

        const hydration = await globalThis.AMZ_STATE.hydrateClientSelection({
            id: 10,
            emailid: "all@example.com",
            pin: "111111",
            location: ["Sidney", "Toronto"],
            job_type: ["FULL_TIME"],
        }, {
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
                Toronto: { lat: 43.653524, lng: -79.383907 },
            },
            defaultCityTags: ["Sidney", "Toronto"],
            cityOptions: ["Sidney", "Toronto"],
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME"],
            defaultInputs: {
                selectedCity: "Sidney",
                distance: "150",
                jobType: ["FULL_TIME", "PART_TIME"],
            },
        });

        expect(hydration.allCitiesSelected).toBe(true);
        expect(store[STORAGE_KEYS.SELECTED_CITY]).toBe("");
        expect(store[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(true);
        expect(store[STORAGE_KEYS.LATITUDE]).toBeNull();
        expect(store[STORAGE_KEYS.LONGITUDE]).toBeNull();
        expect(store[STORAGE_KEYS.CITY_TAGS]).toEqual(["Sidney", "Toronto"]);
    });

    it("normalizes job-search and page-refresh controls", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.ACTIVE]: true,
            [STORAGE_KEYS.SELECTED_CLIENT_ID]: "7",
            [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5",
            [STORAGE_KEYS.JOB_SEARCH_FETCH_TIMEOUT_MS]: "15000",
            [STORAGE_KEYS.PAGE_REFRESH_JOB_SEARCH_INTERVAL_MS]: "120000",
        });

        await expect(globalThis.AMZ_STATE.getJobSearchControls()).resolves.toEqual({
            fallbackDistanceKm: "5",
            fetchTimeoutMs: 15000,
        });
        await expect(globalThis.AMZ_STATE.getPageRefreshIntervalMs()).resolves.toBe(120000);

        delete store[STORAGE_KEYS.SELECTED_CLIENT_ID];
        await expect(globalThis.AMZ_STATE.getPageRefreshIntervalMs()).resolves.toBe(120000);
    });

    it("allows paid activation without a selected admin client", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore();

        await expect(globalThis.AMZ_STATE.setActive(true)).resolves.toBe(true);
        expect(store[STORAGE_KEYS.ACTIVE]).toBe(true);
    });
});
