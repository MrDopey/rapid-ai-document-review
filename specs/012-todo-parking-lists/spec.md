# Feature Specification: Todo & Parking Lot Lists

**Feature Branch**: `012-todo-parking-lists`

**Created**: 2026-09-25

**Status**: Draft

**Input**: User description: "create a 'todo' and 'parking' lot list attached to a document or threaded view. it is simple list string, and the agent needs new tool calls to add, remove (by id), or update (by id) an item on either list. the user should also be able to toggle this list's visibility from the .hud-bar-right, and the user should be able to manage the list items on the list from the front end as well with the usual CRUD operations"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - User asks the agent to manage the Todo list (Priority: P1)

While reviewing a document with the AI agent, the user explicitly asks the agent to note an action item on the Todo list ("add 'fix the intro paragraph' to the todo list"), or to update or remove one. The agent performs exactly the requested change and nothing more — it does not decide on its own to add, edit, or remove items as a side effect of its own reasoning or task tracking.

**Why this priority**: This is the core value proposition — a user-directed, agent-maintained record of outstanding work — and is usable on its own even before any UI controls exist.

**Independent Test**: With the user explicitly instructing the agent in conversation, have the agent call the add/update/remove tool calls against the Todo list and confirm the list reflects only the requested items, edits, and removals — and that the agent does not add or change items unprompted.

**Acceptance Scenarios**:

1. **Given** a document with an empty Todo list, **When** the user asks the agent to add an item with some text, **Then** the item appears on the Todo list with a unique identifier.
2. **Given** a Todo list with an existing item, **When** the user asks the agent to update that item's text, **Then** the item's text is replaced and its identifier is unchanged.
3. **Given** a Todo list with an existing item, **When** the user asks the agent to remove that item, **Then** the item no longer appears on the Todo list.
4. **Given** a Todo list, **When** the user asks the agent to update or remove an item that does not exist on the list, **Then** the tool call returns an error and the list is unchanged.
5. **Given** an ongoing conversation where the agent identifies its own open sub-tasks or reasoning steps, **When** the user has not asked it to record anything on the Todo list, **Then** the agent does not add, update, or remove any Todo list item.
6. **Given** a Todo item the agent last knew to contain some text, **When** the user (via the panel) changes that item's text before the agent acts on it, and the agent then asks to update or remove the item using the hash of the text it last knew, **Then** the tool call is rejected because the hash no longer matches, the item is left exactly as the user last set it, and the rejection tells the agent the item's current text.

---

### User Story 2 - User asks the agent to manage the Parking Lot list (Priority: P2)

During the same conversation, the user asks the agent to file an idea or concern that isn't actionable right now onto a separate Parking Lot list ("park 'consider restructuring section 3 later' "), keeping it visible but out of the way of the actionable Todo list. As with the Todo list, the agent only touches the Parking Lot list when the user explicitly asks it to.

**Why this priority**: Builds directly on User Story 1's mechanics (same CRUD-by-id shape, same user-request-only constraint) applied to a second, independently meaningful list; delivers value once P1 exists.

**Independent Test**: With the user explicitly instructing the agent in conversation, have the agent call the add/update/remove tool calls against the Parking Lot list and confirm items land there and not on the Todo list, and that the agent never acts on this list unprompted.

**Acceptance Scenarios**:

1. **Given** a document with an empty Parking Lot list, **When** the user asks the agent to add an item, **Then** the item appears on the Parking Lot list only, not the Todo list.
2. **Given** a Parking Lot list with an existing item, **When** the user asks the agent to update or remove it, **Then** the change applies to that list only and leaves the Todo list untouched.
3. **Given** an ongoing conversation, **When** the user has not asked the agent to record anything on the Parking Lot list, **Then** the agent does not add, update, or remove any Parking Lot list item on its own initiative.

---

### User Story 3 - User shows or hides the lists panel (Priority: P3)

A user who isn't currently interested in the Todo/Parking Lot lists wants them out of the way, and later wants to bring them back, without losing any content, via a single control in the toolbar's action area. The lists are only meaningful while the user is actually in a conversation with the agent, so in Canvas mode the control only does something once a conversation is focused; in Thread mode, where conversations are always inline rather than behind a separate focus step, the control is simply always available.

