<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConversationsStore, type ConversationMessageState } from '../../stores/conversations.js';
import { useEditsStore } from '../../stores/edits.js';
import { ApiError } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import { clamp, useResizeHandle } from '../../composables/useResizeHandle.js';
import { loadPaneSizes, persistPaneSizes } from '../../composables/panePersistence.js';
import { scrollMessageTopIntoView } from '../../composables/messageScroll.js';
import { useConversationContinuity } from '../../composables/conversationContinuity.js';
import { useConversationRename } from '../../composables/conversationRename.js';
import {
  useConversationBranchAction,
  useBulkToggleAction,
  type ActionDescriptor,
} from '../../composables/conversationActions.js';
import { useConversationStatusBadges } from '../../composables/conversationStatusBadges.js';
import { usePrimaryAction } from '../../composables/primaryAction.js';
import ConversationStatusBadges from './ConversationStatusBadges.vue';
import ConversationActionButtons from './ConversationActionButtons.vue';
import MessageBubble from './MessageBubble.vue';
import EditsList from '../edits/EditsList.vue';

// `atFocusCap`/`maxFocused`: App.vue's own live cap state, threaded down through
// `ConversationDetailPanel.vue` — same precomputed-boolean + max-number shape as
// `ConversationThreadBox.vue`'s own `focusDisabled`/`maxFocused` props, since this view (unlike
// `ConversationThreadBox.vue`, which sits directly under `DocumentCanvas.vue`) has no direct
// access to the raw `focusedConversationIds` set itself. Defaults keep a bare
// `mount(ConversationView, { props: { conversationId } })` (existing tests) behaving as "never at
// cap".
const props = withDefaults(
  defineProps<{ conversationId: string; atFocusCap?: boolean; maxFocused?: number }>(),
  { atFocusCap: false, maxFocused: 3 },
);
const emit = defineEmits<{
  (e: 'select', id: string): void;
  // Fired (via `useConversationBranchAction`'s `onBranchCreated` callback) once a new branch is
  // successfully created, carrying its id up to App.vue (via `ConversationDetailPanel.vue`), which
  // decides whether to auto-focus it (only if there's a free slot under the live focus cap).
  // Deliberately a distinct event from `select` above: `select` drives `replaceFocus` (swap *this*
  // panel's own content for the new conversation, e.g. FR-036's "Request review" navigation),
  // whereas branching should *add* a second panel alongside this one still open, never replace it.
  (e: 'branch-created', id: string): void;
}>();
const store = useConversationsStore();
const editsStore = useEditsStore();

// Mirrored into `store.drafts` on every change (rather than kept purely local) so
// `store.discardIfEmpty` can still see unsent draft text at the moment this conversation's focus
// panel closes and this component is about to unmount — the draft always wins over that cleanup.
// Initialized from any draft the store already has for this conversation (e.g. left over from a
// previous time this same conversation's panel was open and closed without being discarded), so
// unsent text survives a close/reopen instead of silently vanishing.
const draft = ref(store.drafts[props.conversationId] ?? '');
watch(draft, (value) => store.setDraft(props.conversationId, value));
watch(
  () => props.conversationId,
  (id) => {
    draft.value = store.drafts[id] ?? '';
  },
);
const sending = ref(false);
const closing = ref(false);
const closeError = ref<string | null>(null);
const listRef = ref<HTMLDivElement | null>(null);

// FR-034: the close dialog offers folding a compact summary into the parent, separately from
// closing itself. `foldSummaryIntoParent` defaults to unchecked (http-api.md: request default is
// `false`).
const closeDialogOpen = ref(false);
const foldSummaryIntoParent = ref(false);
const closeDialogEl = ref<HTMLElement | null>(null);

// FR-043d: opening the close-confirmation dialog moves focus to its first control; Escape (or
// Cancel) returns focus to the "Close" button that opened it.
useFocusTrap(closeDialogEl, closeDialogOpen, { onEscape: () => cancelCloseDialog() });

const reviewing = ref(false);
const reviewError = ref<string | null>(null);

// FR-007a: a small, unobtrusive, dismiss-once hint pointing at the proposal-based editing path —
// stored globally (not per-conversation) so dismissing it once keeps it out of the way everywhere.
const DIRECT_EDIT_HINT_KEY = 'raidr:directEditHintDismissed';
const directEditHintDismissed = ref(localStorage.getItem(DIRECT_EDIT_HINT_KEY) === '1');
function dismissDirectEditHint(): void {
  directEditHintDismissed.value = true;
  localStorage.setItem(DIRECT_EDIT_HINT_KEY, '1');
}

const messages = computed(() => store.messagesFor(props.conversationId));
const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);
const { isPrimary } = useConversationStatusBadges(() => props.conversationId);

// Rename affordance: click-to-edit title (an inline `<input>` replacing the plain-text title, save
// on Enter/blur, cancel on Escape — see `ConversationThreadBox.vue`'s own doc comment for the "one
// action per slot"/no-confirmation-dialog rationale). Shared with that component via
// `useConversationRename` (same store action, `store.rename`, so renaming from either view updates
// both — they share the same Pinia store).
const nameInputEl = ref<HTMLInputElement | null>(null);
const { isEditingName, nameDraft, renameError, renameSaving, startEditingName, cancelEditingName, saveName } =
  useConversationRename(() => props.conversationId, nameInputEl);

// Shares the exact same computed logic as `ConversationThreadBox.vue`'s continuity-context
// rendering, via the composable, rather than duplicating it — see `useConversationContinuity`'s
// doc comment for the full rationale.
const { parentConversation, continuityMessages } = useConversationContinuity(() => props.conversationId);

