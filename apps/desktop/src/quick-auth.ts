import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface QuickAuthKey { generation: number; requestId: number }
export interface QuickAuthCancellation extends QuickAuthKey { unlocked?: boolean; expired?: boolean }
export interface QuickAuthRequest extends QuickAuthKey {
  accountId: string;
  action: 'select' | 'password' | 'twoFactor';
  password?: string;
  code?: string;
  provider?: number;
  remember?: boolean;
}
export interface QuickAuthResult extends QuickAuthKey {
  accountId: string;
  stage: 'password' | 'twoFactor' | 'unlocked';
  providers?: number[];
  error?: string;
}

/** Credentials enter a caller-checked, one-shot native mailbox, never an event. */
export function requestQuickAuth(request: QuickAuthRequest): Promise<void> {
  return invoke('quick_auth_request', { request });
}
export function cancelQuickAuth(generation: number): Promise<void> {
  return invoke('quick_auth_cancel', { generation });
}
export function onQuickAuthResult(listener: (result: QuickAuthResult) => void): Promise<UnlistenFn> {
  return listen<QuickAuthResult>('1warden:quick-auth-result', event => listener(event.payload));
}
/** Native hide/blur/expiry also clears a pinned quick window's form. */
export function onQuickAuthCancelled(listener: (key: QuickAuthCancellation) => void): Promise<UnlistenFn> {
  return listen<QuickAuthCancellation>('1warden:quick-auth-cancelled', event => listener(event.payload));
}
