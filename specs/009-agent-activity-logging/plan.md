# Implementation Plan: Always-On Agent Activity Logging

**Branch**: `009-agent-activity-logging` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-agent-activity-logging/spec.md`

## Summary

Today, an agent turn's reasoning text is persisted only if the "Show reasoning" setting
(`thinkingVisible`) happens to be on at the time the turn runs (`event-bridge.ts:206,240`), and a
tool call's input arguments and result content are never persisted at all — only `toolName`,
`toolCallId`, `isError`, and `stagedEditId` are recorded (`events.ts:201-219`), even though the
underlying Pi SDK event already carries the full `args`/`result` (confirmed against
`@earendil-works/pi-coding-agent`'s type definitions). This plan decouples capture from display:
`EventBridge` will always persist reasoning and a bounded record of every tool call's
args/result/failure, independent of `thinkingVisible`; the setting becomes purely a frontend
rendering filter applied at read time, so flipping it retroactively reveals or hides
already-recorded detail for any past turn with no re-run and no data loss.

## Technical Context

**Language/Version**: TypeScript 5.9 (Node.js >=26.1.0 backend, Vue 3 frontend)

**Primary Dependencies**: `@earendil-works/pi-coding-agent` (Pi SDK), Fastify 5 (`@fastify/websocket`
for the event stream), Zod (event/DTO contracts in `app/shared/src/contracts`), Vue 3 (frontend)

**Storage**: SQLite, accessed through `StorageAdapter`. Application events are stored as one JSON
`data` blob per row (`conversation_event.data`, `migrations.ts:116-122`) — adding fields to an
existing event type's payload needs no schema migration.

**Testing**: Vitest (`app/backend`: `tests/unit|integration|contract`; runs with
`RADR_BE_PI_FAKE_SESSIONS=1` against `FakeAgentSession`, so this session must be updated in lockstep
with `EventBridge`)

**Target Platform**: Self-hosted Docker deployment (Linux server backend, browser frontend)

**Project Type**: Web application (Fastify backend + Vue frontend monorepo)

**Performance Goals**: No added latency to tool execution or turn streaming; capturing args/result
is a synchronous, in-memory read of data the SDK event already carries — no new I/O beyond the
existing event-persistence write path.

**Constraints**: Per-tool-call persisted result text MUST be bounded (Principle V) so no single
call can grow the event log unboundedly; truncation must be explicit, following the existing
`clampWithNote` convention (`tools/common.ts`) already used for `web_fetch`'s own output bound.

**Scale/Scope**: Single-user, single-document v1 deployment (existing constraint, unchanged by this
feature). Touches: `agent-session-port.ts`, `fake-agent-session.ts`, `event-bridge.ts`,
`app/shared/src/contracts/events.ts`, `app/shared/src/contracts/http.ts`,
`conversation-service.ts`'s `buildMessages`, and a new tool-call display block in
`MessageBubble.vue`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle II (Pi Owns Agent Conversations)**: PASS. This feature reads additional fields
  (`args`, `result`) off the same `AgentSessionEventLike` object Pi already delivers through the one
  sanctioned channel — `session.subscribe(listener)` — via `EventBridge`. It does not read Pi's
  session file/storage format directly; it only widens the app's own port type
  (`agent-session-port.ts`) to stop discarding fields the SDK already puts on that event.
- **Principle V (Configurable Limits Are Enforced, Not Advisory)**: Gate applies directly — the
  persisted tool-call result bound must be a real, enforced cap, not advisory. Addressed in
  Research (Decision 2) and Data Model (`ToolCallRecord.resultText` bound).
- **Principle VI (Sanitize Before Render)**: Gate applies — the new tool-call display block in
  `MessageBubble.vue` renders agent/tool-controlled text (search snippets, fetched page excerpts)
  that is not already covered by the existing message-text sanitization path. Addressed in Phase 1
  (see `contracts/frontend-display.md`): the new block MUST route through the same sanitization
  abstraction as message text, not introduce a second unsanitized rendering path.
- **Principle VII (No Pi Extension Without Demonstrated Necessity)**: PASS. No Pi extension is
  introduced or required; this only changes what the application's own `EventBridge` records from
  the existing SDK event stream.
- **Technology & Platform Constraints (env var naming)**: If a configurable size bound is exposed
  via environment variable, it MUST be `RADR_`-prefixed, consistent with existing convention (e.g.
  alongside `RADR_BE_PI_AGENT_MODEL`).
- All other Core Principles (I, III, IV, VIII) are not implicated: no document-authority, edit
  pipeline, CRDT/revision, or comment-style concerns are touched by this feature.

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/009-agent-activity-logging/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── events-contract.md
│   ├── http-contract.md
│   └── frontend-display.md
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
app/
├── backend/
│   └── src/
│       └── pi/
│           ├── agent-session-port.ts   # widen PiToolExecutionStartEvent with `args`
│           ├── fake-agent-session.ts   # attach args to emitted tool_execution_start
│           ├── event-bridge.ts         # stop gating reasoning on thinkingVisible;
│           │                           # capture args/result on tool_started/tool_completed
│           └── tools/common.ts         # reuse/extend clampWithNote for result truncation
│       └── conversation/
│           └── conversation-service.ts # populate MessageDto.toolCalls (currently hard-coded [])
├── shared/
│   └── src/contracts/
│       ├── events.ts   # extend ToolStartedEvent/ToolCompletedEvent; drop reasoning gating note
│       └── http.ts     # extend MessageDto.toolCalls with args/resultText
└── frontend/
    └── src/components/conversation/
        └── MessageBubble.vue   # new tool-call display block (sanitized), unchanged
                                  # thinkingVisible gating for reasoning text
```

**Structure Decision**: Existing Fastify backend + Vue frontend monorepo layout is unchanged; this
feature is a modification within the existing `app/backend/src/pi`, `app/shared/src/contracts`, and
`app/frontend/src/components/conversation` areas — no new top-level project or package.

## Complexity Tracking

*No Constitution Check violations — this section intentionally left empty.*
