# Official Amazon Booking Workflow

Use this as the resource-backed baseline when analyzing Amazon Shifts logs, HAR files, or direct-application code. The goal is to decide whether our extension matched Amazon's own booking flow, where it diverged, and whether a log indicates success, fallback, or a real bug.

## Resource Evidence Map

Primary local source:

```text
/Users/ankit5076/Documents/Automations/amazon-shifts/resources/js files.har
```

The HAR contains the real production JS responses. Local `resources/*.prod.chunk.js` files may be incomplete placeholders, so prefer `resources/js files.har` or extracted JS from it.

Useful extracted/pretty files, when present from prior analysis:

```text
/tmp/amazon-official-js/1352.pretty.js
/tmp/amazon-official-js/2369.pretty.js
/tmp/amazon-official-js/3133.pretty.js
/tmp/amazon-official-js/3387.pretty.js
```

Important evidence anchors:

- `/tmp/amazon-official-js/1352.pretty.js:90` - pre-consent page reads query params, waits for job/schedule/candidate, and controls the Begin Application button.
- `/tmp/amazon-official-js/1352.pretty.js:106` - Begin Application click handler and selected-schedule create decision tree.
- `/tmp/amazon-official-js/2369.pretty.js:6` - application action creators, including create, update, and create-and-skip-schedule.
- `/tmp/amazon-official-js/3133.pretty.js:141` - route helper that merges hash params and pushes `/#/<route>?...`.
- `/tmp/amazon-official-js/3133.pretty.js:238` - helper that builds update payloads with `dspEnabled: !!application.dspEnabled`.
- `/tmp/amazon-official-js/3133.pretty.js:876` - stale selected-schedule fallback helper.
- `/tmp/amazon-official-js/3387.pretty.js:920` - official route names.
- `/tmp/amazon-official-js/3387.pretty.js:1458` - captcha/WAF axios interceptors.
- `/tmp/amazon-official-js/3387.pretty.js:1463` - candidate application API client.
- `/tmp/amazon-official-js/3387.pretty.js:1582` - create-and-skip-schedule post-create `job-confirm` helper.
- `/tmp/amazon-official-js/3387.pretty.js:1781` - schedule list epic and no-available-shift routing.
- `/tmp/amazon-official-js/3387.pretty.js:1818` - schedule detail epic.
- `/tmp/amazon-official-js/3387.pretty.js:1829` - create application epic.
- `/tmp/amazon-official-js/3387.pretty.js:1844` - update application epic.
- `/tmp/amazon-official-js/3387.pretty.js:1858` - create-application-and-skip-schedule epic.
- `/tmp/amazon-official-js/3387.pretty.js:1873` - get-application success routing and workflow websocket handoff.
- `/tmp/amazon-official-js/3387.pretty.js:1903` - candidate lookup epic.

If `/tmp/amazon-official-js` is missing, search the HAR directly:

```bash
rg -n "createApplicationDS|updateApplication|getScheduleDetailByScheduleId|get-all-schedules|APPLICATION_ALREADY_EXIST|scheduleNotAvailable|job-confirm|ENABLE_EMPTY_SCHEDULE_CHECK" resources/'js files.har'
```

## Route Names

Official route enum includes:

```text
consent
pre-consent
job-opportunities
job-opportunities/job-confirmation
already-applied
already-applied-but-can-be-reset
rehire-eligibility-status
no-available-shift
no-eligible-schedule
applicationId-null
liveness-check
```

Navigation uses a helper that preserves existing hash query params, merges supplied params, then pushes:

```text
/#/<route>?param=value&...
```

For selected-shift success, the important destination is:

```text
#/consent?applicationId=<id>&scheduleId=<returned-or-selected-schedule>
```

For fallback create without selected schedule, the consent route has application id only:

```text
#/consent?applicationId=<id>
```

## API Clients And Base Paths

Candidate application API client:

```text
base: /application/api/candidate-application
GET  /candidate
GET  /candidate?unsanitized=true
GET  /candidate?includeReeStatus=true
POST /ds/create-application/
PUT  /update-application
GET  /applications/{applicationId}
GET  /applications/reserved/{applicationId}
PUT  /update-workflow-step-name
```

Job/schedule API client:

