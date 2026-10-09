import { describe, it, expect } from 'vitest';
import { iconDomainOf, summaryOf, avatarOf } from './item-display';
import { emptyLogin, emptyCard, emptyIdentity, type VaultItem } from './model';

/**
 * 列表行要显示两样东西：一个**彩色图标**和一行**摘要**。
 *
 * 1Password 那一列之所以一眼能认出来，靠的不是「有个图标」，而是
 * 每条都有自己的图标（站点图标，不是一个统一的钥匙）和第二行文字
 * （用户名 / 掩码卡号 / 证件号）。这两样都得从条目数据里推导出来，
 * 而且要**在桌面端和浏览器插件里推导得一模一样** —— 所以放在这里，
 * 不放 UI。
 */

function item(over: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'i1', type: 'login', rawType: 1, name: '条目', nameFailed: false,
    notes: null, notesFailed: false, folderId: null, favorite: false, reprompt: 0,
    createdAt: '', updatedAt: '', deletedAt: null, archivedAt: null, wrappedKey: null,
    login: emptyLogin(), card: null, identity: null, secureNote: null, sshKey: null,
    customFields: [], passwordHistory: [], attachments: [],
    ...over,
  };
}

describe('iconDomainOf —— 这条该用哪个站点的图标', () => {
  it('takes the hostname without the www prefix from the first stored URI', () => {
    const it0 = item({ login: { ...emptyLogin(), uris: [{ uri: 'https://www.bilibili.com/login?x=1', match: null }] } });
    // 常见 www 前缀不影响品牌；服务子域名则必须保留（见下）。
    expect(iconDomainOf(it0)).toBe('bilibili.com');
  });

  it.each(['cloud.tencent.com', 'mail.163.com', 'mail.google.com', 'weixin.qq.com'])(
    'preserves the service hostname %s for builtin icons', host => {
      const it0 = item({ login: { ...emptyLogin(), uris: [{ uri: `https://${host}/login`, match: null }] } });
      expect(iconDomainOf(it0)).toBe(host);
      expect(iconDomainOf(item({ name: host }))).toBe(host);
    },
  );

  it('honours URI order and skips the ones that are not web URLs', () => {
    const it0 = item({
      login: {
        ...emptyLogin(),
        uris: [{ uri: 'androidapp://com.example.app', match: null }, { uri: 'github.com', match: null }],
      },
    });
    // 第一条是 app scheme，不是网页 —— 取不到域名就往下去看
    expect(iconDomainOf(it0)).toBe('github.com');
  });

  it('returns null when no URI yields a domain', () => {
    const it0 = item({ login: { ...emptyLogin(), uris: [{ uri: 'androidapp://com.example.app', match: null }] } });
    expect(iconDomainOf(it0)).toBeNull();
  });

  /**
   * ⚠️ 导入进来的条目经常**没有 URI，名字本身就是个网址**
   * （Bitwarden 的 CSV 导出就是这样，「www.bilibili.com」直接当标题）。
   * 不认名字的话，这一整类条目全都没有图标 —— 而它们恰恰是最需要图标
   * 才能一眼认出来的。
   */
  it('falls back to the name when the name is a domain', () => {
    expect(iconDomainOf(item({ name: 'www.bilibili.com' }))).toBe('bilibili.com');
  });

  /**
   * ⚠️ 但条目名**多半不是**网址（「Claude」「基金从业-Amac」「我的邮箱」）。
   * 把每个名字都当域名去请求，会打出一堆无意义的请求，
   * 而且全都会拿回那张灰色占位图。
   */
  it('does not treat an ordinary name as a domain', () => {
    expect(iconDomainOf(item({ name: 'Claude' }))).toBeNull();
    expect(iconDomainOf(item({ name: '基金从业-Amac' }))).toBeNull();
    expect(iconDomainOf(item({ name: '我的邮箱' }))).toBeNull();
    expect(iconDomainOf(item({ name: '' }))).toBeNull();
  });

  it('has no domain for cards, notes, identities or SSH keys', () => {
    expect(iconDomainOf(item({ type: 'card', rawType: 3, login: null, card: emptyCard() }))).toBeNull();
    expect(iconDomainOf(item({ type: 'secureNote', rawType: 2, login: null }))).toBeNull();
    expect(iconDomainOf(item({ type: 'identity', rawType: 4, login: null, identity: emptyIdentity() }))).toBeNull();
    expect(iconDomainOf(item({ type: 'sshKey', rawType: 5, login: null }))).toBeNull();
  });
});

