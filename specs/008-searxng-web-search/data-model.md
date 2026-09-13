# Phase 1 Data Model: SearXNG Web Search and Page Fetch for the Review Agent

This feature adds no persistent storage, no database schema, and no document/domain entities.
Both new tool results are ephemeral (spec.md Key Entities) — surfaced to the agent and the
conversation transcript only, never written to SQLite or the document.

## `web_search` parameters

| Field | Type | Notes |
|---|---|---|
| `query` | `string`, min length 1 | The search query. Blank/whitespace-only is rejected with an explanatory text result (edge case), not a thrown error. |

## Search Result (one item of `web_search`'s response)

| Field | Type | Notes |
|---|---|---|
| `title` | `string` | Result title, from SearXNG's JSON response. |
| `url` | `string` | Source URL — the value a subsequent `web_fetch` call would target. |
| `snippet` | `string` | Short excerpt SearXNG returns for the result. |

A `web_search` call returns a bounded list of these (research.md R4: top ~8), rendered as
line-numbered/labeled text the same general shape as `read_document`'s result (title + a header,
then the list) — the exact text layout is model-facing prose and an implementation detail, not a
versioned part of this data model, mirroring `contracts/agent-tools.md`'s treatment of
`read_document`'s result layout.

## `web_fetch` parameters

| Field | Type | Notes |
|---|---|---|
| `url` | `string` (URL) | The page to fetch. Not required to have come from a prior `web_search` result — the tool does not track that association. |

## Fetched Page Content (`web_fetch`'s response)

| Field | Type | Notes |
|---|---|---|
| `url` | `string` | Echoes the requested URL. |
| `text` | `string` | Plain-text extraction of the page body (research.md R3), truncated to a fixed bound with a note when truncated (research.md R4, FR-012). |

## Validation & error rules (both tools)

- **Timeout**: a per-call bound (research.md R6) applies to the outbound HTTP request; expiry
  yields an explanatory error result to the agent (FR-009), never an unhandled exception or a hung
  turn.
- **Unreachable/non-2xx backend**: yields an explanatory error result naming what failed (FR-009).
- **Zero search results**: yields a result that plainly states no results were found (FR-010),
  distinct from an error.
- **`web_fetch` non-textual/binary response**: yields an explanatory error result rather than
  returning binary data as "text".
