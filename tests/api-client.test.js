import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_STORAGE", "AMZ_MESSAGING", "AMZ_API"]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/storage.js",
        "shared/utils/messaging.js",
        "shared/api-client.js",
    ]);
}

beforeEach(() => {
    reload();
});

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
    return store;
}

const ADMIN_SESSION_TOKEN = "session-token";

function useAdminSessionStore(initial = {}) {
    const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
    return useLocalStore({
        [STORAGE_KEYS.OPERATOR_USERNAME]: "admin-user",
        [STORAGE_KEYS.ADMIN_SESSION_TOKEN]: ADMIN_SESSION_TOKEN,
        ...initial,
    });
}

function expectAdminSessionHeader(init, token = ADMIN_SESSION_TOKEN) {
    expect(init.headers).toEqual(expect.objectContaining({
        [globalThis.AMZ_CONSTANTS.BACKEND.AUTH_HEADER]: token,
    }));
}

describe("AMZ_API namespace", () => {
    it("is exposed on globalThis and frozen", () => {
        expect(globalThis.AMZ_API).toBeDefined();
        expect(Object.isFrozen(globalThis.AMZ_API)).toBe(true);
    });

    it("exposes a base URL targeting the Canada paid backend", () => {
        expect(globalThis.AMZ_API.BASE_URL).toBe(
            "https://getslotnow.com/administrator-api/api/amazon-warehouse-jobs-canada"
        );
    });

    it("exposes local tracker fallback config for offline runtime defaults", () => {
        const f = globalThis.AMZ_API.FALLBACK_DEFAULTS;
        expect(Object.keys(f.cityCoordinates)).toHaveLength(42);
        expect(f.cityCoordinates.Sidney).toEqual({
            lat: 48.650629,
            lng: -123.398604,
        });
        expect(f.defaultInputs.selectedCity).toBe("Sidney");
        expect(f.defaultInputs.distance).toBe("150");
        expect(f.defaultCityTags).toContain("Sidney");
        expect(f.cityOptions).toContain("Sidney");
        expect(f.distanceOptions).toContainEqual({ value: "25000", label: "Entire Country" });
        expect(f.jobTypeOptions).toEqual(["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"]);
    });
});

describe("apiCheckLicense()", () => {
    it("GETs /license/check and returns the parsed body", async () => {
        useAdminSessionStore();
        const body = { valid: true, expires_at: "2026-12-31T23:59:59" };
        const fetchSpy = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiCheckLicense();
        expect(result).toEqual(body);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/license/check");
        expect(init.method).toBe("GET");
        expectAdminSessionHeader(init);
    });

    it("returns null on non-ok responses", async () => {
        useAdminSessionStore();
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        );
        expect(await globalThis.AMZ_API.apiCheckLicense()).toBeNull();
    });
});

describe("apiGetDefaults()", () => {
    it("GETs /config/defaults", async () => {
        useAdminSessionStore();
        const fetchSpy = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
        );
        globalThis.fetch = fetchSpy;
        await globalThis.AMZ_API.apiGetDefaults();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/config/defaults");
        expect(init.method).toBe("GET");
        expectAdminSessionHeader(init);
    });
});

describe("apiPostApplicationAttempt()", () => {
    it("POSTs application attempts with an admin session", async () => {
        useAdminSessionStore();
        const fetchSpy = vi.fn(() =>
            Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }) })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiPostApplicationAttempt({
            attempt_id: "AS-TEST",
            outcome: "JOB_MATCHED",
        });

        expect(result.ok).toBe(true);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/application-attempts");
        expect(init.method).toBe("POST");
        expectAdminSessionHeader(init);
        expect(JSON.parse(init.body).attempt_id).toBe("AS-TEST");
    });
});

