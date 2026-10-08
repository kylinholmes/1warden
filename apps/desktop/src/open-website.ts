import { invoke } from '@tauri-apps/api/core';
import { tauriAvailable } from './capabilities';

/** An explicit user action; never open vault URLs inside the application. */
export async function openWebsite(value: string): Promise<void> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('只能打开不含登录凭据的 HTTP 或 HTTPS 网址');
  }
  if (tauriAvailable()) await invoke('open_website', { url: url.href });
  else window.open(url.href, '_blank', 'noopener,noreferrer');
}