**Why this priority**: A visibility control is necessary for the feature to be usable in practice, but the lists still carry value (via agent tool calls) even before this control exists — hence it ranks after the list mechanics.

**Independent Test**: Click the toggle control in `.hud-bar-right` and confirm the lists panel shows/hides accordingly, with list contents preserved across toggles; separately, confirm the control's enabled/disabled state matches whether a conversation is focused (Canvas mode only).

**Acceptance Scenarios**:

1. **Given** the lists panel is hidden, **When** the user clicks the toggle control in the toolbar's action area, **Then** the panel becomes visible, showing both the Todo and Parking Lot lists.
2. **Given** the lists panel is visible, **When** the user clicks the toggle control again, **Then** the panel hides, and previously added items are retained (they reappear unchanged when the panel is reopened).
3. **Given** a Canvas-mode document and, separately, a Thread-mode document, **When** the user looks at either document's toolbar action area, **Then** each shows the same toggle control, and each reveals that document's own Todo/Parking Lot panel consistently.
4. **Given** a Canvas-mode document with no conversation currently focused, **When** the user looks at the toolbar action area, **Then** the toggle control is visible but disabled, and activating it has no effect.
5. **Given** a Canvas-mode document, **When** the user focuses a conversation, **Then** the toggle control becomes enabled, and activating it shows the panel attached to that focused conversation's view.
6. **Given** a Canvas-mode document with more than one conversation focused at the same time, **When** the user shows the panel, **Then** exactly one shared panel appears (not one per focused conversation), reflecting the same document-level lists regardless of which or how many conversations are focused.
7. **Given** a Thread-mode document, **When** the user looks at the toolbar action area at any time, **Then** the toggle control is always enabled, with no dependency on any conversation being focused.

---

### User Story 4 - User manages list items directly (Priority: P4)

A user reviewing the lists wants to add a new item, correct a typo in an existing one, or delete an item that's no longer relevant — without asking the agent to do it.

**Why this priority**: Extends the same underlying lists with a manual editing path; depends on the lists and panel already existing (P1–P3), so it's last in build order even though it's user-facing.

**Independent Test**: With the panel open, add, edit, and delete an item on each list directly in the UI and confirm the changes are reflected immediately and persist after closing and reopening the panel.

**Acceptance Scenarios**:

1. **Given** the lists panel is open, **When** the user adds a new item to either list via the panel, **Then** the item appears on that list with a unique identifier.
2. **Given** an existing item in either list, **When** the user edits its text via the panel, **Then** the displayed text updates and the identifier is unchanged.
3. **Given** an existing item in either list, **When** the user deletes it via the panel, **Then** the item is removed from that list.
4. **Given** items added or edited by the agent, **When** the user opens the panel, **Then** the user sees the same items and can edit or delete them the same way as items they added themselves.

---

### Edge Cases

