# Feature Specification: Always-On Agent Activity Logging

**Feature Branch**: `009-agent-activity-logging`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "Decouple the agent's reasoning and tool-call activity (search queries, fetched URLs, and their results) from the 'Show reasoning' display toggle. This information must always be captured in the persisted conversation history; the toggle should only control what the frontend chooses to render, not what the backend records."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete activity record regardless of display setting (Priority: P1)

A reviewer is using the document-review agent with "Show reasoning" turned off (today's default). The agent runs a web search, fetches a page, and reasons about what it found before responding. Later, the reviewer (or a teammate) needs to audit exactly what the agent searched for, which pages it read, and what it concluded internally — even though "Show reasoning" was off at the time.

**Why this priority**: Without this, an entire class of agent activity is unrecoverable after the fact. The record of what the agent actually did is currently determined by a display preference set at run time, which means the same action (running the agent) produces a materially different, permanently incomplete history depending on an unrelated UI setting.

**Independent Test**: With "Show reasoning" off, run a turn that uses a search tool and produces reasoning. Turn "Show reasoning" on afterward (without re-running the turn) and confirm the full reasoning and tool-call detail for that already-completed turn is now visible — proving the data was captured, not merely hidden live.

**Acceptance Scenarios**:

1. **Given** "Show reasoning" is off, **When** the agent performs a web search and reasons about the results, **Then** the search query, the returned results, and the reasoning text are all recorded in the conversation history.
2. **Given** a turn recorded while "Show reasoning" was off, **When** a user later turns "Show reasoning" on and reopens that conversation, **Then** the previously-hidden reasoning and tool-call detail for that turn are now visible, with no data loss.
3. **Given** "Show reasoning" is off, **When** the agent fetches a URL, **Then** the fetched URL and a record of its result are captured even though nothing about the fetch is shown live to the user.

---

### User Story 2 - "Show reasoning" becomes a pure display preference (Priority: P2)

A user toggles "Show reasoning" on and off while reviewing a conversation. The toggle should feel like a view filter (like show/hide a column), not a recording switch — flipping it never changes what happened, only what the user currently sees.

**Why this priority**: This is the direct consequence of Story 1, but called out separately because it changes the mental model the user should have of the setting, and because it constrains where the gating logic is allowed to live (client-side only).

**Independent Test**: Flip "Show reasoning" on and off multiple times while viewing the same already-completed conversation and confirm no new agent activity occurs and no data changes — only the visible content in the transcript changes.

**Acceptance Scenarios**:

1. **Given** an open conversation, **When** the user toggles "Show reasoning" off, **Then** reasoning and tool-call detail already loaded disappear from view without any request to re-run or discard history.
2. **Given** an open conversation, **When** the user toggles "Show reasoning" on, **Then** previously-hidden reasoning and tool-call detail for every turn in that conversation (past and present) becomes visible immediately, without needing the agent to run again.

---

### User Story 3 - See what the agent searched for and cited (Priority: P1)

A reviewer wants to know which search results or fetched pages the agent used to justify a claim or a suggested edit, so they can independently verify the source.

**Why this priority**: Search/fetch tool calls are currently a black box in the recorded history — only the tool's name and success/failure are kept, never the query, URL, or the content returned. Without this, "the agent looked something up" is unverifiable after the fact, which undermines trust in agent-suggested changes that rely on external information.

**Independent Test**: Ask the agent a question that requires a web search, then inspect that turn's recorded history and confirm the exact search query, the URLs of the results considered, and the fetched content (if any) are all present, independent of whether "Show reasoning" is on.

**Acceptance Scenarios**:

1. **Given** the agent runs a search tool, **When** the turn completes, **Then** the recorded history includes the search query and the list of result URLs/snippets returned.
2. **Given** the agent fetches a specific URL, **When** the turn completes, **Then** the recorded history includes that URL and a record of the content that was retrieved (bounded in size).
3. **Given** a tool call fails or times out, **When** the turn completes, **Then** the recorded history still shows that the call was attempted (query/URL and failure reason), not just silence.

### Edge Cases

- What happens when a tool call's result is very large (e.g. a long fetched page or many search results)? The captured record must be bounded so a single tool call cannot cause unbounded storage growth; older/overflow content is truncated with a clear indication that truncation occurred.
- What happens to activity already recorded before this feature ships, where reasoning was discarded because "Show reasoning" was off at the time? That older history remains permanently incomplete for those specific past turns — this feature only guarantees completeness going forward, not retroactively for data that was never captured.
- What happens when a conversation branches or a turn is retried? Each attempt's tool-call and reasoning activity is recorded against that specific attempt, so retries don't overwrite or merge with the record of the original attempt.
- What happens if the agent produces reasoning or a tool call but the turn errors out before finishing? Whatever activity happened before the error is still recorded, not discarded along with the failed turn.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST record an agent turn's reasoning text in the persisted conversation history whenever the agent produces any, regardless of the current "Show reasoning" setting.
- **FR-002**: System MUST record, for every tool call the agent makes, the tool's name and its input arguments (e.g. the search query, the URL to fetch) in the persisted conversation history, regardless of the current "Show reasoning" setting.
- **FR-003**: System MUST record, for every completed tool call, a bounded representation of its result (e.g. the search results returned, the fetched page's content or a truncated excerpt of it) in the persisted conversation history, regardless of the current "Show reasoning" setting.
- **FR-004**: System MUST record a tool call that failed or timed out, including its input arguments and the failure reason, distinctly from a successful call.
- **FR-005**: The "Show reasoning" setting MUST only affect what the frontend renders to the user; it MUST NOT affect what the backend records or transmits to the client.
- **FR-006**: Users MUST be able to toggle "Show reasoning" on for an already-completed conversation and see the full, previously-recorded reasoning and tool-call detail for every past turn, not only turns that happen after the toggle is flipped.
- **FR-007**: System MUST bound the size of a single tool call's recorded result so that no individual tool call can store an unbounded amount of data; when truncated, the record MUST indicate that truncation occurred.
- **FR-008**: System MUST continue to record reasoning and tool-call activity that occurred before a turn errors out, rather than discarding it when the turn ends in failure.

### Key Entities

- **Turn activity record**: The reasoning text and the set of tool calls (each with its name, input, result or failure, and timing) produced by the agent during one turn. Exists independent of any display preference.
- **Tool call record**: One invocation of a tool during a turn — its name, the input given to it (e.g. query or URL), and either its bounded result or its failure reason.
- **Display preference ("Show reasoning")**: A per-user setting that controls only what the client currently renders from the (always-complete) turn activity record; it has no bearing on what gets recorded.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of agent turns that perform a tool call or produce reasoning have that activity present in the conversation's recorded history, independent of the "Show reasoning" setting at the time.
- **SC-002**: A user can toggle "Show reasoning" on for any past conversation and immediately see full reasoning/tool-call detail for turns that ran while the setting was off, with zero turns re-run.
- **SC-003**: For a turn that uses a search or fetch tool, a reviewer can identify the exact query/URL used and the content returned, without needing to re-run the agent, for 100% of such turns.
- **SC-004**: No single tool call's recorded result exceeds the defined size bound, verified across turns involving large fetched pages or large search result sets.

## Assumptions

- "Show reasoning" refers to the existing per-user display setting that currently gates both live streaming and persistence of reasoning text; this feature removes only the persistence/transmission gating, not the setting itself.
- The size bound for a recorded tool-call result is a backend-configured limit (not user-configurable per call), consistent with existing bounded-output patterns already used elsewhere in tool execution.
- Frontend presentation of the newly-always-available tool-call detail (e.g. how search queries/results are displayed in the transcript) is in scope for this feature at a basic level (some visible representation must exist), but a fully designed UI treatment is not mandated beyond making the information visible and legible.
- This feature does not change what data is sent to the underlying model for reasoning — it only changes what the application records/transmits about reasoning and tool calls that already occur.
- Existing conversations recorded before this feature ships are not backfilled; the completeness guarantee applies only to activity recorded after the change is deployed.
