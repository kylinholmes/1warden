import { lockedAccount } from '../src/application/account-target';
import { validateProfile, validatePreferences, validateDevice } from '@1warden/vault';
import type { ApplicationMethod, ApplicationRequest, ApplicationService } from '../src/application/types';

type Sender = { id?: string | undefined; url?: string | undefined; frameId?: number | undefined; tab?: { id?: number | undefined } | undefined };
type Runtime = { id: string; getURL(path: string): string };

const contentRequests = new Set(['1warden:fields', '1warden:submitted', '1warden:webauthn']);
const inlineRequests = new Set(['1warden:inline-accounts', '1warden:inline-fill', '1warden:inline-unlock']);
const pageRequests = new Set([
  '1warden:application', '1warden:context', '1warden:fill', '1warden:save-capture',
  '1warden:dismiss-capture', '1warden:clipboard-copied',
  // Existing automation clients; the application itself uses only the typed API.
  '1warden:connect', '1warden:list', '1warden:matches', '1warden:pending', '1warden:copy', '1warden:lock',
]);

/** Extension IDs alone do not distinguish content scripts from the trusted UI. */
export function authorizeRequest(type: string, sender: Sender, runtime: Runtime): void {
  if (sender.id !== runtime.id || !sender.url) throw new Error('未经授权的扩展请求');
  let source: URL;
  try { source = new URL(sender.url); } catch { throw new Error('无效的请求来源'); }
  if (inlineRequests.has(type)) {
    if (Number.isInteger(sender.tab?.id) && sender.tab!.id! >= 0 && sender.frameId === 0
      && (source.protocol === 'https:' || source.protocol === 'http:')) return;
    throw new Error('账号选择只能由当前网页的顶层内容脚本发出');
  }
  if (contentRequests.has(type)) {
    if (sender.tab?.id !== undefined && (source.protocol === 'https:' || source.protocol === 'http:')) return;
    throw new Error('此请求只能由网页内容脚本发出');
  }
  const page = new URL(runtime.getURL('popup.html'));
  if (pageRequests.has(type) && source.protocol === page.protocol && source.host === page.host
    && source.pathname === page.pathname) return;
  throw new Error('此请求只能由保险库界面发出');
}

export interface SerializedError {
  message: string;
  kind?: string;
  twoFactorRequired?: boolean;
  providers?: number[];
  providersInfo?: unknown;
}

export function serializeError(error: unknown): SerializedError {
  const out: SerializedError = { message: error instanceof Error ? error.message : String(error) };
  if (typeof error !== 'object' || error === null) return out;
  const e = error as Record<string, unknown>;
  if (typeof e['message'] === 'string') out.message = e['message'];
  if (typeof e['kind'] === 'string') out.kind = e['kind'];
  if (typeof e['twoFactorRequired'] === 'boolean') out.twoFactorRequired = e['twoFactorRequired'];
  if (Array.isArray(e['providers']) && e['providers'].every((p) => typeof p === 'number')) out.providers = e['providers'];
  if (e['providersInfo'] !== undefined) out.providersInfo = e['providersInfo'];
  return out;
}

export interface SerialRunner {
  <T>(operation: () => Promise<T>): Promise<T>;
  /** Retire this generation without waiting for its pending network requests. */
  reset(): void;
}

const cancelled = () => new Error('请求已取消，保险库已锁定');

/** Writes stay ordered within an unlock generation; locking cancels that generation immediately. */
export function createSerialRunner(): SerialRunner {
  let tail: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  const cancellations = new Set<() => void>();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const version = epoch;
    let cancel!: () => void;
    const cancellation = new Promise<T>((_resolve, reject) => { cancel = () => reject(cancelled()); });
    cancellations.add(cancel);
    const executing = tail.then(() => {
      if (version !== epoch) throw cancelled();
      return operation();
    });
    const result = Promise.race([executing, cancellation]);
    tail = result.catch(() => {});
    void result.then(() => cancellations.delete(cancel), () => cancellations.delete(cancel));
    return result;
  };
  run.reset = () => {
    epoch++;
    for (const cancel of cancellations) cancel();
    cancellations.clear();
    tail = Promise.resolve();
  };
  return run;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown) => typeof v === 'string';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const none = (args: unknown[]) => args.length === 0;