describe("apiLoginAdmin()", () => {
    it("stores the returned admin session without storing the password", async () => {
        const store = useLocalStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.USERNAME]: "legacy" });
        const fetchSpy = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    admin_id: 7,
                    username: "ankit5076",
                    phone_number: "8123784208",
                    email_address: "ankit.vishwakarma513@gmail.com",
                    session_token: "login-token",
                }),
            })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiLoginAdmin({
            username: "ankit5076",
            password: "Automate!5076",
        });

        expect(result.username).toBe("ankit5076");
        expect(result.session_token).toBe("login-token");
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]).toBe("ankit5076");
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ADMIN_SESSION_TOKEN]).toBe("login-token");
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.PASSWORD]).toBeUndefined();
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.USERNAME]).toBeUndefined();
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://getslotnow.com/administrator-api/api/amazon-warehouse-jobs-canada/auth/login",
            expect.objectContaining({
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: "ankit5076", password: "Automate!5076" }),
            })
        );
    });
});

describe("admin session enforcement", () => {
    it("does not call protected endpoints or mutate auth state without a stored admin session", async () => {
        const store = useLocalStore({
            [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "admin-user",
        });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        await expect(globalThis.AMZ_API.apiCheckLicense()).resolves.toBeNull();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ACTIVE]).toBeUndefined();
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ADMIN_SESSION_TOKEN]).toBeUndefined();
    });

    it("keeps the admin session, runtime cache, and active flag after a 401", async () => {
        const store = useAdminSessionStore({
            [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ACTIVE]: true,
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: {
                username: "admin-user",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "admin-user",
                cachedAt: Date.now(),
                policy: { valid: true, username: "admin-user" },
            },
        });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })
        );

        await expect(globalThis.AMZ_API.apiCheckLicense()).resolves.toBeNull();

        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ADMIN_SESSION_TOKEN]).toBe(ADMIN_SESSION_TOKEN);
        expect(store[globalThis.AMZ_CONSTANTS.STORAGE_KEYS.ACTIVE]).toBe(true);
        expect(store[globalThis.AMZ_API.RUNTIME_CACHE_KEY]).toBeDefined();
    });
});

describe("apiGetScheduleCooldown()", () => {
    it("GETs the schedule cooldown endpoint with an admin session", async () => {
        useAdminSessionStore();
        const fetchSpy = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ cooled_down: true }),
            })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiGetScheduleCooldown({
            country: "ca",
            jobId: "JOB-1",
            scheduleId: "SCH-1",
            cooldownMs: 120000,
        });

        expect(result).toEqual({ cooled_down: true });
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(
            globalThis.AMZ_API.BASE_URL +
            "/application-attempts/schedule-cooldown?country=ca&jobId=JOB-1&scheduleId=SCH-1&cooldownMs=120000"
        );
        expect(init.method).toBe("GET");
        expectAdminSessionHeader(init);
    });
});

