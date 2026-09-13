# Phase 0 Research: Always-On Agent Activity Logging

No `[NEEDS CLARIFICATION]` markers remain in the Technical Context — this feature modifies an
existing, well-understood subsystem (`EventBridge`) rather than introducing new technology. The
items below are the concrete design decisions this research resolved.

## Decision 1: Where reasoning-gating and args/result capture must change

**Decision**: Change exactly two persistence sites in `event-bridge.ts`, and add args/result
capture at the two existing tool-event sites — no new event types.

- `message_update` / `thinking_delta` (`event-bridge.ts:205-217`): remove
  `if (!this.thinkingVisible()) break;` — always buffer and broadcast.
- `message_end` (`event-bridge.ts:230-242`): always set `reasoning: event.reasoning ?? null` —
  remove the `thinkingVisible() ?` ternary.
- `tool_execution_start` (`event-bridge.ts:249-258`) and `tool_execution_end` (:271-285): add
  `args` and a bounded `resultText`/failure record respectively. These two sites are **not**
  currently gated by `thinkingVisible` at all (unlike reasoning) — they were simply never capturing
  the extra fields in the first place, per FR-002/FR-003.
- `EventBridge.thinkingVisible()` (:400-402) becomes dead code once both call sites are removed and
  can be deleted.

**Rationale**: This is the minimal change that satisfies FR-001–FR-005 without inventing a new
event-sourcing mechanism — it reuses the exact `tool_started`/`tool_completed`/`message_completed`
event types that already exist, only widening their `data` payloads (no migration needed, per the
JSON-blob storage confirmed in Technical Context).

**Alternatives considered**: A new `tool_call_recorded` event type combining start+end into one
row was considered, but rejected — it would duplicate `tool_started`/`tool_completed`'s existing
role and complicate the "late/orphaned event" handling `EventBridge` already has for a settled run
(`event-bridge.ts:143-159`).

## Decision 2: Raw `args`/`result` are already available; only the port type hides them

**Decision**: Widen `PiToolExecutionStartEvent` (`agent-session-port.ts:46-50`) to include
`args?: unknown`, and update `FakeAgentSession` to attach the params object it already holds at
emit time (`fake-agent-session.ts:354,395`, and any `web_search`/`web_fetch` simulation added
there). No change needed for `result` on `tool_execution_end` — `PiToolExecutionEndEvent` already
declares it (`agent-session-port.ts:58-64`), and `normalizeRealEvent`'s fallthrough (`return
rawEvent;`, line 397) already passes the real SDK's `args`/`result` through untouched at runtime
today — they are just never read.

**Rationale**: Confirmed against `@earendil-works/pi-coding-agent`'s own type definitions
(`node_modules/.../extensions/types.d.ts:593-614` and the underlying `pi-agent-core`
`AgentEvent` union) that the real SDK's `tool_execution_start` carries `args: any` and
`tool_execution_end` carries `result: any` — this is not new SDK surface, just previously-unread
data on an event the app already subscribes to.

**Alternatives considered**: Re-deriving args from the tool's own `execute()` call via a wrapper in
each tool file (`web-search.ts`, `web-fetch.ts`, ...) was considered, but rejected as more invasive
— it would require touching every tool definition instead of one central point
(`EventBridge`/`FakeAgentSession`), and the SDK already hands the data to the one place that needs
it.

## Decision 3: Result/failure size bound and truncation convention

**Decision**: Cap the persisted `resultText` for a tool call at a fixed size (reuse the existing
`clampWithNote` helper pattern from `tools/common.ts`, currently used for `web_fetch`'s own
`MAX_CONTENT_CHARS` bound), and always record a call that errored or timed out with its `args` and
a failure reason string instead of `resultText`.

**Rationale**: Satisfies FR-007/SC-004 (bounded storage) and Constitution Principle V (limits must
be enforced, not advisory) using a convention already proven in this codebase, rather than
introducing a new truncation scheme. The exact numeric cap is an internal backend constant (not
user- or per-call-configurable), matching the existing `MAX_CONTENT_CHARS`/`MAX_RESULTS` pattern in
`tools/web-fetch.ts`/`web-search.ts`.

**Alternatives considered**: An environment-variable-configurable cap (`RADR_BE_...`) was
considered for parity with `RADR_BE_PI_AGENT_MODEL`-style config, but rejected for v1 as
unnecessary configurability — the existing web-tool bounds are hard-coded constants for the same
reason (research.md R4 from spec 008), and Assumptions in `spec.md` already state the bound is
backend-configured, not per-call.

## Decision 4: Correlating a tool call with its message for display

**Decision**: Add `messageId` to the `tool_started`/`tool_completed` event `data` payload, sourced
from `EventBridge`'s already-tracked current assistant message id (the same id used for
`textBufferKey`/`reasoningBufferKey`), so `conversation-service.ts`'s `buildMessages` can group a
message's tool calls by `messageId` when populating `MessageDto.toolCalls` (currently hard-coded to
`[]` at `conversation-service.ts:888`).

**Rationale**: `MessageDto.toolCalls` already has a shape for this (`http.ts:308-316`) but nothing
populates it because there is no key to join `tool_started`/`tool_completed` events back to the
"tool-call carrier" message segment they belong to. `messageId` is the natural join key already
used for every other per-message event in this bridge.

**Alternatives considered**: Joining by `toolCallId` proximity/ordering within a turn (no explicit
key) was considered, but rejected as fragile — a turn can contain multiple tool calls, and ordering
alone doesn't guarantee correct association if events are replayed out of arrival order after a
reconnect.

## Decision 5: Frontend gating — reasoning stays behind `thinkingVisible`; tool-call facts do not

**Decision**: `thinkingVisible` continues to gate only the model's internal reasoning text
(unchanged frontend behavior in `MessageBubble.vue`). The new tool-call display block (name,
args, bounded result/failure) is **not** gated by `thinkingVisible` — it renders unconditionally,
since it is a factual record of what the agent did (comparable to today's always-visible
`tool_started`/`tool_completed` status), not the model's internal reasoning.

**Rationale**: The setting is explicitly named "Show reasoning" and its existing scope (per
`stores/settings.ts`, `event-bridge.ts`) is the model's chain-of-thought text, not tool-call
bookkeeping — `tool_started`/`tool_completed` are already unconditionally persisted/broadcast today
(never gated), so adding args/result to them is consistent with their existing always-visible
status, not a scope change. This resolves the open question left in `spec.md`'s Assumptions in
favor of the narrower, less surprising reading of "the toggle" (matches FR-005's literal text: the
toggle affects rendering of *reasoning*, not of tool-call detail).

**Alternatives considered**: Gating tool-call detail behind `thinkingVisible` as well (so both are
one on/off pair) was considered, since Story 3's acceptance criteria say tool-call detail must be
visible "independent of whether Show reasoning is on" — which this decision satisfies more directly
by never hiding it at all, rather than by adding a second on/off state to reconcile with the first.
