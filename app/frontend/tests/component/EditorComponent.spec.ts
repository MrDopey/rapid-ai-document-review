import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { EditorView } from '@codemirror/view';
import EditorComponent from '../../src/components/editor/EditorComponent.vue';

function ctrlF(): KeyboardEvent {
  // jsdom (unlike a real browser) doesn't set `event.code` from `key` alone — CodeMirror's
  // keymap matching keys off `code` (`KeyF`) as well as `key`, so both need to be present for the
  // dispatched event to actually match the searchKeymap's `Mod-f` binding below.
  return new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

// Spec: specs/005-canvas-conversation-threads. Confirmed design: the single "Start conversation
// from selection" button is split into two — "Branch (New)" (empty placeholder, no continuity)
// and "Branch (Main)" (continues from the current point: the parent's last exchange renders as
// read-only continuity context, no document/selection resend) — both sharing the same
// `:disabled="!selection"` guard, and each emits `branch-from-selection` with an explicit
// `includeSeedMessage` boolean alongside the selection range so the whole chain (DocumentCanvas.vue
// -> App.vue -> conversationsStore.branch -> ConversationService.branch) can thread the flag
// through to the backend, where it now selects continuity (`forkedFromMessageId`) rather than a
// seed message.
//
// CodeMirror's own view isn't exposed by this component (`defineExpose` only surfaces
// `undo`/`redo`/`anchorTop`), so tests drive a real selection through `EditorView.findFromDOM` —
// the same public API CodeMirror itself documents for locating a mounted view from its DOM node —
// rather than reaching into private component internals.

function findView(wrapper: ReturnType<typeof mount>): EditorView {
  const host = wrapper.find('.editor-host').element as HTMLElement;
  const view = EditorView.findFromDOM(host);
  if (!view)
    throw new Error(
      'EditorView not found from DOM — component may not have mounted CodeMirror yet',
    );
  return view;
}

describe('EditorComponent — Branch (New) / Branch (Main) buttons', () => {
  it('both buttons are disabled with no selection, and enabled once one is made', async () => {
    const wrapper = mount(EditorComponent, {
      props: { modelValue: 'Hello world, this is a document.' },
    });
    const branchButton = wrapper.findAll('button.branch-button')[0];
    const seedButton = wrapper.findAll('button.branch-button')[1];

    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(seedButton.attributes('disabled')).toBeDefined();

    const view = findView(wrapper);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await wrapper.vm.$nextTick();

    expect(branchButton.attributes('disabled')).toBeUndefined();
    expect(seedButton.attributes('disabled')).toBeUndefined();
  });

  it('"Branch (New)" emits branch-from-selection with includeSeedMessage: false', async () => {
    const wrapper = mount(EditorComponent, {
      props: { modelValue: 'Hello world, this is a document.' },
    });
    const view = findView(wrapper);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await wrapper.vm.$nextTick();

    const branchButton = wrapper.findAll('button.branch-button')[0];
    expect(branchButton.text()).toBe('Branch (New)');
    await branchButton.trigger('click');

    const emitted = wrapper.emitted('branch-from-selection');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]).toEqual([{ from: 0, to: 5 }, false]);
  });

  it('"Branch (Main)" emits branch-from-selection with includeSeedMessage: true', async () => {
    const wrapper = mount(EditorComponent, {
      props: { modelValue: 'Hello world, this is a document.' },
    });
    const view = findView(wrapper);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await wrapper.vm.$nextTick();

    const seedButton = wrapper.findAll('button.branch-button')[1];
    expect(seedButton.text()).toBe('Branch (Main)');
    await seedButton.trigger('click');

    const emitted = wrapper.emitted('branch-from-selection');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]).toEqual([{ from: 0, to: 5 }, true]);
  });

  // "Clicking while disabled emits nothing" for the no-selection case is covered once, below, by
  // the focus-cap describe block's identical assertion (same native-`disabled` mechanism either
  // way) — no need to duplicate it here too.
});

