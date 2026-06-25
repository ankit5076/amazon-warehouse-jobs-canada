import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

const nativeConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
};

let spies;
let storageStore;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getStorageResult(keys) {
    if (Array.isArray(keys)) {
        return keys.reduce((result, key) => {
            if (Object.prototype.hasOwnProperty.call(storageStore, key)) {
                result[key] = clone(storageStore[key]);
            }
            return result;
        }, {});
    }
    if (typeof keys === "string") {
        return Object.prototype.hasOwnProperty.call(storageStore, keys)
            ? { [keys]: clone(storageStore[keys]) }
            : {};
    }
    if (keys && typeof keys === "object") {
        return Object.entries(keys).reduce((result, [key, fallback]) => {
            result[key] = Object.prototype.hasOwnProperty.call(storageStore, key)
                ? clone(storageStore[key])
                : fallback;
            return result;
        }, {});
    }
    return clone(storageStore);
}

function installLoggerStorage(initial = {}) {
    storageStore = clone(initial);
    globalThis.chrome = {
        runtime: {
            lastError: null,
            getManifest: () => ({ version: "1.0.0" }),
        },
        storage: {
            onChanged: {
                addListener: vi.fn(),
            },
            local: {
                get: vi.fn((keys, cb) => {
                    const result = getStorageResult(keys);
                    if (typeof cb === "function") cb(result);
                    return Promise.resolve(result);
                }),
                set: vi.fn((values, cb) => {
                    Object.assign(storageStore, clone(values || {}));
                    if (typeof cb === "function") cb();
                    return Promise.resolve();
                }),
                remove: vi.fn((keys, cb) => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(key => delete storageStore[key]);
                    if (typeof cb === "function") cb();
                    return Promise.resolve();
                }),
            },
        },
    };
}

function reloadLogger({ initialStorage = {} } = {}) {
    unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_TEXT", "AMZ_LOGGER"]);
    installLoggerStorage(initialStorage);
    spies = {
        log: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    console.log = spies.log;
    console.info = spies.info;
    console.debug = spies.debug;
    console.warn = spies.warn;
    console.error = spies.error;

    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/text.js",
        "shared/utils/logger.js",
    ]);
}

function resetSpies() {
    Object.values(spies).forEach(spy => spy.mockClear());
}

function sourceFiles(rootDir) {
    return readdirSync(rootDir).flatMap(name => {
        const filePath = resolve(rootDir, name);
        const stat = statSync(filePath);
        if (stat.isDirectory()) return sourceFiles(filePath);
        return name.endsWith(".js") ? [filePath] : [];
    });
}

