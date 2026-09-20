import { describe, expect, it } from 'vitest';
import {
  findConflicts,
  matchesBinding,
  HOTKEY_BINDINGS,
  isEditingContext,
  type HotkeyBinding,
} from '../../src/a11y/keymap-registry.js';

// Hotkey-consolidation refactor: `HOTKEY_BINDINGS` is the single machine-checkable list every
// app-level (non-CodeMirror) keydown binding's modifiers+code+scope now lives in — see that
// array's own doc comment in a11y/keymap-registry.ts. This is the regression guard: it runs
// `findConflicts` over the actual live list, so a future addition that collides with an existing
// combo fails here instead of silently shadowing (or being shadowed by) an existing shortcut.

function binding(
  overrides: Partial<HotkeyBinding> & Pick<HotkeyBinding, 'id' | 'code'>,
): HotkeyBinding {
  return {
    modifiers: { ctrl: true, alt: true, shift: false },
    scope: 'Global',
    description: overrides.id,
    ...overrides,
  };
}

describe('findConflicts', () => {
  it('reports zero conflicts for the real, live HOTKEY_BINDINGS list', () => {
    expect(findConflicts(HOTKEY_BINDINGS)).toEqual([]);
  });

  // Bug fix regression: Ctrl+Alt+1..9 (focus-toggle-1..9) must be reachable from inside a
  // conversation composer's own textarea, exactly like the cycle-focused-conversations shortcut —
  // see FOCUS_TOGGLE_BINDINGS' own doc comment in keymap-registry.ts for the bug this fixes.
  it('every focus-toggle-<N> binding is composer-exempt', () => {
    const focusToggleBindings = HOTKEY_BINDINGS.filter((b) => b.id.startsWith('focus-toggle-'));
    expect(focusToggleBindings).toHaveLength(9);
    for (const b of focusToggleBindings) {
      expect(b.composerExempt).toBe(true);
    }
  });

  // Bug fix regression: `cycle-conversation-next-alt` (Ctrl+Alt+N) is a guaranteed-reachable
  // alternate for `cycle-conversation-next` (Ctrl+Alt+L), added since a bare Ctrl+Alt+L is a common
  // OS-level "Lock screen" shortcut on several Linux desktop environments — see that binding's own
  // doc comment in keymap-registry.ts.
  it('cycle-conversation-next-alt (Ctrl+Alt+N) exists as a composer-exempt, Global alternate for KeyL', () => {
    const alt = HOTKEY_BINDINGS.find((b) => b.id === 'cycle-conversation-next-alt');
    expect(alt).toMatchObject({
      code: 'KeyN',
      scope: 'Global',
      modifiers: { ctrl: true, alt: true, shift: false },
      composerExempt: true,
    });
  });

  // Bug fix regression: Thread mode's own Ctrl+Alt+J/K (`thread-cycle-next`/`thread-cycle-prev`,
  // 'Thread list' scope) must be composer-exempt — unlike canvas mode's own 'Conversation list'
  // `cycle-next`/`cycle-prev`, which have a separate composer-exempt fallback (Ctrl+Alt+H/L) and so
  // deliberately stay unset — since they're Thread mode's ONLY keyboard way to move between threads,
  // and `ThreadComposer.vue`'s own textarea is the one control a reviewer's cursor sits in most of
  // the time in this mode. See `isEditingContext`'s own `allowComposer` doc comment for the full
  // root-cause writeup.
  it('both thread-cycle-next and thread-cycle-prev are composer-exempt', () => {
    const threadBindings = HOTKEY_BINDINGS.filter((b) => b.scope === 'Thread list');
    expect(threadBindings).toHaveLength(2);
    for (const b of threadBindings) {
      expect(b.composerExempt).toBe(true);
    }
  });

  it('flags two distinct bindings sharing an identical modifiers+code combo within reachable scopes', () => {
    const bindings = [
      binding({ id: 'a', code: 'KeyZ', scope: 'Global' }),
      binding({ id: 'b', code: 'KeyZ', scope: 'Global' }),
    ];
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.a.id).toBe('a');
    expect(conflicts[0]!.b.id).toBe('b');
  });

  it('does not flag two bindings that differ only by one modifier (e.g. Shift)', () => {
    const bindings = [
      binding({ id: 'a', code: 'KeyZ', modifiers: { ctrl: true, alt: true, shift: false } }),
      binding({ id: 'b', code: 'KeyZ', modifiers: { ctrl: true, alt: true, shift: true } }),
    ];
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('does not flag two "Document editor"-scoped bindings against a "Global"/"Conversation list" one sharing the same combo — CodeMirror is an isolated keymap system', () => {
    const bindings = [
      binding({ id: 'editor-thing', code: 'KeyZ', scope: 'Document editor' }),
      binding({ id: 'global-thing', code: 'KeyZ', scope: 'Global' }),
    ];
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('still flags two "Document editor"-scoped bindings against each other (a real CodeMirror keymap collision)', () => {
    const bindings = [
      binding({ id: 'a', code: 'KeyZ', scope: 'Document editor' }),
      binding({ id: 'b', code: 'KeyZ', scope: 'Document editor' }),
    ];
    expect(findConflicts(bindings)).toHaveLength(1);
  });

  it('flags a "Global" binding against a "Conversation list" one sharing the same combo — both are dispatched off the same document-level keydown, just filtered to their own scope', () => {
    const bindings = [
      binding({ id: 'a', code: 'KeyZ', scope: 'Global' }),
      binding({ id: 'b', code: 'KeyZ', scope: 'Conversation list' }),
    ];
    expect(findConflicts(bindings)).toHaveLength(1);
  });

  it('flags a composer-exempt binding against an ordinary "Global" one sharing the same combo — a composer keydown still bubbles to the same document-level listener as everything else', () => {
    const bindings = [
      binding({ id: 'a', code: 'KeyZ', scope: 'Global', composerExempt: true }),
      binding({ id: 'b', code: 'KeyZ', scope: 'Global' }),
    ];
    expect(findConflicts(bindings)).toHaveLength(1);
  });
});

describe('matchesBinding', () => {
  it('requires an exact match on ctrl/alt/shift and code — a stray extra modifier never matches', () => {
    const target = binding({
      id: 'a',
      code: 'KeyH',
      modifiers: { ctrl: true, alt: true, shift: false },
    });
    expect(
      matchesBinding(
        new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true }),
        target,
      ),
    ).toBe(true);
    expect(
      matchesBinding(
        new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true, shiftKey: true }),
        target,
      ),
    ).toBe(false);
    expect(
      matchesBinding(
        new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true }),
        target,
      ),
    ).toBe(false);
  });
});

