# Phase 1 Data Model: RADR-Prefixed Environment Variables

This feature adds no persistent storage, schema, or domain entity. The only "entity" is the environment
variable naming itself.

## Environment Variable (rename mapping)

| Field | Type | Notes |
|---|---|---|
| `oldName` | string | Current unprefixed name (e.g. `PORT`). Ceases to be read anywhere after this feature (FR-002). |
| `newName` | string | `RADR_`-prefixed replacement (e.g. `RADR_PORT`). |
| `component` | enum: `backend` \| `frontend` \| `test-harness` | Which part of the codebase reads this variable. |
| `inScope` | boolean | `true` for all application-defined variables; `false` for `ANTHROPIC_API_KEY` and `NODE_ENV` (FR-003). |

**Full mapping** (see research.md R1 for verified call sites):

| `oldName` | `newName` | `component` |
|---|---|---|
| `PORT` | `RADR_PORT` | backend |
| `HOST` | `RADR_HOST` | backend |
| `DATABASE_PATH` | `RADR_DATABASE_PATH` | backend |
| `PI_SESSION_STORAGE_PATH` | `RADR_PI_SESSION_STORAGE_PATH` | backend |
| `PI_CODING_AGENT_DIR` | `RADR_PI_CODING_AGENT_DIR` | backend |
| `LOG_LEVEL` | `RADR_LOG_LEVEL` | backend |
| `PI_FAKE_SESSIONS` | `RADR_PI_FAKE_SESSIONS` | backend |
| `E2E_SEED_REVISION_DEBOUNCE_MS` | `RADR_E2E_SEED_REVISION_DEBOUNCE_MS` | backend (test-only hook) |
| `BACKEND_PORT` | `RADR_BACKEND_PORT` | frontend |
| `FRONTEND_HOST` | `RADR_FRONTEND_HOST` | frontend |
| `PI_LIVE_TEST` | `RADR_PI_LIVE_TEST` | test-harness |

**Out of scope** (`inScope: false`, unchanged): `ANTHROPIC_API_KEY`, `NODE_ENV`.

## Validation rules

- No `newName` may collide with an existing, still-unprefixed variable this project reads (verified: none
  of the 11 new names collide with `ANTHROPIC_API_KEY`/`NODE_ENV`, or with each other).
- Every `oldName`'s current default value, "required vs. optional" status, and validation behavior (e.g.
  `HOST`/`RADR_HOST`'s "must be `127.0.0.1`" constraint) carries over unchanged to `newName` (FR-005).
- Every location that *sets* a variable (deployment config, test harness) and every location that *reads*
  it must use the same `newName` — no reader/setter pair may be left mismatched (research.md R3).

## Relationships

- **Environment Variable → Component**: many-to-one; each variable belongs to exactly one component
  (backend config, frontend Vite config, or a test harness), matching today's structure.
- **README documentation row → Environment Variable**: one-to-one for the 7 backend variables already
  documented in README.md's configuration table; this feature updates those rows' names and adds the
  old→new mapping required by FR-006. No new documentation rows are required for the previously-
  undocumented `FRONTEND_HOST`/`PI_LIVE_TEST`/`E2E_SEED_REVISION_DEBOUNCE_MS` (out of scope for this
  rename to newly document them — only their names change, consistent with FR-004's "no stale reference"
  requirement, which concerns renaming existing references, not adding new ones).

No state transitions, no stored entity, no schema/migration changes.
