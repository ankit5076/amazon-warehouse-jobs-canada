import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_LOGGER", "AMZ_MESSAGING"]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/logger.js",
        "shared/utils/messaging.js",
    ]);
    globalThis.chrome.runtime.lastError = null;
}

describe("AMZ_MESSAGING", () => {
    beforeEach(() => {
        reload();
    });

    it("normalizes runtime messages into ok/data responses", async () => {
        globalThis.chrome.runtime.sendMessage = vi.fn((message, callback) => {
            callback({ ok: true, value: message.value });
        });

        await expect(
            globalThis.AMZ_MESSAGING.sendRuntimeMessage({ value: 42 })
        ).resolves.toEqual({
            ok: true,
            data: { ok: true, value: 42 },
        });
    });

    it("turns chrome runtime lastError into a safe error response", async () => {
        globalThis.chrome.runtime.sendMessage = vi.fn((_message, callback) => {
            globalThis.chrome.runtime.lastError = { message: "receiving end does not exist" };
            callback();
            globalThis.chrome.runtime.lastError = null;
        });

        await expect(
            globalThis.AMZ_MESSAGING.sendRuntimeMessage({ action: "missing" })
        ).resolves.toEqual({
            ok: false,
            error: "receiving end does not exist",
        });
    });

    it("swallows failed tab messages for service-worker tab sync", async () => {
        globalThis.chrome.tabs.sendMessage = vi.fn((_tabId, _message, callback) => {
            globalThis.chrome.runtime.lastError = { message: "tab has no listener" };
            callback();
            globalThis.chrome.runtime.lastError = null;
        });

        await expect(
            globalThis.AMZ_MESSAGING.sendTabMessage(123, { action: "state" })
        ).resolves.toEqual({
            ok: false,
            error: "tab has no listener",
        });
    });
});
