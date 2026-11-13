import { useStoreSnapshot } from '@1warden/state/react';
import { getClipboardClearMs, subscribeClipboardClearMs } from './clipboard';

export function useClipboardClearMs(): number {
  return useStoreSnapshot(subscribeClipboardClearMs, getClipboardClearMs);
}
