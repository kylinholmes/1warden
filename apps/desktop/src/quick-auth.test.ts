import { beforeEach, expect, it, vi } from 'vitest';
import { cancelQuickAuth, onQuickAuthCancelled, onQuickAuthResult, requestQuickAuth } from './quick-auth';

const harness = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: harness.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
  harness.handlers.set(name, handler); return () => harness.handlers.delete(name);
} }));
beforeEach(() => { harness.invoke.mockClear(); harness.handlers.clear(); });

it('sends credentials only through the one-shot native command and cancellation only includes generation', async () => {
  const request = { generation: 2, requestId: 3, accountId: 'account', action: 'password' as const, password: 'secret' };
  await requestQuickAuth(request); await cancelQuickAuth(2);
  expect(harness.invoke.mock.calls).toEqual([
    ['quick_auth_request', { request }], ['quick_auth_cancel', { generation: 2 }],
  ]);
});
it('receives projected authentication and native cancellation results and removes listeners', async () => {
  const results = vi.fn(); const cancelled = vi.fn();
  const offResults = await onQuickAuthResult(results); const offCancelled = await onQuickAuthCancelled(cancelled);
  const result = { generation: 2, requestId: 3, accountId: 'account', stage: 'twoFactor', providers: [0] };
  const cancellation = { generation: 2, requestId: 3, unlocked: false };
  harness.handlers.get('1warden:quick-auth-result')!({ payload: result });
  harness.handlers.get('1warden:quick-auth-cancelled')!({ payload: cancellation });
  expect(results).toHaveBeenCalledWith(result); expect(cancelled).toHaveBeenCalledWith(cancellation);
  offResults(); offCancelled(); expect(harness.handlers.size).toBe(0);
});
