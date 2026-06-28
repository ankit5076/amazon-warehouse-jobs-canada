#!/usr/bin/env node
/**
 * MV3 build script - produces a shareable, obfuscated Chrome extension under
 * `dist/amazon-warehouse-ca/` and optionally a zip next to it.
 *
 * The source tree intentionally stays split by domain for maintainability. The
 * distributable is flattened into MV3-safe execution-context bundles:
 *
 *   - background.<hash>.js                 service worker
 *   - popup.<hash>.js / popup.<hash>.css   extension popup
 *   - content-main.<hash>.js               hiring.amazon app pages
 *   - content-application.<hash>.js        application pages at document_start
 *   - create-application.<hash>.js         chrome.scripting injection bundle
 *   - direct-waf-bridge-page.js            page-world injected WAF bridge
 *
 * Files are content-hashed after minification/obfuscation so Chrome cannot
 * reuse stale bundle URLs after a build. The page-world WAF bridge intentionally
 * keeps a stable filename so a still-open content script does not point at a
 * deleted hashed bridge after the extension is rebuilt/reloaded.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const esbuild = require("esbuild");
const obfuscator = require("javascript-obfuscator");
const archiver = require("archiver");
const { assertProductionBackendUrl } = require("./assert-production-backend");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, "amazon-warehouse-ca");

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const VERSION = MANIFEST.version || PKG.version || "0.0.0";
const ZIP_NAME = `amazon-warehouse-ca-${VERSION}.zip`;
const ZIP_PATH = path.join(ROOT, ZIP_NAME);

const ESBUILD_TARGET = ["chrome114"];

const OBFUSCATOR_OPTS = {
    compact: true,
    // MV3-safe: keep options that avoid eval / new Function / debugger loops.
    controlFlowFlattening: false,
    deadCodeInjection: false,
    splitStrings: false,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.7,
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "variable",
    identifierNamesGenerator: "mangled",
    renameGlobals: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    numbersToExpressions: false,
    simplify: true,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    target: "browser",
};

const CONTEXTS = Object.freeze({
    APPLICATION_CONTENT: Object.freeze([
        "shared/constants.js",
        "shared/utils/time.js",
        "shared/utils/logger.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/url.js",
        "shared/utils/messaging.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
        "shared/api-client.js",
        "content/utils/application-observability.js",
        "shared/notifications.js",
        "content/utils/alerts.js",
        "content/utils/direct-application-api.js",
        "content/utils/direct-application-guard.js",
        "content/utils/direct-application-mode.js",
        "content/utils/direct-application-waf.js",
        "content/utils/direct-application.js",
    ]),
    MAIN_CONTENT: Object.freeze([
        "shared/constants.js",
        "shared/utils/time.js",
        "shared/utils/logger.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/account.js",
        "shared/utils/url.js",
        "shared/utils/city-tags.js",
        "shared/utils/intervals.js",
        "shared/utils/runtime-controls.js",
        "shared/utils/state-store.js",
        "shared/utils/messaging.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
        "content/utils/auth-probe.js",
        "content/utils/page-refresh.js",
        "shared/api-client.js",
        "shared/validation.js",
        "shared/notifications.js",
        "content/utils/dom.js",
        "content/utils/application-observability.js",
        "content/utils/identity.js",
        "content/utils/toasts.js",
        "content/utils/alerts.js",
        "content/utils/job-search.js",
        "content/utils/job-match.js",
        "content/utils/polling.js",
        "content/utils/schedule-automation.js",
        "content/login.js",
        "content/fetch.js",
    ]),
    POPUP: Object.freeze([
        "shared/constants.js",
        "shared/utils/time.js",
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
    ]),
    BACKGROUND_DEPS: Object.freeze([
        "shared/constants.js",
        "shared/utils/time.js",
        "shared/utils/logger.js",
        "shared/utils/text.js",
        "shared/utils/storage.js",
        "shared/utils/account.js",
        "shared/utils/url.js",
        "shared/utils/messaging.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
        "shared/api-client.js",
        "shared/validation.js",
        "background/telegram.js",
        "background/notification-service.js",
        "background/tab-service.js",
    ]),
    CREATE_APPLICATION: Object.freeze([
        "shared/constants.js",
        "shared/utils/time.js",
        "shared/utils/logger.js",
        "shared/utils/text.js",
        "shared/utils/url.js",
        "shared/utils/storage.js",
        "shared/utils/messaging.js",
        "shared/utils/license-api.js",
        "shared/utils/license-state.js",
        "shared/utils/payment-gate.js",
        "content/utils/dom.js",
        "content/utils/direct-application-guard.js",
        "content/utils/direct-application-mode.js",
        "shared/api-client.js",
        "shared/validation.js",
        "shared/notifications.js",
        "content/createapp.js",
    ]),
});

// --------------------------------------------------------------------------

function log(step, msg) {
    process.stdout.write(`[build] ${step.padEnd(11)} ${msg}\n`);
}

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readSrc(relPath) {
    return fs.readFileSync(path.join(SRC, relPath), "utf8");
}

function copyFile(srcAbs, destAbs) {
    ensureDir(path.dirname(destAbs));
    fs.copyFileSync(srcAbs, destAbs);
}

function copyDirectory(srcAbs, destAbs) {
    if (!fs.existsSync(srcAbs)) return;
    for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
        if (entry.name === ".DS_Store") continue;
        const srcPath = path.join(srcAbs, entry.name);
        const destPath = path.join(destAbs, entry.name);
        if (entry.isDirectory()) copyDirectory(srcPath, destPath);
        else copyFile(srcPath, destPath);
    }
}

function contentHash(content) {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function writeHashedFile(baseName, ext, content) {
    const filename = `${baseName}.${contentHash(content)}.${ext}`;
    const absPath = path.join(OUT, filename);
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, content);
    return filename;
}

function writeNamedFile(filename, content) {
    const absPath = path.join(OUT, filename);
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, content);
    return filename;
}

function copyHashedAsset(srcRelPath, baseName, ext) {
    const source = fs.readFileSync(path.join(SRC, srcRelPath));
    const filename = writeHashedFile(baseName, ext, source);
    log("asset", `${srcRelPath} -> ${filename}`);
    return filename;
}

function createIdentifiersPrefix(bundleName) {
    const readable = bundleName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || "bundle";
    const digest = crypto.createHash("sha1").update(bundleName).digest("hex").slice(0, 12);
    return `_amz_${readable}_${digest}_`;
}

function findMatchingBrace(source, openBraceIndex) {
    if (openBraceIndex < 0 || source[openBraceIndex] !== "{") return -1;
    let depth = 0;
    for (let i = openBraceIndex; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function stripServiceWorkerImportScripts(source) {
    const tryPattern = /\btry\s*\{/g;
    let match;

    while ((match = tryPattern.exec(source))) {
        const tryBraceIndex = source.indexOf("{", match.index);
        const tryEnd = findMatchingBrace(source, tryBraceIndex);
        if (tryEnd === -1) return source;

        const tryBlock = source.slice(tryBraceIndex + 1, tryEnd);
        if (!/\bimportScripts\s*\(/.test(tryBlock)) {
            tryPattern.lastIndex = tryEnd + 1;
            continue;
        }

        const afterTry = source.slice(tryEnd + 1);
        const catchMatch = /^\s*catch\s*\(\s*error\s*\)\s*\{/.exec(afterTry);
        if (!catchMatch) return source;

        const catchBraceIndex = tryEnd + 1 + catchMatch[0].lastIndexOf("{");
        const catchEnd = findMatchingBrace(source, catchBraceIndex);
        if (catchEnd === -1) return source;

        return source.slice(0, match.index) + source.slice(catchEnd + 1);
    }

    return source;
}

function patchConstantsSource(source, replacements = {}) {
    let patched = source;

    if (replacements.directWafBridgeResource) {
        patched = patched.replace(
            /PAGE_BRIDGE_RESOURCE:\s*'content\/utils\/direct-waf-bridge-page\.js'/,
            `PAGE_BRIDGE_RESOURCE: '${replacements.directWafBridgeResource}'`
        );
    }

    if (Object.prototype.hasOwnProperty.call(replacements, "createApplicationBundle")) {
        const injectionFiles = replacements.createApplicationBundle
            ? `['${replacements.createApplicationBundle}']`
            : "[]";
        patched = patched.replace(
            /INJECTION_FILES:\s*Object\.freeze\(\[[\s\S]*?\]\),/,
            `INJECTION_FILES: Object.freeze(${injectionFiles}),`
        );
    }

    return patched;
}

function readBundlePart(relPath, replacements = {}) {
    let source = readSrc(relPath);
    if (relPath === "shared/constants.js") {
        source = patchConstantsSource(source, replacements);
    }
    if (relPath === "background/service-worker.js") {
        source = stripServiceWorkerImportScripts(source);
    }
    return `\n/* ${relPath} */\n${source}\n;`;
}

async function minifyJavaScript(source) {
    const result = await esbuild.transform(source, {
        loader: "js",
        minify: true,
        target: ESBUILD_TARGET,
        legalComments: "none",
        charset: "utf8",
    });
    return result.code;
}

async function buildJsBundle(bundleName, relPaths, replacements = {}, options = {}) {
    const source = relPaths.map(relPath => readBundlePart(relPath, replacements)).join("\n");
    const minified = await minifyJavaScript(source);
    const obfuscated = obfuscator
        .obfuscate(minified, {
            ...OBFUSCATOR_OPTS,
            identifiersPrefix: createIdentifiersPrefix(bundleName),
        })
        .getObfuscatedCode();
    const filename = options.filename
        ? writeNamedFile(options.filename, obfuscated)
        : writeHashedFile(bundleName, "js", obfuscated);
    log("bundle", `${bundleName} -> ${filename} (${source.length}->${obfuscated.length} chars)`);
    return filename;
}

async function buildCssBundle(bundleName, relPaths) {
    const source = relPaths.map(relPath => `/* ${relPath} */\n${readSrc(relPath)}`).join("\n");
    const result = await esbuild.transform(source, {
        loader: "css",
        minify: true,
        legalComments: "none",
        charset: "utf8",
    });
    const filename = writeHashedFile(bundleName, "css", result.code);
    log("bundle", `${bundleName} -> ${filename} (${source.length}->${result.code.length} chars)`);
    return filename;
}

function buildPopupHtml({ popupCss, popupJs }) {
    let html = readSrc("popup/index.html");
    html = html.replace(/<link\s+rel="stylesheet"\s+href="popup\.css"\s*>/, `<link rel="stylesheet" href="${popupCss}">`);
    html = html.replace(/<script\s+src="[^"]+"\s*><\/script>\s*/g, "");
    html = html.replace(/\.\.\/assets\//g, "assets/");
    html = html.replace("</body>", `    <script src="${popupJs}"></script>\n</body>`);
    fs.writeFileSync(path.join(OUT, "popup.html"), html);
    log("html", "popup/index.html -> popup.html");
}

function buildManifest({
    backgroundJs,
    contentApplicationJs,
    contentMainJs,
    createApplicationJs,
    directWafBridgeJs,
    contentCss,
    sweetalertCss,
    sweetalertJs,
}) {
    const manifest = JSON.parse(JSON.stringify(MANIFEST));

    manifest.action.default_popup = "popup.html";
    manifest.background.service_worker = backgroundJs;

    manifest.content_scripts[0].js = [contentApplicationJs];
    manifest.content_scripts[1].css = [sweetalertCss, contentCss];
    manifest.content_scripts[1].js = [sweetalertJs, contentMainJs];

    manifest.web_accessible_resources = [
        {
            matches: ["<all_urls>"],
            resources: [
                "assets/images/canada-flag.png",
                "assets/sounds/alert.wav",
                "assets/sounds/alert_long.wav",
                "assets/fonts/Quicksand.ttf",
            ],
        },
        {
            matches: [
                "https://hiring.amazon.ca/*",
                "https://hiring.amazon.com/*",
            ],
            resources: [directWafBridgeJs],
        },
    ];

    fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log("manifest", "manifest.json rewritten for hashed bundles");
}

function zipDist() {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(ZIP_PATH);
        const zip = archiver("zip", { zlib: { level: 9 } });
        out.on("close", () => resolve(zip.pointer()));
        zip.on("warning", (err) => (err.code === "ENOENT" ? log("zip", err.message) : reject(err)));
        zip.on("error", reject);
        zip.pipe(out);
        zip.directory(OUT, "amazon-warehouse-ca");
        zip.finalize();
    });
}

// --------------------------------------------------------------------------

async function main() {
    const wantZip = process.argv.includes("--zip");

    assertProductionBackendUrl();
    log("check", "production backend URL confirmed");

    log("clean", `removing ${path.relative(ROOT, DIST)} and ${ZIP_NAME}`);
    rmrf(DIST);
    rmrf(ZIP_PATH);
    ensureDir(OUT);

    log("copy", "static assets");
    copyDirectory(path.join(SRC, "assets"), path.join(OUT, "assets"));

    const directWafBridgeJs = await buildJsBundle(
        "direct-waf-bridge-page",
        ["content/utils/direct-waf-bridge-page.js"],
        {},
        { filename: "direct-waf-bridge-page.js" }
    );

    const replacementsForCreateApplication = {
        directWafBridgeResource: directWafBridgeJs,
        createApplicationBundle: "",
    };
    const createApplicationJs = await buildJsBundle(
        "create-application",
        CONTEXTS.CREATE_APPLICATION,
        replacementsForCreateApplication
    );

    const replacements = {
        directWafBridgeResource: directWafBridgeJs,
        createApplicationBundle: createApplicationJs,
    };

    const [
        backgroundJs,
        contentApplicationJs,
        contentMainJs,
        popupJs,
        popupCss,
        contentCss,
    ] = await Promise.all([
        buildJsBundle("background", [...CONTEXTS.BACKGROUND_DEPS, "background/service-worker.js"], replacements),
        buildJsBundle("content-application", CONTEXTS.APPLICATION_CONTENT, replacements),
        buildJsBundle("content-main", CONTEXTS.MAIN_CONTENT, replacements),
        buildJsBundle("popup", CONTEXTS.POPUP, replacements),
        buildCssBundle("popup", ["popup/popup.css"]),
        buildCssBundle("content", ["popup/popup.css", "content/overrides.css"]),
    ]);

    const sweetalertJs = copyHashedAsset("vendor/sweetalert.js", "sweetalert", "js");
    const sweetalertCss = copyHashedAsset("vendor/sweetalert.css", "sweetalert", "css");

    buildPopupHtml({ popupCss, popupJs });
    buildManifest({
        backgroundJs,
        contentApplicationJs,
        contentMainJs,
        createApplicationJs,
        directWafBridgeJs,
        contentCss,
        sweetalertCss,
        sweetalertJs,
    });

    if (wantZip) {
        log("zip", `creating ${ZIP_NAME}`);
        const bytes = await zipDist();
        log("zip", `wrote ${ZIP_NAME} (${(bytes / 1024).toFixed(1)} KB)`);
    }

    log("done", `extension ready at ${path.relative(ROOT, OUT)}/`);
    if (!wantZip) log("hint", "run `npm run package` to also produce a .zip");
}

main().catch((err) => {
    console.error("[build] FAILED:", err);
    process.exit(1);
});