// This view owns its own per-message expand state, the same way `ConversationThreadBox.vue` does
// (data-model.md's `MessageDisplayState` is keyed by `messageId` alone, so both call sites share
// one persisted default via `messageDisplayState.ts` without colliding, even with several focused
// panels for different conversations open at once). Same role-aware default as
// `ConversationThreadBox.vue`'s own seeding (see `ensureMessageExpandedSeeded`'s doc comment in
// `stores/conversations.ts` for the full reasoning): an assistant reply starts fully shown, a user
// message stays collapsed-by-default, and any message the user has explicitly toggled by hand (of
// either role) keeps exactly that choice regardless of this default.
//
// Backed by `conversationsStore.expandedByMessage` (keyed by conversationId then messageId), not a
// local `ref<Record<string, boolean>>` — `ConversationThreadBox.vue`'s canvas box and this
// focused/detail view can both be mounted at once for the same conversation, so a local ref per
// component would let the two silently show different expanded/collapsed state for the same
// message. Both components read/write the exact same reactive source; `localStorage` stays purely
// the persistence layer underneath it.
const expandedByMessage = computed(() => store.expandedByMessage[props.conversationId] ?? {});
watch(messages, () => store.ensureMessageExpandedSeeded(props.conversationId), { immediate: true });
// Expanding a single message scrolls so its own top edge becomes visible — see
// `ConversationThreadBox.vue`'s identical `setMessageExpanded` doc comment for why only the
// collapsed -> expanded direction triggers this, and why the bulk toggle below deliberately
// doesn't. No sticky header sits inside `.message-list` here (unlike the sidebar box's
// `.thread-header`), so `scrollMessageTopIntoView` is called with no offset element.
function setMessageExpanded(messageId: string, expanded: boolean): void {
  const wasExpanded = expandedByMessage.value[messageId];
  store.setMessageExpanded(props.conversationId, messageId, expanded);
  if (expanded && !wasExpanded) {
    scrollMessageTopIntoView(listRef.value, messageId);
  }
}

// Bulk "Expand all"/"Collapse all" toggle (FR-009) over the same per-message `expandedByMessage`
// state this view already owns above. Shared with `ConversationThreadBox.vue` via
// `useBulkToggleAction`.
const { action: bulkToggleAction, visible: bulkToggleVisible } = useBulkToggleAction(() => props.conversationId);

// "Branch" action (branching *this* conversation with no selection, US2/FR-006/FR-007 — see
// `conversationActions.ts`'s own doc comment for why a whole-conversation branch is the only kind
// this data model supports). Shared with `ConversationThreadBox.vue` via
// `useConversationBranchAction`. Same store call, same server-computed `canBranch` gating (mirrors
// `maxConversationDepth`, already covers "closed conversations can't be branched from" per the
// read-only banner above).
//
// Branching from the focus view emits `branch-created` (via the composable's `onBranchCreated`
// callback) on success so App.vue can auto-focus the new branch — creation itself is blocked at
// the cap, so a free slot is always guaranteed by the time this fires, and App.vue's own no-op
// guard is only ever defense in depth against a same-tick race.
const { action: branchAction, error: branchError } = useConversationBranchAction(() => props.conversationId, {
  atFocusCap: () => props.atFocusCap,
  maxFocused: () => props.maxFocused,
  onBranchCreated: (id) => emit('branch-created', id),
});

// 006-toolbar-reorg (second refactor): the HUD's per-row Make/Clear Primary button is gone (the
// HUD list is purely informational now) — this focus/detail view is one of its two new homes
// (alongside `ConversationThreadBox.vue`'s sidebar box), via the shared `usePrimaryAction`
// composable (`composables/primaryAction.ts`) so the busy-switch confirmation dialog's state/
// resolution logic isn't duplicated between the two hosts. `primaryDialogEl` is this view's own
// template ref for that dialog's root, same "host owns the template ref" convention `nameInputEl`
// above already establishes.
const primaryDialogEl = ref<HTMLElement | null>(null);
const {
  action: primaryAction,
  busyPrompt: primaryBusyPrompt,
  busyConversationName: primaryBusyConversationName,
  resolveBusyPrompt: resolvePrimaryBusyPrompt,
  error: primaryError,
} = usePrimaryAction(() => props.conversationId, primaryDialogEl);

// A visible, low-noise "sent — awaiting response" indicator for the gap between the turn being
// queued (`conversation.status === 'working'`, server-driven via the `conversation_status_changed`
// WS event) and the first assistant token actually streaming in — the composer's own `sending`
// only covers the HTTP round trip to queue the turn, not the LLM's response time. Derived entirely
// from state already in the store: once the newest message is an assistant message that has
// started streaming *text*, or the turn has left `working`, this clears on its own — no new store
// state needed. Declared up here (rather than near the other action handlers further down) so it's
// available to the scroll-stickiness watchers below, which need to react to it alongside
// `messages`.
const awaitingResponse = computed(() => {
  if (conversation.value?.status !== 'working') return false;
  const last = messages.value[messages.value.length - 1];
  if (!last || last.role !== 'assistant') return true;
  return last.streaming && !last.text;
});

// ---------------------------------------------------------------------------------------------
// New: a vertical, draggable/keyboard-operable split between the message transcript and the
// proposed-edits list below it, reusing the same `useResizeHandle`/`panePersistence` composables
// as App.vue's splits (see App.vue for the shared drag/keyboard/localStorage logic). This split
// has to fill whatever height ConversationView is actually given by its parent (App.vue's
// sidebar) rather than assume a fixed viewport height — `.transcript-edits` is a flex child of
// `.conversation-view` (flex: 1; min-height: 0) so it always sizes to that available space, and
// the `fr` math below is computed against its own `getBoundingClientRect()`, not the viewport's.
// ---------------------------------------------------------------------------------------------
const DEFAULT_TRANSCRIPT_FR = 3;
const DEFAULT_EDITS_FR = 2;
const MIN_TRANSCRIPT_PX = 120;
const MIN_EDITS_PX = 100;
const EDITS_HANDLE_SPACE_PX = 6;

const initialSplit = loadPaneSizes({ transcriptFr: DEFAULT_TRANSCRIPT_FR, editsFr: DEFAULT_EDITS_FR });
const transcriptFr = ref(initialSplit.transcriptFr);
const editsFr = ref(initialSplit.editsFr);
const transcriptEditsEl = ref<HTMLDivElement | null>(null);

