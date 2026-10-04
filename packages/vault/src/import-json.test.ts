import { describe, it, expect } from 'vitest';
import { parseBitwardenJson, parse1Pif, detectJsonFormat } from './import-json';

describe('detectJsonFormat', () => {
  it('recognises a Bitwarden JSON export', () => {
    expect(detectJsonFormat('{"encrypted":false,"folders":[],"items":[]}')).toMatchObject({ id: 'bitwarden' });
  });

  it('recognises a 1PIF file', () => {
    expect(detectJsonFormat('***5642bee8-a5ff-11dc-8314-0800200c9a66***\n{"uuid":"x","typeName":"Logins"}'))
      .toMatchObject({ id: '1pif' });
  });

  it('returns null for unrelated JSON', () => {
    expect(detectJsonFormat('{"hello":"world"}')).toBeNull();
  });

  it('returns null for text that is not JSON at all', () => {
    expect(detectJsonFormat('name,url,username')).toBeNull();
  });
});

/**
 * Bitwarden 的未加密 JSON 导出。
 *
 * ⚠️ 这是 Bitwarden 唯一**无损**的导出格式 —— CSV 会丢掉自定义字段的类型、
 * 卡片的有效期、身份里的地址，以及网址的匹配方式。所以只要用户手里是 JSON，
 * 就该尽量把结构完整搬过来，而不是压成 CSV 那几列。
 */
describe('parseBitwardenJson', () => {
  const exportJson = (items: unknown[], folders: unknown[] = []): string =>
    JSON.stringify({ encrypted: false, folders, items });

  const login = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'c1', type: 1, name: 'GitHub', notes: '工作账号', favorite: true,
    folderId: 'f1',
    login: {
      uris: [{ match: 0, uri: 'https://github.com' }],
      username: 'me', password: 'pw', totp: 'JBSWY3DPEHPK3PXP',
    },
    fields: [{ name: 'PIN', value: '4321', type: 1 }],
    ...over,
  });

  it('reads a login with its folder, notes, favourite and custom fields', () => {
    const r = parseBitwardenJson(exportJson([login()], [{ id: 'f1', name: '工作' }]));
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: 'GitHub', type: 'login', notes: '工作账号', favorite: true, folderName: '工作',
      login: { username: 'me', password: 'pw', totp: 'JBSWY3DPEHPK3PXP', uri: 'https://github.com' },
    });
    expect(r.items[0]!.customFields).toEqual([{ name: 'PIN', value: '4321', type: 1 }]);
  });

  /** 一个条目可以有多个网址；匹配方式（Domain/Host/Exact…）也要留着 */
  it('keeps every URI with its match mode', () => {
    const item = login({ login: { uris: [
      { match: 0, uri: 'https://github.com' },
      { match: 3, uri: 'https://gist.github.com' },
    ], username: 'me', password: 'pw', totp: null } });
    const r = parseBitwardenJson(exportJson([item]));
    expect(r.items[0]!.login?.uri).toBe('https://github.com');
    // 两个都在，且各自的匹配方式留着 —— 只留第一个会让用户在那个站点上填错
    expect(r.items[0]!.login?.uris).toEqual([
      { uri: 'https://github.com', match: 0 },
      { uri: 'https://gist.github.com', match: 3 },
    ]);
  });

  it('reads a secure note', () => {
    const r = parseBitwardenJson(exportJson([
      { id: 'n1', type: 2, name: 'WiFi', notes: '密码在路由器背面', favorite: false, secureNote: { type: 0 } },
    ]));
    expect(r.items[0]).toMatchObject({ name: 'WiFi', type: 'secureNote', notes: '密码在路由器背面' });
  });

  it('reads a card', () => {
    const r = parseBitwardenJson(exportJson([
      { id: 'k1', type: 3, name: '招行卡', favorite: false,
        card: { cardholderName: '张三', brand: 'Visa', number: '4111111111111111', expMonth: '9', expYear: '2028', code: '123' } },
    ]));
    expect(r.items[0]).toMatchObject({
      name: '招行卡', type: 'card',
      card: { cardholderName: '张三', brand: 'Visa', number: '4111111111111111', expMonth: '9', expYear: '2028', code: '123' },
    });
  });

  it('reads an identity', () => {
    const r = parseBitwardenJson(exportJson([
      { id: 'i1', type: 4, name: '我', favorite: false,
        identity: { firstName: '三', lastName: '张', email: 'a@b.test', phone: '13800000000' } },
    ]));
    expect(r.items[0]!.identity).toMatchObject({ firstName: '三', lastName: '张', email: 'a@b.test' });
  });

  /** ⚠️ 不认识的新类型不能整条丢掉 —— 用户丢的是一条记录，而且不会有任何提示 */
  it('keeps an unknown item type as a note instead of dropping it', () => {
    const r = parseBitwardenJson(exportJson([
      { id: 'x1', type: 99, name: '某种新东西', notes: '内容还在', favorite: false },
    ]));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: '某种新东西', type: 'secureNote' });
  });

  /** 加密导出读不了 —— 要明确说清楚，不能解析出一堆乱码条目 */
  it('refuses an encrypted export with a clear reason', () => {
    const r = parseBitwardenJson(JSON.stringify({ encrypted: true, data: '2.xxx|yyy|zzz' }));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('加密');
  });

  it('says which item it could not read', () => {
    const r = parseBitwardenJson(exportJson([login(), { id: 'bad', type: 1 }]));
    expect(r.items).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain('名称');
  });

  it('reports malformed JSON instead of throwing', () => {
    const r = parseBitwardenJson('{ not json');
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('JSON');
  });
});

