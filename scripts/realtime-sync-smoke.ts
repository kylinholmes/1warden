#!/usr/bin/env bun
/** Local Vaultwarden integration: independent clients, real MessagePack push, synthetic data only.
 * VW_TEST_URL=https://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/realtime-sync-smoke.ts
 * The TLS override is for a disposable local certificate only; native production uses certificate pins.
 */
import { VaultClient } from '../packages/vault/src/client';
import { subscribeNotifications } from '../packages/api/src/notifications';
import { localVaultwardenUrl, registerLocalVaultwardenAccount } from './vaultwarden-registration';

const serverUrl = localVaultwardenUrl(process.env.VW_TEST_URL ?? 'https://localhost:8443');
const existing = process.env.ONEWARDEN_TEST_EMAIL && process.env.ONEWARDEN_TEST_PASSWORD;
const email = existing ? process.env.ONEWARDEN_TEST_EMAIL! : `push-${crypto.randomUUID()}@example.invalid`;
const masterPassword = existing ? process.env.ONEWARDEN_TEST_PASSWORD! : `Disposable-${crypto.randomUUID()}!Aa42`;
const fetchImpl: typeof fetch = (input, init) => {
  if (new URL(String(input)).origin !== new URL(serverUrl).origin) throw Error('Nonlocal test request refused');
  const headers = new Headers(init?.headers);
  // Optional loopback test identity isolates this run from a long-running dev
  // server's shared localhost limiter, without changing its configuration/data.
  const testIp = process.env.VW_TEST_CLIENT_IP;
  if (testIp) {
    if (!/^127(?:\.\d{1,3}){3}$/.test(testIp)) throw Error('Test client IP must be loopback');
    headers.set('X-Real-IP', testIp);
  }
  return fetch(input, { ...init, headers, redirect: 'error' });
};
let notifications = 0;
function client(live: boolean) {
  const id = crypto.randomUUID();
  return new VaultClient({ fetchImpl, deviceStore: { get: () => id, set() {}, clear() {} },
    ...(live ? { notifications: options => subscribeNotifications({ ...options,
      onSync: async () => { notifications++; await options.onSync(); },
    }) } : {}),
  });
}
const writer = client(false); const reader = client(true);
let folder: string | undefined;
let phase = 'register';
async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > end) throw Error(label);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  console.log(`PASS: ${label}`);
}
try {
  if (!existing) await registerLocalVaultwardenAccount({ serverUrl, email, password: masterPassword, fetchImpl });
  phase = 'writer login';
  await writer.connect({ serverUrl, email, masterPassword });
  phase = 'reader login';
  await reader.connect({ serverUrl, email, masterPassword });
  phase = 'subscribe';
  await until(() => notifications > 0 && reader.hasVerifiedSync(), 'authenticated push subscription and catch-up sync');
  folder = (await writer.createFolder('Synthetic push folder')).id;
  phase = 'create push';
  await until(() => reader.getSession().folders.some(f => f.id === folder), 'another client receives folder creation without manual refresh');
  await writer.renameFolder(folder, 'Synthetic renamed folder');
  phase = 'update push';
  await until(() => reader.getSession().folders.some(f => f.id === folder && f.name === 'Synthetic renamed folder'), 'another client receives folder update');
  await writer.deleteFolder(folder);
  phase = 'delete push';
  await until(() => !reader.getSession().folders.some(f => f.id === folder), 'another client receives folder deletion');
  folder = undefined;
  reader.lock();
  const count = notifications;
  folder = (await writer.createFolder('Synthetic after lock')).id;
  await new Promise(resolve => setTimeout(resolve, 250));
  if (notifications !== count || reader.isUnlocked()) throw Error('locked reader received push');
  console.log('PASS: locked reader disconnects');
} catch (error) {
  const info = error as { name?: string; status?: number; kind?: string };
  console.error(`FAIL: realtime sync smoke during ${phase} (${info.name ?? 'error'}, ${info.kind ?? ''}, HTTP ${info.status ?? 'n/a'}; credential-bearing details omitted)`);
  process.exitCode = 1;
} finally {
  if (folder) await writer.deleteFolder(folder).catch(() => { process.exitCode = 1; });
  writer.logout(); reader.logout();
}
