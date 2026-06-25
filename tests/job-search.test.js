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
        "AMZ_JOB_SEARCH",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/city-tags.js",
        "shared/utils/runtime-controls.js",
        "shared/utils/state-store.js",
        "content/utils/job-search.js",
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
    return store;
}

beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reload();
    window.localStorage.clear();
    vi.spyOn(Math, "random").mockReturnValue(0);
});

function buildRequest(jobType, overrides = {}) {
    return globalThis.AMZ_JOB_SEARCH.buildRequestBody({
        lat: "48.650629",
        lng: "-123.398604",
        distance: "150",
        jobType,
        ...overrides,
    }).variables.searchJobRequest;
}

function findJobTypeFilter(request) {
    return request.containFilters?.find(filter => filter.key === "jobType");
}

const MAX_PAY_SORTER = [{
    fieldName: "totalPayRateMax",
    ascending: "false",
}];

function buildCanadaAllCitiesHarShape(startDate) {
    return {
        locale: "en-CA",
        country: "Canada",
        pageSize: 100,
        sorters: MAX_PAY_SORTER,
        dateFilters: [{
            key: "firstDayOnSite",
            range: { startDate },
        }],
    };
}

function buildCanadaScheduleHarShape(jobId, startDate) {
    return {
        locale: "en-CA",
        country: "Canada",
        keyWords: "",
        equalFilters: [],
        containFilters: [{
            key: "isPrivateSchedule",
            val: ["false"],
        }],
        rangeFilters: [],
        orFilters: [],
        dateFilters: [{
            key: "firstDayOnSite",
            range: { startDate },
        }],
        sorters: MAX_PAY_SORTER,
        pageSize: 1000,
        jobId,
    };
}

