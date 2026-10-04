import { describe, it, expect } from 'vitest';
import { parseXml, xmlText, xmlChildren, xmlAttr } from './xml';
import { parseKeePassXml, looksLikeKeePassXml } from './import-keepass';

/**
 * ⚠️ 自己写 XML 解析是有风险的决定，所以每一条边界都有用例。
 *
 * 现实约束：MV3 的 service worker 里**没有 `DOMParser`**，而 `@coffer/vault`
 * 要在扩展里跑。引一个 XML 库则要连 DOM 仿真一起引。所以写一个**只够用**的：
 * 不支持 DTD、不支持命名空间、不支持处理指令 —— 而 KeePass 的导出只用得到
 * 元素、属性、文本、CDATA 和实体。
 */
describe('parseXml', () => {
  it('parses nested elements and text', () => {
    const root = parseXml('<a><b>hello</b><c>world</c></a>');
    expect(xmlText(root, 'a.b')).toBe('hello');
    expect(xmlText(root, 'a.c')).toBe('world');
  });

  it('reads attributes', () => {
    const root = parseXml('<a><b x="1" y=\'two\'>v</b></a>');
    const b = xmlChildren(root, 'a.b')[0]!;
    expect(xmlAttr(b, 'x')).toBe('1');
    expect(xmlAttr(b, 'y')).toBe('two');
    expect(xmlAttr(b, 'missing')).toBeNull();
  });

  it('finds repeated children by path', () => {
    const root = parseXml('<r><e><k>a</k></e><e><k>b</k></e></r>');
    expect(xmlChildren(root, 'r.e').map((e) => xmlText(e, 'k'))).toEqual(['a', 'b']);
  });

  /** ⚠️ 密码里出现 `&` `<` 是常事，实体解码错了会静默改掉用户的密码 */
  it('decodes entities in text', () => {
    const root = parseXml('<a>&lt;p@ss&amp;word&gt; &quot;x&quot; &apos;y&apos;</a>');
    expect(xmlText(root, 'a')).toBe('<p@ss&word> "x" \'y\'');
  });

  it('decodes numeric entities', () => {
    expect(xmlText(parseXml('<a>&#65;&#x42;</a>'), 'a')).toBe('AB');
  });

  it('decodes entities inside attribute values', () => {
    const root = parseXml('<a><b v="a&amp;b"/></a>');
    expect(xmlAttr(xmlChildren(root, 'a.b')[0]!, 'v')).toBe('a&b');
  });

  it('reads CDATA verbatim, without decoding entities', () => {
    const root = parseXml('<a><![CDATA[<not a tag> & raw]]></a>');
    expect(xmlText(root, 'a')).toBe('<not a tag> & raw');
  });

  it('skips comments', () => {
    expect(xmlText(parseXml('<a><!-- <b>ignored</b> -->real</a>'), 'a')).toBe('real');
  });

  it('skips the XML declaration', () => {
    expect(xmlText(parseXml('<?xml version="1.0" encoding="utf-8"?><a>x</a>'), 'a')).toBe('x');
  });

  it('handles a self-closing tag', () => {
    const root = parseXml('<a><b/><c>v</c></a>');
    expect(xmlChildren(root, 'a.b')).toHaveLength(1);
    expect(xmlText(root, 'a.b')).toBe('');
  });

  /** 真实导出里换行与缩进到处都是 —— 不能让它们混进值里 */
  it('trims whitespace between tags but keeps inner text', () => {
    const root = parseXml('<a>\n  <b>\n    value\n  </b>\n</a>');
    expect(xmlText(root, 'a.b')).toBe('value');
  });

  it('keeps a multi-line value intact', () => {
    const root = parseXml('<a><b>第一行\n第二行</b></a>');
    expect(xmlText(root, 'a.b')).toBe('第一行\n第二行');
  });

  /** ⚠️ 残缺的 XML 要报错，不能返回半棵树 —— 半棵树上「少了 200 条」看不出是解析问题 */
  it('throws on an unclosed tag', () => {
    expect(() => parseXml('<a><b>text</a>')).toThrow();
  });

  it('throws on mismatched tags', () => {
    expect(() => parseXml('<a><b></c></a>')).toThrow();
  });
});

describe('looksLikeKeePassXml', () => {
  it('recognises a KeePass export', () => {
    expect(looksLikeKeePassXml('<?xml version="1.0"?>\n<KeePassFile><Meta/></KeePassFile>')).toBe(true);
  });

  it('rejects other XML', () => {
    expect(looksLikeKeePassXml('<rss><channel/></rss>')).toBe(false);
  });

  it('rejects non-XML', () => {
    expect(looksLikeKeePassXml('name,url,username')).toBe(false);
  });
});

/**
 * ⚠️ KeePass 的导出里，被保护的字段值是 **base64**，不是加密的。
 *
 * `Protected="True"` 只表示「KeePass 界面上把它显示成圆点」——
 * .kdbx 才加密，而导出的 XML 是明文。解不开的话用户的密码会是
 * 一串 base64，看起来像乱码。
 */
