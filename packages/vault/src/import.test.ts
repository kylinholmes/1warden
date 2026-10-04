import { describe, it, expect } from 'vitest';
import { parseBitwardenCsv } from './import';

const HEADER = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';
const row = (...cells: string[]): string => cells.join(',');

describe('parseBitwardenCsv —— 正常映射', () => {
  const csv = [
    HEADER,
    row('工作', '1', 'login', 'GitHub', '备注', '', '0', 'https://github.com', 'me', 'pw123', ''),
  ].join('\n');

  it('maps the standard columns', () => {
    const r = parseBitwardenCsv(csv);
    expect(r.skipped).toEqual([]);
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it.name).toBe('GitHub');
    expect(it.folderName).toBe('工作');
    expect(it.favorite).toBe(true);
    expect(it.type).toBe('login');
    expect(it.notes).toBe('备注');
    expect(it.login).toEqual({ username: 'me', password: 'pw123', totp: null, uri: 'https://github.com' });
  });

  it('records the source row number so errors can point at it', () => {
    // 第 1 行是表头，数据从第 2 行开始
    expect(parseBitwardenCsv(csv).items[0]!.rowNumber).toBe(2);
  });
});

describe('parseBitwardenCsv —— 表头的宽容', () => {
  /** ⚠️ 不同版本的导出列名大小写与空格都不一样，按字面比会整份导入失败 */
  it('ignores case and surrounding spaces in column names', () => {
    const csv = [
      'Folder , FAVORITE,Type, NAME ,Login_URI,Login_Username,Login_Password',
      row('', '0', 'login', 'X', 'https://x.test', 'u', 'p'),
    ].join('\n');
    const it = parseBitwardenCsv(csv).items[0]!;
    expect(it.name).toBe('X');
    expect(it.login?.password).toBe('p');
  });

  it('accepts columns in a different order', () => {
    const csv = [
      'name,login_password,login_username',
      row('X', 'p', 'u'),
    ].join('\n');
    expect(parseBitwardenCsv(csv).items[0]!.login).toMatchObject({ username: 'u', password: 'p' });
  });

  it('tolerates missing optional columns', () => {
    const csv = ['name,login_password', row('X', 'p')].join('\n');
    const it = parseBitwardenCsv(csv).items[0]!;
    expect(it.folderName).toBeNull();
    expect(it.favorite).toBe(false);
    expect(it.login?.username).toBeNull();
  });

  /**
   * ⚠️ 没有 name 列**不再**视为错误。
   *
   * 早先这里直接拒绝（「表头里找不到 name 列」），但那份文件里的用户名和密码
   * 都是好的 —— 因为标题列缺失就把整份导入挡回去，用户丢掉的是全部密码。
   * 现在退而用用户名当名称：显示上不完美，但内容一条不少。
   */
  it('falls back to the username when there is no name column', () => {
    const r = parseBitwardenCsv(['login_password,login_username', row('p', 'u')].join('\n'));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: 'u', login: { username: 'u', password: 'p' } });
  });
});

describe('parseBitwardenCsv —— 类型', () => {
  it('accepts the type names the CSV export uses', () => {
    const csv = [HEADER,
      row('', '0', 'login', 'A', '', '', '0', '', '', '', ''),
      row('', '0', 'note', 'B', '', '', '0', '', '', '', ''),
      row('', '0', 'card', 'C', '', '', '0', '', '', '', ''),
      row('', '0', 'identity', 'D', '', '', '0', '', '', '', ''),
    ].join('\n');
    expect(parseBitwardenCsv(csv).items.map((i) => i.type)).toEqual(['login', 'secureNote', 'card', 'identity']);
  });

  /** 更老的导出用的是数字 */
  it('accepts legacy numeric types', () => {
    const csv = [HEADER,
      row('', '0', '1', 'A', '', '', '0', '', '', '', ''),
      row('', '0', '2', 'B', '', '', '0', '', '', '', ''),
    ].join('\n');
    expect(parseBitwardenCsv(csv).items.map((i) => i.type)).toEqual(['login', 'secureNote']);
  });

  it('falls back to a secure note for an unknown type', () => {
    // 宁可当成笔记（内容还在），也不要整行丢掉
    const csv = [HEADER, row('', '0', 'something-new', 'A', 'body', '', '0', '', '', '', '')].join('\n');
    const it = parseBitwardenCsv(csv).items[0]!;
    expect(it.type).toBe('secureNote');
    expect(it.notes).toBe('body');
  });
});

