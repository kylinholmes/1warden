import { describe, it, expect } from 'vitest';
import { parseGenericCsv, detectCsvFormat, splitDelimiter } from './import-csv';

const csv = (...lines: string[]): string => lines.join('\n');

describe('detectCsvFormat —— 认出是哪家的导出', () => {
  it('recognises a 1Password CSV', () => {
    const text = csv('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes', 'GitHub,https://github.com,me,pw,,0,0,,');
    expect(detectCsvFormat(text)).toMatchObject({ id: '1password' });
  });

  it('recognises a Bitwarden CSV', () => {
    const text = csv('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp', ',,login,X,,,,,,,');
    expect(detectCsvFormat(text)).toMatchObject({ id: 'bitwarden' });
  });

  it('recognises a Chrome/Edge CSV', () => {
    const text = csv('name,url,username,password,note', 'GitHub,https://github.com,me,pw,');
    expect(detectCsvFormat(text)).toMatchObject({ id: 'chromium' });
  });

  it('recognises a LastPass CSV', () => {
    const text = csv('url,username,password,extra,name,grouping,fav', 'https://x.test,u,p,,X,,0');
    expect(detectCsvFormat(text)).toMatchObject({ id: 'lastpass' });
  });

  /**
   * ⚠️ 1Password 与 Chrome 的 CSV 都是 `...,url,username,password,...` ——
   * 光看列名分不开。检测是给 UI **预选**用的提示，不是唯一判据：
   * 用户永远能在界面上自己改。所以这里只要求「尽量猜对」，
   * 猜错不能导致导入失败。
   */
  it('does not lose data when the guess is wrong', () => {
    const text = csv('Title,Url,Username,Password', 'GitHub,https://github.com,me,pw');
    const r = parseGenericCsv(text, detectCsvFormat(text));
    expect(r.items[0]!.login?.password).toBe('pw');
  });

  it('returns null for something that is not a password CSV at all', () => {
    expect(detectCsvFormat(csv('日期,金额,备注', '2026-01-01,12,午饭'))).toBeNull();
  });
});

/**
 * ⚠️ **同义词匹配，而不是照抄每家的列名表。**
 *
 * Bitwarden 支持约六十种 CSV 格式，逐个维护列表是维护不完的：
 * 各家改一次导出、加一列，那份表就悄悄过时了，而症状是「用户导进来一堆空条目」。
 * 按语义匹配列名则天然容忍这些差异 —— 也顺带覆盖了 Excel 手工整理过的表头。
 */
