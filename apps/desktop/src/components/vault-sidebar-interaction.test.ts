// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, type SidebarProps } from './VaultSidebar';

let root: Root;
let host: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => localStorage.clear());
afterEach(async () => { if (root) await act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(node: HTMLElement) { await act(() => node.click()); }
async function input(node: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const base: SidebarProps = {
  folders: [{ id: 'a', name: '旅行资料', nameFailed: false, updatedAt: '2026-10-09T00:00:00Z' }], category: { kind: 'folder', id: 'a' } as const,
  onSelect() {}, counts: { all: 1, favorites: 0 }, onLogout: async () => {}, onSwitchAccount: async () => {},
  account: 'person@example.test', profile: null, serverUrl: 'https://vault.example.test', onOpenSettings() {}, onOpenProfile() {},
  generatorOpen: false, onOpenGenerator() {}, syncing: false,
  typeCounts: [{ type: 'login', label: '登录', count: 1 }], showTypes: true,
  onCreateFolder: async (_name: string) => {}, onRenameFolder: async (_id: string, _name: string) => {}, onDeleteFolder: async (_id: string) => {},
};
async function mount(overrides: Partial<SidebarProps> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(createElement(Sidebar, { ...base, ...overrides })));
}

describe('vault sidebar folder interactions', () => {
  it('folds sections independently without changing the selection and expands folders for creation', async () => {
    let selections = 0;
    await mount({ onSelect() { selections++; } });
    await click(button('文件夹')); await click(button('类别'));
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('false');
    expect(button('类别').getAttribute('aria-expanded')).toBe('false');
    expect(selections).toBe(0);
    await click(button('新建文件夹'));
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('true');
    expect(button('类别').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[aria-label="新文件夹名"]')).not.toBeNull();
  });

  it('keeps a failed creation draft and blocks duplicate submissions while awaiting success', async () => {
    let attempts = 0;
    let finish: (() => void) | undefined;
    await mount({ onCreateFolder: async () => { attempts++; if (attempts === 1) throw new Error('网络未连接'); await new Promise<void>(resolve => { finish = resolve; }); } });
    await click(button('新建文件夹'));
    const field = document.querySelector<HTMLInputElement>('[aria-label="新文件夹名"]')!;
    await input(field, '  工作  ');
    await click(button('保存'));
    expect(field.value).toBe('  工作  ');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('网络未连接');
    const save = button('保存');
    await act(() => {
      const form = save.closest('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await click(save);
    expect(attempts).toBe(2);
    await act(async () => finish?.());
    expect(document.querySelector('[aria-label="新文件夹名"]')).toBeNull();
  });

  it('opens an accessible menu without selecting and restores focus after Escape', async () => {
    let selections = 0;
    await mount({ onSelect() { selections++; } });
    const trigger = button('文件夹操作：旅行资料');
    await click(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(selections).toBe(0);
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('names the folder in delete confirmation and preserves a failed dialog', async () => {
    let attempts = 0;
    await mount({ onDeleteFolder: async () => { attempts++; throw new Error('删除失败'); } });
    await click(button('文件夹操作：旅行资料')); await click(button('删除文件夹'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旅行资料');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('其中的条目会移至未分类，不会删除条目');
    await click(button('删除文件夹'));
    expect(attempts).toBe(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('删除失败');
  });

  it('saves a trimmed rename and keeps the draft when focus leaves the input', async () => {
    let renamed = '';
    await mount({ onRenameFolder: async (_id, name) => { renamed = name; } });
    await click(button('文件夹操作：旅行资料')); await click(button('重命名'));
    const field = document.querySelector<HTMLInputElement>('[aria-label="文件夹名"]')!;
    await input(field, '  报销  ');
    await act(() => field.blur());
    expect(document.querySelector('[aria-label="文件夹名"]')).toBe(field);
    await act(() => field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(renamed).toBe('报销');
    expect(document.querySelector('[aria-label="文件夹名"]')).toBeNull();
  });

  it('cancels with Escape and persists independent collapse preferences across mounts', async () => {
    await mount();
    await click(button('类别')); await click(button('新建文件夹'));
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[aria-label="新文件夹名"]')).toBeNull();
    expect(document.activeElement).toBe(button('新建文件夹'));
    await act(() => root.unmount()); root = createRoot(host);
    await act(() => root.render(createElement(Sidebar, base)));
    expect(button('类别').getAttribute('aria-expanded')).toBe('false');
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('true');
  });

  it('discards pending creation errors when the account changes', async () => {
    let reject: ((error: Error) => void) | undefined;
    await mount({ onCreateFolder: async () => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }) });
    await click(button('新建文件夹'));
    await input(document.querySelector<HTMLInputElement>('[aria-label="新文件夹名"]')!, '待保存');
    await click(button('保存'));
    await act(() => root.render(createElement(Sidebar, { ...base, account: 'next@example.test' })));
    await act(async () => reject?.(new Error('旧账户失败')));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="新文件夹名"]')).toBeNull();
  });

  it('keeps section controls working when local storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    await mount();
    await click(button('类别')); await click(button('文件夹'));
    expect(button('类别').getAttribute('aria-expanded')).toBe('false');
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('false');
    await click(button('新建文件夹'));
    expect(document.querySelector('[aria-label="新文件夹名"]')).not.toBeNull();
  });

  it('dismisses a menu when its folder disappears without navigating', async () => {
    let selections = 0;
    await mount({ onSelect() { selections++; } });
    await click(button('文件夹操作：旅行资料'));
    await act(() => root.render(createElement(Sidebar, { ...base, folders: [], onSelect() { selections++; } })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(selections).toBe(0);
  });
});
