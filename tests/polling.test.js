import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function reload() {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_POLLING"]);
    loadSharedScripts([
        "shared/constants.js",
        "content/utils/polling.js",
    ]);
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    reload();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("AMZ_POLLING", () => {
    it("adds configured jitter to scheduled poll delays", async () => {
        const run = vi.fn(() => Promise.resolve());
        const poller = globalThis.AMZ_POLLING.createSingleFlightPoller({
            run,
            canRun: () => true,
            getDelayMs: () => 850,
        });

        poller.start();
        await flushMicrotasks();
        expect(run).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1049);
        expect(run).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("uses the configured maximum jitter boundary", async () => {
        Math.random.mockReturnValue(0.999);
        const run = vi.fn(() => Promise.resolve());
        const poller = globalThis.AMZ_POLLING.createSingleFlightPoller({
            run,
            canRun: () => true,
            getDelayMs: () => 850,
        });

        poller.start();
        await flushMicrotasks();
        expect(run).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1649);
        expect(run).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(run).toHaveBeenCalledTimes(2);
    });
});
