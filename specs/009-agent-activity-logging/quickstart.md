# Quickstart: Validating Always-On Agent Activity Logging

## Prerequisites

- Backend and frontend running locally per the repo's normal dev setup (`app/backend`,
  `app/frontend`).
- A document open with at least one conversation.
- Access to inspect persisted events directly, either via the backend's event-log read path or a
  quick SQLite query against `conversation_event` for the relevant `conversation_id`.

## Scenario 1 — Reasoning and tool-call detail are captured while "Show reasoning" is off

1. In Settings, ensure "Show reasoning" is **off** (the default).
2. Start a conversation turn that requires a web search (e.g. ask a question needing current
   information) so the agent calls `web_search`/`web_fetch` and produces reasoning.
3. Once the turn settles, inspect the stored `tool_started`/`tool_completed`/`message_completed`
   events for that turn's `messageId`.
4. **Expected**: `message_completed.data.reasoning` is non-null (if the model reasoned at all);
   `tool_started.data.args` contains the search query/URL; `tool_completed.data.resultText` (or
   `failureReason`, if it failed) is present — all despite "Show reasoning" being off the whole
   time. Confirms FR-001–FR-004, spec Story 1 and Story 3.

## Scenario 2 — Toggling "Show reasoning" retroactively reveals past turns

1. With the turn from Scenario 1 already completed and "Show reasoning" still off, reload/reopen
   that conversation in the UI — reasoning text and the tool-call block should be hidden or absent
   from view (per existing/expected display behavior).
2. Turn "Show reasoning" **on**, without re-running the turn.
3. **Expected**: the same past turn's reasoning becomes visible immediately in the transcript.
   Confirms FR-006, SC-002, spec Story 2.

## Scenario 3 — Tool-call detail is visible regardless of the toggle

1. With "Show reasoning" **off**, view the conversation from Scenario 1 again.
2. **Expected**: the tool-call display block (tool name, search query/URL, result or failure) is
   already visible, even though reasoning text is not — because tool-call detail is not gated by
   the toggle at all (Research Decision 5). Confirms Story 3's independent-test criterion.

## Scenario 4 — Bounded result size

1. Use `web_fetch` against a page known to produce a very large amount of text.
2. Inspect the persisted `tool_completed.data.resultText` for that call.
3. **Expected**: `resultText` length does not exceed the fixed backend bound, and ends with a
   truncation marker when the underlying content was longer. Confirms FR-007/SC-004.

## Scenario 5 — Failed tool call is still recorded

1. Trigger a `web_search`/`web_fetch` call that fails (e.g. an unreachable URL, or the search
   backend down).
2. Inspect the persisted `tool_completed` event for that call.
3. **Expected**: `isError` is `true`, `failureReason` is populated with the failure message, and
   `args` from the paired `tool_started` event still shows what was attempted. Confirms FR-004.