const strings = (count: number) => (args: unknown[]) => args.length === count && args.every(string);
const file = (v: unknown) => object(v) && string(v['name']) && string(v['dataBase64']) && string(v['format']);
const validators: Record<ApplicationMethod, (args: unknown[]) => boolean> = {
  snapshot: none,
  switchAccount: (a) => {
    if (a.length !== 1) return false;
    if (a[0] === null) return true;
    try { lockedAccount(a[0] as never); return true; } catch { return false; }
  },
  saveProfile: (a) => {
    if (a.length !== 2 || (a[1] !== null && !string(a[1]))) return false;
    try { validateProfile(a[0]); return true; } catch { return false; }
  },
  savePreferences: (a) => {
    if (a.length !== 2) return false;
    try { validatePreferences(a[0]); if (a[1] !== null) validatePreferences(a[1]); return true; } catch { return false; }
  },
  recordDevice: (a) => {
    if (a.length !== 1) return false;
    try { validateDevice(a[0]); return true; } catch { return false; }
  },
  connect: (a) => {
    const params = a[0];
    return a.length === 1 && object(params) && ['serverUrl', 'email', 'masterPassword'].every((k) => string(params[k]));
  },
  connectWithTwoFactor: (a) => a.length === 3 && string(a[0]) && number(a[1]) && typeof a[2] === 'boolean',
  unlock: strings(1), lock: none, logout: none, search: strings(1), getItem: strings(1), getDraft: strings(1),
  saveItem: (a) => a.length === 1 && object(a[0]) && string(a[0]['id']),
  toggleFavorite: strings(1), moveToTrash: strings(1), deletePermanently: strings(1),
  createFolder: strings(1), renameFolder: strings(2), deleteFolder: strings(1),
  reveal: (a) => {
    if (a.length !== 2 || !string(a[0]) || !object(a[1])) return false;
    const field = a[1];
    return ['password', 'cardNumber', 'cardCode', 'privateKey'].includes(String(field['kind']))
      || (['custom', 'history'].includes(String(field['kind'])) && Number.isInteger(field['index']) && Number(field['index']) >= 0);
  },
  totp: strings(1), downloadAttachment: strings(2), securityReport: (a) => a.length === 1 && number(a[0]),
  checkBreaches: none, parseImport: (a) => a.length === 1 && file(a[0]), importData: (a) => a.length === 1 && file(a[0]),
};

const mutations = new Set<ApplicationMethod>([
  'connect', 'connectWithTwoFactor', 'unlock', 'lock', 'logout', 'switchAccount', 'saveItem', 'saveProfile', 'savePreferences', 'recordDevice', 'toggleFavorite',
  'moveToTrash', 'deletePermanently', 'createFolder', 'renameFolder', 'deleteFolder', 'importData',
]);

/** In-memory reads must not wait for network writes or an unresponsive webpage. */
export const LOCAL_READS = new Set<ApplicationMethod>([
  'snapshot', 'search', 'getItem', 'getDraft', 'reveal', 'totp', 'securityReport',
]);

