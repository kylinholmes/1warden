import { DEFAULT_PROFILE_PREFERENCES, type ProfilePreferences, type UserProfile } from '@1warden/vault';
import { accountKey } from './application/account-target';
import { createStore } from '@1warden/state';
import type { ApplicationClient, ApplicationSnapshot } from './application/types';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
export interface SaveField<T> { value: T; status: SaveStatus; error: string | null }
interface Draft<T> extends SaveField<T> { base: T | null; dirty: boolean }
interface Entry { profile: Draft<UserProfile>; preferences: Draft<ProfilePreferences> }
export interface AutosaveSnapshot { profile: SaveField<UserProfile>; preferences: SaveField<ProfilePreferences> }
const emptyProfile = (): UserProfile => ({ displayName: '', avatarDataUrl: null });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s: ApplicationSnapshot) => s.account ? accountKey(s.account) : null;
const ready = (s: ApplicationSnapshot) => s.status === 'unlocked' && s.profileReady && !s.profileError && !s.profileSettingsError;
const draft = <T>(value: T, base: T | null = value): Draft<T> => ({ value, base, dirty: false, status: 'idle', error: null });

/** App-owned, memory-only drafts survive page navigation, but never cross account identities.
 * Authentication changes park pending edits; returning to a verified account resumes them.
 * Only explicit edits enqueue writes. Remote snapshots never echo a preference save.
 */
export function createProfileAutosave(client: ApplicationClient) {
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let running: Promise<void> | null = null;
  let started = false;
  const blank: Entry = { profile: draft(emptyProfile()), preferences: draft({ ...DEFAULT_PROFILE_PREFERENCES }, null) };
  const state = createStore<AutosaveSnapshot>(() => blank);
  function entry(): Entry {
    const s = client.getSnapshot(); const key = identity(s);
    if (!key) return blank;
    let value = entries.get(key);
    if (!value) {
      value = { profile: draft(s.profile ?? emptyProfile()), preferences: draft(s.profileSettings?.preferences ?? { ...DEFAULT_PROFILE_PREFERENCES }, s.profileSettings?.preferences ?? null) };
      entries.set(key, value);
    }
    return value;
  }
  function emit() {
    const value = entry();
    state.setState({ profile: { ...value.profile }, preferences: { ...value.preferences } }, true);
  }
  function cancelTimer() { clearTimeout(timer); timer = undefined; }
  function schedule() {
    cancelTimer();
    if (started && ready(client.getSnapshot()) && [entry().profile, entry().preferences].some(f => f.dirty && !f.error)) {
      timer = setTimeout(() => { void flush(); }, 650);
    }
  }
  function observe() {
    const s = client.getSnapshot(); const value = entry();
    if (ready(s)) {
      if (!value.profile.dirty) value.profile = { ...value.profile, base: s.profile ?? emptyProfile(), value: s.profile ?? emptyProfile() };
      if (!value.preferences.dirty) value.preferences = { ...value.preferences, base: s.profileSettings?.preferences ?? null, value: s.profileSettings?.preferences ?? { ...DEFAULT_PROFILE_PREFERENCES } };
    }
    emit(); schedule();
  }
  function edit<T>(field: Draft<T>, value: T) {
    field.value = value; field.dirty = true; field.status = 'pending'; field.error = null;
    emit(); schedule();
  }
  async function drain() {
    // Serialized metadata writes are necessary: profile and preferences share one cipher.
    while (ready(client.getSnapshot())) {
      const s = client.getSnapshot(); const key = identity(s); const value = entry();
      const kind = value.profile.dirty && !value.profile.error ? 'profile' : value.preferences.dirty && !value.preferences.error ? 'preferences' : null;
      if (!kind) break;
      const field = value[kind]; const sent = field.value;
      const remote = kind === 'profile' ? s.profile ?? emptyProfile() : s.profileSettings?.preferences ?? null;
      if (same(remote, sent)) { field.dirty = false; field.status = 'saved'; field.base = remote as never; emit(); continue; }
      if (!same(remote, field.base)) {
        field.error = '此部分已被其他设备修改。你的修改仍在本页；可放弃修改后查看最新资料。'; field.status = 'error'; emit(); continue;
      }
      field.status = 'saving'; emit();
      try {
        if (kind === 'profile') await client.saveProfile(sent as UserProfile, s.profileVersion);
        else await client.savePreferences(sent as ProfilePreferences, field.base as ProfilePreferences | null);
        const latest = client.getSnapshot();
        const acknowledged = identity(latest) === key && ready(latest)
          ? kind === 'profile' ? latest.profile ?? sent : latest.profileSettings?.preferences ?? sent : sent;
        field.base = acknowledged as never;
        field.dirty = !same(sent, field.value);
        if (!field.dirty) field.value = acknowledged as never;
        field.status = field.dirty ? 'pending' : 'saved';
      } catch (e) {
        field.error = e instanceof Error ? e.message : '保存失败，请重试'; field.status = 'error';
      }
      emit();
      // Never continue a batch on a different active identity.
      if (identity(client.getSnapshot()) !== key) break;
    }
  }
  function flush(): Promise<void> {
    cancelTimer();
    if (running) return running;
    running = drain().finally(() => { running = null; schedule(); });
    return running;
  }
  // Initialize once so Zustand selectors always receive a cached snapshot.
  emit();
  return {
    getSnapshot: state.getState,
    subscribe: state.subscribe,
    start: () => { started = true; unsubscribe?.(); unsubscribe = client.subscribe(observe); observe(); },
    stop: () => { started = false; unsubscribe?.(); unsubscribe = undefined; cancelTimer(); },
    editProfile: (patch: Partial<UserProfile>) => { if (ready(client.getSnapshot())) edit(entry().profile, { ...entry().profile.value, ...patch }); },
    editPreferences: (value: ProfilePreferences) => { if (ready(client.getSnapshot())) edit(entry().preferences, value); },
    pendingPreferences: () => entry().preferences.dirty ? entry().preferences.value : null,
    flush,
    retry: (kind: keyof Entry) => { const field = entry()[kind]; field.error = null; field.status = 'pending'; emit(); return flush(); },
    discard: (kind: keyof Entry) => { const field = entry()[kind]; if (field.status === 'saving') return; field.dirty = false; field.error = null; field.status = 'idle'; observe(); },
    forget: (key = identity(client.getSnapshot())) => { if (key) entries.delete(key); emit(); },
  };
}
export type ProfileAutosave = ReturnType<typeof createProfileAutosave>;
