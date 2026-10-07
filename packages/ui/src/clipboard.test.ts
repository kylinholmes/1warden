import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyWithAutoClear, installClipboardScheduler, CLIPBOARD_CLEAR_MS } from './clipboard';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); installClipboardScheduler(null); });

describe('clipboard lifecycle owner', () => {
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
