# Specification Quality Checklist: Linear Thread Mode

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-15
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- All three clarifications were resolved in the 2026-09-15 session (see spec.md Clarifications): (1) linear thread mode's threads are a separate set from canvas mode's conversations; (2) branching is triggered by highlighting a passage in any message strictly earlier than a thread's tip, seeding the new branch with that passage as a Markdown blockquote; (3) export means a genuine Pi-native session export/viewer.
- 2026-09-20 session: superseded the per-document runtime mode-toggle framing. A document's type (canvas-mode vs. threaded-conversation) is now chosen once, at document-creation time (extending spec 010's document-creation flow), and is fixed for the document's lifetime. A threaded-conversation document has exactly one root thread, auto-created with the document; no independent second top-level thread can ever be created — every other thread must be a branch. User Story 1, FR-001/FR-003/FR-004/FR-014, Key Entities, Success Criteria (SC-001), and Assumptions were updated accordingly; this introduces a new dependency on spec 010's document-creation flow gaining a type selector.
- `SessionManager.branch()` (leaf-repositioning within one Pi session, as opposed to `forkFrom`, which creates a separate session file) is noted only in Assumptions/Key Entities as a constraint on how branch relationships must behave (a genuine shared-tree branch, not an independent copy) — the specific SDK method name itself is deliberately kept out of the functional requirements, which stay implementation-agnostic per Constitution Principle II.
- **Resolved 2026-09-20**: the constitution amendment removing the "Pi export viewing" non-goal landed (constitution v2.4.0), narrowly carving out read-only rendering of a thread's genuine, native Pi session export (obtained via the Pi SDK, per Principle II) without licensing any fabricated/reformatted substitute. FR-013/User Story 4 is unblocked for planning; a follow-up `/speckit-plan` run is needed to actually produce its research/data-model/contract/tasks (see research.md R8). Stories 1-3 were never blocked by this.
- **Planned 2026-09-20 (follow-up)**: User Story 4/FR-013's research/data-model/contract/tasks were produced (research.md R9: `SessionManager.createBranchedSession()` on a throwaway instance, never the shared cached one, so the export is genuinely SDK-obtained and testable under `RADR_BE_PI_FAKE_SESSIONS=1`) and implemented — the spec is no longer just planned but built.