describe('summaryOf —— 列表行的第二行', () => {
  it('shows the username for a login', () => {
    expect(summaryOf(item({ login: { ...emptyLogin(), username: 'yyxdz@cock.li' } }))).toBe('yyxdz@cock.li');
  });

  /** 没有用户名时退回**域名**，不是整条 URL —— URL 太长会挤掉名字 */
  it('falls back to the domain, not the whole URL, for a login', () => {
    const it0 = item({ login: { ...emptyLogin(), uris: [{ uri: 'https://www.bilibili.com/login/step2?x=1', match: null }] } });
    expect(summaryOf(it0)).toBe('bilibili.com');
  });

  /** 1Password 的用户名优先于网址，两者都有时不能显示网址 */
  it('prefers the username over the URI', () => {
    const it0 = item({
      login: { ...emptyLogin(), username: 'me@example.com', uris: [{ uri: 'https://example.com', match: null }] },
    });
    expect(summaryOf(it0)).toBe('me@example.com');
  });

  it('returns null for a login with neither', () => {
    expect(summaryOf(item())).toBeNull();
  });

  /**
   * ⚠️ 卡号必须**掩码**。列表是用户随手截图、投屏、给别人看的地方，
   * 完整卡号摊在那里是实打实的泄露。
   */
  it('masks the card number down to the last four digits', () => {
    const c = item({ type: 'card', rawType: 3, login: null, card: { ...emptyCard(), number: '4480092412340924' } });
    expect(summaryOf(c)).toBe('4480 **** 0924');
  });

  it('does not try to mask a number too short to mask', () => {
    const c = item({ type: 'card', rawType: 3, login: null, card: { ...emptyCard(), number: '1234' } });
    expect(summaryOf(c)).toBe('1234');
  });

  it('falls back to the cardholder name when there is no number', () => {
    const c = item({ type: 'card', rawType: 3, login: null, card: { ...emptyCard(), cardholderName: 'ZHANG SAN' } });
    expect(summaryOf(c)).toBe('ZHANG SAN');
  });

  it('shows the identifier for an identity', () => {
    const id = item({ type: 'identity', rawType: 4, login: null, identity: { ...emptyIdentity(), ssn: '330124199909240713' } });
    expect(summaryOf(id)).toBe('330124199909240713');
  });

  it('builds a name for an identity that has no identifier', () => {
    const id = item({ type: 'identity', rawType: 4, login: null, identity: { ...emptyIdentity(), firstName: 'San', lastName: 'Zhang' } });
    expect(summaryOf(id)).toBe('San Zhang');
  });

  it('returns null for notes and SSH keys', () => {
    expect(summaryOf(item({ type: 'secureNote', rawType: 2, login: null }))).toBeNull();
    expect(summaryOf(item({ type: 'sshKey', rawType: 5, login: null }))).toBeNull();
  });

  /** 解不开名字的条目在列表里显示「无法解密」—— 摘要不该再透出别的东西 */
  it('returns nothing for an item whose name failed to decrypt', () => {
    expect(summaryOf(item({ nameFailed: true, login: { ...emptyLogin(), username: 'me@example.com' } }))).toBeNull();
  });
});

describe('avatarOf —— 拿不到图标时的彩色字母徽标', () => {
  it('is stable for the same item', () => {
    const a = item({ name: 'Zlib' });
    expect(avatarOf(a)).toEqual(avatarOf(a));
  });

  /**
   * ⚠️ 颜色是**从键算出来**的，不是随机的。
   *
   * 随机会让同一批条目每次渲染换一次颜色（列表滚动、重新同步都会），
   * 看起来像抖动。用户对「这个紫色的 ZI 是 Zlib」是有肌肉记忆的。
   */
  it('gives the same name the same colour across items', () => {
    expect(avatarOf(item({ name: 'Zlib', id: 'a' })).hue).toBe(avatarOf(item({ name: 'Zlib', id: 'b' })).hue);
  });

  it('spreads different names over different hues', () => {
    const hues = new Set(['Zlib', 'Bitget', 'Claude', 'OKX', 'Paradoxplaza', 'GitHub']
      .map((n) => avatarOf(item({ name: n })).hue));
    // 六个不同名字全撞一个颜色的话，彩色就没意义了
    expect(hues.size).toBeGreaterThan(3);
  });

  it('keeps the hue in range', () => {
    for (const n of ['a', 'Zlib', '基金从业-Amac', 'x'.repeat(300), '']) {
      const { hue } = avatarOf(item({ name: n }));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  /**
   * ⚠️ 中文名取**两个汉字**。只取一个字母的话，一堆中文条目全是同一个字，
   * 而这个字多半是「我」「中」「基」这类高频字 —— 等于没有区分度。
   * 1Password 对「基金从业-Amac」显示的正是「基金」。
   */
  it('takes two characters from a CJK name', () => {
    expect(avatarOf(item({ name: '基金从业-Amac' })).text).toBe('基金');
  });

  it('takes two characters from a latin name', () => {
    expect(avatarOf(item({ name: 'Zlib' })).text).toBe('Zl');
  });

  /** 中文名里夹英文时，「基金从业-Amac」要取汉字而不是「基金」以外的部分 */
  it('skips leading punctuation and spaces', () => {
    expect(avatarOf(item({ name: '  Zlib' })).text).toBe('Zl');
    expect(avatarOf(item({ name: '— 我的邮箱' })).text).toBe('我的');
  });

  it('still shows something for a name with no usable characters', () => {
    expect(avatarOf(item({ name: '' })).text.length).toBeGreaterThan(0);
    expect(avatarOf(item({ name: '   ' })).text.length).toBeGreaterThan(0);
    expect(avatarOf(item({ name: '!!!' })).text.length).toBeGreaterThan(0);
  });

  /** 有站点域名的条目按**域名**取色，这样同一个站点的多条登录是同一个颜色 */
  it('keys the colour off the domain when there is one', () => {
    const a = item({ name: '工作账号', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com', match: null }] } });
    const b = item({ name: '私人账号', login: { ...emptyLogin(), uris: [{ uri: 'https://github.com/login', match: null }] } });
    expect(avatarOf(a).hue).toBe(avatarOf(b).hue);
  });
});
