<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConversationsStore, type ConversationMessageState } from '../../stores/conversations.js';
import { useEditsStore } from '../../stores/edits.js';
import { ApiError } from '../../transport/http-client.js';
import { useFocusTrap } from '../../a11y/focus-manager.js';
import { clamp, useResizeHandle } from '../../composables/useResizeHandle.js';
import { loadPaneSizes, persistPaneSizes } from '../../composables/panePersistence.js';
import MessageBubble from './MessageBubble.vue';
import EditsList from '../edits/EditsList.vue';

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const store = useConversationsStore();
const editsStore = useEditsStore();

const draft = ref('');
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

// Fix: a visible, low-noise "sent — awaiting response" indicator for the gap between the turn
// being queued (`conversation.status === 'working'`, server-driven via the
// `conversation_status_changed` WS event) and the first assistant token actually streaming in —
// today that gap is silent (the composer's own `sending` only covers the HTTP round trip to queue
// the turn, not the LLM's response time). Derived entirely from state already in the store: once
// the newest message is an assistant message that has started streaming *text*, or the turn has
// left `working`, this clears on its own — no new store state needed. Declared up here (rather
// than near the other action handlers further down) so it's available to the scroll-stickiness
// watchers below, which need to react to it alongside `messages`.
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
  'Here is the passage this conversation was branched from',
  'This conversation was branched from "',
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

// Fix: while a message streams in, the transcript auto-scrolls to the bottom on every token — see
// the `messages` watcher below. That's the desired behaviour while the user is following along at
// the bottom, but if they've deliberately scrolled up (e.g. to re-read earlier history), the very
// next token delta yanks them straight back down. `stickToBottom` tracks whether the user is
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
  },
);
watch(
  () => conversation.value?.status,
  (status, previousStatus) => {
    if (status === 'errored' && previousStatus !== 'errored') errorDismissed.value = false;
  },
);

/** Shared by both the `messages` and `awaitingResponse` watchers below: scrolls `.message-list` to
 *  its bottom, but only while the user hasn't deliberately scrolled away (`stickToBottom`). Waits a
 *  tick first so it runs after the DOM reflects whatever just changed (a new/updated message, or
 *  the awaiting-response indicator appearing/disappearing as the last child of the list). */
async function scrollToBottomIfSticky(): Promise<void> {
  if (!stickToBottom.value) return;
  await nextTick();
  listRef.value?.scrollTo({ top: listRef.value.scrollHeight });
}

watch(messages, scrollToBottomIfSticky, { deep: true });
// Fix: the awaiting-response indicator (rendered in `.message-list`, right after the last message
// — see the template) is derived state, not itself a mutation of `messages`. It normally appears
// in the same tick as a new user message is pushed (so the `messages` watch above already covers
// it), but it can also flip on its own — e.g. `conversation.status` turning `working` slightly
// before or after that message lands via the WS event vs. the HTTP response — so this watches
// `awaitingResponse` too, reusing the same sticky-scroll logic, rather than relying on that timing
// coincidence.
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
</script>

