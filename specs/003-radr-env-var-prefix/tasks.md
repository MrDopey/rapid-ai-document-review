---

description: "Task list template for feature implementation"
---

# Tasks: RADR-Prefixed Environment Variables

**Input**: Design documents from `/specs/003-radr-env-var-prefix/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/environment-variable-mapping.md, quickstart.md

**Tests**: Not explicitly requested for this feature (pure rename, no new behavior) — the existing automated
suites (unit/contract/e2e) are the verification mechanism (SC-002), not new tests to write.

**Note on scope vs. plan.md**: Phase 0/1 verification (research.md R1) found `FRONTEND_HOST` was missing
from the original request. A further source-level verification pass while writing this task list found
**more** call sites than plan.md's file list — including two entire files not `grep`-verified in Phase 0:
`app/backend/tests/unit/config.test.ts` and `app/backend/tests/integration/restart.test.ts` (both set
several of the renamed variables directly), plus `app/backend/tests/contract/pi-model-config.test.ts` (new
since plan.md was written), and doc-comments (JSDoc/`//`) in several other files that name an old variable
in prose. FR-004 ("no stale reference to an old name remains anywhere in the project") covers all of these,
so every task below reflects the fully-verified inventory, not just plan.md's original list.

## Phase 1: Setup

*No tasks.* This is a pure rename across existing files — no new project, package, dependency, or tooling
initialization is required.

## Phase 2: Foundational

*No tasks.* There is no shared infrastructure that blocks story work: every call site is an independent,
mechanical text edit. User Story 1's file-level tasks can start immediately.

---

## Phase 3: User Story 1 - Consistent, recognizable configuration surface (Priority: P1) 🎯 MVP

**Goal**: Every application-defined environment variable (backend, frontend, and test harnesses) is read
and set only under its `RADR_`-prefixed name; no code path reads an old unprefixed name anymore (FR-001,
FR-002, FR-004, FR-005).

**Independent Test**: Per quickstart.md Scenarios 1–3 — start the backend/frontend with only `RADR_`-
prefixed vars set and confirm identical behavior to today; start with only an old name set and confirm it
has no effect (default is used instead); run the unit + contract test suites and confirm they pass using
only `RADR_`-prefixed configuration internally.

Each task below is one atomic edit: every variable a file *reads* and every variable it *sets* changes
together (research.md R3), using the mapping in `contracts/environment-variable-mapping.md`.

### Real reads/writes (behavior-relevant call sites)

- [x] T001 [P] [US1] Rename in `app/backend/src/config.ts`: `PORT`→`RADR_PORT` (line 48), `HOST`→`RADR_HOST`
  (line 45), `DATABASE_PATH`→`RADR_DATABASE_PATH` (line 50), `PI_SESSION_STORAGE_PATH`→
  `RADR_PI_SESSION_STORAGE_PATH` (line 51), `PI_CODING_AGENT_DIR`→`RADR_PI_CODING_AGENT_DIR` (line 52),
  `LOG_LEVEL`→`RADR_LOG_LEVEL` (line 53), `PI_FAKE_SESSIONS`→`RADR_PI_FAKE_SESSIONS` (line 54). Do not
  change `RADR_PI_AGENT_MODEL` (line 55, already correctly prefixed) or any default value/behavior.
- [x] T002 [P] [US1] Rename in `app/backend/src/server.ts`: `E2E_SEED_REVISION_DEBOUNCE_MS`→
  `RADR_E2E_SEED_REVISION_DEBOUNCE_MS` (both reads, lines 36 and 38).
- [x] T003 [P] [US1] Rename in `app/frontend/vite.config.ts`: `BACKEND_PORT`→`RADR_BACKEND_PORT` (line 4),
  `FRONTEND_HOST`→`RADR_FRONTEND_HOST` (line 11).
- [x] T004 [P] [US1] Rename in `playwright.config.ts`: in the backend `webServer` entry's `env` block,
  `PORT`→`RADR_PORT`, `HOST`→`RADR_HOST`, `DATABASE_PATH`→`RADR_DATABASE_PATH`,
  `PI_SESSION_STORAGE_PATH`→`RADR_PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`→
  `RADR_PI_CODING_AGENT_DIR`, `LOG_LEVEL`→`RADR_LOG_LEVEL`, `E2E_SEED_REVISION_DEBOUNCE_MS`→
  `RADR_E2E_SEED_REVISION_DEBOUNCE_MS`, `PI_FAKE_SESSIONS`→`RADR_PI_FAKE_SESSIONS` (lines 33–43); in the
  frontend `webServer` entry's `env` block, `BACKEND_PORT`→`RADR_BACKEND_PORT` (line 50).
