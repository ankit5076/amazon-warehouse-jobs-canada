---
name: verify-amazon-shifts-bundling
description: Verify Amazon Shifts Chrome MV3 extension bundling after source, config, test, or build-script changes. Use whenever Codex changes amazon-shifts code, manifest files, build scripts, content-script loaders, WAF bridge behavior, web-accessible resources, or package/build output; also use when debugging stale bundle hashes, missing scripts, or dist/manifest mismatches.
---

# Verify Amazon Shifts Bundling

## Purpose

Use this skill as the final guardrail after Codex changes `/Users/ankit5076/Documents/Automations/amazon-shifts` source/config/test/build-script code. It checks that source tests pass, production bundling works, the generated MV3 manifest points only at existing dist files, and the WAF page bridge cannot regress to a stale hashed filename.

Documentation-only skill/reference updates are exempt.

## Required Workflow

1. Resolve the repo root:

```bash
cd /Users/ankit5076/Documents/Automations/amazon-shifts
```

2. If Codex changed any source/config/test/build-script file, bump the minor extension version in `src/manifest.json` before final verification. Example: `2.25.0` becomes `2.26.0`.

3. Run the full test suite:

```bash
npm test -- --run
```

4. Run the bundling verifier as a separate final check:

```bash
npm run verify:bundle
```

This command rebuilds `dist/amazon-shifts/` and verifies the generated manifest, referenced files, content-script bundle shapes, version parity, and stable WAF bridge resource.

5. Run whitespace/syntax diff hygiene:

```bash
git diff --check
```

6. In the final answer, report all three gates and whether `dist/amazon-shifts/manifest.json` exposes `direct-waf-bridge-page.js`.

## What The Verifier Protects

- `src/manifest.json` version matches the built manifest.
- All built manifest references exist in `dist/amazon-shifts/`.
- Content scripts remain split correctly:
  - `content-application.<hash>.js` at `document_start`
  - `sweetalert.<hash>.js` plus `content-main.<hash>.js` at `document_idle`
- The WAF bridge is stable `direct-waf-bridge-page.js`, not `direct-waf-bridge-page.<hash>.js`.
- Built JS does not still reference a hashed WAF bridge.
- Built content scripts do not point at source JS paths such as `shared/*.js` or `content/*.js`.

## Failure Interpretation

- If `npm run verify:bundle` fails on the WAF bridge, inspect `scripts/build.js` and `src/shared/constants.js` replacement logic first.
- If Chrome logs still show `direct-waf-bridge-page.<hash>.js` after a passing `2.25.0+` build, the active Amazon tab is running a stale pre-`2.25.0` content script. Reload the extension and refresh/close Amazon tabs.
- If a manifest reference is missing, update `scripts/build.js` `CONTEXTS`, `buildManifest`, or asset copying before changing runtime code.
