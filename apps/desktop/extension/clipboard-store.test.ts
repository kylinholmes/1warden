import { describe, expect, it } from 'vitest';
import { createClipboardStore } from './clipboard-store';
import type { StorageArea } from './session-store';

function fixture() {
  const data: Record<string, unknown> = {};
  let now = 1_000;
  let text = 'secret';
  const deadlines: number[] = [];
  const area = {
    async get(key: string) { return { [key]: structuredClone(data[key]) }; },
    async set(items: Record<string, unknown>) { Object.assign(data, structuredClone(items)); },
    async remove(key: string) { delete data[key]; },
  } as StorageArea;
  const options = { area, now: () => now, schedule: async (deadline: number) => { deadlines.push(deadline); },
    clipboard: { readText: async () => text, writeText: async (value: string) => { text = value; } } };
  return { store: createClipboardStore(options), restart: () => createClipboardStore(options), deadlines,
    setNow: (value: number) => { now = value; }, setText: (value: string) => { text = value; }, text: () => text, data };
}

describe('clipboard deadline outside the popup', () => {
  it('restores the deadline after a background restart and clears the copied value', async () => {
    const f = fixture();
    await f.store.schedule('secret');
    f.setNow(20_000);
    await f.restart().resume();
    expect(f.deadlines).toEqual([31_000, 31_000]);
    expect(f.text()).toBe('secret');
    f.setNow(31_000);
    await f.restart().resume();
    expect(f.text()).toBe('');
    expect(f.data).toEqual({});
  });

  it('preserves a later clipboard value and replaces an earlier deadline on copy', async () => {
    const f = fixture();
    await f.store.schedule('old');
    f.setNow(10_000);
    await f.store.schedule('secret');
    f.setNow(31_000);
    await f.store.resume();
    expect(f.text()).toBe('secret');
    f.setText('user copied this');
    f.setNow(40_000);
    await f.store.resume();
    expect(f.text()).toBe('user copied this');
    expect(f.data).toEqual({});
  });
});
