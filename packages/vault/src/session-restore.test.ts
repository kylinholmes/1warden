import { describe, it, expect } from 'vitest';
import { makeUserKey } from '@1warden/crypto';
import { VaultSession, restoreSession, type AccountInfo } from './session';
import { emptyLogin, type VaultItem, type VaultFolder } from './model';

const ACCOUNT: AccountInfo = {
  serverUrl: 'http://127.0.0.1:8080', email: 'a@b.test', userId: 'u1',
  kdf: { kdf: 0, iterations: 600000 },
};

function item(id: string): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: emptyLogin(), card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const FOLDER: VaultFolder = { id: 'f1', name: '工作', nameFailed: false, updatedAt: '' };

/**
 * ⚠️ 这条恢复路径是为**进程重启**准备的。
 *
 * service worker 约 30 秒空闲就被杀，模块变量全部归零。下次有消息时模块
 * 重新执行，`client` 是新的 —— 一个 `loggedOut` 的会话对象。而
 * `chrome.storage.session` 里的密钥**还在**（那是另一个进程/存储区）。
 *
 * 没有这条路径的话，表现是：用户明明刚解锁过，操作却报「保险库未解锁」，
 * 而且刷新页面就好、过一会儿又坏 —— 最难查的那种。
 */
describe('restoreSession —— 重启后把会话灌回来', () => {
  it('brings a fresh session back to unlocked with its key and data', () => {
    const s = new VaultSession();
    const key = makeUserKey();

    restoreSession(s, { account: ACCOUNT, userKey: key, items: [item('1')], folders: [FOLDER] });

    expect(s.status).toBe('unlocked');
    expect(s.isUnlocked()).toBe(true);
    expect(s.getKey()).toEqual(key);
    expect(s.items.map((i) => i.id)).toEqual(['1']);
    expect(s.folders).toEqual([FOLDER]);
  });

  /** 唤醒时可能已经有别的消息先完成了恢复 —— 第二次不能把状态倒回去 */
  it('is a no-op on an already unlocked session', () => {
    const s = new VaultSession();
    const first = makeUserKey();
    restoreSession(s, { account: ACCOUNT, userKey: first, items: [item('1')], folders: [] });

    const second = makeUserKey();
    restoreSession(s, { account: ACCOUNT, userKey: second, items: [item('2')], folders: [] });

    // 密钥和数据都还是第一次的 —— 不能把用户已经看到的东西换掉
    expect(s.getKey()).toEqual(first);
    expect(s.items.map((i) => i.id)).toEqual(['1']);
  });

  /**
   * ⚠️ 数组必须**拷贝**，不能直接把存储里那份引用进来。
   * 两边共享同一个数组的话，一次写入会同时改到「会话里看到的」和
   * 「下次要存回去的」，而且改坏了不会有人报错。
   */
  it('copies the arrays instead of aliasing them', () => {
    const s = new VaultSession();
    const items = [item('1')];
    const folders = [FOLDER];
    restoreSession(s, { account: ACCOUNT, userKey: makeUserKey(), items, folders });

    expect(s.items).not.toBe(items);
    expect(s.folders).not.toBe(folders);
  });

  it('leaves the account readable so the UI can show who is signed in', () => {
    const s = new VaultSession();
    restoreSession(s, { account: ACCOUNT, userKey: makeUserKey(), items: [], folders: [] });
    expect(s.account?.email).toBe('a@b.test');
  });
});
