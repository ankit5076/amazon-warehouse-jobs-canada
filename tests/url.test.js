import { beforeEach, describe, expect, it } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reloadUrl() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_URL"]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/url.js",
    ]);
}

describe("AMZ_URL", () => {
    beforeEach(() => {
        reloadUrl();
    });

    it("recognizes app hash routes when Amazon inserts query params before the hash", () => {
        expect(globalThis.AMZ_URL.isJobSearchPage(
            "https://hiring.amazon.ca/app?country=ca&locale=en-CA#/jobSearch"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isJobSearchPage(
            "https://hiring.amazon.com/app?country=us&locale=en-US#/jobSearch"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isJobDetailPage(
            "https://hiring.amazon.ca/app?country=ca&locale=en-CA#/jobDetail?jobId=JOB-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isJobDetailPage(
            "https://hiring.amazon.com/app?country=us&locale=en-US#/jobDetail?jobId=JOB-1"
        )).toBe(true);
    });

    it("parses application resume context", () => {
        expect(globalThis.AMZ_URL.isApplicationPage(
            "https://hiring.amazon.ca/application/?applicationId=app-1&jobId=JOB-1&page=resume-application"
        )).toBe(true);
        expect(globalThis.AMZ_URL.getApplicationContextFromUrl(
            "https://hiring.amazon.ca/application/?applicationId=app-1&jobId=JOB-1&page=resume-application"
        )).toEqual(expect.objectContaining({
            applicationId: "app-1",
            jobId: "JOB-1",
            page: "resume-application",
            scheduleId: null,
        }));
    });

    it("recognizes country-scoped application pages for booking-started notifications", () => {
        expect(globalThis.AMZ_URL.isCountryApplicationPage(
            "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&scheduleId=SCH-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isCountryApplicationPage(
            "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isCountryApplicationPage(
            "https://hiring.amazon.com/application/?jobId=JOB-1&page=pre-consent&scheduleId=SCH-1&token=secret"
        )).toBe(false);
    });

    it("treats country-scoped application form routes as observability-only pages", () => {
        expect(globalThis.AMZ_URL.isApplicationFormPage(
            "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&scheduleId=SCH-1#/general-questions?applicationId=app-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isApplicationFormPage(
            "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&scheduleId=SCH-1#/self-identification?applicationId=app-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isApplicationFormPage(
            "https://hiring.amazon.com/application/?jobId=JOB-1&page=pre-consent&scheduleId=SCH-1&country=us"
        )).toBe(false);
        expect(globalThis.AMZ_URL.isApplicationFormPage(
            "https://hiring.amazon.com/application/?jobId=JOB-1&scheduleId=SCH-1&country=us#/consent?applicationId=app-1&scheduleId=SCH-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isApplicationFormPage(
            "https://hiring.amazon.ca/application/ca/?applicationId=app-1&jobId=JOB-1"
        )).toBe(false);
        expect(globalThis.AMZ_URL.isFinalApplicationFormPage(
            "https://hiring.amazon.ca/application/ca/?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1#/general-questions?applicationId=app-1&country=ca&jobId=JOB-1&locale=en-CA&scheduleId=SCH-1"
        )).toBe(true);
        expect(globalThis.AMZ_URL.isFinalApplicationFormPage(
            "https://hiring.amazon.com/application/?jobId=JOB-1&scheduleId=SCH-1&country=us#/consent?applicationId=app-1&scheduleId=SCH-1"
        )).toBe(false);
        expect(globalThis.AMZ_URL.getApplicationRouteName(
            "https://hiring.amazon.com/application/us/?jobId=JOB-1#/general-questions?applicationId=app-1"
        )).toBe("general-questions");
    });

    it("sanitizes sensitive application URL params before notification output", () => {
        const sanitized = globalThis.AMZ_URL.sanitizeNotificationUrl(
            "https://hiring.amazon.com/application/us/?country=us&jobId=JOB-1&locale=en-US&scheduleId=SCH-1&token=secret#/general-questions?country=us&jobId=JOB-1&scheduleId=SCH-1&applicationId=app-1"
        );

        expect(sanitized).toContain("jobId=JOB-1");
        expect(sanitized).toContain("scheduleId=SCH-1");
        expect(sanitized).not.toContain("token=");
        expect(sanitized).not.toContain("applicationId=");
    });

    it("builds the active country job detail URL from constants", () => {
        const { AMAZON } = globalThis.AMZ_CONSTANTS;
        expect(globalThis.AMZ_URL.buildJobDetailUrl("JOB-1")).toBe(
            `https://${AMAZON.COUNTRY_CONFIG.domain}/app#/jobDetail?jobId=JOB-1&locale=${AMAZON.COUNTRY_CONFIG.locale}`
        );
    });

    it("builds the official early pre-consent application URL with a selected schedule", () => {
        const { AMAZON } = globalThis.AMZ_CONSTANTS;
        expect(globalThis.AMZ_URL.buildApplicationPreConsentUrl("JOB-1", "SCH-1")).toBe(
            `https://${AMAZON.COUNTRY_CONFIG.domain}/application/?jobId=JOB-1&page=pre-consent&scheduleId=SCH-1&locale=${AMAZON.COUNTRY_CONFIG.locale}&country=${AMAZON.COUNTRY_CONFIG.applicationCountryPath}`
        );
    });
});