```text
base: /application/api/job
GET  /{jobId}?locale=<locale>
GET  /get-schedule-details/{scheduleId}?locale=<locale>&applicationId=<optional>
POST /get-all-schedules/{jobId}
POST /get-all-schedules-with-start-date-availability/{jobId}
```

Page/config bootstrap APIs:

```text
GET /application/api/config/
GET /application/api/page-config/page-orders
GET /application/api/page-config/<page-config-json>
```

## Job Search And Schedule Drawer Baseline

Official job search uses GraphQL `searchJobCardsByLocation`. For broad Canada/all-cities search, captured official requests can be as small as:

```json
{
  "locale": "en-CA",
  "country": "Canada",
  "pageSize": 100,
  "sorters": [{ "fieldName": "totalPayRateMax", "ascending": "false" }],
  "dateFilters": [{ "key": "firstDayOnSite", "range": { "startDate": "<today>" } }]
}
```

The job detail schedule drawer does not rely on the original job-card response. It uses GraphQL `searchScheduleCards` for the known `jobId`, usually with `isPrivateSchedule=false`, `firstDayOnSite` from today, and page sizes such as `100` or `1000`; some drawer requests include `scheduleShift: []` and `consolidateSchedule: true`.

Do not treat the DOM drawer text `0 schedules found` as authoritative by itself. A known `jobId` can still return `getJobDetail` as `POSTED` and `searchScheduleCards` with schedule cards even when recent broad `searchJobCardsByLocation` polls returned zero or the drawer UI did not render selectable cards. For log analysis, distinguish:

- search index visibility: `searchJobCardsByLocation` returns job cards or zero
- local matching: returned job cards are filtered by extension city/job-type/cooldown logic
- schedule availability: `searchScheduleCards` or application schedule-detail APIs confirm actual schedule cards/status
- UI automation: DOM schedule labels/apply buttons appear and are clicked

If a job card matched once, then later visible jobs are not matched, check for extension cooldown logs such as `skipping jobs cooling down after unavailable schedule response` before calling it a city/job-type match bug.

Create and update use the captcha-aware axios instance. A `405` response with `x-amzn-waf-action: captcha` is Amazon WAF/CAPTCHA, not a normal API failure. The official axios interceptor tries to solve the challenge, obtains/refreshes the WAF token, and retries the original request.

## Core Payloads

Selected schedule create:

```json
{
  "jobId": "JOB-...",
  "dspEnabled": true,
  "scheduleId": "SCH-...",
  "candidateId": "candidate-...",
  "activeApplicationCheckEnabled": true
}
```

No selected schedule create:

```json
{
  "jobId": "JOB-...",
  "dspEnabled": true,
  "candidateId": "candidate-...",
  "activeApplicationCheckEnabled": true
}
```

Official stale-schedule fallback create omits both `scheduleId` and `candidateId`:

```json
{
  "jobId": "JOB-...",
  "dspEnabled": true,
  "activeApplicationCheckEnabled": true
}
```

Post-create selected schedule confirmation:

```json
{
  "applicationId": "application-...",
  "payload": {
    "jobId": "JOB-...",
    "scheduleId": "SCH-..."
  },
  "type": "job-confirm",
  "dspEnabled": true
}
```

`dspEnabled` is not a random constant in official code:

```text
create payload: job.results.dspEnabled
update payload: !!application.dspEnabled
```

## Full Success Flow With Selected Schedule

This is the canonical booking success path.

1. Candidate clicks Apply/selects a schedule on the job detail experience.
2. Browser enters the application/pre-consent route with hash/query params containing at least `jobId`, usually `scheduleId`, and sometimes `applicationId`.
3. App bootstrap loads config, page order, country/state config, stores query params in `sessionStorage`, stores token if present, and may redirect to AES V2 if feature flags/country require it.
4. Pre-consent page parses query params from hash/search.
5. Pre-consent page fetches or waits for:
   - job detail for `jobId`
   - schedule detail for `scheduleId`
   - candidate data, especially `candidateId`
   - app config/envConfig
6. The Begin Application button remains disabled until:
   - job detail is loaded
   - candidate data is loaded
   - if `scheduleId` exists, schedule detail is loaded
   - UI is not loading
   - any required data-policy checkbox is checked