/** Hides (and makes unreachable) the drag handle when there is nothing to resize — a conversation
 *  with zero proposed edits ever (see EditsList.vue's own "No proposed edits yet." empty state) —
 *  rather than let it split the transcript against dead space. */
const hasEdits = computed(() => editsStore.editsFor(props.conversationId).length > 0);

/** Whether the "Proposed edits" section (EditsList.vue) is worth showing at all. Closing only
 *  requires zero *pending* proposals (conversation-service.ts's `close()` throws while any are
 *  pending); it does not clear already-applied/dropped/superseded ones, and GET
 *  /conversations/:id/edits (edit-service.ts's `listForConversation`) returns the full history
 *  regardless of status. So a closed conversation can still have a non-empty edits list — this
 *  hides the section only once it's actually empty, rather than unconditionally on
 *  `status === 'closed'`. For an open conversation the section always shows (as before), including
 *  its "No proposed edits yet." empty state — that placeholder still matters there since more
 *  edits may yet arrive. */
const showEditsSection = computed(() => conversation.value?.status !== 'closed' || hasEdits.value);

const transcriptEditsStyle = computed(() => {
  if (!hasEdits.value) return undefined;
  return { gridTemplateRows: `${transcriptFr.value}fr ${EDITS_HANDLE_SPACE_PX}px ${editsFr.value}fr` };
});

/** This `role="separator"` handle needs `aria-valuenow`/`aria-valuemin`/`aria-valuemax` (WCAG
 *  "Required ARIA attribute not present"). Expressed as a 0-100 percentage of the transcript/edits
 *  split (same live fraction `transcriptEditsStyle` above already renders), so an assistive-tech
 *  user gets the same "how is this split right now" information sighted users read off the
 *  handle's own position. */
const editsSplitPercent = computed(() => Math.round((transcriptFr.value / (transcriptFr.value + editsFr.value)) * 100));

const editsResize = useResizeHandle({
  axis: 'vertical',
  containerEl: transcriptEditsEl,
  beginGesture: (containerRect) => {
    const startTranscriptFr = transcriptFr.value;
    const totalFr = startTranscriptFr + editsFr.value;
    const remainingPx = containerRect.height - EDITS_HANDLE_SPACE_PX;
    const startTranscriptPx = remainingPx * (startTranscriptFr / totalFr);
    return (deltaPx) => {
      const nextTranscriptPx = clamp(
        startTranscriptPx + deltaPx,
        MIN_TRANSCRIPT_PX,
        Math.max(MIN_TRANSCRIPT_PX, remainingPx - MIN_EDITS_PX),
      );
      transcriptFr.value = (nextTranscriptPx / remainingPx) * totalFr;
      editsFr.value = totalFr - transcriptFr.value;
    };
  },
  onSettle: () => persistPaneSizes({ transcriptFr: transcriptFr.value, editsFr: editsFr.value }),
});

// FR-007c: the auto-generated branch-seed message (ConversationService's `branch()`) is sent
// through the ordinary user-message path — its role is genuinely 'user' (relied on by
// `.message-bubble[data-role="user"]` elsewhere, e.g. tests/e2e/us3.spec.ts) — so this is a
// display-only heuristic that recognizes it by its fixed template and position rather than a
// dedicated flag, and renders it as a distinct context card instead of a normal "You" bubble.
const BRANCH_SEED_PREFIXES = [
  'Here is the full document under review (revision', // buildBranchSeedMessage (seed-excerpt.ts)
];
function isSeedMessage(message: ConversationMessageState, index: number): boolean {
  return (
    index === 0 &&
    message.role === 'user' &&
    conversation.value?.kind === 'branch' &&
    BRANCH_SEED_PREFIXES.some((prefix) => message.text.startsWith(prefix))
  );
}

/** FR-007h: "1 pending proposal" vs "N pending proposals" — used both for the upfront
 *  close-dialog notice and the post-failure error banner. */
function pendingProposalPhrase(count: number): string {
  return `${count} pending proposal${count === 1 ? '' : 's'}`;
}
/** FR-034: set once a fold summary has actually been delivered into this conversation (as the
 *  parent of a conversation that closed with "Fold summary" enabled) — see conversations.ts's
 *  `conversation_summary_folded` handler. */
const foldedSummary = computed(() => store.foldedSummaries[props.conversationId] ?? null);

// Dismissing the error banner is purely a local UI affordance — `conversation.status` (and its
// HUD badge) stay `errored` until a retry actually succeeds; this only lets the user clear the
// message out of the way in the meantime. Reset whenever a *new* error arrives, or the user
// switches conversations, so a previous dismissal doesn't hide a later, different failure.
const errorDismissed = ref(false);
function dismissError(): void {
  errorDismissed.value = true;
}

function load(): void {
  errorDismissed.value = false;
  void store.loadDetail(props.conversationId);
}

// While a message streams in, the transcript auto-scrolls to the bottom on every token — see the
// `messages` watcher below. That's the desired behaviour while the user is following along at the
// bottom, but if they've deliberately scrolled up (e.g. to re-read earlier history), the very next
// token delta must not yank them straight back down. `stickToBottom` tracks whether the user is
// currently at (or near) the bottom of `.message-list`; the auto-scroll only fires while it's
// true. It's kept in sync by a plain `scroll` listener (near-bottom => true, else => false) rather
// than by distinguishing user- vs. programmatic scrolls: a programmatic scroll-to-bottom always
// lands "near bottom" itself, so it re-affirms `true`, and the user scrolling back down by hand is
// indistinguishable from — and handled the same as — that.
const NEAR_BOTTOM_THRESHOLD_PX = 32;
const stickToBottom = ref(true);
function onListScroll(): void {
  const el = listRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
}

