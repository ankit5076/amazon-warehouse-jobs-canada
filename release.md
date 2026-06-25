# Release Notes

## Unreleased

- Kept post-create booking failures observable, shared stale-schedule cooldown through tracker-service, required fresh auth before hot polling, and added a fast application-route fallback after Apply clicks.
- Removed the legacy My Applications redirect timer after native Create Application clicks so Amazon's native form route owns successful manual/fallback application flow.
- Moved direct-booking post-confirm workflow observability behind the success notification/handoff path and appended the extension version to every Telegram message.
- Made country-scoped Amazon application form pages observability-only: record form-opened, clear Select Shift handoff, disable active automation, and prevent Create Application/My Applications side-effect clicks.
- Stopped GraphQL-confirmed disappeared schedules from suppressing future job matching and made the pre-match jobs toast neutral until a job truly matches.
- Mark matched jobs whose schedule GraphQL recovery confirms zero schedules as `SCHEDULE_DISAPPEARED_AFTER_MATCH`, making tracker analytics distinguish filter matches from vanished inventory.
- Set the local default fetch interval to 850 ms and added 200-800 ms scheduled poll jitter so active polling is less mechanically timed without delaying post-match booking API steps.
- Added a delayed one-time Amazon auth-probe recheck on the job-search route so polling can recover when Amazon hydrates login state just after the first route probe.
- Rechecked the Amazon session on the job-search route before redirecting to login, preventing stale auth-probe state from looping users back to login immediately after a successful sign-in.
- Blocked activation, polling, login automation, and job-search page refresh unless a tracker client is selected, so stale `__ap=true` cannot poll Amazon GraphQL after users are reset or not loaded.
- Renamed the manual application fallback entry point to lowercase `content/createapp.js` so source casing matches injection and build references.
- Moved direct-application mode and guard lookup helpers into shared content utilities so booking and native UI fallback controllers no longer duplicate mode/guard logic.
- Started terminal booking observability posts before extra storage enrichment so zero-delay redirects are less likely to drop tracker-service rows.
- Ignored stale operator-runtime validation responses and preserved the valid policy cache during same-operator popup refreshes to avoid accidental Activate resets.
- Kept activation from resetting during transient runtime-policy fetch failures when a fresh cached valid policy exists for the same operator.
- Renamed application-attempt internals to observability and changed Telegram relay payloads to notification text.
- Added categorized, timestamp-stable observability timeline events for extension JS/control gaps so tracker analytics can expose workflow bottlenecks without increasing Telegram noise.
- Removed muted observability/progress Telegram notification events so Telegram only carries job-found and terminal booking success/failure while tracker observability keeps step-level workflow detail.
- Removed the popup debug-log download feature flag, persisted console-log buffer, and JSON export button while keeping standard/debug/off console log mode.
- Refactored MV3 internals with shared messaging helpers, focused direct-application guard/WAF modules, and a pure job-match helper while preserving the maximum-speed booking path.
- Removed unreferenced Bootstrap/vendor style files and `src/.DS_Store` to reduce extension footprint.
- Updated governance/testing instructions for messaging, loader updates, direct-booking submodules, and dead-code deletion rules.
