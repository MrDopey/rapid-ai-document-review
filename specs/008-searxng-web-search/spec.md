# Feature Specification: SearXNG Web Search and Page Fetch for the Review Agent

**Feature Branch**: `008-searxng-web-search`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "https://github.com/searxng/searxng, add this to the devcontainer, and then include this as a tool call for the pi agent to use"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent grounds answers and proposals in current web information (Priority: P1)

While reviewing a document with the agent, a user asks a question or requests a change that
depends on information the agent cannot know from the document alone or from what it was trained
on (a current fact, a recent standard, a live reference). The agent searches the web, and — when a
result looks worth reading in full rather than just its snippet — fetches that page's content, and
uses what it finds to inform its reply or its edit proposal.

**Why this priority**: This is the actual product value of the feature — everything else exists to
support it. Without it, "add search" is just unused infrastructure.

**Independent Test**: In a conversation, ask the agent something whose correct answer requires
current web information (e.g. a fact not in the document and not evergreen). Confirm the agent
issues a search, optionally fetches a result page's full content, both activities appear in the
conversation transcript, and the agent's response reflects information plausibly drawn from them.

**Acceptance Scenarios**:

1. **Given** an active conversation at any branch depth, **When** the user asks a question that
   benefits from current web information, **Then** the agent may call the search tool and the
   resulting query and a summary of results appear in the conversation transcript as a distinct
   tool activity.
2. **Given** a search result whose snippet is insufficient, **When** the agent calls the page-fetch
   tool with that result's URL, **Then** the agent receives the page's textual content and that
   fetch appears in the conversation transcript as its own distinct tool activity.
3. **Given** a search or fetch returns results/content, **When** the agent continues its turn,
   **Then** the agent's reply or edit proposal is generated normally through the existing
   chat/proposal flow — neither search results nor fetched page content ever bypass that flow to
   write into the document directly.
4. **Given** a search returns zero results, **When** the agent receives the tool result, **Then**
   the agent is told plainly that no results were found and continues the conversation without
   erroring.
5. **Given** the search backend or a fetched page is unreachable or returns an error, **When** the
   agent calls the corresponding tool, **Then** the agent receives an explanatory error result and
   the conversation continues (chat and document reading remain unaffected) rather than the run
   failing.

---

### User Story 2 - Developer has a working search backend with zero setup (Priority: P2)

A developer opens the project in the devcontainer to build or test the web search tool. They need
a real search backend to call without signing up for a third-party search API, generating an API
key, or paying for usage during development.

**Why this priority**: User Story 1 cannot be built, tested, or demonstrated without something for
the tool to call. This is the enabling infrastructure, but it delivers no value by itself.

**Independent Test**: Open the devcontainer fresh, take no manual setup steps beyond the normal
container start, and confirm a self-hosted search instance is already running and reachable from
inside the container.

**Acceptance Scenarios**:

1. **Given** a fresh devcontainer build, **When** the container finishes its normal startup, **Then**
   a self-hosted search engine instance is running and reachable from within the container without
   any additional manual step, account, or credential.
2. **Given** the devcontainer is already running, **When** the developer restarts it, **Then** the
   search instance comes back up the same way, with no data or configuration lost that the
   developer would need to redo.

---

### Edge Cases

- Search query is empty or whitespace-only.
- Search backend is slow to respond (the tool call should not hang the conversation indefinitely).
- Search backend is temporarily down at devcontainer startup but becomes available moments later.
- The same query is issued repeatedly in one conversation (no requirement to deduplicate; each
  call is independent, same as `read_document`).
- A conversation deeper than any editing limit still has full access to the search and fetch
  tools, since neither is an edit action.
- The agent tries to fetch a URL that was never returned by a search result.
- A fetched page is extremely large, not textual (binary/media), or requires authentication.
- A fetched page is slow to respond or hangs (the tool call should not hang the conversation
  indefinitely).
- A fetched URL redirects, 404s, or otherwise fails to resolve to content.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The development environment MUST provide a running, self-hosted web search engine
  instance, reachable from inside the devcontainer, with no external account or API key required.
