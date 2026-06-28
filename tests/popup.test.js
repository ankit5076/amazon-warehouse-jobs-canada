import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function tick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushPopup() {
    for (let index = 0; index < 20; index += 1) await tick();
}

function installPopupDom() {
    const dom = new JSDOM(`<!doctype html>
        <html>
          <body>
            <span id="version"></span>
            <select id="log_mode">
              <option value="standard">Standard</option>
              <option value="debug">Debug</option>
              <option value="off">Off</option>
            </select>
            <div class="toggle-section">
              <input id="activate" type="checkbox">
            </div>
            <input id="use_direct_application" type="checkbox">
            <strong id="direct_application_mode_label"></strong>
            <div class="access-actions">
              <button id="checkout_btn" data-plan="access" type="button">Get 30 days</button>
              <button id="checkout_pro_btn" data-plan="pro" type="button">Go Pro</button>
              <small id="license-status"></small>
            </div>
            <div class="dropdowns-container" data-authenticated-section>
              <div class="field"><select id="city"></select></div>
              <div class="field"><select id="distance"></select></div>
              <select id="jobType" multiple></select>
              <input id="fetch_interval_value" type="number">
              <select id="fetch_interval_unit">
                <option value="ms">Milliseconds</option>
                <option value="s">Seconds</option>
              </select>
              <button id="add-all-cities" type="button"></button>
              <button id="select-all-job-types" type="button"></button>
            </div>
            <form id="refresh_info" data-authenticated-section><button id="refresh_btn" type="submit"></button></form>
            <form id="ais_visa_info" data-authenticated-section><button id="reset_info" type="submit"></button></form>
            <div class="tag-input-container" data-authenticated-section>
              <span id="city-scope-status"></span>
              <div id="tag-input-box"><input id="city-input"></div>
            </div>
            <button id="clear-all" type="button"></button>
          </body>
        </html>`, {
        url: "chrome-extension://test/popup/index.html",
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    return dom;
}

function useLocalStore(initial = {}) {
    const store = { ...initial };
    globalThis.chrome.storage.local.get = vi.fn((keys, cb) => {
        let result = {};
        if (Array.isArray(keys)) {
            keys.forEach(key => {
                if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
            });
        } else if (typeof keys === "string") {
            if (Object.prototype.hasOwnProperty.call(store, keys)) result[keys] = store[keys];
        } else if (keys && typeof keys === "object") {
            Object.keys(keys).forEach(key => {
                result[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : keys[key];
            });
        } else {
            result = { ...store };
        }
        if (typeof cb === "function") cb(result);
        return Promise.resolve(result);
    });
    globalThis.chrome.storage.local.set = vi.fn((values, cb) => {
        Object.assign(store, values);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    globalThis.chrome.storage.local.remove = vi.fn((keys, cb) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    globalThis.chrome.storage.local.clear = vi.fn(cb => {
        Object.keys(store).forEach(key => delete store[key]);
        if (typeof cb === "function") cb();
        return Promise.resolve();
    });
    return store;
}

function loadPopupScripts() {
    unloadSharedNamespaces([
        "AMZ_CONSTANTS",
        "AMZ_LOGGER",
        "AMZ_TEXT",
        "AMZ_STORAGE",
        "AMZ_ACCOUNT",
        "AMZ_CITY_TAGS",
        "AMZ_INTERVALS",
        "AMZ_RUNTIME_CONTROLS",
        "AMZ_STATE",
        "AMZ_MESSAGING",
        "AMZ_LICENSE_API",
        "AMZ_LICENSE_STATE",
        "AMZ_PAYMENT_GATE",
        "AMZ_API",
        "AMZ_VALIDATION",
        "AMZ_POPUP_TAGS",
    ]);
    loadSharedScripts([
        "shared/constants.js",
        "shared/utils/logger.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/account.js",
        "shared/utils/city-tags.js",
        "shared/utils/intervals.js",
        "shared/utils/runtime-controls.js",
        "shared/utils/state-store.js",
        "shared/utils/messaging.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
        "shared/api-client.js",
        "shared/validation.js",
        "popup/tag-manager.js",
        "popup/content.js",
    ]);
}

describe("paid popup gate", () => {
    beforeEach(() => {
        installPopupDom();
        if (!globalThis.chrome) {
            globalThis.chrome = {
                runtime: {
                    lastError: null,
                    sendMessage: () => {},
                    getManifest: () => ({ version: "1.0.0" }),
                },
                tabs: {},
                storage: {
                    onChanged: { addListener: () => {} },
                    local: {},
                    session: {},
                },
            };
        }
        globalThis.chrome.tabs ||= {};
        globalThis.chrome.storage ||= {};
        globalThis.chrome.storage.onChanged ||= { addListener: () => {} };
        globalThis.chrome.storage.local ||= {};
        globalThis.chrome.tabs.query = vi.fn(() => Promise.resolve([]));
        globalThis.chrome.storage.onChanged.addListener = vi.fn();
        globalThis.fetch = vi.fn(url =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(String(url).includes("/license/plans")
                    ? { plans: { access: true, pro: true } }
                    : { allowed: false, isProUser: false }),
            })
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.Event;
    });

    it("shows booking controls first and keeps email fields out of the landing markup", () => {
        const html = readFileSync(resolve("src", "popup", "index.html"), "utf8");
        expect(html).toContain("checkout_btn");
        expect(html).toContain("checkout_pro_btn");
        expect(html).toContain("$50");
        expect(html).toContain("$120");
        expect(html).toContain("id=\"city\"");
        expect(html).toContain("id=\"distance\"");
        expect(html).not.toContain("buyer_email");
        expect(html).not.toContain("extension_username");
        expect(html).not.toContain("admin_login_btn");
    });

    it("enables activation with search scope even before a valid paid license", async () => {
        loadPopupScripts();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        useLocalStore({
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.CITY_TAGS]: ["Sidney"],
        });
        document.dispatchEvent(new Event("DOMContentLoaded"));
        await flushPopup();

        expect(document.getElementById("activate").disabled).toBe(false);
        expect(document.getElementById("license-status").textContent).toMatch(/Search is free/);
    });

    it("enables activation after license validation and search scope are valid", async () => {
        loadPopupScripts();
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = useLocalStore({
            [STORAGE_KEYS.LICENSE_BUYER_EMAIL]: "buyer@example.com",
            [STORAGE_KEYS.LICENSE_AMAZON_EMAIL]: "amazon@example.com",
            [STORAGE_KEYS.SELECTED_CITY]: "Sidney",
            [STORAGE_KEYS.CITY_TAGS]: ["Sidney"],
        });
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ allowed: true, isProUser: false, syncIntervalMs: 60000 }),
            })
        );

        document.dispatchEvent(new Event("DOMContentLoaded"));
        await flushPopup();

        expect(document.getElementById("activate").disabled).toBe(false);
        document.getElementById("activate").checked = true;
        document.getElementById("activate").dispatchEvent(new Event("change", { bubbles: true }));
        await flushPopup();

        expect(store[STORAGE_KEYS.ACTIVE]).toBe(true);
    });

    it("opens hosted checkout pages without collecting emails in the popup", async () => {
        loadPopupScripts();
        useLocalStore();
        const openSpy = vi.spyOn(globalThis.window, "open").mockImplementation(() => null);
        globalThis.fetch = vi.fn((url, init) => {
            if (String(url).includes("/license/plans")) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ plans: { access: true, pro: true } }),
                });
            }
            const body = JSON.parse(init?.body || "{}");
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    allowed: false,
                    isProUser: false,
                    checkoutUrl: body.purchaseType === "pro"
                        ? "https://checkout.dodo/pro"
                        : "https://checkout.dodo/access",
                }),
            });
        });

        document.dispatchEvent(new Event("DOMContentLoaded"));
        await flushPopup();
        document.getElementById("checkout_btn").click();
        await flushPopup();
        document.getElementById("checkout_pro_btn").click();
        await flushPopup();

        expect(document.getElementById("checkout-buyer-email")).toBeNull();
        expect(document.getElementById("checkout-amazon-email")).toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "https://getslotnow.com/extension-usage-tracker/api/amazon-warehouse-jobs-canada/license/checkout",
            expect.objectContaining({ method: "POST" })
        );
        expect(openSpy).toHaveBeenNthCalledWith(
            1,
            "https://checkout.dodo/access",
            "_blank",
            "noopener,noreferrer"
        );
        expect(openSpy).toHaveBeenNthCalledWith(
            2,
            "https://checkout.dodo/pro",
            "_blank",
            "noopener,noreferrer"
        );
    });
});
