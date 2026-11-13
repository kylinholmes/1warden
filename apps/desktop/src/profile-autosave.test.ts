import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfileAutosave } from './profile-autosave';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from './application/types';

function setup(initial: Partial<ApplicationSnapshot> = {}) {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', profileReady: true,
    account: { serverUrl: 'https://a.test', email: 'a@test.com', userId: '', kdf: { kdf: 0, iterations: 1 } },
    profile: { displayName: 'Before', avatarDataUrl: null }, profileVersion: '1', ...initial };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ApplicationSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  const saveProfile = vi.fn(async (profile) => { update({ profile, profileVersion: String(Number(snapshot.profileVersion) + 1) }); });
  const savePreferences = vi.fn(async (preferences) => { update({ profileSettings: { preferences, devices: [] } }); });
  const client = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    saveProfile, savePreferences } as unknown as ApplicationClient;
  const store = createProfileAutosave(client); store.start();
  return { store, client, update, saveProfile, savePreferences };
}
afterEach(() => vi.useRealTimers());
describe('profile autosave', () => {
  it('keeps appearance edits during verified background sync and saves only after sync finishes', async () => {
    const { store, update, savePreferences } = setup();
    const preferences = { mode: 'light' as const, palette: 'whale', showTypes: true, iconStyle: 'original' as const };
    update({ syncing: true, profileReady: false });
    store.editPreferences(preferences);
    expect(store.getSnapshot().preferences.value).toEqual(preferences);
    expect(await store.flush()).toEqual({ saved: false, pending: ['preferences'] });
    expect(savePreferences).not.toHaveBeenCalled();
    update({ syncing: false, profileReady: true });
    expect(await store.flush()).toEqual({ saved: true, pending: [] });
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith(preferences, null); store.stop();
  });
  it.each(['initial', 'reunlock', 'account', 'syncError', 'profileError', 'profileSettingsError'] as const)('previews but never writes appearance during %s unverified sync', async reason => {
    const { store, update, client, savePreferences } = setup(reason === 'initial' ? { profileReady: false, syncing: true } : {});
    if (reason === 'reunlock') { update({ status: 'locked', profileReady: false }); update({ status: 'unlocked', syncing: true }); }
    if (reason === 'account') update({ account: { ...client.getSnapshot().account!, email: 'b@test.com' }, syncing: true, profileReady: false });
    if (reason.endsWith('Error')) update({ [reason]: 'unverified', syncing: true, profileReady: false });
    store.editPreferences({ mode: 'light', palette: 'whale', showTypes: false });
    expect(store.getSnapshot().preferences.value).toMatchObject({ mode: 'light', palette: 'whale', showTypes: false });
    expect(await store.flush()).toEqual({ saved: false, pending: ['preferences'] });
    expect(savePreferences).not.toHaveBeenCalled(); store.stop();
  });
  it('ignores edits while locked or without an account', () => {
    const { store, update } = setup(); const before = store.getSnapshot();
    update({ status: 'locked' }); store.editPreferences({ mode: 'dark' }); store.editProfile({ displayName: 'Blocked' });
    expect(store.getSnapshot().preferences.value).toEqual(before.preferences.value);
    expect(store.getSnapshot().profile.value).toEqual(before.profile.value);
    update({ status: 'unlocked', account: null }); store.editPreferences({ mode: 'dark' });
    expect(store.getSnapshot().preferences.status).toBe('idle'); store.stop();
  });
  it('merges only explicit first-sync edits into the newly verified remote preferences and profile', async () => {
    const { store, update, savePreferences, saveProfile } = setup({ profileReady: false, syncing: true, profile: null });
    store.editPreferences({ mode: 'light' }); store.editProfile({ displayName: 'Mine' });
    await store.flush(); expect(savePreferences).not.toHaveBeenCalled(); expect(saveProfile).not.toHaveBeenCalled();
    const remote = { mode: 'dark' as const, palette: 'dracula', showTypes: false, iconStyle: 'plate' as const };
    update({ syncing: false, profileReady: true, profileSettings: { preferences: remote, devices: [] },
      profile: { displayName: 'Remote', avatarDataUrl: 'data:image/png;base64,remote' }, profileVersion: '2' });
    expect(store.getSnapshot().preferences.value).toEqual({ ...remote, mode: 'light' });
    await store.flush();
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ ...remote, mode: 'light' }, remote);
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith({ displayName: 'Mine', avatarDataUrl: 'data:image/png;base64,remote' }, '2'); store.stop();
  });
  it('retains the visible migrated appearance when editing an account without remote preferences', async () => {
    const { store, savePreferences } = setup();
    const preview = { mode: 'dark' as const, palette: 'dracula', showTypes: false, iconStyle: 'plate' as const };
    store.editPreferences({ mode: 'dark' }, preview); await store.flush();
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith(preview, null); store.stop();
  });
  it('retains the account-local preview when first sync confirms absent remote preferences', async () => {
    const { store, update, savePreferences } = setup({ syncing: true, profileReady: false });
    const preview = { mode: 'dark' as const, palette: 'jade', showTypes: false, iconStyle: 'plate' as const };
    store.editPreferences({ iconStyle: 'plate' }, preview);
    update({ syncing: false, profileReady: true, profileSettings: { preferences: null, devices: [] } });
    await store.flush();
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith(preview, null); store.stop();
  });
  it('allows profile typing during background sync and saves it after verification', async () => {
    const { store, update, saveProfile } = setup(); update({ syncing: true, profileReady: false });
    store.editProfile({ displayName: 'Edited while syncing' });
    expect(store.getSnapshot().profile.value.displayName).toBe('Edited while syncing');
    await store.flush(); expect(saveProfile).not.toHaveBeenCalled();
    update({ syncing: false, profileReady: true }); await store.flush();
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith({ displayName: 'Edited while syncing', avatarDataUrl: null }, '1'); store.stop();
  });
  it('retains a preview on save failure and reports known-base remote conflicts instead of overwriting', async () => {
    const { store, update, savePreferences } = setup();
    savePreferences.mockRejectedValueOnce(new Error('Synthetic save offline'));
    store.editPreferences({ mode: 'dark' }); await store.flush();
    expect(store.getSnapshot().preferences).toMatchObject({ status: 'error', error: 'Synthetic save offline', value: { mode: 'dark' } });
    await store.retry('preferences'); expect(store.getSnapshot().preferences.status).toBe('saved');
    update({ syncing: true, profileReady: false }); store.editPreferences({ mode: 'light' });
    const remote = { mode: 'dark' as const, palette: 'dracula', showTypes: false };
    update({ syncing: false, profileReady: true, profileSettings: { preferences: remote, devices: [] } }); await store.flush();
    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().preferences).toMatchObject({ status: 'error', value: { mode: 'light' } });
    store.discard('preferences'); expect(store.getSnapshot().preferences.value).toEqual(remote); store.stop();
  });
  it('parks first-sync edits per account and never transfers them to another identity', async () => {
    const { store, client, update, savePreferences } = setup({ profileReady: false, syncing: true }); const a = client.getSnapshot();
    store.editPreferences({ mode: 'dark' });
    update({ account: { ...a.account!, email: 'b@test.com' }, profileReady: true, syncing: false });
    await store.flush(); expect(savePreferences).not.toHaveBeenCalled();
    expect(store.getSnapshot().preferences.value.mode).toBe('system');
    update({ ...a, profileReady: true, syncing: false }); await store.flush();
    expect(savePreferences).toHaveBeenCalledTimes(1); expect(store.getSnapshot().preferences.value.mode).toBe('dark'); store.stop();
  });
  it('does not postpone a pending save when unrelated ready snapshots arrive', async () => {
    vi.useFakeTimers(); const { store, update, savePreferences } = setup();
    store.editPreferences({ mode: 'dark', palette: 'whale', showTypes: true });
    for (let i = 0; i < 7; i++) { await vi.advanceTimersByTimeAsync(100); update({ revision: i + 1 }); }
    expect(savePreferences).toHaveBeenCalledTimes(1); store.stop();
  });
  it('retains the edit deadline through repeated background sync instead of starving autosave', async () => {
    vi.useFakeTimers(); const { store, update, savePreferences } = setup();
    store.editPreferences({ mode: 'dark', palette: 'whale', showTypes: true });
    await vi.advanceTimersByTimeAsync(100); update({ syncing: true, profileReady: false });
    await vi.advanceTimersByTimeAsync(800); expect(savePreferences).not.toHaveBeenCalled();
    update({ syncing: false, profileReady: true }); await vi.advanceTimersByTimeAsync(1);
    expect(savePreferences).toHaveBeenCalledTimes(1); store.stop();
  });
  it('reports pending failed edits on every flush until retry saves them', async () => {
    const { store, saveProfile } = setup();
    saveProfile.mockRejectedValueOnce(new Error('offline'));
    store.editProfile({ displayName: 'Keep on logout' });
    expect(await store.flush()).toEqual({ saved: false, pending: ['profile'] });
    expect(await store.flush()).toEqual({ saved: false, pending: ['profile'] });
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().profile.value.displayName).toBe('Keep on logout');
    expect(await store.retry('profile')).toEqual({ saved: true, pending: [] });
    expect(await store.flush()).toEqual({ saved: true, pending: [] }); store.stop();
  });
  it('reports parked dirty edits when the account locks instead of reporting a successful flush', async () => {
    const { store, update, saveProfile } = setup();
    store.editProfile({ displayName: 'Pending' }); update({ status: 'locked' });
    expect(await store.flush()).toEqual({ saved: false, pending: ['profile'] });
    expect(saveProfile).not.toHaveBeenCalled(); store.stop();
  });
  it('does not erase unsaved drafts through forget before an explicit discard', async () => {
    const { store } = setup(); store.editProfile({ displayName: 'Retained' });
    expect(() => store.forget()).toThrow('尚未保存');
    expect(store.getSnapshot().profile.value.displayName).toBe('Retained');
    store.discard('profile'); expect(() => store.forget()).not.toThrow(); store.stop();
  });
  it('coalesces typing and saves without a button', async () => {
    vi.useFakeTimers(); const { store, saveProfile } = setup();
    store.editProfile({ displayName: 'N' }); store.editProfile({ displayName: 'New' });
    expect(saveProfile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith({ displayName: 'New', avatarDataUrl: null }, '1');
    expect(store.getSnapshot().profile.status).toBe('saved'); store.stop();
  });
  it('keeps failures and retries explicitly', async () => {
    const { store, saveProfile } = setup(); saveProfile.mockRejectedValueOnce(new Error('offline'));
    store.editProfile({ displayName: 'Keep' }); await store.flush();
    expect(store.getSnapshot().profile.error).toBe('offline');
    expect(store.getSnapshot().profile.value.displayName).toBe('Keep');
    await store.retry('profile'); expect(store.getSnapshot().profile.status).toBe('saved'); store.stop();
  });
  it('parks a draft on account change and never writes it to another account', async () => {
    vi.useFakeTimers(); const { store, client, update, saveProfile } = setup(); const a = client.getSnapshot();
    store.editProfile({ displayName: 'A draft' });
    update({ account: { ...a.account!, serverUrl: 'https://b.test' }, profile: { displayName: 'B', avatarDataUrl: null } });
    await vi.advanceTimersByTimeAsync(800); expect(saveProfile).not.toHaveBeenCalled();
    expect(store.getSnapshot().profile.value.displayName).toBe('B');
    update(a); await vi.advanceTimersByTimeAsync(800);
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith({ displayName: 'A draft', avatarDataUrl: null }, '1'); store.stop();
  });
  it('rebases unrelated metadata but refuses to overwrite a changed profile', async () => {
    const { store, update, saveProfile } = setup(); store.editProfile({ displayName: 'Mine' });
    update({ profileVersion: '2' }); await store.flush();
    expect(saveProfile).toHaveBeenLastCalledWith({ displayName: 'Mine', avatarDataUrl: null }, '2');
    store.editProfile({ displayName: 'Later' }); update({ profile: { displayName: 'Remote', avatarDataUrl: null }, profileVersion: '3' });
    await store.flush(); expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().profile.status).toBe('error'); store.stop();
  });
  it('serializes newer edits made during a slow write', async () => {
    const { store, saveProfile, update } = setup(); let release!: () => void;
    saveProfile.mockImplementationOnce(async profile => { await new Promise<void>(r => { release = r; }); update({ profile, profileVersion: '2' }); });
    store.editProfile({ displayName: 'First' }); const pending = store.flush();
    store.editProfile({ displayName: 'Second' }); release(); await pending;
    expect(saveProfile).toHaveBeenCalledTimes(2);
    expect(saveProfile).toHaveBeenLastCalledWith({ displayName: 'Second', avatarDataUrl: null }, '2'); store.stop();
  });
  it('does not write a locked draft or echo an incoming preference projection', async () => {
    vi.useFakeTimers(); const { store, update, saveProfile, savePreferences } = setup();
    update({ profileSettings: { preferences: { mode: 'dark', palette: 'original', showTypes: true }, devices: [] } });
    await vi.advanceTimersByTimeAsync(800); expect(savePreferences).not.toHaveBeenCalled();
    store.editProfile({ displayName: 'Paused' }); update({ status: 'locked' });
    await store.flush(); expect(saveProfile).not.toHaveBeenCalled(); store.stop();
  });
  it('accepts server normalization without an extra write or a false later conflict', async () => {
    const { store, saveProfile, update } = setup();
    saveProfile.mockImplementationOnce(async profile => { update({ profile: { ...profile, displayName: profile.displayName.trim() }, profileVersion: '2' }); });
    store.editProfile({ displayName: ' New ' }); await store.flush();
    expect(store.getSnapshot().profile.value.displayName).toBe('New');
    expect(saveProfile).toHaveBeenCalledTimes(1);
    store.editProfile({ displayName: 'Next' }); await store.flush();
    expect(store.getSnapshot().profile.status).toBe('saved'); expect(saveProfile).toHaveBeenCalledTimes(2); store.stop();
  });
  it('saves profile and preferences in sequence and preserves unsent locked edits', async () => {
    const { store, client, update, savePreferences } = setup();
    const preferences = { mode: 'light' as const, palette: 'ayu', showTypes: false, iconStyle: 'original' as const };
    store.editProfile({ displayName: 'Together' }); store.editPreferences(preferences); await store.flush();
    expect(client.getSnapshot().profile?.displayName).toBe('Together');
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith(preferences, null);
    store.editProfile({ displayName: 'After unlock' }); update({ status: 'locked' }); await store.flush();
    update({ status: 'unlocked' }); await store.flush(); expect(client.getSnapshot().profile?.displayName).toBe('After unlock'); store.stop();
  });
});