- [x] T005 [P] [US1] Rename in `docker/docker-compose.yml`: `PORT`→`RADR_PORT`, `HOST`→`RADR_HOST`,
  `DATABASE_PATH`→`RADR_DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`→`RADR_PI_SESSION_STORAGE_PATH`,
  `PI_CODING_AGENT_DIR`→`RADR_PI_CODING_AGENT_DIR`, `LOG_LEVEL`→`RADR_LOG_LEVEL` (all keys under `app.
  environment`, lines 9–14). Leave the `ports`/volume config untouched.
- [x] T006 [P] [US1] Rename in `app/backend/tests/contract/test-app.ts`: `DATABASE_PATH`→
  `RADR_DATABASE_PATH` (line 26), `PI_FAKE_SESSIONS`→`RADR_PI_FAKE_SESSIONS` (line 27), `HOST`→`RADR_HOST`
  (line 28), `LOG_LEVEL`→`RADR_LOG_LEVEL` (line 29), `PI_SESSION_STORAGE_PATH`→
  `RADR_PI_SESSION_STORAGE_PATH` (line 30), `PI_CODING_AGENT_DIR`→`RADR_PI_CODING_AGENT_DIR` (line 31).
- [x] T007 [P] [US1] Rename in `app/backend/tests/contract/live-pi.test.ts`: `PI_LIVE_TEST`→
  `RADR_PI_LIVE_TEST` (reads/assertions at lines 49, 303, 304) and update the doc-comment at line 31 that
  names `PI_LIVE_TEST=1`, plus the `PI_CODING_AGENT_DIR` mention in the doc-comment near line 31, to their
  `RADR_`-prefixed names. Do not touch the unrelated `RADR_PI_AGENT_MODEL` override logic (lines 275–291,
  already correctly prefixed by feature 002).
- [x] T008 [P] [US1] Rename in `app/backend/tests/unit/config.test.ts`: every `HOST` reference (doc-comment
  and code, lines 4, 7, 10, 16, 25, 37, 38) → `RADR_HOST`; `DATABASE_PATH` (lines 17, 65) →
  `RADR_DATABASE_PATH`; `LOG_LEVEL` (lines 18, 66) → `RADR_LOG_LEVEL`. Leave `RADR_PI_AGENT_MODEL`
  references (lines 64, 80, 87, 94) unchanged.
- [x] T009 [P] [US1] Rename in `app/backend/tests/contract/pi-model-config.test.ts`: `PI_FAKE_SESSIONS`→
  `RADR_PI_FAKE_SESSIONS` (lines 126, 238–240, including the doc-comment on line 238), `DATABASE_PATH`→
  `RADR_DATABASE_PATH` (line 127), `LOG_LEVEL`→`RADR_LOG_LEVEL` (line 128), and the `HOST` mention in the
  doc-comment at line 69 → `RADR_HOST`.
- [x] T010 [P] [US1] Rename in `app/backend/tests/integration/restart.test.ts`: `HOST`→`RADR_HOST` (line
  34, plus the doc-comment mention near line 24), `DATABASE_PATH`→`RADR_DATABASE_PATH` (line 32, plus the
  doc-comment mention near line 24), `LOG_LEVEL`→`RADR_LOG_LEVEL` (line 35), `PI_SESSION_STORAGE_PATH`→
  `RADR_PI_SESSION_STORAGE_PATH` (line 36), `PI_CODING_AGENT_DIR`→`RADR_PI_CODING_AGENT_DIR` (line 37),
  `E2E_SEED_REVISION_DEBOUNCE_MS`→`RADR_E2E_SEED_REVISION_DEBOUNCE_MS` (line 41).

### Comment-only references (no runtime behavior, still stale per FR-004)

- [x] T011 [P] [US1] Update the `DATABASE_PATH` comment in `tests/e2e/global-setup.ts` (line 5) to
  `RADR_DATABASE_PATH`.
- [x] T012 [P] [US1] Update the `E2E_SEED_REVISION_DEBOUNCE_MS` comment in `tests/e2e/us4.spec.ts` (line
  129) to `RADR_E2E_SEED_REVISION_DEBOUNCE_MS`.
