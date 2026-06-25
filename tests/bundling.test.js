import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = resolve(ROOT, "dist", "amazon-shifts");

function contextBody(buildScript, name) {
    const match = buildScript.match(new RegExp(`${name}: Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\),`));
    expect(match, `${name} context should exist`).not.toBeNull();
    return match?.[1] || "";
}

describe("production bundling", () => {
    it("keeps application observability local and excludes external service modules", () => {
        const buildScript = readFileSync(resolve(ROOT, "scripts", "build.js"), "utf8");
        const applicationContent = contextBody(buildScript, "APPLICATION_CONTENT");
        const mainContent = contextBody(buildScript, "MAIN_CONTENT");
        const backgroundDeps = contextBody(buildScript, "BACKGROUND_DEPS");

        expect(applicationContent).toContain('"content/utils/application-observability.js"');
        expect(applicationContent).toContain('"content/utils/direct-application-mode.js"');
        expect(applicationContent.indexOf('"content/utils/application-observability.js"'))
            .toBeLessThan(applicationContent.indexOf('"content/utils/direct-application.js"'));
        expect(applicationContent.indexOf('"content/utils/direct-application-mode.js"'))
            .toBeLessThan(applicationContent.indexOf('"content/utils/direct-application.js"'));

        expect(mainContent).toContain('"content/utils/application-observability.js"');
        expect(mainContent).not.toContain('"shared/job-found-channel.js"');
        expect(mainContent.indexOf('"content/utils/application-observability.js"'))
            .toBeLessThan(mainContent.indexOf('"content/fetch.js"'));

        for (const body of [applicationContent, mainContent, backgroundDeps, buildScript]) {
            expect(body).not.toContain("shared/api-client.js");
            expect(body).not.toContain("shared/validation.js");
            expect(body).not.toContain("shared/notifications.js");
            expect(body).not.toContain("background/telegram.js");
            expect(body).not.toContain("background/notification-service.js");
            expect(body).not.toContain("JOB_FOUND_CHANNEL");
            expect(body).not.toContain("job-found-channel");
        }
    });

    it("builds a self-contained MV3 dist with a stable WAF bridge resource", () => {
        const output = execFileSync(process.execPath, ["scripts/verify-bundling.js"], {
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });

        expect(output).toContain("bundle verification passed");

        const manifest = JSON.parse(readFileSync(resolve(DIST, "manifest.json"), "utf8"));
        expect(manifest.host_permissions).toEqual([
            "https://hiring.amazon.ca/*",
            "https://hiring.amazon.com/*",
            "*://auth.hiring.amazon.com/*",
            "*://auth.hiring.amazon.ca/*",
        ]);
        const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources || []);
        expect(resources).toContain("direct-waf-bridge-page.js");
        expect(existsSync(resolve(DIST, "direct-waf-bridge-page.js"))).toBe(true);
        expect(readdirSync(DIST).some(file => /^direct-waf-bridge-page\.[a-f0-9]{12}\.js$/.test(file)))
            .toBe(false);
    });
});
