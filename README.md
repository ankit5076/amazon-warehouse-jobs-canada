# amazon-warehouse-ca Extension

This extension watches the Amazon hiring job-search page, identifies matching job cards by city tags, navigates to the matching job detail page, and automates the schedule/application click path when the extension is active.

## Project layout

- `shared/constants.js` — all static configuration, selectors, routes, storage keys, defaults, and timing values.
- `shared/utils/*` — reusable text, URL, storage, city-tag, and interval helpers.
- `shared/api-client.js` — backend calls for defaults, license checks, and Telegram notification relay delivery.
- `shared/validation.js` — in-memory backend validation state.
- `shared/telegram.js` — content-side notification dispatch.
- `background/*` — service-worker event routing plus background tab and Telegram services.
- `content/*` — page controllers and content-only services for login, polling, job search, schedule automation, alerts, application observability, and Create Application flow.
- `popup/*` — popup UI controller and city-tag manager.

## Fetch interval defaults

The interval selector uses unit-specific defaults:

- Milliseconds → `850`
- Seconds → `1`

Changing the unit resets the value to that unit’s default. Every scheduled poll
adds 200-800 ms of jitter to the configured base interval.

## Auth-error backoff

The polling engine keeps the user-selected interval as the configured interval. If it sees 3 consecutive authorization-related failures, such as HTTP 401, HTTP 403, or GraphQL auth/session/token errors, it temporarily uses a 2-second base interval plus the normal scheduled jitter.

Backoff ends automatically after either:

- 2 consecutive successful fetches, or
- 60 seconds of cooldown

The popup value is not overwritten during backoff.

## Build output

- `npm run build` regenerates `dist/amazon-warehouse-ca/` from `src/`.
- `npm run package` regenerates `dist/amazon-warehouse-ca/` and writes `amazon-warehouse-ca-<manifest-version>.zip`.
- Distribution JavaScript is obfuscated with per-file identifier prefixes. The build script uses a path-derived hash so scripts that share a browser global scope do not overwrite each other’s obfuscator helper functions.

## Operational notes

- Job polling is single-flight: a second request is never started while the prior request is still running.
- GraphQL authorization is derived from page session values and is never a literal placeholder token.
- Create Application injection covers current and legacy application URL path variants.
- Polling continues when job cards are returned but none match configured city tags.
- Application observability begins only after a matched job exists. Empty polling,
  no-match polling, and routine pre-match GraphQL failures should not emit tracker
  application-attempt rows.
- Observability POSTs are non-blocking and must continue even if the extension active
  toggle is turned off mid-attempt.
- Popup log mode controls console verbosity only; tracker-service observability delivery
  must remain independent from console logging.

## Observability payload guardrails

Keep application-attempt payloads compact:

- include IDs, version, operator/client context, selected job/schedule context,
  outcome, key durations, and a small event timeline
- do not send full GraphQL responses, full job lists, DOM snapshots, auth
  headers, cookies, WAF tokens, or credentials
- store only short-lived pending trace state across navigation and clear it after
  terminal flush or TTL expiry

## Verification

After source, config, test, build-script, manifest, or content-loader changes:

```bash
npm test -- --run
npm run verify:bundle
git diff --check
```

Also bump the minor extension version in `src/manifest.json` for source/config/
test/build changes. Documentation-only updates are exempt.


## TODO
Honest remaining difference: Amazon’s official UI has a fallback where, if the selected schedule is unavailable, it may create an application without that schedule if other schedules exist. Our extension still cools down the stale schedule and returns to search, which is faster/safer for grabbing the exact selected shift but not 100% identical to website behavior.
