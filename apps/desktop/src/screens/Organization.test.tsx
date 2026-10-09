// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavDrawerProvider, summarise } from '@1warden/ui';
import type { OrganizationReport } from '@1warden/vault';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import { Organization } from './Organization';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; host?.remove(); });

const record = (id: string, name = `Fixture ${id}`) => ({ ...summarise({ ...blankEditorItem(), id, name }), username: 'fixture-user', iconDomain: 'fixture.example' });
const account = { serverUrl: 'https://fixture.invalid', email: 'fixture@example.invalid', userId: 'fixture-user', kdf: { kdf: 0 as const, iterations: 1 } };
const cleanReport = (over: Partial<OrganizationReport> = {}): OrganizationReport => ({ total: 1, checked: 1, skipped: 0,
  duplicates: [], missingUrls: [], missingUsernames: [], lowInformationNames: [], unfiled: [], ...over });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(method = vi.fn<() => Promise<OrganizationReport>>().mockResolvedValue(cleanReport()), over: Partial<ApplicationSnapshot> = {}) {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, revision: 1, status: 'unlocked', account, lastSyncedAt: 1,
    items: [record('a'), record('b')], ...over };
  const listeners = new Set<() => void>();
  const client = { organizationReport: method, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as ApplicationClient;
  return { client, method, emit: (over: Partial<ApplicationSnapshot>) => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, ...over }; for (const listener of listeners) listener();
  } };
}
async function mount(client: ApplicationClient, onEditItem = vi.fn<(id: string) => void | Promise<void>>()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const onBack = vi.fn();
  const render = async (editing = false) => { await act(async () => {
    root!.render(createElement(NavDrawerProvider, null, createElement(Organization, { client, onBack, onEditItem, editing })));
  }); };
  await render();
  return { render, onEditItem, onBack };
}
const button = (text: string) => [...host.querySelectorAll('button')].find(control => control.textContent === text)!;
const editButtons = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="编辑「"]')];
async function filter(value: string) {
  await act(() => { const select = host.querySelector('select')!; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('local organization report presentation', () => {
  it('shows loading, exposes a retryable scan error, and does not call mutating operations', async () => {
    const pending = deferred<OrganizationReport>();
    const fixtureClient = fixture(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(cleanReport({ missingUrls: ['a'] })));
    const { onBack } = await mount(fixtureClient.client);
    expect(host.textContent).toContain('正在分析当前已载入的条目');
    expect([...host.querySelectorAll('button')].some(control => control.textContent === '重新分析')).toBe(false);
    expect(host.querySelectorAll('[data-page-back]')).toHaveLength(1);
    await act(() => button('保险库').click());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('只在本地读取');
    await act(async () => pending.reject(new Error('Synthetic scan failure')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic scan failure');
    expect(host.textContent).not.toContain('没有条目');
    expect([...host.querySelectorAll('button')].filter(control => /分析/.test(control.textContent ?? ''))).toHaveLength(1);
    await act(async () => button('重试分析').click());
    expect(fixtureClient.method).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Fixture a');
    expect(button('重新分析').disabled).toBe(false);
  });

  it('distinguishes an empty loaded vault from incomplete sync and clean checked records', async () => {
    const fixtureClient = fixture(vi.fn().mockResolvedValue(cleanReport({ total: 0, checked: 0 })), { items: [] });
    await mount(fixtureClient.client);
    expect(host.textContent).toContain('当前已载入的保险库没有条目');
    await act(async () => fixtureClient.emit({ lastSyncedAt: null, syncError: 'Synthetic sync failure' }));
    expect(host.textContent).toContain('当前尚无可检查的已载入条目');
    expect(host.textContent).toContain('本页结果不代表服务器上的全部内容');
    fixtureClient.method.mockResolvedValue(cleanReport({ total: 2, checked: 1, skipped: 1 }));
    await act(async () => fixtureClient.emit({ syncError: null, lastSyncedAt: 2 }));
    expect(host.textContent).toContain('已检查的记录暂未发现整理线索');
    expect(host.textContent).toContain('未能检查的记录不在此结论范围内');
    expect(host.textContent).toContain('跳过 1 条');
  });

  it('filters all six categories and gives groups readable, nonsecret item context', async () => {
    const report = cleanReport({ total: 2, checked: 2,
      duplicates: [{ kind: 'identical', itemIds: ['a', 'b'], reason: 'checkedContentMatches' }],
      missingUrls: ['a'], missingUsernames: ['b'], lowInformationNames: ['a'], unfiled: ['b'] });
    await mount(fixture(vi.fn().mockResolvedValue(report), { items: [
      { ...record('a'), summary: 'Never render this opaque summary' }, record('b'),
    ] }).client);
    expect(host.querySelectorAll('select option')).toHaveLength(6);
    expect(host.textContent).toContain('第 1 组 · 2 条记录');
    expect(host.textContent).toContain('fixture-user');
    expect(host.textContent).toContain('fixture.example');
    expect(host.textContent).not.toContain('Never render this opaque summary');
    expect(editButtons()).toHaveLength(2);
    await filter('missingUrls');
    expect(host.textContent).toContain('Fixture a');
    expect(host.textContent).not.toContain('Fixture b');
    await filter('missingUsernames');
    expect(host.textContent).toContain('Fixture b');
    expect(host.textContent).not.toContain('Fixture a');
    await filter('similar');
    expect(host.textContent).toContain('这一类暂未发现整理线索');
  });

  it('bounds both ordinary lists and unusually large duplicate groups', async () => {
    const records = Array.from({ length: 25 }, (_, index) => record(String(index)));
    const report = cleanReport({ total: 25, checked: 25, unfiled: records.map(item => item.id),
      duplicates: [{ kind: 'similar', itemIds: records.map(item => item.id), reason: 'sameUsernameAndHost' }] });
    await mount(fixture(vi.fn().mockResolvedValue(report), { items: records }).client);
    expect(editButtons()).toHaveLength(20);
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="显示第 1 组更多条目"]')!.click());
    expect(editButtons()).toHaveLength(25);
    await filter('unfiled');
    expect(editButtons()).toHaveLength(20);
    await act(() => button('显示更多条目（还剩 5 条）').click());
    expect(editButtons()).toHaveLength(25);
    await filter('similar');
    await filter('unfiled');
    expect(editButtons()).toHaveLength(20);
  });

  it('paginates the number of duplicate groups independently of their members', async () => {
    const records = Array.from({ length: 42 }, (_, index) => record(String(index)));
    const duplicates: OrganizationReport['duplicates'] = Array.from({ length: 21 }, (_, index) => ({
      kind: 'identical', reason: 'checkedContentMatches', itemIds: [String(index * 2), String(index * 2 + 1)],
    }));
    await mount(fixture(vi.fn().mockResolvedValue(cleanReport({ total: 42, checked: 42, duplicates })), { items: records }).client);
    expect(editButtons()).toHaveLength(40);
    await act(() => button('显示更多分组（还剩 1 组）').click());
    expect(editButtons()).toHaveLength(42);
  });

  it('describes related-site clues without claiming every similar record shares one host', async () => {
    const report = cleanReport({ total: 3, checked: 3,
      duplicates: [{ kind: 'similar', reason: 'sameUsernameAndHost', itemIds: ['a', 'b', 'c'] }] });
    await mount(fixture(vi.fn().mockResolvedValue(report), { items: [record('a'),
      { ...record('b'), iconDomain: 'another.example' }, { ...record('c'), iconDomain: 'third.example' },
    ] }).client);
    expect(host.textContent).toContain('存在相同用户名和站点线索');
    expect(host.textContent).toContain('逐条人工核对');
    expect(host.textContent).not.toContain('用户名与主机相同的登录');
    expect(editButtons()).toHaveLength(3);
  });

  it('disables repeated edit requests until the opener resolves and exposes an edit error', async () => {
    const pending = deferred<void>();
    const onEdit = vi.fn().mockReturnValue(pending.promise);
    const { render } = await mount(fixture(vi.fn().mockResolvedValue(cleanReport({ unfiled: ['a', 'b'] }))).client, onEdit);
    await act(() => { editButtons()[0]!.click(); editButtons()[0]!.click(); });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('a');
    expect(editButtons().every(control => control.disabled)).toBe(true);
    await act(async () => pending.reject(new Error('Synthetic editor failure')));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Synthetic editor failure');
    expect(editButtons().every(control => !control.disabled)).toBe(true);
    await render(true);
    expect(editButtons().every(control => control.disabled)).toBe(true);
  });

  it('hides results immediately on locking and ignores the old pending scan', async () => {
    const pending = deferred<OrganizationReport>();
    const fixtureClient = fixture(vi.fn().mockReturnValue(pending.promise));
    await mount(fixtureClient.client);
    await act(async () => fixtureClient.emit({ status: 'locked', items: [] }));
    await act(async () => pending.resolve(cleanReport({ unfiled: ['a'] })));
    expect(host.textContent).toContain('过期结果已隐藏');
    expect(host.textContent).not.toContain('Fixture a');
    expect(host.querySelector('select')).toBeNull();
  });

  it('drops an old account response and reloads the current account even with the same revision', async () => {
    const old = deferred<OrganizationReport>();
    const next = deferred<OrganizationReport>();
    const fixtureClient = fixture(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise));
    await mount(fixtureClient.client);
    await act(async () => fixtureClient.emit({ revision: 1, account: { ...account, userId: 'next-user', email: 'next@example.invalid' }, items: [record('next')] }));
    await act(async () => old.resolve(cleanReport({ unfiled: ['a'] })));
    expect(host.textContent).not.toContain('Fixture a');
    expect(host.textContent).toContain('正在分析');
    await act(async () => next.resolve(cleanReport({ unfiled: ['next'] })));
    expect(host.textContent).toContain('Fixture next');
    expect(fixtureClient.method).toHaveBeenCalledTimes(2);
  });

  it('hides old findings during a revision refresh while retaining the selected category', async () => {
    const next = deferred<OrganizationReport>();
    const fixtureClient = fixture(vi.fn().mockResolvedValueOnce(cleanReport({ missingUrls: ['a'], unfiled: ['b'] })).mockReturnValueOnce(next.promise));
    await mount(fixtureClient.client);
    await filter('unfiled');
    await act(async () => fixtureClient.emit({}));
    expect(host.textContent).not.toContain('Fixture b');
    expect(host.textContent).toContain('正在分析');
    await act(async () => next.resolve(cleanReport({ missingUrls: ['a'], unfiled: ['a'] })));
    expect(host.querySelector('select')!.value).toBe('unfiled');
    expect(host.textContent).toContain('Fixture a');
    expect(host.textContent).not.toContain('Fixture b');
  });

  it('preserves a valid restored edit button focus and repairs it when a refreshed row disappears', async () => {
    const next = deferred<OrganizationReport>();
    const fixtureClient = fixture(vi.fn().mockResolvedValueOnce(cleanReport({ unfiled: ['a'] })).mockReturnValueOnce(next.promise));
    const { render } = await mount(fixtureClient.client);
    await render(true);
    await render(false);
    const opener = editButtons()[0]!;
    await act(() => opener.focus());
    await render(true);
    await render(false);
    expect(document.activeElement).toBe(opener);
    await render(true);
    await act(async () => fixtureClient.emit({ items: [] }));
    await render(false);
    expect(document.activeElement).toBe(host.querySelector('h1'));
    await act(async () => next.resolve(cleanReport({ total: 0, checked: 0 })));
    expect(document.activeElement).toBe(host.querySelector('h1'));
  });
});
