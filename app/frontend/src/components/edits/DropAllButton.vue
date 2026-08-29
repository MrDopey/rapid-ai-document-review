<script setup lang="ts">
import { useEditsStore } from '../../stores/edits.js';
import { useBusyAction } from '../../composables/useBusyAction.js';

const props = defineProps<{ conversationId: string; disabled?: boolean }>();
const store = useEditsStore();
const { busy, run: onClick } = useBusyAction(() => store.dropRemaining(props.conversationId));
</script>

<template>
  <button type="button" class="drop-all-button" :disabled="disabled || busy" @click="onClick">
    {{ busy ? 'Dropping…' : 'Drop remaining' }}
  </button>
</template>