/**
 * 1PIF —— 1Password 的旧版交换格式。
 *
 * 每一条是一个 JSON 对象，用 `***<uuid>***` 这样的行分隔。
 * 字段名与 1PUX 完全不同（`typeName` / `secureContents` / `designation`），
 * 所以不能和 1PUX 共用解析。
 */
describe('parse1Pif', () => {
  const pif = (...objs: unknown[]): string =>
    objs.map((o) => `***aaaaaaaa-1111-2222-3333-444444444444***\n${JSON.stringify(o)}\n`).join('');

  const loginItem = {
    uuid: 'u1', typeName: 'Logins', updatedAt: 1700000000, location: 'https://github.com',
    secureContents: {
      title: 'GitHub',
      notesPlain: '工作账号',
      URLs: [{ url: 'https://github.com' }],
      fields: [
        { name: 'username', value: 'me', designation: 'username' },
        { name: 'password', value: 'pw', designation: 'password' },
      ],
    },
  };

  it('reads a login by its designation, not by field order', () => {
    const r = parse1Pif(pif(loginItem));
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: 'GitHub', type: 'login', notes: '工作账号',
      login: { username: 'me', password: 'pw', uri: 'https://github.com' },
    });
  });

  /** ⚠️ 字段顺序在真实文件里不固定 —— 按位置读会把用户名和密码对调 */
  it('still finds the credentials when the fields are in the other order', () => {
    const swapped = {
      ...loginItem,
      secureContents: { ...loginItem.secureContents, fields: [
        { name: 'password', value: 'pw', designation: 'password' },
        { name: 'username', value: 'me', designation: 'username' },
      ] },
    };
    const r = parse1Pif(pif(swapped));
    expect(r.items[0]!.login).toMatchObject({ username: 'me', password: 'pw' });
  });

  it('reads the one-time password field', () => {
    const withTotp = {
      ...loginItem,
      secureContents: { ...loginItem.secureContents, fields: [
        ...loginItem.secureContents.fields,
        { name: 'one-time password', value: 'otpauth://totp/GitHub?secret=ABC', designation: 'totp' },
      ] },
    };
    expect(parse1Pif(pif(withTotp)).items[0]!.login?.totp).toBe('otpauth://totp/GitHub?secret=ABC');
  });

  it('reads a secure note', () => {
    const note = { uuid: 'u2', typeName: 'Secure Notes', secureContents: { title: 'WiFi', notesPlain: '密码在背面' } };
    expect(parse1Pif(pif(note)).items[0]).toMatchObject({ name: 'WiFi', type: 'secureNote', notes: '密码在背面' });
  });

  it('reads a credit card', () => {
    const card = {
      uuid: 'u3', typeName: 'Credit Cards',
      secureContents: { title: '招行卡', cardholder: '张三', type: 'Visa', number: '4111111111111111', expiry: '09/2028', verificationNumber: '123' },
    };
    expect(parse1Pif(pif(card)).items[0]).toMatchObject({
      name: '招行卡', type: 'card',
      card: { cardholderName: '张三', brand: 'Visa', number: '4111111111111111', expMonth: '9', expYear: '2028', code: '123' },
    });
  });

  it('reads several items from one file', () => {
    const r = parse1Pif(pif(loginItem, { uuid: 'u9', typeName: 'Secure Notes', secureContents: { title: 'N' } }));
    expect(r.items.map((i) => i.name)).toEqual(['GitHub', 'N']);
  });

  /** 不认识的新类型要留住内容，不能整条丢 */
  it('keeps an unrecognised type as a note', () => {
    const odd = { uuid: 'u4', typeName: 'Software Licenses', secureContents: { title: '某软件', notesPlain: '序列号' } };
    expect(parse1Pif(pif(odd)).items[0]).toMatchObject({ name: '某软件', type: 'secureNote', notes: '序列号' });
  });

  it('reports a broken record instead of dropping the whole file', () => {
    const broken = `***aaaa***\n{ this is not json\n`;
    const r = parse1Pif(broken + pif(loginItem));
    expect(r.items).toHaveLength(1);
    expect(r.skipped[0]?.reason).toBeTruthy();
  });

  it('reports a file with no records at all', () => {
    const r = parse1Pif('这不是一个 1PIF 文件');
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('1PIF');
  });
});