- Adding an item with empty or whitespace-only text (from either the agent or the user) is rejected rather than creating a blank item.
- An agent tool call targeting an identifier that doesn't exist on the specified list returns an error instead of silently succeeding or affecting the other list.
- A list with a large number of items remains fully viewable (e.g., via scrolling) without breaking the panel layout.
- The Todo and Parking Lot lists are independent: an identifier on one list is never resolved against the other list.
- The agent never adds, updates, or removes a list item on its own initiative (e.g., as self-directed task tracking, memory, or scratch storage) — every such tool call traces back to an explicit user request within the conversation.
- If a user changes or removes an item (via the panel) after the agent last observed its content, and the agent then attempts to update or remove that same item based on the content it last knew, the attempt is rejected rather than silently applied over the user's more recent change.
- Toggling the panel's visibility never deletes or alters list contents — it only affects whether the panel is currently shown.
- Opening the same document later (new session/reload) shows the same list contents as when it was last left.
- In Canvas mode, unfocusing the last focused conversation while the panel is open closes/disables the panel along with disabling the toggle control, without discarding any list content.
- In Canvas mode, focusing a second (or third...) conversation while the panel is already open does not spawn additional panels — the single shared panel remains as-is.
- In Thread mode, the panel narrowing the available content width never causes thread cards or the composer to become inaccessible or clipped — the content area reflows rather than being obscured.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST maintain two independent lists per document: a "Todo" list and a "Parking Lot" list, each holding zero or more items.
- **FR-002**: Each list item MUST consist of a unique identifier (unique within its list) and a text string.
- **FR-003**: The system MUST provide an agent tool call to add a new item, with given text, to either the Todo list or the Parking Lot list; the response MUST include the new item's identifier and a server-issued short hash of its text.
- **FR-004**: The system MUST provide an agent tool call to remove an item from either list, addressed by its identifier and the short hash most recently returned to the agent by the server for that item.
- **FR-005**: The system MUST provide an agent tool call to update the text of an existing item on either list, addressed by its identifier and the short hash most recently returned to the agent by the server for that item; the response MUST include the item's new server-issued short hash.
- **FR-006**: The agent MUST only invoke the add/remove/update tool calls in direct response to an explicit user request in the conversation; the agent MUST NOT use either list as its own durable storage, memory, or self-directed task tracker.
- **FR-007**: When an agent tool call references an item identifier that does not exist on the target list, the system MUST return an error to the caller and leave both lists unchanged.
- **FR-008**: When an agent's update or remove tool call's stated short hash for an item does not match the item's actual current short hash (i.e. the item changed, via the panel, after the hash was last issued to the agent), the system MUST reject the tool call, leave the item as its actual current value, and report that current text and current short hash back to the caller — never silently apply the agent's change over the newer one.
- **FR-009**: The short hash is server-issued and opaque to the agent: the agent MUST only ever pass back a hash value it was previously given by a tool call response, never one it computes or constructs itself.
- **FR-010**: The system MUST provide a read-only agent tool call that returns the current items (identifier, text, and short hash) of both lists, so the agent can obtain the identifier/hash of an item it did not itself just add before calling update or remove on it. This tool is informational only — calling it is never subject to FR-006's "only on explicit user request" constraint, since it has no effect on either list's contents.
- **FR-011**: The system MUST provide a control in the toolbar's HUD action area (`.hud-bar-right`) that toggles the visibility of a panel containing both lists.
- **FR-012**: The lists panel MUST be hidden by default and MUST only become visible when the user activates the toggle control.
- **FR-013**: When the lists panel is visible, the system MUST display the current items of both the Todo list and the Parking Lot list.
- **FR-014**: The system MUST allow the user to add a new item, with entered text, to either list directly from the panel.
- **FR-015**: The system MUST allow the user to edit the text of an existing item on either list directly from the panel.
- **FR-016**: The system MUST allow the user to delete an existing item from either list directly from the panel.
- **FR-017**: The system MUST reject add or update operations, whether initiated by the agent or the user, that would result in an item with empty or whitespace-only text.
- **FR-018**: List contents MUST persist for the life of the document, surviving panel visibility toggles, page reloads, and reopening the document in a later session.
- **FR-019**: The toggle control, the lists panel, and the list contents MUST be available and consistent whether the document is being viewed in Canvas mode or Thread mode.
- **FR-020**: User edits made directly through the panel (add, update, delete) MUST apply immediately and MUST NOT be subject to the agent's stale-content check — that check constrains only the agent's own tool calls, never the user's own direct edits.
- **FR-021**: In Canvas mode, the toggle control MUST be disabled (visible but non-interactive) whenever no conversation is currently focused, and MUST become enabled as soon as at least one conversation is focused.
- **FR-022**: In Canvas mode, when the toggle control is enabled and activated, the panel MUST render as a single rail attached to the focused-conversation view (the conversation-detail overlay); this rail MUST NOT duplicate per focused conversation — exactly one shared panel exists regardless of how many conversations are simultaneously focused.
- **FR-023**: In Thread mode, the toggle control MUST always be enabled, independent of any conversation focus state.
- **FR-024**: In Thread mode, when the panel is visible, it MUST render as a fixed rail hugging the right edge of the viewport, positioned outside the thread list's own content area, narrowing that content area's available width rather than overlapping or covering it.
- **FR-025**: In either mode, the panel MUST render its Todo contents and its Parking Lot contents as two always-visible, vertically stacked sections rather than as independently collapsible/toggleable panels.