describe('parseKeePassXml', () => {
  const xml = (...entries: string[]): string => `<?xml version="1.0" encoding="utf-8"?>
<KeePassFile>
  <Meta><Generator>KeePass</Generator></Meta>
  <Root>
    <Group>
      <UUID>g1</UUID>
      <Name>工作</Name>
      <Group>
        <UUID>g2</UUID>
        <Name>子组</Name>
      </Group>
      ${entries.join('\n')}
    </Group>
  </Root>
</KeePassFile>`;

  const entry = (title: string, strings: [string, string][], extra = ''): string => `
    <Entry>
      <UUID>e-${title}</UUID>
      ${strings.map(([k, v]) => `<String><Key>${k}</Key><Value>${v}</Value></String>`).join('')}
      ${extra}
    </Entry>`;

  it('reads a login with its group as the folder', () => {
    const r = parseKeePassXml(xml(entry('GitHub', [
      ['Title', 'GitHub'], ['UserName', 'me'], ['Password', 'pw'],
      ['URL', 'https://github.com'], ['Notes', '工作账号'],
    ])));
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: 'GitHub', type: 'login', folderName: '工作', notes: '工作账号',
      login: { username: 'me', password: 'pw', uri: 'https://github.com' },
    });
  });

  /** ⚠️ 保护字段的值是 base64 —— 不解码的话密码会变成一串乱码 */
  it('decodes a protected value from base64', () => {
    const protectedPw = Buffer.from('p@ssw0rd', 'utf8').toString('base64');
    const r = parseKeePassXml(xml(`
      <Entry><UUID>e1</UUID>
        <String><Key>Title</Key><Value>X</Value></String>
        <String><Key>UserName</Key><Value>me</Value></String>
        <String><Key>Password</Key><Value Protected="True">${protectedPw}</Value></String>
      </Entry>`));
    expect(r.items[0]!.login?.password).toBe('p@ssw0rd');
  });

  /** ⚠️ 嵌套分组：要用**最近**的那层名字，不是最外层的 */
  it('uses the innermost group as the folder', () => {
    const nested = `<?xml version="1.0"?><KeePassFile><Root><Group>
      <Name>外层</Name>
      <Group><Name>内层</Name>
        <Entry><UUID>e1</UUID>
          <String><Key>Title</Key><Value>X</Value></String>
          <String><Key>URL</Key><Value>https://x.test</Value></String>
        </Entry>
      </Group>
    </Group></Root></KeePassFile>`;
    expect(parseKeePassXml(nested).items[0]!.folderName).toBe('内层');
  });

  it('reads the one-time password field', () => {
    const r = parseKeePassXml(xml(entry('X', [
      ['Title', 'X'], ['URL', 'https://x.test'], ['otp', 'otpauth://totp/X?secret=ABC'],
    ])));
    expect(r.items[0]!.login?.totp).toBe('otpauth://totp/X?secret=ABC');
  });

  /** 非标准键是用户自己的字段，不能丢 */
  it('keeps non-standard keys as custom fields', () => {
    const r = parseKeePassXml(xml(entry('X', [
      ['Title', 'X'], ['URL', 'https://x.test'], ['PIN', '4321'],
    ])));
    expect(r.items[0]!.customFields).toEqual([{ name: 'PIN', value: '4321', type: 0 }]);
  });

  /** ⚠️ 没有 URL、没有用户名、只有密码的条目也是**有效凭据** —— 别当成笔记丢掉 */
  it('treats an entry with only a password as a login', () => {
    const r = parseKeePassXml(xml(entry('X', [['Title', 'X'], ['Password', 'pw']])));
    expect(r.items[0]!.type).toBe('login');
    expect(r.items[0]!.login?.password).toBe('pw');
  });

  it('treats an entry with no credentials at all as a note', () => {
    const r = parseKeePassXml(xml(entry('X', [['Title', 'X'], ['Notes', '一段笔记']])));
    expect(r.items[0]).toMatchObject({ type: 'secureNote', notes: '一段笔记' });
  });

  it('falls back to the username when there is no title', () => {
    const r = parseKeePassXml(xml(entry('X', [['UserName', 'me'], ['Password', 'pw']])));
    expect(r.items[0]!.name).toBe('me');
  });

  it('skips an entry with nothing usable and says which one', () => {
    const r = parseKeePassXml(xml(
      entry('X', [['Notes', '只有备注']]),
      entry('Y', [['Title', 'Y'], ['Password', 'pw']]),
    ));
    expect(r.items.map((i) => i.name)).toEqual(['Y']);
    expect(r.skipped).toHaveLength(1);
  });

  it('reads several entries', () => {
    const r = parseKeePassXml(xml(
      entry('A', [['Title', 'A'], ['Password', 'a']]),
      entry('B', [['Title', 'B'], ['Password', 'b']]),
    ));
    expect(r.items.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('reports a file that is not KeePass XML', () => {
    const r = parseKeePassXml('<rss><channel/></rss>');
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('KeePass');
  });

  /** ⚠️ 残缺的 XML 要明确报错，不能返回「0 条」—— 那和「文件里真的没有条目」分不开 */
  it('reports malformed XML instead of returning an empty success', () => {
    const r = parseKeePassXml('<?xml version="1.0"?><KeePassFile><Root><Group></KeePassFile>');
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/XML|损坏/);
  });

  /** ⚠️ .kdbx 是加密数据库，不是 XML —— 用户很容易选错文件 */
  it('tells the user when they picked a .kdbx instead of an export', () => {
    const kdbx = new Uint8Array([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5]);
    const r = parseKeePassXml(new TextDecoder('utf-8', { fatal: false }).decode(kdbx));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toBeTruthy();
  });
});