- [x] T013 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in `tests/e2e/us2.spec.ts` (line 3) to
  `RADR_PI_FAKE_SESSIONS`.
- [x] T014 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in `app/backend/tests/contract/http.test.ts`
  (line 33) to `RADR_PI_FAKE_SESSIONS`.
- [x] T015 [P] [US1] Update the `PI_FAKE_SESSIONS`/`DATABASE_PATH` comments in
  `app/backend/tests/contract/ws.test.ts` (lines 16, 553) to `RADR_PI_FAKE_SESSIONS`/`RADR_DATABASE_PATH`.
- [x] T016 [P] [US1] Update the `HOST` comment in `app/backend/src/logging.ts` (line 23) to `RADR_HOST`.
- [x] T017 [P] [US1] Update the `PI_CODING_AGENT_DIR`/`PI_FAKE_SESSIONS` comments in
  `app/backend/src/pi/pi-service.ts` (lines 146, 409) to `RADR_PI_CODING_AGENT_DIR`/`RADR_PI_FAKE_SESSIONS`.
- [x] T018 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in `app/backend/src/pi/fake-agent-session.ts`
  (line 118) to `RADR_PI_FAKE_SESSIONS`.
- [x] T019 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in `app/backend/src/pi/event-bridge.ts` (line
  15) to `RADR_PI_FAKE_SESSIONS`.
- [x] T020 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in `app/backend/src/pi/agent-session-port.ts`
  (line 4) to `RADR_PI_FAKE_SESSIONS`.
- [x] T021 [P] [US1] Update the `PI_FAKE_SESSIONS` comment in
  `app/backend/src/conversation/conversation-service.ts` (line 565) to `RADR_PI_FAKE_SESSIONS`.

### Checkpoint

- [x] T022 [US1] After T001–T021 are all complete, run `npm run test:unit -w app/backend` and
  `npm run test:contract -w app/backend` (the default, non-live contract suite) and confirm every test
  passes using only `RADR_`-prefixed configuration internally (quickstart.md Scenario 3; depends on
  T001–T021).

**Checkpoint**: User Story 1 is fully functional and independently verifiable — every variable is read
only under its new name, and the default automated suites confirm no regression.

---

## Phase 4: User Story 2 - No silent breakage for anyone still using the old names (Priority: P2)

**Goal**: An operator upgrading an existing deployment can find, in documentation, an unambiguous statement
that variable names changed and the complete old→new mapping (FR-006).

**Independent Test**: Per quickstart.md Scenario 5 — open README.md's configuration section and confirm
every variable name shown is `RADR_`-prefixed (except the two explicitly out-of-scope ones) and a mapping
table lets an upgrading operator find every old name's replacement in under 2 minutes.

- [x] T023 [US2] In `README.md`, rename every documented variable to its `RADR_`-prefixed form: the
  configuration table rows for `PORT`, `HOST`, `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`,
  `PI_CODING_AGENT_DIR`, `LOG_LEVEL`, `PI_FAKE_SESSIONS` (lines ~60–67), and every prose mention of these
  names elsewhere in the file (lines ~40, 72, 75, 114, 137, 162, 164, 166). Leave the `ANTHROPIC_API_KEY`
  row/mentions and `NODE_ENV` exactly as worded (FR-003) — do not prefix them.
- [x] T024 [US2] Add an "Upgrading from previous variable names" section to `README.md` (near the
  configuration section) containing the full old→new mapping table from
  `specs/003-radr-env-var-prefix/contracts/environment-variable-mapping.md`'s "Renamed" table, stating
  plainly that the old names are no longer read at all after this change (depends on T023 for a consistent
  final state).

**Checkpoint**: Both user stories are complete — the rename is functionally verified (US1) and fully
discoverable for upgrading operators (US2).

---

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T025 [P] Build/typecheck both packages (`npm run build -w app/backend`, `npm run build -w
  app/frontend` or equivalent `tsc --noEmit`) to catch any remaining unprefixed reference at compile time
  (depends on T001–T021).
