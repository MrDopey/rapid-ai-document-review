# Tasks: Always-On Agent Activity Logging

**Input**: Design documents from `/specs/009-agent-activity-logging/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Not explicitly requested as TDD in the spec. This feature changes behavior asserted by
existing tests, so updating/extending those existing tests is included as required implementation
work within each story's phase (not as a separate optional TDD section).

**Organization**: Tasks are grouped by user story (spec.md: US1 & US3 are P1, US2 is P2) so each
story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1, US2, or US3, per spec.md
- File paths are exact, repo-root-relative

---

## Phase 1: Setup

**Purpose**: Confirm the working environment; no new dependencies or scaffolding are needed — this
feature only modifies existing modules.

- [X] T001 Confirm `git status` is clean and you're on (or have created) branch
  `009-agent-activity-logging`, then confirm `app/backend` and `app/frontend` dev servers start
  cleanly per the repo's existing scripts (no code changes in this task).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Widen the SDK-facing plumbing and event schemas that both US1 (backend capture) and
US3 (display) depend on. Neither story can be implemented until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] In `app/backend/src/pi/agent-session-port.ts`, add `args?: unknown` to the
  `PiToolExecutionStartEvent` interface (currently `{ type: 'tool_execution_start'; toolCallId:
  string; toolName: string; }`, no `args` field) — this only widens the app's own port type; the
  real SDK's raw event already carries `args` today (per research.md Decision 2) and
  `normalizeRealEvent`'s fallthrough already passes it through untouched.
- [X] T003 [P] In `app/backend/src/pi/fake-agent-session.ts`, attach the tool's actual params object
  (already in scope at each emit site) to every `tool_execution_start` emission — currently emitted
  without `args` at the `propose_document_edit` site (~line 354) and the `read_document` site (~line
  395). If `web_search`/`web_fetch` calls are not yet simulated anywhere in this file, add minimal
  simulation for at least one of them so US1/US3 can be exercised under
  `RADR_BE_PI_FAKE_SESSIONS=1` without a live model.
- [X] T004 In `app/shared/src/contracts/events.ts`, widen `ToolStartedEvent`'s data object (current:
  `{ toolCallId: z.string(), toolName: z.string() }`, lines ~201-204) to add `messageId: z.string()`
  and `args: z.unknown()`, per contracts/events-contract.md.
- [X] T005 In `app/shared/src/contracts/events.ts`, widen `ToolCompletedEvent`'s data object (current:
  `{ toolCallId, toolName, isError, stagedEditId }`, lines ~211-219) to add `messageId: z.string()`,
  `resultText: z.string().nullable()`, and `failureReason: z.string().nullable()`. Per
  data-model.md's Tool Call Record validation rules: "Exactly one of `resultText`/`failureReason` is
  non-null on a given `tool_completed` record's data" (mirroring `isError`), and per the `args` field
  note, tool-call `args` are "Not size-bounded — tool inputs are inherently small (query strings,
  URLs), unlike results."
- [X] T006 In `app/backend/src/pi/event-bridge.ts`, add an `extractResultText(result: unknown,
  isError: boolean): string | null` helper next to the existing `extractStagedEditId` (lines
  ~67-77), which extracts text from `result`'s content (the `AgentToolResult.content` text blocks)
  and truncates it via the existing `clampWithNote` pattern from `app/backend/src/pi/tools/
  common.ts`. Per data-model.md: "`resultText`, when present, MUST NOT exceed the fixed backend
  truncation bound (Research Decision 3); when the underlying result was longer, the stored value
  MUST end with a truncation marker." Define the fixed bound as a new constant in this file (e.g.
  `MAX_TOOL_RESULT_LOG_CHARS`), following the existing `MAX_CONTENT_CHARS`/`MAX_RESULTS`
  hard-coded-constant convention in `tools/web-fetch.ts`/`web-search.ts` (research.md Decision 3 —
  not env-configurable).

**Checkpoint**: Schema and SDK plumbing ready — US1 and US3 implementation can now begin.

---

## Phase 3: User Story 1 - Complete activity record regardless of display setting (Priority: P1) 🎯 MVP

**Goal**: Reasoning and tool-call args/result/failure are always persisted in the application event
log, regardless of the `thinkingVisible` ("Show reasoning") setting at the time.

**Independent Test**: With "Show reasoning" off, run a turn using a search/fetch tool; inspect the
persisted `tool_started`/`tool_completed`/`message_completed` events directly (DB or event-log read
path) and confirm reasoning, args, and result/failure are all present — per quickstart.md Scenarios
1, 4, 5.

### Implementation for User Story 1

- [X] T007 [US1] In `app/backend/src/pi/event-bridge.ts`, remove the `if
  (!this.thinkingVisible()) break;` guard in the `message_update`/`thinking_delta` case (~line 206)
  so the delta is always buffered (`RunBuffer`) and broadcast.
- [X] T008 [US1] In `app/backend/src/pi/event-bridge.ts`, change the `message_end` case (~line 240)
  to always set `reasoning: event.reasoning ?? null` — remove the `this.thinkingVisible() ?`
  ternary. Per data-model.md: "Always populated when the model produced any (was previously `null`
  whenever `thinkingVisible` was off)."
- [X] T009 [US1] In `app/backend/src/pi/event-bridge.ts`, delete the now-dead `private
  thinkingVisible(): boolean` method (~lines 400-402) once T007/T008 remove its only call sites.
- [X] T010 [US1] In `app/backend/src/pi/event-bridge.ts`'s `tool_execution_start` case (~lines
  249-258), populate the new `messageId` (the bridge's currently-tracked assistant message id) and
  `args` (from `event.args`, added in T002/T003) fields on the published `tool_started` event.
- [X] T011 [US1] In `app/backend/src/pi/event-bridge.ts`'s `tool_execution_end` case (~lines
  271-285), populate `messageId` (same id as the paired `tool_started`), and derive `resultText`/
  `failureReason` via `extractResultText` (T006) — `failureReason` set from the tool's error/timeout
  message when `isError` is true, `resultText` otherwise, never both, per data-model.md's invariant.
- [X] T012 [US1] In `app/backend/tests/unit/event-bridge.test.ts`, add a test asserting
  `message_completed.data.reasoning` is non-null after a turn with `thinkingVisible: false` in the
  test's settings fixture (currently no test asserts gating either way here) — proves T007-T009.
- [X] T013 [US1] In `app/backend/tests/unit/event-bridge.test.ts`, add tests asserting
  `tool_started`/`tool_completed` events carry `messageId`/`args` and `resultText`/`failureReason`
  respectively, including one case where the tool call errors (asserts `failureReason` set,
  `resultText` null) — proves T010-T011.
- [X] T014 [US1] In `app/backend/tests/contract/ws.test.ts`, rewrite the test at ~lines 539-580
  ("thinkingVisible toggle affects only subsequent frames, not an in-flight run's already-emitted
  deltas") — this behavior no longer holds since `thinking_delta` must now always emit regardless of
  the setting; replace with an assertion that `thinking_delta` frames are emitted identically whether
  `thinkingVisible` is `true` or `false`.
- [X] T015 [US1] In `app/backend/tests/unit/fake-agent-session.test.ts`, add a test asserting a
  simulated tool call's `tool_execution_start` event includes the `args` object passed to it — proves
  T003.

**Checkpoint**: Backend event log is now a complete, toggle-independent record. Verifiable directly
via the event log without any frontend change (quickstart.md Scenarios 1, 4, 5).

---

## Phase 4: User Story 3 - See what the agent searched for and cited (Priority: P1)

**Goal**: A reviewer can see, in the conversation transcript, exactly what a search/fetch tool call
searched for or fetched, and what it returned or why it failed — independent of the
`thinkingVisible` setting.

**Independent Test**: Ask the agent a question requiring a web search; inspect that turn in the UI
(or its `MessageDto`) and confirm the search query, result URLs/snippets, and any fetched content
are present and legible, regardless of "Show reasoning" — per quickstart.md Scenario 3.

### Implementation for User Story 3

- [X] T016 [US3] In `app/shared/src/contracts/http.ts`, widen `MessageDto.toolCalls`'s array item
  schema (current: `{ toolCallId, name, stagedEditId }`, lines ~308-316) to add `args: z.unknown()`,
  `resultText: z.string().nullable()`, `failureReason: z.string().nullable()`, per
  contracts/http-contract.md.
- [X] T017 [US3] In `app/backend/src/conversation/conversation-service.ts`'s `buildMessages` (~lines
  875-902), replace the hard-coded `toolCalls: []` (line ~888) with logic that joins
  `tool_started`/`tool_completed` events sharing a `messageId` (T010/T011) by `toolCallId`, emitting
  one `toolCalls` entry per call with `name`, `args`, `resultText`, `failureReason`, `stagedEditId`.
  This is a read-time projection over the full stored event log, so it applies retroactively to
  every already-recorded conversation once deployed (no backfill).
- [X] T018 [P] [US3] In `app/backend/tests/unit/conversation-service-tool-call-carrier.test.ts`, add
  assertions that `buildMessages`'s output `toolCalls` array is populated with the expected
  `args`/`resultText`/`failureReason`/`stagedEditId` for a message with tool calls — proves T017.
- [X] T019 [US3] In `app/frontend/src/components/conversation/MessageBubble.vue`, add a new
  tool-call display block rendered for each entry in `message.toolCalls`, unconditional on
  `settings.thinkingVisible` (per contracts/frontend-display.md — Research Decision 5: tool-call
  detail is not gated by "Show reasoning"). Show the tool name, `args` pretty-printed via
  `JSON.stringify(args, null, 2)` inside a `<pre>`/monospace block (formatting is display-only — the
  stored event data stays compact, per contracts/frontend-display.md), and either `resultText` or
  `failureReason` (never both) in a `<pre>`/monospace block. Render all of this as plain
  Vue-interpolated (auto-escaped) text — no `v-html` or other raw-HTML binding, per Constitution
  Principle VI as applied in contracts/frontend-display.md.
- [X] T020 [US3] In `app/frontend/src/style.css`, add CSS rules (scoped in `MessageBubble.vue`'s
  `<style>` block, referencing existing tokens — no new tokens needed in `style.css` itself) so the
  new tool-call block uses `var(--info-color)`/`var(--info-bg)`/`var(--info-border)` for a
  successful call, and `var(--danger-color)`/`var(--danger-bg)` when `isError`/`failureReason` is
  set — reusing the existing, currently-unused info tokens and the existing danger tokens rather than
  inventing new colors, per contracts/frontend-display.md.
- [X] T021 [P] [US3] In `app/frontend/tests/component/MessageBubble.toolCallCarrier.spec.ts` (or a
  new sibling spec file), add a test asserting the new tool-call block renders `args`/`resultText`
  for a message with `toolCalls` set, identically whether `settings.thinkingVisible` is `true` or
  `false` — proves T019's "not gated by the toggle" requirement.

**Checkpoint**: US1 + US3 together deliver the full "see what the agent did" experience in the UI.

---

## Phase 5: User Story 2 - "Show reasoning" becomes a pure display preference (Priority: P2)

**Goal**: Toggling `thinkingVisible` only changes what's currently rendered; it never affects what
was recorded, so turning it on later reveals full past reasoning with no re-run.

**Independent Test**: Flip "Show reasoning" on for an already-completed conversation recorded while
it was off, and confirm previously-hidden reasoning appears immediately, with no re-fetch/re-run —
per quickstart.md Scenario 2.

**Depends on**: Phase 3 (US1) — reasoning must already be unconditionally persisted before this
story's retroactive-visibility guarantee can hold.

### Implementation for User Story 2

- [X] T022 [US2] In `app/frontend/src/components/conversation/MessageBubble.vue`, verify/adjust the
  reasoning-text rendering so it is gated solely on `settings.thinkingVisible` (a client-side
  render-time check), not on whether `message.reasoning` is non-null — since `reasoning` is now
  always populated when produced (T008), any prior logic that treated a null `reasoning` as "nothing
  to show" must not be relied upon to hide it when the toggle is off.
- [X] T023 [US2] In `app/backend/tests/contract/http.test.ts` (or `ws.test.ts`), add an integration
  test: run a turn with `thinkingVisible: false`, then `PATCH /api/settings` to set it `true`, then
  `GET` the conversation and assert the earlier turn's `reasoning` is present in the response — proves
  retroactive visibility requires no re-run (FR-006/SC-002).
- [X] T024 [P] [US2] In `app/frontend/tests/component/MessageBubble.toolCallCarrier.spec.ts`, extend
  the existing toggle test to also assert that reasoning text (not just the tool-call-carrier bubble)
  becomes visible/hidden reactively when `settings.thinkingVisible` changes, without any new fetch.

**Checkpoint**: All three user stories complete — full activity is always captured (US1), visible in
the UI (US3), and the toggle is confirmed to be a pure, retroactive display filter (US2).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T025 Review every comment added/changed across this feature's diff for Constitution Principle
  VIII compliance ("Comments Are Durable, Not Historical") — no comment should narrate this change,
  reference this task list, or explain "why we removed the toggle gate" as history; only durable
  gotchas (if any) may be documented.
- [X] T026 Run through all 5 scenarios in `specs/009-agent-activity-logging/quickstart.md` manually
  end-to-end (dev backend + frontend) and confirm each's expected outcome.
- [X] T027 Run `./scripts/verify.sh` and fix any failures until it exits green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS US1 and US3 (T004-T006 are prerequisites
  for any tool-call capture; T002-T003 are prerequisites for `args` to exist at all).
- **US1 (Phase 3)**: Depends on Foundational. No dependency on US3 or US2 — independently
  deliverable and testable via direct event-log inspection (the MVP).
- **US3 (Phase 4)**: Depends on Foundational, and on US1's `tool_started`/`tool_completed` fields
  (T010-T011) actually being populated, to have data to display.
- **US2 (Phase 5)**: Depends on US1 (T007-T009) for the retroactive-visibility guarantee to hold;
  does not depend on US3.
- **Polish (Phase 6)**: Depends on all desired stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel (different files).
- T018 and T019-T021 within US3 touch different files/layers and can be parallelized across
  developers once T016-T017 land.
- T021 and T024 (different spec files/assertions) can run in parallel with each other once their
  respective implementation tasks land.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (US1) — this alone satisfies the feature's core promise (nothing is silently
   discarded because of a display toggle), verifiable without any UI change.
3. **STOP and VALIDATE**: run quickstart.md Scenarios 1, 4, 5.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → validate via direct event-log inspection → MVP.
3. US3 → validate via UI (quickstart Scenario 3) → full "see what the agent did" experience.
4. US2 → validate retroactive toggle behavior (quickstart Scenario 2) → toggle semantics finalized.
5. Polish → constitution review, full quickstart pass, green `verify.sh`.
