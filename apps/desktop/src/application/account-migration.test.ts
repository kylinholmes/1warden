import { afterEach, describe, expect, it } from 'vitest';
import { makeUserKey, encryptString, toBase64 } from '@1warden/crypto';
import { VaultClient, buildProfileItem, decryptCipher, emptyLogin, encryptCipher, type VaultItem } from '@1warden/vault';
import { createAccountSessions } from './account-sessions';

const sourceAccount = { serverUrl: 'https://source.test', email: 'source@example.com', userId: 'source', kdf: { kdf: 0 as const, iterations: 1 } };
const targetAccount = { ...sourceAccount, serverUrl: 'https://target.test', email: 'target@example.com', userId: 'target' };
const clients: VaultClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.logout(); });

function note(overrides: Partial<VaultItem> = {}): VaultItem {
  return { ...buildProfileItem({ displayName: 'irrelevant', avatarDataUrl: null }), id: 'source-note', name: 'Private record',
    customFields: [], notes: 'source secret', ...overrides };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { resolve, promise };
}

async function fixture(records: VaultItem[] = [note()]) {
  const sourceKey = makeUserKey(); const targetKey = makeUserKey();
  let sourceCiphers = await Promise.all(records.map(async item => ({ ...await encryptCipher(item, sourceKey, { archivedDate: item.archivedAt }), id: item.id })));
  const created: any[] = [];
  const createdFolders: any[] = [];
  let failRefresh = false; let loseResponse = false;
  const requests: { origin: string; method: string; path: string }[] = [];
  let pause: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; path: string; origin: string } | undefined;
  const sessions = createAccountSessions(() => {
    const vault = new VaultClient({ autoLockMs: 0, fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      requests.push({ origin: url.origin, method, path: url.pathname });
      if (pause?.origin === url.origin && pause.path === url.pathname) { const pending = pause; pause = undefined; pending.started.resolve(); await pending.release.promise; }
      if (url.pathname === '/api/accounts/revision-date') return failRefresh
        ? Response.json({ message: 'Synthetic refresh failure' }, { status: 503 }) : Response.json(1);
      if (url.pathname === '/api/sync') return Response.json({ profile: { id: url.origin === sourceAccount.serverUrl ? 'source' : 'target' },
        ciphers: url.origin === sourceAccount.serverUrl ? sourceCiphers : created,
        folders: url.origin === sourceAccount.serverUrl ? [{ id: 'source-folder', name: await encryptString('Folder', sourceKey) }] : createdFolders,
        collections: [] });
      if (url.origin === sourceAccount.serverUrl && url.pathname.startsWith('/api/ciphers/')) {
        if (method === 'GET') return Response.json(sourceCiphers.find(row => row.id === url.pathname.split('/').at(-1)));
        if (method === 'PUT' && url.pathname.endsWith('/delete')) return new Response(null, { status: 204 });
      }
      if (url.origin === targetAccount.serverUrl && method === 'POST' && url.pathname === '/api/ciphers') {
        const row = { ...JSON.parse(String(init?.body)), id: `copy-${created.length}` }; created.push(row);
        if (loseResponse) throw new TypeError('Synthetic lost response');
        return Response.json(row);
      }
      if (url.origin === targetAccount.serverUrl && method === 'POST' && url.pathname === '/api/folders') {
        const row = { ...JSON.parse(String(init?.body)), id: `folder-${createdFolders.length}` }; createdFolders.push(row); return Response.json(row);
      }
      throw new Error(`Unexpected endpoint: ${url.origin}${url.pathname}`);
    } });
    clients.push(vault); return vault;
  });
  await sessions.service.switchAccount(sourceAccount);
  const source = sessions.getActiveVault();
  source.restore({ account: sourceAccount, userKey: sourceKey, items: [], folders: [], token: { accessToken: 'source-token' } as never, syncVerified: true });
  await sessions.service.switchAccount(targetAccount);
  const target = sessions.getActiveVault();
  target.restore({ account: targetAccount, userKey: targetKey, items: [], folders: [], token: { accessToken: 'target-token' } as never, syncVerified: true });
  return { ...sessions, source, target, sourceKey, targetKey, created, createdFolders, requests,
    failRefresh() { failRefresh = true; }, loseResponse() { loseResponse = true; },
    replaceSource: async (items: VaultItem[]) => { sourceCiphers = await Promise.all(items.map(async item => ({ ...await encryptCipher(item, sourceKey, { archivedDate: item.archivedAt }), id: item.id }))); },
    pause(origin: string, path = '/api/sync') { pause = { origin, path, started: deferred(), release: deferred() }; return pause; },
  };
}

