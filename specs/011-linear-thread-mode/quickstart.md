# Quickstart: Validating Linear Thread Mode

Prerequisites: repo installed (`npm install` at root), backend + frontend dev servers runnable per the project's existing README/debugging instructions. No new environment variables or services are required by this feature (`RADR_BE_PI_FAKE_SESSIONS=1` works exactly as it does for canvas mode, since `ThreadService`/`PiService.sendOnThread` reuse the same fake-session path).

Scope: this validates User Stories 1-4 (FR-001 through FR-015).

## Setup

```bash
npm run dev
```

Open the app; use the document switcher (spec 010) to create a new document, choosing "Threaded conversation" as its type instead of the default canvas document.

## Scenario 1 — Single root, top-down, no free top-level thread (User Story 1, FR-001–FR-004, FR-014)

1. Confirm the new document opens directly into `ThreadModeView` (not the Preview/Canvas/History grid) with exactly one thread visible, at the top of a vertical list.
2. Look for any UI action to start a second, independent top-level thread — confirm none exists; only a highlight-to-branch affordance is available on messages.
3. Send a message in the root thread; confirm it appends to that same thread, top-down.
4. Switch (via the document switcher) to an existing canvas-mode document, then back to this threaded document; confirm the root thread's history and position are exactly as left (FR-014).

**Expected**: SC-001 — one root, always, with no path to a second independent top-level thread.

## Scenario 2 — Highlight-to-branch with XML-tagged seed (User Story 2, FR-005/FR-005a/FR-006/FR-007)

1. In the root thread, send/receive at least three messages.
2. Highlight a passage inside an earlier message (not the thread's current tip) and trigger branch.
3. Confirm a new thread appears, indented as a sibling fork at that message's split point (FR-005b), and that its first message already contains `<branch-seed-excerpt>` wrapping the exact highlighted text, editable/appendable by the reviewer before sending.
4. Send that seeded message; confirm the branch continues independently — messages sent in the root afterward are not visible in the branch and vice versa.
5. Attempt to highlight text in the thread's current tip message and branch from it; confirm the action is refused (FR-007).
6. Inspect the underlying Pi session file (or a debug endpoint reusing `PiService.readClosedTranscript`-style access) for the document; confirm the root thread and the branch share the same session file path, distinguished only by their recorded leaf entry ids (FR-006, research.md R1) — i.e., not two separate session files.

**Expected**: SC-002; the branch is a genuine same-session Pi branch, not an independent fork.

## Scenario 3 — Multiple siblings from the same message, and frozen non-tip segments (User Story 2, scenarios 8-9)

1. From the same earlier message used in Scenario 2, highlight a second, different passage and branch again.
2. Confirm both branches render as siblings at the same split point, each with its own distinct seed excerpt, alongside the root's own continuation.
3. On the root's non-tip segment (the one ending at the branch point), confirm no compose action is available — only highlight-to-branch.
4. On the root's current tip segment, confirm the compose box is present and works normally.

**Expected**: FR-005b/FR-005c hold — history before a branch point is read-only; only a thread's actual tip accepts new messages.

## Scenario 4 — Done declutters without deleting (User Story 3, FR-008–FR-011)

1. Mark one of the branch threads from Scenario 2/3 done.
2. Confirm it disappears from the default top-down list immediately (SC-003).
3. Open the done/history view; confirm the thread is still there with its full history and seed excerpt intact, and reopen it.
4. Confirm reopening returns it to the default list.
5. With a thread that has a pending (unresolved) staged edit, attempt to mark it done; confirm it is refused until the edit is resolved (FR-010).
6. Mark the root thread done while one of its branches remains active; confirm the branch stays visible in the default list, unaffected (FR-011, Edge Cases).

**Expected**: SC-003/SC-004; done is reversible and never affects unrelated threads.

## Scenario 5 — Genuine Pi-native session export renders in the browser (User Story 4, FR-013)

1. In a thread with at least a couple of exchanged messages, click "Export" on its header.
2. Confirm a viewer opens showing a rendered transcript matching that thread's actual message history, plus a raw, collapsible Pi session export (JSONL) panel.
3. Compare the rendered transcript against the live thread's own messages; confirm they match (SC-005).
4. Try exporting a brand-new thread with no messages yet; confirm the action is refused (`EMPTY_THREAD_EXPORT`).

**Expected**: SC-005 — the export renders in the browser and matches the thread's history at export time; it is Pi's own genuine export (the raw JSONL panel), not a fabricated substitute.
