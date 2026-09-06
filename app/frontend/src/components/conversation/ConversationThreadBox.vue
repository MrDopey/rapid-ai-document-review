<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useConversationsStore } from '../../stores/conversations.js';
import { scrollMessageTopIntoView } from '../../composables/messageScroll.js';
import { useConversationContinuity } from '../../composables/conversationContinuity.js';
import { useConversationRename } from '../../composables/conversationRename.js';
import {
  useConversationBranchAction,
  useBulkToggleAction,
  type ActionDescriptor,
} from '../../composables/conversationActions.js';
import { useConversationStatusBadges } from '../../composables/conversationStatusBadges.js';
import ConversationStatusBadges from './ConversationStatusBadges.vue';
import ConversationActionButtons from './ConversationActionButtons.vue';
import MessageBubble from './MessageBubble.vue';

// A per-box detail view can't support switching between conversations while one is already open
// (it would cover the *entire* viewport including the toolbar/HUD, so clicking a different HUD row
// to switch never reaches it). So the actual detail view is rendered in `App.vue` (via
// `ConversationDetailPanel.vue`, one instance per currently focused conversation) — this box only
// ever *requests* a change to focus state; it doesn't render or own any detail panel itself.
// Several conversations may have an open detail panel simultaneously, up to a configurable cap
// (`focusedConversationIds: Set<string>` in App.vue), and both this box's "Focus" button and its
// "Close" button (only rendered while `isFocused`) just request the *same* toggle rather than two
// directionally-different actions — App.vue's own toggle already no-ops correctly in either
// direction (removing when present, adding when absent and under cap). `focusDisabled`/
// `maxFocused` (both computed by App.vue/DocumentCanvas.vue from the live cap and current focused
// count) drive the Focus button's own disabled-looking affordance when focusing this conversation
// would exceed that cap; they're irrelevant whenever `isFocused` is already true (toggling off is
// always allowed, never capped).
// `atFocusCap` is the same live "no free slot" condition `focusDisabled` above already reflects for
// the Focus button, but *not* conditioned on `isFocused` — branching always creates a brand-new
// conversation (never already focused), so the Branch button's own disabled check is just the
// plain cap comparison, computed once by DocumentCanvas.vue and threaded down here as its own
// boolean prop (same "precomputed boolean + maxFocused number" shape as `focusDisabled`/
// `maxFocused` already establish).
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
  // Mirrors `ConversationView.vue`'s own `branch-created` emit — fired (via
  // `useConversationBranchAction`'s `onBranchCreated` callback) once a new branch is successfully
  // created, carrying its id up to App.vue (via DocumentCanvas.vue), which auto-focuses it. Branch
  // creation itself is blocked at the cap (see that composable's own doc comment), so by the time
  // this fires a free slot is always available.
  (e: 'branch-created', id: string): void;
}>();
const store = useConversationsStore();

const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);
const messages = computed(() => store.messagesFor(props.conversationId));
const { isPrimary } = useConversationStatusBadges(() => props.conversationId);

// Rename affordance: click-to-edit title, following the same "one action per slot" convention as
// the Branch action below — an inline text input replaces the plain-text `.thread-title`
// span rather than opening a modal/dialog, since this is a single-field, low-stakes edit. Save on
// Enter/blur, cancel on Escape (constitution's "UI Conventions": no confirmation dialog for a
// reversible, single-field text edit). Shared with `ConversationView.vue`'s focus/detail view via
// `useConversationRename` (same store action, `store.rename`, so renaming from either view updates
// both — they share the same Pinia store).
const nameInputEl = ref<HTMLInputElement | null>(null);
const { isEditingName, nameDraft, renameError, renameSaving, startEditingName, cancelEditingName, saveName } =
  useConversationRename(() => props.conversationId, nameInputEl);

// Branch-lineage cue (sidebar list view): a plain-text breadcrumb naming this conversation's
// parent, if any. This data model has no message-level fork-point field at all —
// `ConversationDto.parentId` links two *conversations*, and the only anchor a branch can carry
// (`seedSelection`) is a document character-range excerpt, never a specific transcript message id
// (see conversation-service.ts's `branch()` and conversationLayout.ts's doc comments). So "branched
// from" here names the parent conversation as a whole; it can't point at a specific message within
// it because no such reference is stored anywhere in the domain model.
// A freshly-created branch starts with zero messages of its own (see conversation-service.ts's
// `branch()` — `forkedFromMessageId` is populated with the parent's last message id at the moment
// of branching, `null` for a selection-anchored branch with no message-level fork point). Rather
// than leave that box a blank dead end, this borrows exactly two messages from the *parent's* own
// (already independently loaded — see `onMounted` below) message list for read-only display: the
// last user message and the last assistant message, up to and including `forkedFromMessageId`.
// These are never written into this conversation's own `messagesByConversation` entry — they stay
// sourced live from the parent, so they can never be mistaken for (or counted as) this
// conversation's own messages.
// This logic (and `parentConversation` above it) is shared with `ConversationView.vue`'s
// focus/detail view via `useConversationContinuity` — see that composable's doc comment — so both
// call sites stay in lockstep rather than risk drifting apart.
const { parentConversation, continuityMessages } = useConversationContinuity(() => props.conversationId);

