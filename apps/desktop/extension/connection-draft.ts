import type { ConnectionDraftStore } from '../src/application/types';
import { lockedAccount } from '../src/application/account-target';
import type { StorageArea } from './session-store';

export const CONNECTION_DRAFT_KEY = '1warden.connectionDraft';

function publicReturnAccount(value: unknown): { serverUrl: string; email: string } | undefined {
  try {
    const { serverUrl, email } = lockedAccount(value as Parameters<typeof lockedAccount>[0]);
    return { serverUrl, email };
  } catch { return undefined; }
}

/** Session storage survives popup closure and background restarts, without disk writes. */
export function createConnectionDraftStore(area: Pick<StorageArea, 'get' | 'set' | 'remove'>): ConnectionDraftStore {
  let writes: Promise<unknown> = Promise.resolve();
  function write(operation: () => Promise<void>): Promise<void> {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }
  return {
    async load() {
      await writes;
      const raw = (await area.get(CONNECTION_DRAFT_KEY))[CONNECTION_DRAFT_KEY];
      if (typeof raw !== 'object' || raw === null) return null;
      const draft = raw as Record<string, unknown>;
      if (typeof draft['serverUrl'] !== 'string' || typeof draft['email'] !== 'string') return null;
      const returnAccount = publicReturnAccount(draft['returnAccount']);
      return { serverUrl: draft['serverUrl'], email: draft['email'],
        error: typeof draft['error'] === 'string' ? draft['error'] : null,
        ...(returnAccount ? { returnAccount } : {}) };
    },
    save({ serverUrl, email, error, returnAccount: rawReturnAccount }) {
      // Whitelist fields: credentials passed by a caller must never persist here.
      const returnAccount = publicReturnAccount(rawReturnAccount);
      return write(() => area.set({ [CONNECTION_DRAFT_KEY]: { serverUrl, email, error,
        ...(returnAccount ? { returnAccount } : {}) } }));
    },
    clear() { return write(() => area.remove(CONNECTION_DRAFT_KEY)); },
  };
}
