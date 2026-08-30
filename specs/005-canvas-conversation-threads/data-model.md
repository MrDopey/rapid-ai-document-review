# Phase 1 Data Model: Spatial Canvas for Document and Conversations

Almost every entity this feature needs already exists (`Conversation` in
`app/shared/src/domain/index.ts`). This document describes the one additive field and the
frontend-only, non-persisted view-model entities derived from existing data — no schema migration
is required.

## Conversation (existing entity, one field added)

| Field | Type | Notes |
|---|---|---|
| `id`, `documentId`, `parentId`, `name`, `kind`, `status`, `isPrimary`, `branchDepth`, `seedSelection`, `createdAt`, ... | *(unchanged)* | See `app/shared/src/domain/index.ts`. |
| `anchorOrphaned` | `boolean` | **New, server-computed** (research.md §7). `false` when `seedSelection` is `null`; otherwise `true` once `documentContent.slice(seedSelection.from, seedSelection.to) !== seedSelection.text` at the current revision. Never persisted — computed at read time exactly like `isStale`/`canEdit`/`canBranch`. Added to the `ConversationDto` Zod schema in `app/shared/src/contracts/http.ts` (the actual wire contract the frontend consumes) and mirrored on the `Conversation` interface in `app/shared/src/domain/index.ts` for consistency. |

**Anchor derivation rule** (frontend + backend agree on this, not a stored field): a conversation's
anchor is the top of the document when `seedSelection` is `null` (this is what makes the `kind:
'main'` conversation — and any other conversation created without a selection — the spec's "Main,"
regardless of `isPrimary`), otherwise its anchor is `seedSelection.from`/`seedSelection.to`. Note
that **anchor and `isPrimary` are independent**: `isPrimary` can move to a highlight-anchored branch
(Constitution Principle III's auto-apply flag), while that branch still renders at its highlight's
position, not at the top of the document. This distinction matters for implementation and must not
be conflated.

## ConversationLayout (frontend-only, derived, not persisted)

Computed per render pass from existing `Conversation` fields plus live DOM measurements; never sent
to or stored by the backend.

| Field | Type | Derivation |
|---|---|---|
| `conversationId` | `string` | — |
| `column` | `number` | `conversation.branchDepth` (FR-006). |
| `anchorY` | `number` | Document-space Y of `seedSelection.from` (via the editor's position-to-coordinate mapping), or `0` (top of document) when `seedSelection` is `null`. |
| `stackY` | `number` | `anchorY`, adjusted downward per the collision-avoidance pass (research.md §6) against other boxes already placed in the same `column`; adjusted upward instead when a conversation earlier in the same column has left view (closed and filtered out, or hidden), closing the gap it left behind. |
| `siblingOrder` | `number` | Index among conversations sharing the same `parentId`, ordered by `createdAt` (FR-007). |
| `isOrphaned` | `boolean` | Mirrors `conversation.anchorOrphaned`, exposed here so the layout pass and the visual-flag rendering read the same value. |

## CanvasScrollPosition (frontend-only, derived + persisted to `localStorage`)

| Field | Type | Notes |
|---|---|---|
| `scrollLeft`, `scrollTop` | `number` | The canvas's native scroll offsets (research.md §1/§8) — no zoom/scale field exists; zoom is out of scope for this version. |

Persistence key/shape follows the existing `panePersistence.ts` convention (per-viewer,
`localStorage`-backed, not part of any API contract).

## MessageDisplayState (frontend-only, derived + persisted to `localStorage`)

| Field | Type | Notes |
|---|---|---|
| `messageId` | `string` | — |
| `expanded` | `boolean` | Default `false` (FR-008). Individually toggleable; a conversation's bulk control (FR-009) sets every one of its messages' `expanded` at once but does not introduce a separate stored "bulk state" — it is purely a batch write over the same per-message field. |

## HUD ordering (frontend-only, derived, not persisted)

Computed as: for each visible `Conversation`, resolve its **root** ancestor (walk `parentId` until
`null`) and that root's anchor position (`0` for Main, else `seedSelection.from`); sort visible
conversations by that resolved root-anchor position, ascending, with Main always first since its
anchor is `0` and no other anchor is defined to be less than the top of the document (FR-010).