// This box — not `MessageBubble.vue` itself — owns every one of its messages' `expanded` state,
// since the bulk toggle below needs to read/set all of them at once (data-model.md's
// `MessageDisplayState` is "purely a batch write over the same per-message field", not a separate
// stored bulk mode). Seeded from `localStorage` per message the first time each message is seen
// (streaming deltas update `message.text` in place without changing `id`, so this only runs once
// per real message) — see `ensureMessageExpandedSeeded` in `stores/conversations.ts` for the
// role-aware default (assistant replies start expanded, user messages stay collapsed-by-default)
// and the full reasoning.
//
// Backed by `conversationsStore.expandedByMessage` (keyed by conversationId then messageId), not a
// local `ref<Record<string, boolean>>` — this box and `ConversationView.vue`'s focus/detail view
// can both be mounted at once for the same conversation, so a local ref per component would let
// the two silently show different expanded/collapsed state for the same message. Both components
// read/write the exact same reactive source; `localStorage` stays purely the persistence layer
// underneath it.
const expandedByMessage = computed(() => store.expandedByMessage[props.conversationId] ?? {});
watch(messages, () => store.ensureMessageExpandedSeeded(props.conversationId), { immediate: true });

// Root DOM node of the sticky header — passed to `scrollMessageTopIntoView` below so it can offset
// for the header's own live rendered height (see that composable's doc comment for why a fixed CSS
// value wouldn't be reliable here: this header's height varies with a rename error, branch-lineage
// line, or wrapped action buttons).
const threadHeaderEl = ref<HTMLElement | null>(null);

// Expanding a single message (as opposed to the bulk "Expand all" toggle below, which deliberately
// leaves scroll position alone — there's no one message to anchor to) scrolls so its own top edge
// becomes visible, not just wherever it happens to land once its content grows. Only fires on a
// collapsed -> expanded transition (never on collapse, and never redundantly on an
// already-expanded message), since that's the only direction that can reveal new content the user
// hasn't seen yet.
function setMessageExpanded(messageId: string, expanded: boolean): void {
  const wasExpanded = expandedByMessage.value[messageId];
  store.setMessageExpanded(props.conversationId, messageId, expanded);
  if (expanded && !wasExpanded) {
    scrollMessageTopIntoView(rootEl.value, messageId, threadHeaderEl.value);
  }
}

// FR-009: a single bulk write over every message's `expanded` field — if any message is currently
// collapsed, one click expands all of them; once every message is already expanded, the same
// control collapses all of them instead. Individual messages stay independently toggleable
// afterward (setMessageExpanded above is unchanged by this bulk path).
// Shared with `ConversationView.vue` via `useBulkToggleAction`.
const { action: bulkToggleAction, visible: bulkToggleVisible } = useBulkToggleAction(() => props.conversationId);

// Root element exposed so `DocumentCanvas.vue` can attach a `ResizeObserver` to it (Phase 4/US2's
// sibling-collision stacking needs each box's *actual* rendered height, not a fixed assumption).
const rootEl = ref<HTMLElement | null>(null);

// There is no message-level anchor in this data model (`CreateConversationRequest` only carries an
// optional *document* `selection`, never a message id). "Branch off a specific message" is
// implemented as branching *this* conversation with no selection — the new child renders one
// column further out, inheriting this conversation's own resolved position (`resolveBaseAnchorY`
// in `conversationLayout.ts`). This is a dedicated affordance, alongside every other header action
// (constitution: one action per slot).
// Shared with `ConversationView.vue`'s focus-view "Branch" button via `useConversationBranchAction`
// (see that composable's own doc comment): blocked outright while `atFocusCap`, and auto-focuses
// the new branch via the `branch-created` emit on every success.
const { action: branchAction, error: branchError } = useConversationBranchAction(() => props.conversationId, {
  atFocusCap: () => props.atFocusCap,
  maxFocused: () => props.maxFocused,
  onBranchCreated: (id) => emit('branch-created', id),
});

