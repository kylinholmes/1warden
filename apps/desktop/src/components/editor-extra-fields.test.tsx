// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomField, LoginUri } from '@1warden/vault';
import { EditorCustomFields } from '../../../../packages/ui/src/EditorCustomFields';
import { EditorUrls } from '../../../../packages/ui/src/EditorUrls';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { if (root) await act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined; });
async function mount(render: () => ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(render()));
}
function control<T extends HTMLElement>(name: string): T { return host!.querySelector<T>(`[aria-label="${name}"]`)!; }
async function input(node: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(node: HTMLSelectElement, value: string) { await act(() => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); }
const textField: CustomField = { name: '中文字段名称 with a long description', value: 'Readable ordinary text', type: 0, linkedId: null, sourceId: 'stable-text' };
async function custom(initial: CustomField[]) {
  let fields = initial;
  const onChange = vi.fn((next: CustomField[]) => { fields = next; root!.render(render()); });
  const render = () => createElement(EditorCustomFields, { fields, itemType: 'login', onChange });
  await mount(render); return { onChange, fields: () => fields };
}
async function urls(initial: LoginUri[]) {
  let uris = initial;
  const onChange = vi.fn((next: LoginUri[]) => { uris = next; root!.render(render()); });
  const render = () => createElement(EditorUrls, { uris, onChange });
  await mount(render); return { onChange, uris: () => uris };
}

describe('single-column custom field editing', () => {
  it('uses the editable name once above the value with one small removal tool and no nested card', async () => {
    await custom([textField, { ...textField, name: 'Secret', type: 1, sourceId: 'stable-hidden' }]);
    const row = host!.querySelector<HTMLElement>('[data-editor-custom="0"]')!;
    expect(row.classList.contains('flex-col')).toBe(true);
    const name = control<HTMLInputElement>('字段 1 名称'); const value = control<HTMLInputElement>('字段 1 值');
    expect(name.closest('label')).not.toBeNull(); expect(value.closest('label')).not.toBeNull();
    expect(row.querySelectorAll('input, select, button')).toHaveLength(4);
    expect([...row.querySelectorAll('input, select')].map(node => node.getAttribute('aria-label')))
      .toEqual(['字段 1 名称', '字段 1 值', '字段 1 类型']);
    const nameRow = name.closest('[data-editor-custom-name-row]');
    expect(nameRow).not.toBeNull(); expect(control('删除字段 1').closest('[data-editor-custom-name-row]')).toBe(nameRow);
    expect(row.classList.contains('border')).toBe(false);
    expect(row.classList.contains('border-b')).toBe(true);
    expect(row.className).not.toContain('rounded-');
    expect(name.classList.contains('secret')).toBe(false);
    expect(value.classList.contains('secret')).toBe(false);
    expect(control<HTMLInputElement>('字段 2 值').classList.contains('secret')).toBe(true);
    expect(control<HTMLInputElement>('字段 2 值').type).toBe('password');
    expect(row.querySelector('h3, h4, legend')).toBeNull();
    expect(row.className).not.toContain('grid-cols');
  });
  it('keeps controls, focus, other rows and native identity when editing names and ordinary values', async () => {
    const other = { ...textField, name: 'Other', sourceId: 'other' };
    const fixture = await custom([textField, other]);
    const name = control<HTMLInputElement>('字段 1 名称'); const value = control<HTMLInputElement>('字段 1 值');
    await act(() => name.focus()); await input(name, 'Revised name');
    expect(document.activeElement).toBe(name); expect(control('字段 1 名称')).toBe(name);
    await input(value, 'Revised value');
    expect(fixture.fields()).toEqual([{ ...textField, name: 'Revised name', value: 'Revised value' }, other]);
    expect(fixture.fields()[1]).toBe(other);
    expect(control('字段 1 值')).toBe(value);
  });
  it('retains linked and boolean transitions, including unusual saved boolean values until edited', async () => {
    const fixture = await custom([{ ...textField, type: 2, value: 'legacy-value' }]);
    expect(fixture.onChange).not.toHaveBeenCalled(); expect(host!.textContent).toContain('未改动时会保留');
    await act(() => control<HTMLInputElement>('字段 1 开关').click());
    expect(fixture.fields()[0]?.value).toBe('true');
    await select(control('字段 1 类型'), '3');
    expect(fixture.fields()[0]).toEqual({ ...textField, type: 3, value: '', linkedId: 100 });
    await select(control('字段 1 关联目标'), '101');
    expect(fixture.fields()[0]?.linkedId).toBe(101);
    await select(control('字段 1 类型'), '1');
    expect(fixture.fields()[0]?.linkedId).toBeNull(); expect(control<HTMLInputElement>('字段 1 值').type).toBe('password');
  });
  it('preserves unknown types and linked targets without silently rewriting them and still permits explicit removal', async () => {
    const unknown = { ...textField, unsupportedType: 99 };
    const linked = { ...textField, type: 3 as const, linkedId: 999, sourceId: 'linked' };
    const fixture = await custom([unknown, linked]);
    expect(control<HTMLInputElement>('字段 1 名称').disabled).toBe(true);
    expect(control<HTMLSelectElement>('字段 1 类型').disabled).toBe(true);
    expect(control('字段 1 值')).toBeNull();
    expect(control<HTMLSelectElement>('字段 2 关联目标').value).toBe('999');
    expect(fixture.onChange).not.toHaveBeenCalled();
    await act(() => control<HTMLButtonElement>('删除字段 1').click());
    expect(fixture.fields()).toEqual([linked]);
  });
});

describe('single-column URL editing', () => {
  const first = { uri: 'https://one.example/long/path', match: 3, sourceId: 'first' };
  const second = { uri: 'https://two.example', match: 99, sourceId: 'second' };
  it('places one visible URL label above each input and uses its label row for removal', async () => {
    await urls([first, second]);
    for (const index of [1, 2]) {
      const input = control<HTMLInputElement>(`网址 ${index}`);
      const label = input.labels?.[0]!;
      expect(label).toBeDefined(); expect(input.parentElement?.classList.contains('flex-col')).toBe(true);
      expect(label.textContent).toBe(index === 1 ? '网址' : '网址 2');
      expect(label.closest('[data-editor-url-label-row]')).not.toBeNull();
      expect(control(`删除网址 ${index}`).closest('[data-editor-url-label-row]')).toBe(label.closest('[data-editor-url-label-row]'));
      expect(label.querySelector('button')).toBeNull();
      expect(input.classList.contains('secret')).toBe(false);
      const row = input.closest('[data-editor-url]')!;
      expect(row.querySelector('h3, h4, legend')).toBeNull();
      expect([...row.querySelectorAll('input, select')].map(node => node.getAttribute('aria-label')))
        .toEqual([`网址 ${index}`, `网址 ${index} 匹配方式`]);
    }
  });
  it('retains all URLs and match rules through text edits, matching changes, adding and removing', async () => {
    const fixture = await urls([first, second]);
    expect(fixture.onChange).not.toHaveBeenCalled();
    expect(control<HTMLSelectElement>('网址 2 匹配方式').value).toBe('99');
    const current = control<HTMLInputElement>('网址 1');
    await act(() => current.focus()); await input(current, 'https://revised.example');
    expect(control('网址 1')).toBe(current); expect(document.activeElement).toBe(current);
    expect(fixture.uris()).toEqual([{ ...first, uri: 'https://revised.example' }, second]);
    await select(control('网址 1 匹配方式'), '');
    expect(fixture.uris()[0]?.match).toBeNull(); expect(fixture.uris()[1]).toBe(second);
    await act(() => host!.querySelector<HTMLButtonElement>('[data-editor-add-url]')!.click());
    expect(fixture.uris()).toEqual([{ ...first, uri: 'https://revised.example', match: null }, second, { uri: '', match: null }]);
    await act(() => control<HTMLButtonElement>('删除网址 2').click());
    expect(fixture.uris()).toEqual([{ ...first, uri: 'https://revised.example', match: null }, { uri: '', match: null }]);
  });
  it('keeps the empty shell read-only until edited and delegates owned removal/addition callbacks', async () => {
    const onChange = vi.fn(); const onRemove = vi.fn(); const onAdd = vi.fn();
    await mount(() => createElement(EditorUrls, { uris: [], onChange, onRemove, onAdd }));
    expect(onChange).not.toHaveBeenCalled(); expect(control<HTMLInputElement>('网址 1').value).toBe('');
    expect(control('删除网址 1')).toBeNull();
    await act(() => host!.querySelector<HTMLButtonElement>('[data-editor-add-url]')!.click());
    expect(onAdd).toHaveBeenCalledOnce(); expect(onChange).not.toHaveBeenCalled();
    await act(() => root!.render(createElement(EditorUrls, { uris: [first], onChange, onRemove, onAdd })));
    await act(() => control<HTMLButtonElement>('删除网址 1').click());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(0); expect(onChange).not.toHaveBeenCalled();
  });
  it('inherits the save-time disabled state for every draft and destructive control', async () => {
    await mount(() => createElement('fieldset', { disabled: true },
      createElement(EditorUrls, { uris: [first], onChange: vi.fn() }),
      createElement(EditorCustomFields, { fields: [textField], itemType: 'login', onChange: vi.fn() })));
    expect([...host!.querySelectorAll('input, select, button')].every(node => node.matches(':disabled'))).toBe(true);
  });
});
