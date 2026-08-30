# Feature Specification: Spatial Canvas for Document and Conversations

**Feature Branch**: `[005-canvas-conversation-threads]`

**Created**: 2026-08-30

**Status**: Draft

**Input**: User description: "i am looking for a major restructure, editing document should be 'floating' on a canvas, similar to microsoft words, when highlighting a text the floating conversations with the assistant should be visually coloated next to the document - off to the side at roughly the same location of what was highlighted; similar to making a comment in microsoft words, when a conversation is branched, the new conversation branch moves more to the side, so visually each branched conversation can be seen like a tree branch, each message in the conversation has a default 'max height' but users can expand them to view the full message."

## Illustrative Layout *(non-normative)*

The following ASCII sketch illustrates the spatial relationships described by the user stories and requirements below — HUD position, Main's anchor, highlight colocation, branch-depth columns, and per-message/bulk expand controls. It is a conceptual reference only; exact visual styling is a design-phase decision.

```
 ┌─ HUD (fixed to top of viewport, ordered by distance from top of doc) ─────┐
 │ 0. Main          1. Conv A (¶2)        2. Conv B (¶5)                     │
 └────────────────────────────────────────────────────────────────────────┘

 ┌──────────┐        col-0                    col-1
 │ DOCUMENT │┄┄┄┄┄┄┄►┌───────────┐
 │ (top)    │        │ 💬 Main    │  ← anchored to top of doc,
 │          │        │  [⤢]       │     always first in the HUD
 │          │        │  msg1 ▾    │
 │          │        │  msg2 ▾    │
 │          │        └───────────┘
 │▓highlight┄┄┄┄┄┄┄►┌───────────┐
 │          │        │ 💬 Conv A  │  ← colocated at ~highlight height
 │          │        │  [⤢]       │
 │          │        │  msg1 ▾    │
 │          │        └───────────┘        ┌────────────┐
 │██highlight┄┄┄┄┄┄►┌───────────┐────────►│ 💬 Conv A.1 │  ← branch: one
 │          │        │ 💬 Conv B  │        │  [⤢]        │     column further
 │          │        │  msg1 ▾    │        │  msg1 ▾     │     out than parent
 │          │        └───────────┘        └────────────┘
 └──────────┘
```

- `[⤢]` — bulk control: expands/collapses every message in that conversation at once (FR-009).
- `msg ▾ / ▲` — per-message control: expands/collapses that one message independently (FR-008).
- Two branches off the same message would stack vertically within the same column, separated by a gap (FR-007).
- A conversation whose highlighted anchor text is later edited/deleted stays at its last known position, visually flagged as orphaned (FR-011).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Conversations sit next to the text they're about (Priority: P1)

A reviewer is reading the document, which now floats as an editable page on a pannable canvas rather than being locked to the viewport. They highlight a passage and start a conversation about it; the conversation appears as its own box to the right of the document, positioned at roughly the same height as the highlighted passage. The document's Main conversation (not tied to any specific highlight) also appears in this same right-hand area, anchored to the top of the document. The reviewer can now tell, purely from vertical position, which conversation belongs to which part of the document — without opening anything or reading titles.

**Why this priority**: This is the core of the restructure and the entire reason for the change. Without spatial colocation, nothing else in this feature (branching layout, compact messages) has a canvas to live on.

**Independent Test**: Open a document, highlight a passage, and start a conversation on it. Verify the document renders as a floating page on a pannable canvas, the new conversation renders beside the document at approximately the highlight's vertical position, and the Main conversation renders anchored to the top of the document in the same right-hand area.

**Acceptance Scenarios**:

1. **Given** the document is open, **When** the reviewer views the workspace, **Then** the document renders as a floating page on a pannable canvas rather than a fixed, viewport-locked layout.
2. **Given** the document is open, **When** the reviewer highlights a passage and opens a conversation on it, **Then** a new conversation box appears to the right of the document, vertically positioned at approximately the same height as the highlighted passage.
3. **Given** two highlighted passages at different heights each have a conversation, **When** the reviewer looks at the canvas, **Then** the two conversation boxes appear in the same top-to-bottom order as their highlights in the document.
4. **Given** the document is open, **When** the reviewer looks at the right-hand area, **Then** the Main conversation is visible there, anchored to the top of the document, distinguishable from highlight-anchored conversations.
5. **Given** the canvas, **When** the reviewer scrolls the mouse wheel, **Then** the canvas pans (the document and its colocated conversations scroll together, vertically and, when needed to reach a further branch-depth column, horizontally).

---

### User Story 2 - Branches read as a tree moving away from the document (Priority: P2)

A reviewer is in a conversation anchored to a highlight and wants to explore a different follow-up question without losing their original line of questioning. They branch the conversation from a specific message. The new branch appears as its own box one column further from the document than its parent, sharing everything said up to the branch point; anything said afterward in either branch stays private to that branch. If they branch the same message again, the second new branch stacks below the first, at the same column, with a visible gap between them — so the whole structure reads left-to-right as a tree, with distance from the document showing how many forks deep a conversation is.

**Why this priority**: Branching is a heavily-used existing capability; this story makes its structure visible spatially instead of only inferable from a conversation list, which is the second major piece of the restructure after colocation.

**Independent Test**: From an existing anchored conversation, branch off a specific message twice. Verify both new conversations render one column further from the document than their parent, stacked vertically with a gap between them, and that each branch shows the shared history up to the fork point plus only its own subsequent messages.

**Acceptance Scenarios**:

1. **Given** an anchored conversation with several messages, **When** the reviewer branches from one of its messages, **Then** the new conversation renders one column further from the document than its parent, and shows all messages up to and including the branch point.
2. **Given** a branch has been created, **When** the reviewer adds new messages to the original conversation or to the branch, **Then** those new messages appear only in the conversation they were added to.
3. **Given** a message already has one branch, **When** the reviewer creates a second branch from that same message, **Then** both branches render in the same column, stacked vertically with a visible gap, without overlapping.
4. **Given** a branch of a branch is created, **When** the reviewer views the canvas, **Then** that conversation renders one further column out than its immediate parent, two columns out from the document.

---

### User Story 3 - Messages stay compact until you need the detail (Priority: P3)

A reviewer scanning a long conversation doesn't want every message expanded to full length by default — it would make the thread too tall to scan. Each message shows only up to a default height, with the option to expand just that one message. When they want to read the whole conversation in full, a single control expands every message in the thread at once; they can still collapse or expand any individual message afterward.

**Why this priority**: This keeps conversations usable once colocation (P1) and branching (P2) make many conversations visible on the same canvas at once; it's a refinement of thread ergonomics rather than the structural change itself.

**Independent Test**: Open a conversation with several long messages. Verify each message is capped at a default height with its own expand control, and that a single thread-level control expands or collapses every message in that thread at once.

**Acceptance Scenarios**:

1. **Given** a conversation contains a message whose content exceeds the default display height, **When** the reviewer views the thread, **Then** that message is truncated to the default height with a control to expand it individually.
2. **Given** a message is expanded, **When** the reviewer activates its own control again, **Then** that message collapses back to the default height, independent of other messages in the thread.
3. **Given** a conversation contains multiple messages, some expanded and some collapsed, **When** the reviewer activates the thread's bulk control, **Then** every message in that thread expands (or, if all were already expanded, collapses) together.
4. **Given** the reviewer has just used the bulk control, **When** they then expand or collapse one specific message, **Then** only that message's state changes.

---

### User Story 4 - Finding your way around from a top-of-screen overview (Priority: P4)

A reviewer working on a long document with many active conversations wants to jump straight to a specific one without hunting across the canvas. A HUD fixed to the top of the viewport lists every visible conversation, ordered top-to-bottom by how far its anchor is from the top of the document — Main always listed first, since it's anchored to the very top. Branches are grouped with their root conversation's position rather than getting a separate ordering slot.