describe("apiGetClients()", () => {
    it("GETs /clients and normalizes client response fields", async () => {
        useAdminSessionStore();
        const fetchSpy = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve([
                    {
                        id: 42,
                        name: " Test Client ",
                        emailid: " client@example.com ",
                        pin: " 123456 ",
                        status: " PENDING ",
                        location: [" Toronto ", "", "Toronto", " Vancouver "],
                        job_type: [" PART_TIME ", "", "PART_TIME", " FLEX_TIME "],
                        created_at: "2026-05-17T10:00:00",
                    },
                    {
                        id: 43,
                        name: "Booked Client",
                        emailid: "booked@example.com",
                        pin: "111111",
                        status: " BOOKED ",
                    },
                    {
                        id: 44,
                        name: "Settled Client",
                        emailid: "settled@example.com",
                        pin: "222222",
                        status: " settled ",
                    },
                    null,
                ]),
            })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiGetClients();

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(expect.objectContaining({
            id: "42",
            name: "Test Client",
            emailid: "client@example.com",
            pin: "123456",
            status: "PENDING",
            location: ["Toronto", "Vancouver"],
            jobType: ["PART_TIME", "FLEX_TIME"],
            job_type: ["PART_TIME", "FLEX_TIME"],
            createdAt: "2026-05-17T10:00:00",
        }));
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/clients?excludeStatuses=BOOKED%2CSETTLED");
        expect(init.method).toBe("GET");
        expectAdminSessionHeader(init);
    });

    it("proxies /clients through the service worker in extension contexts", async () => {
        useAdminSessionStore();
        globalThis.chrome.runtime.id = "extension-id";
        globalThis.chrome.runtime.sendMessage = vi.fn((message, cb) => {
            cb({ ok: true, status: 200, body: [] });
        });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiGetClients();

        expect(result).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith({
            action: globalThis.AMZ_CONSTANTS.MESSAGE_ACTIONS.BACKEND_REQUEST,
            path: "/clients?excludeStatuses=BOOKED%2CSETTLED",
            init: {
                method: "GET",
                headers: { [globalThis.AMZ_CONSTANTS.BACKEND.AUTH_HEADER]: ADMIN_SESSION_TOKEN },
            },
        }, expect.any(Function));

        delete globalThis.chrome.runtime.id;
    });

    it("does not call /clients without a stored operator username", async () => {
        useLocalStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "" });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        await expect(globalThis.AMZ_API.apiGetClients()).rejects.toMatchObject({
            code: globalThis.AMZ_API.ERROR_CODES.MISSING_OPERATOR_USERNAME,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("guards direct /clients backend requests through the same operator gate", async () => {
        useLocalStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "" });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        await expect(
            globalThis.AMZ_API.backendRequest("/clients", { method: "GET" })
        ).rejects.toMatchObject({
            code: globalThis.AMZ_API.ERROR_CODES.MISSING_OPERATOR_USERNAME,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns null when the clients response is not a list", async () => {
        useAdminSessionStore();
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ clients: [] }) })
        );
        await expect(globalThis.AMZ_API.apiGetClients()).resolves.toBeNull();
    });
});

describe("apiGetRuntimePolicy()", () => {
    it("GETs /runtime with an admin session", async () => {
        useAdminSessionStore();
        const body = { valid: false };
        const fetchSpy = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiGetRuntimePolicy("team user");
        expect(result).toEqual(body);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/runtime");
        expect(init.method).toBe("GET");
        expectAdminSessionHeader(init);
    });

    it("proxies backend requests through the service worker in extension contexts", async () => {
        useAdminSessionStore();
        const body = { valid: false };
        globalThis.chrome.runtime.id = "extension-id";
        globalThis.chrome.runtime.sendMessage = vi.fn((message, cb) => {
            cb({ ok: true, status: 200, body });
        });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiGetRuntimePolicy("team user");

        expect(result).toEqual(body);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledOnce();
        expect(globalThis.chrome.runtime.sendMessage.mock.calls[0][0]).toEqual({
            action: globalThis.AMZ_CONSTANTS.MESSAGE_ACTIONS.BACKEND_REQUEST,
            path: "/runtime",
            init: {
                method: "GET",
                headers: { [globalThis.AMZ_CONSTANTS.BACKEND.AUTH_HEADER]: ADMIN_SESSION_TOKEN },
            },
        });

        delete globalThis.chrome.runtime.id;
    });

    it("dedupes simultaneous runtime backend requests", async () => {
        useAdminSessionStore();
        let resolveFetch;
        const fetchSpy = vi.fn(() => new Promise(resolve => {
            resolveFetch = resolve;
        }));
        globalThis.fetch = fetchSpy;

        const first = globalThis.AMZ_API.backendRequest("/runtime", { method: "GET" });
        const second = globalThis.AMZ_API.backendRequest("/runtime", { method: "GET" });

        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
        resolveFetch({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ valid: true }),
        });

        await expect(Promise.all([first, second])).resolves.toEqual([
            { ok: true, status: 200, body: { valid: true } },
            { ok: true, status: 200, body: { valid: true } },
        ]);
    });
});

