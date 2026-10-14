#!/usr/bin/env bun
/** Real protocol smoke. New synthetic account; memory-only clients; loopback only.
 * Run: VW_TEST_URL=http://127.0.0.1:18083 bun run test:vaultwarden
 * Requires Vaultwarden 1.37.4, SIGNUPS_ALLOWED=true, SIGNUPS_VERIFY=false, no SMTP.
 * The CI service/container is disposable. Local runs leave only the unique empty
 * test account; record cleanup uses exclusively the IDs created by this run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VaultClient, createVaultExport, parseImport, emptyLogin, type VaultItem } from '../packages/vault/src/index';
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
  const headers = new Headers(init?.headers);
  if (process.env.VW_TEST_CLIENT_IP) headers.set('X-Real-IP', process.env.VW_TEST_CLIENT_IP);
  return fetch(input, { ...init, headers, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) });
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
    sshKey: null, customFields: [{ name: 'Round-trip secret', value: 'synthetic-custom', type: 1, linkedId: null }],
    passwordHistory: [{ password: 'synthetic-old-password', lastUsedDate: '2026-01-01T00:00:00Z' }], attachments: [],
    login: { ...emptyLogin(), username: 'synthetic-user', password: `Entry-${runId}!`,
      uris: [{ uri: 'https://service.example.invalid', match: 3 }],
      fido2Credentials: [{ credentialId: '00000000-0000-4000-8000-000000000001', keyType: 'public-key', keyAlgorithm: 'ECDSA',
        keyCurve: 'P-256', keyValue: 'synthetic-passkey-material', rpId: 'service.example.invalid', userName: 'synthetic-user',
        counter: '0', discoverable: 'true', creationDate: '2026-01-01T00:00:00Z' }] },
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
  // Local source builds can report an empty version; CI always uses the pinned default.
  const expectedVersion = process.env.VW_TEST_EXPECT_VERSION ?? '1.37.4';
  check(serverVersion === expectedVersion, expectedVersion ? `real server reports Vaultwarden ${expectedVersion}` : 'local development server reports an unversioned build');
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
  phase = 'export-import';
  for (const format of ['encrypted-json', 'json', 'csv'] as const) {
    const password = 'Independent-synthetic-export-password';
    const snapshot = await reader.readExportData();
    const exported = await createVaultExport({ items: snapshot.items.filter(item => item.id === saved.id), folders: snapshot.folders, format, password });
    const parsed = await parseImport(exported.bytes, 'auto', format === 'encrypted-json' ? password : undefined);
    check(parsed.items.length === 1 && parsed.skipped.length === 0, `${format} export parses back to one record`);
    const before = new Set(reader.getSession().items.map(item => item.id));
    const outcome = await reader.importItems(parsed.items);
    for (const item of reader.getSession().items) if (!before.has(item.id)) createdIds.push(item.id);
    check(outcome.created === 1 && outcome.failed.length === 0, `${format} import writes successfully to Vaultwarden`);
    await reader.refresh();
    const imported = reader.getSession().items.find(item => !before.has(item.id));
    check(imported?.login?.password === synced!.login!.password && imported?.customFields[0]?.value === 'synthetic-custom',
      `${format} fresh server sync preserves credentials and custom values`);
    if (format !== 'csv') check(imported?.login?.fido2Credentials[0]?.keyValue === 'synthetic-passkey-material'
      && imported?.passwordHistory[0]?.password === 'synthetic-old-password' && imported?.login?.uris[0]?.match === 3,
    `${format} fresh server sync preserves passkeys, password history and URL matching`);
    exported.bytes.fill(0);
  }
  phase = 'archive-export';
  const archived = await reader.saveItem({ ...draft(), name: 'CI archived credential', archivedAt: '2026-01-01T00:00:00Z' });
  createdIds.push(archived.id);
  await reader.refresh();
  check(!reader.getSession().items.some(item => item.id === archived.id), 'archived credential stays outside the browsing session');
  const archiveSnapshot = await reader.readExportData();
  const archiveExport = await createVaultExport({ items: archiveSnapshot.items.filter(item => item.id === archived.id), folders: [], format: 'json' });
  const archiveImport = await parseImport(archiveExport.bytes);
  check(archiveImport.items.length === 1 && Boolean(archiveImport.items[0]?.archivedAt), 'authoritative export preserves the archived credential');
  const beforeArchiveImport = new Set(archiveSnapshot.items.map(item => item.id));
  const archiveOutcome = await reader.importItems(archiveImport.items);
  const restoredArchives = (await reader.readExportData()).items.filter(item => !beforeArchiveImport.has(item.id));
  createdIds.push(...restoredArchives.map(item => item.id));
  check(archiveOutcome.created === 1 && restoredArchives.length === 1 && Boolean(restoredArchives[0]?.archivedAt),
    'JSON import preserves archive state on the real server');
  archiveExport.bytes.fill(0);
  phase = 'update';
  const updated = await reader.saveItem({ ...synced!, name: 'CI updated login', login: { ...synced!.login!, username: 'updated-user' } });
  check(updated.name === 'CI updated login', 'revision-protected update succeeds');
  reader.logout();
  const finalReader = newClient();
  await login(finalReader);
  check(finalReader.hasVerifiedSync() && finalReader.getSession().items.find(item => item.id === saved.id)?.name === 'CI updated login'
    && finalReader.getSession().items.find(item => item.id === saved.id)?.login?.username === 'updated-user', 'second fresh login sees the updated record');
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
