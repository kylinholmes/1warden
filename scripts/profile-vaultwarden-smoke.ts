#!/usr/bin/env bun
/** Contract check against the explicitly configured local development Vaultwarden. Restores its test data. */
import { VaultClient, isProfileItem, selectProfileItem, type VaultItem } from '../packages/vault/src/index';
import { createVaultService } from '../apps/desktop/src/application/service';
import { createProfileCache } from '../apps/desktop/src/application/profile-cache';
const serverUrl = process.env.VW_TEST_URL ?? 'http://127.0.0.1:8080';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(serverUrl).hostname)) throw Error('This test only accepts loopback servers');
const email = process.env.COFFER_TEST_EMAIL ?? 'coffer-test@example.com';
const masterPassword = process.env.COFFER_TEST_PASSWORD ?? 'Test-Master-Password-123!';
const storage = new Map<string, string>();
const cache = createProfileCache({ get: async (k) => storage.get(k) ?? null, set: async (k, v) => { storage.set(k, v); }, remove: async (k) => { storage.delete(k); } });
let writes = 0;
let checks = 0;
const client = new VaultClient({ fetchImpl: async (input, init) => {
  if (String(input).includes('/api/ciphers') && ['POST', 'PUT'].includes(init?.method ?? '')) {
    const body = JSON.parse(String(init!.body));
    if (body.type === 2 && body.notes) {
      if (!body.notes.startsWith('2.') || body.notes.includes('data:image')) throw Error('Profile was not encrypted');
      if (body.notes.length > 10000) throw Error('Encrypted note exceeds default budget');
      writes++;
    }
  }
  return fetch(input, init);
}, deviceStore: { get: async () => 'coffer-local-profile-contract', set: async () => {}, clear: async () => {} } });
const service = createVaultService(client, cache);
let original: VaultItem | undefined;
let createdId: string | undefined;
let wrote = false;
function check(ok: unknown, label: string) { if (!ok) throw Error(label); checks++; console.log(`PASS: ${label}`); }
try {
  await service.connect({ serverUrl, email, masterPassword });
  check(client.hasVerifiedSync(), 'local Vaultwarden authenticated and synchronized');
  original = selectProfileItem(client.getSession().items);
  const originalCount = client.getSession().items.filter(isProfileItem).length;
  const profile = { displayName: 'Coffer 本地 Profile 测试', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC' };
  await service.saveProfile(profile, (await service.snapshot()).profileVersion); wrote = true;
  const first = selectProfileItem(client.getSession().items)!; if (!original) createdId = first.id;
  check(first.id.length > 0 && writes === 1, 'real server accepts encrypted Base64 profile note');
  await service.saveProfile({ ...profile, displayName: 'Coffer 本地 Profile 更新' }, (await service.snapshot()).profileVersion);
  check(selectProfileItem(client.getSession().items)!.id === first.id && writes === 2, 'real server updates the same record with revision protection');
  check(client.getSession().items.filter(isProfileItem).length === originalCount + (original ? 0 : 1), 'no duplicate profile records');
  await service.lock(); check((await service.snapshot()).profile?.displayName === 'Coffer 本地 Profile 更新', 'local cached presentation is available while locked');
  storage.clear(); await service.unlock(masterPassword);
  const fresh = await service.snapshot();
  check(fresh.profile?.displayName === 'Coffer 本地 Profile 更新' && fresh.profile.avatarDataUrl === profile.avatarDataUrl, 'fresh server sync decrypts name and avatar');
  check(!fresh.items.some((i) => i.id === first.id) && (await service.search('Coffer 本地 Profile')).length === 0, 'profile stays out of browsing and search');
  console.log(`${checks} real Vaultwarden checks passed`);
} finally {
  if (wrote) {
    if (!client.isUnlocked()) await service.connect({ serverUrl, email, masterPassword });
    if (original) {
      const current = client.getSession().items.find((i) => i.id === original!.id)!;
      await client.saveItem({ ...original, updatedAt: current.updatedAt });
      console.log('Restored original test-account Profile');
    } else if (createdId) {
      await client.deletePermanently(createdId);
      console.log('Removed temporary test-account Profile');
    }
  }
  client.logout();
}
