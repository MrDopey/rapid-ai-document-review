export type RevisionSource = 'user' | 'agent';
export type RevisionOrigin = 'creation' | 'manual_debounce' | 'agent_edit' | 'restore';

export type DocumentType = 'canvas' | 'thread';

export interface Document {
  id: string;
  title: string;
  currentRevision: number;
  /** Fixed at creation (011-linear-thread-mode, FR-001/FR-014); immutable thereafter. */
  documentType: DocumentType;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  revision: number;
  documentId: string;
  source: RevisionSource;
  origin: RevisionOrigin;
  conversationId: string | null;
  conversationName: string | null;
  stagedEditId: string | null;
  restoredFrom: number | null;
  note: string | null;
  autoApplied: boolean;
  createdAt: string;
}

export type ConversationKind = 'main' | 'branch' | 'review' | 'thread-root' | 'thread-branch';
export type ConversationStatus = 'idle' | 'working' | 'errored' | 'closed';

export interface ConversationSeedSelection {
  from: number;
  to: number;
  text: string;
}

export interface Conversation {
  id: string;
  documentId: string;
  parentId: string | null;
  name: string;
  kind: ConversationKind;
  status: ConversationStatus;
  errorMessage: string | null;
  isPrimary: boolean;
  isCurrentMain: boolean;
  contextRevision: number;
  branchDepth: number;
  seedSelection: ConversationSeedSelection | null;
  /** The id of the parent conversation's last message at the point of branching, when this
   *  branch was created from within a conversation (no `selection` given). `null` for Main, for
   *  a review conversation, and for a branch created from a document `selection` — that anchor
   *  mechanism is `seedSelection` instead (005-canvas-conversation-threads). */
  forkedFromMessageId: string | null;
  /** 011-linear-thread-mode: non-`null` once a reviewer marks this Thread done; `null` for every
   *  non-thread `kind`. */
  doneAt: string | null;
  /** 011-linear-thread-mode: the highlighted passage that seeded a `thread-branch`; `null` for
   *  `thread-root` and every non-thread `kind`. */
  seedExcerptText: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;

  // Server-computed, never persisted
  isStale: boolean;
  canEdit: boolean;
  canBranch: boolean;
  pendingEditCount: number;
  readOnly: boolean;
  /** `false` when `seedSelection` is null; otherwise true once the document's current content at
   *  that range no longer matches the text recorded at branch time (contracts/conversation-anchor.md,
   *  005-canvas-conversation-threads). */
  anchorOrphaned: boolean;
}

export type StagedEditStatus = 'pending' | 'applied' | 'dropped' | 'superseded';
export type ConflictReason = 'not_found' | 'ambiguous' | 'overlapping';

export interface ConflictDetailOperation {
  index: number;
  reason: ConflictReason;
  occurrences: number;
}

export interface ConflictDetail {
  operations: ConflictDetailOperation[];
}

export interface EditOperation {
  old_string: string;
  new_string: string;
}

export interface StagedEdit {
  id: string;
  documentId: string;
  conversationId: string;
  piToolCallId: string;
  sourceRevision: number;
  summary: string;
  operations: EditOperation[];
  status: StagedEditStatus;
  autoApplied: boolean;
  appliedRevision: number | null;
  supersedesId: string | null;
  conflictDetail: ConflictDetail | null;
  replacementAttempt: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UserSettings {
  thinkingVisible: boolean;
  revisionDebounceMs: number;
  maxConcurrentAgents: number;
  maxEditingDepth: number;
  maxConversationDepth: number;
  maxReplacementAttempts: number;
  softWordCountThreshold: number;
}

/**
 * FR-041's single source of truth for `user_settings`' default values — previously hand-typed
 * independently in the SQLite migration's `DEFAULT` clauses and (at least potentially) any other
 * place that needed to know a setting's out-of-the-box value. The migration interpolates these
 * into its `CREATE TABLE` SQL rather than re-declaring the literals.
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  thinkingVisible: false,
  revisionDebounceMs: 300_000,
  maxConcurrentAgents: 3,
  maxEditingDepth: 2,
  maxConversationDepth: 3,
  maxReplacementAttempts: 2,
  softWordCountThreshold: 20_000,
};

/**
 * True for an assistant message segment with no visible text and no reasoning — the real Pi SDK's
 * tool-call-carrier segment (backend `event-bridge.ts`'s `message_end` handling) reads this way,
 * so the UI treats it the same as reasoning content: hidden by default, revealed by the "Show
 * reasoning" toggle, instead of always rendering as a blank "Assistant" bubble.
 *
 * The single source of truth for `MessageDto.isToolCallCarrier` (contracts/http.ts): computed
 * fresh from the stored/broadcast `text`/`reasoning` facts (no separate persisted
 * `isToolCallCarrier`/`hasToolCall` field) per this app's event-sourcing architecture — events
 * store raw facts, and this interpretation is derived at read time instead, so a future change to
 * it applies retroactively with no backfill/migration. The persisted `message_completed` event's
 * `data` (shared/contracts/events.ts's `MessageCompletedEvent`) never carries this field either,
 * so BOTH the backend's REST path (`conversation-service.ts`'s `buildMessages`, for
 * `GET /conversations/:id`) and the frontend's own WS live-broadcast handler
 * (`stores/conversations.ts`'s `message_completed` case, which sees the exact same raw
 * `text`/`reasoning` over the wire) call this one function, so a live-streamed update and a page
 * reload can never classify the same message differently.
 */
export function computeIsToolCallCarrier(data: {
  text: string;
  reasoning: string | null | undefined;
}): boolean {
  return data.text === '' && !data.reasoning;
}

/**
 * Wraps a highlighted passage from a thread-mode conversation in its own `<branch-seed-excerpt>`
 * tag pair — the same XML-tagging convention `seed-excerpt.ts`'s own `wrapDocumentRevision`/
 * `wrapHighlightedSelection` use for canvas-mode seeds (constitution's Quality & Review Gates
 * rule), under a distinct tag name since this excerpt is a passage from prior *conversation* text,
 * not document content.
 *
 * Lives here (not backend-only `conversation/seed-excerpt.ts`) because it now has two genuinely
 * separate callers on two separate sides of the wire that must always produce byte-identical
 * output: the backend's `ThreadService.branchFromHighlight` (seeds a brand-new branch's first
 * message, FR-005a) and the frontend's `stores/thread.ts` `quoteHighlightIntoComposer` ("Quote
 * from here" — seeds the *same* thread's own next composer message, no branch/new session
 * involved). Both actions share this one builder rather than each formatting the tag by hand, so
 * they can never drift apart.
 */
export function buildThreadBranchSeedMessage(highlightedText: string): string {
  const tag = 'branch-seed-excerpt';
  return [`<${tag}>`, '', highlightedText, '', `</${tag}>`].join('\n');
}