### Key Entities

- **List Item**: A single entry on either list. Attributes: unique identifier (scoped to its list), text content (non-empty string), and a short hash of its current text (used to detect stale agent edits, not stored as a history — only the current hash is kept). Belongs to exactly one of the two lists and to the document it is attached to.
- **Todo List**: The ordered collection of List Items representing actionable, outstanding work for a document.
- **Parking Lot List**: The ordered collection of List Items representing deferred or lower-priority notes for a document, kept separate from the Todo list.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can reveal or hide the Todo/Parking Lot panel in a single click from the toolbar, from either Canvas mode or Thread mode.
- **SC-002**: An item added by the agent via a tool call is visible in the panel without requiring a manual page refresh.
- **SC-003**: A user can add, edit, or delete a list item from the panel in under 10 seconds without navigating away from the document view.
- **SC-004**: 100% of add/update/remove operations that target a non-existent item identifier return a clear error rather than corrupting either list.
- **SC-005**: List contents are identical before and after a page reload or panel visibility toggle, with no items lost or duplicated.
- **SC-006**: Across a sample of ordinary review conversations where the user never mentions the Todo or Parking Lot lists, the agent makes zero add/update/remove tool calls against either list (the read-only listing tool, FR-010, is not covered by this criterion, since consulting it has no effect on either list).
- **SC-007**: 100% of agent update/remove attempts based on stale (already user-changed) item content are rejected, with the item retaining the user's more recent value — zero silent overwrites of a user's change by the agent.
- **SC-008**: In Canvas mode, the toggle control's enabled/disabled state always matches whether a conversation is focused, with no observed case of it being enabled with nothing focused or disabled while something is focused.
- **SC-009**: In Thread mode, opening the panel never hides or clips any thread card or composer — the content area remains fully usable at a narrower width.

## Assumptions

