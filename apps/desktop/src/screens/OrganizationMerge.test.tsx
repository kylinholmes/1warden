// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarise } from '@1warden/ui';
import type { OrganizationMergePreview, OrganizationMergeResult } from '@1warden/vault';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import type { ApplicationClient } from '../application/types';
import { OrganizationMerge } from './OrganizationMerge';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; host?.remove(); });
const items = ['a', 'b', 'c'].map(id => summarise({ ...blankEditorItem(), id, name: `Fixture ${id}` }));
const preview = (over: Partial<OrganizationMergePreview> = {}): OrganizationMergePreview => ({
  token: 'fixture-token', baseId: 'a', itemIds: ['a', 'b', 'c'], items: items.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
  fields: [], additions: [{ label: '网址', count: 2 }], blockers: [], warnings: ['先保存主条目，再处理来源。'], ...over,
});
const result: OrganizationMergeResult = { baseId: 'a', saved: true, trashedIds: ['b', 'c'], retainedSources: [] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(plan = vi.fn().mockResolvedValue(preview()), merge = vi.fn().mockResolvedValue(result)) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const client = { previewMerge: plan, mergeItems: merge } as unknown as ApplicationClient;
  const onClose = vi.fn(); const onComplete = vi.fn();
  const render = async (open = true) => act(async () => root!.render(createElement(OrganizationMerge, { client, items, open, onClose, onComplete })));
  await render(); return { client, plan, merge, onClose, onComplete, render };
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;

describe('organization merge confirmation', () => {
  it('chooses a base and individual sources without writing until explicit confirmation', async () => {
    const { plan, merge, onComplete } = await mount();
    expect(merge).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled();
    expect(host.querySelector('select')).toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
    await act(() => host.querySelector<HTMLButtonElement>('[role="option"][data-value="b"]')!.click());
    await act(() => host.querySelector<HTMLInputElement>('[aria-label="合并来源「3. Fixture c」"]')!.click());
    await act(async () => button('预览合并').click());
    expect(plan).toHaveBeenCalledExactlyOnceWith({ baseId: 'b', sourceIds: ['a'] });
    expect(merge).not.toHaveBeenCalled();
    await act(async () => button('确认合并').click());
    expect(merge).toHaveBeenCalledExactlyOnceWith({ token: 'fixture-token', choices: {} });
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(result);
    expect(host.textContent).toContain('2 条来源已移到回收站');
  });

  it('requires every conflict choice and never renders sensitive preview values', async () => {
    const plan = preview({ fields: [{ key: 'password', label: '密码', secret: true, selectedItemId: null,
      options: [{ itemId: 'a', value: 'must-not-render-a' }, { itemId: 'b', value: 'must-not-render-b' }] }] });
    const { merge } = await mount(vi.fn().mockResolvedValue(plan));
    await act(async () => button('预览合并').click());
    expect(host.textContent).not.toContain('must-not-render');
    expect(button('确认合并').disabled).toBe(true);
    await act(() => button('确认合并').click()); expect(merge).not.toHaveBeenCalled();
    await act(() => host.querySelector<HTMLInputElement>('[aria-label="密码使用「2. Fixture b」"]')!.click());
    expect(button('确认合并').disabled).toBe(false);
    await act(async () => button('确认合并').click());
    expect(merge).toHaveBeenCalledExactlyOnceWith({ token: 'fixture-token', choices: { password: 'b' } });
  });

  it('cannot confirm blocked records and explains why all source records remain unchanged', async () => {
    const { merge } = await mount(vi.fn().mockResolvedValue(preview({ blockers: ['来源中包含附件，请先单独处理。'] })));
    await act(async () => button('预览合并').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('来源中包含附件');
    expect(host.textContent).toContain('没有改动任何记录');
    expect(button('确认合并').disabled).toBe(true);
    await act(() => button('确认合并').click()); expect(merge).not.toHaveBeenCalled();
  });

  it('reveals only an explicitly requested preview value and clears it when returning to selection', async () => {
    const plan = preview({ fields: [{ key: 'totp', label: '验证码密钥', secret: true, selectedItemId: null,
      options: [{ itemId: 'a', value: null }, { itemId: 'b', value: null }] }] });
    const { client } = await mount(vi.fn().mockResolvedValue(plan));
    const reveal = vi.fn().mockResolvedValue('SYNTHETIC-OTP-SEED');
    client.revealMergeValue = reveal;
    await act(async () => button('预览合并').click());
    expect(reveal).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('SYNTHETIC-OTP-SEED');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="显示验证码密钥（来源 2）"]')!.click());
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ token: 'fixture-token', fieldKey: 'totp', itemId: 'b' });
    expect(host.textContent).toContain('SYNTHETIC-OTP-SEED');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回选择主条目"]')!.click());
    expect(host.textContent).not.toContain('SYNTHETIC-OTP-SEED');
  });

  it('does not restore a revealed value after the preview has been closed', async () => {
    const pending = deferred<string>();
    const plan = preview({ fields: [{ key: 'password', label: '密码', secret: true, selectedItemId: null,
      options: [{ itemId: 'a', value: null }, { itemId: 'b', value: null }] }] });
    const { client, render } = await mount(vi.fn().mockResolvedValue(plan));
    client.revealMergeValue = vi.fn().mockReturnValue(pending.promise);
    await act(async () => button('预览合并').click());
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="显示密码（来源 1）"]')!.click());
    await render(false);
    await act(async () => pending.resolve('LATE-SYNTHETIC-SECRET'));
    expect(host.textContent).not.toContain('LATE-SYNTHETIC-SECRET');
  });

  it('locks repeat confirmation and Escape during the write, then reports partial cleanup clearly', async () => {
    const pending = deferred<OrganizationMergeResult>();
    const { merge, onClose } = await mount(undefined, vi.fn().mockReturnValue(pending.promise));
    await act(async () => button('预览合并').click());
    await act(() => { button('确认合并').click(); button('确认合并').click(); });
    expect(merge).toHaveBeenCalledTimes(1);
    await act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    const partial = { ...result, trashedIds: ['b'], retainedSources: [{ id: 'c', reason: '来源已被其他设备更新，仍保留。' }] };
    await act(async () => pending.resolve(partial));
    expect(host.textContent).toContain('主条目已保存');
    expect(host.textContent).toContain('有 1 条来源需要检查');
    expect(host.textContent).toContain('不要重复合并');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('3. Fixture c');
    expect(button('完成')).toBeDefined();
  });

  it('requires a fresh preview after failed saving instead of blindly retrying a consumed token', async () => {
    const { plan, merge } = await mount(undefined, vi.fn().mockRejectedValue(new Error('记录已变化，请重新核对。')));
    await act(async () => button('预览合并').click());
    await act(async () => button('确认合并').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('记录已变化');
    expect(button('确认合并')).toBeUndefined();
    await act(async () => button('重新载入预览').click());
    expect(plan).toHaveBeenCalledTimes(2); expect(merge).toHaveBeenCalledTimes(1);
    expect(button('确认合并')).toBeDefined();
  });

  it('ignores a late preview after closing the dialog', async () => {
    const pending = deferred<OrganizationMergePreview>();
    const { render } = await mount(vi.fn().mockReturnValue(pending.promise));
    await act(() => button('预览合并').click());
    await render(false);
    await act(async () => pending.resolve(preview({ blockers: ['late response must not appear'] })));
    expect(host.textContent).not.toContain('late response must not appear');
  });
});