// Branch-cap parity fix (005-canvas-conversation-threads follow-up): the toolbar's two Branch
// buttons are threaded `focusedConversationIds`/`maxFocusedConversations` (App.vue's own multi-focus
// state, via DocumentCanvas.vue) so they can be disabled — with a tooltip naming the focus limit —
// once there's no free slot left to auto-focus a newly created branch into, the same behavior
// change already applied to the sidebar and focus-view Branch buttons.
describe('EditorComponent — Branch buttons at the focus cap', () => {
  function mountWithSelectionAt(atCap: boolean) {
    const wrapper = mount(EditorComponent, {
      props: {
        modelValue: 'Hello world, this is a document.',
        focusedConversationIds: atCap ? new Set(['a', 'b', 'c']) : new Set(),
        maxFocusedConversations: 3,
      },
    });
    return wrapper;
  }

  async function makeSelection(wrapper: ReturnType<typeof mount>): Promise<void> {
    const view = findView(wrapper);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await wrapper.vm.$nextTick();
  }

  it('disables both buttons, with a focus-limit tooltip, once a selection exists but the focus set is at the cap', async () => {
    const wrapper = mountWithSelectionAt(true);
    await makeSelection(wrapper);

    const [branchButton, seedButton] = wrapper.findAll('button.branch-button');
    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(seedButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).toMatch(/max 3/);
    expect(seedButton.attributes('title')).toMatch(/max 3/);
  });

  it('keeps the original "no selection" tooltip (not the cap tooltip) when both reasons apply — no-selection takes priority', () => {
    const wrapper = mountWithSelectionAt(true);
    const [branchButton, seedButton] = wrapper.findAll('button.branch-button');

    expect(branchButton.attributes('disabled')).toBeDefined();
    expect(branchButton.attributes('title')).not.toMatch(/max 3/);
    expect(branchButton.attributes('title')).toMatch(/Highlight text/);
    expect(seedButton.attributes('title')).not.toMatch(/max 3/);
    expect(seedButton.attributes('title')).toMatch(/Highlight text/);
  });

  it('stays enabled, with the original tooltip, once a selection exists and the focus set has room', async () => {
    const wrapper = mountWithSelectionAt(false);
    await makeSelection(wrapper);

    const [branchButton, seedButton] = wrapper.findAll('button.branch-button');
    expect(branchButton.attributes('disabled')).toBeUndefined();
    expect(seedButton.attributes('disabled')).toBeUndefined();
    expect(branchButton.attributes('title')).toMatch(/Highlight text/);
  });

  it('clicking either disabled (at-cap) button emits nothing', async () => {
    const wrapper = mountWithSelectionAt(true);
    await makeSelection(wrapper);

    await wrapper.findAll('button.branch-button')[0].trigger('click');
    await wrapper.findAll('button.branch-button')[1].trigger('click');

    expect(wrapper.emitted('branch-from-selection')).toBeUndefined();
  });
});

// Ctrl+F/Cmd+F in-editor search (not the browser's native find-in-page): `@codemirror/search`'s
// `search()` extension + `searchKeymap` (wired into EditorComponent.vue's own keymap.of([...]))
// give Mod-f -> openSearchPanel for free, and CodeMirror's keymap only fires when the keydown
// event actually reaches the editor's own contentDOM — so this is exercised the same way a real
// browser would: dispatching a real KeyboardEvent, not calling openSearchPanel directly.
describe('EditorComponent — Ctrl+F opens the in-editor search panel', () => {
  it('opens the CodeMirror search panel when the event reaches the focused editor', () => {
    const wrapper = mount(EditorComponent, {
      props: { modelValue: 'Hello world, this is a document.' },
    });
    const view = findView(wrapper);

    expect(wrapper.find('.cm-search').exists()).toBe(false);

    const event = ctrlF();
    const prevented = !view.contentDOM.dispatchEvent(event);

    expect(prevented).toBe(true); // dispatchEvent returns false once preventDefault() was called
    expect(wrapper.find('.cm-search').exists()).toBe(true);
  });

  it('does not intercept (nor preventDefault) Ctrl+F when it fires outside the editor', () => {
    mount(EditorComponent, { props: { modelValue: 'Hello world, this is a document.' } });

    const event = ctrlF();
    const notPrevented = document.body.dispatchEvent(event);

    expect(notPrevented).toBe(true); // true means nothing called preventDefault() — native find-in-page still applies
  });
});
