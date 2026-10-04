import { describe, it, expect } from 'vitest';
import { matchesUrl, matchItemsByUrl, URI_MATCH } from './url-match';
import { emptyLogin } from './model';
import type { LoginUri, VaultItem } from './model';

function item(id: string, uris: (string | LoginUri)[]): VaultItem {
  return {
    id, type: 'login', rawType: 1, name: `item-${id}`, nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: 'x', updatedAt: 'x', deletedAt: null, archivedAt: null, hasItemKey: false,
    login: {
      ...emptyLogin(),
      username: 'u', password: 'p',
      uris: uris.map((u) => (typeof u === 'string' ? { uri: u, match: null } : u)),
    },
    card: null, identity: null, secureNote: null,
    customFields: [], passwordHistory: [], attachments: [],
  };
}

const entry = (uri: string, match: number | null = null): LoginUri => ({ uri, match });

describe('matchesUrl —— Host（精确主机名）', () => {
  it('matches the same host', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'https://example.com/login')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesUrl(entry('https://EXAMPLE.com', URI_MATCH.host), 'https://example.com/')).toBe(true);
  });

  it('ignores path, query and fragment', () => {
    expect(matchesUrl(entry('https://example.com/other?a=1', URI_MATCH.host), 'https://example.com/login')).toBe(true);
  });

  it('does not match a different host', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'https://other.com/')).toBe(false);
  });

  // Host 与 Domain 的区别就在这里
  it('does not match a subdomain', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'https://www.example.com/')).toBe(false);
    expect(matchesUrl(entry('https://www.example.com', URI_MATCH.host), 'https://example.com/')).toBe(false);
  });

  it('does not match on port alone', () => {
    expect(matchesUrl(entry('https://example.com:8443', URI_MATCH.host), 'https://example.com/')).toBe(false);
  });
});

describe('matchesUrl —— Domain（基础域名）', () => {
  it('matches the registrable domain and its subdomains', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'https://example.com/')).toBe(true);
    expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'https://www.example.com/')).toBe(true);
    expect(matchesUrl(entry('https://www.example.com', URI_MATCH.domain), 'https://login.example.com/')).toBe(true);
  });

  it('is the default when match is null', () => {
    expect(matchesUrl(entry('https://example.com', null), 'https://www.example.com/')).toBe(true);
  });

  /**
   * ⚠️ 下面这组是**凭据泄露**的防线。
   *
   * 自动填充最危险的动作就是在错误的站点上填密码。域名匹配但凡写得松一点，
   * 攻击者只要注册一个形似的域名就能收走密码。
   */
  describe('安全边界', () => {
    it('does not match a domain that merely ends with the same characters', () => {
      expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'https://evil-example.com/')).toBe(false);
      expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'https://notexample.com/')).toBe(false);
    });

    it('does not match when the target is a suffix of the host', () => {
      expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'https://example.com.evil.com/')).toBe(false);
    });

    it('does not match a different host under a multi-label public suffix', () => {
      // 朴素的「取最后两段」会把这两个当成同一站 —— 必须靠公共后缀表
      expect(matchesUrl(entry('https://a.com.cn', URI_MATCH.domain), 'https://b.com.cn/')).toBe(false);
      expect(matchesUrl(entry('https://shop.example.co.uk', URI_MATCH.domain), 'https://bank.example.co.uk/')).toBe(true);
    });

    it('does not match a different host under a private suffix', () => {
      // github.io 在公共后缀表里 —— a.github.io 与 b.github.io 是不同的人
      expect(matchesUrl(entry('https://alice.github.io', URI_MATCH.domain), 'https://bob.github.io/')).toBe(false);
    });

    it('treats a bare IP as its own registrable domain', () => {
      expect(matchesUrl(entry('http://127.0.0.1:8080', URI_MATCH.domain), 'http://127.0.0.1:8080/login')).toBe(true);
      expect(matchesUrl(entry('http://127.0.0.1', URI_MATCH.domain), 'http://127.0.0.2/')).toBe(false);
    });
  });
});

describe('matchesUrl —— StartsWith', () => {
  it('matches when the page URL starts with the stored value', () => {
    expect(matchesUrl(entry('https://example.com/app', URI_MATCH.startsWith), 'https://example.com/app/login')).toBe(true);
  });

  it('does not match a different prefix', () => {
    expect(matchesUrl(entry('https://example.com/app', URI_MATCH.startsWith), 'https://example.com/other')).toBe(false);
  });
});

