---
name: analyze-amazon-shifts-logs
description: Analyze/analyse Amazon Shifts extension debug logs, HAR files, failed bookings, search issues, and current execution flow by comparing evidence against the official Amazon resource bundle in the amazon-shifts resources folder. Use when Codex is asked to analyze/analyse logs, decide whether logs look good, explain why booking did or did not happen, interpret APPLICATION_ALREADY_EXIST, verify direct-application behavior, or check whether our extension matches Amazon's official workflow.
---

# Analyze Amazon Shifts Logs

## Quick Start

Run the bundled analyzer first. It automatically looks for the repo `resources` folder and prints an official-resource baseline when available:

```bash
python3 skills/analyze-amazon-shifts-logs/scripts/analyze_logs.py logs
```

Pass a specific log when the user gives one:

```bash
python3 skills/analyze-amazon-shifts-logs/scripts/analyze_logs.py logs/amazon-shifts-debug-logs-*.json
```

Pass HAR explicitly when the user provides it:

```bash
python3 skills/analyze-amazon-shifts-logs/scripts/analyze_logs.py logs/amazon-shifts-debug-logs-*.json logs/create.har
python3 skills/analyze-amazon-shifts-logs/scripts/analyze_logs.py logs/amazon-shifts-debug-logs-*.json --har logs/create.har
```

If only a HAR is provided, still analyze the HAR and use the newest debug JSON from the same folder when available:

```bash
python3 skills/analyze-amazon-shifts-logs/scripts/analyze_logs.py logs/create.har
```

The script prints a Markdown report with metadata, timeline, per-step durations, total attempt time, HAR API calls when available, findings, and suggestions.

## Required Resource Verification

Never give a final verdict on booking correctness from logs alone. Always compare the observed flow against the official Amazon resource bundle under `/Users/ankit5076/Documents/Automations/amazon-shifts/resources`.

For direct application, create application, selected-shift, `APPLICATION_ALREADY_EXIST`, stale schedule, consent, no-available-shift, or end-to-end booking workflow questions, read [references/official-direct-application-flow.md](references/official-direct-application-flow.md) before concluding. It contains the official API sequence, payloads, route decisions, WAF/CAPTCHA behavior, workflow websocket handoff, and log/HAR checklist.

If the analyzer says official resources are missing or incomplete, inspect `resources/js files.har` manually and say that resource verification was partial. Do not claim "same as Amazon" unless the resource baseline was checked.

## Knowledge Maintenance

When resource-bundle analysis reveals a new durable fact about Amazon's official workflow, API sequence, payload shape, route decision, error meaning, WAF/CAPTCHA behavior, timing expectation, or response interpretation, update [references/official-direct-application-flow.md](references/official-direct-application-flow.md) in the same turn. Keep one-off log observations out of the reference unless they generalize to future debugging.

## Code Change Versioning

When Codex makes any source/config/test/build-script code change in `/Users/ankit5076/Documents/Automations/amazon-shifts`, bump the minor extension version in `src/manifest.json` in the same turn before final verification. For example, `2.23.0` becomes `2.24.0`. Do not skip this for small fixes; only documentation-only skill/reference updates are exempt.

After any such code change, use the bundling verification workflow:

```bash
npm test -- --run
npm run verify:bundle
git diff --check
```

After updating skill files inside the repo, sync the installed copy:

```bash
rsync -a --delete skills/analyze-amazon-shifts-logs/ /Users/ankit5076/.codex/skills/analyze-amazon-shifts-logs/
```

## Workflow

1. Resolve the repo root as `/Users/ankit5076/Documents/Automations/amazon-shifts` unless the user gives another path.
2. Use the newest `amazon-shifts-debug-logs-*.json` in the supplied directory unless a specific file is requested.
3. If a `.har` exists in the same directory or the user supplies a HAR path, analyze it alongside the console logs. When a HAR is supplied without a JSON log, produce a HAR-only network timeline and note that extension-stage logs are unavailable.
4. Verify the official-resource baseline:
   - Confirm whether `resources/js files.har` or extracted official chunks are available.
   - Compare observed API sequence, response handling, and navigation against the official direct-application flow.
   - If current source behavior is questioned, inspect `src/content/utils/direct-application.js`, `src/content/utils/direct-application-api.js`, and `src/shared/constants.js`.
