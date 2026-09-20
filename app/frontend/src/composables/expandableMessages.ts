import { loadMessageExpanded, persistMessageExpanded } from './messageDisplayState.js';

/**
 * Minimal shape either `ConversationMessageState` (`stores/conversations.ts`) or its thread-mode
 * counterpart (`stores/thread.ts`) already satisfies — only `id`/`role` are ever needed to seed or
 * toggle expand/collapse state, so this composable never needs to import either store's own
 * (otherwise unrelated) message type.
 */
export interface ExpandableMessage {
  id: string;
  role: string;
}

/** The shared `expandedByMessage` shape both `ConversationsState` and `ThreadsState` declare:
 *  keyed by "entity id" (a conversationId or threadId) then messageId. */
export type ExpandedByEntity = Record<string, Record<string, boolean>>;

/**
 * Shared per-entity (conversationId or threadId) expand/collapse state management — the exact same
 * algorithm `stores/conversations.ts` and `stores/thread.ts` each independently need for their own
 * `expandedByMessage` state, extracted here once both stores' own doc comments called out they were
 * "mirroring" one another line for line. `localStorage` persistence itself stays purely in
 * `messageDisplayState.ts`; the functions below are just the shared in-memory `expandedByMessage`
 * read/write rules layered on top of it.
 */

/**
 * Seeds `expandedByEntity[entityId]` for every message not already present there, from
 * `localStorage` (an assistant reply defaults to expanded, a user message defaults to collapsed).
 * Idempotent — only ever fills in *missing* keys — so calling this from more than one mounted
 * component/watcher for the same entity is harmless.
 */
export function seedExpandedForEntity(
  expandedByEntity: ExpandedByEntity,
  entityId: string,
  messages: readonly ExpandableMessage[],
): void {
  const forEntity = (expandedByEntity[entityId] ??= {});
  for (const message of messages) {
    if (!(message.id in forEntity)) {
      forEntity[message.id] = loadMessageExpanded(message.id, message.role === 'assistant');
    }
  }
}

/** Single-message expand/collapse write. */
export function setExpandedForEntity(
  expandedByEntity: ExpandedByEntity,
  entityId: string,
  messageId: string,
  expanded: boolean,
): void {
  const forEntity = (expandedByEntity[entityId] ??= {});
  forEntity[messageId] = expanded;
  persistMessageExpanded({ [messageId]: expanded });
}

/** Bulk expand/collapse write ("Expand all"/"Collapse all") — one `localStorage` read-merge-write
 *  for every affected message, not one per message. */
export function setManyExpandedForEntity(
  expandedByEntity: ExpandedByEntity,
  entityId: string,
  entries: Record<string, boolean>,
): void {
  const forEntity = (expandedByEntity[entityId] ??= {});
  Object.assign(forEntity, entries);
  persistMessageExpanded(entries);
}

/** Whether any of `messages` is currently collapsed under `expandedForEntity` (that entity's own
 *  slice of `expandedByEntity` — an absent entry reads as collapsed, same as everywhere else this
 *  state is read). */
export function anyCollapsed(
  messages: readonly ExpandableMessage[],
  expandedForEntity: Record<string, boolean>,
): boolean {
  return messages.some((m) => !expandedForEntity[m.id]);
}

/** Builds the `{ messageId: nextExpanded }` bulk-write entries for "Expand all"/"Collapse all" over
 *  `messages`, given the caller's own already-decided `nextExpanded` value — kept separate from
 *  `anyCollapsed` above (rather than folded into one function) so a caller that needs `nextExpanded`
 *  computed over a *different* scope than `messages` itself (`stores/thread.ts`'s document-wide
 *  toggle: one `nextExpanded` decided across every Thread, then applied per-Thread) can still reuse
 *  this. */
export function buildExpandedEntries(
  messages: readonly ExpandableMessage[],
  nextExpanded: boolean,
): Record<string, boolean> {
  const entries: Record<string, boolean> = {};
  for (const message of messages) {
    entries[message.id] = nextExpanded;
  }
  return entries;
}