**Why this priority**: This is a navigation aid that becomes valuable once P1-P3 make the canvas spatially rich; it's not required to deliver the core restructure but completes the experience for long documents.

**Independent Test**: Open a document with several highlight-anchored conversations at different positions, plus one branch. Verify the HUD renders fixed to the top of the viewport, lists Main first, then the other conversations ordered by their anchors' distance from the top of the document, with the branch listed at its root's position.

**Acceptance Scenarios**:

1. **Given** multiple conversations exist at different document positions, **When** the reviewer looks at the HUD, **Then** it is fixed to the top of the viewport and lists the conversations ordered top-to-bottom by distance of their anchor from the top of the document, with Main listed first.
2. **Given** a conversation has been branched, **When** the reviewer looks at the HUD, **Then** the branch does not receive its own separate position in the ordering distinct from its root conversation.
3. **Given** the canvas is panned to any position, **When** the reviewer looks at the top of the viewport, **Then** the HUD is still visible in the same place, with no control to collapse, hide, or dismiss it.

---

### Edge Cases

- What happens when the text a conversation is anchored to is edited or deleted? The conversation becomes orphaned: it stays visible at approximately its last known position rather than disappearing or relocating, and is visually distinguishable from a conversation whose anchor is still intact.
- What happens when two conversations' boxes would visually overlap (close highlights, or several sibling branches in one column)? The canvas keeps them separated by a minimum vertical gap, recalculated as thread heights or the viewport change; this is rarely visible in practice since threads default to their compact form.
- What happens when a conversation is hidden or closed and filtered out? Visibility continues to be controlled by the existing show/hide conversation filter; this feature does not add a second, competing visibility mechanism. Once it leaves view, the remaining conversations in its column reflow upward to close the gap it leaves behind (FR-012), rather than leaving empty space.
- What happens when branch depth is deep enough to push columns far from the document? The canvas remains pannable (vertically and horizontally) so every column stays reachable by scrolling; the maximum branching depth itself remains governed by the existing configurable, enforced limit.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The document MUST render as an editable, floating page on a pannable canvas rather than a fixed, viewport-locked layout.
- **FR-002**: Users MUST be able to highlight a range of document text and open a conversation anchored to that range.
- **FR-003**: A conversation anchored to a highlighted range MUST render in a column to the right of the document, vertically positioned at approximately the same height as its anchor.
- **FR-004**: The Main conversation MUST render in the same right-hand column area as highlight-anchored conversations, anchored to the top of the document, and MUST always appear as the topmost conversation.
- **FR-005**: Branching a conversation from a specific message MUST produce a new conversation containing the shared history up to and including that message; messages added afterward MUST be visible only within the conversation they were added to.
- **FR-006**: A branched conversation MUST render exactly one column further from the document than its parent conversation's column, so column position reflects branch depth.
- **FR-007**: When more than one branch is created from the same message, the resulting sibling conversations MUST render in the same column, stacked vertically with a visible gap, without overlapping.
- **FR-008**: Each message within a conversation MUST default to a maximum display height, with a control to expand or collapse that individual message independently of the rest of the conversation.
- **FR-009**: Each conversation MUST provide a single control that expands or collapses all of its messages at once; after using it, users MUST still be able to expand or collapse any individual message independently.
- **FR-010**: The HUD MUST be positioned at the top of the viewport, in the same header row as the document title and the existing toolbar controls — title on one side, HUD in the middle (width-aligned with the document/canvas area and the Preview pane together; Preview is otherwise unchanged by this feature — see Assumptions), existing controls on the other side — and MUST list every visible conversation ordered top-to-bottom by the vertical distance of its anchor from the top of the document; a branched conversation MUST be grouped at its root conversation's position rather than given an independent ordering slot. The HUD MUST remain visible at all times — it is not collapsible, hideable, or dismissible, and panning the canvas MUST NOT move it or affect its visibility.
- **FR-011**: If the text a conversation is anchored to is edited or deleted, the conversation MUST remain visible at its last known anchored position and MUST be visually distinguishable as orphaned, rather than being removed or silently relocated.
- **FR-012**: The canvas MUST reposition conversations within a column with a minimum vertical gap whenever their current heights would otherwise cause them to overlap, recalculating as heights or viewport size change, and MUST also recalculate to close the resulting gap when a conversation leaves view (closed and filtered out, or hidden via the existing show/hide filter) — remaining conversations in that column shift to fill the space rather than leaving it empty.
- **FR-013**: This feature MUST reuse the existing conversation show/hide filter to control which conversations render on the canvas, and MUST NOT introduce a separate or competing visibility mechanism.
- **FR-014**: Users MUST be able to pan (scroll) the canvas, both vertically and horizontally, to reach the document and every conversation across all branch-depth columns.
- **FR-015**: A mouse-wheel scroll MUST pan the canvas — scrolling the document and its colocated conversations together.