// `ConversationView.vue` is not permanently mounted for every conversation — this compact box is
// the only thing that renders for a conversation by default, so it has to trigger the message
// fetch itself. Guarded so remounting this box (e.g. during layout reflow) doesn't refetch
// messages that are already loaded.
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
// `focusDisabled`): a click always still toggles regardless of whether it "looks" capped,
// `ariaDisabled` alone carries that affordance so the button stays keyboard-reachable and its
// title stays discoverable.
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
  <article
    v-if="conversation"
    ref="rootEl"
    class="conversation-thread-box"
    :class="{ 'is-primary': isPrimary }"
    :data-conversation-id="conversationId"
  >
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
  /* Must use `--neutral-muted-color`, not `--border-color` — that token is documented in style.css
     as a "decorative divider only" (~1.5-1.7:1 against --panel-bg/--bg-color, below WCAG 1.4.11's
     3:1 non-text minimum). This box's outer edge is a UI-boundary cue (it's how adjacent
     stacked/columned boxes read as separate), which needs the higher-contrast token —
     `--neutral-muted-color` clears 3:1+ against every flat panel surface (this box sits on flat
     `--panel-bg`/`--panel-bg-alt`, not a tinted one, so the plain — not `-on-tint` — variant is
     correct here) in both color schemes. */
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 6px;
  padding: 0.4rem 0.6rem 0.6rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
/* The shadow value lives once in style.css's `--primary-indicator-shadow` custom property (shared
   with `ConversationView.vue`'s/`HudPanel.vue`'s own `.is-primary` rules), reused here for visual
   consistency across all three surfaces that display a conversation. `box-shadow` is a single
   property and its values don't merge across separate rules, so this rule restates the base
   rule's own drop-shadow alongside `--primary-indicator-shadow` rather than losing it to a
   separate `.is-primary` override; both inset shadows automatically follow this box's own
   `border-radius: 6px` (an inset shadow is always clipped to the padding box's rounded corners,
   same as the border it sits just inside of). */
.conversation-thread-box.is-primary {
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.08),
    var(--primary-indicator-shadow);
}
.thread-header {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  /* A sticky element's `top` positions its *margin* edge, not its painted box — any offset there
     (from `top` itself, or from a leftover `margin-top`) is a gap that sits OUTSIDE this header's
     own opaque background, letting `.thread-messages` content scrolling underneath show through as
     it scrolls past. `top: 0` plus `margin: 0` eliminates that gap entirely, since the header's
     margin box (== border box, with no margin) then lands flush with the top of its scroll
     container the instant it engages.
     Breathing room is recreated via `padding-top`/`padding-bottom` instead of `margin`, since
     padding lives *inside* the header's own painted, opaque box and so can't reopen the same
     bleed-through gap (padding applies identically whether or not the header is currently stuck).
     `background` matches this box's own `--panel-bg` (see `.conversation-thread-box` above) for the
     same reason — content scrolling underneath can't show through the header's own box either.
     `--z-raised` (style.css `:root`) only needs to beat this box's own unstyled (z-index: auto)
     message content directly below it in the same stacking context; `.conversation-thread-box`
     being `position: absolute` already gives it its own stacking context, so this can never
     collide with any app-level overlay's z-index (e.g. `ConversationDetailPanel.vue`'s
     `--z-raised`, App.vue's `--z-overlay`/`--z-overlay-detail`,
     `PrimaryPanel.vue`'s/`ConversationView.vue`'s `--z-overlay-primary`,
     `ReconnectingIndicator.vue`'s `--z-indicator`) — those all live in entirely separate stacking
     contexts. `.thread-header` and `.thread-messages` share the same left/right edges in every
     state, and horizontal position is unaffected by a sticky offset that only sets `top`. */
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
/* `.thread-rename-button`/`.rename-error` shared shape now lives in style.css (identical to
   `ConversationView.vue`'s own copy). `.thread-title-input`'s shared shape (flex/border/padding)
   also lives there — this override layers just the three properties that differ from
   `ConversationView.vue`'s own copy (matching this box's own compact title styling rather than an
   `h2`). */
.thread-title-input {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--text-color, #111);
  background: var(--panel-bg, #f7f7f8);
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
/* Read-only continuity context (branch placeholder with zero of its own messages): shared shape/
   `.continuity-label` now live in style.css (identical to `ConversationView.vue`'s own copy,
   including this exact `margin-bottom` — no override needed here). See that stylesheet's own
   comment for the `--neutral-muted-color-on-tint` contrast reasoning. */
.branch-error {
  color: var(--danger-color, #b91c1c);
  font-size: 0.7rem;
}
</style>
