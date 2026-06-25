import { describe, it, expect, beforeEach } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_RUNTIME_CONTROLS"]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/runtime-controls.js",
    ]);
}

beforeEach(() => {
    reload();
});

describe("AMZ_RUNTIME_CONTROLS", () => {
    it("keeps a current city when runtime coordinates are valid", () => {
        const result = globalThis.AMZ_RUNTIME_CONTROLS.resolveSearchInputs({
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
                Toronto: { lat: 43.653524, lng: -79.383907 },
            },
            defaultInputs: { selectedCity: "Sidney", distance: "150", jobType: ["FULL_TIME", "PART_TIME"] },
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
        }, {
            selectedCity: "Toronto",
            distance: "150",
            jobType: ["PART_TIME"],
        });

        expect(result).toEqual({
            allCitiesSelected: false,
            selectedCity: "Toronto",
            lat: 43.653524,
            lng: -79.383907,
            distance: "150",
            jobType: ["PART_TIME"],
        });
    });

    it("falls back to backend defaults when current controls are blank or invalid", () => {
        const result = globalThis.AMZ_RUNTIME_CONTROLS.resolveSearchInputs({
            cityCoordinates: {
                Sidney: { lat: "48.650629", lng: "-123.398604" },
            },
            defaultInputs: { selectedCity: "Sidney", distance: "150", jobType: ["FULL_TIME", "PART_TIME"] },
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"],
        }, {
            selectedCity: "Missing City",
            distance: "",
            jobType: "",
        });

        expect(result.selectedCity).toBe("Sidney");
        expect(result.lat).toBe(48.650629);
        expect(result.lng).toBe(-123.398604);
        expect(result.distance).toBe("150");
        expect(result.jobType).toEqual(["FULL_TIME", "PART_TIME"]);
    });

    it("preserves all-cities mode without falling back to backend default coordinates", () => {
        const result = globalThis.AMZ_RUNTIME_CONTROLS.resolveSearchInputs({
            cityCoordinates: {
                Sidney: { lat: 48.650629, lng: -123.398604 },
            },
            defaultInputs: { selectedCity: "Sidney", distance: "150", jobType: ["FULL_TIME"] },
            distanceOptions: [{ value: "150", label: "150" }],
            jobTypeOptions: ["FULL_TIME", "PART_TIME"],
        }, {
            selectedCity: "",
            allCitiesSelected: true,
            distance: "150",
            jobType: ["FULL_TIME"],
        });

        expect(result).toEqual({
            allCitiesSelected: true,
            selectedCity: "",
            lat: null,
            lng: null,
            distance: "150",
            jobType: ["FULL_TIME"],
        });
    });

    it("filters null empty and undefined values out of runtime option lists", () => {
        const controls = globalThis.AMZ_RUNTIME_CONTROLS;

        expect(controls.normalizeStringList([
            null,
            "",
            "  ",
            "undefined",
            "Toronto",
            "Toronto",
            " null ",
            "Sidney",
        ])).toEqual(["Toronto", "Sidney"]);

        expect(controls.getAllowedValue([
            null,
            "",
            "undefined",
            { value: null, label: "Bad" },
            { value: "150", label: "150" },
        ], "150")).toBe("150");
        expect(controls.getAllowedValue(["null", "undefined"], "undefined")).toBe("");
    });

    it("parses canonical job types from GraphQL mixtures and matches any selected type", () => {
        const controls = globalThis.AMZ_RUNTIME_CONTROLS;

        expect(controls.normalizeJobTypeList("FLEX_TIME;FULL_TIME")).toEqual([
            "FLEX_TIME",
            "FULL_TIME",
        ]);
        expect(controls.normalizeJobTypeList(["part-time", "FULL_TIME", "FULL_TIME"])).toEqual([
            "PART_TIME",
            "FULL_TIME",
        ]);
        expect(controls.jobMatchesSelectedTypes("FLEX_TIME;FULL_TIME", ["FULL_TIME"])).toBe(true);
        expect(controls.jobMatchesSelectedTypes("FLEX_TIME;FULL_TIME", ["PART_TIME"])).toBe(false);
        expect(controls.jobMatchesSelectedTypes("FLEX_TIME;FULL_TIME", [])).toBe(true);
    });

    it("builds storage updates while respecting missing-only keys", () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const snapshot = {
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.CITY_TAGS]: ["Sidney"],
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "s",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "1",
        };
        const stored = {
            [STORAGE_KEYS.SELECTED_CITY]: "Toronto",
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "2",
        };

        const updates = globalThis.AMZ_RUNTIME_CONTROLS.pickStorageUpdates(snapshot, stored, {
            missingOnlyKeys: [
                STORAGE_KEYS.CITY_TAGS,
                STORAGE_KEYS.FETCH_INTERVAL_UNIT,
                STORAGE_KEYS.FETCH_INTERVAL_VALUE,
            ],
        });

        expect(updates).toEqual({
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "s",
        });
    });

    it("uses unit-specific fetch interval defaults in storage snapshots", () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const controls = {
            cityCoordinates: {},
            fetchInterval: {
                defaultUnit: "s",
                defaultSValue: "1",
                defaultMsValue: 1000,
            },
        };

        expect(globalThis.AMZ_RUNTIME_CONTROLS.buildStorageSnapshot(controls, {
            fetchIntervalUnit: "s",
        })).toEqual(expect.objectContaining({
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "s",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "1",
            [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 0,
        }));

        expect(globalThis.AMZ_RUNTIME_CONTROLS.buildStorageSnapshot(controls, {
            fetchIntervalUnit: "ms",
        })).toEqual(expect.objectContaining({
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "ms",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "1000",
            [STORAGE_KEYS.FETCH_INTERVAL_MIN_MS]: 0,
        }));
    });
});