// Tracks whether the *next* `lastMessageId` change (below) is this conversation's very first
// population of messages since it was opened/switched to (lands at the bottom, showing the tail
// of existing history — "most recent first") versus a genuinely new message arriving while
// already viewing an already-loaded conversation (scrolls to that new message's own top instead —
// see `lastMessageId`'s watcher below). Reset alongside `stickToBottom` whenever the conversation
// being viewed changes.
const isInitialMessagesLoad = ref(true);

onMounted(load);
onMounted(() => {
  listRef.value?.addEventListener('scroll', onListScroll);
});
onBeforeUnmount(() => {
  listRef.value?.removeEventListener('scroll', onListScroll);
});
watch(() => props.conversationId, load);
watch(
  () => props.conversationId,
  () => {
    // A freshly-loaded conversation always starts auto-following the bottom, rather than
    // inheriting a stale `false` left over from wherever the user had scrolled to in whatever
    // conversation was previously open.
    stickToBottom.value = true;
    isInitialMessagesLoad.value = true;
  },
);
watch(
  () => conversation.value?.status,
  (status, previousStatus) => {
    if (status === 'errored' && previousStatus !== 'errored') errorDismissed.value = false;
  },
);

/** Used by the `awaitingResponse` watcher below (and once, on this conversation's very first
 *  message load — see the `lastMessageId` watcher just below): scrolls `.message-list` to its
 *  bottom, but only while the user hasn't deliberately scrolled away (`stickToBottom`). Waits a
 *  tick first so it runs after the DOM reflects whatever just changed. */
async function scrollToBottomIfSticky(): Promise<void> {
  if (!stickToBottom.value) return;
  await nextTick();
  listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
}

/** Identity of the newest message only — deliberately NOT a `deep` watch over all of `messages`.
 *  A streaming token delta (conversations.ts's `text_delta` handler) mutates the existing last
 *  message's `.text` in place without changing its `id`, so this doesn't re-fire on every token; it
 *  fires exactly once per genuinely new message (a fresh send, or a new assistant message starting
 *  via `message_started`). */
const lastMessageId = computed(() => messages.value[messages.value.length - 1]?.id ?? null);

// Scrolling the whole transcript to its bottom on every new message (as `scrollToBottomIfSticky`
// does) would, for a long assistant reply, show only whatever the tail currently looks like as it
// streams in, never the beginning of the reply. This lands at the bottom the first time a
// conversation's messages are loaded (`isInitialMessagesLoad`, reset per-conversation above) — so
// opening/switching to a conversation shows its most recent history first — but once it's already
// open, a newly-appended message instead scrolls just far enough for THAT message's own top edge
// to become visible, leaving the user free to keep reading down at their own pace as it streams in
// rather than being repeatedly yanked to match wherever the tail currently is.
watch(
  lastMessageId,
  async (id) => {
    if (!id || !stickToBottom.value) return;
    await nextTick();
    if (isInitialMessagesLoad.value) {
      isInitialMessagesLoad.value = false;
      listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
      return;
    }
    scrollMessageTopIntoView(listRef.value, id);
  },
  { immediate: true },
);
// The awaiting-response indicator (rendered in `.message-list`, right after the last message — see
// the template) is derived state, not itself a mutation of `messages`. It normally appears in the
// same tick as a new user message is pushed (so the `lastMessageId` watch above already covers
// revealing that message), but the indicator itself can still be scrolled out of view below it
// (this conversation deliberately doesn't force-scroll all the way to the bottom on every new
// message — see above), and it can also flip on its own — e.g. `conversation.status` turning
// `working` slightly before or after that message lands via the WS event vs. the HTTP response — so
// this reveals it explicitly, via the plain scroll-to-bottom behaviour (appropriate here: the
// indicator has no "top" of its own worth preserving, it's just a short status line to surface).
watch(awaitingResponse, scrollToBottomIfSticky);

async function onSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || conversation.value?.status === 'closed') return;
  draft.value = '';
  sending.value = true;
  try {
    await store.send(props.conversationId, text);
  } finally {
    sending.value = false;
  }
}

/** FR-018: refresh this conversation's context to the current document revision, then send. */
async function onRefreshSend(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value || conversation.value?.status === 'closed') return;
  draft.value = '';
  sending.value = true;
  try {
    await store.refreshAndSend(props.conversationId, text);
  } finally {
    sending.value = false;
  }
}

/** FR-043a: plain Enter sends as before; Ctrl/Cmd+Enter is the keyboard-operable equivalent of
 *  the "Refresh + Send" button below. Shift/Alt+Enter fall through to the textarea's default
 *  newline behaviour, unchanged. */
function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    void onRefreshSend();
    return;
  }
  if (!event.shiftKey && !event.altKey) {
    event.preventDefault();
    void onSend();
  }
}

async function onRetry(): Promise<void> {
  await store.retry(props.conversationId);
}

/** Opens the close confirmation dialog, which separately offers folding a compact summary into
 *  the parent conversation (FR-034) — closing and folding are two distinct decisions. */
function openCloseDialog(): void {
  closeError.value = null;
  foldSummaryIntoParent.value = false;
  closeDialogOpen.value = true;
}

function cancelCloseDialog(): void {
  closeDialogOpen.value = false;
}

/** FR-033: refused while any proposal is pending — surfaced inline rather than thrown away, so
 * the user sees exactly why (naming the count, per PENDING_EDITS_BLOCK_CLOSE's `details`). */
async function confirmClose(): Promise<void> {
  closeError.value = null;
  closing.value = true;
  try {
    await store.close(props.conversationId, foldSummaryIntoParent.value);
    closeDialogOpen.value = false;
  } catch (err) {
    // Dismiss the dialog on failure too (FR-033): the error (e.g. pending proposals blocking
    // close) is surfaced in the main view's banner, not inside the now-irrelevant confirmation
    // dialog, and leaving the dialog's overlay open would block the very controls (Accept/Drop)
    // the user needs to resolve it.
    closeDialogOpen.value = false;
    if (err instanceof ApiError && err.code === 'PENDING_EDITS_BLOCK_CLOSE') {
      // FR-007h: build our own properly-pluralized message from `details.pendingEditIds` rather
      // than surfacing the backend's raw "N proposal(s)" string verbatim.
      const ids = err.details?.pendingEditIds;
      closeError.value = Array.isArray(ids)
        ? `Cannot close: ${pendingProposalPhrase(ids.length)} must be resolved first.`
        : err.message;
    } else {
      closeError.value = err instanceof Error ? err.message : 'Failed to close conversation.';
    }
  } finally {
    closing.value = false;
  }
}

