import {
  EMPTY_SNAPSHOT, type ApplicationCapabilities, type ApplicationClient,
  type ApplicationMethod, type ApplicationService, type ApplicationSnapshot, type BrowserActions,
} from './types';

export const APPLICATION_METHODS = [
  'snapshot', 'connect', 'connectWithTwoFactor', 'unlock', 'lock', 'logout', 'switchAccount', 'search',
  'getItem', 'getDraft', 'saveProfile', 'saveItem', 'toggleFavorite', 'moveToTrash', 'deletePermanently',
  'createFolder', 'renameFolder', 'deleteFolder', 'reveal', 'totp', 'downloadAttachment',
  'securityReport', 'checkBreaches', 'parseImport', 'importData',
] as const satisfies readonly ApplicationMethod[];

const MUTATIONS = new Set<ApplicationMethod>([
  'connect', 'connectWithTwoFactor', 'unlock', 'lock', 'logout', 'switchAccount', 'saveItem', 'saveProfile',
  'toggleFavorite', 'moveToTrash', 'deletePermanently', 'createFolder', 'renameFolder',
  'deleteFolder', 'importData',
]);

interface Options {
  capabilities: ApplicationCapabilities;
  browser?: BrowserActions;
  saveFile(fileName: string, dataBase64: string): Promise<{ path: string | null }>;
  subscribeRemote?: (refresh: () => void) => () => void;
}

/** Stable external-store snapshots and cancellation at account/lock boundaries. */
export function createApplicationClient(service: ApplicationService, options: Options): ApplicationClient {
  let current: ApplicationSnapshot = { ...EMPTY_SNAPSHOT };
  let epoch = 0;
  let request = 0;
  let disposed = false;
  let locking = 0;
  let unsubscribeRemote: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function publish(snapshot: ApplicationSnapshot) {
    const changedAccount = current.account !== null && (current.account.serverUrl !== snapshot.account?.serverUrl
      || current.account.email !== snapshot.account?.email);
    if (changedAccount || (current.status === 'unlocked' && (snapshot.status === 'locked' || snapshot.status === 'loggedOut'))) epoch++;
    current = snapshot;
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<void> {
    if (disposed || locking > 0) return;
    const version = epoch;
    const sequence = ++request;
    const snapshot = await service.snapshot();
    if (disposed || locking > 0 || version !== epoch || sequence !== request) return;
    publish(snapshot);
  }

  const operations = Object.fromEntries(APPLICATION_METHODS.map((method) => [method, async (...args: unknown[]) => {
    if (disposed) throw new Error('当前界面已关闭');
    const isLock = method === 'lock' || method === 'logout' || method === 'switchAccount';
    if (isLock) {
      epoch++;
      locking++;
      publish({ ...EMPTY_SNAPSHOT, revision: current.revision + 1,
        status: method === 'lock' && current.account ? 'locked' : 'loggedOut',
        account: method === 'lock' ? current.account : null,
        profile: method === 'lock' ? current.profile : null,
      });
    }
    const version = epoch;
    try {
      const operation = service[method] as (...values: unknown[]) => Promise<unknown>;
      const result = await operation(...args);
      if (disposed || version !== epoch) throw new Error('请求已过期，保险库可能已锁定');
      return result;
    } finally {
      if (isLock) locking--;
      // A partial import can change the vault before throwing; refresh failures must
      // not replace the original operation error or falsely report a failed save.
      if (MUTATIONS.has(method) && !disposed && version === epoch) {
        await refresh().catch(() => {});
      }
    }
  }])) as unknown as ApplicationService;

  return {
    ...operations,
    capabilities: options.capabilities,
    ...(options.browser ? { browser: options.browser } : {}),
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() {
      disposed = false;
      if (!unsubscribeRemote && options.subscribeRemote) {
        unsubscribeRemote = options.subscribeRemote(() => { void refresh().catch(() => {}); });
      }
      await refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      epoch++;
      request++;
      unsubscribeRemote?.();
      unsubscribeRemote = null;
      current = { ...EMPTY_SNAPSHOT };
      listeners.clear();
    },
    saveFile: options.saveFile,
  };
}
