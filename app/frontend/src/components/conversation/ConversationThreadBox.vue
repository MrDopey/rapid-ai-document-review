<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { ApiError } from '../../transport/http-client.js';
import { loadMessageExpanded, persistMessageExpanded } from '../../composables/messageDisplayState.js';
import { scrollMessageTopIntoView } from '../../composables/messageScroll.js';
import { useConversationContinuity } from '../../composables/conversationContinuity.js';
import {
  useConversationBranchAction,
  useBulkToggleAction,
  type ActionDescriptor,
} from '../../composables/conversationActions.js';
import ConversationStatusBadges from './ConversationStatusBadges.vue';
import ConversationActionButtons from './ConversationActionButtons.vue';
import MessageBubble from './MessageBubble.vue';

// US4/T031 fix: the app's pre-canvas sidebar showed exactly one conversation's full detail view
// at a time — a per-box `.modal-overlay` (this component's original approach) can't support
// switching between conversations (once open, it covers the *entire* viewport including the
// toolbar/HUD, so clicking a different HUD row to switch never reaches it). So the actual detail
// view is rendered in `App.vue` (via `ConversationDetailPanel.vue`, one instance per currently
// focused conversation) — this box only ever *requests* a change to focus state; it doesn't
// render or own any detail panel itself.
// 005-canvas-conversation-threads (multi-focus overlay): renamed from `isOpen`/`request-open`+
// `request-close` to `isFocused`/`toggle-focus` — App.vue's `selectedConversationId` (a single
// scalar) became `focusedConversationIds: Set<string>` (several conversations may have an open
// detail panel simultaneously, up to a configurable cap), and both this box's "Focus" button and
// its "Close" button (only rendered while `isFocused`) now just request the *same* toggle rather
// than two directionally-different actions — App.vue's own toggle already no-ops correctly in
// either direction (removing when present, adding when absent and under cap). `focusDisabled`/
// `maxFocused` (both computed by App.vue/DocumentCanvas.vue from the live cap and current focused
// count) drive the Focus button's own disabled-looking affordance when focusing this conversation
// would exceed that cap; they're irrelevant whenever `isFocused` is already true (toggling off is
// always allowed, never capped).
// `atFocusCap` (005-canvas-conversation-threads, branch-cap parity): the same live "no free slot"
// condition `focusDisabled` above already reflects for the Focus button, but *not* conditioned on
// `isFocused` — branching always creates a brand-new conversation (never already focused), so the
// Branch button's own disabled check is just the plain cap comparison, computed once by
// DocumentCanvas.vue and threaded down here as its own boolean prop (same "precomputed boolean +
// maxFocused number" shape as `focusDisabled`/`maxFocused` already establish).
const props = withDefaults(
  defineProps<{
    conversationId: string;
    isFocused?: boolean;
    focusDisabled?: boolean;
    maxFocused?: number;
    atFocusCap?: boolean;
  }>(),
  { isFocused: false, focusDisabled: false, maxFocused: 3, atFocusCap: false },
);
const emit = defineEmits<{
  (e: 'toggle-focus', conversationId: string): void;
  // Parity fix (auto-focus on branch): mirrors `ConversationView.vue`'s own `branch-created` emit —
  // fired (via `useConversationBranchAction`'s `onBranchCreated` callback) once a new branch is
  // successfully created, carrying its id up to App.vue (via DocumentCanvas.vue), which auto-focuses
  // it. Branch creation itself is blocked at the cap (see that composable's own doc comment), so by
  // the time this fires a free slot is always available.
  (e: 'branch-created', id: string): void;
}>();
const store = useConversationsStore();

const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);
const messages = computed(() => store.messagesFor(props.conversationId));

// Rename affordance: click-to-edit title, following the same "one action per slot" convention as
// the Branch action below — an inline text input replaces the plain-text `.thread-title`
// span rather than opening a modal/dialog, since this is a single-field, low-stakes edit. Save on
// Enter/blur, cancel on Escape (constitution's "UI Conventions": no confirmation dialog for a
// reversible, single-field text edit).
const isEditingName = ref(false);
const nameDraft = ref('');
const renameError = ref<string | null>(null);
const renameSaving = ref(false);
const nameInputEl = ref<HTMLInputElement | null>(null);

async function startEditingName(): Promise<void> {
  if (!conversation.value) return;
  nameDraft.value = conversation.value.name;
  renameError.value = null;
  isEditingName.value = true;
  await nextTick();
  nameInputEl.value?.focus();
  nameInputEl.value?.select();
}