describe("AMZ_JOB_SEARCH", () => {
    it("builds the active country request without sending a jobType GraphQL filter when both buckets are selected", () => {
        const body = globalThis.AMZ_JOB_SEARCH.buildRequestBody({
            lat: "48.650629",
            lng: "-123.398604",
            distance: "150",
            jobType: ["FULL_TIME", "PART_TIME"],
        });
        const { AMAZON } = globalThis.AMZ_CONSTANTS;
        const request = body.variables.searchJobRequest;

        expect(request.locale).toBe(AMAZON.COUNTRY_CONFIG.locale);
        expect(request.country).toBe(AMAZON.COUNTRY_CONFIG.country);
        expect(request.containFilters).toEqual([{
            key: "isPrivateSchedule",
            val: ["false"],
        }]);
        expect(request.containFilters.some(filter => filter.key === "jobType")).toBe(false);

        if (AMAZON.isCanada) {
            expect(request.equalFilters).toEqual([]);
            expect(request.sorters).toEqual(MAX_PAY_SORTER);
            expect(request.rangeFilters).toEqual([]);
            expect(request.geoQueryClause).toEqual({
                lat: 48.650629,
                lng: -123.398604,
                unit: "km",
                distance: 150,
            });
            expect(request.consolidateSchedule).toBeUndefined();
        } else {
            expect(request.equalFilters).toEqual([{
                key: "scheduleRequiredLanguage",
                val: "en-US",
            }]);
            expect(request.sorters).toEqual([{
                fieldName: "totalPayRateMax",
                ascending: "false",
            }]);
            expect(request.rangeFilters).toEqual([{
                key: "hoursPerWeek",
                range: { minimum: 0, maximum: 80 },
            }]);
            expect(request.geoQueryClause).toBeUndefined();
            expect(request.consolidateSchedule).toBe(true);
        }

        expect(body.query).toContain("jobType");
        expect(body.query).toContain("jobTypeL10N");
        expect(body.query).toContain("employmentType");
        expect(body.query).toContain("employmentTypeL10N");
        expect(body.query).toContain("scheduleCount");
        expect(body.query).toContain("postalCode");
        expect(body.query).toContain("currencyCode");
        expect(body.query).toContain("geoClusterDescription");
        expect(body.query).toContain("payFrequency");
        expect(body.query).toContain("jobLocationType");
    });

    it("keeps GraphQL request headers to app-owned values", () => {
        const headers = globalThis.AMZ_CONSTANTS.AMAZON.GRAPHQL.REQUEST_HEADERS;

        expect(headers).toEqual({
            accept: "*/*",
            "content-type": "application/json",
            iscanary: "false",
        });
        expect(Object.keys(headers).some(key => key.startsWith("sec-"))).toBe(false);
    });

    it("uses the official bearer authorization shape for GraphQL job search", () => {
        window.localStorage.setItem("sessionToken", "session-token");
        window.localStorage.setItem("bbCandidateId", "candidate-id");

        expect(globalThis.AMZ_JOB_SEARCH.getAuthorizationHeader()).toBe(
            "Bearer Status|logged-in|Session|session-token"
        );
    });

    it("marks the GraphQL authorization shape unauthenticated when no candidate is present", () => {
        window.localStorage.setItem("sessionToken", "session-token");

        expect(globalThis.AMZ_JOB_SEARCH.getAuthorizationHeader()).toBe(
            "Bearer Status|unauthenticated|Session|session-token"
        );
    });

    it.each([
        [[]],
        [["FULL_TIME"]],
        [["PART_TIME"]],
        [["FLEX_TIME"]],
        [["REDUCED_TIME"]],
        [["PART_TIME", "FLEX_TIME", "REDUCED_TIME"]],
        [["FULL_TIME", "PART_TIME"]],
        [["FULL_TIME", "FLEX_TIME"]],
        [["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"]],
    ])("omits Canada jobType GraphQL filters so matching can happen locally: %j", jobType => {
        expect(globalThis.AMZ_JOB_SEARCH.getJobTypeContainFilter(jobType, true)).toBeNull();

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            const request = buildRequest(jobType);
            expect(findJobTypeFilter(request)).toBeUndefined();
        }
    });

    it("does not build a US jobType GraphQL filter", () => {
        expect(globalThis.AMZ_JOB_SEARCH.getJobTypeContainFilter(["FULL_TIME"], false)).toBeNull();
        expect(globalThis.AMZ_JOB_SEARCH.getJobTypeContainFilter(["PART_TIME"], false)).toBeNull();
        expect(globalThis.AMZ_JOB_SEARCH.getJobTypeContainFilter(["FLEX_TIME"], false)).toBeNull();
        expect(globalThis.AMZ_JOB_SEARCH.getJobTypeContainFilter(["REDUCED_TIME"], false)).toBeNull();
    });

    it("uses the stored fallback distance when the selected distance is blank", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: { searchJobCardsByLocation: { jobCards: [] } },
                }),
            })
        );

        const result = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "",
            jobType: "",
        });

        expect(result.state).toBe("success");
        const [, init] = globalThis.fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(body.variables.searchJobRequest.geoQueryClause.distance).toBe(5);
        } else {
            expect(body.variables.searchJobRequest.geoQueryClause).toBeUndefined();
        }
    });

    it("uses supplied in-memory job search controls without reading storage during fetch", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: { searchJobCardsByLocation: { jobCards: [] } },
                }),
            })
        );
        globalThis.chrome.storage.local.get.mockClear();

        const result = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "",
            jobType: "",
            jobSearch: {
                fallbackDistanceKm: "9",
                fetchTimeoutMs: 0,
            },
        });

        expect(result.state).toBe("success");
        expect(globalThis.chrome.storage.local.get).not.toHaveBeenCalled();
        const [, init] = globalThis.fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(body.variables.searchJobRequest.geoQueryClause.distance).toBe(9);
        } else {
            expect(body.variables.searchJobRequest.geoQueryClause).toBeUndefined();
        }
    });

    it("omits Canada geo filters for all-cities searches", () => {
        const body = globalThis.AMZ_JOB_SEARCH.buildRequestBody({
            lat: "48.650629",
            lng: "-123.398604",
            distance: "150",
            selectedCity: "",
            allCitiesSelected: true,
            cityTags: ["Sidney", "Toronto"],
        });
        const request = body.variables.searchJobRequest;

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(request.geoQueryClause).toBeUndefined();
            expect(request.keyWords).toBeUndefined();
            expect(request.equalFilters).toBeUndefined();
            expect(request.containFilters).toBeUndefined();
            expect(request.rangeFilters).toBeUndefined();
            expect(request.orFilters).toBeUndefined();
            expect(request.consolidateSchedule).toBeUndefined();
            expect(request.sorters).toEqual(MAX_PAY_SORTER);
        } else {
            expect(request.geoQueryClause).toBeUndefined();
            expect(request.rangeFilters).toEqual([{
                key: "hoursPerWeek",
                range: { minimum: 0, maximum: 80 },
            }]);
            expect(request.consolidateSchedule).toBe(true);
        }
    });

    it("matches the captured Canada all-cities GraphQL request shape", () => {
        const body = globalThis.AMZ_JOB_SEARCH.buildRequestBody({
            lat: "48.650629",
            lng: "-123.398604",
            distance: "150",
            selectedCity: "",
            allCitiesSelected: true,
            cityTags: ["Sidney", "Toronto"],
            jobType: [],
        });
        const request = body.variables.searchJobRequest;
        const today = new Date().toISOString().split("T")[0];

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(request).toEqual(buildCanadaAllCitiesHarShape(today));
            expect(request.geoQueryClause).toBeUndefined();
            expect(request.consolidateSchedule).toBeUndefined();
        }
    });

    it("matches the captured Canada schedule GraphQL request shape for a known job", () => {
        const jobId = "JOB-CA-0000000434";
        const body = globalThis.AMZ_JOB_SEARCH.buildScheduleRequestBody({ jobId });
        const request = body.variables.searchScheduleRequest;
        const today = new Date().toISOString().split("T")[0];

        expect(body.operationName).toBe("searchScheduleCards");
        expect(body.query).toContain("query searchScheduleCards");
        expect(body.query).toContain("scheduleCards");
        expect(body.query).toContain("scheduleId");

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(request).toEqual(buildCanadaScheduleHarShape(jobId, today));
            expect(request.geoQueryClause).toBeUndefined();
            expect(request.consolidateSchedule).toBeUndefined();
            expect(request.containFilters.some(filter => filter.key === "scheduleShift")).toBe(false);
        }
    });

    it("fetches schedule cards with the official schedule GraphQL operation", async () => {
        const scheduleCard = {
            jobId: "JOB-CA-0000000434",
            scheduleId: "SCH-CA-0000005935",
            city: "Whitby",
            state: "ON",
        };
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: {
                        searchScheduleCards: {
                            nextToken: null,
                            scheduleCards: [scheduleCard],
                        },
                    },
                }),
            })
        );

        const result = await globalThis.AMZ_JOB_SEARCH.fetchScheduleCards({
            jobId: scheduleCard.jobId,
            jobSearch: { fetchTimeoutMs: 0 },
        });

        expect(result).toEqual(expect.objectContaining({
            state: "success",
            status: 200,
            scheduleCards: [scheduleCard],
            nextToken: null,
            isAuthError: false,
            isWafBlocked: false,
        }));
        const [, init] = globalThis.fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.operationName).toBe("searchScheduleCards");
        expect(body.variables.searchScheduleRequest.jobId).toBe(scheduleCard.jobId);
        expect(init.headers.country).toBe(globalThis.AMZ_CONSTANTS.AMAZON.COUNTRY_CONFIG.country);
        expect(init.headers.Authorization).toContain("Bearer Status|unauthenticated|Session|");
    });

    it("adds jitter before job search GraphQL requests", async () => {
        vi.useFakeTimers();
        Math.random.mockReturnValue(0.999);
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: { searchJobCardsByLocation: { jobCards: [] } },
                }),
            })
        );

        const resultPromise = globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "150",
            jobType: "",
            jobSearch: {
                fallbackDistanceKm: "5",
                fetchTimeoutMs: 0,
            },
        });

        await vi.advanceTimersByTimeAsync(49);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        const result = await resultPromise;
        expect(result.state).toBe("success");
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("adds jitter before schedule GraphQL requests", async () => {
        vi.useFakeTimers();
        Math.random.mockReturnValue(0.999);
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: {
                        searchScheduleCards: {
                            nextToken: null,
                            scheduleCards: [],
                        },
                    },
                }),
            })
        );

        const resultPromise = globalThis.AMZ_JOB_SEARCH.fetchScheduleCards({
            jobId: "JOB-CA-0000000434",
            jobSearch: { fetchTimeoutMs: 0 },
        });

        await vi.advanceTimersByTimeAsync(49);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        const result = await resultPromise;
        expect(result.state).toBe("success");
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("does not call schedule GraphQL without a job id", async () => {
        globalThis.fetch = vi.fn();

        const result = await globalThis.AMZ_JOB_SEARCH.fetchScheduleCards({
            jobSearch: { fetchTimeoutMs: 0 },
        });

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            state: "failed",
            status: null,
            scheduleCards: [],
            details: expect.stringContaining("Missing jobId"),
        }));
    });

    it("summarizes debug request shape without auth headers or GraphQL text", () => {
        const body = globalThis.AMZ_JOB_SEARCH.buildRequestBody({
            lat: "48.650629",
            lng: "-123.398604",
            distance: "150",
            selectedCity: "",
            allCitiesSelected: true,
            cityTags: ["Sidney", "Toronto"],
            jobType: ["PART_TIME"],
        });

        const summary = globalThis.AMZ_JOB_SEARCH.summarizeRequestBody(body, {
            selectedCity: "",
            allCitiesSelected: true,
            cityTags: ["Sidney", "Toronto"],
            jobType: ["PART_TIME"],
        }, {
            fallbackDistanceKm: "5",
            fetchTimeoutMs: 15000,
        });

        expect(summary).toEqual(expect.objectContaining({
            operationName: "searchJobCardsByLocation",
            country: "Canada",
            locale: "en-CA",
            allCitiesSearch: true,
            selectedCity: null,
            selectedJobTypes: ["PART_TIME"],
            cityTagCount: 2,
            geoQueryClauseSent: false,
            fallbackDistanceKm: "5",
            timeoutMs: 15000,
        }));
        expect(JSON.stringify(summary)).not.toContain("Authorization");
        expect(JSON.stringify(summary)).not.toContain("Bearer");
        expect(JSON.stringify(summary)).not.toContain("query searchJobCardsByLocation");
    });

    it("uses explicit all-cities state even before city tags are hydrated", () => {
        const request = globalThis.AMZ_JOB_SEARCH.buildRequestBody({
            lat: "48.650629",
            lng: "-123.398604",
            distance: "150",
            selectedCity: "",
            allCitiesSelected: true,
            cityTags: [],
            jobType: ["FULL_TIME"],
        }).variables.searchJobRequest;

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(request.geoQueryClause).toBeUndefined();
            expect(findJobTypeFilter(request)).toBeUndefined();
            expect(request.containFilters).toBeUndefined();
        }
    });

    it("only requires location coordinates when the active country search uses geo", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5" });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    data: { searchJobCardsByLocation: { jobCards: [] } },
                }),
            })
        );

        const result = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: null,
            lng: null,
            distance: "",
            jobType: "",
        });

        if (globalThis.AMZ_CONSTANTS.AMAZON.isCanada) {
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(result).toEqual(expect.objectContaining({
                state: "failed",
                status: null,
                jobCards: [],
                details: expect.stringContaining("Missing location coordinates"),
                isAuthError: false,
            }));
        } else {
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            expect(result).toEqual(expect.objectContaining({
                state: "success",
                status: 200,
                jobCards: [],
                isAuthError: false,
            }));
        }
    });

    it("marks only 401 GraphQL responses as auth errors by status", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5" });
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: () => Promise.resolve({}),
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: () => Promise.resolve({}),
            });

        const unauthorized = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "150",
            jobType: "",
        });
        const forbidden = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "150",
            jobType: "",
        });

        expect(unauthorized).toEqual(expect.objectContaining({
            state: "failed",
            status: 401,
            jobCards: [],
            isAuthError: true,
        }));
        expect(forbidden).toEqual(expect.objectContaining({
            state: "failed",
            status: 403,
            jobCards: [],
            isAuthError: false,
        }));
    });

    it("classifies GraphQL WAF 403 as retryable WAF block instead of auth failure", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({ [STORAGE_KEYS.JOB_SEARCH_FALLBACK_DISTANCE_KM]: "5" });
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            json: () => Promise.resolve({
                errors: [{ errorType: "WAFForbiddenException", message: "403 Forbidden" }],
            }),
        });

        const result = await globalThis.AMZ_JOB_SEARCH.fetchJobCards({
            lat: 48.65,
            lng: -123.39,
            distance: "150",
            jobType: "",
        });

        expect(result).toEqual(expect.objectContaining({
            state: "failed",
            status: 403,
            jobCards: [],
            isAuthError: false,
            isWafBlocked: true,
            details: expect.stringContaining("Amazon WAF"),
        }));
    });
});
