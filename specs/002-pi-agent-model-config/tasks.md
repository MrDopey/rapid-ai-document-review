---

description: "Task list template for feature implementation"
---

# Tasks: Configurable Pi Agent Model

**Input**: Design documents from `/specs/002-pi-agent-model-config/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/environment-config.md, quickstart.md (all present)

**Tests**: Included — plan.md's Testing section and quickstart.md's "Automated coverage" note both call
for unit coverage of `RADR_PI_AGENT_MODEL` parsing and contract coverage of `PiService` session-creation
behavior with/without the override.

**Organization**: Tasks are grouped by user story (spec.md). The actual code change (config parsing +
model resolution) is one small, shared conditional in two existing files that both US1 and US2's
acceptance scenarios exercise — per the Task Generation Rules ("entity serves multiple stories → put in
earliest story or Foundational phase"), that shared implementation lives in Phase 2 (Foundational); each
user-story phase then adds the tests that independently prove *that* story's acceptance scenarios hold.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Foundational/Polish tasks carry no `[Story]` label

## Path Conventions

This is the existing web app monorepo; this feature only touches `app/backend/` and `README.md` (see
plan.md Project Structure — no frontend, schema, or endpoint changes).

---

## Phase 1: Setup

No project initialization, new dependencies, or tooling changes are required — this feature only edits
two existing backend source files, adds test coverage, and updates documentation. Skipping directly to
Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The actual config-parsing and model-resolution change that every user story's tests verify.

**⚠️ CRITICAL**: No user story task can be verified until this phase is complete.

- [X] T001 [P] Add `piAgentModel: string | undefined` to the `Config` interface and parse
  `RADR_PI_AGENT_MODEL` in `app/backend/src/config.ts`, alongside the existing `PI_*` env vars: read the raw
  string via `process.env.RADR_PI_AGENT_MODEL`, and normalize a blank or whitespace-only value to
  `undefined` (FR-005) — do not split/validate the `provider/model[:thinkingLevel]` shape here (research.md
  R3; that happens in `pi-service.ts`).
- [X] T002 [P] Unit test `RADR_PI_AGENT_MODEL` parsing in `app/backend/tests/unit/config.test.ts` (new
  `describe` block, following the existing `HOST` env-reload pattern in that file: `vi.resetModules()` +
  dynamic `import('../../src/config.js')` per case): unset → `undefined`; empty string → `undefined`;
  whitespace-only (`"   "`) → `undefined`; a non-blank string → passed through unchanged (raw, unparsed).
- [X] T003 In `app/backend/src/pi/pi-service.ts`, add a private helper that parses `provider/model` (with
  an optional `:thinkingLevel` suffix) out of `config.piAgentModel` and resolves it via
  `modelRuntime.getModel(provider, id)` (research.md R1 — NOT the package-level `getModel`, so
  `models.json`-defined custom models resolve too). When `config.piAgentModel` is unset, the helper returns
  `undefined`. When it is set but does not parse as `provider/model[:thinkingLevel]`, or
  `modelRuntime.getModel(...)` returns falsy, throw an `Error` whose message names the literal invalid
  value and identifies `RADR_PI_AGENT_MODEL` as the source (FR-006, data-model.md Validation rules).
  *(depends on T001)*
- [X] T004 In `getOrCreateSession()` in `app/backend/src/pi/pi-service.ts`, call the T003 helper only on the
  real-session branch (after the existing `config.piFakeSessions` early return, so FR-004 holds by
  construction — research.md R5) and pass its result as the `model` option into the existing
  `createAgentSession({ ... })` call when defined; when `undefined`, omit `model` entirely so today's SDK
  auto-resolution is unchanged (FR-003). *(depends on T003)*

**Checkpoint**: The override now works end-to-end. Every user-story phase below only adds tests that
prove specific acceptance scenarios against this same code path.

---

## Phase 3: User Story 1 - Pin the agent to a specific model via deployment configuration (Priority: P1) 🎯 MVP

**Goal**: A valid `RADR_PI_AGENT_MODEL` causes every newly created agent session to use that exact
model/provider instead of SDK auto-resolution.

**Independent Test**: Set `RADR_PI_AGENT_MODEL`, start the backend, create a conversation, confirm (via
mocked or live session inspection) the specified model was used.

### Tests for User Story 1

- [X] T005 [US1] Contract test in new file `app/backend/tests/contract/pi-model-config.test.ts`: with
  `vi.mock('@earendil-works/pi-coding-agent', ...)` stubbing `ModelRuntime.create`/`.getModel`,
  `createAgentSession`, `SessionManager`, and `DefaultResourceLoader`, set `RADR_PI_AGENT_MODEL` to a value
  the stubbed `modelRuntime.getModel` resolves, drive `PiService.send(...)` on a fresh conversation, and
  assert the stubbed `createAgentSession` was called with a `model` option equal to the value
  `modelRuntime.getModel` returned (Acceptance Scenario 1). *(depends on T004)*
- [X] T006 [US1] In the same file, a contract test: set `RADR_PI_AGENT_MODEL` to a value that either fails
  to parse as `provider/model[:thinkingLevel]` or that the stubbed `modelRuntime.getModel` resolves to a
  falsy value, drive `PiService.send(...)`, and assert it rejects with an error whose message contains both
  the literal invalid value and `RADR_PI_AGENT_MODEL`, and that the stubbed `createAgentSession` is never
  called (FR-006, Edge Case: unauthenticatable/unresolvable override). *(depends on T005 — same file)*
- [X] T007 [P] [US1] Optional live-SDK confirmation: extend
  `app/backend/tests/contract/live-pi.test.ts`'s existing `PI_LIVE_TEST`-gated `describe.skipIf(!LIVE)`
  block with a scenario that sets `RADR_PI_AGENT_MODEL` to a real, resolvable model before constructing the
  session (mirroring that file's existing `createRealSession` helper) and asserts the resulting session's
  reported model matches the override (quickstart.md Scenario 1). *(depends on T004; independent file from
  T005/T006, so parallelizable with them)*

**Checkpoint**: User Story 1 is independently verifiable — a valid override is honored and mis-set
overrides fail fast and loudly.

---

## Phase 4: User Story 2 - Preserve current behavior when no override is set (Priority: P1)

**Goal**: With no override set (the state of every existing deployment and test run today), behavior is
byte-for-byte unchanged, including under `PI_FAKE_SESSIONS=1`.

**Independent Test**: Start the backend with no override, create a conversation, confirm behavior is
identical to before this feature (and that fake-session mode is untouched by the override either way).

### Tests for User Story 2

- [X] T008 [US2] In `app/backend/tests/contract/pi-model-config.test.ts`, a contract test: with
  `RADR_PI_AGENT_MODEL` unset, drive `PiService.send(...)`, and assert the stubbed `createAgentSession` was
  called with no `model` property (or `model: undefined`) — i.e. today's auto-resolution path is untouched
  (FR-003, SC-002). *(depends on T004; same file as T005/T006/T007, so sequential with those)*
- [X] T009 [US2] In the same file, a contract test: set `process.env.PI_FAKE_SESSIONS = '1'` together with a
  `RADR_PI_AGENT_MODEL` value, drive `PiService.send(...)`, and assert the stubbed `ModelRuntime.create` /
  `createAgentSession` are never called at all (the `FakeAgentSession` path is taken), regardless of the
  override (FR-004, quickstart.md Scenario 3).
- [X] T010 [US2] In the same file, a contract test: set `RADR_PI_AGENT_MODEL` to an empty string, then to a
  whitespace-only string, and confirm both behave identically to "unset" from T008 — no error, no `model`
  passed (FR-005, quickstart.md Scenario 5).

**Checkpoint**: User Stories 1 AND 2 are both independently verifiable against the same Phase 2
implementation — the override is honored when valid, and completely inert when absent, blank, or under
fake sessions.

---

## Phase 5: User Story 3 - Understand available configuration options (Priority: P2)

**Goal**: A developer/operator can learn about `RADR_PI_AGENT_MODEL`, the existing `models.json` mechanism,
and their precedence order from documentation alone.

**Independent Test**: Read only `README.md` and correctly configure the override, and correctly state
which mechanism wins if both are set.

### Implementation for User Story 3

- [x] T011 [US3] Update `README.md`: add a `RADR_PI_AGENT_MODEL` row to the environment variable table
  (after the `PI_CODING_AGENT_DIR` row, ~line 64) with format `provider/model[:thinkingLevel]` and default
  "unset (SDK auto-resolution)", and add a short paragraph immediately after the table stating the
  documented precedence order (contracts/environment-config.md): `RADR_PI_AGENT_MODEL` env override >
  `models.json` custom model definitions (`PI_CODING_AGENT_DIR`) > SDK default/last-used-model
  auto-resolution (FR-008, SC-004).

**Checkpoint**: All three user stories are independently satisfied.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T012 [P] Manually run `specs/002-pi-agent-model-config/quickstart.md` Scenarios 1–6 end-to-end (a
  real provider credential is needed for Scenarios 1, 4, and 6) to confirm the automated tests above match
  real backend behavior. **Not run**: this sandbox has no model provider credential configured; Scenarios
  1, 4, and 6 need a real `ANTHROPIC_API_KEY` (or equivalent) and cannot be exercised here. Scenarios 2, 3,
  and 5 are already covered by the automated contract tests (T008–T010).
- [X] T013 Run the full backend suite (`npm run -w app/backend test` and the default `test:contract`
  script, which excludes `live-pi.test.ts`) to confirm zero regressions for the no-override path (SC-002).
  Confirmed green: `test:unit` 28/28, `test:integration` 24/24, `test:contract` 90/90, plus a clean
  `tsc -b --force` in `app/backend`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: none (skipped).
- **Foundational (Phase 2)**: T001 → T002 can run in parallel with T001 (different files); T003 depends on
  T001; T004 depends on T003. BLOCKS every user-story phase.
- **User Stories (Phase 3–5)**: All depend on Phase 2 completion. T005/T006/T008/T009/T010 share one file
  (`pi-model-config.test.ts`) and so run sequentially relative to each other; T007 (live-pi.test.ts) and
  T011 (README.md) touch different files and can proceed in parallel with the Phase 3/4 test tasks.
- **Polish (Phase 6)**: depends on all prior phases.

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Foundational (Phase 2).
- **User Story 2 (P1)**: Depends only on Foundational (Phase 2) — independent of US1's tests, though they
  share a test file (sequencing, not a functional dependency).
- **User Story 3 (P2)**: Depends only on Foundational (Phase 2) — pure documentation, no code dependency on
  US1/US2 test tasks.

### Parallel Opportunities

- T001 (`config.ts`) and T002 (`config.test.ts`) in parallel.
- Once Phase 2 is done: T007 (`live-pi.test.ts`) and T011 (`README.md`) can proceed in parallel with each
  other and with the T005/T006/T008/T009/T010 sequence in `pi-model-config.test.ts`.

---

## Parallel Example: Phase 2

```bash
Task: "Add piAgentModel parsing to app/backend/src/config.ts"
Task: "Unit test RADR_PI_AGENT_MODEL parsing in app/backend/tests/unit/config.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (T001–T004) — this is the entire feature's code change.
2. Complete Phase 3: User Story 1 tests (T005–T007).
3. **STOP and VALIDATE**: a valid override is honored; an invalid one fails fast.
4. Ship — US2's tests (Phase 4) then formally lock in that this shipped without changing any
   no-override deployment's behavior.

### Incremental Delivery

1. Phase 2 (Foundational) → the feature works end-to-end.
2. Phase 3 (US1 tests) → prove "pin it" works and fails loudly when misconfigured.
3. Phase 4 (US2 tests) → prove zero behavior change for the unset/blank/fake-session cases (SC-002).
4. Phase 5 (US3 docs) → operators can self-serve without reading code (SC-001, SC-004).
5. Phase 6 (Polish) → manual quickstart pass + full suite run.

## Notes

- [P] tasks = different files, no dependencies.
- Phase 2 is intentionally where the real implementation lives (see Organization note above) — the
  per-story phases are almost entirely test tasks against that shared implementation.
- T005/T006/T008/T009/T010 all live in one new contract test file; write them in that order but they may
  be split into one commit each without breaking any other test.
- Verify T005/T006/T008/T009/T010 fail appropriately before Phase 2 is implemented if following strict
  TDD; given Phase 2 is one small shared conditional, this repo's implementer is free to do Phase 2 first
  (as ordered above) since there is no meaningful "story-specific" implementation to hold back.
</content>
