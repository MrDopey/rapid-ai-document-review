# Contract: `anchorOrphaned` computed field

Extends the existing `GET /api/documents/:id`-style conversation list payload (see
`specs/001-ai-document-review/contracts/http-api.md`) with one additional server-computed boolean on
each `Conversation`, following the same convention as `isStale`/`canEdit`/`canBranch`.

## Field

`anchorOrphaned: boolean`

- `false` when `seedSelection` is `null` (the conversation is anchored to the top of the document —
  i.e. it is a "Main"-style conversation regardless of `kind` or `isPrimary`; there is no text
  anchor that can go stale).
- `true` once `documentContent.slice(seedSelection.from, seedSelection.to) !== seedSelection.text`,
  evaluated against the document's current content at read time.
- `false` while the slice still matches.

Computed server-side, never persisted — mirrors `isStale` (`contextRevision < currentRevision`) and
is subject to the same rationale: the UI must not be able to disagree with the application's own
view of document state (Constitution Principle I).

## Example response delta

```json
{
  "id": "conv_intro",
  "name": "Review: Introduction",
  "kind": "branch",
  "parentId": "conv_main",
  "branchDepth": 1,
  "seedSelection": { "from": 120, "to": 180, "text": "the original highlighted passage" },
  "isStale": true,
  "canEdit": true,
  "canBranch": true,
  "anchorOrphaned": true
}
```

Here `anchorOrphaned: true` indicates the document's current content at offsets `120..180` no
longer reads `"the original highlighted passage"` — the highlight the conversation was anchored to
has since been edited or removed. The frontend uses this to render the conversation at its last
known anchor position with the orphaned visual flag (spec FR-011, SC-006), rather than hiding or
relocating it.

## Non-goals

- No new endpoint. No request-side field — `anchorOrphaned` is response-only, computed from data
  the client already sent when the conversation was branched.
- No change to `seedSelection` itself; it remains the immutable, point-in-time record it always was.
