# Contract: Environment Variable Old→New Name Mapping

This feature's only external interface is the set of environment variable names operators, CI, and
deployment configs use to configure the application. This is the authoritative contract (FR-006) —
publish this table (or a copy of it) in README.md.

## Renamed (old name no longer read after this change — FR-002)

| Old name | New name | Component | Default / behavior (unchanged — FR-005) |
|---|---|---|---|
| `PORT` | `RADR_PORT` | backend | `3000` |
| `HOST` | `RADR_HOST` | backend | `127.0.0.1`; must remain `127.0.0.1` or the backend refuses to start |
| `DATABASE_PATH` | `RADR_DATABASE_PATH` | backend | `./data/document-review.sqlite` |
| `PI_SESSION_STORAGE_PATH` | `RADR_PI_SESSION_STORAGE_PATH` | backend | `./data/pi-sessions` |
| `PI_CODING_AGENT_DIR` | `RADR_PI_CODING_AGENT_DIR` | backend | `./data/pi-agent` |
| `LOG_LEVEL` | `RADR_LOG_LEVEL` | backend | `info` |
| `PI_FAKE_SESSIONS` | `RADR_PI_FAKE_SESSIONS` | backend | unset (disabled); `1` enables fake sessions |
| `E2E_SEED_REVISION_DEBOUNCE_MS` | `RADR_E2E_SEED_REVISION_DEBOUNCE_MS` | backend (test-only) | unset (no override) |
| `BACKEND_PORT` | `RADR_BACKEND_PORT` | frontend | `3000` (Vite dev-server proxy target) |
| `FRONTEND_HOST` | `RADR_FRONTEND_HOST` | frontend | `127.0.0.1` |
| `PI_LIVE_TEST` | `RADR_PI_LIVE_TEST` | test-harness | unset (live-Pi contract test skipped) |

## Unchanged (explicitly out of scope — FR-003)

| Name | Reason |
|---|---|
| `ANTHROPIC_API_KEY` | Third-party model-provider credential, not application-defined; consumed internally by the Pi Coding Agent SDK, never read directly by this application's own code. |
| `NODE_ENV` | Standard Node.js platform convention (set in `docker/Dockerfile`, not read by application code). |

## Behavior contract

1. **Before this feature**: application reads/sets only the "Old name" column.
2. **After this feature**: application reads/sets only the "New name" column; the "Old name" values, if
   still present in an operator's environment, have no effect at all (not read, not merged, not warned
   about at runtime — the discoverability requirement, FR-006, is satisfied by documentation, not a
   runtime warning).
3. Every default value, required/optional status, and validation rule (e.g. `RADR_HOST` must be
   `127.0.0.1`) is identical to its pre-rename counterpart.
4. `ANTHROPIC_API_KEY` and `NODE_ENV` behave identically before and after this feature ships — untouched.

## Non-goals

- No dual-read/back-compat shim for old names (spec Assumptions: this is a hard rename).
- No new environment variable, no new default, no new validation behavior — purely a naming change.
