import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function tick() {
    return new Promise(resolve => setTimeout(resolve, 10));
}

async function waitForMessage(messages, predicate) {
    for (let index = 0; index < 50; index += 1) {
        const match = messages.find(predicate);
        if (match) return match;
        await tick();
    }
    throw new Error("Timed out waiting for bridge message");
}

describe("direct WAF page bridge", () => {
    afterEach(() => {
        if (globalThis.window?.close) globalThis.window.close();
        delete globalThis.window;
        delete globalThis.document;
        vi.restoreAllMocks();
    });

    it("shows a fallback verification panel when the CAPTCHA SDK cannot load", async () => {
        const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
            url: "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1",
            pretendToBeVisual: true,
            runScripts: "outside-only",
        });
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;

        const messages = [];
        window.addEventListener("message", event => {
            messages.push(event.data);
        });

        const source = readFileSync(resolve(
            process.cwd(),
            "src/content/utils/direct-waf-bridge-page.js"
        ), "utf8");
        window.eval(source);
        await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_BRIDGE_READY" &&
            message?.ok === true
        );
        window.dispatchEvent(new window.MessageEvent("message", {
            source: window,
            data: {
                type: "AMZ_DIRECT_WAF_CAPTCHA_REQUEST",
                requestId: "captcha-test",
                sdkUrl: "",
                apiKey: "test-api-key",
                domWaitMs: 0,
            },
        }));

        const result = await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_CAPTCHA_RESULT"
        );

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            reason: "captcha-sdk-unavailable",
        }));
        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "AMZ_DIRECT_WAF_CAPTCHA_STATUS",
                requestId: "captcha-test",
                stage: "render-requested",
            }),
            expect.objectContaining({
                type: "AMZ_DIRECT_WAF_CAPTCHA_STATUS",
                requestId: "captcha-test",
                stage: "render-failed",
            }),
        ]));

        const overlay = document.getElementById("__amzDirectCaptchaOverlay");
        expect(overlay).toBeTruthy();
        expect(overlay.style.display).toBe("flex");
        expect(overlay.textContent).toContain("Human verification could not load");
    });

    it("acknowledges readiness probes after the page bridge is loaded", async () => {
        const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
            url: "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1",
            pretendToBeVisual: true,
            runScripts: "outside-only",
        });
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;

        const messages = [];
        window.addEventListener("message", event => {
            messages.push(event.data);
        });

        const source = readFileSync(resolve(
            process.cwd(),
            "src/content/utils/direct-waf-bridge-page.js"
        ), "utf8");
        window.eval(source);
        await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_BRIDGE_READY" &&
            message?.alreadyReady === false
        );

        window.dispatchEvent(new window.MessageEvent("message", {
            source: window,
            data: {
                type: "AMZ_DIRECT_WAF_BRIDGE_PING",
                requestId: "ready-test",
            },
        }));

        const ready = await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_BRIDGE_READY" &&
            message?.requestId === "ready-test"
        );

        expect(ready).toEqual(expect.objectContaining({
            ok: true,
            alreadyReady: true,
            requestId: "ready-test",
        }));
    });

    it("loads the WAF SDK before serving token requests", async () => {
        const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
            url: "https://hiring.amazon.ca/application/ca/?country=ca&jobId=JOB-1&scheduleId=SCH-1",
            pretendToBeVisual: true,
            runScripts: "outside-only",
        });
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;

        const messages = [];
        window.addEventListener("message", event => {
            messages.push(event.data);
        });

        const appendOriginal = document.head.appendChild.bind(document.head);
        const appendSpy = vi.spyOn(document.head, "appendChild").mockImplementation(element => {
            if (element?.dataset?.amzDirectCaptchaSdk === "true") {
                setTimeout(() => {
                    window.AwsWafIntegration = {
                        getToken: vi.fn(async () => "token-1"),
                    };
                    element.onload?.();
                }, 0);
            }
            return appendOriginal(element);
        });

        const source = readFileSync(resolve(
            process.cwd(),
            "src/content/utils/direct-waf-bridge-page.js"
        ), "utf8");
        window.eval(source);
        await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_BRIDGE_READY" &&
            message?.alreadyReady === false
        );

        window.dispatchEvent(new window.MessageEvent("message", {
            source: window,
            data: {
                type: "AMZ_DIRECT_WAF_TOKEN_REQUEST",
                requestId: "token-test",
                sdkUrl: "https://captcha.example.test/jsapi.js",
                sdkLoadTimeoutMs: 100,
                waitMs: 100,
            },
        }));

        const result = await waitForMessage(messages, message =>
            message?.type === "AMZ_DIRECT_WAF_TOKEN_RESULT" &&
            message?.requestId === "token-test"
        );

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            reason: "waf-token-ready",
            method: "getToken",
        }));
        expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({
            src: "https://captcha.example.test/jsapi.js",
        }));
        expect(window.AwsWafIntegration.getToken).toHaveBeenCalled();
    });
});