function invoke(service: ApplicationService, request: ApplicationRequest): Promise<unknown> {
  // Explicit dispatch prevents inherited methods or new VaultClient methods from becoming RPCs.
  switch (request.method) {
    case 'saveProfile': return service.saveProfile(...request.args);
    case 'savePreferences': return service.savePreferences(...request.args);
    case 'recordDevice': return service.recordDevice(...request.args);
    case 'switchAccount': return service.switchAccount(...request.args);
    case 'snapshot': return service.snapshot(...request.args);
    case 'connect': return service.connect(...request.args);
    case 'connectWithTwoFactor': return service.connectWithTwoFactor(...request.args);
    case 'unlock': return service.unlock(...request.args);
    case 'lock': return service.lock(...request.args);
    case 'logout': return service.logout(...request.args);
    case 'search': return service.search(...request.args);
    case 'getItem': return service.getItem(...request.args);
    case 'getDraft': return service.getDraft(...request.args);
    case 'saveItem': return service.saveItem(...request.args);
    case 'toggleFavorite': return service.toggleFavorite(...request.args);
    case 'moveToTrash': return service.moveToTrash(...request.args);
    case 'deletePermanently': return service.deletePermanently(...request.args);
    case 'createFolder': return service.createFolder(...request.args);
    case 'renameFolder': return service.renameFolder(...request.args);
    case 'deleteFolder': return service.deleteFolder(...request.args);
    case 'reveal': return service.reveal(...request.args);
    case 'totp': return service.totp(...request.args);
    case 'downloadAttachment': return service.downloadAttachment(...request.args);
    case 'securityReport': return service.securityReport(...request.args);
    case 'checkBreaches': return service.checkBreaches(...request.args);
    case 'parseImport': return service.parseImport(...request.args);
    case 'importData': return service.importData(...request.args);
  }
}

export function createApplicationDispatcher(service: ApplicationService | (() => ApplicationService), options: {
  run?: SerialRunner;
  beforeRequest?: () => Promise<void>;
  afterMutation?: (method: ApplicationMethod, succeeded: boolean) => Promise<void>;
  onChanged?: () => void;
} = {}) {
  const run = options.run ?? createSerialRunner();
  let epoch = 0;
  let lockBarrier: Promise<unknown> = Promise.resolve();
  const currentService = () => typeof service === 'function' ? service() : service;
  return async function dispatch(input: unknown): Promise<unknown> {
    if (!object(input) || typeof input['method'] !== 'string' || !Object.hasOwn(validators, input['method'])
      || !Array.isArray(input['args'])) throw new Error('无效的保险库操作');
    const method = input['method'] as ApplicationMethod;
    if (!validators[method](input['args'])) throw new Error('无效的操作参数');
    const request = input as ApplicationRequest;
    if (method === 'lock' || method === 'logout' || method === 'switchAccount') {
      epoch++;
      run.reset();
      // Invoke before the first await: the service destroys its key immediately.
      const locking = invoke(currentService(), request);
      const previousLock = lockBarrier;
      lockBarrier = (async () => {
        await locking;
        await previousLock.catch(() => {});
        await options.afterMutation?.(method, true);
        options.onChanged?.();
      })();
      return lockBarrier;
    }
    const version = epoch;
    const execute = async () => {
      await lockBarrier;
      if (version !== epoch) throw cancelled();
      if (options.beforeRequest) await options.beforeRequest();
      if (version !== epoch) throw cancelled();
      const activeService = currentService();
      let succeeded = false;
      try {
        const result = await invoke(activeService, request);
        if (version !== epoch) throw cancelled();
        succeeded = true;
        return result;
      } finally {
        if (version === epoch && mutations.has(method)) {
          // A failed import can have already committed rows; persist that state too.
          await options.afterMutation?.(method, succeeded);
          if (version === epoch) options.onChanged?.();
        }
      }
    };
    // Browsing must not wait for a pending login, sync, write, or webpage message.
    // Restoration, lock cleanup, and generation checks still apply to this read.
    if (!LOCAL_READS.has(method)) return run(execute);
    try { return await execute(); }
    catch (error) {
      // Restoration can discover expiry and lock the old generation. Only this
      // side-effect-free read may restart to return the current locked snapshot.
      if (method === 'snapshot' && version !== epoch) return dispatch(input);
      throw error;
    }
  };
}
