# Contract: Archiving Main

Extends `POST /api/conversations/:id/close` (`specs/001-ai-document-review/contracts/http-api.md`)
and reuses its existing `conversation_closed`/`conversation_started` WS events
(`specs/001-ai-document-review/contracts/websocket-events.md:113,117`). No new route and no new
event types are introduced — only a `kind`-specific behavior branch inside the existing close
operation, plus one new field and one new error code.

## `POST /api/conversations/:id/close`

Request body is unchanged (`CloseConversationRequest { foldSummaryIntoParent: boolean }`); for a
Main conversation, `foldSummaryIntoParent` is ignored (Main has no parent to fold into — mirrors
today's `willFold` check, which is already `false` whenever `parentId` is `null`).

### Behavior when the target conversation's `kind === 'main'`

1. Same preconditions as any other close:
   - `409 PENDING_EDITS_BLOCK_CLOSE` if any staged edit is still `pending` (unchanged, existing
     check).
   - `409 CONVERSATION_BUSY` (**new**) if `status === 'working'` — this guard is added to `close()`
     uniformly, so it applies to every kind, not just Main.
2. On success, atomically (single storage transaction):
   - The target Main: `status: 'closed'`, `closedAt` set, `isCurrentMain: false`. If it was
     Primary, Primary clears with no transfer (existing `PrimaryService.closeClears`, unchanged
     behavior — FR-007).
   - A new Main conversation is created in the same document: `kind: 'main'`, `isCurrentMain:
     true`, `isPrimary: false`, `parentId: null`, seeded with a fresh document excerpt using the
     same mechanism as Main's initial creation (FR-008).
3. Response body: unchanged shape, `CloseConversationResponse { conversationId, status: 'closed',
   summaryFoldedIntoParent: false, parentConversationId: null }`, describing the *archived*
   conversation (the one the client called close on) — consistent with every other `close` call.
   The new Main is not embedded in this response; the client learns about it exactly the way it
   learns about any newly created conversation — the `conversation_started` WS event below — since
   a document already guarantees exactly one live WS connection driving all conversation state
   (Constitution Principle I).

### What does NOT change

- The request/response schema shapes.
- The event *types* emitted (`conversation_closed`, `conversation_started`) — only that
  `conversation_started` for a Main-archive's replacement carries `kind: 'main'` and no
  `parentId`/`seedSelection`, same as any other Main creation.
- Every other conversation `kind`'s close behavior.

## New field: `ConversationDto.isCurrentMain`

```
isCurrentMain: boolean
```

- `true` for the one live Main; `false` for every branch, review conversation, and archived Main.
- Server-computed from the persisted `is_current_main` column (data-model.md) — included on every
  `ConversationDto` the client already receives (list, get, the `conversation_started` WS payload's
  corresponding fetched conversation), following the same convention as `isPrimary`.

### Example: archiving Main

Before (`GET /api/documents/:id` conversation list excerpt):

```json
{ "id": "conv_main_1", "kind": "main", "status": "idle", "isPrimary": true, "isCurrentMain": true }
```

After `POST /api/conversations/conv_main_1/close`:

```json
{ "id": "conv_main_1", "kind": "main", "status": "closed", "isPrimary": false, "isCurrentMain": false }
```

...and a `conversation_started` WS event fires for the replacement:

```json
{
  "conversationId": "conv_main_2",
  "name": "Main",
  "kind": "main",
  "parentId": null,
  "branchDepth": 0,
  "contextRevision": 17,
  "seedSelection": null
}
```

whose subsequently fetched `ConversationDto` shows `"isCurrentMain": true, "isPrimary": false`.

## New error: `CONVERSATION_BUSY`

```json
{ "error": { "code": "CONVERSATION_BUSY", "message": "Cannot close a conversation while it is actively working" } }
```

`409`, thrown by `close()` for any `kind` (not only Main) whenever `status === 'working'` —
see research.md §4 for why this is added uniformly rather than only for Main.

## Removed: `CANNOT_CLOSE_MAIN_CONVERSATION`

The error code, its throw site, and its contract test are removed — Main is no longer permanently
uncloseable, so this code can never be returned once this feature ships.
