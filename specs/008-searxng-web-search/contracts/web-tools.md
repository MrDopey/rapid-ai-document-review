# Contract: `web_search` and `web_fetch` (Pi integration surface)

**Feature**: `008-searxng-web-search` | **Date**: 2026-09-13
**Related**: [../data-model.md](../data-model.md), [../research.md](../research.md) R1-R6,
`specs/001-ai-document-review/contracts/agent-tools.md` (the existing `read_document`/
`propose_document_edit` contract this one extends the same registration pattern for).

This is the contract between the application and the Pi agent for two new tools. Like
`read_document`/`propose_document_edit`, they are registered via `customTools`; no Pi extension is
involved (Principle VII, constitution v2.2.0's carve-out of the "additional agent tools" non-goal).

---

## Tool availability

Both tools are added to the list `PiService.buildTools()` returns for every conversation,
unconditionally — unlike `propose_document_edit`, neither is gated by `max_editing_depth`, since
neither participates in the edit-proposal pipeline (Principle III N/A for these tools):

```ts
private buildTools(conversation: ConversationRow): RegisteredToolLike[] {
  const tools: RegisteredToolLike[] = [
    createReadDocumentTool({ ... }),
    createWebSearchTool({ searxngUrl: config.searxngUrl }),
    createWebFetchTool({}),
  ];
  // propose_document_edit still gated by max_editing_depth, unchanged
  ...
}
```

---

## Tool: `web_search`

Searches the web via a self-hosted SearXNG instance and returns a bounded list of results.

**Parameters**

```ts
Type.Object({
  query: Type.String({ minLength: 1,
    description: "The search query." }),
})
```

**Result — results found**

```text
Web search: "searxng json api format"
5 results

1. SearXNG JSON API — https://docs.searxng.org/dev/search_api.html
   Describes the `format=json` search API and how to enable it in settings.yml...
2. ...
```

**Result — no results**

```text
Web search: "asdkjfhaslkdjfhoiuweqr"
No results found.
```

**Result — backend error**

```text
Web search failed: could not reach the search backend (timed out after 8000ms).
```

**Semantics**

- Read-only (FR-006): cannot create a staged edit or touch the document.
- Available regardless of branch/editing depth (FR-007).
- Each call is independent — no deduplication or caching across calls in one conversation (edge
  cases).
- Blank/whitespace-only `query` returns an explanatory text result, not a thrown error (edge cases),
  matching `read_document`'s handling of invalid `from_line`/`to_line`.
- Results are capped to a small fixed count per call (research.md R4) — not configurable via
  parameters or environment.
- The exact text layout is model-facing prose and an implementation detail (not versioned by this
  contract), the same treatment `agent-tools.md` gives `read_document`'s result layout — only the
  found/no-results/error distinction and the field content (title/url/snippet) are load-bearing.

---

## Tool: `web_fetch`

Fetches a URL and returns its page content as plain text.

**Parameters**

```ts
Type.Object({
  url: Type.String({ minLength: 1,
    description: "The URL to fetch." }),
})
```

**Result — success**

```text
Fetched: https://docs.searxng.org/dev/search_api.html

SearXNG JSON API
The `format=json` output is disabled by default...
[... truncated to 20000 characters; note appended if truncated ...]
```

**Result — error**

```text
Could not fetch https://example.invalid/: request failed (DNS resolution error).
```

**Semantics**

- Read-only (FR-006), available regardless of branch/editing depth (FR-007), same as `web_search`.
- Does not require the URL to have come from a prior `web_search` result (edge cases) — the tool
  has no memory of prior search results.
- HTML responses are converted to plain text (research.md R3); non-textual/binary responses yield
  an explanatory error result rather than binary content (data-model.md).
- Content is bounded to a fixed size with a truncation note when exceeded (FR-012, research.md R4).
- A bounded per-call timeout applies (research.md R6); expiry yields an explanatory error result
  (FR-009), never a hung conversation turn.

---

## Event bridge

Both tools surface through the existing `tool_execution_start`/`tool_execution_end` → `tool_started`/
`tool_completed` mapping already documented in `agent-tools.md`'s event bridge table — no new
application event types are introduced (FR-008). The bridge table in `agent-tools.md` remains
exhaustive over Pi's `AgentSessionEvent` union; this feature adds no new event kinds, only new
tool names flowing through the existing `tool_execution_*` rows.

---

## Contract test expectations

Driven by direct `.execute(...)` calls on the tool objects (research.md R5) against a local HTTP
stub, not a live SearXNG instance:

1. `web_search` with a query that the stub answers with N results returns exactly those N results,
   each with title/url/snippet.
2. `web_search` with a query the stub answers with zero results returns the plain "no results"
   text, not an error.
3. `web_search` against an unreachable/timing-out stub returns an explanatory error result; the
   conversation is not left hung (bounded by the tool's own timeout, not the turn watchdog).
4. `web_search` with a blank query returns an explanatory text result without calling the stub.
5. `web_fetch` against a stub HTML page returns extracted plain text.
6. `web_fetch` against a stub page larger than the size bound returns truncated text with a note.
7. `web_fetch` against a stub returning a non-textual content type returns an explanatory error,
   not binary content.
8. `web_fetch` against an unreachable/timing-out stub returns an explanatory error result.
9. Both tools appear in `PiService.buildTools()`'s output (`getActiveToolNames()`) for every
   conversation regardless of `branchDepth`, unlike `propose_document_edit`.
10. Neither tool's execution creates a `staged_edit` row or emits `staged_edit_created` — asserted
    directly against the storage layer after invoking either tool.