describe('matchesUrl —— Exact', () => {
  it('matches only the identical URL', () => {
    expect(matchesUrl(entry('https://example.com/login', URI_MATCH.exact), 'https://example.com/login')).toBe(true);
  });

  it('tolerates a trailing slash on either side', () => {
    expect(matchesUrl(entry('https://example.com/', URI_MATCH.exact), 'https://example.com')).toBe(true);
  });

  it('does not match a different path', () => {
    expect(matchesUrl(entry('https://example.com/login', URI_MATCH.exact), 'https://example.com/login/other')).toBe(false);
  });

  it('does not match a different scheme', () => {
    expect(matchesUrl(entry('http://example.com/', URI_MATCH.exact), 'https://example.com/')).toBe(false);
  });
});

describe('matchesUrl —— RegularExpression', () => {
  it('matches by pattern', () => {
    expect(matchesUrl(entry('^https://[a-z]+\\.example\\.com/', URI_MATCH.regex), 'https://shop.example.com/x')).toBe(true);
  });

  it('does not match when the pattern does not', () => {
    expect(matchesUrl(entry('^https://shop\\.example\\.com/', URI_MATCH.regex), 'https://other.example.com/')).toBe(false);
  });

  /** 用户写错正则不该让整个匹配流程炸掉 */
  it('treats an invalid pattern as no match rather than throwing', () => {
    expect(matchesUrl(entry('([unclosed', URI_MATCH.regex), 'https://example.com/')).toBe(false);
  });
});

describe('matchesUrl —— Never 与无法解析的输入', () => {
  it('never matches when match is Never', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.never), 'https://example.com/')).toBe(false);
  });

  it('is false for an empty stored URI', () => {
    expect(matchesUrl(entry('', URI_MATCH.domain), 'https://example.com/')).toBe(false);
  });

  it('is false for an unparseable page URL', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'not a url')).toBe(false);
  });

  /** 非 http 协议（如安卓应用链接）在浏览器里没有对应站点，不该匹配 */
  it('does not match a non-web scheme against a web page', () => {
    expect(matchesUrl(entry('androidapp://com.example', URI_MATCH.domain), 'https://example.com/')).toBe(false);
  });
});

describe('matchItemsByUrl', () => {
  const items = [
    item('a', ['https://example.com']),
    item('b', [entry('https://example.com', URI_MATCH.host)]),
    item('c', [entry('https://example.com', URI_MATCH.never)]),
    item('d', ['https://other.com']),
    item('e', []),
  ];

  it('returns the items that match, in input order', () => {
    expect(matchItemsByUrl(items, 'https://www.example.com/').map((i) => i.id)).toEqual(['a']);
  });

  it('excludes Never entries even when the URL is identical', () => {
    expect(matchItemsByUrl(items, 'https://example.com/').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns nothing for a site no item covers', () => {
    expect(matchItemsByUrl(items, 'https://unrelated.com/')).toEqual([]);
  });

  it('skips deleted and archived items', () => {
    const live = item('live', ['https://example.com']);
    const trashed = { ...item('trashed', ['https://example.com']), deletedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...item('archived', ['https://example.com']), archivedAt: '2026-01-01T00:00:00Z' };
    expect(matchItemsByUrl([live, trashed, archived], 'https://example.com/').map((i) => i.id)).toEqual(['live']);
  });

  it('is empty for an unparseable page URL', () => {
    expect(matchItemsByUrl(items, '')).toEqual([]);
  });
});

describe('matchesUrl —— 协议降级防线', () => {
  /**
   * 攻击者把 https 降级成 http 之后，密码会以明文走网络。用户看到的
   * 只是地址栏少了个锁的图标，不会察觉。所以这条要在所有匹配类型上生效。
   */
  it('never fills an https credential into an http page', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'http://example.com/')).toBe(false);
    expect(matchesUrl(entry('https://example.com', URI_MATCH.domain), 'http://example.com/')).toBe(false);
    expect(matchesUrl(entry('https://example.com', URI_MATCH.startsWith), 'http://example.com/')).toBe(false);
    expect(matchesUrl(entry('https://example.com', URI_MATCH.exact), 'http://example.com/')).toBe(false);
  });

  // 只收紧不放松：本来就是 http 存的，在 http 页面上照常匹配
  it('still fills an http credential into an http page', () => {
    expect(matchesUrl(entry('http://example.com', URI_MATCH.host), 'http://example.com/')).toBe(true);
    expect(matchesUrl(entry('http://example.com', URI_MATCH.domain), 'http://example.com/')).toBe(true);
  });

  // https 存的填进 https，当然没问题
  it('fills an https credential into an https page', () => {
    expect(matchesUrl(entry('https://example.com', URI_MATCH.host), 'https://example.com/')).toBe(true);
  });
});
