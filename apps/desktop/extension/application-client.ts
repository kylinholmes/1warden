import { createApplicationClient } from '../src/application/client';
import type { ApplicationClient, ApplicationMethod, ApplicationRequest, ApplicationService, SiteContext } from '../src/application/types';
import { ext } from './ext-api';
import { downloadFile } from './download-file';
import { LOCAL_READS, type SerializedError } from './application-rpc';
import { createConnectionDraftStore } from './connection-draft';
import { lockedAccount } from '../src/application/account-target';

type Reply<T> = { ok: true; result: T } | { ok: false; error: SerializedError };

async function request<T>(message: unknown, timeoutMs?: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = ext.runtime.sendMessage(message) as Promise<Reply<T> | undefined>;
    const response = await (timeoutMs === undefined ? pending : Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('扩展后台响应超时，请重试')), timeoutMs);
      }),
    ]));
    if (!response) throw new Error('扩展后台没有响应，请重试');
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  } catch (error) {
    if (error instanceof Error && /Receiving end does not exist|Extension context invalidated/i.test(error.message)) {
      throw new Error('扩展后台未连接，请重试；若仍失败，请在扩展管理页重新加载 1Warden。', { cause: error });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function call<K extends ApplicationMethod>(method: K, ...args: Parameters<ApplicationService[K]>): ReturnType<ApplicationService[K]> {
  // Local reads are bounded. Never time out/replay a server mutation here.
  return request({ type: '1warden:application', method, args } as ApplicationRequest,
    LOCAL_READS.has(method) ? 5_000 : undefined) as ReturnType<ApplicationService[K]>;
}

function clearCaptureLink(id: string): void {
  try {
    if (location.hash.startsWith('#capture=') && decodeURIComponent(location.hash.slice(9)) === id) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch { /* An unrelated malformed link must not be removed. */ }
}

/** Called only after the clipboard write succeeds, from the shared clipboard helper. */
export function scheduleExtensionClipboardClear(value: string): Promise<void> {
  return request({ type: '1warden:clipboard-copied', value });
}

export function createExtensionApplicationClient(): ApplicationClient {
  const service: ApplicationService = {
    snapshot: () => call('snapshot'),
    sync: () => call('sync'),
    listTrash: () => call('listTrash'),
    restoreItem: (...args) => call('restoreItem', ...args),
    saveProfile: (...args) => call('saveProfile', ...args),
    savePreferences: (...args) => call('savePreferences', ...args),
    recordDevice: (...args) => call('recordDevice', ...args),
    connect: (...args) => call('connect', ...args),
    connectWithTwoFactor: (...args) => call('connectWithTwoFactor', ...args),
    unlock: (...args) => call('unlock', ...args),
    switchAccount: (...args) => call('switchAccount', ...args),
    lock: () => call('lock'), logout: () => call('logout'),
    search: (...args) => call('search', ...args), getItem: (...args) => call('getItem', ...args),
    getDraft: (...args) => call('getDraft', ...args), saveItem: (...args) => call('saveItem', ...args),
    toggleFavorite: (...args) => call('toggleFavorite', ...args), moveToTrash: (...args) => call('moveToTrash', ...args),
    moveToFolder: (...args) => call('moveToFolder', ...args),
    deletePermanently: (...args) => call('deletePermanently', ...args),
    createFolder: (...args) => call('createFolder', ...args), renameFolder: (...args) => call('renameFolder', ...args),
    deleteFolder: (...args) => call('deleteFolder', ...args), reveal: (...args) => call('reveal', ...args),
    totp: (...args) => call('totp', ...args), downloadAttachment: (...args) => call('downloadAttachment', ...args),
    uploadAttachment: (...args) => call('uploadAttachment', ...args),
    deleteAttachment: (...args) => call('deleteAttachment', ...args),
    removePasskey: (...args) => call('removePasskey', ...args),
    clearPasswordHistory: (...args) => call('clearPasswordHistory', ...args),
    securityReport: (...args) => call('securityReport', ...args), organizationReport: () => call('organizationReport'), checkBreaches: () => call('checkBreaches'),
    previewMerge: (...args) => call('previewMerge', ...args), mergeItems: (...args) => call('mergeItems', ...args),
    revealMergeValue: (...args) => call('revealMergeValue', ...args),
    exportVault: (...args) => call('exportVault', ...args),
    parseImport: (...args) => call('parseImport', ...args), importData: (...args) => call('importData', ...args),
    previewAccountImport: (...args) => call('previewAccountImport', ...args),
    importAccount: (...args) => call('importAccount', ...args),
    previewBulkDelete: (...args) => call('previewBulkDelete', ...args),
    commitBulkDelete: (...args) => call('commitBulkDelete', ...args),
  };
  const client = createApplicationClient(service, {
    capabilities: { native: false, browser: true, saveAttachments: true },
    browser: {
      credentials: {
        list: async () => {
          const captureId = location.hash.startsWith('#capture=') ? decodeURIComponent(location.hash.slice(9)) : undefined;
          try {
            return await request({ type: '1warden:credential-list', application: true,
              ...(captureId !== undefined ? { captureId } : {}) }, 5_000);
          } catch (error) {
            // Preserve the expiry explanation once; Retry then loads the current queue.
            // Network failures must retain the requested link.
            if (captureId !== undefined && (error as { kind?: string } | null)?.kind === 'captureExpired') clearCaptureLink(captureId);
            throw error;
          }
        },
        save: async choice => { await request({ type: '1warden:credential-save', choice, application: true }); clearCaptureLink(choice.captureId); },
        dismiss: async id => { await request({ type: '1warden:credential-dismiss', id, application: true }); clearCaptureLink(id); },
        history: () => request({ type: '1warden:credential-history', application: true }, 5_000),
        revealHistory: id => request({ type: '1warden:credential-reveal-history', id, application: true }, 5_000),
        deleteHistory: id => request({ type: '1warden:credential-delete-history', id, application: true }),
        recoverHistory: id => request({ type: '1warden:credential-recover-history', id, application: true }),
      },
      context: () => request<SiteContext>({ type: '1warden:context' }),
      fill: (itemId, tabId) => request({ type: '1warden:fill', itemId, tabId, application: true }),
    },
    saveFile: (fileName, dataBase64) => downloadFile(ext.downloads, fileName, dataBase64),
    subscribeRemote(listener) {
      const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
        if (sender.id === ext.runtime.id && sender.tab === undefined && typeof message === 'object' && message !== null
          && (message as { type?: string }).type === '1warden-internal:changed') listener();
        return undefined;
      };
      ext.runtime.onMessage.addListener(onMessage);
      return () => ext.runtime.onMessage.removeListener(onMessage);
    },
  });
  client.connectionDraft = createConnectionDraftStore(ext.storage.session);
  const switchAccount = client.switchAccount;
  client.switchAccount = async (target) => {
    if (target) lockedAccount(target);
    const previous = client.getSnapshot().account;
    // App observes the empty snapshot immediately. Prepare its next form before that publication.
    if (!target && previous) await client.connectionDraft!.save({ serverUrl: '', email: '', error: null,
      returnAccount: { serverUrl: previous.serverUrl, email: previous.email },
    });
    else await client.connectionDraft!.clear();
    await switchAccount(target);
  };
  return client;
}
