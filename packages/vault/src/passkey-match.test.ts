import { describe, it, expect } from 'vitest';
import { isRpIdAllowed, originOf, checkClientData, pickCredentials, relyingPartyOf } from './passkey-match';
import type { VaultItem } from './model';
import { emptyLogin } from './model';
import type { StoredPasskey } from './passkey';

function pk(over: Partial<StoredPasskey> = {}): StoredPasskey {
  return {
    credentialId: 'cred-1', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
    keyValue: 'KEY', rpId: 'example.com', counter: '0', discoverable: 'true',
    creationDate: '2026-01-01T00:00:00.000000Z',
    ...over,
  };
}

function item(id: string, creds: StoredPasskey[], over: Partial<VaultItem> = {}): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `条目 ${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: { ...emptyLogin(), fido2Credentials: creds },
    card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

/**
 * ⚠️ 这一段是整个 passkey 功能里**最危险**的判断。
 *
 * 浏览器原生会把 `rpId` 的域校验做掉 —— 页面在 `evil.com` 上根本没法为
 * `github.com` 发起 WebAuthn。但我们接管了 `navigator.credentials` 之后，
 * **那道强制就没了**，得由我们自己做。
 *
 * 做漏了的后果不是「功能不好用」，而是：任何站点都能向我们要一份
 * github.com 的断言签名，然后拿去登录用户的 GitHub。而且用户全程看不到异常。
 *
 * 所以这里的规则一律**宁可不给，不可给错**。
 */
describe('isRpIdAllowed —— rpId 必须是页面自己的域', () => {
  it('allows the exact host', () => {
    expect(isRpIdAllowed('https://example.com', 'example.com')).toBe(true);
  });

  it('allows a registrable-domain suffix', () => {
    // rpId 声明父域是 WebAuthn 的正常用法：在 login.example.com 上
    // 注册的凭据，登录页在 www.example.com 时也要能用
    expect(isRpIdAllowed('https://login.example.com', 'example.com')).toBe(true);
    expect(isRpIdAllowed('https://a.b.example.com', 'example.com')).toBe(true);
  });

  it('rejects a rpId that is not a suffix of the host', () => {
    expect(isRpIdAllowed('https://evil.com', 'example.com')).toBe(false);
    expect(isRpIdAllowed('https://example.com.evil.com', 'example.com')).toBe(false);
  });

  /** ⚠️ 前缀相同时最容易写错的一条：字符串 includes 会把 notexample.com 判成通过 */
  it('rejects a host that merely contains the rpId as a substring', () => {
    expect(isRpIdAllowed('https://notexample.com', 'example.com')).toBe(false);
    expect(isRpIdAllowed('https://example.com.attacker.net', 'example.com')).toBe(false);
  });

  it('rejects a rpId that is a public suffix', () => {
    // rpId = "com" 会让**所有** .com 站点共用一个凭据命名空间
    expect(isRpIdAllowed('https://example.com', 'com')).toBe(false);
    expect(isRpIdAllowed('https://foo.co.uk', 'co.uk')).toBe(false);
  });

  it('rejects http origins except localhost', () => {
    expect(isRpIdAllowed('http://example.com', 'example.com')).toBe(false);
    expect(isRpIdAllowed('http://localhost', 'localhost')).toBe(true);
    expect(isRpIdAllowed('http://127.0.0.1:8080', '127.0.0.1')).toBe(true);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(isRpIdAllowed('file:///tmp/x.html', 'example.com')).toBe(false);
    expect(isRpIdAllowed('data:text/html,hi', 'example.com')).toBe(false);
  });

  it('rejects malformed input instead of throwing', () => {
    expect(isRpIdAllowed('not a url', 'example.com')).toBe(false);
    expect(isRpIdAllowed('https://example.com', '')).toBe(false);
  });
});

describe('originOf', () => {
  it('normalizes to scheme + host, dropping the path', () => {
    expect(originOf('https://example.com/login?x=1#f')).toBe('https://example.com');
    // ⚠️ 端口是 origin 的一部分：不同端口是不同的源
    expect(originOf('http://localhost:8443/x')).toBe('http://localhost:8443');
    // 默认端口要归一化掉，否则和 clientDataJSON 里的 origin 对不上
    expect(originOf('https://example.com:443/')).toBe('https://example.com');
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(originOf('file:///tmp/x')).toBeNull();
  });
});

describe('checkClientData —— 页面给的数据必须自洽', () => {
  const make = (over: Record<string, unknown> = {}): Uint8Array => new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get', challenge: 'Y2hhbGxlbmdl', origin: 'https://example.com', ...over,
  }));

  it('accepts well-formed client data for the expected ceremony and origin', () => {
    expect(checkClientData(make(), 'webauthn.get', 'https://example.com')).toEqual({ ok: true });
  });

  /**
   * ⚠️ `origin` 必须和**页面实际的源**一致。
   *
   * 攻击者可以伪造整份 clientDataJSON —— 那正是为什么签名要覆盖它。
   * 但如果我们在签名前不检查，就会签出一份「origin 写着 evil.com」的断言，
   * 或者更糟：签出一份 origin 正确、challenge 却是攻击者选定的断言。
   */
  it('rejects a mismatched origin', () => {
    const r = checkClientData(make({ origin: 'https://evil.com' }), 'webauthn.get', 'https://example.com');
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty('reason');
  });

  it('rejects a mismatched ceremony type', () => {
    // 拿 webauthn.create 的 clientData 去做断言，是典型的混淆攻击
    expect(checkClientData(make({ type: 'webauthn.create' }), 'webauthn.get', 'https://example.com').ok).toBe(false);
  });

  it('rejects a missing challenge', () => {
    expect(checkClientData(make({ challenge: '' }), 'webauthn.get', 'https://example.com').ok).toBe(false);
  });

  it('rejects anything that is not JSON', () => {
    expect(checkClientData(new TextEncoder().encode('not json'), 'webauthn.get', 'https://example.com').ok).toBe(false);
    expect(checkClientData(new Uint8Array(0), 'webauthn.get', 'https://example.com').ok).toBe(false);
  });

  /**
   * ⚠️ `crossOrigin` 为 true 时，这次调用来自一个跨源 iframe。
   * 嵌在别人页面里的 frame 不该拿到凭据 —— 那是点击劫持的经典入口。
   */
  it('rejects cross-origin client data', () => {
    expect(checkClientData(make({ crossOrigin: true }), 'webauthn.get', 'https://example.com').ok).toBe(false);
  });
});

describe('pickCredentials —— 挑出这次能给哪些凭据', () => {
  const items = [
    item('1', [pk({ credentialId: 'a1' })]),
    item('2', [pk({ credentialId: 'b1', rpId: 'other.com' })]),
    item('3', [pk({ credentialId: 'c1' }), pk({ credentialId: 'c2' })]),
    item('4', [], { deletedAt: '2026-01-01T00:00:00.000000Z' }),
  ];

  it('returns only credentials whose rpId matches', () => {
    const got = pickCredentials(items, 'example.com', null);
    expect(got.map((c) => c.stored.credentialId)).toEqual(['a1', 'c1', 'c2']);
  });

  it('narrows to allowCredentials when the page supplied one', () => {
    const got = pickCredentials(items, 'example.com', [{ id: 'c2', type: 'public-key' }]);
    expect(got.map((c) => c.stored.credentialId)).toEqual(['c2']);
  });

  /** allowCredentials 为空数组时**不是**「没有限制」—— 规范说那是空集 */
  it('treats an empty allowCredentials as "nothing is allowed"', () => {
    expect(pickCredentials(items, 'example.com', [])).toEqual([]);
  });

  it('returns nothing when no credential matches the rpId', () => {
    expect(pickCredentials(items, 'nope.com', null)).toEqual([]);
  });

  /**
   * ⚠️ 凭据的 rpId 必须**完全相等**，不能做后缀匹配。
   *
   * 后缀匹配看起来更「宽容好用」，实际上是把两个不同的 RP 混成一个：
   * 在 `login.example.com` 上为内部系统注册的凭据，会被交到 `example.com`
   * 手上的任意页面 —— 而那是**另一个** RP，它本来无从得知前者的存在。
   * 沿用 isRpIdAllowed 的宽容规则到这一层，正是最容易犯的错。
   */
  it('does not match a credential registered for a subdomain', () => {
    const sub = [...items, item('9', [pk({ credentialId: 'sub1', rpId: 'login.example.com' })])];
    expect(pickCredentials(sub, 'example.com', null).map((c) => c.stored.credentialId))
      .not.toContain('sub1');
    // 反向也不能：父域的凭据不该给子域，那是 RP 自己没声明的事
    expect(pickCredentials(items, 'login.example.com', null)).toEqual([]);
  });

  /** 回收站里的条目还带着凭据，但用户已经删了它 —— 不能拿它去登录 */
  it('ignores deleted items', () => {
    const withDeleted = [...items, item('5', [pk({ credentialId: 'd1' })], { deletedAt: '2026-01-01T00:00:00.000000Z' })];
    expect(pickCredentials(withDeleted, 'example.com', null).map((c) => c.stored.credentialId))
      .not.toContain('d1');
  });

  it('carries the owning item so the caller can show which entry it is', () => {
    const got = pickCredentials(items, 'example.com', null);
    expect(got[0]!.item.id).toBe('1');
  });
});

describe('relyingPartyOf —— 给 UI 显示的站点名', () => {
  it('prefers the stored rpName', () => {
    expect(relyingPartyOf(pk({ rpName: 'GitHub' }))).toBe('GitHub');
  });

  it('falls back to the rpId', () => {
    expect(relyingPartyOf({ rpId: 'example.com' })).toBe('example.com');
  });

  /** rpName 是 RP 自己填的，可能是一整句话 —— 直接塞进列表会把布局撑坏 */
  it('ignores an absurdly long rpName', () => {
    expect(relyingPartyOf({ rpId: 'example.com', rpName: 'x'.repeat(200) })).toBe('example.com');
  });
});