7. On click, official code clears UI/banner state.
8. If `ENABLE_LIVENESS_CHECK` is enabled and the app is not on AtoZ domain:
   - stores `sessionStorage.livenessCheckPayload`
   - routes to `#/liveness-check`
   - does not create the application yet
9. If `scheduleId` exists, official code builds selected-schedule create payload:
   - `jobId`
   - `scheduleId`
   - `candidateId`
   - `dspEnabled` from job detail
   - `activeApplicationCheckEnabled`
10. If `ENABLE_EMPTY_SCHEDULE_CHECK` is disabled, or an `applicationId` is already present in the route, official code skips the extra availability check and dispatches `CREATE_APPLICATION_AND_SKIP_SCHEDULE`.
11. Otherwise, official code calls schedule detail again and checks whether the selected schedule is available. The availability helper treats an active schedule as available.
12. If schedule detail is available, official code dispatches `CREATE_APPLICATION_AND_SKIP_SCHEDULE`.
13. `CREATE_APPLICATION_AND_SKIP_SCHEDULE` calls:

```text
POST /application/api/candidate-application/ds/create-application/
```

14. On create success, official code calls the helper that performs post-create `job-confirm`.
15. The helper reads:
   - `jobId` from `application.jobScheduleSelected.jobId`
   - `applicationId` and `candidateId` from the created application
   - `scheduleId` from the currently loaded schedule detail
16. It builds the `job-confirm` payload via the official update-payload helper:
   - `applicationId`
   - `type: "job-confirm"`
   - `payload: { jobId, scheduleId }`
   - `dspEnabled: !!application.dspEnabled`
17. It calls:

```text
PUT /application/api/candidate-application/update-application
```

18. On `job-confirm` success:
   - official code reads the returned schedule id from `response.jobScheduleSelected.scheduleId`
   - if returned schedule id differs from requested schedule id, it records/logs a mismatch
   - routes to consent with `applicationId` and the returned schedule id
   - clears UI/loading state
   - starts workflow websocket/audit with `jobId`, returned `scheduleId`, `applicationId`, `candidateId`, and `envConfig`
19. Expected terminal URL:

```text
#/consent?...applicationId=<applicationId>&scheduleId=<returnedScheduleId>
```

20. A log/HAR should not call this selected-shift success unless create succeeded and `job-confirm` either succeeded or the later official state clearly rehydrates the application as selected/reserved.

## No Schedule Selected Flow

This happens when the user starts an application for a job without a selected schedule.

1. Pre-consent page has `jobId` but no `scheduleId`.
2. Official code builds a create payload without schedule id:

```json
{
  "jobId": "JOB-...",
  "dspEnabled": true,
  "candidateId": "candidate-...",
  "activeApplicationCheckEnabled": true
}
```

3. Dispatches normal `CREATE_APPLICATION`.
4. `CREATE_APPLICATION` calls `POST /ds/create-application/`.
5. On success, official code routes to `job-opportunities` with `applicationId`.
6. It does not call `job-confirm` because no schedule was selected.

Expected route:

```text
#/job-opportunities?applicationId=<applicationId>
```

## Selected Schedule Unavailable Before Create

This is the official fallback guarded by `ENABLE_EMPTY_SCHEDULE_CHECK`.

Trigger:

```text
scheduleId exists
ENABLE_EMPTY_SCHEDULE_CHECK is enabled
no applicationId in route
getScheduleDetails(scheduleId) says schedule is not available/active
```

Official sequence:

1. Log that the selected schedule is unavailable.
2. Call schedule list fallback:

```json
{
  "jobId": "JOB-...",
  "locale": "en-CA",
  "pageSize": 1
}
```

3. API:

```text
POST /application/api/job/get-all-schedules/{jobId}
```

4. If at least one other schedule exists:
   - create a DS application without selected schedule id
   - do not include `candidateId` in this fallback payload
   - do not call `job-confirm`
   - clear UI/loading state
   - start workflow websocket/audit using original `jobId`, original stale `scheduleId`, new `applicationId`, returned `candidateId`, and `envConfig`
   - set `sessionStorage.scheduleNotAvailable = <originalScheduleId>`
   - route to consent with application id only

Expected route:

```text
#/consent?applicationId=<applicationId>
```

Expected session marker:

```text
sessionStorage.scheduleNotAvailable = original selected schedule id
```