/** FR-036: request an independent review of this closed conversation and its branches, then
 *  navigate to the newly created `kind: 'review'` conversation. */
async function onRequestReview(): Promise<void> {
  reviewError.value = null;
  reviewing.value = true;
  try {
    const result = await store.review(props.conversationId);
    emit('select', result.conversation.id);
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : 'Failed to request review.';
  } finally {
    reviewing.value = false;
  }
}

// Archive-or-Request-review stays local (not shared with `ConversationThreadBox.vue`, which has no
// equivalent action of its own) — mutually exclusive by `conversation.status`: "Request review"
// once closed, "Archive" while still open, for every `kind` including `main`
// (specs/006-archivable-main-conversation, US1).
const archiveOrReviewAction = computed<ActionDescriptor | null>(() => {
  if (!conversation.value) return null;
  if (conversation.value.status === 'closed') {
    return { key: 'request-review', label: 'Request review', disabled: reviewing.value, onClick: () => void onRequestReview() };
  }
  // specs/006-archivable-main-conversation (US1): archiving Main is now a supported operation
  // (it atomically archives the current Main and replaces it with a fresh one) — Main gets the
  // same "Archive" action any other open conversation already has, no `kind` gating.
  return { key: 'archive', label: 'Archive', disabled: closing.value, danger: true, onClick: openCloseDialog };
});

const actions = computed<ActionDescriptor[]>(() => {
  const list: ActionDescriptor[] = [];
  if (bulkToggleVisible.value) list.push(bulkToggleAction.value);
  if (conversation.value) list.push(branchAction.value);
  if (conversation.value) list.push(primaryAction.value);
  const archiveOrReview = archiveOrReviewAction.value;
  if (archiveOrReview) list.push(archiveOrReview);
  return list;
});
</script>

