# Implementation Plan: RADR-Prefixed Environment Variables

**Branch**: `003-radr-env-var-prefix` | **Date**: 2026-08-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-radr-env-var-prefix/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Every application-defined environment variable this project reads today is unprefixed
(`PORT`, `HOST`, `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`, `LOG_LEVEL`,
`PI_FAKE_SESSIONS`, `E2E_SEED_REVISION_DEBOUNCE_MS` in the backend; `BACKEND_PORT` and `FRONTEND_HOST` in
the frontend's Vite config; `PI_LIVE_TEST` in the live-Pi contract test). `FRONTEND_HOST` was not named in
the original feature request but is in scope under FR-001 ("every application-defined environment
variable") — found during Phase 0 verification (research.md R1). This feature is a pure, mechanical rename
of every one of those names to a `RADR_`-prefixed form (e.g. `PORT` → `RADR_PORT`), applied consistently
everywhere a name is read, set, or documented: `app/backend/src/config.ts`,
`app/backend/src/server.ts`, `app/frontend/vite.config.ts`, `playwright.config.ts`,
`app/backend/tests/contract/test-app.ts`, `app/backend/tests/contract/live-pi.test.ts`,
`docker/docker-compose.yml`, and `README.md`. `ANTHROPIC_API_KEY` (third-party SDK credential) and
`NODE_ENV` (platform convention) are explicitly out of scope and keep their current names. No default
value, required/optional status, or runtime behavior changes — only names change. The in-flight
`002-pi-agent-model-config` feature already defines its new variable directly as `RADR_PI_AGENT_MODEL`, so
it needs no change here.

## Technical Context

**Language/Version**: TypeScript (Node.js backend), Vite/TypeScript (frontend config), YAML
(`docker-compose.yml`), Markdown (`README.md`).

**Primary Dependencies**: None new — this only touches existing env-var read/write call sites
(`process.env.*`) already present in the files listed above.

**Storage**: N/A — no persisted data; process environment variables only.

**Testing**: Vitest (`app/backend/tests/unit`, `tests/contract`) and Playwright (`tests/e2e`) — the
existing suites are the verification mechanism (spec SC-002): after the rename, they must all still pass
using only the new names internally.

**Target Platform**: Linux server / Docker (backend + its test harnesses), any OS running the Vite dev
server (frontend), CI runners executing both suites.

**Project Type**: Web application (frontend + backend monorepo) — this feature touches both packages plus
shared root-level config/deployment/test files, but adds no new package or service.

**Performance Goals**: N/A — pure rename, no runtime logic change.

**Constraints**: MUST NOT change any default value, required-vs-optional behavior, or observable runtime
behavior for any renamed variable (FR-005); MUST NOT leave any stale reference to an old name in code,
config, or docs (FR-004); MUST leave `ANTHROPIC_API_KEY`/`NODE_ENV` untouched (FR-003).

**Scale/Scope**: Small, mechanical, but wide-reaching — touches every file that currently names one of
these 11 variables (`PORT`, `HOST`, `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`,
`LOG_LEVEL`, `PI_FAKE_SESSIONS`, `E2E_SEED_REVISION_DEBOUNCE_MS`, `BACKEND_PORT`, `FRONTEND_HOST`,
`PI_LIVE_TEST`), across both packages, root config, and docs — no new files except this spec's own
artifacts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- No Core Principle (I–VII) governs environment-variable naming; this feature does not touch document
  ownership, Pi session ownership/model-interaction semantics, edit proposals, CRDT/revisions, rendering,
  or Pi extensions — it only renames the *keys* used to configure existing, unchanged behavior. **PASS.**
- Technology & Platform Constraints section names no variable-naming convention to comply with or
  conflict with. **PASS.**
- Quality & Review Gates: "every user-facing behavior change MUST be expressible as Given/When/Then" —
  this feature has no user-facing behavior change (spec FR-005), only Given/When/Then scenarios confirming
  *no* behavior change, which the spec already provides. **PASS.**

No violations. Complexity Tracking section is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/003-radr-env-var-prefix/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/backend/
├── src/
│   ├── config.ts                        # rename all 7 PI_*/PORT/HOST/... env var reads
│   └── server.ts                        # rename E2E_SEED_REVISION_DEBOUNCE_MS read
└── tests/contract/
    ├── test-app.ts                      # rename env vars set for contract tests
    └── live-pi.test.ts                  # rename PI_LIVE_TEST

app/frontend/
└── vite.config.ts                       # rename BACKEND_PORT and FRONTEND_HOST reads

playwright.config.ts                     # rename all env vars set for e2e webServer processes
docker/docker-compose.yml                # rename all env vars set for the app service
README.md                                # update documented variable names + old→new mapping (FR-006)
```

**Structure Decision**: No new packages, directories, or services — every change is a rename at an
existing call site in files that already exist. Grouped by the same module boundaries the codebase already
uses (backend config/server, frontend Vite config, root-level deployment/test config, docs).

## Complexity Tracking

*(No Constitution Check violations — section not needed.)*
