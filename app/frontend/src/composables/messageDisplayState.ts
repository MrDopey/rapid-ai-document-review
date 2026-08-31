/**
 * Per-viewer, `localStorage`-backed persistence for `MessageDisplayState.expanded`
 * (data-model.md, specs/005-canvas-conversation-threads) — whether a given message defaults to
 * its compact, capped-height form or is expanded to show its full content. Keyed by `messageId`
 * only (not per-conversation): the data model scopes this state to the message itself, and a
 * message id is already globally unique. Same read-merge-write shape as `panePersistence.ts`, so
 * a bulk write (data-model.md's "purely a batch write over the same per-message field" — no
 * separate stored bulk state) is one `localStorage` write, not one per message.
 */
const MESSAGE_EXPANDED_KEY = 'raidr:messageExpanded';

type ExpandedRecord = Record<string, boolean>;

function readStored(): ExpandedRecord {
  try {
    const raw = localStorage.getItem(MESSAGE_EXPANDED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as ExpandedRecord) : {};
  } catch {
    return {};
  }
}

/** Defaults to `defaultExpanded` (FR-008: compact until expanded, for messages that don't opt into
 *  a different default) whenever nothing has ever been *explicitly* stored for this message —
 *  i.e. the user has never toggled it themselves. Once a value is stored (either direction), that
 *  explicit choice always wins over whatever default the caller passes, so re-collapsing a message
 *  the user previously expanded (or vice versa) sticks across reloads regardless of its role.
 *  Assistant messages now default to expanded (see both `ConversationThreadBox.vue` and
 *  `ConversationView.vue`'s own `expandedByMessage` watchers, which pass `true` here for
 *  `role === 'assistant'`) — the compact-by-default behaviour this function used to hard-code
 *  unconditionally now only applies to messages whose caller doesn't ask for a different default
 *  (in practice, user messages). */
export function loadMessageExpanded(messageId: string, defaultExpanded = false): boolean {
  const stored = readStored();
  return messageId in stored ? stored[messageId] === true : defaultExpanded;
}

/** Best-effort, read-merge-write persistence for one or more messages at once — a quota/private-
 *  browsing error here must not break expand/collapse. */
export function persistMessageExpanded(entries: ExpandedRecord): void {
  try {
    const merged = { ...readStored(), ...entries };
    localStorage.setItem(MESSAGE_EXPANDED_KEY, JSON.stringify(merged));
  } catch {
    // Best-effort persistence only.
  }
}
