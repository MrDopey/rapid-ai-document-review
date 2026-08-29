<script setup lang="ts">
import { useEditsStore } from '../../stores/edits.js';
import { useBusyAction } from '../../composables/useBusyAction.js';

const props = defineProps<{ conversationId: string; disabled?: boolean }>();
const store = useEditsStore();
const { busy, run: onClick } = useBusyAction(() => store.acceptRemaining(props.conversationId));
</script>

<template>
  <button type="button" class="accept-all-button" :disabled="disabled || busy" @click="onClick">
    {{ busy ? 'Accepting…' : 'Accept remaining' }}
  </button>
</template>
