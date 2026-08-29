# Phase 0 Research: RADR-Prefixed Environment Variables

No `[NEEDS CLARIFICATION]` markers remain in the spec. This research verifies the complete, exact set of
call sites against the current codebase (rather than trusting the feature description's list at face
value), since a rename this mechanical is only as good as its completeness (FR-004, SC-001).

## R1: Complete inventory of application-defined environment variables (verified against source)

- **Decision**: The authoritative rename list is 11 variables, not the 9 named in the original feature
  request — `FRONTEND_HOST` (read in `app/frontend/vite.config.ts:11`) was missing from the request's
  enumeration but is unambiguously in scope under FR-001 ("every environment variable that this
  application... defines and reads for its own configuration"). Final list, with every call site:

  | Old name | New name | Read at | Set at |
  |---|---|---|---|
  | `PORT` | `RADR_PORT` | `app/backend/src/config.ts:23` | `docker/docker-compose.yml:9`, `playwright.config.ts:33` |
  | `HOST` | `RADR_HOST` | `app/backend/src/config.ts:20` | `docker/docker-compose.yml:10`, `app/backend/tests/contract/test-app.ts:28`, `playwright.config.ts` (`HOST: '127.0.0.1'`) |
  | `DATABASE_PATH` | `RADR_DATABASE_PATH` | `app/backend/src/config.ts:25` | `docker/docker-compose.yml:11`, `app/backend/tests/contract/test-app.ts:26`, `playwright.config.ts` |
  | `PI_SESSION_STORAGE_PATH` | `RADR_PI_SESSION_STORAGE_PATH` | `app/backend/src/config.ts:26` | `docker/docker-compose.yml:12`, `test-app.ts:30`, `playwright.config.ts` |
  | `PI_CODING_AGENT_DIR` | `RADR_PI_CODING_AGENT_DIR` | `app/backend/src/config.ts:27` | `docker/docker-compose.yml:13`, `test-app.ts:31`, `playwright.config.ts` |
  | `LOG_LEVEL` | `RADR_LOG_LEVEL` | `app/backend/src/config.ts:28` | `docker/docker-compose.yml:14`, `test-app.ts:29`, `playwright.config.ts` |
  | `PI_FAKE_SESSIONS` | `RADR_PI_FAKE_SESSIONS` | `app/backend/src/config.ts:29` | `test-app.ts:27`, `playwright.config.ts` |
  | `E2E_SEED_REVISION_DEBOUNCE_MS` | `RADR_E2E_SEED_REVISION_DEBOUNCE_MS` | `app/backend/src/server.ts:36,38` | `playwright.config.ts:39` |
  | `BACKEND_PORT` | `RADR_BACKEND_PORT` | `app/frontend/vite.config.ts:4` | `playwright.config.ts:50` |
  | `FRONTEND_HOST` | `RADR_FRONTEND_HOST` | `app/frontend/vite.config.ts:11` | (undocumented today; operator-set, no current call site sets it) |
  | `PI_LIVE_TEST` | `RADR_PI_LIVE_TEST` | `app/backend/tests/contract/live-pi.test.ts:49,250` | (operator-set at invocation time, e.g. `RADR_PI_LIVE_TEST=1 npm run test:contract:live`) |

  README.md documents `PORT`, `HOST`, `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`,
  `LOG_LEVEL`, `PI_FAKE_SESSIONS`, and `ANTHROPIC_API_KEY` (lines ~40, 60-67, 103, 126, 151-155) — all of
  the renamed ones need updating there; `FRONTEND_HOST`/`PI_LIVE_TEST`/`E2E_SEED_REVISION_DEBOUNCE_MS` are
  not currently documented in README and don't need new documentation added purely for this rename (no
  regression either way), beyond the old→new mapping table required by FR-006.
- **Rationale**: A grep-verified inventory is the only way to satisfy FR-004 ("no stale reference to an
  old name remains anywhere in the project") — relying on the feature request's enumeration alone would
  have silently missed `FRONTEND_HOST`.
- **Alternatives considered**: Renaming only the 9 explicitly-named variables and treating `FRONTEND_HOST`
  as a follow-up — rejected: contradicts FR-001's "every" and would leave one inconsistent, unprefixed
  application-defined variable, defeating the feature's stated purpose (User Story 1).

## R2: Handling `HOST`'s special "must be 127.0.0.1" validation semantics

- **Decision**: The rename does not change `HOST`'s (now `RADR_HOST`'s) documented constraint that it
  "must remain `127.0.0.1`" (README.md:61,153-155) — that behavior lives wherever it's currently enforced
  and is carried over unchanged under the new name; this feature only changes what the variable is called,
  never what it does or how it's validated (FR-005).
- **Rationale**: Explicitly required by FR-005 ("MUST NOT alter any default value, required/optional
  status, or runtime behavior associated with any renamed variable — only its name changes").
- **Alternatives considered**: None — in scope, this is a hard constraint from the spec, not a design
  choice.

## R3: `docker-compose.yml`, `test-app.ts`, `playwright.config.ts` set values that must move together

- **Decision**: Every location that *sets* one of the 11 variables (for the real app, contract tests, or
  e2e tests) is renamed in the same change as the location that *reads* it — these are treated as one
  atomic edit per variable, not staged separately, since a partially-renamed variable (e.g. `config.ts`
  reading `RADR_PORT` while `docker-compose.yml` still sets `PORT`) would silently break that deployment
  path (falling back to `RADR_PORT`'s default instead of erroring, which is exactly the "silent breakage"
  User Story 2 exists to avoid).
- **Rationale**: FR-002 ("MUST NOT read any of the old, unprefixed variable names after this change") is
  only meaningfully verified end-to-end if every setter and every reader change together; verification
  (SC-002: full test suite passes) already forces this in practice for the test-only call sites.
- **Alternatives considered**: A rename with a temporary dual-read shim (read `RADR_X` if set, else fall
  back to reading old `X` with a deprecation warning) — rejected per spec Assumptions: the user's request
  explicitly frames this as "a pure rename... no behavior changes," and FR-002 explicitly forbids reading
  old names at all post-rename.

## R4: `ANTHROPIC_API_KEY` / `NODE_ENV` exclusion — confirming no accidental touch

- **Decision**: Verified via source: `ANTHROPIC_API_KEY` is never read directly in application code
  (confirmed by grep — only mentioned in README.md as an SDK-consumed credential) and `NODE_ENV` is set
  only in `docker/Dockerfile` (`ENV NODE_ENV=production`) and never read anywhere in the codebase. Neither
  needs any code change; README.md's `ANTHROPIC_API_KEY` row/mentions are left exactly as worded (FR-003).
- **Rationale**: Confirms FR-003 is already satisfied by construction — no risk of accidentally
  "helpfully" renaming these during the mechanical pass, since they don't appear anywhere the rename
  touches except as prose in README.md.
- **Alternatives considered**: None needed — this is a verification step, not a design decision.
