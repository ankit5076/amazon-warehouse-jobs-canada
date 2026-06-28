# Architecture

## Configuration boundary

`shared/constants.js` is the sole static configuration source. It contains:

- Storage key names
- Message action names
- Backend endpoint paths and fallback defaults
- Amazon routes, country configuration, and GraphQL query metadata
- DOM selectors
- Polling, login, Create Application, schedule, alert, and Telegram timing values
- Install and reset defaults

Runtime files should consume constants instead of embedding selectors, URLs, or timing values.

## Shared utilities

`shared/utils` is reserved for context-neutral helpers:

- `text.js` — escaping, whitespace normalization, and matching normalization
- `url.js` — hiring page route detection and hash-query parsing
- `storage.js` — promise-based Chrome storage wrappers
- `city-tags.js` — city-tag merging and job-city matching
- `intervals.js` — interval defaults and unit conversion

## Background responsibility

- `background/service-worker.js` only wires Chrome events.
- `background/tab-service.js` syncs extension state to tabs and injects the Create Application controller.
- `background/telegram-service.js` formats, deduplicates, and relays Telegram messages.

## Content responsibility

- `content/fetch.js` orchestrates page state and polling.
- `content/utils/job-search.js` performs GraphQL request construction and execution.
- `content/utils/polling.js` provides a single-flight poller.
- `content/utils/schedule-automation.js` handles job-detail schedule/application button automation.
- `content/utils/toasts.js` and `content/utils/alerts.js` handle user feedback.
- `content/login.js` owns auth-page prompt/fill behavior.
- `content/createapp.js` owns the application consent/Create Application page.

## Popup responsibility

- `popup/content.js` handles form state, refresh, reset, and activation.
- `popup/tag-manager.js` handles tag rendering and persistence.

## Removed dead paths

The refactor removed:

- Redundant service-worker sound handlers that could not reliably run in a worker context
- Unused candidate-id message plumbing
- Obsolete commented login and interval code
- Unused helper and placeholder functions
- Popup messages with no receiver


## Auth backoff flow

`content/utils/job-search.js` classifies HTTP and GraphQL authorization failures. `content/fetch.js` owns the runtime backoff state because it already controls polling cadence and page-session synchronization.

Backoff changes only the effective polling delay. It does not overwrite the interval stored by the popup, so the user’s configured value remains stable while the content script temporarily slows requests.


## Distribution build boundary

`scripts/build.js` copies `src/` to `dist/amazon-warehouse-ca/`, obfuscates non-vendor JavaScript, and optionally packages a ZIP. The build creates a unique per-file obfuscator identifier prefix from the relative file path plus a hash. This avoids generated helper-function collisions between classic scripts loaded into the same service-worker, popup, or content-script global scope.