describe("loadRuntimePolicy()", () => {
    it("normalizes a valid runtime policy and writes the one-hour runtime cache", async () => {
        useAdminSessionStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "paiduser" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    valid: true,
                    controls: {
                        city_coordinates: { Toronto: { lat: 43.65, lng: -79.38 } },
                        default_city_tags: ["Toronto"],
                        city_options: ["Toronto"],
                        distance_options: [{ value: "5", label: "5" }],
                        job_type_options: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
                        default_inputs: {
                            selected_city: "Toronto",
                            distance: "5",
                            job_type: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
                        },
                        fetch_interval: {
                            default_unit: "s",
                            default_s_value: "1",
                            default_ms_value: 1000,
                        },
                        job_search: { fallback_distance_km: 5, fetch_timeout_ms: 15000 },
                        page_refresh: { job_search_interval_ms: 120000 },
                        features: {
                            polling: true,
                            schedule_automation: true,
                            direct_application: true,
                            telegram: true,
                        },
                    },
                }),
            })
        );

        const result = await globalThis.AMZ_API.loadRuntimePolicy("paiduser", { allowCache: false });
        expect(result.valid).toBe(true);
        expect(result.username).toBe("paiduser");
        expect(result.controls.cityCoordinates.Toronto).toEqual({ lat: 43.65, lng: -79.38 });
        expect(result.controls.features.telegram).toBe(true);
        expect(result.controls.defaultInputs).toEqual({
            selectedCity: "Toronto",
            distance: "5",
            jobType: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
        });
        expect(result.controls.fetchInterval).toEqual({
            defaultUnit: "s",
            defaultSValue: "1",
            defaultMsValue: 1000,
        });
        expect(result.controls.jobSearch).toEqual({
            fallbackDistanceKm: "5",
            fetchTimeoutMs: 15000,
        });
        expect(result.controls.pageRefresh).toEqual({
            jobSearchIntervalMs: 120000,
        });
        expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith({
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: expect.objectContaining({
                username: "paiduser",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "paiduser",
                cachedAt: expect.any(Number),
                policy: expect.objectContaining({ valid: true, username: "paiduser" }),
            }),
        });
    });

    it("filters null empty and undefined runtime control options", async () => {
        useAdminSessionStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "paiduser" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    valid: true,
                    controls: {
                        city_coordinates: {
                            "": { lat: 1, lng: 2 },
                            null: { lat: 3, lng: 4 },
                            Toronto: { lat: 43.65, lng: -79.38 },
                        },
                        default_city_tags: [null, "", "undefined", "Toronto", "Toronto", " Bolton "],
                        city_options: [null, "", "undefined", " Toronto ", "Toronto"],
                        distance_options: [
                            null,
                            { value: null, label: "Bad" },
                            { value: "", label: "Bad" },
                            { value: "5", label: "" },
                            { value: "5", label: "Duplicate" },
                            { value: "null", label: "Bad" },
                            { value: 15, label: " 15 " },
                        ],
                        job_type_options: ["", "undefined", "FULL_TIME", "FULL_TIME", " PART_TIME "],
                        default_inputs: {
                            selected_city: "null",
                            distance: undefined,
                            job_type: ["FULL_TIME", "", "FLEX_TIME"],
                        },
                    },
                }),
            })
        );

        const result = await globalThis.AMZ_API.loadRuntimePolicy("paiduser", { allowCache: false });

        expect(result.controls.cityCoordinates).toEqual({
            Toronto: { lat: 43.65, lng: -79.38 },
        });
        expect(result.controls.defaultCityTags).toEqual(["Toronto", "Bolton"]);
        expect(result.controls.cityOptions).toEqual(["Toronto"]);
        expect(result.controls.distanceOptions).toEqual([
            { value: "5", label: "5" },
            { value: "15", label: "15" },
        ]);
        expect(result.controls.jobTypeOptions).toEqual(["FULL_TIME", "PART_TIME"]);
        expect(result.controls.defaultInputs).toEqual({
            selectedCity: "",
            distance: "",
            jobType: ["FULL_TIME", "FLEX_TIME"],
        });
    });

    it("uses a fresh cached runtime policy without calling the backend", async () => {
        const cachedPolicy = {
            valid: true,
            username: "paiduser",
            controls: {
                cityCoordinates: {},
                defaultCityTags: ["Calgary"],
                cityOptions: ["Calgary"],
                distanceOptions: [],
                jobTypeOptions: [],
                defaultInputs: { selectedCity: "Calgary", distance: "150", jobType: ["FULL_TIME"] },
                fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
                jobSearch: { fallbackDistanceKm: "5", fetchTimeoutMs: 15000 },
                pageRefresh: { jobSearchIntervalMs: 120000 },
                features: { polling: true },
            },
        };
        useLocalStore({
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: {
                username: "paiduser",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "paiduser",
                cachedAt: Date.now(),
                policy: cachedPolicy,
            },
        });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.loadRuntimePolicy("PaidUser");

        expect(result.valid).toBe(true);
        expect(result.cache.hit).toBe(true);
        expect(result.controls.defaultCityTags).toEqual(["Calgary"]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("exposes a fresh cached runtime policy without calling the backend", async () => {
        const cachedPolicy = {
            valid: true,
            username: "paiduser",
            controls: {
                cityCoordinates: {},
                defaultCityTags: ["Calgary"],
                cityOptions: ["Calgary"],
                distanceOptions: [],
                jobTypeOptions: [],
                defaultInputs: { selectedCity: "Calgary", distance: "150", jobType: ["FULL_TIME"] },
                fetchInterval: { defaultSValue: "1", defaultUnit: "s", defaultMsValue: 1000 },
                jobSearch: { fallbackDistanceKm: "5", fetchTimeoutMs: 15000 },
                pageRefresh: { jobSearchIntervalMs: 120000 },
                features: { polling: true },
            },
        };
        useLocalStore({
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: {
                username: "paiduser",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "paiduser",
                cachedAt: Date.now(),
                policy: cachedPolicy,
            },
        });
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.getCachedRuntimePolicy("PaidUser");

        expect(result.valid).toBe(true);
        expect(result.cache.hit).toBe(true);
        expect(result.controls.defaultCityTags).toEqual(["Calgary"]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("bypasses the cache when allowCache is false", async () => {
        useAdminSessionStore({
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: {
                username: "paiduser",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "paiduser",
                cachedAt: Date.now(),
                policy: { valid: false, username: "paiduser" },
            },
        });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ valid: true, controls: {} }),
            })
        );

        const result = await globalThis.AMZ_API.loadRuntimePolicy("paiduser", { allowCache: false });

        expect(result.valid).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("clears the persisted runtime policy cache", async () => {
        const store = useLocalStore({
            [globalThis.AMZ_API.RUNTIME_CACHE_KEY]: {
                username: "paiduser",
                version: globalThis.AMZ_API.RUNTIME_POLICY_CACHE_VERSION,
                usernameKey: "paiduser",
                cachedAt: Date.now(),
                policy: { valid: true, username: "paiduser" },
            },
        });

        await globalThis.AMZ_API.clearRuntimePolicyCache();

        expect(store[globalThis.AMZ_API.RUNTIME_CACHE_KEY]).toBeUndefined();
    });

    it("does not backfill missing runtime controls from bundled constants", async () => {
        useAdminSessionStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "paiduser" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ valid: true, controls: {} }),
            })
        );

        const result = await globalThis.AMZ_API.loadRuntimePolicy("paiduser");

        expect(result.valid).toBe(true);
        expect(result.controls.cityCoordinates).toEqual({});
        expect(result.controls.defaultCityTags).toEqual([]);
        expect(result.controls.cityOptions).toEqual([]);
        expect(result.controls.distanceOptions).toEqual([]);
        expect(result.controls.jobTypeOptions).toEqual([]);
        expect(result.controls.defaultInputs).toEqual({
            selectedCity: "",
            distance: "",
            jobType: [],
        });
        expect(result.controls.fetchInterval).toEqual({
            defaultUnit: "",
            defaultSValue: "",
            defaultMsValue: 0,
        });
        expect(result.controls.jobSearch).toEqual({
            fallbackDistanceKm: "",
            fetchTimeoutMs: 0,
        });
        expect(result.controls.pageRefresh).toEqual({
            jobSearchIntervalMs: 0,
        });
    });

    it("returns null when runtime cannot be reached", async () => {
        useAdminSessionStore({ [globalThis.AMZ_CONSTANTS.STORAGE_KEYS.OPERATOR_USERNAME]: "paiduser" });
        globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
        expect(await globalThis.AMZ_API.loadRuntimePolicy("paiduser", { allowCache: false })).toBeNull();
    });
});

