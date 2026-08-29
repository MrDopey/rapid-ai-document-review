# Feature Specification: Configurable Pi Agent Model

**Feature Branch**: `002-pi-agent-model-config`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Make the Pi Coding Agent backend's LLM model configurable instead of relying solely on SDK auto-resolution. Support: (1) an explicit model override read from environment variables (e.g. RADR_PI_AGENT_MODEL / PI_AGENT_PROVIDER), consumed in app/backend/src/config.ts and passed through to pi-service.ts's createAgentSession call, and (2) documentation of the existing models.json fallback. If no override env var is set, current auto-resolution behavior (SDK default/last-used model) is preserved."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pin the agent to a specific model via deployment configuration (Priority: P1)

An operator deploying the application (locally, in a container, or in a hosted environment) wants every new agent conversation to use a specific, known model and provider, without editing application code or maintaining a separate credentials file.

**Why this priority**: This is the core of the request — today the model is picked implicitly by the underlying agent SDK, which makes behavior unpredictable across environments and hard to pin for testing, cost control, or compliance reasons. Giving operators a direct configuration knob is the minimum viable version of this feature.

**Independent Test**: Set the model/provider configuration values in the environment, start the backend, start a new agent conversation, and confirm (via session/agent metadata or logs) that the specified model was used — without touching any code or existing per-agent-directory config files.

**Acceptance Scenarios**:

1. **Given** the operator has set a valid model and provider via environment configuration, **When** the backend starts and a new agent conversation is created, **Then** the conversation uses the specified model/provider instead of whatever the SDK would have auto-selected.
2. **Given** the operator has set only a model value without a provider (or vice versa), **When** the backend starts, **Then** the system either derives the missing value sensibly or fails fast at startup with a clear error identifying which value is missing — it does not fail silently or start with an ambiguous configuration.
3. **Given** an existing conversation was started under a previously configured model, **When** the operator changes the environment configuration and restarts the backend, **Then** new conversations use the newly configured model while previously recorded session history remains readable and unaffected.

---

### User Story 2 - Preserve current behavior when no override is set (Priority: P1)

An operator who does not set any model configuration wants the application to keep working exactly as it does today, so this feature introduces no risk to existing deployments (including automated tests that run without any model configuration).

**Why this priority**: Backward compatibility is a hard constraint from the request ("current auto-resolution behavior is preserved"). Without this guarantee, the feature would be a breaking change.

**Independent Test**: Start the backend with no model/provider configuration set (as today), start a new agent conversation, and confirm behavior is unchanged from before this feature existed (including the credential-free fake-session development mode).

**Acceptance Scenarios**:

1. **Given** no model/provider override is configured, **When** the backend starts and a conversation is created, **Then** the model is chosen exactly as it was before this feature (prior session's model, else provider default), with no new required configuration.
2. **Given** the credential-free fake-session development mode is enabled, **When** the backend starts, **Then** the presence or absence of a model override has no effect on that mode.

---

### User Story 3 - Understand available configuration options (Priority: P2)

A developer or operator setting up the application for the first time wants clear documentation of every way the agent's model can be controlled — environment-based override versus the existing per-agent-directory file-based override — so they can choose the right mechanism and understand which one wins if both are present.

**Why this priority**: Without documentation, the new override risks being unused or misused, and its interaction with the existing file-based mechanism would be a recurring point of confusion.

**Independent Test**: Follow only the project's setup documentation, with no prior knowledge of the code, and correctly configure a specific model using the environment-based override; separately, correctly determine (from the docs alone) which mechanism takes precedence when both are configured.

**Acceptance Scenarios**:

1. **Given** the project's setup documentation, **When** a new developer reads it, **Then** they can identify all available ways to control the agent's model and the precedence order between them.
2. **Given** both the environment-based override and the existing file-based configuration are present, **When** the backend resolves which model to use, **Then** the documented precedence order is what is actually applied.

### Edge Cases

- What happens when the environment configuration names a model/provider combination that the configured credentials cannot actually authenticate with? The system must surface a clear, actionable error rather than silently falling back or crashing without explanation.
- What happens when the environment-based override and the existing per-agent-directory file-based configuration disagree? The documented precedence order (see User Story 3) must be applied consistently and predictably.
- What happens when the override configuration is set for one running conversation but changed while other conversations are still in progress? In-progress conversations are unaffected until they are restarted; only newly created conversations pick up the change.
- What happens when the override value is present but empty or malformed (e.g., blank string)? It must be treated as "not set" (falling back to current auto-resolution behavior), not as an error or an attempt to use an empty value.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support specifying the agent's model and provider via deployment-level configuration (environment variables), separate from any code change or per-agent-directory file.
- **FR-002**: System MUST apply this configured override to every newly created agent conversation for as long as the configuration remains set.
- **FR-003**: System MUST preserve today's behavior — automatic model resolution via the underlying SDK — whenever no override configuration is supplied, with no change in required setup for existing deployments.
- **FR-004**: System MUST NOT let the override configuration affect the credential-free fake-session development mode.
- **FR-005**: System MUST treat an empty or blank override value the same as an unset one (falls back to current auto-resolution behavior).
- **FR-006**: System MUST fail fast with a clear, actionable error at startup or conversation-creation time when the override configuration is invalid or incomplete in a way that cannot be resolved automatically, rather than silently ignoring it or failing deep inside unrelated logic.
- **FR-007**: System MUST NOT change the model used by conversations that already exist / are already in progress when the override configuration changes; the change only applies to newly created conversations after a restart.
- **FR-008**: Project documentation MUST describe every supported way to control the agent's model (the new environment-based override and the existing file-based configuration) and MUST state the precedence order when more than one is present.

### Key Entities

- **Model Configuration**: The resolved model + provider selection that governs a newly created agent conversation. Sourced from (in precedence order, to be documented): environment-based override, then existing file-based per-agent-directory configuration, then SDK default/last-used-model auto-resolution.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can pin every new agent conversation to a specific model/provider using only deployment configuration, with zero code changes, in under 5 minutes using the documentation alone.
- **SC-002**: 100% of existing deployments and automated test runs that set no model configuration continue to behave identically to before this feature shipped.
- **SC-003**: Given an invalid or incomplete override configuration, an operator can identify the specific problem from the error message alone, without reading source code.
- **SC-004**: A new developer can correctly answer "which configuration wins if both are set?" using only the project's documentation, without asking another person or reading code.

## Assumptions

- "Operator" refers to whoever controls the backend process's environment (a developer running it locally, or whoever manages the container/hosting environment) — not an end user of the document-review product itself.
- The existing per-agent-directory file-based model configuration (already supported by the underlying agent SDK) continues to exist unchanged; this feature adds an additional, higher-level override on top of it rather than replacing it.
- "Fails fast with a clear error" means the error is visible in server startup logs or the conversation-creation response, consistent with how other configuration/credential problems are currently surfaced in this project.
- Changing the model configuration requires restarting the backend process; live hot-reloading of model configuration for already-running conversations is out of scope.
