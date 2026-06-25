import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadSharedScripts, unloadSharedNamespaces } from "./_load.js";

function tick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushPopup() {
    for (let index = 0; index < 10; index += 1) {
        await tick();
    }
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
            <input id="activate" type="checkbox">
            <input id="use_direct_application" type="checkbox">
            <strong id="direct_application_mode_label"></strong>
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
            <form id="refresh_info"><button id="refresh_btn" type="submit">Refresh</button></form>
            <form id="ais_visa_info"><button id="reset_info" type="submit">Reset</button></form>
            <div class="tag-input-container">
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

describe("local-only popup settings", () => {
    beforeEach(() => {
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
            "AMZ_POPUP_TAGS",
        ]);
        installPopupDom();
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
            "popup/tag-manager.js",
        ]);
        globalThis.chrome.runtime.getManifest = () => ({ version: "9.9.9" });
        globalThis.chrome.tabs.query = vi.fn(() => Promise.resolve([{ id: 123 }]));
        globalThis.chrome.tabs.sendMessage = vi.fn(() => Promise.resolve(true));
    });

    afterEach(() => {
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.Event;
    });

    async function loadPopup(store = {}) {
        const localStore = useLocalStore(store);
        loadSharedScripts(["popup/content.js"]);
        document.dispatchEvent(new Event("DOMContentLoaded"));
        await flushPopup();
        return localStore;
    }

    it("hydrates controls from bundled local defaults without backend modules", async () => {
        await loadPopup();

        expect(globalThis.AMZ_API).toBeUndefined();
        expect(globalThis.AMZ_VALIDATION).toBeUndefined();
        expect(document.getElementById("version").textContent).toContain("9.9.9");
        expect([...document.getElementById("city").options].map(option => option.value))
            .toContain("Toronto");
        expect([...document.getElementById("distance").options].map(option => option.value))
            .toContain("50");
        expect([...document.getElementById("jobType").options].map(option => option.value))
            .toEqual(["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"]);
    });

    it("activates with local all-city settings and notifies the active tab", async () => {
        const { STORAGE_KEYS, MESSAGE_ACTIONS } = globalThis.AMZ_CONSTANTS;
        const store = await loadPopup({
            [STORAGE_KEYS.ALL_CITIES_SELECTED]: true,
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
            [STORAGE_KEYS.FETCH_INTERVAL_UNIT]: "ms",
            [STORAGE_KEYS.FETCH_INTERVAL_VALUE]: "850",
        });

        const activate = document.getElementById("activate");
        activate.checked = true;
        activate.dispatchEvent(new Event("change"));
        await flushPopup();

        expect(store[STORAGE_KEYS.ACTIVE]).toBe(true);
        expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(123, {
            action: MESSAGE_ACTIONS.ACTIVATE,
            status: true,
        });
    });

    it("autosaves direct application mode and job type selections locally", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = await loadPopup({
            [STORAGE_KEYS.ALL_CITIES_SELECTED]: true,
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
        });

        const directMode = document.getElementById("use_direct_application");
        directMode.checked = false;
        directMode.dispatchEvent(new Event("change"));
        document.getElementById("select-all-job-types").click();
        await flushPopup();

        expect(store[STORAGE_KEYS.USE_DIRECT_APPLICATION]).toBe(false);
        expect(store[STORAGE_KEYS.JOB_TYPE]).toEqual(["FULL_TIME", "PART_TIME", "FLEX_TIME", "REDUCED_TIME"]);
        expect(document.getElementById("direct_application_mode_label").textContent).toBe("Manual");
    });

    it("reset keeps the extension local-only and restores all-city defaults", async () => {
        const { STORAGE_KEYS } = globalThis.AMZ_CONSTANTS;
        const store = await loadPopup({
            [STORAGE_KEYS.ACTIVE]: true,
            [STORAGE_KEYS.SELECTED_CITY]: "Toronto",
            [STORAGE_KEYS.ALL_CITIES_SELECTED]: false,
            [STORAGE_KEYS.CITY_TAGS]: ["Toronto"],
        });

        document.getElementById("ais_visa_info").dispatchEvent(new Event("submit"));
        await flushPopup();

        expect(store[STORAGE_KEYS.ACTIVE]).toBe(false);
        expect(store[STORAGE_KEYS.ALL_CITIES_SELECTED]).toBe(true);
        expect(store[STORAGE_KEYS.CITY_TAGS]).toContain("Toronto");
        expect(store[STORAGE_KEYS.OPERATOR_USERNAME]).toBe("");
        expect(store[STORAGE_KEYS.SELECTED_CLIENT_ID]).toBe("");
    });
});