function cancelEditingName(): void {
  isEditingName.value = false;
  renameError.value = null;
}

async function saveName(): Promise<void> {
  if (!isEditingName.value || !conversation.value) return;
  const trimmed = nameDraft.value.trim();
  if (!trimmed) {
    // FR: empty-name validation — rejected inline, editing stays open so the user can fix it
    // (matching `branchError`'s inline-message convention below) rather than silently reverting.
    renameError.value = 'Name cannot be empty';
    return;
  }
  if (trimmed === conversation.value.name) {
    // No-op edit (e.g. blur with nothing changed): close without a network round trip.
    isEditingName.value = false;
    renameError.value = null;
    return;
  }
  renameSaving.value = true;
  try {
    await store.rename(conversation.value.id, trimmed);
    isEditingName.value = false;
    renameError.value = null;
  } catch (err) {
    renameError.value =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to rename conversation.';
  } finally {
    renameSaving.value = false;
  }
}

// Branch-lineage cue (sidebar list view): a plain-text breadcrumb naming this conversation's
// parent, if any. Note on scope: this data model has no message-level fork-point field at all —
// `ConversationDto.parentId` links two *conversations*, and the only anchor a branch can carry
// (`seedSelection`) is a document character-range excerpt, never a specific transcript message id
// (see conversation-service.ts's `branch()` and conversationLayout.ts's doc comments). So "branched
// from" here names the parent conversation as a whole; it can't point at a specific message within
// it because no such reference is stored anywhere in the domain model.
// 005-canvas-conversation-threads: branch creation no longer sends any seed message, so a
// freshly-created branch starts with zero messages of its own (see conversation-service.ts's
// `branch()` — `forkedFromMessageId` is populated with the parent's last message id at the moment
// of branching, `null` for a selection-anchored branch with no message-level fork point). Rather
// than leave that box a blank dead end, borrow exactly two messages from the *parent's* own
// (already independently loaded — see `onMounted` below) message list for read-only display: the
// last user message and the last assistant message, up to and including `forkedFromMessageId`.
// These are never written into this conversation's own `messagesByConversation` entry — they stay
// sourced live from the parent, so they can never be mistaken for (or counted as) this
// conversation's own messages.
// Bug fix follow-up: this logic (and `parentConversation` above it) is now shared with
// `ConversationView.vue`'s focus/detail view via `useConversationContinuity` — see that
// composable's doc comment — so both call sites stay in lockstep rather than risk drifting apart.
const { parentConversation, continuityMessages } = useConversationContinuity(() => props.conversationId);

// US3/FR-008/FR-009: this box — not `MessageBubble.vue` itself — owns every one of its messages'
// `expanded` state, since the bulk toggle below needs to read/set all of them at once
// (data-model.md's `MessageDisplayState` is "purely a batch write over the same per-message
// field", not a separate stored bulk mode). Seeded from `localStorage` per message the first time
// each message is seen (streaming deltas update `message.text` in place without changing `id`, so
// this only runs once per real message).
// Bug fix (assistant messages expanded by default): `loadMessageExpanded`'s second argument is the
// default to fall back to only when nothing has ever been explicitly stored for this exact message
// id — an assistant reply now starts fully shown rather than clamped/requiring a click, without
// disturbing any message (of either role) the user has already toggled by hand. User messages keep
// the pre-existing collapsed-by-default behaviour: they're the ones the user themselves just typed
// (so their own content is never a surprise), tend to be short, and the user only asked about
// "assistant returned messages" here — changing their default too would be an unrequested, and
// arguably regressive, behaviour change for a case this task doesn't cover.
const expandedByMessage = ref<Record<string, boolean>>({});
watch(
  messages,
  (list) => {
    for (const message of list) {
      if (!(message.id in expandedByMessage.value)) {
        expandedByMessage.value[message.id] = loadMessageExpanded(message.id, message.role === 'assistant');
      }
    }
  },
  { immediate: true },
);

// Root DOM node of the sticky header — passed to `scrollMessageTopIntoView` below so it can offset
// for the header's own live rendered height (see that composable's doc comment for why a fixed CSS
// value wouldn't be reliable here: this header's height varies with a rename error, branch-lineage
// line, or wrapped action buttons).
const threadHeaderEl = ref<HTMLElement | null>(null);

