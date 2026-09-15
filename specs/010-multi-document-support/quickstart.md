# Quickstart: Validating Multi-Document Support

Prerequisites: repo dependencies installed (`npm install` at root), SQLite migrations applied (`npm run db:migrate`), backend and frontend dev servers running (`npm run dev`, `npm run dev:frontend`).

## Scenario 1 — Create and switch (User Story 1)

1. Open the app; note the current document's title in the header.
2. Click the title-bar dropdown → "+ New document". A new empty document becomes active; its title appears in the header and as a second entry in the dropdown.
3. Type distinct Markdown content into the new document.
4. Open the dropdown, select the original document. Confirm its content is exactly as left (not merged with or overwritten by the new document).
5. Switch back to the new document via the dropdown; confirm its content persisted.
6. Repeat step 4-5 using the `Ctrl+Alt+[` / `Ctrl+Alt+]` keyboard shortcut instead of the dropdown; confirm identical behavior without using the mouse.

**Expected**: Matches spec.md Acceptance Scenarios US1 #1-5. Verified via `app/frontend/tests/component` (dropdown) + Playwright e2e (`tests/`, cross-document switch flow).

## Scenario 2 — Isolation of conversations and history (User Story 2)

1. In Document A, start a conversation and send a message that triggers a streaming agent response.
2. While the response is still streaming, switch to Document B via the dropdown.
3. Confirm Document B shows only its own (fresh) Main conversation — no trace of Document A's conversation.
4. Switch back to Document A; confirm the streamed response completed in full while backgrounded.
5. Inspect each document's revision history panel; confirm each contains only its own revisions.

**Expected**: Matches spec.md Acceptance Scenarios US2 #1-3, SC-003. Verified via `app/backend/tests/integration` (event stream continues for a backgrounded document) + contract tests asserting `document_id` scoping on list/stream endpoints.

## Scenario 3 — Rename and delete (User Story 3)

1. Rename the active document from the header/dropdown; confirm the new title appears in both places immediately.
2. With 2+ documents open, delete a non-active document (with confirmation); confirm it disappears from the dropdown and `GET /api/documents` no longer lists it.
3. Reduce to exactly one document; attempt to delete it; confirm the system blocks the deletion (`409` / `last_document` error surfaced to the user).

**Expected**: Matches spec.md Acceptance Scenarios US3 #1-4.

## Scenario 4 — Restart persistence

1. With 2+ documents open, make Document B active, then restart the backend process.
2. On reload, confirm all documents reappear in the dropdown with content/history/conversations intact, and Document B is active again.

**Expected**: Matches spec.md SC-005, FR-011.

## Running the automated checks

```sh
npm run test:unit         # backend + frontend unit tests, incl. StorageAdapter/DocumentService keying
npm run test:integration  # backend integration tests, incl. cross-document isolation + background streaming
npm run test:contract     # HTTP/WS contract tests against the routes in contracts/http-and-ws.md
npm run test:e2e          # Playwright: full create/switch/rename/delete flows incl. keyboard shortcut
```
