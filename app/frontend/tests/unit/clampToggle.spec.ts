import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { useClampToggle } from '../../src/composables/clampToggle.js';

/**
 * Direct composable coverage for `useClampToggle`'s message-scoped bulk-toggle API
 * (`canBulkToggle`/`bulkLabel`/`toggleAll`) — the per-region clamp/expand behavior itself is
 * already covered end-to-end through `ToolCallMessage.spec.ts`'s component mounts; these cases
 * only need a fake element with a `scrollHeight`, not a full render.
 */
function fakeEl(scrollHeight: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  return el;
}

function makeController(initialPrimary = false) {
  const primary = ref(initialPrimary);
  return useClampToggle(
    '__primary__',
    () => primary.value,
    (value) => {
      primary.value = value;
    },
  );
}

describe('useClampToggle — canBulkToggle', () => {
  it('is false with 0 registered secondaries', () => {
    const clamp = makeController();
    expect(clamp.canBulkToggle()).toBe(false);
  });

  it('is false with 1 registered secondary, even if overflowing', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(400));
    clamp.recompute();
    expect(clamp.canBulkToggle()).toBe(false);
  });

  it('is false with 2 registered secondaries, neither overflowing', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(10));
    clamp.setEl('b', fakeEl(10));
    clamp.recompute();
    expect(clamp.canBulkToggle()).toBe(false);
  });

  it('is true with 2 registered secondaries, only one overflowing', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(10));
    clamp.recompute();
    expect(clamp.canBulkToggle()).toBe(true);
  });

  it('drops an unregistered secondary from the count, flipping back to false when only 1 remains', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(400));
    clamp.recompute();
    expect(clamp.canBulkToggle()).toBe(true);

    clamp.setEl('b', null);
    expect(clamp.canBulkToggle()).toBe(false);
  });

  it('re-registering the same id without an intervening unmount does not reset an already-expanded secondary', () => {
    const clamp = makeController();
    const elA = fakeEl(400);
    const elB = fakeEl(400);
    clamp.setEl('a', elA);
    clamp.setEl('b', elB);
    clamp.recompute();

    clamp.toggle('a');
    expect(clamp.isExpanded('a')).toBe(true);

    // Redundant re-render calling setEl with the same element again (no unmount in between).
    clamp.setEl('a', elA);
    expect(clamp.isExpanded('a')).toBe(true);
  });
});

describe('useClampToggle — bulkLabel', () => {
  it('reads "Expand all" when any secondary is collapsed', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(400));
    clamp.recompute();
    expect(clamp.bulkLabel()).toBe('Expand all');
  });

  it('reads "Collapse all" when none are collapsed', () => {
    const clamp = makeController();
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(400));
    clamp.recompute();
    clamp.toggle('a');
    clamp.toggle('b');
    expect(clamp.bulkLabel()).toBe('Collapse all');
  });
});

describe('useClampToggle — toggleAll', () => {
  it('expands everything when the primary is already true but every secondary is default-collapsed', async () => {
    const clamp = makeController(true);
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(400));
    clamp.recompute();

    expect(clamp.isExpanded('a')).toBe(false);
    expect(clamp.isExpanded('b')).toBe(false);

    clamp.toggleAll();
    await nextTick();

    expect(clamp.isExpanded('a')).toBe(true);
    expect(clamp.isExpanded('b')).toBe(true);
  });

  it('collapses everything in a mixed state where secondaries are individually expanded but the primary flag is still false', async () => {
    const clamp = makeController(false);
    clamp.setEl('a', fakeEl(400));
    clamp.setEl('b', fakeEl(400));
    clamp.recompute();
    clamp.toggle('a');
    clamp.toggle('b');

    expect(clamp.isExpanded('a')).toBe(true);
    expect(clamp.isExpanded('b')).toBe(true);

    clamp.toggleAll();
    await nextTick();

    expect(clamp.isExpanded('a')).toBe(false);
    expect(clamp.isExpanded('b')).toBe(false);
  });
});
