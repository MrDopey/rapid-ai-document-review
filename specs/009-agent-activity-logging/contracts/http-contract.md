# Contract: HTTP/Read-Model DTO Changes

Applies to `app/shared/src/contracts/http.ts`'s `MessageDto` and its population in
`conversation-service.ts`'s `buildMessages`.

## `MessageDto.toolCalls` (widened, and now actually populated)

Current (`http.ts:308-316`):

```ts
toolCalls: z
  .array(
    z.object({
      toolCallId: z.string(),
      name: z.string(),
      stagedEditId: z.string().nullable().optional(),
    }),
  )
  .optional(),
```

New:

```ts
toolCalls: z
  .array(
    z.object({
      toolCallId: z.string(),
      name: z.string(),
      args: z.unknown(),
      resultText: z.string().nullable(),
      failureReason: z.string().nullable(),
      stagedEditId: z.string().nullable().optional(),
    }),
  )
  .optional(),
```

## `buildMessages` behavioral contract change

`conversation-service.ts:875-902` currently hard-codes `toolCalls: []` for every message. It MUST
instead, for each `message_completed` row, collect every `tool_started`/`tool_completed` event pair
whose `messageId` matches that message's `messageId`, and emit one `toolCalls` entry per
`toolCallId`, joining the pair's fields (`args` from `tool_started`, `resultText`/`failureReason`/
`isError`/`stagedEditId` from `tool_completed`).

This projection runs at read time over the full stored event log (same pattern already used for
`isToolCallCarrier` via `computeIsToolCallCarrier`), so it automatically applies to every
previously-recorded conversation once this feature ships — no backfill job needed, since the
underlying events already carry everything required as of the deploy that starts writing `args`/
`resultText`.

## No REST endpoint shape changes

No new endpoint, no changed request shape, no changed status codes. `GET` conversation/message
endpoints that already return `MessageDto` transparently gain the wider `toolCalls` array.
