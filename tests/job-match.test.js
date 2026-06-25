import { beforeEach, describe, expect, it } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_TEXT",
        "AMZ_CITY_TAGS",
        "AMZ_RUNTIME_CONTROLS",
        "AMZ_JOB_MATCH",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/city-tags.js",
        "shared/utils/runtime-controls.js",
        "content/utils/job-match.js",
    ]);
}

describe("AMZ_JOB_MATCH", () => {
    beforeEach(() => {
        reload();
    });

    it("matches against in-memory city tags and exact selected job types", () => {
        const jobs = [
            { jobId: "JOB-1", city: "Toronto", jobType: "PART_TIME" },
            { jobId: "JOB-2", city: "Sidney", jobType: "FULL_TIME" },
        ];

        const result = globalThis.AMZ_JOB_MATCH.findMatchingJob(jobs, {
            selectedCity: "Sidney",
            cityTags: ["Toronto"],
            selectedJobTypes: ["FULL_TIME"],
        });

        expect(result.storedTags).toEqual(["Toronto"]);
        expect(result.matchingTags).toEqual(["Toronto", "Sidney"]);
        expect(result.matchedJob).toEqual(expect.objectContaining({ jobId: "JOB-2" }));
    });

    it("matches fallback location fields when city is unavailable", () => {
        const jobs = [
            {
                jobId: "JOB-1",
                city: "Vancouver",
                locationName: "Vancouver Fulfillment Centre",
                jobType: "FULL_TIME",
            },
            {
                jobId: "JOB-2",
                city: "",
                locationName: "Toronto Delivery Station",
                geoClusterDescription: "Greater Toronto Area",
                jobType: "FULL_TIME",
            },
        ];

        const result = globalThis.AMZ_JOB_MATCH.findMatchingJob(jobs, {
            selectedCity: "",
            cityTags: ["Toronto"],
            selectedJobTypes: ["FULL_TIME"],
        });

        expect(result.matchedJob).toEqual(expect.objectContaining({ jobId: "JOB-2" }));
    });

    it("prefers a city match before falling back to location text", () => {
        const jobs = [
            {
                jobId: "JOB-1",
                city: "Vancouver",
                locationName: "Toronto Delivery Station",
                jobType: "FULL_TIME",
            },
            {
                jobId: "JOB-2",
                city: "Toronto",
                locationName: "Toronto Fulfillment Centre",
                jobType: "FULL_TIME",
            },
        ];

        const result = globalThis.AMZ_JOB_MATCH.findMatchingJob(jobs, {
            selectedCity: "",
            cityTags: ["Toronto"],
            selectedJobTypes: ["FULL_TIME"],
        });

        expect(result.matchedJob).toEqual(expect.objectContaining({ jobId: "JOB-2" }));
    });

    it("matches selected job types against localized job type values", () => {
        const jobs = [
            {
                jobId: "JOB-1",
                city: "Toronto",
                jobType: "",
                jobTypeL10N: "Full-time",
            },
        ];

        const result = globalThis.AMZ_JOB_MATCH.findMatchingJob(jobs, {
            selectedCity: "Toronto",
            cityTags: [],
            selectedJobTypes: ["FULL_TIME"],
        });

        expect(result.matchedJob).toEqual(expect.objectContaining({ jobId: "JOB-1" }));
    });

    it("builds compact diagnostics for city and job type rejection debugging", () => {
        const jobs = [
            {
                jobId: "JOB-1",
                city: "Toronto",
                locationName: "YYZ Warehouse",
                jobType: "FULL_TIME",
            },
            {
                jobId: "JOB-2",
                city: "Whitby",
                locationName: "YHM6 Whitby Sortation Centre",
                jobTypeL10N: "Part-time",
            },
            {
                jobId: "JOB-3",
                city: "Calgary",
                locationName: "YYC5 Warehouse",
                jobType: "PART_TIME",
            },
        ];

        const diagnostics = globalThis.AMZ_JOB_MATCH.buildMatchDiagnostics(jobs, {
            selectedCity: "",
            cityTags: ["Whitby"],
            selectedJobTypes: ["PART_TIME"],
            sampleLimit: 2,
        });

        expect(diagnostics.matchingTags).toEqual(["Whitby"]);
        expect(diagnostics.selectedJobTypes).toEqual(["PART_TIME"]);
        expect(diagnostics.counts).toEqual({
            total: 3,
            cityMatched: 1,
            fallbackLocationMatched: 1,
            locationMatched: 1,
            jobTypeMatched: 2,
            matched: 1,
        });
        expect(diagnostics.samples).toHaveLength(2);
        expect(diagnostics.samples[0]).toEqual(expect.objectContaining({
            cityMatched: false,
            jobTypeMatched: false,
            matched: false,
        }));
        expect(diagnostics.samples[1]).toEqual(expect.objectContaining({
            cityMatched: true,
            jobTypeMatched: true,
            matched: true,
        }));
    });

    it("builds compact metadata for background side effects", () => {
        const metadata = globalThis.AMZ_JOB_MATCH.buildLastMatchedJobMetadata(
            { jobId: "JOB-1", city: "Sidney" },
            {
                selectedCity: "Sidney",
                matchingTags: ["Sidney"],
                distance: "150",
                selectedJobTypes: ["FULL_TIME"],
                country: "Canada",
                pageUrl: "https://hiring.amazon.ca/app#/jobSearch",
            }
        );

        expect(metadata).toEqual(expect.objectContaining({
            jobId: "JOB-1",
            city: "Sidney",
            selectedCity: "Sidney",
            cityTags: ["Sidney"],
            distance: "150",
            selectedJobTypes: ["FULL_TIME"],
            country: "Canada",
        }));
        expect(metadata.matchedAt).toEqual(expect.any(String));
    });
});
