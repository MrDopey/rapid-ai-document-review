# Quickstart & Validation Guide

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Related**: [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

How to run the application and prove the feature works end to end. Each scenario below maps to a
user story in [spec.md](./spec.md) and is the acceptance gate for that story. Implementation details
belong in `tasks.md`, not here.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node 26.1.0 | Pinned by `.devcontainer/Dockerfile`. Provides built-in `node:sqlite` (research R7). Verify with `node -e "require('node:sqlite')"`. |
| A model provider credential | Pi needs a provider key, e.g. `ANTHROPIC_API_KEY`. Without it, agent scenarios fail with `AGENT_UNAVAILABLE` while document scenarios still pass. |
| Docker (deployment validation only) | Not needed for local development. |
| Playwright browsers | `npx playwright install chromium` before the first e2e run. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `127.0.0.1` | **Do not change.** Localhost-only is the designed and supported configuration (spec Assumptions). |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `PI_SESSION_STORAGE_PATH` | `./data/pi-sessions` | Pi JSONL session directory (design §34) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config/credential directory |
| `LOG_LEVEL` | `info` | pino level (FR-042) |

Runtime behaviour limits are **not** environment variables — they live in `user_settings` and are
editable in the UI or via `PATCH /api/settings` (FR-041). See
[data-model.md §8](./data-model.md) for defaults.

## Setup

```bash
npm install
npm run db:migrate                 # creates DATABASE_PATH and applies the schema
npm run dev                        # backend (watch) + Vite frontend, concurrently
```

Open `http://127.0.0.1:3000`. With no document yet, the paste screen appears.

## Test commands

```bash
npm test                           # Vitest: all unit + integration + contract tests
npm run test:unit                  # fast: reconciliation, limits, sanitizer, debounce
npm run test:integration           # service-level, temp DB + FakePiSession
npm run test:contract              # HTTP/WS shapes against the shared Zod schemas
npm run test:contract:live-pi      # opt-in; needs a provider credential
npm run test:e2e                   # Playwright, one spec per user story
npm run test:e2e -- --grep "US3"   # a single story
```

`npm test` must pass without any provider credential — every agent interaction in the default suite
runs against `FakePiSession` (research R11). Only `test:contract:live-pi` calls a real model.

---

## Validation scenarios

### US1 — Create and edit a document with tracked history (P1)

Covers FR-001 – FR-008, FR-007a. Independently valuable: a Markdown editor with history.

```bash
npm run test:e2e -- --grep "US1"
```

1. **Create**: paste ~200 words of Markdown → the document renders in both panes and a `Main`
   conversation appears in the HUD, marked Primary. Revision list shows `v1 · User · creation`.
2. **Edit and sync**: type in the source pane → the preview updates; open a second browser tab →
   the edit is already there, no reload (FR-003). Both tabs receive
   `document_content_changed`.
3. **Debounced revision**: set `revisionDebounceMs` to `3000` in settings, edit, stop for 4 s →
   exactly **one** new revision appears, marked `User · manual_debounce` (FR-004), not one per
   keystroke.
4. **Restore**: restore `v1` → content matches `v1`, a **new** revision is recorded, and every
   revision in between is still listed (FR-006). Nothing is deleted.
5. **Undo/redo**: `Ctrl+Z` / `Ctrl+Shift+Z` reverse and reapply local edits (FR-007).
6. **Export**: copy and download the current Markdown; then export a specific past revision and
   confirm its content differs from current (FR-007a).
7. **Render and sanitize**: paste a Mermaid fence, an inline `<svg>`, and
   `<img src=x onerror=alert(1)>` → the diagram and SVG render; the `onerror` attribute is absent
   from the DOM (FR-008, Principle VI). Inspect the element to confirm, do not rely on the absence
   of an alert.

**Expected**: revision list attributes every entry to `User`; no agent activity yet.

### US2 — Ask the main conversation about the document (P1)

Covers FR-009, FR-010.

```bash
npm run test:e2e -- --grep "US2"
```

1. Ask `Main` a question about the document → the answer streams token by token and is grounded in
   the current content (FR-010).
2. Enable *Show reasoning* in settings → send again → reasoning appears as it streams. Disable it →
   send again → no reasoning (FR-010, FR-041).
3. **SC-001**: from paste to first Main answer, under 15 s.

### US3 — Branch from a selection and review proposed edits (P2)

Covers FR-011, FR-012, FR-019 – FR-025, FR-033. The central review workflow.

```bash
npm run test:e2e -- --grep "US3"
```

1. **Branch**: highlight a paragraph → *Start conversation from selection* → a child appears in the
   HUD under `Main` with `Main v<n>` as its context. Its first message contains the highlighted text
   plus surrounding context (FR-011, FR-012).
2. **Propose**: ask it to improve the passage → a proposal appears with a summary and a pending
   badge. **The document is byte-identical** — verify against the source pane, not just the preview
   (FR-021, SC-004).
3. **Preview**: open the proposal → both a full-document preview and an added/removed view are
   available (FR-022).
4. **Accept**: accept → the document updates and a new revision appears, attributed to that
   conversation by name (FR-025, SC-008).
5. **Drop**: elicit a second proposal, drop it → the document is unchanged and the proposal is gone
   from pending (FR-023).
6. **Bulk**: elicit three proposals; resolve one individually, then *Drop remaining* → the other two
   resolve together (FR-023).
7. **Act while active**: elicit a proposal, and while the agent is still working, accept it → it
   applies without closing the conversation (FR-024).
8. **Close is blocked**: with one pending proposal, try to close → refused with an explanation naming
   the pending proposals (FR-033). Resolve it, then close successfully.
9. **SC-002**: first branch response within 10 s on a ~15,000-word document.
   **SC-003**: opening a diff and deciding takes under 15 s per proposal.

### US4 — Keep a conversation in sync with a changing document (P2)

Covers FR-016 – FR-018.

```bash
npm run test:e2e -- --grep "US4"
```

1. Start a branch (context `v17`). In `Main`, advance the document (or edit manually) to `v20`.
2. The branch is marked **stale** in the HUD, still showing `v17`, and its behaviour has not changed
   on its own (FR-016).
3. Send normally (`Enter`) → answered against the older context; `read_document` returns `v17`
   content (FR-017).
4. **Refresh + Send** (`Ctrl+Enter`) → the HUD shows `v20`, `conversation_context_refreshed` names
   the included proposals, and the answer reflects the newer document (FR-018).

### US5 — Designate a Primary conversation for automatic edits (P3)

Covers FR-027 – FR-030.

```bash
npm run test:e2e -- --grep "US5"
```

1. `Main` is Primary by default, and exactly one conversation is Primary at all times (FR-027).
2. Ask `Main` for an edit → it applies immediately with a new revision and **no pending proposal
   left behind**. A `staged_edit` row still exists, marked `applied` with `autoApplied: true` — the
   audit trail SC-004 depends on (FR-027).
3. Make a branch Primary while `Main` is working → warned, with three choices offered: switch now,
   don't switch, switch when finished (FR-029). Verify all three.
4. Choose *switch now* → the branch becomes Primary; `Main`'s in-flight operation **continues to
   completion** uninterrupted and simply stops auto-applying afterwards (FR-030).
5. Non-Primary conversations keep staging their proposals throughout (FR-021).
6. **Primary conflict**: force a Primary edit whose anchor no longer matches (edit the document
   manually mid-run) → it is **not** applied and **not** dropped: it is superseded, a replacement is
   requested, and that replacement appears as a **pending proposal for review** (FR-027, US5 #5).

### US6 — Resolve conflicts when applying an out-of-date proposal (P3)

Covers FR-031, FR-032. Test with `test:integration` as well — deterministic conflicts are easiest to
force at the service level.

```bash
npm run test:integration -- --grep "reconcile"
npm run test:e2e -- --grep "US6"
```

1. **Clean**: create a proposal, advance the document *elsewhere* so its anchors still resolve
   uniquely, apply → clean apply and a new revision (FR-031, FR-032 success branch).
2. **`not_found`**: create a proposal, then manually rewrite the exact region it targets, apply →
   conflict. The original is marked superseded, and a replacement appears as a new pending proposal
   informed by the conflict (FR-032).
3. **`ambiguous`**: duplicate the anchored text elsewhere in the document, apply → conflict for
   multiple occurrences, same recovery.
4. **Chained**: let a replacement itself go stale, apply → the same reconcile-then-replace path runs
   again (spec edge case).
5. **SC-005**: in every case above, either both changes are preserved or a conflict is clearly shown.
   Assert the manual edit is still present in the document text after each conflict — never silently
   overwritten.

### US7 — Review closed conversations (P4)

Covers FR-034 – FR-036.

```bash
npm run test:e2e -- --grep "US7"
```

1. Close a conversation with all proposals resolved → it is offered, **separately**, the option to
   fold a compact summary into its parent (FR-034). Take it, and confirm the parent's next answer
   reflects the summary while the child's raw messages were not copied in.
2. Open the closed conversation → history, proposals, and the document context it used are all
   visible; branch and Primary controls are disabled (FR-035). **SC-009**: everything is intact and
   unchanged.
3. Request a review of it → a new review conversation produces a review, and the closed conversation
   is byte-identical afterwards (FR-036). Compare its transcript before and after.

### Cross-cutting scenarios

**Concurrency (FR-015, SC-007)**

```bash
npm run test:e2e -- --grep "concurrency"
```
With `maxConcurrentAgents = 3`, start three agents, then submit a fourth prompt → it is **queued**,
reported with a queue position, and runs when a slot frees. It is never rejected or dropped. Typing
in the editor stays responsive throughout.

**Disconnection and recovery (FR-037, SC-006)**

```bash
npm run test:e2e -- --grep "disconnect"
```
Start a long agent run, kill the browser tab, wait for the run to finish, reopen → the completed
response, any proposal it created, and the current document are all present within 5 s. The
conversation was never marked `errored` — a dropped socket is not a failure (Constitution Quality
Gate).

**Restart recovery (FR-039)**

```bash
npm run test:integration -- --grep "restart"
```
With an open conversation and a pending proposal, restart the backend → document content, revision
history, conversation list (including `pi_session_path` resolution), pending proposals, and Primary
designation are all restored, and connected clients resync.

**Failure and retry (FR-038)**

```bash
npm run test:integration -- --grep "agent error"
```
Force a model failure → the conversation shows `errored` with the message visible, and *Retry*
recovers it to `idle`/`working`.

**Idempotency (FR-040)**

```bash
npm run test:integration -- --grep "idempotent"
```
Deliver the same `propose_document_edit` tool-call id twice → one proposal, one application, one
revision.

**Depth limits (FR-013, FR-026)**

```bash
npm run test:e2e -- --grep "depth"
```
Branch to `maxConversationDepth`, then try once more → **blocked with an explanation**, not silently
ignored. Separately, at a depth beyond `maxEditingDepth`, confirm the conversation still chats and
reads but cannot propose, apply, or refresh-send — the two limits are independent.

**Accessibility (FR-043)**

```bash
npm run test:e2e -- --grep "a11y"
```
Complete the full core loop — paste, edit, branch from selection, review a diff, accept — using the
keyboard only, with no mouse. Verify a screen reader announces conversation status changes and
streaming responses via live regions, and that the editor, HUD, diff viewer, and every interactive
control are reachable and labelled. Run an automated contrast/roles audit over each main view.

**No document yet (edge case)**

```bash
npm run test:contract -- --grep "no document"
```
Before creation, `GET /api/document` returns `404` and conversation endpoints refuse — conversations
cannot start without a document.

---

## Deployment validation

```bash
docker compose -f docker/docker-compose.yml up --build
```

Then confirm:
1. `http://127.0.0.1:3000` serves the application.
2. `DATABASE_PATH` and `PI_SESSION_STORAGE_PATH` are mounted volumes — restart the container and
   confirm the document, revisions, and conversations all survive (FR-039).
3. The image contains no native-module build step, since SQLite comes from `node:sqlite` (research
   R7).
4. `docker logs` shows one JSON object per line with a consistent field set, and the `event` values
   match the names in [contracts/websocket-events.md](./contracts/websocket-events.md) (FR-042).
5. The published port binds to `127.0.0.1` only — confirm the service is unreachable from another
   device on the network.

---

## Definition of done

- [ ] Every US1–US7 scenario above passes.
- [ ] Every cross-cutting scenario passes.
- [ ] SC-001 … SC-009 measured and met.
- [ ] `npm test` green with no provider credential configured.
- [ ] `npm run test:contract:live-pi` green against real Pi, confirming `FakePiSession` has not
      drifted.
- [ ] Deployment validation complete.