describe('parseBitwardenCsv —— 自定义字段', () => {
  it('parses the fields column', () => {
    const csv = [HEADER,
      row('', '0', 'login', 'A', '', '"PIN: 4321\n备用: abc"', '0', '', '', '', ''),
    ].join('\n');
    const it = parseBitwardenCsv(csv).items[0]!;
    expect(it.customFields).toEqual([
      { name: 'PIN', value: '4321', type: 0 },
      { name: '备用', value: 'abc', type: 0 },
    ]);
  });

  it('keeps a value that itself contains a colon', () => {
    const csv = [HEADER, row('', '0', 'login', 'A', '', '"url: https://x.test"', '0', '', '', '', '')].join('\n');
    expect(parseBitwardenCsv(csv).items[0]!.customFields[0])
      .toEqual({ name: 'url', value: 'https://x.test', type: 0 });
  });
});

describe('parseBitwardenCsv —— 跳过的行', () => {
  it('skips empty lines', () => {
    const csv = [HEADER, row('', '0', 'login', 'A', '', '', '0', '', '', 'p', ''), '', ''].join('\n');
    expect(parseBitwardenCsv(csv).items).toHaveLength(1);
  });

  /**
   * ⚠️ 没有名称的行**不再跳过**，改成用用户名当名称。
   *
   * 早先的判断是「没名字的条目在列表里是一片空白，用户找不回来」。但对比一下
   * 两种代价：名字不完美只是不好看，而**跳过等于用户丢了一条密码** ——
   * 而且他不会知道。第一条规则（不丢内容）优先。
   *
   * 三者都没有（名称、用户名、网址全空）才跳过 —— 那行确实什么都给不出来。
   */
  it('falls back to the username for a row with no name', () => {
    const csv = [HEADER,
      row('', '0', 'login', '', '', '', '0', '', 'me', 'p', ''),
      row('', '0', 'login', 'B', '', '', '0', '', '', 'p', ''),
    ].join('\n');
    const r = parseBitwardenCsv(csv);
    expect(r.items.map((i) => i.name)).toEqual(['me', 'B']);
    expect(r.skipped).toEqual([]);
  });

  it('skips a row that has no name, username or url at all', () => {
    const csv = [HEADER,
      row('', '0', 'login', '', '', '', '0', '', '', '', ''),
      row('', '0', 'login', 'B', '', '', '0', '', '', 'p', ''),
    ].join('\n');
    const r = parseBitwardenCsv(csv);
    expect(r.items.map((i) => i.name)).toEqual(['B']);
    expect(r.skipped[0]).toMatchObject({ rowNumber: 2 });
  });

  it('skips a row that is shorter than the header', () => {
    const csv = [HEADER, 'login,A'].join('\n');
    const r = parseBitwardenCsv(csv);
    expect(r.items).toEqual([]);
    // ⚠️ 断言原因，不能只数条数 —— 短行会**恰好**被「没有名称」那条也兜住，
    // 于是「不检查列数」的实现在这条测试下照样绿（变异检验抓到的）
    expect(r.skipped[0]?.reason).toContain('列');
  });

  /**
   * ⚠️ 这条才是列数检查真正要防的：行**够得到** name 列（name 是第 4 列），
   * 但后面全缺。不拦的话会写出一个只有名字、其余全空的条目 ——
   * 用户看到列表里多出一条叫 A 的空记录，不知道它是哪来的，也不知道少了什么。
   */
  it('skips a truncated row even when the name column is present', () => {
    const csv = [HEADER, 'a,b,c,A,bogus'].join('\n');
    const r = parseBitwardenCsv(csv);
    expect(r.items).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('列');
  });
});

describe('parseBitwardenCsv —— 不丢内容', () => {
  /** 导入是一次性、不可重来的操作：丢一条密码，用户就得重新导出再导一遍 */
  it('keeps a password containing quotes and commas intact', () => {
    const csv = [HEADER,
      row('', '0', 'login', 'A', '', '', '0', 'https://x.test', 'me', '"p@ss,""word"",1"', ''),
    ].join('\n');
    expect(parseBitwardenCsv(csv).items[0]!.login?.password).toBe('p@ss,"word",1');
  });

  it('keeps a multi-line note intact', () => {
    const csv = [HEADER, row('', '0', 'note', 'A', '"第一行\n第二行"', '', '0', '', '', '', '')].join('\n');
    expect(parseBitwardenCsv(csv).items[0]!.notes).toBe('第一行\n第二行');
  });

  it('treats an empty string as null rather than as an empty value', () => {
    // 空的用户名与「用户名是空字符串」在后续写入时行为不同
    const csv = [HEADER, row('', '0', 'login', 'A', '', '', '0', '', '', 'p', '')].join('\n');
    const it = parseBitwardenCsv(csv).items[0]!;
    expect(it.login?.username).toBeNull();
    expect(it.notes).toBeNull();
  });
});
