# Changelog

## Build pipeline fix

- Fixed dist-only runtime failures caused by obfuscator helper-prefix collisions between files such as `content/utils/polling.js` and `content/utils/schedule-automation.js`.
- Replaced the truncated path prefix with a path-derived hash-backed identifier prefix.
- Added an explicit build-time collision guard for obfuscator prefixes.
- Regenerated `dist/amazon-warehouse-ca/` with the corrected build path.
- Updated stale unit tests and Chrome storage stubs to match the refactored constants/storage surface.

## Auth backoff build

- Added authorization-error detection for HTTP 401, HTTP 403, and GraphQL auth/session/token failures.
- Added temporary 2-second polling backoff after 3 consecutive auth-related failures.
- Added automatic recovery after 2 successful fetches or 60 seconds of cooldown.
- Preserved the user-configured interval while using a temporary effective interval during backoff.
- Updated polling toast messaging and documentation for auth-backoff behavior.

## Refactor build

- Centralized static configuration in `shared/constants.js`.
- Added reusable utility modules for text, URL, storage, city tags, and intervals.
- Split background responsibilities into service-worker routing, tab synchronization, and Telegram delivery.
- Split content responsibilities into polling, job-search API, schedule automation, alerts, toasts, login, and Create Application controllers.
- Split popup city-tag rendering into `popup/tag-manager.js`.
- Removed dead, unreachable, and duplicate code paths.
- Updated inline comments to reflect current behavior.
- Preserved the 500 ms / 1 second interval defaults and unit-reset behavior.
- Preserved single-flight polling and dynamic GraphQL authorization handling.
- Fixed Create Application injection route matching to include Canadian application URLs.
- Fixed polling behavior so non-matching returned jobs do not stop future polling.
- Removed an unrelated injected conditional audio block from `vendor/sweetalert.js`.
