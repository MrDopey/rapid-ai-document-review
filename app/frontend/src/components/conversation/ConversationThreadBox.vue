<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useConversationsStore, type ConversationMessageState } from '../../stores/conversations.js';
import { ApiError } from '../../transport/http-client.js';
import { loadMessageExpanded, persistMessageExpanded } from '../../composables/messageDisplayState.js';
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
const props = withDefaults(
  defineProps<{ conversationId: string; isFocused?: boolean; focusDisabled?: boolean; maxFocused?: number }>(),
  { isFocused: false, focusDisabled: false, maxFocused: 3 },
);
const emit = defineEmits<{ (e: 'toggle-focus', conversationId: string): void }>();
const store = useConversationsStore();

const conversation = computed(() => store.conversations.find((c) => c.id === props.conversationId) ?? null);
const messages = computed(() => store.messagesFor(props.conversationId));

// Rename affordance: click-to-edit title, following the same "one action per slot" convention as
// `branchThisConversation` below — an inline text input replaces the plain-text `.thread-title`
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
const parentConversation = computed(() =>
  conversation.value?.parentId ? (store.conversations.find((c) => c.id === conversation.value?.parentId) ?? null) : null,
);

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
const continuityMessages = computed<ConversationMessageState[]>(() => {
  const conv = conversation.value;
  if (!conv || messages.value.length > 0 || !conv.forkedFromMessageId) return [];
  const parentMessages = store.messagesFor(conv.parentId ?? '');
  const forkIndex = parentMessages.findIndex((m) => m.id === conv.forkedFromMessageId);
  if (forkIndex === -1) return [];
  const upToFork = parentMessages.slice(0, forkIndex + 1);
  const lastUser = [...upToFork].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...upToFork].reverse().find((m) => m.role === 'assistant');
  const result: ConversationMessageState[] = [];
  for (const m of upToFork) {
    if (m === lastUser || m === lastAssistant) result.push(m);
  }
  return result;
});

// US3/FR-008/FR-009: this box — not `MessageBubble.vue` itself — owns every one of its messages'
// `expanded` state, since the bulk toggle below needs to read/set all of them at once
// (data-model.md's `MessageDisplayState` is "purely a batch write over the same per-message
// field", not a separate stored bulk mode). Seeded from `localStorage` per message the first time
// each message is seen (streaming deltas update `message.text` in place without changing `id`, so
// this only runs once per real message).
const expandedByMessage = ref<Record<string, boolean>>({});
watch(
  messages,
  (list) => {
    for (const message of list) {
      if (!(message.id in expandedByMessage.value)) {
        expandedByMessage.value[message.id] = loadMessageExpanded(message.id);
      }
    }
  },
  { immediate: true },
);

function setMessageExpanded(messageId: string, expanded: boolean): void {
  expandedByMessage.value[messageId] = expanded;
  persistMessageExpanded({ [messageId]: expanded });
}

// FR-009: a single bulk write over every message's `expanded` field — if any message is currently
// collapsed, one click expands all of them; once every message is already expanded, the same
// control collapses all of them instead. Individual messages stay independently toggleable
// afterward (setMessageExpanded above is unchanged by this bulk path).
const anyCollapsed = computed(() => messages.value.some((m) => !expandedByMessage.value[m.id]));
const bulkToggleLabel = computed(() => (anyCollapsed.value ? 'Expand all' : 'Collapse all'));
function toggleAllMessages(): void {
  const nextExpanded = anyCollapsed.value;
  const entries: Record<string, boolean> = {};
  for (const message of messages.value) {
    expandedByMessage.value[message.id] = nextExpanded;
    entries[message.id] = nextExpanded;
  }
  persistMessageExpanded(entries);
}

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
const branching = ref(false);
const branchError = ref<string | null>(null);
async function branchThisConversation(): Promise<void> {
  if (!conversation.value) return;
  branchError.value = null;
  branching.value = true;
  try {
    await store.branch({ parentConversationId: conversation.value.id });
  } catch (err) {
    // `canBranch` (server-computed, mirrors `maxConversationDepth`) already disables the button
    // below in the common case — this catch only covers a race (e.g. a setting change lowering
    // the depth limit between render and click), consistent with HudPanel.vue's `primaryError`
    // pattern for a similar server-side rejection.
    branchError.value =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to branch this conversation.';
  } finally {
    branching.value = false;
  }
}

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

defineExpose({ el: rootEl });
</script>