describe('isEditingContext — allowComposer option', () => {
  function composerTextarea(conversationId = 'conv-1'): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.id = `composer-${conversationId}`;
    document.body.appendChild(el);
    return el;
  }

  it('without allowComposer, a composer textarea still blocks (matches every pre-existing caller)', () => {
    const el = composerTextarea();
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event)).toBe(true);
    el.remove();
  });

  it('with allowComposer, a composer textarea (id prefix composer-) is exempted', () => {
    const el = composerTextarea();
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(false);
    el.remove();
  });

  it('with allowComposer, a non-composer textarea is still blocked', () => {
    const el = document.createElement('textarea');
    el.id = 'some-other-textarea';
    document.body.appendChild(el);
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(true);
    el.remove();
  });

  it('with allowComposer, a plain <input> (e.g. the rename field) is still blocked', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(true);
    el.remove();
  });

  it('with allowComposer, a contenteditable surface (the document editor) is still blocked', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true });
    document.body.appendChild(el);
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(true);
    el.remove();
  });

  it('with allowComposer, a composer textarea inside another open (non-excluded) dialog is still blocked', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const el = document.createElement('textarea');
    el.id = 'composer-conv-1';
    dialog.appendChild(el);
    document.body.appendChild(dialog);
    const event = new KeyboardEvent('keydown', { code: 'KeyH', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(true);
    dialog.remove();
  });

  // Bug fix regression (Thread mode's Ctrl+Alt+J/K "not working" while typing): `ThreadComposer.vue`
  // deliberately uses a `thread-composer-` id prefix (distinct from canvas mode's own `composer-`),
  // which this option must recognize too, or Thread mode's own `composerExempt` bindings
  // (`thread-cycle-next`/`thread-cycle-prev` in HOTKEY_BINDINGS below) would still be silently
  // swallowed by the blanket textarea rule despite the flag being set.
  it('with allowComposer, a Thread-mode composer textarea (id prefix thread-composer-) is exempted', () => {
    const el = document.createElement('textarea');
    el.id = 'thread-composer-thread-1';
    document.body.appendChild(el);
    const event = new KeyboardEvent('keydown', { code: 'KeyJ', ctrlKey: true, altKey: true });
    Object.defineProperty(event, 'target', { value: el });
    expect(isEditingContext(event, { allowComposer: true })).toBe(false);
    el.remove();
  });
});
