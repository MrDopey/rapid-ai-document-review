# Quickstart: Configurable Pi Agent Model

Validates the feature end-to-end per spec.md's user stories. See [data-model.md](./data-model.md) for the
configuration value shape and [contracts/environment-config.md](./contracts/environment-config.md) for
the full behavior/precedence contract.

## Prerequisites

- Repo checked out, dependencies installed (`npm install` at repo root).
- A valid provider credential available to the Pi Coding Agent SDK for the "happy path" scenarios (e.g.
  `ANTHROPIC_API_KEY` in the environment, or an existing `PI_CODING_AGENT_DIR/auth.json`) — only needed
  for scenarios that create a real (non-fake) session.

## Scenario 1 — Override picked up (User Story 1)

1. Start the backend with an explicit override:
   ```bash
   RADR_PI_AGENT_MODEL=anthropic/claude-opus-4-5 ANTHROPIC_API_KEY=<key> npm run dev -w app/backend
   ```
2. Create a conversation and send a first message (via the existing HTTP/WS API — see
   `specs/001-ai-document-review/contracts/`).
3. **Expected**: the session's `model` (visible via `AgentSessionLike.model`/session events, or the Pi
   session file's recorded model) is `anthropic/claude-opus-4-5`, regardless of any prior session history.

## Scenario 2 — No override set (User Story 2, backward compatibility)

1. Start the backend with `RADR_PI_AGENT_MODEL` unset (as today).
2. Create a conversation and send a first message.
3. **Expected**: behavior is unchanged from before this feature — SDK auto-resolution applies (prior
   session's model if restoring, else provider default). No new required configuration, no new errors.

## Scenario 3 — Fake-session mode unaffected

1. Start the backend with both `PI_FAKE_SESSIONS=1` and `RADR_PI_AGENT_MODEL=anthropic/claude-opus-4-5` set.
2. Create a conversation and send a first message.
3. **Expected**: identical behavior to `PI_FAKE_SESSIONS=1` alone (deterministic `FakeAgentSession`) — the
   override has no observable effect. Confirms FR-004.

## Scenario 4 — Invalid override fails fast

1. Start the backend with `RADR_PI_AGENT_MODEL=not-a-real-provider/not-a-real-model` (and a real credential
   configured, `PI_FAKE_SESSIONS` unset).
2. Create a conversation and send a first message.
3. **Expected**: the request fails with a clear error naming the invalid `RADR_PI_AGENT_MODEL` value — not a
   silent fallback to auto-resolution, and not an unrelated/opaque SDK error. Confirms FR-006 and
   SC-003.

## Scenario 5 — Blank override treated as unset

1. Start the backend with `RADR_PI_AGENT_MODEL=` (empty) or `RADR_PI_AGENT_MODEL="   "` (whitespace only).
2. Create a conversation and send a first message.
3. **Expected**: identical to Scenario 2 — no error, auto-resolution applies. Confirms FR-005.

## Scenario 6 — Restart required to change model

1. Start with `RADR_PI_AGENT_MODEL=anthropic/claude-opus-4-5`, open a conversation, send a message.
2. Without restarting the process, change the environment variable (e.g. edit `.env`) to a different
   model.
3. Send another message on the same, already-open conversation.
4. **Expected**: still uses the original model (in-process cache unaffected) — confirms FR-007.
5. Restart the backend process with the new value, then create a *new* conversation.
6. **Expected**: the new conversation uses the newly configured model.

## Automated coverage (for implementation, not this command)

- Unit tests: `app/backend/tests/unit` — `RADR_PI_AGENT_MODEL` parsing (unset/blank/valid/malformed
  string) in `config.ts`.
- Contract tests: `app/backend/tests/contract` — `PiService` session creation with/without a valid
  override, using `PI_FAKE_SESSIONS=1` for Scenario 3 and a controlled/mock `ModelRuntime` (or the
  existing `live-pi.test.ts` real-SDK suite, if warranted) for Scenarios 1/4/5's resolution behavior.
