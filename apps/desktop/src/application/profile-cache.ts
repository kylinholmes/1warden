import { validateProfile, type UserProfile } from '@coffer/vault';
import type { HostStorage } from '@coffer/ui';

type Account = { serverUrl: string; email: string };
export interface ProfileCache {
  load(account: Account): Promise<UserProfile | null>;
  save(account: Account, profile: UserProfile): Promise<void>;
  clear(account: Account): Promise<void>;
}

/** User-authorized presentation-only cache. Never pass full notes or vault records here. */
export function createProfileCache(storage: HostStorage): ProfileCache {
  let tail: Promise<unknown> = Promise.resolve();
  const key = (a: Account) => `profile.v1.${JSON.stringify([a.serverUrl.replace(/\/$/, ''), a.email.toLowerCase()])}`;
  function queued<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation); tail = next.catch(() => {}); return next;
  }
  return {
    load: (a) => queued(async () => {
      try { const raw = await storage.get(key(a)); return raw ? validateProfile(JSON.parse(raw)) : null; }
      catch { return null; }
    }),
    save: (a, value) => {
      const profile = validateProfile(value);
      return queued(async () => { try { await storage.set(key(a), JSON.stringify(profile)); } catch { /* cache is optional */ } });
    },
    clear: (a) => queued(async () => { await storage.remove(key(a)); }),
  };
}
