import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function loadGuard() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_GUARD"]);
    loadSharedScripts([
        "shared/constants.js",
        "content/utils/direct-application-guard.js",
    ]);
}

describe("AMZ_DIRECT_GUARD", () => {
    beforeEach(() => {
        const dom = new JSDOM("<!doctype html><html><body></body></html>", {
            url: "https://hiring.amazon.ca/application/ca/?jobId=JOB-1",
        });
        globalThis.window = dom.window;
        globalThis.sessionStorage = dom.window.sessionStorage;
        loadGuard();
    });

    afterEach(() => {
        delete globalThis.window;
        delete globalThis.sessionStorage;
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_GUARD"]);
    });

    it("finds a guard for the same job when the current URL no longer has a schedule id", () => {
        const { DIRECT_APPLICATION } = globalThis.AMZ_CONSTANTS;
        const guard = globalThis.AMZ_DIRECT_GUARD.create({
            prefix: DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
        });

        sessionStorage.setItem(
            [
                DIRECT_APPLICATION.GUARD_STORAGE_PREFIX,
                "JOB-1",
                "SCH-1",
            ].join("::"),
            JSON.stringify({
                stage: DIRECT_APPLICATION.STAGES.APPLICATION_CREATED_WAITING_FOR_CONFIRM,
                applicationId: "APP-1",
            })
        );

        const found = guard.readForJob({ jobId: "JOB-1", scheduleId: "" });

        expect(found.applicationId).toBe("APP-1");
        expect(guard.suppressesUiFallback(found)).toBe(true);
    });
});
