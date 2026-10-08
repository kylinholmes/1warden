import type { AccountInfo, ConnectParams } from '@1warden/vault';
export type AccountTarget = Pick<ConnectParams, 'serverUrl' | 'email'>;

export function accountKey(target: AccountTarget): string {
  const account = lockedAccount(target);
  return JSON.stringify([account.serverUrl, account.email]);
}

/** A selected identity is locked; unlock always asks the server for its actual KDF/key/user ID. */
export function lockedAccount(target: AccountTarget): AccountInfo {
  if (!target || typeof target.email !== 'string' || typeof target.serverUrl !== 'string') throw new Error('账户信息无效');
  const email = target.email.trim().toLowerCase();
  let url: URL;
  try { url = new URL(target.serverUrl.trim()); } catch { throw new Error('服务器地址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !email || !email.includes('@') || /\s/.test(email)) throw new Error('账户信息无效');
  url.hash = ''; url.search = '';
  return { serverUrl: url.href.replace(/\/$/, ''), email, userId: '', kdf: { kdf: 0, iterations: 600_000 } };
}
