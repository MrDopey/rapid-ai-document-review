# Quickstart: Validating the Spatial Canvas

Prerequisites: repo installed (`npm install` at root), backend + frontend dev servers runnable per
the project's existing README/debugging instructions. No new environment variables or services are
required by this feature.

## Setup

```bash
npm run dev   # or the project's existing per-package dev scripts
```

Open the app and load (or create) a document with at least a few paragraphs of text.

## Scenario 1 — Colocation (User Story 1, FR-001–FR-004)

1. Confirm the document renders as a floating page on a canvas, not a fixed split pane.
2. Highlight a passage partway down the document; start a conversation from it.
3. Confirm the new conversation box appears to the right of the document, at approximately the
   highlighted passage's height, in column 0.
4. Confirm the Main conversation is also visible in column 0, anchored to the top of the document,
   and is the topmost box.
5. Highlight a second passage further down; confirm its conversation box appears further down than
   the first, preserving document order.

**Expected**: conversation vertical order on screen always matches highlight order in the document,
per SC-001.

## Scenario 2 — Branching as a tree (User Story 2, FR-005–FR-007)

1. From an anchored conversation with a few messages, branch off a specific message.
2. Confirm the new branch renders one column to the right (column 1) and shows the shared history
   up to the fork point.
3. Send a message in the original conversation and a different message in the branch; confirm each
   appears only in its own box.
4. Branch the same message again; confirm the second branch stacks below the first in column 1 with
   a visible gap, not overlapping.
5. Branch the branch itself; confirm that new conversation renders in column 2.

**Expected**: column number always equals `branchDepth`; siblings never overlap, per SC-002 and the
Edge Cases section.

## Scenario 3 — Compact messages (User Story 3, FR-008–FR-009)

1. Send/receive a message long enough to exceed the default display height.
2. Confirm it truncates with its own expand control; expand and collapse it individually.
3. With a mix of expanded/collapsed messages in one conversation, activate that conversation's bulk
   control; confirm every message in it expands (or collapses) together.
4. After the bulk action, toggle one message individually; confirm only that message's state changes.

**Expected**: SC-003 (one action expands/collapses everything) and SC-004 (compact messages never
exceed the default height) both hold.

## Scenario 4 — HUD ordering (User Story 4, FR-010)

1. With Main plus two highlight-anchored conversations at different heights, plus one branch of the
   first, open the HUD.
2. Confirm it is fixed to the top of the viewport, lists Main first, then the other two ordered by
   distance from the top of the document, and that the branch is grouped at its root's position
   rather than appearing as an independent entry.
3. Click a HUD entry; confirm the canvas scrolls (`scrollIntoView`) so that conversation is in view.

**Expected**: SC-005.

## Scenario 5 — Orphaned anchors (Edge Cases, FR-011, contracts/conversation-anchor.md)

1. Edit or delete the text a highlight-anchored conversation is anchored to.
2. Confirm that conversation stays visible at its last known position and is visually flagged as
   orphaned (`anchorOrphaned: true` in the conversation payload), rather than disappearing or
   moving.

**Expected**: SC-006.

## Scenario 6 — Wheel pan (FR-015)

1. Scroll the mouse wheel over the canvas; confirm the document and its conversations pan together
   (vertically, and horizontally when a further branch-depth column needs to come into view), and
   that the document page itself has no separate inner scrollbar competing for the gesture.
2. Repeat Scenario 6 using only the keyboard: focus the canvas (e.g. Tab into it) and use arrow
   keys/Page Up/Page Down to pan, confirming a non-pointer path exists with no custom keybinding
   required (native scrollable-container behavior, research.md §3).

**Expected**: SC-007.

## Automated coverage

- Unit/component: Vitest specs for `ConversationLayout` collision/stacking logic (column position,
  sibling ordering, reflow on removal) and `MessageBubble`'s per-message/bulk expand state.
- E2E: `tests/e2e/us8.spec.ts` (or the next available `usN` slot) covering Scenarios 1–4 end-to-end,
  following the existing per-user-story Playwright convention.
