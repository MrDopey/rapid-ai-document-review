import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Change } from 'diff';
import DiffText from '../../src/components/diff/DiffText.vue';

// Spec: specs/007-diff-viewer-modes (contracts/diff-text-component.md, FR-005/FR-010).

describe('DiffText', () => {
  const parts: Change[] = [
    { value: 'unchanged ' },
    { value: 'removed-word ', removed: true },
    { value: 'added-word ', added: true },
    { value: 'tail' },
  ];

  it('side="unified" renders every part in order with marker + visually-hidden label', () => {
    const wrapper = mount(DiffText, { props: { parts, side: 'unified' } });

    const del = wrapper.find('del.removed');
    const ins = wrapper.find('ins.added');
    expect(del.exists()).toBe(true);
    expect(ins.exists()).toBe(true);
    expect(del.find('.marker').text()).toBe('−');
    expect(del.find('.visually-hidden').text()).toBe('removed:');
    expect(del.text()).toContain('removed-word');
    expect(ins.find('.marker').text()).toBe('+');
    expect(ins.find('.visually-hidden').text()).toBe('added:');
    expect(ins.text()).toContain('added-word');

    // Order preserved: unchanged, removed, added, tail.
    const html = wrapper.html();
    expect(html.indexOf('unchanged')).toBeLessThan(html.indexOf('removed-word'));
    expect(html.indexOf('removed-word')).toBeLessThan(html.indexOf('added-word'));
    expect(html.indexOf('added-word')).toBeLessThan(html.indexOf('tail'));
  });

  it('side="left" omits added-only parts', () => {
    const wrapper = mount(DiffText, { props: { parts, side: 'left' } });
    expect(wrapper.find('ins.added').exists()).toBe(false);
    expect(wrapper.find('del.removed').exists()).toBe(true);
    expect(wrapper.text()).toContain('unchanged');
    expect(wrapper.text()).toContain('removed-word');
    expect(wrapper.text()).not.toContain('added-word');
  });

  it('side="right" omits removed-only parts', () => {
    const wrapper = mount(DiffText, { props: { parts, side: 'right' } });
    expect(wrapper.find('del.removed').exists()).toBe(false);
    expect(wrapper.find('ins.added').exists()).toBe(true);
    expect(wrapper.text()).toContain('unchanged');
    expect(wrapper.text()).toContain('added-word');
    expect(wrapper.text()).not.toContain('removed-word');
  });

  it('renders HTML-significant characters literally, never as markup', () => {
    const unsafeParts: Change[] = [
      { value: '<script>alert(1)</script>' },
      { value: '<b>bold</b>', added: true },
      { value: 'a & b', removed: true },
    ];
    const wrapper = mount(DiffText, { props: { parts: unsafeParts, side: 'unified' } });

    expect(wrapper.html()).not.toContain('<script>alert(1)</script>');
    expect(wrapper.html()).toContain('&lt;script&gt;');
    expect(wrapper.html()).not.toContain('<b>bold</b>');
    expect(wrapper.html()).toContain('&lt;b&gt;');
    expect(wrapper.html()).toContain('a &amp; b');
    expect(wrapper.text()).toContain('<script>alert(1)</script>');
    expect(wrapper.text()).toContain('<b>bold</b>');
    expect(wrapper.text()).toContain('a & b');
  });
});
