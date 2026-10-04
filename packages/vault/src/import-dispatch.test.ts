import { describe, it, expect } from 'vitest';
import { parseImport, detectImportFormat, IMPORT_FORMATS } from './import-dispatch';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 一个最小的 1PUX（ZIP）—— 见 import-1pux.test.ts 里更完整的构造 */
async function make1Pux(): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify({ accounts: [{ attrs: {}, vaults: [{ attrs: { name: '个人' }, items: [
    { uuid: 'i1', categoryUuid: '001', favIndex: 0,
      overview: { title: 'GitHub', urls: [{ url: 'https://github.com' }], tags: [] },
      details: { loginFields: [{ name: 'username', value: 'me', designation: 'username' }], notesPlain: '', sections: [] } },
  ] }] }] }));
  const attrs = enc.encode('{}');

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of [{ name: 'export.data', body: data }, { name: 'export.attributes', body: attrs }]) {
    const nb = enc.encode(e.name);
    const local = new Uint8Array(30 + nb.length + e.body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 0, true);
    lv.setUint32(18, e.body.length, true); lv.setUint32(22, e.body.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30); local.set(e.body, 30 + nb.length);
    parts.push(local);

    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); cv.setUint32(20, e.body.length, true);
    cv.setUint32(24, e.body.length, true); cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    offset += local.length;
  }
  const cs = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 2, true); ev.setUint16(10, 2, true);
  ev.setUint32(12, cs, true); ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

const BW_CSV = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,,,,https://github.com,me,pw,';
const CHROME_CSV = 'name,url,username,password,note\nGitHub,https://github.com,me,pw,';
const BW_JSON = JSON.stringify({ encrypted: false, folders: [], items: [
  { id: 'c1', type: 1, name: 'GitHub', favorite: false,
    login: { uris: [{ match: 0, uri: 'https://github.com' }], username: 'me', password: 'pw', totp: null } },
] });
const PIF = '***aaaa-1111***\n' + JSON.stringify({ uuid: 'u1', typeName: 'Logins',
  secureContents: { title: 'GitHub', URLs: [{ url: 'https://github.com' }],
    fields: [{ name: 'username', value: 'me', designation: 'username' }] } }) + '\n';

describe('IMPORT_FORMATS', () => {
  it('lists every format the user can pick', () => {
    const ids = IMPORT_FORMATS.map((f) => f.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('1pux');
    expect(ids).toContain('bitwarden-json');
    expect(ids).toContain('csv');
  });

  /** 界面要拿这个标记决定「按文本读还是按字节读」—— 读错了 1PUX 就废了 */
  it('marks which formats need raw bytes', () => {
    expect(IMPORT_FORMATS.find((f) => f.id === '1pux')?.binary).toBe(true);
    expect(IMPORT_FORMATS.find((f) => f.id === 'csv')?.binary).toBeFalsy();
  });
});

/**
 * ⚠️ 识别**只是给界面预选用**，不是判据 —— 用户永远能自己改。
 *
 * 因为 1Password 与 Chrome 的 CSV 都是 `...,url,username,password,...`，
 * 光看列名分不开。猜错**不能**导致导入失败：下面每一条都断言
 * 「猜错时数据照样进得来」。
 */
describe('detectImportFormat', () => {
  it('spots a 1PUX by its ZIP magic', async () => {
    expect(await detectImportFormat(await make1Pux())).toBe('1pux');
  });

  it('spots a Bitwarden JSON', () => {
    expect(detectImportFormat(bytes(BW_JSON))).toBe('bitwarden-json');
  });

  it('spots a 1PIF', () => {
    expect(detectImportFormat(bytes(PIF))).toBe('1pif');
  });

  it('spots a Bitwarden CSV', () => {
    expect(detectImportFormat(bytes(BW_CSV))).toBe('bitwarden-csv');
  });

  it('falls back to the generic CSV for anything else tabular', () => {
    expect(detectImportFormat(bytes(CHROME_CSV))).toBe('csv');
  });

  it('returns null for something that is not a password export', () => {
    expect(detectImportFormat(bytes('日期,金额\n2026-01-01,12'))).toBeNull();
  });
});

describe('parseImport —— 自动识别', () => {
  it('imports a 1PUX end to end', async () => {
    const r = await parseImport(await make1Pux());
    expect(r.items[0]).toMatchObject({ name: 'GitHub', folderName: '个人' });
  });

  it('imports a Bitwarden JSON end to end', async () => {
    const r = await parseImport(bytes(BW_JSON));
    expect(r.items[0]!.login?.password).toBe('pw');
  });

  it('imports a 1PIF end to end', async () => {
    const r = await parseImport(bytes(PIF));
    expect(r.items[0]!.login?.username).toBe('me');
  });

  it('imports a generic CSV end to end', async () => {
    const r = await parseImport(bytes(CHROME_CSV));
    expect(r.items[0]).toMatchObject({ name: 'GitHub', login: { username: 'me', password: 'pw' } });
  });

  /** 界面把「自动」之外的选项交给这里 —— 用户明确指定时要按指定的走 */
  it('honours an explicitly chosen format', async () => {
    const r = await parseImport(bytes(BW_CSV), 'bitwarden-csv');
    expect(r.items).toHaveLength(1);
  });

  /**
   * ⚠️ 用户选错格式时，**要给一句能看懂的话**，而不是空结果。
   * 空结果在界面上表现为「导入了 0 条」，用户不知道是自己选错了还是文件坏了。
   */
  it('explains itself when the file does not match the chosen format', async () => {
    const r = await parseImport(bytes(BW_JSON), '1pux');
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toBeTruthy();
  });

  it('reports a file it cannot recognise at all', async () => {
    const r = await parseImport(bytes('随便一段文字'));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('认不出');
  });

  it('reports an empty file instead of throwing', async () => {
    const r = await parseImport(new Uint8Array(0));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toBeTruthy();
  });
});
