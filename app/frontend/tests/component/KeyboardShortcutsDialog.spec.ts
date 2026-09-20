import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import KeyboardShortcutsDialog from '../../src/components/toolbar/KeyboardShortcutsDialog.vue';

// Spec: 011-linear-thread-mode's mode-aware Keyboard Shortcuts dialog. App.vue mounts this dialog
// from two mutually-exclusive branches (canvas/document-editor mode and Thread mode) and now passes
// a `mode` prop so the dialog only lists shortcuts actually reachable from wherever it was opened —
// see keymap-registry.ts's `MODE_EXCLUSIVE_SCOPES` for which scopes are mode-exclusive and why.

function scopeHeadings(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('h3').map((el) => el.text());
}

describe('KeyboardShortcutsDialog — filters scopes by `mode` prop', () => {
  it('mode="canvas" shows "Document editor" and "Conversation list", hides "Thread list"', () => {
    const wrapper = mount(KeyboardShortcutsDialog, { props: { mode: 'canvas' } });
    const headings = scopeHeadings(wrapper);
    expect(headings).toContain('Document editor');
    expect(headings).toContain('Conversation list');
    expect(headings).not.toContain('Thread list');
  });

  it('mode="thread" shows "Thread list", hides "Document editor" and "Conversation list"', () => {
    const wrapper = mount(KeyboardShortcutsDialog, { props: { mode: 'thread' } });
    const headings = scopeHeadings(wrapper);
    expect(headings).toContain('Thread list');
    expect(headings).not.toContain('Document editor');
    expect(headings).not.toContain('Conversation list');
  });

  it('shows shared scopes (Conversation composer, Dialogs, Global) in both modes', () => {
    const sharedScopes = ['Conversation composer', 'Dialogs', 'Global'];
    const canvasHeadings = scopeHeadings(
      mount(KeyboardShortcutsDialog, { props: { mode: 'canvas' } }),
    );
    const threadHeadings = scopeHeadings(
      mount(KeyboardShortcutsDialog, { props: { mode: 'thread' } }),
    );
    for (const scope of sharedScopes) {
      expect(canvasHeadings).toContain(scope);
      expect(threadHeadings).toContain(scope);
    }
  });
});
