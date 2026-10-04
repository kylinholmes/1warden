/**
 * 从 CSV 导入。
 *
 * ## 为什么这是「面向普通个人用户」的硬门槛
 *
 * 没有人会从零开始录几百条密码。**没有导入，就没法迁进来** —— 一个再好的
 * 密码管理器，用户第一步过不去就等于不存在。
 *
 * ## 为什么做 Bitwarden 格式
 *
 * 它是这个生态里的互通格式：Bitwarden 官方导出、KeePass 的转换插件、
 * 1Password 的转换器都能产出它。支持一种格式就打开了整条迁移路径。
 *
 * ## 两条不可动摇的规则
 *
 * 1. **不丢内容。** 导入是一次性、不可重来的操作 —— 丢一条密码，用户就得
 *    重新导出、重新导入，还可能已经写进去半份数据。所以宁可把不认识的东西
 *    当成安全笔记留下，也不要整行丢掉。
 * 2. **跳过的行必须报出来。** 「导入了 187 条」而不说「跳过了 3 条」，
 *    用户不会发现少了什么，直到某天要登录某个网站。
 */
import { parseCsv } from './csv';

export type ImportedType = 'login' | 'secureNote' | 'card' | 'identity';

export interface ImportedField {
  name: string;
  value: string;
  /** 0=文本 1=隐藏 —— 与 Bitwarden 的字段类型一致 */
  type: 0 | 1;
}

export interface ImportedItem {
  name: string;
  type: ImportedType;
  folderName: string | null;
  favorite: boolean;
  notes: string | null;
  login: { username: string | null; password: string | null; totp: string | null; uri: string | null } | null;
  customFields: ImportedField[];
  /** 在源文件里的行号（表头是第 1 行）—— 报告问题时要能指出来 */
  rowNumber: number;
}

export interface ImportResult {
  items: ImportedItem[];
  skipped: { rowNumber: number; reason: string }[];
}

/** CSV 里 type 列可能写名字也可能写数字 */
const TYPE_BY_NAME: Record<string, ImportedType> = {
  login: 'login',
  note: 'secureNote',
  securenote: 'secureNote',
  card: 'card',
  identity: 'identity',
  '1': 'login',
  '2': 'secureNote',
  '3': 'card',
  '4': 'identity',
};

/** 把一格里的空串归一成 null —— 「空用户名」与「没有用户名」在写入时行为不同 */
function orNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length === 0 ? null : v!.trim();
}

/** `1` / `true` / `yes` 都算真 —— 不同版本的导出不一样 */
function truthy(v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

/**
 * 解析 `fields` 那一格：`名称: 值`，多条以换行分隔。
 *
 * ⚠️ 只按**第一个**冒号切。值里带冒号是常事（URL、时间），
 * 按最后一个切或全切都会把值弄坏。
 */
function parseFields(cell: string | undefined): ImportedField[] {
  const raw = (cell ?? '').trim();
  if (raw.length === 0) return [];

  return raw.split('\n').map((line) => {
    const idx = line.indexOf(':');
    if (idx < 0) return { name: line.trim(), value: '', type: 0 as const };
    return {
      name: line.slice(0, idx).trim(),
      value: line.slice(idx + 1).trim(),
      type: 0 as const,
    };
  }).filter((f) => f.name.length > 0);
}

/**
 * 解析 Bitwarden 格式的 CSV。
 *
 * 表头按**列名**定位而不是按位置 —— 不同版本的导出列序与命名都不一样，
 * 按位置读会在换一个版本之后整份错位，而错位是静默的：名字进了密码列，
 * 用户要等到登录失败才会发现。
 */
export function parseBitwardenCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { items: [], skipped: [] };

  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  const col = (name: string): number => header.indexOf(name);

  const iName = col('name');
  if (iName < 0) {
    return { items: [], skipped: [{ rowNumber: 1, reason: '表头里找不到 name 列 —— 这不像 Bitwarden 导出的 CSV' }] };
  }

  const idx = {
    folder: col('folder'), favorite: col('favorite'), type: col('type'),
    notes: col('notes'), fields: col('fields'), reprompt: col('reprompt'),
    uri: col('login_uri'), username: col('login_username'),
    password: col('login_password'), totp: col('login_totp'),
  };

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const rowNumber = r + 1;
    const at = (i: number): string | undefined => (i < 0 ? undefined : cells[i]);

    // 完全空的行（末尾换行、手改文件留下的空行）不算「跳过」，不报
    if (cells.every((c) => c.trim().length === 0)) continue;

    // 列数比表头少说明这行是坏的。硬按位置读会读到 undefined，
    // 然后写出一个字段全空的条目 —— 那比不导入更糟
    if (cells.length < header.length) {
      skipped.push({ rowNumber, reason: `只有 ${cells.length} 列，少于表头的 ${header.length} 列` });
      continue;
    }

    const name = (at(iName) ?? '').trim();
    if (name.length === 0) {
      skipped.push({ rowNumber, reason: '没有名称' });
      continue;
    }

    const typeCell = (at(idx.type) ?? '').trim().toLowerCase();
    /*
     * 类型推断。
     *
     * ⚠️ 不能只看 type 列：有的导出/转换器**根本没有这一列**，或者留空。
     * 那样会把一堆登录条目当成安全笔记导进来 —— 用户名密码都还在 notes 里
     * 躺着，但自动填充一条都匹配不上，用户完全不知道发生了什么。
     *
     * 所以缺类型时看**内容**：只要 login_* 里有东西，它就是登录。
     * 认不出的非空类型名才退回笔记（内容保住，用户能自己归类）。
     */
    const hasLoginData = [idx.username, idx.password, idx.uri, idx.totp]
      .some((i) => (at(i) ?? '').trim().length > 0);
    const type: ImportedType = TYPE_BY_NAME[typeCell]
      ?? (typeCell.length === 0 && hasLoginData ? 'login' : 'secureNote');

    const login = type === 'login'
      ? {
        username: orNull(at(idx.username)),
        password: orNull(at(idx.password)),
        totp: orNull(at(idx.totp)),
        uri: orNull(at(idx.uri)),
      }
      : null;

    items.push({
      name,
      type,
      folderName: orNull(at(idx.folder)),
      favorite: truthy(at(idx.favorite)),
      notes: orNull(at(idx.notes)),
      login,
      customFields: parseFields(at(idx.fields)),
      rowNumber,
    });
  }

  return { items, skipped };
}
