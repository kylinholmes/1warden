/** Test-only registration against a loopback Vaultwarden with mail verification disabled.
 * 1.37.4 contract: https://github.com/dani-garcia/vaultwarden/blob/1.37.4/src/api/identity.rs
 * No fallback to removed endpoints: an incompatible server must fail visibly.
 */
import {
  concatBytes, deriveMasterKey, encryptBytes, hashMasterPassword, makeUserKey,
  stretchMasterKey, toBase64, zeroizeKey, type KdfConfig,
} from '../packages/crypto/src/index';

export function localVaultwardenUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw Error('Test Vaultwarden must be an HTTP(S) loopback URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export class RegistrationRejected extends Error {
  constructor(readonly phase: 'verification' | 'finish', readonly status: number) {
    super(`Local Vaultwarden registration ${phase} failed (HTTP ${status}); requires the 1.37.4 verification-token API, allowed signups, and disabled email verification`);
    this.name = 'RegistrationRejected';
  }
}

export interface RegistrationPayload {
  email: string;
  name: string;
  masterPasswordHash: string;
  key: string;
  keys: { publicKey: string; encryptedPrivateKey: string };
  kdfType: number;
  kdfIterations: number;
  kdfMemory: number | null;
  kdfParallelism: number | null;
}

/** Exported separately so protocol/transport failures can be tested without an expensive KDF. */
export async function submitLocalRegistration(
  serverUrl: string, payload: RegistrationPayload, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = localVaultwardenUrl(serverUrl);
  const post = (path: string, body: unknown) => fetchImpl(`${base}/identity/accounts/register/${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
  });
  const verification = await post('send-verification-email', { email: payload.email, name: payload.name });
  if (!verification.ok) throw new RegistrationRejected('verification', verification.status);
  if (verification.status === 204) {
    throw Error('Local Vaultwarden requires email verification; use a disposable server with SIGNUPS_VERIFY=false and no SMTP');
  }
  // 1.37.4 honors Accept: application/json. Older token responses can be plain
  // text; both representations must contain a JWT, never an empty success body.
  const rawToken = (await verification.text()).trim();
  let token: unknown = rawToken;
  try { token = JSON.parse(rawToken); } catch { /* explicit plain-text token representation */ }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw Error('Local Vaultwarden returned no usable registration token; response is not logged because it may contain credentials');
  }
  const finished = await post('finish', {
    ...payload, emailVerificationToken: token, masterPasswordHint: null,
    organizationUserId: null, orgInviteToken: null,
    acceptEmergencyAccessId: null, acceptEmergencyAccessInviteToken: null,
  });
  if (!finished.ok) throw new RegistrationRejected('finish', finished.status);
}

export async function registerLocalVaultwardenAccount({
  serverUrl, email, password, name = '1Warden disposable test',
  kdf = { kdf: 0, iterations: 600_000 }, fetchImpl = fetch,
}: {
  serverUrl: string; email: string; password: string; name?: string;
  kdf?: KdfConfig; fetchImpl?: typeof fetch;
}): Promise<void> {
  localVaultwardenUrl(serverUrl); // Refuse nonlocal targets before deriving credentials.
  email = email.trim().toLowerCase();
  const masterKey = await deriveMasterKey(password, email, kdf);
  const stretched = await stretchMasterKey(masterKey);
  const userKey = makeUserKey();
  let privateDer: Uint8Array | undefined;
  let userBytes: Uint8Array | undefined;
  try {
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
    privateDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    userBytes = concatBytes(userKey.encKey, userKey.macKey);
    await submitLocalRegistration(serverUrl, {
      email, name, masterPasswordHash: await hashMasterPassword(masterKey, password),
      key: await encryptBytes(userBytes, stretched),
      keys: { publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
        encryptedPrivateKey: await encryptBytes(privateDer, userKey) },
      kdfType: kdf.kdf, kdfIterations: kdf.iterations,
      kdfMemory: kdf.kdf === 1 ? kdf.memory : null,
      kdfParallelism: kdf.kdf === 1 ? kdf.parallelism : null,
    }, fetchImpl);
  } finally {
    masterKey.fill(0); zeroizeKey(stretched); zeroizeKey(userKey);
    privateDer?.fill(0); userBytes?.fill(0);
  }
}
