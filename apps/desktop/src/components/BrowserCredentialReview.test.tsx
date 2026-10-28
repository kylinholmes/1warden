// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserCredentialReview, GeneratedPasswordHistory } from './BrowserCredentialReview';
import type { BrowserCredentialActions, CapturePreview } from '../application/browser-credentials';

let node: HTMLDivElement; let root: Root;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(() => root.unmount()); node.remove(); });
const capture = (extra: Partial<CapturePreview> = {}): CapturePreview => ({ id: 'capture', revision: 2, tabId: 1,
  url: 'https://example.test/signup', username: null, action: 'review', itemId: null, createdAt: 1, snoozed: false,
  source: 'form', targets: [{ id: 'one', title: 'Example', username: 'alice', updatedAt: 'version-1' }], ...extra });
function actions(row = capture()): BrowserCredentialActions {
  return { list: vi.fn().mockResolvedValue([row]), save: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined),
    history: vi.fn().mockResolvedValue([{ id: 'generated', url: row.url, createdAt: Date.now() }]),
    revealHistory: vi.fn().mockResolvedValue('generated-secret'), deleteHistory: vi.fn().mockResolvedValue(undefined),
    recoverHistory: vi.fn().mockResolvedValue(capture({ source: 'history', tabId: null })) };
}
const button = (label: string) => [...node.querySelectorAll('button')].find(b => b.textContent === label)!;
async function select(value: string) {
  await act(() => node.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  const option = [...node.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.dataset['value'] === value)!;
  await act(() => option.click());
}
it('requires an explicit target for ambiguity and sends only the reviewed target revision', async () => {
  const api = actions();
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  expect(node.textContent).toContain('https://example.test');
  expect(button('保存密码').disabled).toBe(true);
  await select('item:one');
  await act(() => button('更新密码').click());
  expect(api.save).toHaveBeenCalledExactlyOnceWith({ captureId: 'capture', revision: 2, action: 'update', itemId: 'one', targetUpdatedAt: 'version-1' });
  expect(node.textContent).not.toContain('generated-secret');
});
it('offers new-item saving, keeps a failed capture available and allows retry', async () => {
  const api = actions(capture({ action: 'save', username: 'alice' }));
  vi.mocked(api.save).mockRejectedValueOnce(new Error('网络未连接'));
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  await act(() => button('保存密码').click());
  expect(node.textContent).toContain('网络未连接'); expect(button('保存密码').disabled).toBe(false);
  expect(document.activeElement).toBe(button('保存密码'));
  await act(() => button('保存密码').click());
  expect(api.save).toHaveBeenLastCalledWith({ captureId: 'capture', revision: 2, action: 'save', username: 'alice' });
});

it('moves focus to the next capture after saving or ignoring and keeps a concise completion status', async () => {
  const first = capture({ action: 'save' }); const second = capture({ id: 'second', action: 'save' });
  const api = actions(first); let rows = [first, second];
  vi.mocked(api.list).mockImplementation(async () => rows);
  vi.mocked(api.save).mockImplementation(async () => { rows = rows.filter(row => row.id !== first.id); });
  vi.mocked(api.dismiss).mockImplementation(async id => { rows = rows.filter(row => row.id !== id); });
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  await act(() => button('保存密码').click());
  expect(document.activeElement).toBe(node.querySelector('[data-capture-id="second"] h3'));
  expect(node.querySelector('[role="status"]')?.textContent).toBe('密码已保存；剩余 1 项待检查。');
  await act(() => button('不保存').click());
  expect(document.activeElement).toBe(node.querySelector('h2'));
  expect(node.querySelector('[role="status"]')?.textContent).toBe('已忽略此项；剩余 0 项待检查。');
});

it('restores the original action after a failed dismiss refresh replaces a revised capture', async () => {
  const api = actions(capture({ action: 'save' }));
  vi.mocked(api.dismiss).mockRejectedValueOnce(new Error('Offline synthetic'));
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  vi.mocked(api.list).mockResolvedValue([capture({ action: 'save', revision: 3 })]);
  await act(() => button('不保存').click());
  expect(document.activeElement).toBe(button('不保存'));
  expect(api.dismiss).toHaveBeenCalledOnce();
  expect(node.querySelector('[role="status"]')?.textContent).toContain('操作未完成，请检查后重试');
});

it('ignores a pending save after the account-owned review unmounts without moving new-session focus', async () => {
  const api = actions(capture({ action: 'save' })); let resolve!: () => void;
  vi.mocked(api.save).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  await act(() => button('保存密码').click());
  await act(() => root.render(createElement('button', { id: 'new-session' }, 'New session fixture')));
  const next = node.querySelector<HTMLButtonElement>('#new-session')!; next.focus();
  await act(() => resolve());
  expect(document.activeElement).toBe(next);
  expect(node.querySelector('[role="status"]')).toBeNull();
});
it('supplements an empty target username with exactly the value shown for explicit consent', async () => {
  const api = actions(capture({ action: 'save', username: 'alice', targets: [{ id: 'one', title: 'Example', username: '', updatedAt: 'v1' }] }));
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  const input = node.querySelector('input')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'bob'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await select('item:one');
  expect(node.textContent).toContain('同时补充账号：alice');
  await act(() => node.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(() => button('更新密码').click());
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));
});
it('does not silently approve a target that changed after the preview was displayed', async () => {
  const row = capture({ action: 'update', itemId: 'one', username: 'alice' }); const api = actions(row);
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 1 })));
  vi.mocked(api.list).mockResolvedValue([capture({ ...row, targets: [{ ...row.targets[0]!, updatedAt: 'version-2' }] })]);
  await act(() => root.render(createElement(BrowserCredentialReview, { actions: api, revision: 2 })));
  expect(button('更新密码').disabled).toBe(true);
  expect(node.textContent).toContain('条目已变化');
  await act(() => button('重新选择').click());
  await select('item:one'); await act(() => button('更新密码').click());
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ targetUpdatedAt: 'version-2' }));
});
it('loads only history metadata; revealing and restoring require separate clicks', async () => {
  const api = actions();
  await act(() => root.render(createElement(GeneratedPasswordHistory, { actions: api })));
  expect(api.history).toHaveBeenCalledOnce(); expect(api.revealHistory).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain('generated-secret');
  await act(() => button('显示').click()); expect(node.textContent).toContain('generated-secret');
  await act(() => button('隐藏').click()); expect(node.textContent).not.toContain('generated-secret');
  await act(() => button('恢复为条目').click());
  expect(api.recoverHistory).toHaveBeenCalledExactlyOnceWith('generated'); expect(api.save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(node.querySelector('[data-capture-id] h3'));
  expect(button('保存密码').disabled).toBe(true);
  await select('new'); await act(() => button('保存密码').click()); expect(api.save).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(button('恢复为条目'));
  expect(node.textContent).toContain('密码已保存。');
});

it('keeps generated-history recover failures retryable and focuses the title when its last row is deleted', async () => {
  const api = actions();
  vi.mocked(api.recoverHistory).mockRejectedValueOnce(new Error('Synthetic history failure'));
  await act(() => root.render(createElement(GeneratedPasswordHistory, { actions: api })));
  await act(() => button('恢复为条目').click());
  expect(document.activeElement).toBe(button('恢复为条目'));
  expect(node.querySelector('[role="alert"]')?.textContent).toBe('Synthetic history failure');
  await act(() => button('删除').click());
  expect(document.activeElement).toBe(node.querySelector('h2'));
  expect(node.textContent).toContain('已删除生成记录；剩余 0 条。');
});
