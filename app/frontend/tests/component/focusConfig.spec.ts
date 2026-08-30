import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import {
  DEFAULT_MAX_FOCUSED_CONVERSATIONS,
  resolveMaxFocusedConversations,
  useFocusCap,
} from '../../src/composables/focusConfig.js';

// Spec: specs/005-canvas-conversation-threads (multi-focus overlay confirmed design). Tests the
// pure `resolveMaxFocusedConversations` parser directly (rather than `import.meta.env`, which is
// read once at module scope — see focusConfig.ts's own doc comment) and `useFocusCap`'s
// clamp(envMax, [1, viewportFitCount]) math against an injected env-max via a second pure helper.

describe('resolveMaxFocusedConversations', () => {
  it('falls back to the default when unset', () => {
    expect(resolveMaxFocusedConversations(undefined)).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
  });

  it('falls back to the default when empty', () => {
    expect(resolveMaxFocusedConversations('')).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
  });

  it('falls back to the default for a non-integer', () => {
    expect(resolveMaxFocusedConversations('2.5')).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
    expect(resolveMaxFocusedConversations('abc')).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
  });

  it('falls back to the default for zero or negative values', () => {
    expect(resolveMaxFocusedConversations('0')).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
    expect(resolveMaxFocusedConversations('-1')).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
  });

  it('uses a valid positive integer as given', () => {
    expect(resolveMaxFocusedConversations('5')).toBe(5);
    expect(resolveMaxFocusedConversations('1')).toBe(1);
  });
});

describe('useFocusCap', () => {
  // `useFocusCap` reads the module-scope `maxFocusedConversationsFromEnv` (resolved once from
  // `import.meta.env`, unset in this test run — so it's `DEFAULT_MAX_FOCUSED_CONVERSATIONS`, 3).
  // These tests exercise the clamp against that fixed default rather than re-injecting env,
  // consistent with the "read once at module scope" design.
  it('clamps to the viewport fit count when it is below the env default', () => {
    const viewportFitCount = ref(1);
    const cap = useFocusCap(viewportFitCount);
    expect(cap.value).toBe(1);
  });

  it('never exceeds the env default even when more would fit on screen', () => {
    const viewportFitCount = ref(10);
    const cap = useFocusCap(viewportFitCount);
    expect(cap.value).toBe(DEFAULT_MAX_FOCUSED_CONVERSATIONS);
  });

  it('never drops below 1 even if viewportFitCount is reported as 0', () => {
    const viewportFitCount = ref(0);
    const cap = useFocusCap(viewportFitCount);
    expect(cap.value).toBe(1);
  });

  it('reacts to viewportFitCount changing', () => {
    const viewportFitCount = ref(1);
    const cap = useFocusCap(viewportFitCount);
    expect(cap.value).toBe(1);
    viewportFitCount.value = 2;
    expect(cap.value).toBe(2);
  });
});