### Key Entities

- **Canvas**: The pannable surface hosting the floating document page and every conversation box positioned relative to it.
- **Conversation**: A colocated, anchored conversation — either Main or highlight-anchored — rendered as a box in a column at a given branch depth; holds an ordered list of messages, a reference to its parent conversation (if it is a branch), and its anchor state (intact or orphaned).
- **Anchor**: The positional reference tying a conversation to the document: either the top of the document (Main) or a highlighted text range. An anchor can become orphaned if its underlying text is edited or deleted.
- **Message**: A single turn within a conversation, with its own default-height/expanded display state, independent of the conversation's bulk expand/collapse state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Given a document with up to 10 concurrently visible conversations, a user can correctly identify which conversation corresponds to a given highlighted passage by vertical position alone, without opening any conversation or reading its title.
- **SC-002**: Given a branch three levels deep, a user can correctly state how many branches removed a conversation is from the document by column position alone, without opening any conversation.
- **SC-003**: Collapsing or expanding every message in a conversation takes exactly one user action, regardless of how many messages the conversation contains.
- **SC-004**: In a conversation's default (compact) view, no single message consumes more vertical space than the configured default message height, regardless of that message's full content length.
- **SC-005**: From the HUD, a user can navigate to any visible conversation in a single action, and the first conversation listed is always the one whose anchor is closest to the top of the document.
- **SC-006**: When a conversation's anchor text is edited or deleted, a user can distinguish that conversation as orphaned from an intact one within the same glance, without opening it.
- **SC-007**: A user can pan the entire canvas — reaching the document and every conversation in every branch-depth column — using only the mouse wheel, without ever needing a separate button or mode switch.

## Assumptions

- Branching shares conversation history up to and including the fork point; messages added after the fork are private to whichever branch they were added to. This restructure does not change branching's underlying semantics (Pi remains the source of truth for the conversation tree, per the project constitution) — it changes how branches are laid out spatially.
- An orphaned conversation (its anchor text was edited or deleted) stays at its last known position and is flagged as orphaned; the exact visual treatment for that flag is a design-phase decision, not specified here.
- Sibling branches from the same message stack vertically with a gap in creation order; this reflow is only rarely visible in practice since conversations default to a compact, capped-height form.
- Conversation visibility (show/hide) continues to be governed by the filter that already exists in the application; this feature does not add a resolve/archive mechanism or any other new visibility control.
- This restructure replaces the current linear/list-based conversation layout; it is not introduced as an additional toggleable view alongside the old one.
- The maximum conversation branching depth continues to be governed by the existing configurable, enforced application limit; this feature does not change that limit, only how depth is rendered spatially.
- Zooming the canvas is explicitly out of scope for this version — mouse-wheel scroll pans the canvas (vertically, and horizontally where needed to reach a further branch-depth column) and nothing more; a future version may reconsider zoom if the number of columns/threads in practice makes pure panning insufficient. Exact gestures beyond wheel-scroll (e.g. click-drag panning), default message height in pixels, minimum gap size between stacked conversations, and the specific visual treatment for "orphaned" remain design-phase decisions.