// Bug fix (scroll-to-top-of-message): expanding a single message (as opposed to the bulk "Expand
// all" toggle below, which deliberately leaves scroll position alone — there's no one message to
// anchor to) scrolls so its own top edge becomes visible, not just wherever it happens to land once
// its content grows. Only fires on a collapsed -> expanded transition (never on collapse, and never
// redundantly on an already-expanded message), since that's the only direction that can reveal new
// content the user hasn't seen yet.
function setMessageExpanded(messageId: string, expanded: boolean): void {
  const wasExpanded = expandedByMessage.value[messageId];
  expandedByMessage.value[messageId] = expanded;
  persistMessageExpanded({ [messageId]: expanded });
  if (expanded && !wasExpanded) {
    scrollMessageTopIntoView(rootEl.value, messageId, threadHeaderEl.value);
  }
}

// FR-009: a single bulk write over every message's `expanded` field — if any message is currently
// collapsed, one click expands all of them; once every message is already expanded, the same
// control collapses all of them instead. Individual messages stay independently toggleable
// afterward (setMessageExpanded above is unchanged by this bulk path).
// Now shared with `ConversationView.vue` via `useBulkToggleAction` — see that composable's own doc
// comment for why it still needs this box's own `expandedByMessage` ref passed in rather than
// owning an independent copy of that state.
const { action: bulkToggleAction, visible: bulkToggleVisible } = useBulkToggleAction(
  () => props.conversationId,
  expandedByMessage,
);

// Root element exposed so `DocumentCanvas.vue` can attach a `ResizeObserver` to it (Phase 4/US2's
// sibling-collision stacking needs each box's *actual* rendered height, not a fixed assumption).
const rootEl = ref<HTMLElement | null>(null);

// 005-canvas-conversation-threads (US2, gap #1 found during implementation review): there is no
// message-level anchor in this data model (`CreateConversationRequest` only carries an optional
// *document* `selection`, never a message id — see spec.md's Assumptions section: "This restructure
// does not change branching's underlying semantics... it changes how branches are laid out
// spatially"). "Branch off a specific message" (spec.md US2) is implemented as branching *this*
// conversation with no selection — the new child renders one column further out, inheriting this
// conversation's own resolved position (`resolveBaseAnchorY` in `conversationLayout.ts`). This is a
// dedicated affordance, alongside every other header action (constitution: one action per slot).
// Branch-cap parity fix: this used to always allow branch creation, with no auto-focus at all —
// now shared with `ConversationView.vue`'s focus-view "Branch" button via `useConversationBranchAction`
// (see that composable's own doc comment): blocked outright while `atFocusCap`, and auto-focuses the
// new branch via the `branch-created` emit on every success.
const { action: branchAction, error: branchError } = useConversationBranchAction(() => props.conversationId, {
  atFocusCap: () => props.atFocusCap,
  maxFocused: () => props.maxFocused,
  onBranchCreated: (id) => emit('branch-created', id),
});

// 005-canvas-conversation-threads: `ConversationView.vue` is no longer permanently mounted for
// every conversation (it used to live in App.vue's sidebar, always fetching its own detail on
// mount) — this compact box is now the only thing that renders for a conversation by default, so
// it has to trigger the message fetch itself. Guarded so remounting this box (e.g. during layout
// reflow in a later phase) doesn't refetch messages that are already loaded.
onMounted(() => {
  if (!store.messagesByConversation[props.conversationId]) {
    void store.loadDetail(props.conversationId);
  }
});

// UI convention (constitution "UI Conventions"): title | primary action | status. This box's own
// header consolidates every per-conversation action this box offers (Focus, Close, bulk expand/
// collapse, Branch — see the template below) rather than scattering them across separate toolbar/
// footer regions as before; every other mutating action (Request review, sending a message,
// viewing proposed edits) still lives exclusively inside `ConversationView.vue`'s own header/
// composer, unchanged.
// 005-canvas-conversation-threads (multi-focus overlay): both buttons below now emit the same
// `toggle-focus` — see the prop doc comment above for why a single toggle replaces the old
// directional `request-open`/`request-close` pair.
const focusButtonTitle = computed(() => {
  if (props.isFocused) return "Close this conversation's full view";
  if (props.focusDisabled) return `Un-focus another conversation first (max ${props.maxFocused})`;
  return "Focus this conversation's full view";
});
function toggleFocus(): void {
  emit('toggle-focus', props.conversationId);
}