<template>
  <section class="conversation-view" aria-label="Conversation">
    <!-- UI convention: title | status | action, in one header row (see
         .specify/memory/constitution.md "UI Conventions") — the same 3-section pattern as
         HudPanel.vue's conversation-list rows. The right-hand action slot shows whichever single
         action currently applies: "Request review" once closed, or "Close" while still open
         (subject to the same kind-based gating as before, `kind !== 'main'`). -->
    <header class="conversation-header">
      <div class="header-titles">
        <span class="pane-eyebrow">Conversation</span>
        <h2 class="text-wrap-safe">{{ conversation?.name ?? 'Conversation' }}</h2>
      </div>
      <span v-if="conversation" class="badge status-badge" :data-status="conversation.status">{{
        conversation.status
      }}</span>
      <div class="header-actions">
        <button
          v-if="conversation?.status === 'closed'"
          type="button"
          class="review-button"
          :disabled="reviewing"
          @click="onRequestReview"
        >
          Request review
        </button>
        <button
          v-else-if="conversation && conversation.kind !== 'main'"
          type="button"
          class="close-button"
          :disabled="closing"
          @click="openCloseDialog"
        >
          Close
        </button>
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

    <div v-if="foldedSummary" class="folded-summary-banner" role="status">
      <strong>Folded summary received:</strong>
      <pre class="text-wrap-safe-pre">{{ foldedSummary.summary }}</pre>
    </div>

    <div ref="transcriptEditsEl" class="transcript-edits" :style="transcriptEditsStyle">
      <div ref="listRef" class="message-list" role="log" aria-live="polite" aria-relevant="additions">
        <MessageBubble
          v-for="(msg, index) in messages"
          :key="msg.id ?? index"
          :message="msg"
          :seed="isSeedMessage(msg, index)"
        />
        <!-- Fix: visible "sent — awaiting response" indicator for the gap between the turn being
             queued and the first assistant token actually streaming in (previously silent — only
             the header's status badge and the Send button's own "Sending…" label reflected
             `working`, neither of which is very noticeable). Rendered here, after the last message,
             so it reads as "here's what's happening in response to what I just sent" rather than
             detached down in the composer/footer area. Clears itself once streaming text arrives or
             the turn leaves `working` — see `awaitingResponse`. -->
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
          Tip: highlight text in the document and click "Start conversation from selection" to get
          a reviewable edit proposal instead of a direct answer.
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

    <div v-if="closeDialogOpen" class="modal-overlay close-dialog-overlay">
      <div ref="closeDialogEl" class="close-dialog" role="alertdialog" aria-modal="true" aria-label="Close conversation">
        <p>Close "{{ conversation?.name }}"? This cannot be undone.</p>
        <p v-if="conversation && conversation.pendingEditCount > 0" class="pending-warning" role="alert">
          This conversation has {{ pendingProposalPhrase(conversation.pendingEditCount) }}; resolve
          {{ conversation.pendingEditCount === 1 ? 'it' : 'them' }} before closing.
        </p>
        <label class="fold-summary-option">
          <input v-model="foldSummaryIntoParent" type="checkbox" />
          Fold a compact summary into the parent conversation
        </label>
        <div class="close-dialog-actions">
          <button type="button" :disabled="closing" @click="confirmClose">Close conversation</button>
          <button type="button" :disabled="closing" @click="cancelCloseDialog">Cancel</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.conversation-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.conversation-header {
  /* Fix: a true 3-column grid (title | status | action) rather than flex + `margin-right: auto` —
     that flex approach only pushes the action+status group to the right as a cluster, it can't
     center the action slot independently of how wide the title or status content is. The two
     flanking tracks are equal-width `1fr` (each with a `minmax(0, …)` floor so a long conversation
     name or status text can shrink/truncate instead of overflowing at narrow sidebar widths), so
     the middle `auto` column stays genuinely centered regardless of column 1/3 content — including
     when it's empty (`conversation.kind === 'main'`, which renders neither button). */
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid var(--border-color, #ddd);
  /* Fix 2: a surface distinct from the HUD above it and the transcript below it. */
  background: var(--panel-bg-alt, #eef0f3);
}
.header-titles {
  display: flex;
  flex-direction: column;
  justify-self: start;
  min-width: 0;
}
/* UI convention: the header's right-hand "action" slot (title | status | action) — see
   .specify/memory/constitution.md "UI Conventions". Only one of Request review / Close ever
   renders here at a time, so this is just a layout container, not a group. */
.header-actions {
  display: flex;
  gap: 0.5rem;
  justify-self: end;
}
.conversation-header > .status-badge {
  justify-self: center;
  min-width: 0;
  white-space: nowrap;
}
/* .pane-eyebrow's shared text styling now lives in style.css. */
/* `.text-wrap-safe`'s shared overflow-wrap handling (applied to the h2 in the template) now lives
   in style.css — closes a gap where a long conversation name had no wrap protection even though
   `.header-titles` above already sets `min-width: 0`. */
.conversation-header h2 {
  margin: 0;
  font-size: 1rem;
}
.status-badge[data-status='idle'] {
  color: var(--neutral-muted-color, #4b5563);
}
.status-badge[data-status='working'] {
  color: var(--status-active-color, #1d4ed8);
}
.status-badge[data-status='errored'] {
  color: var(--danger-color, #b91c1c);
}
.status-badge[data-status='closed'] {
  color: var(--status-closed-color, #374151);
}
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
  /* Fix: reserve the scrollbar's width whether or not it's actually showing — otherwise switching
     from a long conversation (scrollbar present) to a short one (no scrollbar) visibly shifts
     every bubble sideways by the scrollbar's width. */
  scrollbar-gutter: stable;
  padding: 0.75rem;
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
/* Fix: low-noise "sent — awaiting response" indicator (see `awaitingResponse`) — now rendered as
   the last child of `.message-list`, right after the last message bubble, rather than down in
   `.input-area`. Sized/spaced like a message bubble (same horizontal padding and bottom margin as
   `.message-bubble` in MessageBubble.vue) so it sits naturally in the transcript flow, but kept
   visually distinct from an actual chat bubble — no bubble background/border-radius, just the
   spinner + status-colored text — so it still reads as a transient status line rather than a
   message from either party. Reuses the same status color as the header's `working` badge
   (`--status-active-color`) for visual consistency. */
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
.dismiss-notice-button {
  flex: 0 0 auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
}
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
/* Contrast fix: relying on the browser's native (color-scheme-driven) button-face background for
   text-color contrast math is fragile — dark mode's native button face isn't reliably dark enough
   for light/bright accent text (measured well below 4.5:1). Both composer buttons get an explicit
   background from the token system instead, in every state, so contrast never depends on the
   browser's own button rendering. */
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
/* `.text-wrap-safe-pre`'s shared overflow-x/white-space/overflow-wrap handling now lives in
   style.css (previously missing `overflow-wrap` here, a real sub-bug). */
.folded-summary-banner pre {
  margin: 0.35rem 0 0;
  font-family: inherit;
}
.close-dialog-overlay {
  z-index: 60;
}
.close-dialog {
  background: var(--bg-color, #fff);
  color: var(--text-color, #111);
  border-radius: 8px;
  padding: 1rem;
  max-width: 22rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
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
</style>
