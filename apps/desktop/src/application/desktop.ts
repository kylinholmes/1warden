import { VaultClient } from '@coffer/vault';
import { host, IS_DESKTOP, kdfCache, syncCache } from '@coffer/ui';
import { fromBase64 } from '@coffer/crypto';
import { canSaveFiles, saveFile } from '../save';
import { tauriAvailable } from '../capabilities';
import type { ConnectionDraft } from './types';
import { createApplicationClient } from './client';
import { createProfileCache } from './profile-cache';
import { createAccountSessions } from './account-sessions';
import { lockedAccount } from './account-target';

export function createDesktopApplication() {
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const sessions = createAccountSessions(() => new VaultClient({
    fetchImpl: host().fetch,
    autoLockMs: 15 * 60 * 1000,
    onLock: changed, onStatus: changed, onSync: changed,
    syncCache, kdfCache,
  }), createProfileCache(host().storage));
  sessions.subscribeActiveVault(changed);
  const client = createApplicationClient(sessions.service, {
    capabilities: { native: IS_DESKTOP && tauriAvailable(), browser: false, saveAttachments: canSaveFiles() },
    saveFile: (name, data) => saveFile(name, fromBase64(data)),
    subscribeRemote(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  // The native window keeps connection drafts in memory; extensions use storage.session.
  let draft: ConnectionDraft | null = null;
  client.connectionDraft = {
    load: async () => draft ? structuredClone(draft) : null,
    save: async (value) => { draft = { ...value,
      ...(draft?.returnAccount ? { returnAccount: draft.returnAccount } : {}),
    }; },
    clear: async () => { draft = null; },
  };
  const switchAccount = client.switchAccount;
  client.switchAccount = async (target) => {
    if (target) lockedAccount(target);
    const previous = sessions.getActiveVault().getSession().account;
    // switchAccount immediately publishes the connection screen, whose first read needs this draft.
    draft = target || !previous ? null : { serverUrl: '', email: '', error: null,
      returnAccount: { serverUrl: previous.serverUrl, email: previous.email },
    };
    await switchAccount(target);
  };
  return { client, get vault() { return sessions.getActiveVault(); },
    getActiveVault: sessions.getActiveVault, subscribeActiveVault: sessions.subscribeActiveVault };
}
