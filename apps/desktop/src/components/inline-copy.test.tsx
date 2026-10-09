// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretField } from '@1warden/ui';
import { emptyLogin } from '@1warden/vault';
import { ItemDetail } from '../screens/VaultView';
import { itemDetail } from '../application/service';
import { EMPTY_SNAPSHOT, type ApplicationClient } from '../application/types';
import { blankEditorItem } from '../../../../packages/ui/src/item-editor-fields';
import { installClipboardScheduler, installNativeClipboardCopy } from '../../../../packages/ui/src/clipboard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const write = vi.fn<(value: string) => Promise<void>>();
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  write.mockReset().mockResolvedValue(undefined); installNativeClipboardCopy(write);
});
afterEach(async () => {
  await act(() => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
  installNativeClipboardCopy(null); installClipboardScheduler(null); vi.restoreAllMocks();
});
async function mount(node: ReactNode) { await act(() => root.render(node)); }
function field() {
  const node = host.querySelector<HTMLButtonElement>('[data-field-copy]');
  expect(node, 'field content must be the copy target').not.toBeNull();
  return node!;
}

describe('inline field copying', () => {
  it('copies by clicking the value, with a named keyboard-accessible target and inline feedback', async () => {
    await mount(<SecretField label="用户名" value="synthetic@example.invalid" />);
    expect(field().tagName).toBe('BUTTON'); expect(field().type).toBe('button');
    expect(field().getAttribute('aria-label')).toBe('复制用户名');
    const description = field().getAttribute('aria-describedby');
    expect(description).not.toBeNull();
    expect(document.getElementById(description!)?.textContent).toContain('synthetic@example.invalid');
    expect(host.querySelector('[aria-label="复制"]')).toBeNull();
    expect(write).not.toHaveBeenCalled();
    await act(() => host.querySelector<HTMLElement>('[data-field-value]')!.click());
    expect(write).toHaveBeenCalledExactlyOnceWith('synthetic@example.invalid');
    expect(field().querySelector('[role="status"]')?.textContent).toBe('已复制');
  });
  it('fetches secrets only on click, copies the real value and leaves it masked', async () => {
    const getValue = vi.fn(async () => 'synthetic-secret'), reveal = vi.fn(async () => 'revealed-secret');
    await mount(<SecretField label="密码" value="********" masked getValue={getValue} revealValue={reveal} />);
    expect(getValue).not.toHaveBeenCalled();
    await act(() => field().click());
    expect(getValue).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledExactlyOnceWith('synthetic-secret');
    expect(reveal).not.toHaveBeenCalled(); expect(host.innerHTML).not.toContain('synthetic-secret');
    expect(host.querySelector('[data-field-value]')?.textContent).toBe('••••••••');
  });
  it('keeps reveal/hide outside the copy target', async () => {
    const reveal = vi.fn(async () => 'revealed-secret');
    await mount(<SecretField label="密码" value="********" masked revealValue={reveal} />);
    expect(field().querySelector('button')).toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="显示"]')!.click());
    expect(host.textContent).toContain('revealed-secret');
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="隐藏"]')!.click());
    expect(host.textContent).not.toContain('revealed-secret'); expect(write).not.toHaveBeenCalled();
  });
  it('keeps the existing platform cleanup callback and runs it only after a successful write', async () => {
    installNativeClipboardCopy(null);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    const cleanup = vi.fn(async () => {}); installClipboardScheduler(cleanup);
    write.mockRejectedValueOnce(Error('denied')).mockResolvedValueOnce(undefined);
    await mount(<SecretField label="网址" value="https://example.invalid" />);
    await act(() => field().click());
    expect(cleanup).not.toHaveBeenCalled(); expect(field().dataset.state).not.toBe('ok');
    expect(field().textContent).toContain('复制失败');
    await act(() => field().click());
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('https://example.invalid');
    expect(field().textContent).not.toContain('复制失败'); expect(field().dataset.state).toBe('ok');
  });
  it('prevents duplicate pending reads and reports a failed read without writing placeholders', async () => {
    let reject!: (error: Error) => void;
    const getValue = vi.fn(() => new Promise<string>((_, fail) => { reject = fail; }));
    const onError = vi.fn();
    await mount(<SecretField label="密码" value="********" masked getValue={getValue} onCopyError={onError} />);
    await act(() => { field().click(); field().click(); });
    expect(getValue).toHaveBeenCalledTimes(1); expect(field().getAttribute('aria-busy')).toBe('true');
    await act(() => reject(Error('locked')));
    expect(write).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1);
    expect(field().textContent).toContain('复制失败');
  });
  it('lets a user select part of a long field without overwriting the clipboard', async () => {
    await mount(<SecretField label="地址" value="A long address for selection" />);
    const value = host.querySelector('[data-field-value]')!;
    const range = document.createRange(); range.selectNodeContents(value);
    window.getSelection()!.addRange(range);
    await act(() => field().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    expect(write).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
    await act(() => field().click()); expect(write).toHaveBeenCalledTimes(1);
  });
  it('copies an unformatted OTP and record ID directly from their content', async () => {
    const item = itemDetail({ ...blankEditorItem(), id: 'synthetic-record-id',
      login: { ...emptyLogin(), totp: 'synthetic-seed' } });
    const client = { capabilities: { native: false, browser: true, saveAttachments: true },
      getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {},
      totp: vi.fn(async () => ({ code: '123456', remaining: 20, period: 30 })),
    } as unknown as ApplicationClient;
    await mount(<ItemDetail client={client} item={item} icons={null} onBack={() => {}}
      onEdit={() => {}} onDelete={() => {}} onToggleFavorite={() => {}} />);
    const otp = host.querySelector<HTMLButtonElement>('[aria-label="复制验证码"]')!;
    expect(otp.querySelector('[data-field-value]')?.textContent).toBe('123 456');
    await act(() => otp.querySelector<HTMLElement>('[data-field-value]')!.click());
    expect(write).toHaveBeenLastCalledWith('123456');
    expect(host.querySelector('[role="timer"]')).not.toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="复制记录 ID"]')!.click());
    expect(write).toHaveBeenLastCalledWith('synthetic-record-id');
  });
});