- The agent treats the Todo and Parking Lot lists purely as a user-facing feature it operates on demand, never as its own scratchpad, memory, or task-tracking mechanism; it makes no autonomous decisions about what belongs on either list.
- The Todo and Parking Lot lists are attached to the document itself (not to an individual conversation or thread). A document's mode (Canvas or Thread) is fixed at creation and never changes, so no single document is ever viewed in both modes — but different documents may be in either mode, so the lists and the `.hud-bar-right` toggle must be built for both, rather than only for Canvas mode. The two modes present the resulting panel differently (see below), reflecting their different layouts, while operating on the same underlying document-level lists.
- A single toggle control in `.hud-bar-right` shows or hides one combined panel containing both lists, rather than separate toggles per list.
- The lists are only meaningful in the context of talking to the agent, so Canvas mode — where a conversation must first be explicitly focused via `.conversation-detail-overlay` before it's "in view" — gates the toggle control on that focus state (FR-021/FR-022). Thread mode has no equivalent focus step (conversations render inline as `ThreadCard`s), so its toggle control has no such gating (FR-023) and is always available whenever a Thread-mode document is open.
- In Canvas mode, the panel is a single shared rail attached to the conversation-detail overlay, not one rail per focused conversation, even when multiple conversations are focused at once (the overlay's own "1..N instances" behavior) — the lists are document-level, not per-conversation, so duplicating the rail per instance would be redundant.
- In Thread mode, the panel is a fixed rail docked to the right edge of the viewport, outside `.thread-mode-content`, which narrows (reflows) rather than being overlaid/covered by the rail.
- Within the panel (either mode), the Todo section and the Parking Lot section are two always-visible, vertically stacked sibling blocks — not independently collapsible or separately toggleable from one another.
- All collaborators viewing the same document share the same Todo and Parking Lot lists; there are no per-user private lists.
- New items are appended to the end of their list; manual reordering/drag-and-drop of items is out of scope for this feature.
- Moving an item from one list to the other (e.g., Todo → Parking Lot) is out of scope; achieving that effect requires removing it from one list and adding it to the other.
- List item text has no enforced maximum length beyond standard reasonable limits, and no special formatting or rich content — plain text only.
- The short hash for each item is computed and issued exclusively by the server (e.g. in the response to an add, an update, or whenever item state is otherwise surfaced to the agent) and is opaque to the agent — the agent only ever echoes back a hash value it was previously given, never one it computes itself. The stale-content check (FR-008) compares that echoed-back hash against the server's freshly computed hash of the item's actual current text at the moment the tool call runs, not against a separate approval/locking step or a stored history of past hashes. This applies only to the agent's own update/remove tool calls — a user's own direct edits via the panel are always applied immediately (FR-020) and never rejected as "stale."
- The hash only needs to be short enough to be a cheap, convenient tool-call parameter and to make accidental collisions negligible for the size of these lists — it is not a cryptographic or security control.

## UI Layout Reference *(informative — supports FR-021 through FR-025)*

These wireframes fix the placement decisions above for planning purposes; class names refer to
existing structure documented in `AGENTS.md`'s layout diagrams.

**Canvas mode — no conversation focused (toggle control disabled):**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ header.toolbar                                                           │
│  .hud-bar-columns: ...  │ .hud-bar-right/.actions-group: [...] [Lists]  │
│                         │                        (disabled — nothing    │
│                         │                         is focused)           │
├──────────────────────────────────────────────────────────────────────────┤
│ .panes: Preview | Canvas | [History]                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

**Canvas mode — a conversation is focused (toggle enabled; shared rail attached to the overlay):**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ header.toolbar                                                           │
│  .hud-bar-columns: ...  │ .hud-bar-right/.actions-group: [...][Lists(n)]│
├──────────────────────────────────────────────────────────────────────────┤
│ .panes  (dimmed behind overlay)                                          │
│  ░░ .conversation-detail-overlay ░░───────────────────────────────────┐  │
│  ░░ ┌─ <ConversationDetailPanel> ────────┐┌─ .todo-parking-lists-rail─┐░ │
│  ░░ │ conversation header/messages/      ││ (v-if listsOpen; single   │░ │
│  ░░ │ composer                           ││  shared rail regardless   │░ │
│  ░░ │                                    ││  of how many conversations│░ │
│  ░░ │                                    ││  are focused)             │░ │
│  ░░ │                                    │├─ .todo-list-section ─────┤│░ │
│  ░░ │                                    ││ Todo                     ││░ │
│  ░░ │                                    ││  ☐ item text    [✎][✕]  ││░ │
│  ░░ │                                    ││  [+ Add........]         ││░ │
│  ░░ │                                    │├─ .parking-lot-section ───┤│░ │
│  ░░ │                                    ││ Parking Lot              ││░ │
│  ░░ │                                    ││  • item text    [✎][✕]  ││░ │
│  ░░ │                                    ││  [+ Add........]         ││░ │
│  ░░ └────────────────────────────────────┘└──────────────────────────┘░ │
│  ░░───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Thread mode — toggle always enabled; fixed rail hugs the right edge, outside `.thread-mode-content`,
narrowing (not covering) the thread list:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ .thread-mode-view                                                        │
│  ┌─ .thread-mode-hud (sticky) ───────────────────────────────────────┐  │
│  │ ...  │ .hud-bar-right/.actions-group: [Expand-all][Export-all]     │  │
│  │      │  [Lists (n)][Done (n)]                                      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────┐┌─.todo-parking-lists-rail─┐│
│  │ .thread-mode-content                     ││ (v-if listsOpen, fixed, ││
│  │  .thread-mode-list: <ThreadCard>...      ││  outside                ││
│  │  (narrows to make room; never covered)   ││  .thread-mode-content)  ││
│  │                                           │├─ .todo-list-section ───┤│
│  │                                           ││ Todo                   ││
│  │                                           ││  ☐ item text  [✎][✕]  ││
│  │                                           ││  [+ Add........]      ││
│  │                                           │├─ .parking-lot-section ─┤│
│  │                                           ││ Parking Lot            ││
│  │                                           ││  • item text  [✎][✕]  ││
│  │                                           ││  [+ Add........]      ││
│  └─────────────────────────────────────────┘└──────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

`.todo-list-section` and `.parking-lot-section` are sibling blocks directly under
`.todo-parking-lists-rail` in both modes — the same rail content, mounted at a different anchor
point per mode.