describe("apiSendTelegramNotification()", () => {
    it("POSTs JSON to /notifications/telegram and returns the parsed body", async () => {
        useAdminSessionStore();
        const body = { delivered: true, message_id: 42 };
        const fetchSpy = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
        );
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.apiSendTelegramNotification({
            text: "<b>hi</b>",
            parse_mode: "HTML",
        });
        expect(result).toEqual(body);

        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(globalThis.AMZ_API.BASE_URL + "/notifications/telegram");
        expect(init.method).toBe("POST");
        expect(init.headers["content-type"]).toBe("application/json");
        expectAdminSessionHeader(init);
        expect(JSON.parse(init.body)).toEqual({
            text: "<b>hi</b>",
            parse_mode: "HTML",
        });
    });

    it("returns {delivered:false, error} on http failure", async () => {
        useAdminSessionStore();
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) })
        );
        const result = await globalThis.AMZ_API.apiSendTelegramNotification({ text: "x" });
        expect(result.delivered).toBe(false);
        expect(result.error).toContain("502");
    });

    it("returns {delivered:false, error} on a thrown fetch", async () => {
        useAdminSessionStore();
        globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
        const result = await globalThis.AMZ_API.apiSendTelegramNotification({ text: "x" });
        expect(result.delivered).toBe(false);
        expect(result.error).toBe("offline");
    });
});

