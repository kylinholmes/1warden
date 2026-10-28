// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavDrawerProvider, type ReportBrief } from '@1warden/ui';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from '../application/types';
import { SecurityReportView } from './SecurityReport';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; host?.remove(); });
const account = { serverUrl: 'https://fixture.invalid', email: 'fixture@example.invalid', userId: 'fixture', kdf: { kdf: 0 as const, iterations: 1 } };
const clean = (): ReportBrief => ({ total: 10, score: 100, grade: 'excellent', breached: [], weak: [], reused: [], unsecured: [], expiring: [] });
const breached = (): ReportBrief => ({ ...clean(), score: 70, grade: 'fair', breached: [{ itemId: 'a', count: 42 }] });
const findings = (): ReportBrief => ({ ...breached(), weak: [{ itemId: 'b', reason: 'tooShort' }],
  reused: [{ itemIds: ['c', 'd'], count: 2 }], unsecured: [{ id: 'e', name: 'Fixture e', uris: ['http://fixture.invalid'] }],
  expiring: [{ itemId: 'f', expiresAt: '2026-11-30' }],
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, revision: 1, status: 'unlocked', account,
    items: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: `Fixture ${id}` } as ApplicationSnapshot['items'][number])) };
  const listeners = new Set<() => void>();
  const securityReport = vi.fn<() => Promise<ReportBrief>>().mockResolvedValue(clean());
  const checkBreaches = vi.fn<() => Promise<ReportBrief>>().mockResolvedValue(breached());
  const client = { getSnapshot: () => snapshot, securityReport, checkBreaches,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as ApplicationClient;
  return { client, securityReport, checkBreaches, emit: (over: Partial<ApplicationSnapshot>) => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, ...over }; for (const listener of listeners) listener();
  } };
}
async function mount(client: ApplicationClient) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(NavDrawerProvider, null, createElement(SecurityReportView, {
    client, renderItem: (id, onBack) => createElement('article', null, `Detail ${id}`,
      createElement('button', { onClick: onBack }, '返回安全报告')),
  }))));
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!;
const score = () => host.querySelector('[aria-label^="安全评分"]')?.getAttribute('aria-label');

describe('security report flow', () => {
  it('retries report generation, keeps opt-in explicit and updates score, grade, summary, findings together', async () => {
    const f = fixture(); const pending = deferred<ReportBrief>();
    f.securityReport.mockReturnValueOnce(pending.promise); await mount(f.client);
    expect(host.textContent).toContain('正在检查'); expect(f.checkBreaches).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error('Synthetic scan failure')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic scan failure');
    await act(async () => button('重试').click());
    expect(score()).toBe('安全评分 100 分，满分 100 分');
    expect(host.textContent).toContain('泄露查询尚未完成');
    expect(host.querySelector('main[aria-label="安全报告"]')).not.toBeNull();
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.textContent).toContain('SHA-1 哈希前 5 个字符');
    expect(f.checkBreaches).not.toHaveBeenCalled();
    await act(async () => button('开启检查').click());
    expect(score()).toBe('安全评分 70 分，满分 100 分');
    expect(host.textContent).toContain('一般');
    expect(host.textContent).toContain('1 条已泄露');
    expect(host.textContent).toContain('出现过 42 次');
    expect(host.textContent).not.toContain('泄露查询尚未完成');
  });

  it('shows checking/failure/retry without claiming a completed clean result', async () => {
    const f = fixture(); const pending = deferred<ReportBrief>(); f.checkBreaches.mockReturnValueOnce(pending.promise);
    await mount(f.client); await act(() => { button('开启检查').click(); button('开启检查').click(); });
    expect(button('查询中…').disabled).toBe(true);
    expect(f.checkBreaches).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error('Synthetic offline')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('查询未完成');
    expect(host.textContent).toContain('未检查');
    expect(host.textContent).not.toContain('没有发现已泄露的密码');
    expect(host.textContent).toContain('没有弱密码');
    await act(async () => button('重试检查').click());
    expect(score()).toContain('70'); expect(f.checkBreaches).toHaveBeenCalledTimes(2);
  });

  it('opens every finding, expands reused groups, and preserves report DOM, scroll, focus and checked state on back', async () => {
    const f = fixture(); f.checkBreaches.mockResolvedValue(findings()); await mount(f.client);
    await act(async () => button('开启检查').click());
    expect(host.querySelectorAll('main')).toHaveLength(1);
    const headings = [...host.querySelectorAll('h1, h2, h3')];
    expect(headings[0]?.tagName).toBe('H1');
    expect(headings[0]?.textContent).toBe('安全报告');
    expect(headings.slice(1)).toHaveLength(5);
    expect(headings.slice(1).every(heading => heading.tagName === 'H2')).toBe(true);
    const scroll = host.querySelector<HTMLElement>('[data-security-report-scroll]')!; scroll.scrollTop = 430;
    const group = host.querySelector<HTMLDetailsElement>('details')!;
    await act(() => group.querySelector('summary')!.click()); expect(group.open).toBe(true);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const opener = host.querySelector<HTMLButtonElement>(`button[aria-label='查看「Fixture ${id}」']`)!;
      opener.focus(); await act(() => opener.click());
      expect(host.textContent).toContain(`Detail ${id}`);
      expect(scroll.closest('[hidden]')).not.toBeNull();
      expect(document.activeElement?.hasAttribute('data-selectable')).toBe(true);
      await act(() => button('返回安全报告').click());
      expect(host.querySelector('[data-security-report-scroll]')).toBe(scroll);
      expect(scroll.scrollTop).toBe(430); expect(group.open).toBe(true);
      expect(document.activeElement).toBe(opener);
      expect(score()).toContain('70');
    }
    expect(f.checkBreaches).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit consent across same-account refresh and rejects a late revision result', async () => {
    const f = fixture(); const pending = deferred<ReportBrief>(); f.checkBreaches.mockReturnValueOnce(pending.promise);
    await mount(f.client); await act(() => button('开启检查').click());
    await act(async () => f.emit({}));
    expect(f.checkBreaches).toHaveBeenCalledTimes(2); expect(score()).toContain('70');
    await act(async () => pending.resolve({ ...breached(), score: 1, grade: 'critical' }));
    expect(score()).toContain('70');
  });

  it('clears account consent and findings and rejects late responses even when the account reuses a revision', async () => {
    const f = fixture(); const pending = deferred<ReportBrief>(); f.checkBreaches.mockReturnValueOnce(pending.promise);
    await mount(f.client); await act(() => button('开启检查').click());
    await act(async () => f.emit({ revision: 1, account: { ...account, email: 'other@example.invalid', userId: 'other' } }));
    expect(score()).toContain('100'); expect(button('开启检查')).toBeTruthy();
    expect(f.checkBreaches).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(breached()));
    expect(score()).toContain('100'); expect(host.textContent).not.toContain('出现过 42 次');
  });

  it('hides a pending report on lock and ignores its late completion', async () => {
    const f = fixture(); const pending = deferred<ReportBrief>(); f.securityReport.mockReturnValueOnce(pending.promise);
    await mount(f.client);
    await act(async () => f.emit({ status: 'locked', items: [] }));
    await act(async () => pending.resolve(findings()));
    expect(score()).toBeUndefined();
    expect(host.textContent).not.toContain('Fixture');
    expect(f.checkBreaches).not.toHaveBeenCalled();
  });
});
