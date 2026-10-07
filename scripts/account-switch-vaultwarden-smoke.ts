#!/usr/bin/env bun
/** Real account switching across two local Vaultwarden backends; writes only to a disposable instance. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  concatBytes, deriveMasterKey, encryptBytes, hashMasterPassword, makeUserKey, stretchMasterKey, toBase64,
} from '../packages/crypto/src/index';
import { buildProfileItem, VaultClient, type UserProfile } from '../packages/vault/src/index';
import { createAccountSessions } from '../apps/desktop/src/application/account-sessions';
import { createApplicationClient } from '../apps/desktop/src/application/client';
import { createProfileCache } from '../apps/desktop/src/application/profile-cache';

const existingUrl = (process.env.VW_TEST_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const existingEmail = process.env.COFFER_TEST_EMAIL ?? 'coffer-test@example.com';
const existingPassword = process.env.COFFER_TEST_PASSWORD ?? 'Test-Master-Password-123!';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(existingUrl).hostname)) {
  throw Error('The existing test server must use a loopback address');
}
const directory = await mkdtemp(join(tmpdir(), 'coffer-account-switch-'));
const logPath = join(directory, 'vaultwarden.log');
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
const port = reserve.port; reserve.stop(true);
const isolatedUrl = `http://127.0.0.1:${port}`;
const passwordA = 'Isolated-Backend-A!42';
const passwordB = 'Isolated-Backend-B!42';
const secondEmail = `switch-${crypto.randomUUID()}@example.invalid`;
const targetExisting = { serverUrl: existingUrl, email: existingEmail };
const targetA = { serverUrl: isolatedUrl, email: existingEmail };
const targetB = { serverUrl: isolatedUrl, email: secondEmail };
const profileA: UserProfile = { displayName: 'Isolated backend · A', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC' };
const profileB: UserProfile = { displayName: 'Isolated backend · B', avatarDataUrl: null };
let checks = 0;
let rejectedExistingWrites = 0;
const authenticationCalls: string[] = [];
function check(ok: unknown, label: string) {
  if (!ok) throw Error(label);
  checks++; console.log(`PASS: ${label}`);
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const storage = new Map<string, string>();
const cache = createProfileCache({ get: async (k) => storage.get(k) ?? null,
  set: async (k, v) => { storage.set(k, v); }, remove: async (k) => { storage.delete(k); },
});
const clients = new Set<VaultClient>();
const sessions = createAccountSessions(() => {
  const client = new VaultClient({ deviceStore: { get: () => 'coffer-account-switch-smoke', set: () => {}, clear: () => {} },
  fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.origin === new URL(existingUrl).origin && method !== 'GET'
      && !(method === 'POST' && ['/identity/accounts/prelogin', '/identity/connect/token'].includes(url.pathname))) {
      rejectedExistingWrites++; throw Error('Refusing to mutate the existing test backend');
    }
    if (url.pathname === '/identity/connect/token') {
      const email = new URLSearchParams(String(init?.body)).get('username');
      authenticationCalls.push(JSON.stringify([url.origin, email]));
    }
    return fetch(input, init);
  },
  });
  clients.add(client); return client;
}, cache);
const vault = sessions.getActiveVault;
const app = createApplicationClient(sessions.service, {
  capabilities: { native: false, browser: false, saveAttachments: false },
  saveFile: async () => ({ path: null }),
});
let processHandle: ReturnType<typeof Bun.spawn> | undefined;

async function register(email: string, password: string): Promise<void> {
  const kdf = { kdf: 0 as const, iterations: 600_000 };
  const masterKey = await deriveMasterKey(password, email, kdf);
  const userKey = makeUserKey();
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
  const response = await fetch(`${isolatedUrl}/identity/accounts/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      email, name: 'Disposable switching test', masterPasswordHash: await hashMasterPassword(masterKey, password),
      masterPasswordHint: null,
      key: await encryptBytes(concatBytes(userKey.encKey, userKey.macKey), await stretchMasterKey(masterKey)),
      keys: { publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
        encryptedPrivateKey: await encryptBytes(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), userKey) },
      kdfType: kdf.kdf, kdfIterations: kdf.iterations, kdfMemory: null, kdfParallelism: null,
      emailVerificationToken: null, organizationUserId: null, orgInviteToken: null,
      acceptEmergencyAccessId: null, acceptEmergencyAccessInviteToken: null,
    }),
  });
  if (!response.ok) throw Error(`Disposable account registration failed: ${response.status} ${await response.text()}`);
}

async function select(target: typeof targetA, expectedProfile: UserProfile | null, label: string, unlocked = false) {
  const previous = vault();
  const oldKey = previous.getSession().getKey();
  const count = authenticationCalls.length;
  await app.switchAccount(target);
  const snapshot = app.getSnapshot();
  check(snapshot.status === (unlocked ? 'unlocked' : 'locked')
    && (unlocked || (snapshot.items.length === 0 && !snapshot.profileReady))
    && snapshot.account?.serverUrl === target.serverUrl && snapshot.account.email === target.email,
  `${label}: selected account is ${unlocked ? 'already unlocked' : 'locked with no records'}`);
  check(!oldKey || (previous.getSession().getKey() === oldKey
    && [...oldKey.encKey, ...oldKey.macKey].some((byte) => byte !== 0)), `${label}: previous unlocked session is retained in memory`);
  check(authenticationCalls.length === count, `${label}: selection sends no authentication request`);
  check(equal(snapshot.profile, expectedProfile), `${label}: presentation belongs only to the selected account`);
}

async function rejectPassword(password: string, label: string) {
  let rejected = false;
  const count = authenticationCalls.length;
  try { await app.unlock(password); } catch { rejected = true; }
  const snapshot = app.getSnapshot();
  check(rejected && snapshot.status === 'locked' && snapshot.items.length === 0 && vault().getSession().getKey() === null,
    `${label}: rejected credentials cannot reuse the previous session`);
  check(authenticationCalls.length === count + 1, `${label}: credentials are checked by the selected server`);
}

async function unlock(password: string, label: string) {
  const account = app.getSnapshot().account!;
  const count = authenticationCalls.length;
  await app.unlock(password);
  check(app.getSnapshot().status === 'unlocked' && app.getSnapshot().profileReady,
    `${label}: correct password authenticates and synchronizes`);
  check(authenticationCalls.length === count + 1
    && authenticationCalls.at(-1) === JSON.stringify([new URL(account.serverUrl).origin, account.email]),
  `${label}: unlock uses a new authentication for the selected server and email`);
}

async function seedPresentation(profile: UserProfile, noteName: string) {
  await app.saveProfile(profile, app.getSnapshot().profileVersion);
  return app.saveItem({ ...buildProfileItem({ displayName: '', avatarDataUrl: null }),
    name: noteName, notes: `Synthetic account-isolation record: ${noteName}`, customFields: [],
  });
}

try {
  processHandle = Bun.spawn({ cmd: [resolve('vendor/vaultwarden')], cwd: directory,
    env: { PATH: process.env.PATH ?? '', DATA_FOLDER: directory, DATABASE_URL: `sqlite://${join(directory, 'db.sqlite3')}`,
      ROCKET_ADDRESS: '127.0.0.1', ROCKET_PORT: String(port), DOMAIN: isolatedUrl,
      SIGNUPS_ALLOWED: 'true', SIGNUPS_VERIFY: 'false', WEB_VAULT_ENABLED: 'false', LOG_LEVEL: 'warn',
      I_REALLY_WANT_VOLATILE_STORAGE: 'true', LOGIN_RATELIMIT_SECONDS: '1', UNAUTHENTICATED_RATELIMIT_SECONDS: '1',
    }, stdout: Bun.file(logPath), stderr: Bun.file(`${logPath}.err`),
  });
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline && processHandle.exitCode === null) {
    try { ready = (await fetch(`${isolatedUrl}/api/config`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (ready) break;
    await Bun.sleep(100);
  }
  if (!ready) throw Error(`Disposable Vaultwarden did not start: ${(await readFile(logPath, 'utf8')).slice(-2000)}`);
  await register(existingEmail, passwordA); await register(secondEmail, passwordB);
  check(true, 'disposable backend has two independently registered accounts');

  await app.initialize();
  await app.connect({ ...targetExisting, masterPassword: existingPassword });
  check(app.getSnapshot().status === 'unlocked' && app.getSnapshot().profileReady, 'existing local account authenticates read-only');
  const original = app.getSnapshot();
  const originalRecords = JSON.stringify(original.items);
  const originalProfile = structuredClone(original.profile);

  await select(targetA, null, 'Same email / different backend');
  await rejectPassword('', 'Missing password');
  await rejectPassword(existingPassword, 'Password from the first backend');
  await unlock(passwordA, 'Disposable account A');
  check(app.getSnapshot().items.length === 0 && app.getSnapshot().profile === null, 'same-email account on second backend starts with an isolated vault');
  const noteA = await seedPresentation(profileA, 'Disposable A note');

  await select(targetB, null, 'Different email / same backend');
  await rejectPassword(passwordA, 'Password from account A');
  await unlock(passwordB, 'Disposable account B');
  check(app.getSnapshot().items.length === 0 && app.getSnapshot().profile === null, 'second email starts with an isolated vault');
  let crossAccountRead = false;
  try { await app.getItem(noteA.id); crossAccountRead = true; } catch { /* expected */ }
  check(!crossAccountRead, 'account B cannot retrieve account A record by ID');
  const noteB = await seedPresentation(profileB, 'Disposable B note');
  check(equal(await cache.load(targetA), profileA) && equal(await cache.load(targetB), profileB)
    && equal(await cache.load(targetExisting), originalProfile), 'presentation cache partitions both backend and email');

  await select(targetA, profileA, 'Return to disposable account A', true);
  check(equal(app.getSnapshot().profile, profileA) && app.getSnapshot().items.length === 1
    && app.getSnapshot().items[0]?.id === noteA.id, 'account A restores only its own server profile and record');
  await select(targetB, profileB, 'Return to disposable account B', true);
  check(equal(app.getSnapshot().profile, profileB) && app.getSnapshot().items.length === 1
    && app.getSnapshot().items[0]?.id === noteB.id, 'account B restores only its own server profile and record');

  const keyB = vault().getSession().getKey()!;
  await app.lock();
  check(vault().getSession().getKey() === null && [...keyB.encKey, ...keyB.macKey].every((byte) => byte === 0),
    'locking account B wipes its key');
  await select(targetA, profileA, 'A remains unlocked after B locks', true);
  await select(targetB, profileB, 'B requires reauthentication after lock');
  await rejectPassword(passwordA, 'Locked B rejects the other account password');
  await unlock(passwordB, 'Locked account B reauthentication');
  const loggedOutKeyB = vault().getSession().getKey()!;
  await app.logout();
  check(vault().getSession().getKey() === null && [...loggedOutKeyB.encKey, ...loggedOutKeyB.macKey].every((byte) => byte === 0)
    && await cache.load(targetB) === null && equal(await cache.load(targetA), profileA),
  'logout wipes only B key and profile cache');
  await select(targetA, profileA, 'A remains unlocked after B logs out', true);
  await select(targetB, null, 'Logged-out B returns locked');
  await unlock(passwordB, 'Logged-out account B reauthentication');

  const retainedB = vault(); const retainedKeyB = retainedB.getSession().getKey();
  await app.switchAccount(null);
  check(app.getSnapshot().status === 'loggedOut' && retainedB.getSession().getKey() === retainedKeyB,
    'Add Account parks B and selects a separate logged-out client');
  let failedAdd = false;
  try { await app.connect({ ...targetA, masterPassword: passwordB }); } catch { failedAdd = true; }
  check(failedAdd && app.getSnapshot().status === 'loggedOut' && retainedB.getSession().getKey() === retainedKeyB,
    'failed Add Account cannot overwrite an existing unlocked session');
  await select(targetB, profileB, 'Return from failed Add Account', true);

  await select(targetExisting, originalProfile, 'Return to existing backend', true);
  check(JSON.stringify(app.getSnapshot().items) === originalRecords && equal(app.getSnapshot().profile, originalProfile)
    && rejectedExistingWrites === 0, 'existing test vault is unchanged; no mutation was attempted');
  check(app.getSnapshot().unlockedAccounts?.length === 3, 'native snapshot reports all three retained unlocked identities');
  console.log(`${checks} real multi-account checks passed across two Vaultwarden backends; ${authenticationCalls.length} authentication requests`);
} finally {
  for (const client of clients) client.logout();
  app.dispose();
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill('SIGTERM');
    await Promise.race([processHandle.exited, Bun.sleep(5_000)]);
    if (processHandle.exitCode === null) { processHandle.kill('SIGKILL'); await processHandle.exited; }
  }
  await rm(directory, { recursive: true, force: true });
  console.log('Removed disposable Vaultwarden process and data directory');
}
