# Contract: Agent Tools — Todo & Parking Lot Lists

**Feature**: `012-todo-parking-lists` | **Related**: [../spec.md](../spec.md) (FR-003–FR-010),
[../data-model.md](../data-model.md), `specs/001-ai-document-review/contracts/agent-tools.md`
(base tool-registration contract this extends)

Four new tools, registered the same way as `read_document`/`propose_document_edit`
(`customTools`, `defineTool`, no Pi extension — Principle VII, research.md R4). None of the four
ever touch document content, so none are gated by `maxEditingDepth`, and none go through the
staged-edit/proposal pipeline (Constitution Principle III's proposal pipeline governs *document*
mutations specifically; these tools mutate a separate sidecar entity — see plan.md's Constitution
Check). All four are available to every conversation kind, at any branch depth, in both Canvas-mode
and Thread-mode documents.

**Behavioral requirement on the three mutating tools below (FR-006, enforced via
system-prompt/tool-description wording, not structurally enforceable)**: the agent MUST only call
`add_list_item`, `update_list_item`, or `remove_list_item` in direct response to an explicit user
request in the conversation. Each of their `description`s says so explicitly, in the same
imperative register as `propose_document_edit`'s own description. `list_items` (read-only, below)
is exempt from this constraint (FR-010) — the agent may call it whenever it needs current state,
the same way it may call `read_document` at will.

---

## Tool: `list_items` (read-only)

```ts
parameters: {}  // no parameters
```

Description (model-facing): "List the current items on the Todo list and the Parking Lot list,
each with its identifier and the exact `contentHash` value to pass as `expected_content_hash` to
`update_list_item`/`remove_list_item` for that item. Call this before updating or removing an item
you did not just add yourself in this conversation."

**Result**: `textResult` rendering both lists (id, text) in a simple line-numbered-free listing
(no document-style line numbers — these are unordered id/text pairs, not document lines);
`details: { todo: ListItemDto[], parkingLot: ListItemDto[] }` (see data-model.md's `ListItemDto`).
Empty lists render as "No items." per list, not an error.

---

## Tool: `add_list_item`

```ts
parameters: {
  list: "todo" | "parking_lot",
  text: string,        // non-empty after trim (FR-016)
}
```

Description (model-facing): "Add an item to the Todo list or the Parking Lot list — ONLY when the
user explicitly asks you to add something to one of these lists. Never use this as your own task
list or memory."

**Success result** (`textResult`, per `contracts/agent-tools.md`'s `{content, details}` shape):
confirms the item was added, quoting back its `text`; `details: { id, list, contentHash }`.

**Failure**: `text` empty/whitespace-only after trim → plain-text refusal, no item created
(FR-016). No other failure mode — creation never conflicts with anything.

---

## Tool: `update_list_item`

```ts
parameters: {
  list: "todo" | "parking_lot",
  id: string,
  expected_content_hash: string,  // hash of the item's CURRENT text, as last told to the agent —
                                  // NOT a hash of the new `text` below
  text: string,                  // new text, non-empty after trim
}
```

`expected_content_hash` names a precondition, not the new content: it's the hash of what the agent
believes the item's *existing* text still is, checked against the item's actual current text before
the new `text` is applied — deliberately not named `content_hash` alone, since sitting next to a
`text` parameter that would be easy to misread as "the hash of the `text` I'm sending," rather than
"the hash of the text I expect is already there."

Description (model-facing): "Update the text of an existing Todo or Parking Lot item, ONLY when the
user explicitly asks you to. `expected_content_hash` must be the exact hash value you were most
recently given for this item's *current* text (from `add_list_item`, a prior `update_list_item`, or
`list_items`) — never invent or compute one yourself, and never the hash of the new text you're
sending."

**Success**: item's `text` replaced, `id` unchanged, new `contentHash` computed and returned.
`textResult` confirms the new text; `details: { id, list, contentHash }`.

**Failure — not found** (FR-007): `id` doesn't exist on `list` → plain-text error, both lists
unchanged.

**Failure — stale hash** (FR-008): `id` exists but `expected_content_hash` doesn't match the item's
actual current hash (the user changed it via the panel since this hash was issued) → plain-text
rejection that:
1. states the update was rejected because the item changed since the agent last saw it,
2. quotes the item's actual current `text` and `contentHash` back to the agent so it can decide
   whether to retry or tell the user what changed.

The item is left exactly as it was (the agent's proposed `text` is never applied).

---

## Tool: `remove_list_item`

```ts
parameters: {
  list: "todo" | "parking_lot",
  id: string,
  expected_content_hash: string,  // same precondition contract as update_list_item's parameter of
                                  // the same name — the hash of the item's current text, not of
                                  // anything being written
}
```

Description (model-facing): "Remove an item from the Todo or Parking Lot list, ONLY when the user
explicitly asks you to. `expected_content_hash` must be the exact hash value you were most recently
given for this item's current text — never invent or compute one yourself."

**Success**: item deleted. `textResult` confirms removal; `details: { id, list }`.

**Failure — not found**: same as `update_list_item`.

**Failure — stale hash**: same rejection shape as `update_list_item` (quotes back current `text`
and `contentHash`); the item is NOT deleted.

---

## Shared response shape (`details`)

All three tools' `details` object is defined once, mirroring `readDocumentParams`'s
Zod-schema-mirrored-by-TypeBox convention (`app/shared/src/contracts/agent-tools.ts`):

```ts
// app/shared/src/contracts/agent-tools.ts
export const listItemToolResult = z.object({
  id: z.string(),
  list: z.enum(['todo', 'parking_lot']),
  contentHash: z.string().optional(),   // absent on remove_list_item success
});
```

## Non-goals carried over from spec.md

- No tool moves an item between lists (spec.md Assumptions) — achieved by `remove_list_item` on one
  list plus `add_list_item` on the other.
- No pagination/filtering on `list_items` — both lists are expected to stay small (spec.md has no
  enforced item-count cap, but the UI panel's own scrolling is the only accommodation for a long
  list; `list_items` simply returns everything).