<template>
  <section
    class="conversation-view"
    :class="{ 'is-primary': isPrimary, 'primary-indicator': isPrimary }"
    aria-label="Conversation"
  >
    <!-- UI convention: title | status | action (see .specify/memory/constitution.md
         "UI Conventions") — the same 3-section pattern HudPanel.vue's own conversation-list rows
         use for title/status (that list is purely informational, with no action section of its
         own any more), laid out as two explicit rows rather than one (see `.conversation-header`'s
         doc comment for why). Row 1 holds title (left) and status (right); row 2 holds every
         per-conversation action this view offers: the bulk expand/collapse toggle, Branch, and
         Make/Clear Primary (parity with `ConversationThreadBox.vue`'s sidebar box, always shown
         when applicable) alongside whichever single close-state action currently applies —
         "Request review" once closed, or "Archive" while still open, for every kind including
         `main` (specs/006-archivable-main-conversation, US1). -->
    <header class="conversation-header">
      <div class="header-top">
        <div class="header-titles">
          <span class="pane-eyebrow">Conversation</span>
          <div class="title-edit-row">
            <input
              v-if="isEditingName"
              ref="nameInputEl"
              v-model="nameDraft"
              type="text"
              class="thread-title-input"
              aria-label="Conversation name"
              :disabled="renameSaving"
              @keydown.enter.prevent="saveName"
              @keydown.escape.prevent="cancelEditingName"
              @blur="saveName"
            />
            <template v-else>
              <h2 class="text-wrap-safe">{{ conversation?.name ?? 'Conversation' }}</h2>
              <button
                v-if="conversation"
                type="button"
                class="thread-rename-button"
                aria-label="Rename conversation"
                title="Rename conversation"
                @click="startEditingName"
              >
                ✎
              </button>
            </template>
          </div>
          <span v-if="renameError" class="rename-error" role="alert">{{ renameError }}</span>
        </div>
        <ConversationStatusBadges :conversation-id="conversationId" />
      </div>
      <div class="header-actions">
        <ConversationActionButtons :actions="actions" />
      </div>
    </header>

    <!-- FR-035: closed conversations remain fully viewable but are read-only — no reopen, no
         branch, no Primary, no send/refresh-send (the composer is hidden below rather than shown
         disabled, since none of that is available at all once closed). The header's own
         `status-badge` already says "closed" right above this, so the banner text is trimmed to
         not repeat that — it earns its keep only for the specifics a status label can't carry
         (exactly which actions are unavailable and why). -->
    <div v-if="conversation?.status === 'closed'" class="readonly-banner" role="status">
      Read-only: history and proposals remain visible, but this conversation cannot be reopened,
      branched from, or made Primary.
    </div>

    <div v-if="closeError" class="error-banner" role="alert">{{ closeError }}</div>
    <div v-if="reviewError" class="error-banner" role="alert">{{ reviewError }}</div>
    <div v-if="branchError" class="error-banner" role="alert">{{ branchError }}</div>
    <div v-if="primaryError" class="error-banner" role="alert">{{ primaryError }}</div>

    <div v-if="foldedSummary" class="folded-summary-banner" role="status">
      <strong>Folded summary received:</strong>
      <pre class="text-wrap-safe-pre">{{ foldedSummary.summary }}</pre>
    </div>

    <div ref="transcriptEditsEl" class="transcript-edits" :style="transcriptEditsStyle">
      <div ref="listRef" class="message-list" role="log" aria-live="polite" aria-relevant="additions">
        <!-- 005-canvas-conversation-threads: read-only continuity context for a freshly-created,
             zero-message branch — borrowed from the parent, never part of this conversation's own
             transcript below (same treatment as `ConversationThreadBox.vue`'s sidebar box, kept in
             a visually distinct wrapper, labeled, so it can never be mistaken for this
             conversation's own messages). -->
        <div v-if="continuityMessages.length > 0" class="continuity-context">
          <span class="continuity-label">Continued from {{ parentConversation?.name ?? 'parent conversation' }}</span>
          <MessageBubble v-for="message in continuityMessages" :key="message.id" :message="message" :expanded="true" />
        </div>
        <MessageBubble
          v-for="(msg, index) in messages"
          :key="msg.id ?? index"
          :message="msg"
          :seed="isSeedMessage(msg, index)"
          :expanded="expandedByMessage[msg.id] ?? false"
          @update:expanded="(value) => setMessageExpanded(msg.id, value)"
        />
        <!-- Visible "sent — awaiting response" indicator for the gap between the turn being queued
             and the first assistant token actually streaming in. Rendered here, after the last
             message, so it reads as "here's what's happening in response to what I just sent"
             rather than detached down in the composer/footer area. Clears itself once streaming
             text arrives or the turn leaves `working` — see `awaitingResponse`. -->
        <div v-if="awaitingResponse" class="awaiting-response" role="status">
          <span class="awaiting-response-spinner" aria-hidden="true"></span>
          Request sent — waiting for response…
        </div>
      </div>
      <div
        v-if="hasEdits"
        class="resize-handle resize-handle--vertical"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize transcript and proposed edits"
        :aria-valuenow="editsSplitPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        tabindex="0"
        @pointerdown="editsResize.startDrag($event)"
        @keydown="editsResize.onKeydown($event)"
      ></div>
      <EditsList v-if="showEditsSection" :conversation-id="conversationId" />
    </div>

    <div v-if="conversation?.status === 'errored' && !errorDismissed" class="error-banner" role="alert">
      <span class="error-banner-message text-wrap-safe">{{ conversation.errorMessage ?? 'The agent hit an error.' }}</span>
      <span class="error-banner-actions">
        <button type="button" @click="onRetry">Retry</button>
        <button type="button" aria-label="Dismiss error" @click="dismissError">Dismiss</button>
      </span>
    </div>

    <!-- Composer footer: only rendered while the conversation is open — "Request review" now
         lives in the header's middle action slot once the conversation is closed (see
         `.conversation-header` / `.header-actions` above), so this footer has nothing left to
         show at that point and collapses entirely. -->
    <div v-if="conversation?.status !== 'closed'" class="input-area">
      <div v-if="!directEditHintDismissed" class="composer-hint">
        <span>
          Tip: highlight text in the document and click "Branch (Main)" (Alt+Shift+S) to get a
          reviewable edit proposal instead of a direct answer.
        </span>
        <button type="button" class="dismiss-notice-button" aria-label="Dismiss tip" @click="dismissDirectEditHint">
          Got it
        </button>
      </div>

      <form class="composer" @submit.prevent="onSend">
        <label class="visually-hidden" :for="`composer-${conversationId}`">Message {{ conversation?.name }}</label>
        <textarea
          :id="`composer-${conversationId}`"
          v-model="draft"
          placeholder="Ask about the document…"
          @keydown="onComposerKeydown"
        ></textarea>
        <button
          type="submit"
          class="send-button"
          title="Send this message as a direct question or instruction to the conversation."
          :disabled="!draft.trim() || sending || conversation?.status === 'working'"
        >
          {{ conversation?.status === 'working' ? 'Sending…' : 'Send' }}
        </button>
        <button
          type="button"
          class="refresh-send-button"
          :class="{ emphasized: conversation?.isStale }"
          title="Refresh this conversation's context to the latest document revision, then send — use this when the document has changed since this conversation last saw it (Ctrl+Enter)."
          :disabled="!draft.trim() || sending || conversation?.status === 'working'"
          @click="onRefreshSend"
        >
          Refresh + Send
        </button>
      </form>
    </div>

    <Transition name="modal">
      <div v-if="closeDialogOpen" class="modal-overlay close-dialog-overlay">
        <div ref="closeDialogEl" class="close-dialog dialog-box" role="alertdialog" aria-modal="true" aria-label="Close conversation">
          <p>Close "{{ conversation?.name }}"? This cannot be undone.</p>
          <p v-if="conversation && conversation.pendingEditCount > 0" class="pending-warning" role="alert">
            This conversation has {{ pendingProposalPhrase(conversation.pendingEditCount) }}; resolve
            {{ conversation.pendingEditCount === 1 ? 'it' : 'them' }} before closing.
          </p>
          <label class="fold-summary-option">
            <input v-model="foldSummaryIntoParent" type="checkbox" />
            Fold a compact summary into the parent conversation
          </label>
          <!-- "Close conversation" is irreversible (see the "This cannot be undone" text above).
               Cancel must come first in DOM order, since this dialog's `useFocusTrap` auto-focuses
               whichever focusable element is first — an irreversible action must never be the
               auto-focused default. "Close conversation" carries explicit danger styling,
               consistent with how the "Archive" action that opens this dialog is already styled
               (`danger: true` in `archiveOrReviewAction` above). -->
          <div class="close-dialog-actions">
            <button type="button" :disabled="closing" @click="cancelCloseDialog">Cancel</button>
            <button type="button" class="danger" :disabled="closing" @click="confirmClose">Close conversation</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- FR-029/FR-043d: the Make/Clear Primary busy-switch three-choice warning — see
         `usePrimaryAction` (composables/primaryAction.ts) for the shared state/resolution logic
         this and `ConversationThreadBox.vue`'s own copy both drive. -->
    <Transition name="modal">
      <div v-if="primaryBusyPrompt" class="modal-overlay primary-busy-dialog-overlay">
        <div
          ref="primaryDialogEl"
          class="primary-busy-dialog dialog-box"
          role="alertdialog"
          aria-modal="true"
          aria-label="Primary conversation is busy"
        >
          <p>
            {{ primaryBusyConversationName }} is still working. What should happen to the Primary designation?
          </p>
          <div class="primary-busy-choices">
            <button type="button" @click="resolvePrimaryBusyPrompt('switch_now')">Switch now</button>
            <button type="button" @click="resolvePrimaryBusyPrompt('switch_when_idle')">Switch when idle</button>
            <button type="button" @click="resolvePrimaryBusyPrompt('cancel')">Cancel</button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.conversation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* The actual box-shadow value lives once in style.css's shared `.primary-indicator` class (applied
   alongside `.is-primary` in the template), reused for visual consistency across all three
   surfaces that display a conversation (HudPanel, this view, `ConversationThreadBox.vue`). Never
   color alone: the closed-conversation `.readonly-banner` above already spells out "no Primary" in
   words, and `PrimaryPanel.vue`'s Make/Clear-Primary controls name this conversation by its title,
   not by this styling alone. */
