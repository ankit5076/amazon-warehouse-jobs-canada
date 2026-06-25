import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function loadModeHelper(useDirectApplication = true) {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_APPLICATION_MODE"]);
    loadSharedScripts(["shared/constants.js"]);
    const constants = globalThis.AMZ_CONSTANTS;
    globalThis.AMZ_CONSTANTS = Object.freeze({
        ...constants,
        DIRECT_APPLICATION: Object.freeze({
            ...constants.DIRECT_APPLICATION,
            useDirectApplication,
        }),
    });
    loadSharedScripts(["content/utils/direct-application-mode.js"]);
}

describe("AMZ_DIRECT_APPLICATION_MODE", () => {
    beforeEach(() => {
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_DIRECT_APPLICATION_MODE"]);
    });

    it("normalizes missing stored values to the configured default", () => {
        loadModeHelper(false);

        expect(globalThis.AMZ_DIRECT_APPLICATION_MODE.normalize(undefined)).toBe(false);
        expect(globalThis.AMZ_DIRECT_APPLICATION_MODE.label(false)).toBe("manual");
    });

    it("creates isolated mode controllers with shared logging semantics", () => {
        loadModeHelper(true);
        const log = { debug: vi.fn() };
        const first = globalThis.AMZ_DIRECT_APPLICATION_MODE.create({ log });
        const second = globalThis.AMZ_DIRECT_APPLICATION_MODE.create({ log, initialEnabled: false });

        expect(first.isEnabled()).toBe(true);
        expect(second.isEnabled()).toBe(false);

        first.setEnabled(false);
        second.setEnabled(true);

        expect(first.mode()).toBe("manual");
        expect(second.mode()).toBe("automated");
        expect(log.debug).toHaveBeenCalledTimes(2);
    });
});
