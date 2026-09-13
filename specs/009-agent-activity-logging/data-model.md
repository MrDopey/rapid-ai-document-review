# Phase 1 Data Model: Always-On Agent Activity Logging

No new tables or top-level entities are introduced — this feature widens the payload of three
existing, already-persisted event types and one existing read DTO. All three events already live in
`app/shared/src/contracts/events.ts` and are stored in the single JSON `data` blob column
(`conversation_event.data`), so no migration is required.

## Turn Activity Record (conceptual — not a new table)

The combination of one `message_completed` event plus every `tool_started`/`tool_completed` event
sharing its `messageId`, for one turn. Always fully captured going forward, independent of the
`thinkingVisible` display preference (spec FR-001–FR-005).

| Field | Source | Notes |
|---|---|---|
| `reasoning` | `MessageCompletedEvent.data.reasoning` | Always populated when the model produced any (was previously `null` whenever `thinkingVisible` was off). |
| `text` | `MessageCompletedEvent.data.text` | Unchanged — already always captured. |
| tool calls | `ToolStartedEvent`/`ToolCompletedEvent` rows sharing `messageId` | See Tool Call Record below. |

## Tool Call Record

One invocation of a tool during a turn. Represented across the existing `tool_started` (on start)
and `tool_completed` (on end) event pair, joined by `toolCallId`.

| Field | Type | Event | Notes |
|---|---|---|---|
| `toolCallId` | `string` | both | Existing, unchanged join key. |
| `toolName` | `string` | both | Existing, unchanged. |
| `messageId` | `string` | both (**new**) | Added per Research Decision 4 — the assistant message segment this tool call belongs to; lets `buildMessages` group calls per message. |
| `args` | `unknown` (**new**) | `tool_started` | The tool's input parameters (e.g. `{ query }` for `web_search`, `{ url }` for `web_fetch`), taken verbatim from the SDK's `tool_execution_start.args`. Not size-bounded — tool inputs are inherently small (query strings, URLs), unlike results. |
| `isError` | `boolean` | `tool_completed` | Existing, unchanged. |
| `resultText` | `string \| null` (**new**) | `tool_completed` | A bounded, truncated string derived from `tool_execution_end.result`'s content (per Research Decision 3). `null` when `isError` is true and there is no partial output. |
| `failureReason` | `string \| null` (**new**) | `tool_completed` | Populated instead of `resultText` when `isError` is true — the tool's own error/timeout message (FR-004). |
| `stagedEditId` | `string \| null` | `tool_completed` | Existing, unchanged. |

**Validation rules**:
- `resultText`, when present, MUST NOT exceed the fixed backend truncation bound (Research Decision
  3); when the underlying result was longer, the stored value MUST end with a truncation marker
  (consistent with `clampWithNote`'s existing convention), satisfying FR-007.
- Exactly one of `resultText`/`failureReason` is non-null on a given `tool_completed` record's data
  (mirroring `isError`).

## Display Preference (`thinkingVisible`) — unchanged schema, narrowed semantics

No schema change. `user_settings.thinkingVisible` (and `SettingsChangedEvent.data.thinkingVisible`)
remain exactly as they are today. What changes is only where the check is performed: previously
enforced in the backend (`EventBridge`, gating persistence/broadcast), it is now enforced only in
the frontend's own render logic (`MessageBubble.vue`), per Research Decision 5 — reasoning text is
gated there; the new tool-call display block is not gated by this preference at all.

## Read-side DTO: `MessageDto.toolCalls`

`app/shared/src/contracts/http.ts:308-316` already declares a `toolCalls` array on `MessageDto` but
`conversation-service.ts`'s `buildMessages` hard-codes it to `[]` (line 888). This field gains the
same new attributes as the Tool Call Record above:

```
toolCalls: {
  toolCallId: string
  name: string
  args: unknown            // new
  resultText: string | null    // new
  failureReason: string | null // new
  stagedEditId: string | null
}[]
```

`buildMessages` is updated to actually populate this array by joining `tool_started`/
`tool_completed` rows on `messageId` (new field) and `toolCallId`, for every message in the
conversation — not just newly-recorded ones, since this is a read-time projection over the
(now-complete) event log.
