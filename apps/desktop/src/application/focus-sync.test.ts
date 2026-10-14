// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { subscribeFocusSync } from './focus-sync';
import { createApplicationClient } from './client';
import { EMPTY_SNAPSHOT, type ApplicationService } from './types';

let stop: (() => void) | undefined;
afterEach(() => stop?.());

it('syncs on each window focus, without blocking or surfacing an unhandled rejection', async () => {
  let unlocked = false;
  const sync = vi.fn().mockRejectedValue(new Error('offline'));
  stop = subscribeFocusSync({ getSnapshot: () => ({ status: unlocked ? 'unlocked' : 'locked' }), sync }, window);
  window.dispatchEvent(new Event('focus'));
  expect(sync).not.toHaveBeenCalled();
  unlocked = true;
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(sync).toHaveBeenCalledTimes(2);
  stop();
  window.dispatchEvent(new Event('focus'));
  expect(sync).toHaveBeenCalledTimes(2);
});

it('registers focus sync once across repeated initialization and removes it on disposal', async () => {
  const sync = vi.fn().mockResolvedValue(undefined);
  const client = createApplicationClient({ sync, snapshot: async () => ({ ...EMPTY_SNAPSHOT, status: 'unlocked' }) } as unknown as ApplicationService,
    { capabilities: { native: false, browser: false, saveAttachments: false }, saveFile: async () => ({ path: null }) });
  await client.initialize(); await client.initialize();
  try {
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(sync).toHaveBeenCalledOnce();
  } finally { client.dispose(); }
  window.dispatchEvent(new Event('focus'));
  expect(sync).toHaveBeenCalledOnce();
});