// Focus/Close descriptors stay defined locally (not shared with `ConversationView.vue`) — they're
// specific to this surface, combined here with the two shared descriptors above into the one list
// `ConversationActionButtons.vue` renders. `focusAction.disabled` is deliberately left unset (not
// `focusDisabled`): the pre-existing Focus button was never a native `disabled` control either — see
// `focusButtonTitle`'s own doc comment history — a click always still toggles regardless of whether
// it "looks" capped, `ariaDisabled` alone carries that affordance so the button stays keyboard-
// reachable and its title stays discoverable.
const focusAction = computed<ActionDescriptor>(() => ({
  key: 'focus',
  label: 'Focus',
  title: focusButtonTitle.value,
  ariaLabel: focusButtonTitle.value,
  pressed: props.isFocused,
  ariaDisabled: props.focusDisabled,
  onClick: toggleFocus,
}));
const closeAction = computed<ActionDescriptor>(() => ({
  key: 'close',
  label: 'Close',
  ariaLabel: "Close this conversation's full view",
  danger: true,
  onClick: toggleFocus,
}));

const actions = computed<ActionDescriptor[]>(() => {
  const list: ActionDescriptor[] = [focusAction.value];
  if (props.isFocused) list.push(closeAction.value);
  if (bulkToggleVisible.value) list.push(bulkToggleAction.value);
  list.push(branchAction.value);
  return list;
});

defineExpose({ el: rootEl });
</script>

