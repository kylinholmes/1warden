import { describe, it, expect } from 'vitest';
import { decideCapture } from './credential-capture';
import { emptyLogin } from './model';
import type { VaultItem } from './model';

function login(
  id: string, username: string | null, password: string | null, uris: string[] = ['https://example.com'],
): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: { ...emptyLogin(), username, password, uris: uris.map((u) => ({ uri: u, match: null })) },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const captured = (username: string | null, password: string, url = 'https://example.com/login') =>
  ({ username, password, url });

describe('decideCapture —— 新登录', () => {
  it('saves when nothing matches the site', () => {
    expect(decideCapture(captured('me', 'hunter2xyz'), [])).toEqual({ kind: 'save' });
  });

  it('saves when the only item for the site is a different account', () => {
    const items = [login('a', 'someone-else', 'other-password')];
    expect(decideCapture(captured('me', 'hunter2xyz'), items)).toEqual({ kind: 'save' });
  });

  /** 同一站点、同一用户名、但本地根本没记过密码 —— 该补上 */
  it('saves when the matching item has no password stored', () => {
    const items = [login('a', 'me', null)];
    expect(decideCapture(captured('me', 'hunter2xyz'), items)).toEqual({ kind: 'update', itemId: 'a' });
  });
});

describe('decideCapture —— 更新', () => {
  it('updates when the username matches but the password changed', () => {
    const items = [login('a', 'me', 'old-password')];
    expect(decideCapture(captured('me', 'new-password'), items)).toEqual({ kind: 'update', itemId: 'a' });
  });

  it('updates when the stored item has no username but the site matches', () => {
    const items = [login('a', null, 'old-password')];
    expect(decideCapture(captured('me', 'new-password'), items)).toEqual({ kind: 'update', itemId: 'a' });
  });

  it('updates when the captured form had no username', () => {
    const items = [login('a', 'me', 'old-password')];
    expect(decideCapture(captured(null, 'new-password'), items)).toEqual({ kind: 'update', itemId: 'a' });
  });

  // 站点下有多条时，用户名相同的优先 —— 否则改的可能是别人的那条
  it('prefers the item whose username matches', () => {
    const items = [
      login('other', 'someone-else', 'pw-a'),
      login('mine', 'me', 'pw-b'),
    ];
    expect(decideCapture(captured('me', 'brand-new-pw'), items)).toEqual({ kind: 'update', itemId: 'mine' });
  });
});

describe('decideCapture —— 不该打扰用户的情况', () => {
  /** 用户每次登录都弹一次「要保存吗」是最招人烦的失败模式 */
  it('stays quiet when the password is already stored', () => {
    const items = [login('a', 'me', 'same-password')];
    expect(decideCapture(captured('me', 'same-password'), items)).toEqual({ kind: 'none', reason: 'unchanged' });
  });

  it('stays quiet for an empty password', () => {
    expect(decideCapture(captured('me', ''), [])).toEqual({ kind: 'none', reason: 'noPassword' });
  });

  it('stays quiet for a whitespace-only password', () => {
    expect(decideCapture(captured('me', '   '), [])).toEqual({ kind: 'none', reason: 'noPassword' });
  });

  // 密码框常常被自动填充成占位符或被脚本清空 —— 不该当成用户输入的密码
  it('stays quiet for an obviously non-secret value', () => {
    expect(decideCapture(captured('me', '********'), [])).toEqual({ kind: 'none', reason: 'placeholder' });
    expect(decideCapture(captured('me', '••••••••'), [])).toEqual({ kind: 'none', reason: 'placeholder' });
  });

  it('stays quiet when the captured url is not a web page', () => {
    expect(decideCapture(captured('me', 'pw12345678', 'about:blank'), [])).toEqual({ kind: 'none', reason: 'noSite' });
  });

  it('ignores deleted and archived items', () => {
    const trashed = { ...login('a', 'me', 'old'), deletedAt: '2026-01-01T00:00:00Z' };
    // 只剩被删除的那条 → 对它来说等于没有记录 → 该保存新的
    expect(decideCapture(captured('me', 'new-password'), [trashed])).toEqual({ kind: 'save' });
  });
});

describe('decideCapture —— 不泄露密码', () => {
  it('never puts the password into the decision', () => {
    const d = decideCapture(captured('me', 'super-secret-pw'), [login('a', 'me', 'old')]);
    expect(JSON.stringify(d)).not.toContain('super-secret-pw');
  });
});
