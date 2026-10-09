// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutotypeAction } from './AutotypeAction';

// All native IPC is intercepted. These tests never focus another application or send keys.
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers();
  native.invoke.mockReset().mockImplementation(async command => command === 'autotype_status'
    ? { permission: 'granted', enabled: true, shortcut: 'test' } : undefined);
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  vi.clearAllTimers(); vi.useRealTimers();
});
function button(label: string) {
  const node = [...host!.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
async function mount(getPassword: () => Promise<string>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(createElement(AutotypeAction, { username: 'fixture-user', getPassword })));
}
async function advance(ms: number) { await act(() => vi.advanceTimersByTimeAsync(ms)); }
const calls = (command: string) => native.invoke.mock.calls.filter(([name]) => name === command);

describe('Autotype cancellation boundaries', () => {
  it.each(['button', 'Escape'])('cancels the countdown with %s before decrypting or minimizing', async mode => {
    const getPassword = vi.fn(async () => 'fixture-secret'); await mount(getPassword);
    await act(() => button('输入到其他应用…').click());
    expect(document.activeElement).toBe(button('取消发送'));
    await advance(1000);
    await act(() => {
      if (mode === 'button') button('取消发送').click();
      else document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await advance(10000);
    expect(getPassword).not.toHaveBeenCalled();
    expect(calls('main_minimize')).toHaveLength(0);
    expect(calls('autotype_type')).toHaveLength(0);
    expect(host!.textContent).toContain('已取消，未发送按键');
  });
  it('ignores decrypted credentials that arrive after cancellation', async () => {
    let resolve!: (password: string) => void;
    const getPassword = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    await mount(getPassword); await act(() => button('输入到其他应用…').click());
    await advance(3350);
    expect(calls('main_minimize')).toHaveLength(1);
    expect(getPassword).toHaveBeenCalledTimes(1);
    await act(() => button('取消发送').click());
    await act(() => resolve('fixture-secret'));
    await advance(10000);
    expect(calls('autotype_type')).toHaveLength(0);
    expect(host!.textContent).toContain('已取消，未发送按键');
  });
  it('prevents same-tick starts and sends exactly once after a successful countdown', async () => {
    const getPassword = vi.fn(async () => 'fixture-secret'); await mount(getPassword);
    const start = button('输入到其他应用…');
    await act(() => { start.click(); start.click(); });
    await advance(10000);
    expect(calls('main_minimize')).toHaveLength(1);
    expect(getPassword).toHaveBeenCalledTimes(1);
    expect(calls('autotype_type')).toEqual([['autotype_type', { username: 'fixture-user', password: 'fixture-secret', submit: false }]]);
    expect(host!.textContent).toContain('按键已发送。请在目标窗口确认结果。');
  });
  it('keeps a new countdown active when a cancelled request resolves late', async () => {
    let resolveOld!: (password: string) => void;
    const getPassword = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
      .mockResolvedValueOnce('new-fixture-secret');
    await mount(getPassword); await act(() => button('输入到其他应用…').click());
    await advance(3350); await act(() => button('取消发送').click());
    await act(() => button('输入到其他应用…').click());
    await act(() => resolveOld('stale-fixture-secret'));
    expect(button('取消发送')).toBeDefined();
    expect(calls('autotype_type')).toHaveLength(0);
    await advance(3350);
    expect(calls('autotype_type')).toEqual([['autotype_type', { username: 'fixture-user', password: 'new-fixture-secret', submit: false }]]);
  });
  it('does not send a pending decrypted password after the component unmounts', async () => {
    let resolve!: (password: string) => void;
    const getPassword = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    await mount(getPassword); await act(() => button('输入到其他应用…').click());
    await advance(3350);
    await act(() => root!.unmount()); root = undefined;
    await act(() => resolve('fixture-secret'));
    await advance(1000);
    expect(calls('autotype_type')).toHaveLength(0);
  });
  it('does not offer or claim cancellation after native dispatch has begun', async () => {
    let finish!: () => void;
    native.invoke.mockImplementation(async command => {
      if (command === 'autotype_status') return { permission: 'granted', enabled: true, shortcut: 'test' };
      if (command === 'autotype_type') await new Promise<void>(done => { finish = done; });
      return undefined;
    });
    await mount(async () => 'fixture-secret');
    await act(() => button('输入到其他应用…').click());
    await advance(3350);
    expect(calls('autotype_type')).toHaveLength(1);
    expect(host!.textContent).toContain('正在发送按键');
    expect([...host!.querySelectorAll('button')].some(node => node.textContent === '取消发送')).toBe(false);
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    expect(host!.textContent).not.toContain('已取消');
    await act(() => finish());
    expect(host!.textContent).toContain('按键已发送。请在目标窗口确认结果。');
  });
});