5. If resource analysis produced a reusable new finding, update the skill reference and sync the installed skill before the final answer.
6. Report concrete IST timestamps, elapsed durations, job id, schedule id, application id, HTTP statuses, and stage names.
7. Separate root-cause categories:
   - **Search**: GraphQL returned zero jobs, auth/WAF error, wrong city/job-type filters.
   - **Matching**: jobs returned but no local match.
   - **Job detail / schedule UI**: Select schedule or Apply missing/click failed.
   - **Direct application**: candidate lookup, create application, job-confirm, reservation, workflow.
   - **WAF/CAPTCHA**: `405` plus `x-amzn-waf-action: captcha`, CAPTCHA render/solve/timeout.
   - **Amazon availability**: selected schedule no longer available, reservation not verified, post-confirm job missing.
8. Suggest changes only when they follow from evidence. Prefer small, testable fixes.

## Interpretation Rules

- Treat `405` with `x-amzn-waf-action: captcha` as Amazon WAF CAPTCHA, not a normal API failure.
- A successful selected-shift booking is not just create success. It needs `create-application` success, `update-application` with `type: job-confirm`, then consent handoff with the application id and selected/returned schedule id.
- `APPLICATION_ALREADY_EXIST` means Amazon rejected a new create because an active/existing application already exists. Official behavior routes to an already-applied page, not booking success.
- If selected schedule is unavailable before create and other schedules exist, official behavior creates the application without `scheduleId`, sets `sessionStorage.scheduleNotAvailable`, and routes to consent.
- If selected schedule is unavailable before create and no schedules exist, official behavior routes to `#/no-available-shift`.
- If `create-application` succeeds and a later `job-confirm` returns `200`, but the extension emits `booking.failed`, suspect response-shape interpretation or missing reservation verification before declaring failure.
- If `job-confirm` returns `JOB_SELECTED`, treat that as the authoritative selected-shift booking signal even if later attempts for the same job produce `APPLICATION_ALREADY_EXIST` failures.
- If `application.created_without_schedule` or an `application-created-without-schedule` stage appears after `SELECTED_SCHEDULE_NOT_AVAILABLE`, treat it as a terminal stale-selected-schedule outcome: the application exists, but the requested schedule was not booked.
- If Telegram success shows an old `#/pre-consent`, `#/resume-application`, or `#/job-opportunities/job-confirmation` link, check whether `official selected-schedule consent redirect scheduled` appears immediately after. The booking can be valid while the notification URL is stale because the success notification was emitted before the redirect URL was attached/scheduled.
- If the user expects only job-found plus success/failure Telegram messages, verify whether stale-selected-schedule outcomes are mapped to `booking.failed`; otherwise those terminal fallback outcomes may be visible only in logs.
- Current extension expectation: `booking.succeeded` terminal notifications should include a final `redirectUrl`; stale selected-schedule application handoff should emit terminal `booking.failed`; existing-application errors should cool down the same job/account and hand off to My Applications Select Shift instead of repeatedly recreating the application.
- If `booking.failed` notification lacks `errorCode` or `errorClassification`, recommend improving failure payload logging before changing flow.
- If Apply is clicked and direct booking starts several seconds later, attribute most of that gap to Amazon application route load unless logs show extension waiting.
- If logs are dominated by repeated empty polling, mention whether the export came from a version before the polling-log throttle.
- If WAF/CAPTCHA logs show `page bridge script load failed` for a hashed `direct-waf-bridge-page.<hash>.js`, compare that hash with the current built `dist/amazon-warehouse-ca/manifest.json`. A stale content script after extension reload can keep referencing a deleted old bridge bundle; the operator must reload the extension and refresh/close Amazon tabs so content and web-accessible bundle hashes match.
- From extension `2.25.0` onward, production builds expose the WAF page bridge as stable `direct-waf-bridge-page.js`. If newer logs still show a hashed bridge filename, the active Amazon tab is running a pre-`2.25.0` stale content script and must be closed/refreshed after reloading the extension.
- Do not expose credentials, auth headers, candidate ids, tokens, emails, cookies, CAPTCHA tokens, or WAF tokens. Redact anything sensitive if it appears in HAR text.

## Output Shape

Keep the final user answer concise but include:

- Overall verdict.
- Official resource baseline status: matched, mismatched, or partially verified.
- Timeline table or short bullets with step durations.
- Total time from job found or first meaningful step to success/failure.
- What failed and why.
- What was definitely working.
- Suggested code/ops changes, ordered by impact.

Use links to local files when referencing source or artifacts.
