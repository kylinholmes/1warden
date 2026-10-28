// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import type { BulkDeletePreview, BulkDeleteResult } from '@1warden/vault';
import { BulkDeletePanel } from './BulkDelete';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; host?.remove(); });
const account = { serverUrl: 'https://bulk.test', email: 'bulk@example.invalid', userId: 'test', kdf: { kdf: 0 as const, iterations: 1 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(scope: 'vault' | 'trash' = 'vault') {
  let snapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', account } as ApplicationSnapshot;
  const listeners = new Set<() => void>();
  const preview: BulkDeletePreview = { token: 'single-use', scope, count: 3, account };
  const previewBulkDelete = vi.fn<() => Promise<BulkDeletePreview>>().mockResolvedValue(preview);
  const commitBulkDelete = vi.fn<() => Promise<BulkDeleteResult>>().mockResolvedValue({ completed: 3, skipped: 0, failed: [] });
  const client = { previewBulkDelete, commitBulkDelete, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as ApplicationClient;
  return { client, preview, previewBulkDelete, commitBulkDelete, emit(change: Partial<ApplicationSnapshot>) {
    snapshot = { ...snapshot, ...change, revision: snapshot.revision + 1 }; listeners.forEach(listener => listener());
  } };
}
async function mount(client: ApplicationClient, scope: 'vault' | 'trash' = 'vault', onCompleted = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(createElement(BulkDeletePanel, { client, scope, onCompleted })));
  return { onCompleted };
}
const button = (text: string) => [...host.querySelectorAll('button')].find(control => control.textContent === text)!;

describe('bulk cleanup confirmation', () => {
  it('requires an account/count preview and explicit confirmation before moving records', async () => {
    const f = fixture(); await mount(f.client);
    expect(f.previewBulkDelete).not.toHaveBeenCalled(); expect(f.commitBulkDelete).not.toHaveBeenCalled();
    await act(async () => button('预览移到回收站').click());
    expect(host.textContent).toContain('bulk@example.invalid'); expect(host.textContent).toContain('https://bulk.test');
    expect(host.textContent).toContain('3 条'); expect(host.textContent).toContain('归档'); expect(host.textContent).toContain('可恢复');
    expect(f.commitBulkDelete).not.toHaveBeenCalled();
    await act(() => button('取消').click());
    expect(f.commitBulkDelete).not.toHaveBeenCalled();
    await act(async () => button('预览移到回收站').click());
    await act(async () => button('确认移到回收站').click());
    expect(f.commitBulkDelete).toHaveBeenCalledExactlyOnceWith('single-use');
    expect(host.textContent).toContain('已移到回收站 3 条');
  });

  it('requires acknowledgement for irreversible empty trash and exposes partial results for a fresh preview', async () => {
    const f = fixture('trash'); f.commitBulkDelete.mockResolvedValue({ completed: 1, skipped: 1, failed: [{ name: 'Failed record', reason: '重新同步核实' }] });
    const { onCompleted } = await mount(f.client, 'trash');
    await act(async () => button('预览清空回收站').click());
    expect(host.textContent).toContain('无法恢复'); expect(button('确认永久删除').disabled).toBe(true);
    await act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { button('确认永久删除').click(); button('确认永久删除').click(); });
    expect(f.commitBulkDelete).toHaveBeenCalledTimes(1); expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('已永久删除 1 条'); expect(host.textContent).toContain('跳过 1 条');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('有 1 条记录需要检查');
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('Failed record');
    expect(host.textContent).toContain('Failed record：重新同步核实');
    expect(button('重新预览').disabled).toBe(false);
    expect([...host.querySelectorAll('button')].some(control => control.textContent === '确认永久删除')).toBe(false);
  });

  it('invalidates a pending preview across a lock/unlock cycle even on the same account', async () => {
    const f = fixture(); const pending = deferred<BulkDeletePreview>(); f.previewBulkDelete.mockReturnValue(pending.promise);
    await mount(f.client); await act(() => button('预览移到回收站').click());
    await act(() => { f.emit({ status: 'locked' }); f.emit({ status: 'unlocked' }); });
    await act(async () => pending.resolve(f.preview));
    expect([...host.querySelectorAll('button')].some(control => control.textContent === '确认移到回收站')).toBe(false);
    expect(f.commitBulkDelete).not.toHaveBeenCalled();
  });

  it('hides stale completion and never calls its refresh callback after an account change', async () => {
    const f = fixture(); const pending = deferred<BulkDeleteResult>(); f.commitBulkDelete.mockReturnValue(pending.promise);
    const { onCompleted } = await mount(f.client); await act(async () => button('预览移到回收站').click());
    await act(() => button('确认移到回收站').click());
    await act(() => f.emit({ account: { ...account, email: 'another@example.invalid' } }));
    const newSessionControl = document.createElement('button'); host.append(newSessionControl); newSessionControl.focus();
    await act(async () => pending.resolve({ completed: 3, skipped: 0, failed: [] }));
    expect(host.textContent).not.toContain('已移到回收站'); expect(onCompleted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(newSessionControl);
  });

  it('disables confirmation for an empty preview and requires a new preview after a commit error', async () => {
    const f = fixture(); f.previewBulkDelete.mockResolvedValue({ ...f.preview, count: 0 });
    await mount(f.client); await act(async () => button('预览移到回收站').click());
    expect(button('确认移到回收站').disabled).toBe(true);
    await act(() => button('取消').click());
    f.previewBulkDelete.mockResolvedValue(f.preview); f.commitBulkDelete.mockRejectedValue(new Error('预览已过期'));
    await act(async () => button('预览移到回收站').click()); await act(async () => button('确认移到回收站').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('预览已过期');
    expect([...host.querySelectorAll('button')].some(control => control.textContent === '确认移到回收站')).toBe(false);
    expect(button('重新预览').disabled).toBe(false);
  });
});

it('keeps focus through preview, cancel, partial completion and recoverable failures', async () => {
  const f = fixture(); await mount(f.client);
  await act(() => { button('预览移到回收站').focus(); button('预览移到回收站').click(); });
  expect(document.activeElement?.textContent).toBe('将移到回收站 3 条个人记录。');
  await act(() => button('取消').click());
  expect(document.activeElement).toBe(button('预览移到回收站'));
  f.previewBulkDelete.mockRejectedValueOnce(new Error('读取失败'));
  await act(() => button('预览移到回收站').click());
  expect(document.activeElement).toBe(button('重新预览'));
  await act(() => button('重新预览').click());
  f.commitBulkDelete.mockRejectedValueOnce(new Error('预览已过期'));
  await act(() => button('确认移到回收站').click());
  expect(document.activeElement).toBe(button('重新预览'));
  f.commitBulkDelete.mockResolvedValueOnce({ completed: 2, skipped: 0, failed: [{ name: 'Synthetic', reason: '连接中断' }] });
  await act(() => button('重新预览').click());
  await act(() => button('确认移到回收站').click());
  expect(document.activeElement?.textContent).toBe('清理部分完成');
});
