import { describe, it, expect } from 'vitest';
import { parse1Pux, looksLike1Pux } from './import-1pux';

/** 把一段 export.data 的 JSON 包成 1PUX 那个 ZIP */
async function make1Pux(data: unknown, attrs: unknown = { version: 1 }): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const entries: { name: string; body: Uint8Array }[] = [
    { name: 'export.data', body: encoder.encode(JSON.stringify(data)) },
    { name: 'export.attributes', body: encoder.encode(JSON.stringify(attrs)) },
  ];

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const local = new Uint8Array(30 + nameBytes.length + e.body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);                       // 原样存储，测试不需要压缩
    lv.setUint32(18, e.body.length, true);
    lv.setUint32(22, e.body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(e.body, 30 + nameBytes.length);
    parts.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, e.body.length, true);
    cv.setUint32(24, e.body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

const loginItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: 'i1',
  categoryUuid: '001',
  favIndex: 1,
  overview: { title: 'GitHub', urls: [{ label: '', url: 'https://github.com' }], tags: ['工作'] },
  details: {
    loginFields: [
      { name: 'username', value: 'me', designation: 'username', fieldType: 'T' },
      { name: 'password', value: 'pw', designation: 'password', fieldType: 'P' },
    ],
    notesPlain: '工作账号',
    sections: [{ title: '', fields: [{ title: 'PIN', id: '', value: '4321', fieldType: 'T' }] }],
  },
  ...over,
});

const account = (items: unknown[], vaultName = '个人'): unknown => ({
  accounts: [{ attrs: {}, vaults: [{ attrs: { name: vaultName, uuid: 'v1' }, items }] }],
});

describe('looksLike1Pux', () => {
  it('recognises a ZIP', async () => {
    expect(looksLike1Pux(await make1Pux(account([loginItem()])))).toBe(true);
  });

  it('rejects a Bitwarden JSON file renamed to .1pux', () => {
    expect(looksLike1Pux(new TextEncoder().encode('{"items":[]}'))).toBe(false);
  });
});

