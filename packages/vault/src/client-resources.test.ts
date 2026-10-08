import { describe, it, expect } from 'vitest';
import { makeUserKey, encryptBytes } from '@1warden/crypto';
import { VaultClient } from './client';
import { emptyLogin, type VaultItem } from './model';
import { encryptCipher } from './encrypt';
import { createPasskey } from './passkey';

const record = (): VaultItem => ({ id: 'item', name: 'Test', nameFailed: false, type: 'login', rawType: 1,
  notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02',
  deletedAt: null, archivedAt: null, wrappedKey: null, login: { ...emptyLogin(), password: 'old', passwordRevisionDate: '2025-12-01' },
  card: null, identity: null, secureNote: null, sshKey: null, customFields: [], attachments: [],
  passwordHistory: Array.from({ length: 5 }, (_, i) => ({ password: `history${i}`, lastUsedDate: '2025-01-01' })), });
async function fixture(extra?: (url: string, init?: RequestInit) => Promise<Response | undefined>) {
  const key = makeUserKey(); const item = record(); let dto = { ...await encryptCipher(item, key, {}), id: item.id, creationDate: item.createdAt, revisionDate: item.updatedAt };
  const calls: string[] = [];
  const client = new VaultClient({ fetchImpl: async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const custom = await extra?.(String(url), init); if (custom) return custom;
    if (init?.method === 'PUT') { dto = { ...dto, ...JSON.parse(String(init.body)), revisionDate: new Date().toISOString() }; }
    return Response.json(dto);
  } });
  client.restore({ userKey: key, items: [item], folders: [], token: { accessToken: 'test' } as never,
    account: { serverUrl: 'https://vault.test', email: 'test@example.invalid', userId: 'user', kdf: { kdf: 0, iterations: 1 } } });
  return { client, key, item, calls };
}
describe('record resource writes', () => {
  it('adds previous password and caps history at five while preserving unchanged revision', async () => {
    const { client, item } = await fixture();
    const saved = await client.saveItem({ ...item, login: { ...item.login!, password: 'new' } });
    expect(saved.passwordHistory).toHaveLength(5);
    expect(saved.passwordHistory[0]?.password).toBe('old');
    expect(saved.login?.passwordRevisionDate).not.toBe('2025-12-01');
    const unchanged = await client.saveItem({ ...saved, name: 'Renamed' });
    expect(unchanged.login?.passwordRevisionDate).toBe(saved.login?.passwordRevisionDate);
    expect(unchanged.passwordHistory).toEqual(saved.passwordHistory);
  });
  it('does not duplicate explicitly generated previous-password history', async () => {
    const { client, item } = await fixture();
    const saved = await client.saveItem({ ...item, login: { ...item.login!, password: 'new' },
      passwordHistory: [{ password: 'old', lastUsedDate: '2026-02-01' }, ...item.passwordHistory] });
    expect(saved.passwordHistory.filter(row => row.password === 'old')).toHaveLength(1);
    expect(saved.passwordHistory).toHaveLength(5);
  });
  it('clears history without a stale ordinary draft resurrecting it', async () => {
    const { client, item } = await fixture();
    const clearing = client.clearPasswordHistory(item.id);
    const saving = client.saveItem({ ...item, name: 'Renamed' });
    await Promise.all([clearing, saving]);
    expect(client.getSession().items[0]?.passwordHistory).toEqual([]);
  });
  it('removes one passkey and keeps the other plus password across stale drafts', async () => {
    const { client, item } = await fixture();
    const one = (await createPasskey({ rpId: 'example.com', rpName: 'Example', userName: 'one' })).stored;
    const two = (await createPasskey({ rpId: 'example.com', rpName: 'Example', userName: 'two' })).stored;
    const saved = await client.saveItem({ ...item, login: { ...item.login!, fido2Credentials: [one, two] } });
    const removing = client.removePasskey(item.id, one.credentialId);
    const saving = client.saveItem({ ...saved, name: 'Renamed' });
    await Promise.all([removing, saving]);
    expect(client.getSession().items[0]?.login?.fido2Credentials.map(p => p.credentialId)).toEqual([two.credentialId]);
    expect(client.getSession().items[0]?.login?.password).toBe('old');
  });
  it('cleans up a ticket after upload failure', async () => {
    const { client, calls } = await fixture(async (url, init) => {
      if (url.endsWith('/attachment/v2')) return Response.json({ attachmentId: 'att', url: '/ciphers/item/attachment/att', fileUploadType: 0 });
      if (url.endsWith('/attachment/att')) return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('failed', { status: 500 });
    });
    await expect(client.uploadAttachment('item', 'data.bin', new Uint8Array([0, 255]))).rejects.toThrow();
    expect(calls).toContain('DELETE https://vault.test/api/ciphers/item/attachment/att');
    expect(client.getSession().items[0]?.attachments).toEqual([]);
  });
  it('does not return downloaded plaintext when locked during the request', async () => {
    let release!: () => void; let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const { client, key, item } = await fixture(async (url) => {
      if (url.endsWith('/attachment/att')) return Response.json({ url: 'https://vault.test/attachments/item/att' });
      if (url.includes('/attachments/')) { started(); await new Promise<void>(resolve => { release = resolve; }); return new Response('bad'); }
    });
    const attKey = makeUserKey();
    item.attachments.push({ id: 'att', failed: false, fileName: 'test', size: '65', sizeName: '65 B', url: 'https://vault.test/attachments/item/att', key: await encryptBytes(new Uint8Array([...attKey.encKey, ...attKey.macKey]), key) });
    const pending = client.downloadAttachment('item', 'att'); await sent; client.lock(); release();
    await expect(pending).rejects.toThrow(/锁定|取消/);
  });
  it('cleans the old account ticket after account switching before the ticket response', async () => {
    let release!: () => void; let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    let cleanupAuth = '';
    const { client, calls } = await fixture(async (url, init) => {
      if (url.endsWith('/attachment/v2')) {
        started(); await new Promise<void>(resolve => { release = resolve; });
        return Response.json({ attachmentId: 'att', url: '/ciphers/item/attachment/att', fileUploadType: 0 });
      }
      if (init?.method === 'DELETE') { cleanupAuth = new Headers(init.headers).get('Authorization')!; return new Response(null, { status: 204 }); }
    });
    const pending = client.uploadAttachment('item', 'binary', new Uint8Array([1]));
    await sent;
    client.lock();
    client.restore({ account: { serverUrl: 'https://other.test', email: 'other@example.invalid', userId: 'other', kdf: { kdf: 0, iterations: 1 } },
      token: { accessToken: 'other-token' } as never, userKey: makeUserKey(), items: [record()], folders: [] });
    release();
    await expect(pending).rejects.toThrow(/取消|锁定/);
    expect(calls).toContain('DELETE https://vault.test/api/ciphers/item/attachment/att');
    expect(cleanupAuth).toBe('Bearer test');
    expect(calls.some(c => c.includes('other.test'))).toBe(false);
  });
  it.each([1, 2])('cleans unsupported upload type %s without sending file bytes', async fileUploadType => {
    const { client, calls } = await fixture(async (url, init) => {
      if (url.endsWith('/attachment/v2')) return Response.json({ attachmentId: 'att', url: '/ciphers/item/attachment/att', fileUploadType });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    });
    await expect(client.uploadAttachment('item', 'binary', new Uint8Array([1]))).rejects.toThrow(/类型/);
    expect(calls).toEqual(['POST https://vault.test/api/ciphers/item/attachment/v2', 'DELETE https://vault.test/api/ciphers/item/attachment/att']);
  });
  it('reports cleanup failure instead of presenting a failed ticket as success', async () => {
    const { client } = await fixture(async (url) => {
      if (url.endsWith('/attachment/v2')) return Response.json({ attachmentId: 'att', url: '/ciphers/item/attachment/att', fileUploadType: 0 });
      if (url.endsWith('/attachment/att')) return new Response('failed', { status: 500 });
    });
    await expect(client.uploadAttachment('item', 'binary', new Uint8Array([1]))).rejects.toThrow(/清理也失败/);
  });
  it('stops queued resource removal after lock without sending a second record write', async () => {
    let release!: () => void; let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const { client, item, calls } = await fixture(async (_url, init) => {
      if (init?.method === 'PUT') { started(); await new Promise<void>(resolve => { release = resolve; }); }
      return undefined;
    });
    const saving = client.saveItem({ ...item, name: 'Pending' });
    await sent; const clearing = client.clearPasswordHistory('item');
    client.lock(); release();
    const settled = await Promise.allSettled([saving, clearing]);
    expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toHaveLength(1);
    expect(client.getSession().items).toEqual([]);
  });
  it('rejects a second stale full save instead of losing the first saved name', async () => {
    const { client, item } = await fixture();
    const first = client.saveItem({ ...item, name: 'First' });
    const second = client.saveItem({ ...item, notes: 'Second notes' });
    await first;
    await expect(second).rejects.toThrow(/变化|更新/);
    expect(client.getSession().items[0]?.name).toBe('First');
  });

  it('deletes an attachment without losing login data and rejects locked resource actions', async () => {
    let removed = false;
    const { client, item, key, calls } = await fixture(async (url, init) => {
      if (init?.method === 'DELETE') { removed = true; return new Response(null, { status: 204 }); }
      if (removed && url.endsWith('/api/ciphers/item')) return Response.json({ ...await encryptCipher(item, key, {}), id: item.id, revisionDate: '2026-01-03' });
    });
    item.attachments.push({ id: 'att', failed: false, fileName: 'test', size: '65', sizeName: '65 B', key: null, url: 'https://vault.test/attachments/item/att' });
    await client.deleteAttachment('item', 'att');
    expect(client.getSession().items[0]?.attachments).toEqual([]);
    expect(client.getSession().items[0]?.login?.password).toBe('old');
    const before = calls.length; client.lock();
    await expect(client.deleteAttachment('item', 'att')).rejects.toThrow();
    await expect(client.removePasskey('item', 'credential')).rejects.toThrow();
    await expect(client.clearPasswordHistory('item')).rejects.toThrow();
    await expect(client.downloadAttachment('item', 'att')).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });
  it('does not add empty prior passwords to history', async () => {
    const { client, item } = await fixture();
    const cleared = await client.saveItem({ ...item, login: { ...item.login!, password: '' } });
    const saved = await client.saveItem({ ...cleared, login: { ...cleared.login!, password: 'after-empty' } });
    expect(saved.passwordHistory.some(h => h.password === '')).toBe(false);
  });
  it('keeps the previous vault snapshot visible while a manual refresh waits', async () => {
    let release!: () => void; let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const { client } = await fixture(async url => {
      if (url.endsWith('/revision-date')) return Response.json(123);
      if (url.includes('/api/sync')) { started(); await new Promise<void>(resolve => { release = resolve; }); return Response.json({ profile: {}, folders: [], ciphers: [] }); }
    });
    const pending = client.refresh(); await sent;
    expect(client.getSession().items).toHaveLength(1);
    release(); await pending;
  });

});