describe('account import ownership', () => {
  it('refreshes accepted records whose import responses were lost', async () => {
    const f = await fixture(); f.loseResponse();
    const outcome = await f.service.importAccount(sourceAccount, { skipExisting: true });
    expect(outcome).toMatchObject({ created: 0, failed: [{ name: 'Private record' }] });
    expect(f.target.getSession().items.map(item => item.name)).toEqual(['Private record']);
    expect(f.target.getSession().folders.map(folder => folder.name)).toEqual(['Folder']);
  });

  it('keeps the known import outcome when its final refresh fails', async () => {
    const f = await fixture(); f.failRefresh();
    expect(await f.service.importAccount(sourceAccount, { skipExisting: true })).toMatchObject({ created: 1, failed: [] });
    expect(f.target.syncError).toMatch(/同步失败/);
  });

  it('rejects a late import result after selection changes during the final refresh', async () => {
    const f = await fixture();
    const paused = f.pause(targetAccount.serverUrl, '/api/accounts/revision-date');
    const pending = f.service.importAccount(sourceAccount, { skipExisting: true });
    const rejected = expect(pending).rejects.toThrow(/取消|变更|切换/);
    await paused.started.promise;
    await f.service.switchAccount(sourceAccount); await f.service.switchAccount(targetAccount);
    paused.release.resolve(); await rejected;
    expect(f.created).toHaveLength(1);
  });

  it('returns only preview counts and warns about omitted data while retaining target selection', async () => {
    const f = await fixture([note({ folderId: 'source-folder' }), buildProfileItem({ displayName: 'hidden profile', avatarDataUrl: null })]);
    const preview = await f.service.previewAccountImport(sourceAccount);
    expect(preview).toMatchObject({ total: 1, byType: { secureNote: 1 }, folders: 1, skipped: [] });
    expect(JSON.stringify(preview)).not.toMatch(/source secret|Private record|hidden profile|source-token/);
    expect(preview.warnings?.join(' ')).toMatch(/附件/);
    expect(preview.warnings?.join(' ')).toMatch(/重新读取/);
    expect(f.getActiveVault()).toBe(f.target);
    expect(f.source.isUnlocked()).toBe(true);
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('copies fresh source fields and archives with target encryption without modifying the source', async () => {
    const f = await fixture();
    await f.service.previewAccountImport(sourceAccount);
    await f.replaceSource([note({ type: 'login', rawType: 1, secureNote: null, archivedAt: '2026-10-01', folderId: 'source-folder',
      login: { ...emptyLogin(), username: 'fresh user', password: 'fresh password', uris: [{ uri: 'https://example.com', match: 3 }],
        autofillOnPageLoad: false, passwordRevisionDate: '2026-09-01' },
      customFields: [{ name: 'hidden', value: 'field secret', type: 1, linkedId: null }],
      passwordHistory: [{ password: 'old password', lastUsedDate: '2026-08-01' }] })]);
    expect(await f.service.importAccount(sourceAccount, { skipExisting: true })).toMatchObject({ created: 1, failed: [] });
    expect(await decryptCipher(f.created[0], f.targetKey)).toMatchObject({ archivedAt: '2026-10-01', folderId: 'folder-0',
      login: { username: 'fresh user', password: 'fresh password', uris: [{ uri: 'https://example.com', match: 3 }], autofillOnPageLoad: false },
      customFields: [{ name: 'hidden', value: 'field secret', type: 1 }], passwordHistory: [{ password: 'old password' }] });
    expect(f.requests.filter(r => r.origin === sourceAccount.serverUrl).every(r => r.method === 'GET')).toBe(true);
    expect(f.source.getSession().getKey()).toBe(f.sourceKey);
    expect(f.getActiveVault()).toBe(f.target);
  });

  it('rejects same-account and locked-source copies before reading or writing', async () => {
    const f = await fixture();
    await expect(f.service.importAccount({ ...targetAccount, email: ' TARGET@EXAMPLE.COM ' }, { skipExisting: true })).rejects.toThrow(/相同|当前/);
    f.source.lock();
    await expect(f.service.previewAccountImport(sourceAccount)).rejects.toThrow(/解锁|锁定/);
    expect(f.requests).toEqual([]);
  });

  it.each(['source-lock', 'target-lock', 'switch-back', 'source-reunlock'] as const)('cancels a source read after %s', async reason => {
    const f = await fixture();
    const pause = f.pause(sourceAccount.serverUrl);
    const copying = f.service.importAccount(sourceAccount, { skipExisting: true });
    const rejected = expect(copying).rejects.toThrow(/取消|锁定|变更|切换/);
    await pause.started.promise;
    if (reason === 'source-lock') f.source.lock();
    if (reason === 'target-lock') f.target.lock();
    if (reason === 'switch-back') { await f.service.switchAccount(sourceAccount); await f.service.switchAccount(targetAccount); }
    if (reason === 'source-reunlock') { const state = f.source.exportState(); f.source.lock(); f.source.restore({ ...state, userKey: makeUserKey() }); }
    pause.release.resolve(); await rejected;
    expect(f.created).toEqual([]);
    expect(f.createdFolders).toEqual([]);
  });

  it('stops before the next write when the source locks during a target folder mutation', async () => {
    const f = await fixture([note({ folderId: 'source-folder' })]);
    const pause = f.pause(targetAccount.serverUrl, '/api/folders');
    const copying = f.service.importAccount(sourceAccount, { skipExisting: true });
    const rejected = expect(copying).rejects.toThrow(/取消|锁定|变更/);
    await pause.started.promise; f.source.lock(); pause.release.resolve(); await rejected;
    expect(f.created).toEqual([]);
  });
});

describe('native selected-account mutation boundaries', () => {
  it('invalidates a bulk confirmation after switching away and back to an unlocked account', async () => {
    const f = await fixture();
    await f.service.switchAccount(sourceAccount);
    const preview = await f.service.previewBulkDelete('vault');
    expect(preview.count).toBe(1);
    await f.service.switchAccount(targetAccount); await f.service.switchAccount(sourceAccount);
    await expect(f.service.commitBulkDelete(preview.token)).rejects.toThrow(/取消|变更|切换/);
    expect(f.source.isUnlocked()).toBe(true);
    expect(f.requests.filter(row => row.method !== 'GET')).toEqual([]);
  });

  it.each(['preview-read', 'commit-read', 'first-delete'] as const)('cancels bulk cleanup across an account switch during %s', async phase => {
    const f = await fixture([note(), note({ id: 'second-note' })]);
    await f.service.switchAccount(sourceAccount);
    const preview = phase === 'preview-read' ? null : await f.service.previewBulkDelete('vault');
    const paused = f.pause(sourceAccount.serverUrl, phase === 'first-delete' ? '/api/ciphers/source-note/delete' : '/api/sync');
    const pending = preview ? f.service.commitBulkDelete(preview.token) : f.service.previewBulkDelete('vault');
    const rejected = expect(pending).rejects.toThrow(/取消|变更|切换/);
    await paused.started.promise;
    await f.service.switchAccount(targetAccount); await f.service.switchAccount(sourceAccount);
    paused.release.resolve(); await rejected;
    expect(f.requests.filter(row => row.method !== 'GET')).toHaveLength(phase === 'first-delete' ? 1 : 0);
  });

  it.each(['/api/sync', '/api/folders', '/api/ciphers'])('cancels file import when selection changes during %s', async path => {
    const f = await fixture();
    const paused = f.pause(targetAccount.serverUrl, path);
    const file = { name: 'synthetic.json', format: 'bitwarden-json' as const, skipExisting: true,
      dataBase64: toBase64(new TextEncoder().encode(JSON.stringify({ encrypted: false,
        folders: [{ id: 'folder', name: 'File folder' }], items: [
          { type: 2, name: 'First', folderId: 'folder', secureNote: { type: 0 } },
          { type: 2, name: 'Second', folderId: 'folder', secureNote: { type: 0 } },
        ] }))) };
    const importing = f.service.importData(file);
    const rejected = expect(importing).rejects.toThrow(/取消|变更|切换/);
    await paused.started.promise;
    await f.service.switchAccount(sourceAccount); await f.service.switchAccount(targetAccount);
    paused.release.resolve(); await rejected;
    expect(f.created).toHaveLength(path === '/api/ciphers' ? 1 : 0);
  });
});
