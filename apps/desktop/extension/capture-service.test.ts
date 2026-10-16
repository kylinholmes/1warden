import { describe, expect, it, vi } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { emptyLogin, type VaultItem } from '@1warden/vault';
import { CaptureService, type CaptureOwner } from './capture-service';

function fixture() {
  const data: Record<string, unknown> = {};
  const area = { get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); },
    remove: async (key: string) => { delete data[key]; } };
  const items: VaultItem[] = [];
  let writes = 0;
  const owner: CaptureOwner = { account: 'a', key: makeUserKey(), assertCurrent() {}, items: () => items,
    sync: async () => {}, save: async item => { writes++; const result = { ...item, id: item.id || 'created', updatedAt: 'revision-2' };
      const index = items.findIndex(i => i.id === result.id); if (index < 0) items.push(result); else items[index] = result; return result; } };
  let now = Date.now();
  const service = new CaptureService(area, () => now);
  const source = { tabId: 7, frameId: 0, url: 'https://example.test/login', nonce: 'document-one' };
  const input = { formId: 'form-1', username: 'person', password: 'new-secret', intent: 'login' as const, submitted: true };
  return { service, owner, area, items, source, input, data, writes: () => writes, advance(ms: number) { now += ms; } };
}
describe('account and document bound credential capture', () => {
  it('withdraws an earlier changed-password prompt when the same form submits the saved password', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    const first = (await f.service.capture(f.owner, f.source, token, f.input))!;
    await f.service.save(f.owner, { captureId: first.id, revision: first.revision, action: 'save' });
    await f.service.capture(f.owner, f.source, token, { ...f.input, password: 'mistyped-new-password' });
    expect(await f.service.list(f.owner)).toHaveLength(1);
    await f.service.capture(f.owner, f.source, token, f.input);
    expect(await f.service.list(f.owner)).toEqual([]);
  });
  it('cannot resurrect captures if a tab cleanup resumes after lock', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    await f.service.capture(f.owner, f.source, token, f.input);
    const get = f.area.get; let release!: () => void;
    f.area.get = async key => { const result = await get(key); await new Promise<void>(resolve => { release = resolve; }); return result; };
    const cleanup = f.service.clearTab(f.owner, 99);
    await vi.waitFor(() => expect(release).toBeDefined());
    delete f.data['1warden.credential-captures']; f.owner.assertCurrent = () => { throw new Error('locked'); };
    release(); await expect(cleanup).rejects.toThrow('locked');
    expect(f.data['1warden.credential-captures']).toBeUndefined();
  });
  it('changes an empty target username only when explicitly supplied in the confirmation', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    const first = (await f.service.capture(f.owner, f.source, token, { ...f.input, username: null }))!;
    await f.service.save(f.owner, { captureId: first.id, revision: first.revision, action: 'save' });
    const next = (await f.service.capture(f.owner, f.source, token, { ...f.input, password: 'changed' }))!;
    await f.service.save(f.owner, { captureId: next.id, revision: next.revision, action: 'update', itemId: f.items[0]!.id, targetUpdatedAt: f.items[0]!.updatedAt });
    expect(f.items[0]!.login!.username).toBeNull();
  });
  it('refreshes conflicting targets and requires reconfirmation against their new revision', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    const first = (await f.service.capture(f.owner, f.source, token, f.input))!;
    await f.service.save(f.owner, { captureId: first.id, revision: first.revision, action: 'save' });
    const next = (await f.service.capture(f.owner, f.source, token, { ...f.input, password: 'changed' }))!;
    const choice = { captureId: next.id, revision: next.revision, action: 'update' as const, itemId: f.items[0]!.id, targetUpdatedAt: f.items[0]!.updatedAt };
    f.owner.save = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    f.owner.sync = vi.fn(async () => { f.items[0]!.updatedAt = 'remote-revision'; });
    await expect(f.service.save(f.owner, choice)).rejects.toThrow();
    expect(f.owner.sync).toHaveBeenCalledOnce();
    await expect(f.service.save(f.owner, choice)).rejects.toThrow(/变化/);
    expect(f.owner.save).toHaveBeenCalledOnce();
  });
  it('keeps candidates quiet until submitted, previews without secrets and saves once', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    await f.service.capture(f.owner, f.source, token, { ...f.input, submitted: false });
    expect(await f.service.list(f.owner)).toEqual([]);
    const preview = await f.service.capture(f.owner, f.source, token, f.input);
    expect(preview).toMatchObject({ action: 'save', username: 'person' });
    expect(JSON.stringify(preview)).not.toContain('new-secret');
    const choice = { captureId: preview!.id, revision: preview!.revision, action: 'save' as const };
    await f.service.save(f.owner, choice); await f.service.save(f.owner, choice);
    expect(f.writes()).toBe(1); expect(await f.service.list(f.owner)).toEqual([]);
  });
  it('rejects stale document tokens and account changes', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    await expect(f.service.capture(f.owner, { ...f.source, nonce: 'new-document' }, token, f.input)).rejects.toThrow();
    await expect(f.service.capture({ ...f.owner, account: 'b' }, f.source, token, f.input)).rejects.toThrow();
  });
  it('expires pending captures and allows a snoozed one to be inspected', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    const preview = (await f.service.capture(f.owner, f.source, token, f.input))!;
    await f.service.dismiss(f.owner, preview.id, true);
    expect(await f.service.list(f.owner)).toMatchObject([{ snoozed: true }]);
    f.advance(31 * 60_000); expect(await f.service.list(f.owner)).toEqual([]);
  });
  it('rejects an older preview after another submission changes the password', async () => {
    const f = fixture(); const token = await f.service.register(f.owner, f.source);
    const preview = (await f.service.capture(f.owner, f.source, token, f.input))!;
    await f.service.capture(f.owner, f.source, token, { ...f.input, password: 'another-secret' });
    await expect(f.service.save(f.owner, { captureId: preview.id, revision: preview.revision, action: 'save' })).rejects.toThrow(/变化/);
    expect(f.writes()).toBe(0);
  });
  it('requires a matching latest target and retains unrelated fields on update', async () => {
    const f = fixture();
    const seed = (await f.service.register(f.owner, f.source));
    const p = (await f.service.capture(f.owner, f.source, seed, f.input))!;
    await f.service.save(f.owner, { captureId: p.id, revision: p.revision, action: 'save' });
    const item = f.items[0]!; item.notes = 'keep-notes'; item.login = { ...emptyLogin(), ...item.login!, totp: 'keep-totp' };
    const next = (await f.service.capture(f.owner, f.source, seed, { ...f.input, password: 'changed' }))!;
    await expect(f.service.save(f.owner, { captureId: next.id, revision: next.revision, action: 'update', itemId: item.id, targetUpdatedAt: 'stale' })).rejects.toThrow(/变化/);
    await f.service.save(f.owner, { captureId: next.id, revision: next.revision, action: 'update', itemId: item.id, targetUpdatedAt: item.updatedAt });
    expect(f.items[0]).toMatchObject({ notes: 'keep-notes', login: { password: 'changed', totp: 'keep-totp', username: 'person' } });
  });
});