- **FR-002**: The search engine instance MUST come up automatically as part of the devcontainer's
  normal startup — no manual step is required of the developer before it is usable.
- **FR-003**: The agent MUST have access to a tool that performs a web search for a given query and
  returns a set of results (at minimum a title, a source URL, and a short snippet per result) as
  text the agent can reason over.
- **FR-004**: The agent MUST have access to a second tool that fetches a given URL and returns that
  page's textual content (beyond a search snippet) as text the agent can reason over.
- **FR-005**: Both tools MUST be registered the same way the existing `read_document` and
  `propose_document_edit` tools are — as custom tools the application supplies to the agent
  session — and MUST NOT require introducing a Pi extension.
- **FR-006**: Both tools MUST be read-only: neither MUST modify the document, create a staged edit,
  or otherwise participate in the edit-proposal pipeline.
- **FR-007**: Both tools MUST be available to a conversation regardless of its branch or editing
  depth, the same as `read_document` — depth limits govern edit proposals, not
  information-gathering.
- **FR-008**: Each search- or fetch-tool invocation MUST be visible in the conversation's event
  stream as a distinct tool activity (started/completed), the same way other tool calls are
  surfaced, so a user reviewing the conversation can see when and why the agent searched or
  fetched a page.
- **FR-009**: If the search backend or a fetched page is unreachable, times out, or returns an
  error, the corresponding tool MUST return an explanatory error result to the agent instead of
  failing the conversation run.
- **FR-010**: If a search returns no results, the tool MUST return a result that plainly says so,
  rather than an empty or ambiguous response.
- **FR-011**: The search backend's endpoint MUST be configurable, so that an environment other than
  the devcontainer (e.g. production) can point the tool at a different self-hosted instance without
  a code change.
- **FR-012**: The fetch tool MUST bound how much of a page it returns to the agent (e.g. a maximum
  content length), so an unusually large page cannot stall or overwhelm the conversation.

### Key Entities

- **Search Result**: One item returned by a search — a title, a source URL, and a short snippet.
  Ephemeral: surfaced to the agent and in the conversation transcript, never persisted as document
  content or written to the document on its own.
- **Fetched Page Content**: The textual content retrieved from a single URL, typically one named
  by a prior Search Result. Ephemeral in the same way — it informs the agent's reasoning and
  appears in the transcript, but is never written to the document except through the normal
  edit-proposal flow.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can open the devcontainer and, with zero manual setup steps, have a
  working web search backend available for local development and testing.
- **SC-002**: In a live conversation, a query whose answer depends on current web information is
  answered using information the agent could only have obtained via a search, with the search
  activity visible in the transcript.
- **SC-003**: 100% of search- and fetch-tool invocations appear in the conversation transcript as a
  distinct, auditable tool activity — zero cases of a search result or fetched page entering the
  document without going through the existing proposal/acceptance flow.
- **SC-004**: When the search backend or a fetched page is unreachable, 100% of affected
  conversations continue to support chat and document reading; none crash or become stuck as a
  result of a failed search or fetch call.

## Assumptions

- The devcontainer's self-hosted search instance (SearXNG) needs to be reachable only from inside
  the devcontainer's network — it does not need to be exposed to the public internet.
- The search tool itself returns a bounded list of top results (title, URL, snippet); a page's full
  content is retrieved only via the separate fetch tool, on the agent's own decision that a
  snippet is insufficient — the two tools are distinct, not merged into one call.
- The fetch tool fetches content the same way SearXNG's own results are reachable — ordinary public
  web pages — and is not expected to render JavaScript-heavy pages or bypass paywalls/auth.
- The production deployment (`docker/docker-compose.yml`) bundles its own `searxng` service, the
  same as the devcontainer; an operator MAY still point the configurable search endpoint at a
  different externally-provided SearXNG-compatible instance instead via `docker/.env`.
- The search tool requires no per-user authentication or API key, consistent with SearXNG's
  self-hosted, keyless design.
- Automated tests exercise the search tool via a fake/deterministic double, the same way agent
  conversations are tested today via `RADR_BE_PI_FAKE_SESSIONS`, rather than depending on a live
  SearXNG instance being reachable in CI.
