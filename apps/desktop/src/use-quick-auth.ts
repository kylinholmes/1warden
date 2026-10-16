import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createQuickAuthCoordinator } from './quick-auth-coordinator';
import type { QuickAuthCancellation, QuickAuthKey, QuickAuthRequest } from './quick-auth';

export type QuickAuthOptions = Omit<Parameters<typeof createQuickAuthCoordinator>[0], 'isCurrent' | 'reply'>;

export function useQuickAuth(options: QuickAuthOptions): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const coordinator = createQuickAuthCoordinator({ ...options,
      isCurrent: key => invoke<boolean>('quick_auth_is_current', { key: { generation: key.generation, requestId: key.requestId } }),
      reply: result => invoke<boolean>('quick_auth_complete', { result }),
    });
    const remember = (off: () => void) => { if (disposed) off(); else unlisteners.push(off); };
    void listen<QuickAuthKey>('1warden:quick-auth-request', event => {
      // Only main can consume this mailbox. The event contains IDs, no input.
      void invoke<QuickAuthRequest | null>('quick_auth_take', { key: event.payload }).then(request => {
        if (!disposed && request) return coordinator.request(request);
      }).catch(() => {});
    }).then(remember);
    void listen<QuickAuthCancellation>('1warden:quick-auth-cancelled', event => coordinator.cancel(event.payload)).then(remember);
    return () => { disposed = true; coordinator.dispose(); for (const off of unlisteners) off(); };
  }, [options]);
}