describe("AMZ_LOGGER", () => {
    beforeEach(() => {
        reloadLogger();
    });

    afterEach(() => {
        console.log = nativeConsole.log;
        console.info = nativeConsole.info;
        console.debug = nativeConsole.debug;
        console.warn = nativeConsole.warn;
        console.error = nativeConsole.error;
        delete globalThis.chrome;
        unloadSharedNamespaces(["AMZ_CONSTANTS", "AMZ_TEXT", "AMZ_LOGGER"]);
    });

    it("defaults to standard mode and emits only lifecycle levels", () => {
        const log = globalThis.AMZ_LOGGER.create("[amazon-shift][fetch]");

        log("job found", { jobId: "JOB-1" });
        log.info("settings loaded", { active: true });
        log.warn("session unauthorized", { httpStatus: 401 });
        log.error("booking failed", { errorCode: "NO_APPLY" });
        log.debug("mutation scan", { count: 4 });
        log.trace("poll loop", { tick: 1 });

        expect(globalThis.AMZ_LOGGER.getMode()).toBe("standard");
        expect(spies.log).toHaveBeenCalledWith('[amazon-shift][fetch] job found {"jobId":"JOB-1"}');
        expect(spies.info).toHaveBeenCalledWith('[amazon-shift][fetch] settings loaded {"active":true}');
        expect(spies.warn).toHaveBeenCalledWith('[amazon-shift][fetch] session unauthorized {"httpStatus":401}');
        expect(spies.error).toHaveBeenCalledWith('[amazon-shift][fetch] booking failed {"errorCode":"NO_APPLY"}');
        expect(spies.debug).not.toHaveBeenCalled();
    });

    it("loads stored debug mode from chrome storage", () => {
        reloadLogger({ initialStorage: { logMode: "debug" } });
        const log = globalThis.AMZ_LOGGER.create("[direct-application]");

        log.debug("api request");

        expect(globalThis.AMZ_LOGGER.getMode()).toBe("debug");
        expect(spies.debug).toHaveBeenCalledWith("[direct-application] api request");
    });

    it("debug mode emits all logger levels", () => {
        globalThis.AMZ_LOGGER.setMode("debug");
        const log = globalThis.AMZ_LOGGER.create("[direct-application]");

        log("started");
        log.info("captcha required");
        log.warn("waf token unavailable");
        log.error("failed");
        log.debug("api request");
        log.trace("observer scan");

        expect(spies.log).toHaveBeenCalledWith("[direct-application] started");
        expect(spies.info).toHaveBeenCalledWith("[direct-application] captcha required");
        expect(spies.warn).toHaveBeenCalledWith("[direct-application] waf token unavailable");
        expect(spies.error).toHaveBeenCalledWith("[direct-application] failed");
        expect(spies.debug).toHaveBeenCalledWith("[direct-application] api request");
        expect(spies.debug).toHaveBeenCalledWith("[direct-application] observer scan");
    });

    it("off mode suppresses extension-authored logger output", () => {
        globalThis.AMZ_LOGGER.setMode("off");
        const log = globalThis.AMZ_LOGGER.create("[amazon-shift][fetch]");

        log("job found");
        log.info("settings loaded");
        log.warn("session unauthorized");
        log.error("booking failed");
        log.debug("mutation scan");
        log.trace("poll loop");

        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.warn).not.toHaveBeenCalled();
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
    });

    it("prints structured details as a single JSON log line", () => {
        const log = globalThis.AMZ_LOGGER.create("[amazon-shift][fetch]");

        log("jobs fetched", { jobCount: 1, ids: ["JOB-1"] });

        expect(spies.log).toHaveBeenCalledWith(
            '[amazon-shift][fetch] jobs fetched {"jobCount":1,"ids":["JOB-1"]}'
        );
        expect(spies.log.mock.calls[0]).toHaveLength(1);
    });

    it("adds workflow and source file labels to registered logger prefixes", () => {
        const log = globalThis.AMZ_LOGGER.create("[amazon-shift][fetch]", {
            workflow: "job-search",
            source: "content/fetch.js",
        });

        log.info("runtime settings loaded", { active: true });

        expect(spies.info).toHaveBeenCalledWith(
            '[amazon-shift][workflow:job-search][file:content/fetch.js][scope:fetch] runtime settings loaded {"active":true}'
        );
    });

    it("keeps direct console object calls copyable in debug mode", () => {
        globalThis.AMZ_LOGGER.setMode("debug");

        console.log("[amazon-shift][fetch]", "jobs fetched", {
            jobCount: 1,
            isAuthError: false,
        });

        expect(spies.log).toHaveBeenCalledWith(
            '[amazon-shift][fetch] jobs fetched {"jobCount":1,"isAuthError":false}'
        );
        expect(spies.log.mock.calls[0]).toHaveLength(1);
    });

    it("keeps standard direct console visibility limited to warnings and errors", () => {
        resetSpies();

        console.log("[direct]", { visible: true });
        console.info("[direct-info]", "hidden");
        console.debug("[direct-debug]", "hidden");
        console.warn("[important]", { detail: true });
        console.error("[important]", { failed: true });

        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
        expect(spies.warn).toHaveBeenCalledWith('[important] {"detail":true}');
        expect(spies.error).toHaveBeenCalledWith('[important] {"failed":true}');
    });

    it("redacts sensitive keys and keeps circular values readable", () => {
        const circular = { visible: true };
        circular.self = circular;

        globalThis.AMZ_LOGGER.info("[amazon-shift][api]", "payload", {
            authorization: "Bearer secret",
            nested: {
                password: "hunter2",
                publicValue: "ok",
            },
            circular,
        });

        const line = spies.info.mock.calls[0][0];
        expect(line).toContain('"authorization":"[REDACTED]"');
        expect(line).toContain('"password":"[REDACTED]"');
        expect(line).toContain('"publicValue":"ok"');
        expect(line).toContain('"self":"[Circular]"');
        expect(line).not.toContain("Bearer secret");
        expect(line).not.toContain("hunter2");
    });

    it("serializes errors with useful fields", () => {
        const error = new Error("Request failed");
        error.httpStatus = 500;
        error.sessionToken = "secret";

        const log = globalThis.AMZ_LOGGER.create("[direct-application]");
        log.error("failed", error);

        const line = spies.error.mock.calls[0][0];
        expect(line).toContain('"name":"Error"');
        expect(line).toContain('"message":"Request failed"');
        expect(line).toContain('"httpStatus":500');
        expect(line).toContain('"sessionToken":"[REDACTED]"');
        expect(line).not.toContain("secret");
    });

    it("throttles repeated high-frequency debug logs by key", () => {
        globalThis.AMZ_LOGGER.setMode("debug");
        const log = globalThis.AMZ_LOGGER.create("[amazon-shift][schedule-automation]");

        log.debug("scan", { count: 1 }, { throttleKey: "scan", throttleMs: 5000 });
        log.debug("scan", { count: 2 }, { throttleKey: "scan", throttleMs: 5000 });
        log.debug("scan", { count: 3 }, { throttleKey: "other-scan", throttleMs: 5000 });

        expect(spies.debug).toHaveBeenCalledTimes(2);
        expect(spies.debug).toHaveBeenCalledWith(
            '[amazon-shift][schedule-automation] scan {"count":1}'
        );
        expect(spies.debug).toHaveBeenCalledWith(
            '[amazon-shift][schedule-automation] scan {"count":3}'
        );
    });

    it("suppresses debug and trace raw console calls in standard mode", () => {
        resetSpies();

        console.log("[debug-only]", { detail: true });
        console.info("[debug-only]", { detail: true });
        console.debug("[debug-only]", { detail: true });
        console.warn("[important]", { detail: true });
        console.error("[important]", { detail: true });

        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
        expect(spies.warn).toHaveBeenCalledOnce();
        expect(spies.error).toHaveBeenCalledOnce();
    });

    it("keeps extension source files off raw console calls outside the logger and vendor files", () => {
        const srcRoot = resolve(process.cwd(), "src");
        const allowed = new Set(["shared/utils/logger.js"]);
        const offenders = sourceFiles(srcRoot).flatMap(filePath => {
            const relativePath = relative(srcRoot, filePath).replaceAll("\\", "/");
            if (allowed.has(relativePath) || relativePath.startsWith("vendor/")) return [];

            const source = readFileSync(filePath, "utf8");
            const matches = [...source.matchAll(/console\.(log|info|debug|warn|error)\s*\(/g)];
            return matches.map(match => `${relativePath}:${match.index}`);
        });

        expect(offenders).toEqual([]);
    });
});