<template>
  <article v-if="conversation" ref="rootEl" class="conversation-thread-box" :data-conversation-id="conversationId">
    <span class="pane-eyebrow">Conversation</span>
    <header class="thread-header">
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
          <span class="badge status-badge" :data-status="conversation.status">{{ conversation.status }}</span>
          <span
            v-if="conversation.isStale"
            class="badge stale-badge"
            title="Stale: the document has changed since this conversation last saw it."
            >Stale</span
          >
          <!-- FR-011/SC-006: the conversation stays visible at its last known anchor position rather
               than disappearing or moving once its highlighted text has been edited or removed —
               this badge is the visual flag for that state. -->
          <span
            v-if="conversation.anchorOrphaned"
            class="badge orphaned-badge"
            title="Orphaned anchor: the highlighted text this conversation was anchored to has since been edited or removed."
            aria-label="Orphaned anchor: the highlighted text this conversation was anchored to has since been edited or removed."
            >Orphaned anchor</span
          >
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
        <button
          type="button"
          class="thread-action-button focus-button"
          :class="{ 'is-focused': isFocused, 'focus-disabled': focusDisabled }"
          :aria-pressed="isFocused"
          :aria-disabled="focusDisabled"
          :title="focusButtonTitle"
          :aria-label="focusButtonTitle"
          @click="toggleFocus"
        >
          Focus
        </button>
        <button
          v-if="isFocused"
          type="button"
          class="thread-action-button close-button"
          aria-label="Close this conversation's full view"
          @click="toggleFocus"
        >
          Close
        </button>
        <!-- US3/research.md §5: only worth showing once there's more than one message to bulk-act
             on. -->
        <button
          v-if="messages.length > 1"
          type="button"
          class="thread-action-button bulk-toggle-button"
          :aria-label="`${bulkToggleLabel} messages in this conversation`"
          @click="toggleAllMessages"
        >
          {{ bulkToggleLabel }}
        </button>
        <!-- US2 (FR-006/FR-007): disabled via the server-computed `canBranch` (mirrors
             `maxConversationDepth`, Constitution Principle V) rather than a client-reimplemented
             depth check. -->
        <button
          type="button"
          class="thread-action-button branch-button"
          :disabled="!conversation.canBranch || branching"
          :aria-label="`Branch this conversation${!conversation.canBranch ? ' (maximum conversation depth reached)' : ''}`"
          :title="!conversation.canBranch ? 'Maximum conversation depth reached' : 'Branch this conversation'"
          @click="branchThisConversation"
        >
          Branch
        </button>
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
  border: 1px solid var(--border-color, #ccc);
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
  margin: 0.15rem 0 0.4rem;
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
.stale-badge {
  color: var(--warning-color, #92400e);
}
.orphaned-badge {
  color: var(--warning-color, #92400e);
  background: var(--warning-bg, #fef3c7);
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
/* Visual-affordance fix: buttons need to read as clearly interactive at a glance, distinct from the
   plain-text `.branch-lineage` line above and the border-only `.badge` status pills in
   `.thread-status` (which have no fill). A filled background + visible border + hover/focus states
   is what actually separates "this is clickable" from "this is a label" here — `.badge` intentionally
   stays fill-less so the contrast holds.
   Dark-mode contrast fix: `--panel-bg-alt` and this box's own `--panel-bg` background are only
   ~1.15:1 apart (and `--border-color` only ~1.4-1.6:1 against either) in dark mode — well under
   WCAG 1.4.11's 3:1 non-text-contrast minimum for a UI component's boundary, so the button visually
   disappeared into the box. `--neutral-muted-color` (already validated elsewhere in this file/
   style.css to clear 4.5:1+ against every panel surface) clears 3:1 against both backgrounds in
   both color schemes, so the border alone now reliably demarcates the button regardless of how
   close its fill is to the surrounding panel. */
.thread-action-button {
  /* research.md §4: a real <button>, minimum 24x24px hit area. */
  min-width: 24px;
  min-height: 24px;
  font-size: 0.7rem;
  padding: 0.15rem 0.55rem;
  color: var(--text-color, #111);
  background: var(--panel-bg-alt, #eef0f3);
  border: 1px solid var(--neutral-muted-color, #4b5563);
  border-radius: 4px;
  cursor: pointer;
}
.thread-action-button:hover:not(:disabled) {
  background: var(--accent-color, #2563eb);
  border-color: var(--accent-color, #2563eb);
  color: #fff;
}
.thread-action-button:focus-visible {
  outline: 2px solid var(--accent-color, #2563eb);
  outline-offset: 1px;
}
.thread-action-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* 005-canvas-conversation-threads (multi-focus overlay): `aria-disabled`, not the native `disabled`
   attribute (see the prop doc comment above — this stays keyboard-reachable so `focusButtonTitle`'s
   explanation is actually discoverable); the visual dim has to be its own class rather than
   `:disabled` since that selector never matches here. */
.focus-button.focus-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* A small, non-color-alone cue (matching `HudPanel.vue`'s `.conversation-row.is-focused`) that this
   is the currently-open one — distinct from `:hover`/`:focus-visible`'s own accent treatment. */
.focus-button.is-focused {
  border-color: var(--accent-color, #2563eb);
  color: var(--accent-color, #2563eb);
}
.close-button {
  color: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
}
.close-button:hover:not(:disabled) {
  background: var(--danger-color, #b91c1c);
  border-color: var(--danger-color, #b91c1c);
  color: #fff;
}
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
