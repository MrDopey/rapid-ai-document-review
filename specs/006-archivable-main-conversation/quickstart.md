# Quickstart: Validating Archivable Main

Prerequisites: repo installed (`npm install` at root), backend + frontend dev servers runnable per
the project's existing scripts. No new environment variables or services are required by this
feature.

## Setup

```bash
npm run dev   # or the project's existing per-package dev scripts
```

Open the app with a document that already has an active Main conversation.

## Scenario 1 — Archive Main and get a fresh one in place (User Story 1, FR-001–FR-004, FR-007–FR-009)

1. Send a few messages in Main so it has real history.
2. Open Main's conversation detail view; confirm the middle action slot now shows "Archive" (it no
   longer disappears for Main the way it used to).
3. Click Archive and confirm.
4. Confirm the document's Main slot (same top-anchored HUD position, name "Main") immediately shows
   a new, empty conversation — at no point does the HUD show zero Main conversations.
5. Confirm the new Main received a fresh seed message reflecting the document's current content
   (FR-008), not the old Main's history.
6. Confirm the new Main's Primary status: if the archived Main had been Primary, the document now
   shows no Primary conversation (FR-007) — it was not silently transferred to the new Main.
7. Open the archived Main from conversation history: confirm its full prior message history and any
   proposed-edit outcomes are unchanged, it does not carry any "continued from"/forward link to the
   new Main (FR-009), and attempting to send a message, branch, or re-designate it Primary is
   refused the same way any other closed conversation refuses those actions.

**Expected**: matches SC-001 — one archive action, no window where the document lacks a usable
Main.

## Scenario 2 — A branch survives its parent Main's archival (User Story 2, FR-005)

1. From Main, branch into a side conversation and send at least one message in it.
2. Archive Main (per Scenario 1).
3. Confirm the branch is still open, can still receive new messages, and can still be branched
   from (subject to the normal depth limit).
4. Confirm the branch still visibly shows it was branched from that (now-archived) Main.

**Expected**: matches SC-002 — branching off Main's archival is non-destructive to already-open
branches.

## Scenario 3 — Review a past round via an archived Main (User Story 3, FR-010–FR-011)

1. While a Main is current and Primary, let it auto-apply at least one edit (send a message that
   produces an accepted proposal).
2. Archive that Main.
3. Repeat once more: send a message in the new current Main that also auto-applies an edit, then
   archive it too, so the document now has two archived Mains plus one current Main.
4. Open the document's revision history: confirm each auto-applied edit is still attributed to the
   specific (now-archived) Main conversation that produced it.
5. Open the conversation list: confirm the two archived Mains and the current Main are each
   individually identifiable (not just "Main" three times indistinguishably).

**Expected**: matches SC-003 and SC-004.

## Edge cases to spot-check

- Archiving Main while it has an unresolved pending proposal is refused with the same
  "resolve pending proposals first" error as closing any other conversation
  (`PENDING_EDITS_BLOCK_CLOSE`).
- Archiving Main while it is actively responding (`status: 'working'`) is refused
  (`CONVERSATION_BUSY`) — try sending a message, then immediately attempting to archive before the
  response finishes.
- Archiving a Main with zero messages (freshly created, never used) still succeeds and produces a
  new empty Main in its place.
