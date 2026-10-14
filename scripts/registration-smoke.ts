#!/usr/bin/env bun
/** Registration + login against the already deployed local Vaultwarden; no service reconfiguration.
 * Run: NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/registration-smoke.ts
 * TLS relaxation is only for the development server's self-signed certificate.
 * A unique, empty synthetic account is retained; existing accounts are never accessed.
 */
import { beginRegistration, finishRegistration, HttpClient } from '../packages/api/src/index';
import { createRegistrationKeys } from '../apps/desktop/src/screens/registration-keys';
import { VaultClient } from '../packages/vault/src/index';
import { localVaultwardenUrl } from './vaultwarden-registration';

const serverUrl = localVaultwardenUrl(process.env.VW_TEST_URL ?? 'https://localhost:8443');
const request: typeof fetch = (input, init) => {
  if (new URL(input instanceof Request ? input.url : String(input)).origin !== new URL(serverUrl).origin) throw Error('Nonlocal test request rejected');
  const headers = new Headers(init?.headers);
  // Isolate this loopback-only test's rate-limit bucket from the running app.
  headers.set('X-Real-IP', '127.0.0.43');
  return fetch(input, { ...init, headers, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) });
};
const vault = new VaultClient({ fetchImpl: request, deviceStore: { get: () => 'registration-smoke', set() {}, clear() {} } });
let phase = 'server health';
try {
  const config = await request(`${serverUrl}/api/config`);
  if (!config.ok || (await config.json() as { server?: { name?: string } }).server?.name !== 'Vaultwarden') throw Error('Local Vaultwarden is unavailable');
  const email = `registration-${crypto.randomUUID()}@example.invalid`;
  const password = `Disposable-${crypto.randomUUID()}!Aa42`;
  const http = new HttpClient({ baseUrl: serverUrl, fetchImpl: request });
  phase = 'registration start';
  const step = await beginRegistration(http, { email, name: 'Registration smoke' });
  if (step.kind !== 'setPassword') throw Error('This smoke requires disabled email verification');
  phase = 'registration finish';
  const keys = await createRegistrationKeys(email, password);
  await finishRegistration(http, { ...keys, email, emailVerificationToken: step.token, masterPasswordHint: null });
  console.log('PASS: production registration API and local key generation create an account');
  phase = 'login and sync';
  await vault.connect({ serverUrl, email, masterPassword: password });
  if (!vault.isUnlocked() || !vault.hasVerifiedSync() || vault.getSession().items.length !== 0) throw Error('New account did not produce an empty verified vault');
  console.log('PASS: existing VaultClient logs in, decrypts the new account keys, and completes sync');
} catch (error) {
  const status = (error as { status?: number })?.status;
  const kind = (error as { kind?: string })?.kind;
  console.error(`FAIL: local registration smoke during ${phase} (kind=${kind ?? 'unknown'}, HTTP=${status ?? 'none'}); credential-bearing details omitted`);
  process.exitCode = 1;
} finally {
  vault.logout();
}