- [x] T026 Run a repo-wide search for the 11 old unprefixed names (`PORT`, `HOST`, `DATABASE_PATH`,
  `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`, `LOG_LEVEL`, `PI_FAKE_SESSIONS`,
  `E2E_SEED_REVISION_DEBOUNCE_MS`, `BACKEND_PORT`, `FRONTEND_HOST`, `PI_LIVE_TEST`) outside
  `specs/001-ai-document-review/` and `specs/002-pi-agent-model-config/` (historical planning docs, out of
  scope) and confirm zero remain, satisfying FR-004/SC-001 (depends on T001–T024).
- [x] T027 Run the full Playwright e2e suite (`npm run test:e2e`) and manually validate quickstart.md
  Scenario 4 (`docker compose -f docker/docker-compose.yml up`) to confirm identical end-to-end behavior
  under the new names (SC-002, SC-004; depends on T004, T005, T022).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup / Foundational**: No tasks — nothing blocks User Story 1.
- **User Story 1 (Phase 3)**: T001–T021 have no dependencies on each other (21 independent files) and can
  all run in parallel; T022 depends on all of them.
- **User Story 2 (Phase 4)**: Independent of User Story 1's file edits (touches only `README.md`); can run
  in parallel with Phase 3, though T023 should land before T024 (same file).
- **Polish (Phase 5)**: T025/T026 depend on both stories' tasks being complete; T027 depends on the
  frontend/backend/docker-relevant renames (T004, T005) and the Phase 3 checkpoint (T022).

### Parallel Opportunities

- All of T001–T021 (User Story 1) touch different files and can be done simultaneously.
- User Story 2 (T023–T024, `README.md` only) can proceed in parallel with all of User Story 1, since it
  touches no shared file.
- T025 can run alongside T026 once the renames are in place.

---

## Parallel Example: User Story 1

```bash
# Real read/write call sites — all different files, fully parallel:
Task: "Rename env vars in app/backend/src/config.ts"
Task: "Rename env vars in app/backend/src/server.ts"
Task: "Rename env vars in app/frontend/vite.config.ts"
Task: "Rename env vars in playwright.config.ts"
Task: "Rename env vars in docker/docker-compose.yml"
Task: "Rename env vars in app/backend/tests/contract/test-app.ts"
Task: "Rename env vars in app/backend/tests/contract/live-pi.test.ts"
Task: "Rename env vars in app/backend/tests/unit/config.test.ts"
Task: "Rename env vars in app/backend/tests/contract/pi-model-config.test.ts"
Task: "Rename env vars in app/backend/tests/integration/restart.test.ts"

# Comment-only cleanups — also fully parallel with the above and each other:
Task: "Update stale env-var comment in tests/e2e/global-setup.ts"
Task: "Update stale env-var comment in tests/e2e/us4.spec.ts"
Task: "Update stale env-var comment in tests/e2e/us2.spec.ts"
Task: "Update stale env-var comment in app/backend/tests/contract/http.test.ts"
Task: "Update stale env-var comments in app/backend/tests/contract/ws.test.ts"
Task: "Update stale env-var comment in app/backend/src/logging.ts"
Task: "Update stale env-var comments in app/backend/src/pi/pi-service.ts"
Task: "Update stale env-var comment in app/backend/src/pi/fake-agent-session.ts"
Task: "Update stale env-var comment in app/backend/src/pi/event-bridge.ts"
Task: "Update stale env-var comment in app/backend/src/pi/agent-session-port.ts"
Task: "Update stale env-var comment in app/backend/src/conversation/conversation-service.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 3 (T001–T022): every real call site is renamed and the default test suites pass.
2. **STOP and VALIDATE**: quickstart.md Scenarios 1–3 confirm identical behavior under new names and inert
   old names.
3. This alone satisfies the feature's stated purpose (a consistent, `RADR_`-prefixed configuration
   surface) even before documentation lands.

### Incremental Delivery

1. User Story 1 (rename) and User Story 2 (docs) can be built in parallel — they touch disjoint files.
2. Once both land, run Phase 5 polish (build/typecheck, full repo grep audit, e2e + docker validation) as
   the final gate before considering the feature done.

### Notes

- Every task is a rename or comment update only — no default value, required/optional status, or runtime
  behavior changes anywhere (FR-005).
- `ANTHROPIC_API_KEY` and `NODE_ENV` are untouched by every task in this list (FR-003) — confirmed already
  by research.md R4 and re-confirmed by T026's final audit.
- Commit after each task or logical group (e.g. all of T001–T010, then T011–T021, then T023–T024).
