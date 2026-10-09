#!/usr/bin/env bun
/** Real protocol smoke. New synthetic account; memory-only clients; loopback only.
 * Run: VW_TEST_URL=http://127.0.0.1:18083 bun run test:vaultwarden
 * Requires Vaultwarden 1.37.4, SIGNUPS_ALLOWED=true, SIGNUPS_VERIFY=false, no SMTP.
 * The CI service/container is disposable. Local runs leave only the unique empty
 * test account; record cleanup uses exclusively the IDs created by this run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VaultClient, emptyLogin, type VaultItem } from '../packages/vault/src/index';
import { localVaultwardenUrl, registerLocalVaultwardenAccount } from './vaultwarden-registration';

const serverUrl = localVaultwardenUrl(process.env.VW_TEST_URL ?? 'http://127.0.0.1:18083');
const runId = crypto.randomUUID();
const email = `ci-${runId}@example.invalid`;
const masterPassword = `Disposable-${crypto.randomUUID()}!Aa42`;
const checks: string[] = [];
const createdIds: string[] = [];
const clients: VaultClient[] = [];
let failed = false;
let phase = 'health';
let serverVersion: unknown;
const check = (ok: unknown, label: string) => {
  if (!ok) throw Error(label);
  checks.push(label); console.log(`PASS: ${label}`);
};
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== new URL(serverUrl).origin) throw Error('Refusing a request outside the isolated test server');
  return fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) });
};
function newClient() {
  const id = crypto.randomUUID();
  const client = new VaultClient({ fetchImpl: localFetch,
    deviceStore: { get: () => id, set: () => {}, clear: () => {} } });
  clients.push(client); return client;
}
const login = (client: VaultClient) => client.connect({ serverUrl, email, masterPassword });
function draft(): VaultItem {
  return {
    id: '', type: 'login', rawType: 1, name: 'CI synthetic login', nameFailed: false,
    notes: 'Disposable real-server round trip', notesFailed: false, folderId: null,
    favorite: false, reprompt: 0, createdAt: '', updatedAt: '', deletedAt: null,
    archivedAt: null, wrappedKey: null, card: null, identity: null, secureNote: null,
    sshKey: null, customFields: [], passwordHistory: [], attachments: [],
    login: { ...emptyLogin(), username: 'synthetic-user', password: `Entry-${runId}!`,
      uris: [{ uri: 'https://service.example.invalid', match: 3 }] },
  };
}

try {
  const config = await localFetch(`${serverUrl}/api/config`);
  if (!config.ok) throw Error('Isolated server health request failed');
  const body = await config.json() as { server?: { name?: string } };
  if (body.server?.name !== 'Vaultwarden') throw Error('Test target is not Vaultwarden');
  const version = await localFetch(`${serverUrl}/api/version`);
  if (!version.ok) throw Error('Server version request failed');
  serverVersion = await version.json();
  check(serverVersion === '1.37.4', 'real server reports the pinned Vaultwarden 1.37.4');
  phase = 'register';
  await registerLocalVaultwardenAccount({ serverUrl, email, password: masterPassword, fetchImpl: localFetch });
  check(true, 'verification-token registration completes without SMTP');
  phase = 'login';
  const writer = newClient();
  await login(writer);
  check(writer.isUnlocked() && writer.hasVerifiedSync() && writer.getSession().items.length === 0,
    'new identity logs in and performs a verified empty sync');
  phase = 'save';
  const saved = await writer.saveItem(draft());
  createdIds.push(saved.id);
  check(Boolean(saved.id) && saved.login?.password === `Entry-${runId}!`, 'save returns a decryptable server record');
  phase = 'fresh-login-sync';
  writer.logout();
  const reader = newClient(); // No local session/cache reuse can hide a server persistence bug.
  await login(reader);
  const synced = reader.getSession().items.find(item => item.id === saved.id);
  check(reader.hasVerifiedSync() && reader.getSession().items.length === 1
    && synced?.name === saved.name && synced?.login?.password === saved.login?.password
    && synced?.login?.uris[0]?.match === 3,
  'fresh client login synchronizes and decrypts the saved fields and URL rule');
  phase = 'update';
  const updated = await reader.saveItem({ ...synced!, name: 'CI updated login', login: { ...synced!.login!, username: 'updated-user' } });
  check(updated.name === 'CI updated login', 'revision-protected update succeeds');
  reader.logout();
  const finalReader = newClient();
  await login(finalReader);
  check(finalReader.hasVerifiedSync() && finalReader.getSession().items[0]?.name === 'CI updated login'
    && finalReader.getSession().items[0]?.login?.username === 'updated-user', 'second fresh login sees the updated record');
} catch {
  failed = true;
  // Do not expose response bodies, master passwords, decrypted items, or tokens.
  console.error(`FAIL: real Vaultwarden smoke during ${phase}; no credential-bearing error details are logged`);
} finally {
  if (createdIds.length) {
    try {
      const cleanup = newClient(); await login(cleanup);
      for (const id of createdIds) await cleanup.deletePermanently(id);
      check(cleanup.getSession().items.length === 0, 'only records created by this run are removed');
    } catch { failed = true; console.error('FAIL: cleanup of this run’s synthetic records'); }
  }
  for (const client of clients) client.logout();
  if (process.env.ONEWARDEN_CI_OUTPUT) {
    const output = resolve(process.env.ONEWARDEN_CI_OUTPUT);
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'vaultwarden-report.json'), JSON.stringify({
      passed: !failed, synthetic: true, version: serverVersion, checks,
      ...(failed ? { failedPhase: phase } : {}), timestamp: new Date().toISOString(),
    }, null, 2) + '\n');
  }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${checks.length} real Vaultwarden checks; unique empty test account retained on local service`);
