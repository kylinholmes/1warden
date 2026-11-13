import { DEFAULT_PROFILE_PREFERENCES, type ProfilePreferences, type UserProfile } from '@1warden/vault';
import { accountKey } from './application/account-target';
import { createStore } from '@1warden/state';
import type { ApplicationClient, ApplicationSnapshot } from './application/types';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
export interface SaveField<T> { value: T; status: SaveStatus; error: string | null }
interface Draft<T> extends SaveField<T> { base: T | null; baseKnown: boolean; patch: Partial<T>; dirty: boolean }
interface Entry { profile: Draft<UserProfile>; preferences: Draft<ProfilePreferences>; dueAt: number }
export interface AutosaveSnapshot { profile: SaveField<UserProfile>; preferences: SaveField<ProfilePreferences> }
type SaveKind = keyof AutosaveSnapshot;
export interface FlushResult { saved: boolean; pending: SaveKind[] }
export const UNSAVED_PROFILE_MESSAGE = '个人资料或外观偏好尚未保存，暂未退出或切换账户。请回到用户详情或设置中的外观页面重试保存，或明确放弃修改后再试。';
const emptyProfile = (): UserProfile => ({ displayName: '', avatarDataUrl: null });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s: ApplicationSnapshot) => s.account ? accountKey(s.account) : null;
const ready = (s: ApplicationSnapshot) => s.status === 'unlocked' && s.profileReady && !s.syncing && !s.syncError && !s.profileError && !s.profileSettingsError;
const draft = <T>(value: T, base: T | null = value, baseKnown = true): Draft<T> => ({ value, base, baseKnown, patch: {}, dirty: false, status: 'idle', error: null });

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
  const blank: Entry = { profile: draft(emptyProfile()), preferences: draft({ ...DEFAULT_PROFILE_PREFERENCES }, null), dueAt: 0 };
  const state = createStore<AutosaveSnapshot>(() => blank);
  function entry(): Entry {
    const s = client.getSnapshot(); const key = identity(s);
    if (!key) return blank;
    let value = entries.get(key);
    if (!value) {
      value = { profile: draft(s.profile ?? emptyProfile(), s.profile ?? emptyProfile(), ready(s)),
        preferences: draft(s.profileSettings?.preferences ?? { ...DEFAULT_PROFILE_PREFERENCES }, s.profileSettings?.preferences ?? null, ready(s)), dueAt: 0 };
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
    const value = entry();
    if (started && !running && ready(client.getSnapshot()) && [value.profile, value.preferences].some(f => f.dirty && !f.error)) {
      // Only an edit moves the deadline. Sync notifications must not keep
      // postponing a save beyond every brief window of verified readiness.
      timer = setTimeout(() => { void flush(); }, Math.max(0, value.dueAt - Date.now()));
    }
  }
  function canEditPreferences() {
    const s = client.getSnapshot();
    // Editing a local draft does not require network verification. Only drain()
    // may write; it still requires a verified, error-free snapshot.
    return s.status === 'unlocked' && identity(s) !== null;
  }
  function canEditProfile() {
    const s = client.getSnapshot();
    return canEditPreferences() && !s.profileError && !s.profileSettingsError;
  }
  function reconcile<T extends object>(field: Draft<T>, remote: T | null, fallback: T) {
    if (!field.dirty) {
      field.base = remote; field.value = remote ?? fallback; field.baseKnown = true;
    } else if (!field.baseKnown) {
      // The first sync establishes the base. Apply only explicitly edited fields
      // so a preview cannot replace settings that had not been loaded yet.
      // No remote preferences means the account's visible local migration/cache
      // is still the fallback. A non-null remote always owns untouched fields.
      field.base = remote; field.value = { ...(remote ?? field.value), ...field.patch }; field.baseKnown = true;
    }
  }
  function observe() {
    const s = client.getSnapshot(); const value = entry();
    if (ready(s)) {
      reconcile(value.profile, s.profile ?? emptyProfile(), emptyProfile());
      reconcile(value.preferences, s.profileSettings?.preferences ?? null, { ...DEFAULT_PROFILE_PREFERENCES });
    }
    emit(); schedule();
  }
  function edit<T>(field: Draft<T>, patch: Partial<T>) {
    field.value = { ...field.value, ...patch }; field.patch = { ...field.patch, ...patch };
    field.dirty = true; field.status = 'pending'; field.error = null;
    entry().dueAt = Date.now() + 650;
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
      if (same(remote, sent)) { field.dirty = false; field.patch = {}; field.status = 'saved'; field.base = remote as never; emit(); continue; }
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
        if (!field.dirty) { field.value = acknowledged as never; field.patch = {}; }
        field.status = field.dirty ? 'pending' : 'saved';
      } catch (e) {
        field.error = e instanceof Error ? e.message : '保存失败，请重试'; field.status = 'error';
      }
      emit();
      // Never continue a batch on a different active identity.
      if (identity(client.getSnapshot()) !== key) break;
    }
  }
  async function flush(): Promise<FlushResult> {
    // Capture this account's entry before awaiting. A lock/account change must
    // never make its parked draft look like a successful flush of the new one.
    const value = entry();
    cancelTimer();
    if (!running) running = drain().finally(() => { running = null; schedule(); });
    await running;
    const pending = (['profile', 'preferences'] as const).filter(kind => value[kind].dirty);
    return { saved: pending.length === 0, pending };
  }
  // Initialize once so Zustand selectors always receive a cached snapshot.
  emit();
  return {
    getSnapshot: state.getState,
    subscribe: state.subscribe,
    start: () => { started = true; unsubscribe?.(); unsubscribe = client.subscribe(observe); observe(); },
    stop: () => { started = false; unsubscribe?.(); unsubscribe = undefined; cancelTimer(); },
    canEditProfile,
    editProfile: (patch: Partial<UserProfile>) => { if (canEditProfile()) edit(entry().profile, patch); },
    canEditPreferences,
    editPreferences: (patch: Partial<ProfilePreferences>, preview?: ProfilePreferences) => {
      if (!canEditPreferences()) return;
      const field = entry().preferences;
      // Preserve the account's migrated local appearance when the server has no
      // preferences. An unknown base still replaces untouched fields at sync.
      if (!field.dirty && field.base === null && preview) field.value = preview;
      edit(field, patch);
    },
    pendingPreferences: () => entry().preferences.dirty ? entry().preferences.value : null,
    flush,
    retry: (kind: SaveKind) => { const field = entry()[kind]; field.error = null; field.status = 'pending'; emit(); return flush(); },
    discard: (kind: SaveKind) => { const field = entry()[kind]; if (field.status === 'saving') return;
      field.dirty = false; field.patch = {}; field.error = null; field.status = 'idle';
      field.value = (field.base ?? (kind === 'profile' ? emptyProfile() : { ...DEFAULT_PROFILE_PREFERENCES })) as never; observe(); },
    forget: (key = identity(client.getSnapshot())) => {
      const value = key ? entries.get(key) : undefined;
      if (value && (value.profile.dirty || value.preferences.dirty)) throw new Error(UNSAVED_PROFILE_MESSAGE);
      if (key) entries.delete(key); emit();
    },
  };
}
export type ProfileAutosave = ReturnType<typeof createProfileAutosave>;
