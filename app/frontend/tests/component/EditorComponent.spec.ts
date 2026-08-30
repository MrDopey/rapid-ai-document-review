import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { EditorView } from '@codemirror/view';
import EditorComponent from '../../src/components/editor/EditorComponent.vue';

// Spec: specs/005-canvas-conversation-threads. Confirmed design: the single "Start conversation
// from selection" button is split into two — "Branch (New)" (empty placeholder, unchanged default
// behavior) and "Branch (Main)" (restores the pre-canvas seed-message behavior, carrying forward
// context/text from Main) — both sharing the same `:disabled="!selection"` guard, and each emits
// `branch-from-selection` with an explicit `includeSeedMessage` boolean alongside the selection
// range so the whole chain (DocumentCanvas.vue -> App.vue -> conversationsStore.branch ->
// ConversationService.branch) can thread the flag through to the backend.
//
// CodeMirror's own view isn't exposed by this component (`defineExpose` only surfaces
// `undo`/`redo`/`anchorTop`), so tests drive a real selection through `EditorView.findFromDOM` —
// the same public API CodeMirror itself documents for locating a mounted view from its DOM node —
// rather than reaching into private component internals.

function findView(wrapper: ReturnType<typeof mount>): EditorView {
  const host = wrapper.find('.editor-host').element as HTMLElement;
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error('EditorView not found from DOM — component may not have mounted CodeMirror yet');
  return view;
}

describe('EditorComponent — Branch (New) / Branch (Main) buttons', () => {
  it('both buttons are disabled with no selection, and enabled once one is made', async () => {
    const wrapper = mount(EditorComponent, { props: { modelValue: 'Hello world, this is a document.' } });
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
    const wrapper = mount(EditorComponent, { props: { modelValue: 'Hello world, this is a document.' } });
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
    const wrapper = mount(EditorComponent, { props: { modelValue: 'Hello world, this is a document.' } });
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

  it('clicking either button while disabled (no selection) emits nothing', async () => {
    const wrapper = mount(EditorComponent, { props: { modelValue: 'Hello world, this is a document.' } });

    await wrapper.findAll('button.branch-button')[0].trigger('click');
    await wrapper.findAll('button.branch-button')[1].trigger('click');

    expect(wrapper.emitted('branch-from-selection')).toBeUndefined();
  });
});