describe('parse1Pux', () => {
  it('reads a login with its vault, notes and one-time password', async () => {
    const withTotp = loginItem({
      details: {
        ...(loginItem()['details'] as Record<string, unknown>),
        loginFields: [
          { name: 'username', value: 'me', designation: 'username', fieldType: 'T' },
          { name: 'password', value: 'pw', designation: 'password', fieldType: 'P' },
          { name: 'one-time password', value: 'otpauth://totp/GitHub?secret=ABC', designation: 'totp', fieldType: 'T' },
        ],
      },
    });
    const r = await parse1Pux(await make1Pux(account([withTotp], '工作')));
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: 'GitHub', type: 'login', notes: '工作账号', favorite: true, folderName: '工作',
      login: { username: 'me', password: 'pw', totp: 'otpauth://totp/GitHub?secret=ABC', uri: 'https://github.com' },
    });
  });

  /** ⚠️ `loginFields` 的顺序不保证 —— 按位置读会把用户名和密码对调 */
  it('reads the credentials by designation, not by position', async () => {
    const swapped = loginItem({
      details: {
        loginFields: [
          { name: 'password', value: 'pw', designation: 'password', fieldType: 'P' },
          { name: 'username', value: 'me', designation: 'username', fieldType: 'T' },
        ],
        notesPlain: '', sections: [],
      },
    });
    const r = await parse1Pux(await make1Pux(account([swapped])));
    expect(r.items[0]!.login).toMatchObject({ username: 'me', password: 'pw' });
  });

  it('keeps every url', async () => {
    const two = loginItem({
      overview: { title: 'GitHub', urls: [
        { label: 'main', url: 'https://github.com' },
        { label: 'gist', url: 'https://gist.github.com' },
      ], tags: [] },
    });
    const r = await parse1Pux(await make1Pux(account([two])));
    expect(r.items[0]!.login?.uris?.map((u) => u.uri))
      .toEqual(['https://github.com', 'https://gist.github.com']);
  });

  it('reads a secure note', async () => {
    const note = { uuid: 'n1', categoryUuid: '003', overview: { title: 'WiFi', urls: [], tags: [] },
      details: { notesPlain: '密码在路由器背面', sections: [] } };
    const r = await parse1Pux(await make1Pux(account([note])));
    expect(r.items[0]).toMatchObject({ name: 'WiFi', type: 'secureNote', notes: '密码在路由器背面' });
  });

  /** 卡片的字段在 sections 里、按 `id` 认，不在 loginFields 里 */
  it('reads a credit card by its field ids', async () => {
    const card = {
      uuid: 'k1', categoryUuid: '002', overview: { title: '招行卡', urls: [], tags: [] },
      details: { notesPlain: '', sections: [{ title: '银行卡', fields: [
        { id: 'cardholder', title: '持卡人', value: '张三', fieldType: 'T' },
        { id: 'type', title: '类型', value: 'visa', fieldType: 'T' },
        { id: 'number', title: '号码', value: '4111111111111111', fieldType: 'C' },
        { id: 'expiry', title: '有效期', value: '202809', fieldType: 'M' },
        { id: 'verificationNumber', title: '安全码', value: '123', fieldType: 'T' },
      ] }] },
    };
    const r = await parse1Pux(await make1Pux(account([card])));
    expect(r.items[0]).toMatchObject({
      name: '招行卡', type: 'card',
      card: { cardholderName: '张三', brand: 'visa', number: '4111111111111111', expMonth: '9', expYear: '2028', code: '123' },
    });
  });

  it('reads an identity', async () => {
    const id = {
      uuid: 'd1', categoryUuid: '004', overview: { title: '我', urls: [], tags: [] },
      details: { notesPlain: '', sections: [{ title: '', fields: [
        { id: 'firstname', title: '名', value: '三', fieldType: 'T' },
        { id: 'lastname', title: '姓', value: '张', fieldType: 'T' },
        { id: 'email', title: '邮箱', value: 'a@b.test', fieldType: 'E' },
      ] }] },
    };
    const r = await parse1Pux(await make1Pux(account([id])));
    expect(r.items[0]!.identity).toMatchObject({ firstName: '三', lastName: '张', email: 'a@b.test' });
  });

  /**
   * ⚠️ 1Password 的分类比 Bitwarden 多得多（银行账户、驾照、护照、软件许可…）。
   * 认不出的**当笔记留下**，而不是丢掉 —— 用户丢的是一条记录，且不会有提示。
   */
  it('keeps an unrecognised category as a note', async () => {
    const odd = { uuid: 'x1', categoryUuid: '110', overview: { title: '驾照', urls: [], tags: [] },
      details: { notesPlain: '证件内容', sections: [] } };
    const r = await parse1Pux(await make1Pux(account([odd])));
    expect(r.items[0]).toMatchObject({ name: '驾照', type: 'secureNote', notes: '证件内容' });
  });

  /** 标签在 1Password 里是独立于保险库的一层，丢掉可惜，塞进自定义字段留住 */
  it('keeps tags as a custom field', async () => {
    const r = await parse1Pux(await make1Pux(account([loginItem()])));
    expect(r.items[0]!.customFields.some((f) => f.value.includes('工作'))).toBe(true);
  });

  it('reads items from every vault', async () => {
    const data = { accounts: [{ attrs: {}, vaults: [
      { attrs: { name: '个人', uuid: 'v1' }, items: [loginItem()] },
      { attrs: { name: '工作', uuid: 'v2' }, items: [{ uuid: 'n2', categoryUuid: '003',
        overview: { title: 'N', urls: [], tags: [] }, details: { notesPlain: '', sections: [] } }] },
    ] }] };
    const r = await parse1Pux(await make1Pux(data));
    expect(r.items.map((i) => [i.name, i.folderName]))
      .toEqual([['GitHub', '个人'], ['N', '工作']]);
  });

  it('reports an item with no title instead of dropping the whole file', async () => {
    const noTitle = { uuid: 'z1', categoryUuid: '001', overview: { urls: [], tags: [] },
      details: { loginFields: [], notesPlain: '', sections: [] } };
    const r = await parse1Pux(await make1Pux(account([noTitle, loginItem()])));
    expect(r.items).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain('名称');
  });

  /**
   * ⚠️ 认不出的分类，**内容也要留住**。
   *
   * 1Password 的分类比 Bitwarden 多得多，而 1PUX 的字段全在 `sections` 里 ——
   * 如果一个都不读，用户的银行账户、驾照导进来就只剩一个标题。
   * 兜底做法：读不出结构的，把 section 里的内容全部挪进备注。
   */
  it('keeps the section contents of an unrecognised category in the notes', async () => {
    const odd = { uuid: 'x1', categoryUuid: '103', overview: { title: '银行账户', urls: [], tags: [] },
      details: { notesPlain: null, sections: [{ title: '账户', fields: [
        { id: 'bankName', title: '银行', value: '招行', fieldType: 'T' },
        { id: 'accountNumber', title: '账号', value: '6225xxxx', fieldType: 'T' },
      ] }] } };
    const r = await parse1Pux(await make1Pux(account([odd])));
    expect(r.items[0]!.notes).toContain('招行');
    expect(r.items[0]!.notes).toContain('6225xxxx');
  });

  it('reports a file that is not a ZIP', async () => {
    const r = await parse1Pux(new TextEncoder().encode('{"accounts":[]}'));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/ZIP/i);
  });

  /** 空账户不算错，只是没有条目 —— 不该报一堆「跳过」吓用户 */
  it('handles an export with no items', async () => {
    const r = await parse1Pux(await make1Pux({ accounts: [] }));
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