<template>
  <article v-if="conversation" ref="rootEl" class="conversation-thread-box" :data-conversation-id="conversationId">
    <span class="pane-eyebrow">Conversation</span>
    <header ref="threadHeaderEl" class="thread-header">
      <div class="thread-header-top">
        <div class="thread-title-group">
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
            <span class="thread-title text-wrap-safe">{{ conversation.name }}</span>
            <button
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
        <span class="thread-status">
          <ConversationStatusBadges :conversation-id="conversationId" />
        </span>
      </div>
      <span v-if="renameError" class="rename-error" role="alert">{{ renameError }}</span>
      <!-- Branch-lineage cue (sidebar list view): plain text, not a button/badge, naming the parent
           conversation this one was branched from. See `parentConversation`'s doc comment above for
           why this can only name the parent conversation, not a specific message within it. -->
      <span v-if="parentConversation" class="branch-lineage text-wrap-safe">
        ↳ Branched from {{ parentConversation.name }}
      </span>
      <!-- Header action row: every per-conversation action this box offers now lives together here
           (previously "Open" alone lived in the header, "Expand/Collapse all" sat in its own
           toolbar row, and "Branch" sat in a footer row below the messages). -->
      <div class="thread-actions">
        <ConversationActionButtons :actions="actions" />
        <span v-if="branchError" class="branch-error" role="alert">{{ branchError }}</span>
      </div>
    </header>
    <!-- 005-canvas-conversation-threads: read-only continuity context for a freshly-created,
         zero-message branch — borrowed from the parent, never part of this conversation's own
         `.thread-messages` list below (kept in a visually distinct wrapper, labeled, so it can
         never be mistaken for this conversation's own transcript). -->
    <div v-if="continuityMessages.length > 0" class="continuity-context">
      <span class="continuity-label">Continued from {{ parentConversation?.name ?? 'parent conversation' }}</span>
      <MessageBubble v-for="message in continuityMessages" :key="message.id" :message="message" :expanded="true" />
    </div>
    <div class="thread-messages">
      <MessageBubble
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :expanded="expandedByMessage[message.id] ?? false"
        @update:expanded="(value) => setMessageExpanded(message.id, value)"
      />
    </div>
  </article>
</template>

<style scoped>
.conversation-thread-box {
  position: absolute;
  width: 320px;
  max-width: min(320px, 90vw);
  background: var(--panel-bg, #f7f7f8);
  /* Was `var(--border-color, #ccc)` — that token is explicitly documented in style.css as a
     "decorative divider only" (~1.5-1.7:1 against --panel-bg/--bg-color, below WCAG 1.4.11's 3:1
     non-text minimum) and its own comment warns not to use it as a UI-boundary cue. This box's
     outer edge is exactly that boundary — it's how adjacent stacked/columned boxes read as
     separate, so a low-contrast divider made them blend together, especially in dark mode.
     `--neutral-muted-color` is the same fix already applied to `.thread-action-button` below for
     an identical reason: it's validated to clear 3:1+ against every flat panel surface (this box
     sits on flat `--panel-bg`/`--panel-bg-alt`, not a tinted one, so the plain — not `-on-tint` —
     variant is correct here) in both color schemes. */
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 6px;
  padding: 0.4rem 0.6rem 0.6rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
/* Header consolidation: title+status stays a single top row; lineage + actions stack beneath it.
   Previously `.thread-header` was a single 3-column grid holding only title | Open | status — the
   "Open" button now lives in `.thread-actions` below, alongside every other per-conversation action
   this box offers (see the template). */
.thread-header {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  /* Correction (bleed-through fix): a non-zero `top` was tried first (`top: 0.4rem`) to preserve
     breathing room once stuck, but a sticky element's `top` positions its *margin* edge, not its
     painted box — any offset there (from `top` itself, or from a leftover `margin-top` on this
     element) is a gap that sits OUTSIDE this header's own opaque background, so `.thread-messages`
     content scrolling underneath is visible through it as it scrolls past. Confirmed empirically
     with a Playwright probe (`elementFromPoint` at the scroll container's exact top edge resolved to
     a `.msg` element, not the header, with the old `top: 0.4rem` + `margin-top: 0.15rem`
     combination) — and confirmed fixed the same way once `top`/`margin-top` were both zeroed.
     `margin: 0` below removes that second, smaller leak: even at `top: 0`, a lingering `margin-top`
     would still park the header's *painted* box that many pixels below the scroll edge, leaving the
     same class of gap just smaller. (The same reasoning applies to the bottom edge — `padding-bottom`
     below, not `margin-bottom`, keeps the space below this header's content inside its own opaque
     painted box too, for consistency with the top edge; there is no bleed-through risk there today
     since nothing scrolls *above* `.thread-messages`, but a stray bottom margin would be exactly the
     same class of gap-outside-the-background bug were that to ever change.)
     `top: 0` means the header's margin box (== border box, since margin-top is 0) lands flush with
     `.document-canvas`'s own top edge (which has no padding of its own — see DocumentCanvas.vue) the
     instant it engages — zero pixels of scrollport are ever above it, so nothing can bleed through
     geometrically. The breathing room the old `top: 0.4rem` was trying to preserve (matching
     `.conversation-thread-box`'s own 0.4rem top padding, which this header doesn't otherwise inherit
     since `.pane-eyebrow` — not this header — is the box's first child and the one actually sitting
     against that padding) is recreated by `padding-top` instead, which lives *inside* this header's
     own painted, opaque box: 0.4rem (the same breathing room) plus 0.15rem (replacing the
     `margin-top` removed above, so the gap from `.pane-eyebrow` to this header's content is
     unchanged) = 0.55rem. Padding, unlike `top`/`margin`, applies identically whether or not the
     header is currently stuck, so this does very slightly increase the resting (unstuck) gap below
     `.pane-eyebrow` versus the original pre-sticky layout — an accepted, minor trade-off, since
     there's no standard CSS way to condition padding on sticky-engagement state, and it's what keeps
     the stuck state fully opaque.
     Each `.thread-column`'s boxes still stick independently against their own bounds (confirmed via
     the same Playwright probe — different columns can show different stuck headers at once); this
     was never a horizontal inset bug either — `.thread-header` and `.thread-messages` share the same
     left/right edges in every state, only proven by measuring both, not simply asserting it — and
     horizontal position is unaffected by a sticky offset that only sets `top`. `background` matches
     this box's own `--panel-bg` (see `.conversation-thread-box` above) so `.thread-messages` content
     scrolling underneath can't show through the header's own box either. `--z-raised` (style.css
     `:root`) only needs to beat this box's own unstyled (z-index: auto) message content directly
     below it in the same stacking context; `.conversation-thread-box` being `position: absolute`
     already gives it its own stacking context, so this can never collide with any app-level
     overlay's z-index (e.g. `ConversationDetailPanel.vue`'s `--z-raised`, App.vue's `--z-overlay`/
     `--z-overlay-detail`, `PrimaryPanel.vue`'s/`ConversationView.vue`'s `--z-overlay-primary`,
     `ReconnectingIndicator.vue`'s `--z-indicator`) — those all live in entirely separate stacking
     contexts. */
  margin: 0;
  padding-top: 0.55rem;
  padding-bottom: 0.4rem;
  position: sticky;
  top: 0;
  z-index: var(--z-raised, 1);
  background: var(--panel-bg, #f7f7f8);
}
.thread-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem;
}
.thread-title-group {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  flex: 1;
}
.thread-title {
  font-weight: 600;
  font-size: 0.85rem;
  min-width: 0;
}
/* Icon-only button, same 24x24 minimum hit area as `.thread-action-button` (research.md §4) —
   deliberately borderless/transparent at rest so it doesn't compete visually with the title text,
   picking up a visible border only on hover/focus (same treatment as `.thread-action-button`'s own
   hover state, just starting from a quieter baseline appropriate to a secondary, always-visible
   affordance). */
.thread-rename-button {
  flex-shrink: 0;
  min-width: 24px;
  min-height: 24px;
  font-size: 0.75rem;
  line-height: 1;
  padding: 0.15rem 0.3rem;
  color: var(--neutral-muted-color, #4b5563);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.thread-rename-button:hover,
.thread-rename-button:focus-visible {
  color: var(--text-color, #111);
  background: var(--panel-bg-alt, #eef0f3);
  border-color: var(--neutral-muted-color, #4b5563);
}
.thread-rename-button:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: 1px;
}
.thread-title-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--text-color, #111);
  background: var(--panel-bg, #f7f7f8);
  border: 1px solid var(--accent-color, #2563eb);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
}
.thread-title-input:disabled {
  opacity: 0.7;
}
.rename-error {
  color: var(--danger-color, #b91c1c);
  font-size: 0.7rem;
}
.thread-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.3rem;
  min-width: 0;
}
/* Status/stale/orphaned badge colors now live in `ConversationStatusBadges.vue` (shared verbatim
   with `HudPanel.vue`/`ConversationView.vue` — see that component's own doc comment). */
/* Branch-lineage breadcrumb: deliberately plain text (no border/background/cursor) — it must read
   as informational, not as another interactive control alongside the buttons below it. */
.branch-lineage {
  font-size: 0.7rem;
  color: var(--neutral-muted-color, #4b5563);
}
/* Every per-conversation action this box offers (Focus/Close/Expand-all/Branch) lives in this one
   row now, instead of being scattered across the header's old "Open" slot, a separate bulk-toggle
   toolbar, and a footer "Branch" row. */
.thread-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
/* Per-button visual styling (`.thread-action-button`, `.focus-button.is-focused`/`.focus-disabled`,
   `.close-button`) now lives in `ConversationActionButtons.vue`, shared with `ConversationView.vue`
   — see that component's own doc comment for the generic `data-action`/`aria-pressed`/`aria-disabled`
   attribute selectors that replace the old per-action-name classes. */
/* US3: compactness now comes from each `MessageBubble`'s own per-message max-height clamp
   (FR-008), not a fixed cap on this whole container — a box's height is the sum of its (capped)
   messages' heights instead of an arbitrary fixed box height. */
.thread-messages {
  display: flex;
  flex-direction: column;
}
/* Read-only continuity context (branch placeholder with zero of its own messages): dimmed +
   dashed, distinguishing it from `.thread-messages`'s real, interactive transcript below — same
   "context, not a real message" visual language `MessageBubble.vue`'s own `.seed-card` uses. */
.continuity-context {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-bottom: 0.4rem;
  padding: 0.3rem 0.4rem;
  border: 1px dashed var(--seed-border, #9ca3af);
  border-radius: 6px;
  background: var(--seed-bg, #f3f4f6);
  opacity: 0.85;
}
/* Contrast fix (a11y audit), same reasoning as `MessageBubble.vue`'s `.message-role-label` fix:
   `.continuity-context`'s own `--seed-bg` tint is further lightened by its `opacity: 0.85`, which
   blends it (and this label's text) toward whatever backdrop sits behind it — composited contrast
   for the flat-surface `--neutral-muted-color` measures right at ~4.5:1 with no margin there,
   risking a drop below AA depending on the real backdrop. style.css's tinted-surface token,
   `--neutral-muted-color-on-tint`, is the one meant for exactly this case and clears 5:1+ with
   real margin against every composited backdrop tested in dark mode; light mode is unaffected
   since dark text on this light/tinted-light card already has a huge margin. */
.continuity-label {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--neutral-muted-color-on-tint, #c3cad3);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.branch-error {
  color: var(--danger-color, #b91c1c);
  font-size: 0.7rem;
}
</style>
