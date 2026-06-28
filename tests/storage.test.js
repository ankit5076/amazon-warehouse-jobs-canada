import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function loadStorage() {
    unloadSharedNamespaces(["AMZ_STORAGE"]);
    loadSharedScripts(["shared/utils/storage.js"]);
}

describe("AMZ_STORAGE", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        delete globalThis.chrome;
        loadStorage();
    });

    it("filters optional undefined keys before reading local storage", async () => {
        globalThis.chrome.storage.local.get = vi.fn(() => Promise.resolve({}));

        await globalThis.AMZ_STORAGE.getLocal(["licenseEmail", undefined, "", "userEmail"]);

        expect(globalThis.chrome.storage.local.get).toHaveBeenCalledWith(["licenseEmail", "userEmail"]);
    });
});
