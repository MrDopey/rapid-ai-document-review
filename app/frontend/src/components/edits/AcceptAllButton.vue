<script setup lang="ts">
import { useEditsStore } from '../../stores/edits.js';
import { useBusyAction } from '../../composables/useBusyAction.js';

const props = defineProps<{ conversationId: string; disabled?: boolean }>();
// `run` re-throws (see useBusyAction.ts's own doc comment) so this failure can be surfaced —
// EditsList.vue renders it via the same `.error-banner` convention as its per-row accept/drop.
const emit = defineEmits<{ error: [message: string] }>();
const store = useEditsStore();
const { busy, run } = useBusyAction(() => store.acceptRemaining(props.conversationId));

async function onClick(): Promise<void> {
  try {
    await run();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : 'Failed to accept remaining edits.');
  }
}
</script>

<template>
  <button type="button" class="accept-all-button" :disabled="disabled || busy" @click="onClick">
    {{ busy ? 'Accepting…' : 'Accept remaining' }}
  </button>
</template>