5. If no schedules exist:
   - schedule list epic throws `NO_SCHEDULE_FOUND`
   - official route is `#/no-available-shift`
   - in one feature-specific path it may route `#/no-eligible-schedule`
   - no application is created

Expected route:

```text
#/no-available-shift
```

## Create Succeeds But Job-Confirm Fails

This path matters a lot for bug analysis.

Official selected-schedule helper does not create a second application after `job-confirm` fails.

When `POST /ds/create-application/` succeeds but `PUT /update-application` fails:

1. Keep the created application.
2. If `envConfig` exists, route to consent with `applicationId` only.
3. Fetch reserved application data:

```text
GET /application/api/candidate-application/applications/reserved/{applicationId}
```

4. Re-render/rehydrate the application state through the reserved-application callback.
5. Do not call `POST /ds/create-application/` again for the same attempt.
6. Do not call this selected-shift booking success unless the rehydrated application later shows the intended job/schedule state.

Expected route:

```text
#/consent?applicationId=<applicationId>
```

Expected log interpretation:

```text
create ok + job-confirm selected-schedule error = created application, selected schedule not secured
```

## Existing Application And Duplicate Errors

`APPLICATION_ALREADY_EXIST` means Amazon refused a new application because an active/existing application already exists for the candidate. It does not mean the target shift was booked.

Official create error mapping:

```text
APPLICATION_ALREADY_EXIST -> #/already-applied
APPLICATION_ALREADY_EXIST_CAN_BE_RESET -> #/already-applied-but-can-be-reset
NOT_REHIRE_ELIGIBLE / related -> #/rehire-eligibility-status?reason=...
ONE_ACTIVE_APPLICATION_PER_CANDIDATE_ALLOWED -> compare/fetch submitted application path
```

`APPLICATION_ALREADY_EXIST_CAN_BE_RESET` also stores error code/metadata before routing.

For `ONE_ACTIVE_APPLICATION_PER_CANDIDATE_ALLOWED`, official code uses the error metadata to fetch application details and schedule detail for comparison/resolution. Treat that as an existing-active-application branch, not direct booking success.

## Schedule List Error Meanings

Official schedule-list handling checks `availableSchedules.total` and `availableSchedules.schedules.length`.

If response shape is missing:

```text
FETCH_SHIFTS_ERROR
```

If no schedules and caller requested routing when empty:

```text
NO_SCHEDULE_FOUND -> #/no-available-shift
```

If no schedules and caller did not request routing:

```text
NO_SCHEDULE_FOUND_ADJUST_FILTERS
```

For geolocation schedule lists:

```text
NO_SCHEDULE_FOUND_IN_LOCATION
CURRENT_SCHEDULE_NOT_FOUND_IN_LOCATION
```

## Workflow Websocket / Audit Handoff

Official code starts workflow/websocket/audit after selected-schedule `job-confirm` success and also after fallback create-without-schedule success.

Selected-schedule success uses:

```text
jobId from created application
scheduleId from update response jobScheduleSelected.scheduleId
applicationId
candidateId
envConfig
```

Fallback create-without-schedule uses:

```text
original jobId
original stale scheduleId
new applicationId
candidateId from create response
envConfig
```

Get-application success can also start workflow websocket if the app is in a state that requires workflow continuation and no websocket already exists.

## Expected HAR / Log Patterns

Selected-schedule happy path:

```text
GET  /application/api/config/
GET  /application/api/page-config/page-orders
GET  /application/api/candidate-application/candidate
GET  /application/api/job/{jobId}?locale=...
GET  /application/api/job/get-schedule-details/{scheduleId}?locale=...
POST /application/api/candidate-application/ds/create-application/   includes scheduleId
PUT  /application/api/candidate-application/update-application       type=job-confirm
route #/consent with applicationId + scheduleId
workflow websocket/audit
```

Selected schedule unavailable before create, with other schedules:

```text
GET  /get-schedule-details/{scheduleId}                              unavailable
POST /get-all-schedules/{jobId}                                      pageSize=1, returns schedules
POST /ds/create-application/                                         no scheduleId, no candidateId
route #/consent with applicationId only
sessionStorage.scheduleNotAvailable set
workflow websocket/audit
```

Selected schedule unavailable before create, no schedules:

```text
GET  /get-schedule-details/{scheduleId}                              unavailable
POST /get-all-schedules/{jobId}                                      no schedules
route #/no-available-shift
no create call
```

Create succeeds, `job-confirm` fails:

```text
POST /ds/create-application/                                         200 with applicationId
PUT  /update-application                                             selected schedule unavailable/error
route #/consent with applicationId only
optional GET /applications/reserved/{applicationId}
no second create call
```

Create duplicate:

```text
POST /ds/create-application/                                         APPLICATION_ALREADY_EXIST
route #/already-applied
no booking success
```

WAF/CAPTCHA:

```text
POST/PUT returns 405 with x-amzn-waf-action: captcha
captcha interceptor solves challenge / refreshes WAF token
same request retried
interpret the retried response, not the first 405, as the business outcome
```

## Debugging Checklist

Use this checklist whenever asked "why did booking not happen?" or "do logs look good?"

1. Identify extension version from log export. Old versions may not match current code.
2. Identify the first meaningful attempt:
   - job found
   - schedule apply clicked
   - direct booking started
   - first create request
3. Record total time from job found or direct booking start to terminal signal.
4. Determine selected-schedule vs no-schedule path:
   - create payload includes `scheduleId` => selected-schedule path
   - create payload omits `scheduleId` => no-schedule/fallback path
5. If selected-schedule path:
   - create success alone is not enough
   - look for `PUT /update-application` with `type: job-confirm`
   - check update response for selected schedule id/current state/errorCode
6. If `job-confirm` 405 occurs:
   - check WAF header
   - verify captcha solved/retry happened
   - inspect retried `job-confirm` response
7. If retried `job-confirm` returns `SELECTED_SCHEDULE_NOT_AVAILABLE`:
   - schedule was lost after application create
   - official behavior is consent handoff with application id only
   - do not create another application
8. If schedule detail is unavailable before create:
   - look for `get-all-schedules`
   - if schedules exist, expect create without schedule id and consent handoff
   - if none exist, expect no-available-shift
9. If create returns `APPLICATION_ALREADY_EXIST`:
   - route should be already-applied
   - do not mark booking succeeded
10. If logs show My Applications navigation after direct selected-schedule success:
   - that is not the official direct selected-schedule handoff
   - official flow goes to consent after job-confirm
11. If logs show a second create after create succeeded and job-confirm failed:
   - that diverges from official selected-schedule behavior
12. If a success notification is delivered:
   - compare the message link with the later `official selected-schedule consent redirect scheduled` URL
   - report stale notification links separately from real redirect failures
13. If a stale selected schedule fallback is logged:
   - check whether a terminal Telegram message was expected
   - if only `booking.succeeded`/`booking.failed` are delivered, verify this fallback is represented as failure or explicitly explain why it is log-only
14. If failure notification has no `errorCode`, `httpStatus`, `failedStage`, or route:
   - improve logging before changing booking logic

## Current Extension Parity Targets

The extension should mimic these official behaviors:

- Selected schedule available:
  - verify schedule when configured
  - create with `scheduleId`
  - `job-confirm`
  - route consent with application id and returned schedule id
- Selected schedule unavailable before create:
  - get all schedules with `pageSize: 1`
  - if any exist, create without `scheduleId`
  - set `scheduleNotAvailable`
  - route consent with application id only
  - if none exist, route no-available-shift
- Create succeeds but job-confirm fails:
  - keep created application
  - route consent with application id only
  - optionally rehydrate reserved application
  - do not create a second application
- Existing application:
  - `APPLICATION_ALREADY_EXIST` routes already-applied
  - resettable variant routes already-applied-but-can-be-reset
- Payload parity:
  - create `dspEnabled` from job detail
  - update `dspEnabled` from created application
  - fallback create-without-schedule omits `candidateId`

## Reference Maintenance Rule

Keep this file current. Whenever future resource-bundle analysis uncovers a reusable official behavior not already captured here, add it in the same turn and sync the installed skill at:

```text
/Users/ankit5076/.codex/skills/analyze-amazon-shifts-logs
```

Add only durable facts from official resources or repeated confirmed logs. Do not add one-off speculation, candidate-specific identifiers, auth/cookie/token details, or temporary debugging guesses.
