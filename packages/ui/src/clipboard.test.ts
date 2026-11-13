import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyWithAutoClear, installClipboardScheduler, CLIPBOARD_CLEAR_MS, setClipboardClearMs } from './clipboard';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); installClipboardScheduler(null); setClipboardClearMs(CLIPBOARD_CLEAR_MS); });

describe('clipboard lifecycle owner', () => {
  it('uses the duration chosen when copying, without extending an existing expiry', async () => {
    vi.useFakeTimers();
    let clipboard = '';
    vi.stubGlobal('navigator', { clipboard: {
      writeText: async (value: string) => { clipboard = value; }, readText: async () => clipboard,
    } });
    setClipboardClearMs(10_000);
    await copyWithAutoClear('synthetic');
    setClipboardClearMs(60_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(clipboard).toBe('synthetic');
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard).toBe('');
    await copyWithAutoClear('next synthetic');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(clipboard).toBe('next synthetic');
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard).toBe('');
  });

  it('delegates cleanup only after a successful clipboard write', async () => {
    const events: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (value: string) => { events.push(`write:${value}`); } } });
    installClipboardScheduler(async (value) => { events.push(`schedule:${value}`); });
    await copyWithAutoClear('secret');
    expect(events).toEqual(['write:secret', 'schedule:secret']);
  });
  it('does not schedule a failed copy', async () => {
    let scheduled = false;
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    installClipboardScheduler(() => { scheduled = true; });
    await expect(copyWithAutoClear('secret')).rejects.toThrow('denied');
    expect(scheduled).toBe(false);
  });
  it('preserves subsequently copied content in the local runtime', async () => {
    vi.useFakeTimers();
    let clipboard = '';
    vi.stubGlobal('navigator', { clipboard: {
      writeText: async (v: string) => { clipboard = v; }, readText: async () => clipboard,
    } });
    await copyWithAutoClear('secret');
    clipboard = 'my later text';
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard).toBe('my later text');
  });
});
