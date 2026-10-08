import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfileAutosave } from './profile-autosave';
import { EMPTY_SNAPSHOT, type ApplicationClient, type ApplicationSnapshot } from './application/types';

function setup() {
  let snapshot: ApplicationSnapshot = { ...EMPTY_SNAPSHOT, status: 'unlocked', profileReady: true,
    account: { serverUrl: 'https://a.test', email: 'a@test.com', userId: '', kdf: { kdf: 0, iterations: 1 } },
    profile: { displayName: 'Before', avatarDataUrl: null }, profileVersion: '1' };
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
    const preferences = { mode: 'light' as const, palette: 'ayu', showTypes: false };
    store.editProfile({ displayName: 'Together' }); store.editPreferences(preferences); await store.flush();
    expect(client.getSnapshot().profile?.displayName).toBe('Together');
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith(preferences, null);
    store.editProfile({ displayName: 'After unlock' }); update({ status: 'locked' }); await store.flush();
    update({ status: 'unlocked' }); await store.flush(); expect(client.getSnapshot().profile?.displayName).toBe('After unlock'); store.stop();
  });
});
