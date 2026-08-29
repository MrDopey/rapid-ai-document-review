# Feature Specification: RADR-Prefixed Environment Variables

**Feature Branch**: `003-radr-env-var-prefix`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Rename every application-defined environment variable across the backend and frontend to be prefixed with RADR_ (the project's acronym, AI Document Review). In scope: backend (app/backend/src/config.ts) — PORT, HOST, DATABASE_PATH, PI_SESSION_STORAGE_PATH, PI_CODING_AGENT_DIR, LOG_LEVEL, PI_FAKE_SESSIONS — becoming RADR_PORT, RADR_HOST, RADR_DATABASE_PATH, RADR_PI_SESSION_STORAGE_PATH, RADR_PI_CODING_AGENT_DIR, RADR_LOG_LEVEL, RADR_PI_FAKE_SESSIONS; frontend (app/frontend/vite.config.ts) — BACKEND_PORT becoming RADR_BACKEND_PORT; test-only variables that mirror these (playwright.config.ts, app/backend/tests/contract/test-app.ts, tests/e2e/env.ts) — PI_LIVE_TEST, E2E_SEED_REVISION_DEBOUNCE_MS and the test-side copies of the vars above get the same RADR_ prefix treatment for consistency. Also apply to docker/docker-compose.yml and README.md documentation. Out of scope: ANTHROPIC_API_KEY (a third-party SDK credential variable, not application-defined), and NODE_ENV (standard Node.js convention) — these keep their standard names. This is a pure rename for naming-convention consistency; no behavior changes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consistent, recognizable configuration surface (Priority: P1)

An operator or developer configuring this application (locally, in CI, or in a deployment) wants every
application-defined environment variable to be immediately recognizable as belonging to this project,
distinguishable at a glance from generic or third-party variables (e.g. a provider credential, or a
platform-standard variable like `NODE_ENV`).

**Why this priority**: This is the entire point of the request — a consistent naming convention reduces
ambiguity when the application is deployed alongside other services, and makes it obvious which variables
this project owns versus which come from elsewhere.

**Independent Test**: List every environment variable this application reads (backend and frontend);
confirm every application-defined one carries the `RADR_` prefix, and confirm the small, explicitly
out-of-scope set (third-party credentials, platform-standard variables) does not.

**Acceptance Scenarios**:

1. **Given** a fresh deployment configured only with `RADR_`-prefixed variables (plus the explicitly
   out-of-scope ones), **When** the application starts, **Then** it behaves identically to how it behaves
   today configured with the current (unprefixed) variable names — this is a rename, not a behavior
   change.
2. **Given** the project's setup documentation, **When** an operator looks up how to configure the
   application, **Then** every documented variable name carries the `RADR_` prefix except the explicitly
   out-of-scope third-party/platform variables, which are called out as exceptions.
3. **Given** the full test suite (unit, contract, and end-to-end), **When** it is run after the rename,
   **Then** all tests pass using only `RADR_`-prefixed configuration internally, with no leftover
   references to the old unprefixed names.

---

### User Story 2 - No silent breakage for anyone still using the old names (Priority: P2)

An operator who has an existing deployment configured with the current (unprefixed) variable names wants
to know, unambiguously, that those names no longer take effect after upgrading — rather than the
application silently starting with unexpected defaults because the old variable was ignored.

**Why this priority**: A pure rename with no compatibility bridge is a breaking change for any existing
deployment; operators need a clear, discoverable signal rather than a silent behavior change. This is
lower priority than User Story 1 because it's a safety net around the rename, not the rename itself.

**Independent Test**: Start the application with only an old, unprefixed variable name set (its `RADR_`-
prefixed counterpart absent) and confirm the resulting behavior (falling back to default, per User Story
1) is clearly discoverable from documentation as the expected post-rename behavior, so operators upgrading
can find the answer without reading source code.

**Acceptance Scenarios**:

1. **Given** documentation for this project, **When** an operator upgrading from a previous version reads
   it, **Then** they can find a clear statement that the variable names changed and what the new names are.

### Edge Cases

- What happens when both an old unprefixed name and its new `RADR_`-prefixed counterpart are set at the
  same time? The `RADR_`-prefixed name is authoritative; the old name is not read at all post-rename (this
  is a rename, not a dual-support period — see Assumptions).
- What happens to variables that are explicitly out of scope (`ANTHROPIC_API_KEY`, `NODE_ENV`)? They are
  unaffected by this feature and keep their current names, since they are not defined by this project
  (third-party SDK credential, and a platform-wide Node.js convention respectively).
- What happens to test-only, ephemeral variables (e.g. those computed from a process ID for test
  isolation) that are never meant to be set by an operator? They are renamed for consistency the same as
  operator-facing ones, since the goal is a uniform naming convention across the whole codebase, not just
  operator-visible surface.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every environment variable that this application (backend or frontend) defines and reads
  for its own configuration MUST be named with a `RADR_` prefix.
- **FR-002**: The application MUST NOT read any of the old, unprefixed variable names after this change —
  this is a rename, not an additive alias; behavior when a variable is absent (default value or required-
  variable error) MUST be unchanged from today, just under the new name.
- **FR-003**: The two variables identified as out of scope (a third-party model-provider credential, and
  the platform-standard Node.js environment-mode variable) MUST be left unchanged, unprefixed.
- **FR-004**: Every place that currently sets or documents one of the renamed variables — deployment
  configuration, test configuration/harnesses, and setup documentation — MUST be updated to the new name
  so no stale reference to an old name remains anywhere in the project.
- **FR-005**: This rename MUST NOT alter any default value, required/optional status, or runtime behavior
  associated with any renamed variable — only its name changes.
- **FR-006**: Project documentation MUST clearly state, for anyone upgrading an existing deployment, that
  variable names changed and MUST list the old → new name mapping.

### Key Entities

- **Environment Variable**: An application-defined configuration name/value pair read from the process
  environment. Each has: current (old) name, new `RADR_`-prefixed name, and the component that reads it
  (backend, frontend, or test harness).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of application-defined environment variables (backend and frontend, excluding the two
  explicitly out-of-scope variables) are read only under their `RADR_`-prefixed name.
- **SC-002**: The full existing automated test suite (unit, contract, end-to-end) passes unchanged in
  behavior after the rename, using only `RADR_`-prefixed configuration internally.
- **SC-003**: An operator upgrading an existing deployment can find the complete old-name → new-name
  mapping in project documentation in under 2 minutes, without reading source code.
- **SC-004**: A fresh deployment configured entirely with new names (plus the two out-of-scope variables)
  starts and behaves identically to an equivalent deployment configured with the pre-rename names.

## Assumptions

- This is a hard rename, not a transitional/dual-support period — the request explicitly frames it as "a
  pure rename for naming-convention consistency," and no deprecation window was requested. Old names stop
  being read the moment this change ships; there is no grace period where both names work.
- "RADR" is confirmed by the user as the project's acronym (AI Document Review) and is the correct,
  intended prefix — not a placeholder needing further confirmation.
- Test-only variables that are purely internal/ephemeral (never set by an operator, e.g. computed from a
  process ID for isolated test runs) are included in the rename for full naming-convention consistency
  across the codebase, even though no operator-facing documentation is needed for them.
- This feature covers naming only; it does not add validation, a compatibility shim, or any new
  configuration capability — that is out of scope here (see the separate, already-planned feature for
  making the Pi agent's model configurable, which independently defines its own `RADR_`-prefixed variable).
