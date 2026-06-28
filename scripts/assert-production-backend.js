#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONSTANTS_PATH = path.join(ROOT, "src", "shared", "constants.js");
const EXPECTED_BASE_URL = "https://getslotnow.com/administrator-api/api/amazon-warehouse-jobs-canada";

function readActiveBaseUrl() {
    const source = fs.readFileSync(CONSTANTS_PATH, "utf8");
    const match = source.match(/^\s*BASE_URL:\s*['"]([^'"]+)['"]/m);
    return match ? match[1] : "";
}

function assertProductionBackendUrl() {
    const activeBaseUrl = readActiveBaseUrl();

    if (activeBaseUrl === EXPECTED_BASE_URL) return;

    const relativePath = path.relative(ROOT, CONSTANTS_PATH);
    throw new Error(
        [
            `${relativePath} must use the production amazon-warehouse-ca API before commit/build.`,
            `Expected: BASE_URL: '${EXPECTED_BASE_URL}'`,
            activeBaseUrl
                ? `Found:    BASE_URL: '${activeBaseUrl}'`
                : "Found:    no active BASE_URL line",
        ].join("\n")
    );
}

if (require.main === module) {
    try {
        assertProductionBackendUrl();
    } catch (error) {
        console.error("[backend-url] " + error.message.replace(/\n/g, "\n[backend-url] "));
        process.exit(1);
    }
}

module.exports = {
    EXPECTED_BASE_URL,
    assertProductionBackendUrl,
};
