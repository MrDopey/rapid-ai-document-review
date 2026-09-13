# Contract: Application Event Schema Changes

Applies to `app/shared/src/contracts/events.ts`. All changes widen existing event `data` payloads;
no event type is added or removed, and no discriminated-union member changes its `type` literal.

## `MessageCompletedEvent` (unchanged shape, changed guarantee)

```ts
export const MessageCompletedEvent = base(
  'message_completed',
  z.object({
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    reasoning: z.string().nullable(),
  }),
);
```

**Behavioral change**: `reasoning` MUST now be populated whenever the agent produced any, for every
message, regardless of the `thinkingVisible` setting at the time. Previously `null` whenever
`thinkingVisible` was `false` at persist time (`event-bridge.ts:240`).

## `ThinkingDeltaEvent` (unchanged shape, changed guarantee)

**Behavioral change**: MUST now always be buffered (`RunBuffer`) and broadcast during streaming,
regardless of `thinkingVisible`. Previously dropped entirely when `thinkingVisible` was `false`
(`event-bridge.ts:206`).

## `ToolStartedEvent` (widened)

```ts
export const ToolStartedEvent = base(
  'tool_started',
  z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    messageId: z.string(),   // NEW — joins this call to its assistant message segment
    args: z.unknown(),       // NEW — the tool's input parameters, verbatim from the SDK
  }),
);
```

## `ToolCompletedEvent` (widened)

```ts
export const ToolCompletedEvent = base(
  'tool_completed',
  z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    messageId: z.string(),               // NEW — matches ToolStartedEvent.messageId
    isError: z.boolean(),
    resultText: z.string().nullable(),   // NEW — bounded/truncated result text; null iff isError
    failureReason: z.string().nullable(),// NEW — set iff isError; null otherwise
    stagedEditId: z.string().nullable(),
  }),
);
```

**Invariant**: exactly one of `resultText`/`failureReason` is non-null, matching `isError`.

## `EventBridge` behavioral contract changes

- `private thinkingVisible(): boolean` (`event-bridge.ts:400-402`) is removed — no remaining call
  site needs it.
- `tool_execution_start` handling reads `event.args` (added to `PiToolExecutionStartEvent` in
  `agent-session-port.ts`) and the current assistant `messageId` already tracked by the bridge.
- `tool_execution_end` handling derives `resultText`/`failureReason` from `event.result` via a new
  `extractResultText(result, isError)` helper alongside the existing `extractStagedEditId`,
  applying the fixed truncation bound (Research Decision 3).
