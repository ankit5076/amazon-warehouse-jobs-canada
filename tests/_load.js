/**
 * Shared test helper: load an extension source file (which exposes its
 * public API on `globalThis` via an IIFE) and make those globals
 * available to the test environment.
 *
 * The amazon-warehouse-ca shared/* modules are plain MV3 scripts (no ES
 * modules). Each file wraps its body in `(function (root) { ... })(globalThis)`
 * and assigns its public surface to a single `root.AMZ_*` namespace,
 * so we just read the file and run it via indirect eval at the global
 * scope. No source rewriting is needed.
 *
 * If a future shared module ever drops the IIFE pattern and uses bare
 * top-level `const`/`let`, switch to the rewriting strategy used in
 * `us-visa-automation/tests/_load.js`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..", "src");

function installChromeStub() {
    if (!globalThis.chrome) {
        globalThis.chrome = {
            runtime: {
                lastError: null,
                sendMessage: () => {},
                getManifest: () => ({ version: "1.0.0" }),
            },
            tabs: {
                query: (_q, cb) => cb && cb([]),
                sendMessage: () => {},
            },
            storage: {
                onChanged: {
                    addListener: () => {},
                },
                local: {
                    set: (_obj, cb) => {
                        if (typeof cb === "function") cb();
                        return Promise.resolve();
                    },
                    get: (_keys, cb) => {
                        const result = {};
                        if (typeof cb === "function") cb(result);
                        return Promise.resolve(result);
                    },
                    remove: (_keys, cb) => {
                        if (typeof cb === "function") cb();
                        return Promise.resolve();
                    },
                    clear: (cb) => {
                        if (typeof cb === "function") cb();
                        return Promise.resolve();
                    },
                },
                session: {
                    set: (_obj, cb) => {
                        if (typeof cb === "function") cb();
                        return Promise.resolve();
                    },
                    get: (_keys, cb) => {
                        const result = {};
                        if (typeof cb === "function") cb(result);
                        return Promise.resolve(result);
                    },
                    remove: (_keys, cb) => {
                        if (typeof cb === "function") cb();
                        return Promise.resolve();
                    },
                },
            },
        };
    }
    if (!globalThis.fetch) {
        globalThis.fetch = () =>
            Promise.resolve({
                ok: false,
                status: 0,
                json: () => Promise.resolve({}),
            });
    }
}

/**
 * Load one or more shared source files into the current global scope.
 * Files are paths relative to `src/`.
 *
 * @param {string[]} relativePaths - e.g. ["shared/constants.js", "shared/validation.js"]
 */
export function loadSharedScripts(relativePaths) {
    installChromeStub();
    for (const relativePath of relativePaths) {
        const absolutePath = resolve(SRC_ROOT, relativePath);
        const source = readFileSync(absolutePath, "utf8");
        // Indirect eval runs in the global scope; the IIFE assigns its
        // public surface (AMZ_CONSTANTS / AMZ_VALIDATION) to globalThis.
        // eslint-disable-next-line no-eval
        (0, eval)(source);
    }
}

/**
 * Reset a previously-loaded shared module so it can be re-evaluated
 * (useful for validation.js where module-level state — kill switch,
 * expiry — is captured at load time and we want to reload after
 * mutating Date.now()).
 */
export function unloadSharedNamespaces(names) {
    for (const name of names) {
        delete globalThis[name];
    }
}