/* An explicit two-row column, rather than a single-row 3-column grid with `.header-actions`
   wrapping onto a second line when it overflows — a row-wrap fallback lets the action row's wrap
   point drift with however wide the title/status happens to be, and can still crowd
   `.status-badge` at narrow widths before wrapping kicks in. Splitting into two explicit rows
   (same convention as `ConversationThreadBox.vue`'s `.thread-header`: `.thread-header-top` holds
   title+status, `.thread-actions` sits in its own row below) makes each row's own width the full
   header instead, and reads as two clearly separate concerns — "what/how is this conversation" on
   top, "what can I do to it" below — rather than one crowded row. */
.conversation-header {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* A surface distinct from the HUD above it and the transcript below it. */
  background: var(--panel-bg-alt, #eef0f3);
}
/* Row 1: title (grows) | status badge (shrinks to fit), same `justify-content: space-between`
   idiom as `ConversationThreadBox.vue`'s `.thread-header-top`. */
.header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.header-titles {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.header-top > .status-badge {
  flex-shrink: 0;
  min-width: 0;
  white-space: nowrap;
}
/* Rename affordance: same "one action per slot" layout as `ConversationThreadBox.vue`'s own
   `.thread-title-group` — title (or its in-place edit input) plus a small icon-only rename button
   share this row, with `.rename-error` (if any) on its own line beneath. */
.title-edit-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
/* `.thread-rename-button`/`.rename-error` shared shape now lives in style.css (identical between
   this view and `ConversationThreadBox.vue`). `.thread-title-input`'s shared shape (flex/border/
   padding) also lives there — this override layers just the three properties that differ from
   `ConversationThreadBox.vue`'s own copy: sized/weighted to match the `h2` title it replaces while
   editing (see `.conversation-header h2` below), background matched to this header's own
   `--panel-bg-alt` surface. */
.thread-title-input {
  font-weight: 700;
  font-size: 1rem;
  color: var(--text-color, #111);
  background: var(--panel-bg-alt, #eef0f3);
}
/* Row 2: the header's action row (title | status | action, per .specify/memory/constitution.md
   "UI Conventions", now on its own row below row 1). Up to four buttons can render here at once
   (bulk expand/collapse, Branch, Make/Clear Primary, and one of Request review/Archive — see the
   template comment above `.header-actions`), so this is a genuine (wrapping) group, not a single
   control.
   `flex-wrap: wrap` (same idiom `ConversationThreadBox.vue`'s own `.thread-actions` already uses
   for the identical set of buttons) lets extra buttons drop to a further line rather than overflow
   at narrow widths. Left-aligned (no `justify-content` override, so the flex default
   `flex-start` applies) — matching `.thread-actions`'s own left alignment, since this row no
   longer shares a grid column with anything it needs to stay clear of. */
.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  max-width: 100%;
}
/* Per-button visual styling (bulk-toggle/branch/archive/review) lives in
   `ConversationActionButtons.vue`, shared with `ConversationThreadBox.vue` — the "Archive" action's
   danger/red treatment comes from that action's `danger: true` descriptor flag instead of a class
   name (see `archiveOrReviewAction` above). */
/* .pane-eyebrow's shared text styling now lives in style.css. */
/* `.text-wrap-safe`'s shared overflow-wrap handling (applied to the h2 in the template) now lives
   in style.css — closes a gap where a long conversation name had no wrap protection even though
   `.header-titles` above already sets `min-width: 0`. */
.conversation-header h2 {
  margin: 0;
  font-size: 1rem;
}
/* Status badge colors now live in `ConversationStatusBadges.vue` (shared verbatim with
   `HudPanel.vue`/`ConversationThreadBox.vue` — see that component's own doc comment). */
/* New: `.transcript-edits` is a flex child of `.conversation-view` (flex: 1; min-height: 0) so it
   always fills whatever height this component is actually given, never a fixed viewport amount.
   It's a grid with a default `1fr auto` row template — transcript takes all remaining space,
   EditsList sizes to its own (small) empty-state content — for when there's nothing to resize
   (no proposed edits yet, see `hasEdits`); `transcriptEditsStyle` overrides that with an explicit
   `fr` split, once there's a proposed-edits list worth splitting against. When EditsList is
   omitted entirely (`showEditsSection` false — a closed conversation with an empty edits list),
   the now-empty `auto` row collapses to zero and the message-list's `1fr` row fills the freed
   space on its own, with no extra CSS needed. */
.transcript-edits {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: 1fr auto;
}
.message-list {
  min-height: 0;
  overflow-y: auto;
  /* Reserve the scrollbar's width whether or not it's actually showing — otherwise switching from
     a long conversation (scrollbar present) to a short one (no scrollbar) visibly shifts every
     bubble sideways by the scrollbar's width. */
  scrollbar-gutter: stable;
  padding: 0.75rem;
}
/* Read-only continuity context (branch placeholder with zero of its own messages): shared shape/
   `.continuity-label` now live in style.css (identical to `ConversationThreadBox.vue`'s own copy) —
   this overrides just the one property that differed between the two (`margin-bottom`: this view
   uses a touch more breathing room than the sidebar box's compact card). */
.continuity-context {
  margin-bottom: 0.5rem;
}
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger-color, #991b1b);
}
/* `.text-wrap-safe`'s shared overflow-wrap handling now lives in style.css. `min-width: 0` stays
   here: an unbroken long error string (e.g. a raw provider error payload) sits in the
   `.error-banner` flex row, which otherwise refuses to let this span shrink below its content's
   intrinsic width, forcing the whole banner — and with it the page — wider than the viewport. */
.error-banner-message {
  min-width: 0;
  max-height: 8rem;
  overflow-y: auto;
}
.error-banner-actions {
  display: flex;
  gap: 0.5rem;
  flex: 0 0 auto;
}
/* The composer footer — only rendered while the conversation is open (see the template comment
   above `.input-area`); collapses entirely once closed, since Request review now lives in the
   header instead. */
.input-area {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
}
/* Low-noise "sent — awaiting response" indicator (see `awaitingResponse`) — rendered as the last
   child of `.message-list`, right after the last message bubble. Sized/spaced like a message
   bubble (same horizontal padding and bottom margin as `.message-bubble` in MessageBubble.vue) so
   it sits naturally in the transcript flow, but kept visually distinct from an actual chat bubble
   — no bubble background/border-radius, just the spinner + status-colored text — so it still
   reads as a transient status line rather than a message from either party. Reuses the same status
   color as the header's `working` badge (`--status-active-color`) for visual consistency. */
.awaiting-response {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
  color: var(--status-active-color, #1d4ed8);
  font-size: 0.75rem;
}
.awaiting-response-spinner {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: awaiting-response-spin 0.8s linear infinite;
}
@keyframes awaiting-response-spin {
  to {
    transform: rotate(360deg);
  }
}
.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border-color, #ddd);
}
.composer textarea {
  flex: 1;
  resize: vertical;
  min-height: 2.5rem;
}
.composer-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--info-bg, #eff6ff);
  color: var(--info-color, #1e3a8a);
  border-top: 1px solid var(--info-border, #bfdbfe);
  font-size: 0.75rem;
}
/* `.dismiss-notice-button` shared shape now lives in style.css (shared with PrimaryPanel.vue's
   Primary-notice dismiss button). */
/* New: draggable, keyboard-operable resize handle between the transcript and proposed-edits list
   — same look/behaviour as App.vue's `.resize-handle--vertical` (a separate, identically-named
   rule here since each `<style scoped>` block is its own component). */
.resize-handle {
  position: relative;
  touch-action: none;
  background: transparent;
}
.resize-handle--vertical {
  cursor: row-resize;
}
.resize-handle--vertical::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--border-color, #ccc);
}
.resize-handle--vertical:hover::after,
.resize-handle--vertical:focus-visible::after {
  background: var(--accent-color, #2563eb);
  height: 4px;
}
.resize-handle:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: -2px;
}
/* Relying on the browser's native (color-scheme-driven) button-face background for text-color
   contrast math is fragile — dark mode's native button face isn't reliably dark enough for
   light/bright accent text. Both composer buttons get an explicit background from the token system
   instead, in every state, so contrast never depends on the browser's own button rendering. */
.send-button,
.refresh-send-button {
  background: var(--panel-bg-alt, #eef0f3);
  color: var(--text-color, #111);
  border: 1px solid var(--border-color, #ccc);
}
.send-button:disabled,
.refresh-send-button:disabled {
  /* Distinct from the enabled state's background (not just dimmer text) plus `not-allowed` —
     otherwise a disabled button still looks fully clickable at a glance. */
  background: var(--bg-color, #fff);
  color: var(--neutral-muted-color, #4b5563);
  border-color: var(--border-color, #ccc);
  border-style: dashed;
  cursor: not-allowed;
}
.refresh-send-button.emphasized {
  font-weight: 700;
  border-color: var(--warning-color, #92400e);
  color: var(--warning-color, #92400e);
}
.pending-warning {
  padding: 0.4rem 0.6rem;
  background: var(--warning-bg, #fef3c7);
  color: var(--warning-color, #92400e);
  border-radius: 4px;
  font-size: 0.85rem;
}
.readonly-banner {
  padding: 0.5rem 0.75rem;
  background: var(--seed-bg, #f3f4f6);
  color: var(--status-closed-color, #374151);
  font-size: 0.85rem;
}
.folded-summary-banner {
  padding: 0.5rem 0.75rem;
  background: var(--success-bg, #ecfdf5);
  color: var(--success-color, #065f46);
  font-size: 0.8rem;
}
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling lives in
   style.css. */
.folded-summary-banner pre {
  margin: 0.35rem 0 0;
  font-family: inherit;
}
.close-dialog-overlay {
  z-index: var(--z-overlay-primary, 60);
}
/* Background/color/border-radius/box-shadow now live in style.css's shared `.dialog-box` class
   (applied via the template class above); only this dialog's own width/padding stay here. */
.close-dialog {
  padding: 1rem;
  max-width: 22rem;
}
.fold-summary-option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  margin: 0.75rem 0;
}
.close-dialog-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
/* "Close conversation" is the one irreversible action in this dialog — same danger treatment
   `ConversationActionButtons.vue`'s `.action-button.danger` already gives the "Archive" action
   that opens this dialog, reused here since this button isn't rendered through that shared
   component. */
.close-dialog-actions button.danger {
  color: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
}
.close-dialog-actions button.danger:hover:not(:disabled) {
  background: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
  color: #fff;
}
/* Make/Clear Primary's busy-switch confirmation dialog (see `usePrimaryAction`) — same shape as
   `ConversationThreadBox.vue`'s own copy of this dialog (and the removed `HudPanel.vue` original
   it's descended from): `--z-overlay-primary`, `.dialog-box` shared chrome, only width/padding/
   spacing stay local to each host. */
.primary-busy-dialog-overlay {
  z-index: var(--z-overlay-primary, 60);
}
.primary-busy-dialog {
  padding: 1rem;
  max-width: 22rem;
}
.primary-busy-choices {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
</style>
