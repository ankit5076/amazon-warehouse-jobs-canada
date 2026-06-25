# Admin Validation Gate Architecture

## Summary

Create one shared extension-wide admin gate so the Amazon Shifts extension is unusable until an admin username is entered and freshly validated by `/api/amazon-shifts/runtime`.

Chosen behavior:

- Fresh backend validation on unlock points.
- While missing, invalid, expired, disabled, or network-unvalidated: only the admin username field and validation feedback are usable.
- The tracker-service remains the source of truth for admin validity, including enabled status and end date.

## Key Changes

- Add `AMZ_ADMIN_GATE` as a shared module loaded after `api-client.js` and `validation.js`.
- Public API:
  - `unlock({ username, allowCache, reason })`: fresh-validates by default at unlock points, stores an in-memory allowed/denied status, returns `{ allowed, username, policy, reason }`.
  - `requireAllowed({ allowCache, reason })`: returns the valid policy or throws typed gate errors.
  - `getStatus()`: returns current gate state for UI.
  - `clear()`: clears gate state and runtime policy cache when username changes.
  - Error codes: `missing_admin_username`, `invalid_admin_username`, `admin_validation_unavailable`.
- Replace the current "non-empty username" API guard with a "valid admin" guard.
  - `/clients` must call `AMZ_ADMIN_GATE.requireAllowed()` before any network/proxy request.
  - Telegram backend relay should also be treated as gate-required.
  - `/runtime`, `/config/defaults`, and `/license/check` remain ungated because they are needed to validate or bootstrap.
- Popup becomes a locked UI shell until gate unlock succeeds.
  - On popup open: load stored username; if present, call `unlock({ allowCache: false, reason: "popup-open" })`.
  - On username input: save normalized username, clear cached policy/gate state, disable controls, debounce fresh validation.
  - On Activate, Fetch Users, Refresh, client selection, and settings writes: call `requireAllowed()` first.
  - Invalid username must not open the client modal or call `apiGetClients()`.
- Background/content scripts use the same gate.
  - Service worker startup and username changes call `unlock({ allowCache: false })`; invalid result forces `ACTIVE=false` and syncs inactive state to tabs.
  - Main job-search content script delegates `ensureRuntimeAllowed()` to `AMZ_ADMIN_GATE`.
  - Direct application script must load account/api/validation/admin-gate and validate before any direct application workflow, not just check `ACTIVE`.

## Test Plan

- Add `admin-gate.test.js` for missing username, invalid username, valid username, stale username, cache use after fresh unlock, and fail-closed network errors.
- Update popup tests:
  - Missing or invalid admin keeps every control disabled except username.
  - Fetch Users does not open modal and does not call `/clients`.
  - Valid admin unlock enables controls and allows client fetch.
- Update API client tests:
  - `/clients` rejects before fetch/proxy when admin is missing or invalid.
  - `/clients` proceeds after a valid gate unlock.
  - Direct `backendRequest("/clients")` is also protected.
- Update content/background tests where available:
  - Active state is forced false on invalid admin.
  - Direct application run is skipped when gate is not allowed.
- Run `npm test` in `amazon-shifts`.

## Assumptions

- This plan enforces extension behavior; it does not change tracker UI `/api/amazon-shifts/clients` routes because the admin web page currently uses those endpoints directly.
- Backend admin validity remains defined by the existing `/runtime?username=...` response.
- Existing runtime policy cache can be reused only after a fresh unlock has succeeded for the same username.