describe('parseGenericCsv —— 按语义认列', () => {
  it('maps the standard columns of any common export', () => {
    const text = csv('name,url,username,password,note', 'GitHub,https://github.com,me,pw123,备忘');
    const r = parseGenericCsv(text);
    expect(r.skipped).toEqual([]);
    expect(r.items[0]).toMatchObject({
      name: 'GitHub',
      notes: '备忘',
      login: { username: 'me', password: 'pw123', uri: 'https://github.com' },
    });
    expect(r.items[0]!.rowNumber).toBe(2);
  });

  it('accepts alternative spellings for the same field', () => {
    for (const [uriCol, userCol] of [
      ['url', 'username'], ['uri', 'user'], ['website', 'login'], ['web site', 'email'],
      ['link', 'account'], ['URL', 'USERNAME'],
    ] as const) {
      const r = parseGenericCsv(csv(`${uriCol},${userCol},password`, 'https://x.test,me,pw'));
      expect(r.items[0]!.login).toMatchObject({ uri: 'https://x.test', username: 'me', password: 'pw' });
    }
  });

  it('picks up a TOTP column written any of the usual ways', () => {
    for (const col of ['otp', 'otpauth', 'totp', 'login_totp', '2fa']) {
      const r = parseGenericCsv(csv(`name,username,password,${col}`, 'X,me,pw,otpauth://totp/X?secret=ABC'));
      expect(r.items[0]!.login?.totp).toBe('otpauth://totp/X?secret=ABC');
    }
  });

  it('maps folder-like columns to the folder', () => {
    for (const col of ['folder', 'grouping', 'group', 'category', 'collection', 'vault']) {
      const r = parseGenericCsv(csv(`name,username,password,${col}`, 'X,me,pw,工作'));
      expect(r.items[0]!.folderName).toBe('工作');
    }
  });

  /** ⚠️ 认列**按语义**，但只要认出了登录数据，就不能把它当笔记 —— 见下 */
  it('treats a row with login data as a login even when there is no type column', () => {
    const r = parseGenericCsv(csv('name,username,password', 'X,me,pw'));
    expect(r.items[0]!.type).toBe('login');
  });

  it('treats a row with no login data as a secure note', () => {
    const r = parseGenericCsv(csv('name,notes', 'X,一段笔记'));
    expect(r.items[0]!.type).toBe('secureNote');
    expect(r.items[0]!.notes).toBe('一段笔记');
  });

  it('honours an explicit type column when there is one', () => {
    const r = parseGenericCsv(csv('name,type,username,password', 'X,note,me,pw'));
    expect(r.items[0]!.type).toBe('secureNote');
  });

  it('records the folder and the favorite flag', () => {
    const r = parseGenericCsv(csv('name,username,password,folder,favorite', 'X,me,pw,工作,1'));
    expect(r.items[0]).toMatchObject({ folderName: '工作', favorite: true });
  });

  /**
   * ⚠️ 没有名称时**退而用用户名或网址当名称**，而不是跳过。
   *
   * LastPass 这类导出里 name 经常是空的，但 url 和 username 都在 ——
   * 那是一条**完整的可用凭据**。因为「名字不完美」就把它丢掉，
   * 违反的是第一条规则（不丢内容）：用户丢的是一条密码，
   * 而不是一个显示得不够漂亮的标题。
   */
  it('falls back to the username when there is no name', () => {
    const r = parseGenericCsv(csv('name,username,password', ',me,pw'));
    expect(r.items[0]).toMatchObject({ name: 'me', login: { username: 'me', password: 'pw' } });
  });

  it('falls back to the url when there is neither a name nor a username', () => {
    const r = parseGenericCsv(csv('name,url,password', ',,https://x.test'));
    expect(r.items).toEqual([]);   // 这行只有两列，先被列数检查拦下
    const r2 = parseGenericCsv(csv('name,url,username,password', ',https://x.test,,pw'));
    expect(r2.items[0]!.name).toBe('https://x.test');
  });

  /** 三者都没有才跳过 —— 那行确实什么都给不出来 */
  it('skips a row with no name, username or url and says which row', () => {
    const r = parseGenericCsv(csv('name,url,username,password,notes', ',,,,只有备注', 'Y,u,x.test,pw,'));
    expect(r.items.map((i) => i.name)).toEqual(['Y']);
    expect(r.skipped[0]).toMatchObject({ rowNumber: 2 });
  });

  it('skips a broken short row instead of inventing an empty entry', () => {
    const r = parseGenericCsv(csv('name,url,username,password,notes', 'X,https://x.test'));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('列');
  });

  /** 一个都认不出来时要明确失败，而不是把整份文件导成六十条空笔记 */
  it('reports an error when no column can be recognised', () => {
    const r = parseGenericCsv(csv('日期,金额', '2026-01-01,12'));
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('认不出');
  });

  /** ⚠️ 按第一个冒号切。值里带冒号是常事（URL、时间），全切会把值弄坏 */
  it('keeps a value that itself contains a colon when splitting extra fields', () => {
    // 用 Bitwarden 的 fields 列 —— 只有它是「名称: 值」成对写的
    const r = parseGenericCsv(csv('name,username,password,fields', 'X,me,pw,"网址: https://x.test"'));
    expect(r.items[0]!.customFields[0]).toEqual({ name: '网址', value: 'https://x.test', type: 0 });
  });

  it('keeps the whole cell when it has no colon at all', () => {
    const r = parseGenericCsv(csv('name,username,password,fields', 'X,me,pw,一段没有冒号的备注'));
    expect(r.items[0]!.customFields[0]).toEqual({ name: '一段没有冒号的备注', value: '', type: 0 });
  });

  /** ⚠️ `extra` 是 LastPass 的**备注**列，不是自定义字段 —— 别认错 */
  it('treats a LastPass-style extra column as notes', () => {
    const r = parseGenericCsv(csv('url,username,password,extra,name,grouping,fav', 'https://x.test,me,pw,备注内容,X,工作,1'));
    expect(r.items[0]).toMatchObject({ name: 'X', notes: '备注内容', folderName: '工作', favorite: true });
  });
});

/**
 * ⚠️ **分号分隔符。**
 *
 * 欧洲区域设置的 Excel 导出 CSV 用 `;` 而不是 `,`（因为那些语言里逗号是小数点）。
 * 按逗号切会把整行读成一列，于是**每一行的名字都成了整行文本** ——
 * 导入「成功」了，但内容全错，而用户要过很久才发现。
 */
describe('splitDelimiter —— Excel 的分号', () => {
  it('detects a comma-delimited file', () => {
    expect(splitDelimiter('name,url,username\nX,https://x.test,me')).toBe(',');
  });

  it('detects a semicolon-delimited file', () => {
    expect(splitDelimiter('name;url;username\nX;https://x.test;me')).toBe(';');
  });

  it('detects a tab-delimited file', () => {
    expect(splitDelimiter('name\turl\tusername\nX\thttps://x.test\tme')).toBe('\t');
  });

  /** 引号里的分隔符不算 —— `"a,b";c` 是两列不是三列 */
  it('ignores delimiters inside quotes', () => {
    expect(splitDelimiter('"名字, 带逗号";url;username\n"X, Y";https://x.test;me')).toBe(';');
  });

  it('parses a semicolon file end to end', () => {
    const r = parseGenericCsv('name;username;password\nX;me;pw');
    expect(r.items[0]).toMatchObject({ name: 'X', login: { username: 'me', password: 'pw' } });
  });
});