describe("loadDefaults()", () => {
    it("returns empty defaults when the session cache is empty and the server returns nothing", async () => {
        useAdminSessionStore();
        // chrome.storage.session.get returns {} via the default stub;
        // fetch is set to return a non-ok response so apiGetDefaults() -> null.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) })
        );
        const result = await globalThis.AMZ_API.loadDefaults();
        expect(result.cityCoordinates).toEqual({});
        expect(result.defaultCityTags).toEqual([]);
    });

    it("normalizes a server response and writes it to the session cache", async () => {
        useAdminSessionStore();
        const serverBody = {
            city_coordinates: {
                Toronto: { lat: 43.65, lng: -79.38 },
                Bogus: { lat: "NaN", lng: 0 }, // dropped — not a number
            },
            default_city_tags: ["Toronto", "Bolton"],
        };
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(serverBody) })
        );

        const setSpy = vi.spyOn(globalThis.chrome.storage.session, "set");

        const result = await globalThis.AMZ_API.loadDefaults();
        expect(result.cityCoordinates).toEqual({
            Toronto: { lat: 43.65, lng: -79.38 },
        });
        expect(result.defaultCityTags).toEqual(["Toronto", "Bolton"]);
        expect(setSpy).toHaveBeenCalledOnce();
        const [payload] = setSpy.mock.calls[0];
        expect(payload[globalThis.AMZ_API.DEFAULTS_CACHE_KEY]).toEqual(result);
    });

    it("uses the session cache and skips the network when populated", async () => {
        const cached = {
            cityCoordinates: { Halifax: { lat: 44.65, lng: -63.58 } },
            defaultCityTags: ["Halifax"],
        };
        // Override the chrome stub for this test.
        globalThis.chrome.storage.session.get = (_keys, cb) => {
            const result = { [globalThis.AMZ_API.DEFAULTS_CACHE_KEY]: cached };
            if (typeof cb === "function") cb(result);
            return Promise.resolve(result);
        };

        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const result = await globalThis.AMZ_API.loadDefaults();
        expect(result).toEqual(cached);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
