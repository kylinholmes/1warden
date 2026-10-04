/**
 * 通用 CSV 导入 —— 按**语义**认列，而不是照抄每家的列名表。
 *
 * ## 为什么不逐家维护列名
 *
 * Bitwarden 支持约六十种 CSV 格式，1Password 也能从几十种来源导入。
 * 逐个维护「哪个格式有哪些列」是维护不完的：各家改一次导出、加一列，
 * 那份表就悄悄过时了 —— 而过时的症状是「用户导进来一堆空条目」，
 * 或者更糟：「导入成功」但字段全是错的，用户要过很久才发现。
 *
 * 改成按语义匹配（`url` / `uri` / `website` / `link` 都是网址）之后，
 * 天然容忍这些差异，还顺带覆盖了用户手工整理过表头的 Excel 文件 ——
 * 那种文件不属于任何「格式」，却恰恰是最常见的。
 *
 * ## 两条不可动摇的规则（与 Bitwarden 那条路径一致）
 *
 * 1. **不丢内容。** 导入是一次性、不可重来的操作。
 * 2. **跳过的行必须报出来。** 「导入了 187 条」而不说「跳过了 3 条」，
 *    用户不会发现少了什么，直到某天要登录某个网站。
 */
import { parseCsv } from './csv';
import type { ImportedField, ImportedItem, ImportedType, ImportResult } from './import';

/**
 * 每个字段认哪些列名。
 *
 * ⚠️ 顺序有意义：**靠前的优先**。同一个表头匹配到多个字段时（比如
 * `category` 既像「文件夹」又像「类型」），先匹配上的赢。
 * 列表本身按「从具体到宽泛」排，别把宽泛的放前面。
 */
const SYNONYMS: Record<string, readonly string[]> = {
  name: ['name', 'title', 'login_name', 'item', 'entry', 'account_name', 'site'],
  username: ['username', 'user_name', 'user', 'login_username', 'loginname', 'login', 'email', 'email_address', 'account'],
  password: ['password', 'passwd', 'pass', 'pwd', 'login_password'],
  totp: ['login_totp', 'otpauth', 'otp', 'totp', 'two_factor_secret', '2fa'],
  uri: ['login_uri', 'url', 'uri', 'website', 'web_site', 'link', 'urls', 'site_url'],
  notes: ['notes', 'note', 'comment', 'comments', 'memo'],
  /**
   * ⚠️ `extra` 必须**单独一项**，不能并进 `notes`。
   *
   * `fieldOf` 返回的是字段名而不是列名 —— 并进 `notes` 的话，
   * `at(cells, 'extra')` 永远取不到东西（索引里那个键叫 `notes`）。
   * 而 LastPass 的备注就写在这一列里，漏了它用户的备注会整批丢掉。
   */
  extra: ['extra'],
  folder: ['grouping', 'folder', 'group', 'collection', 'vault', 'path', 'category'],
  favorite: ['favorite', 'favourite', 'starred', 'star', 'pinned', 'fav'],
  type: ['type', 'kind', 'item_type'],
  /** 自定义字段那一格 —— 只有 Bitwarden 有，但认出来能让它走同一条路 */
  fields: ['fields', 'custom_fields', 'extra_fields'],
};

/** 表头归一：小写、去空格与标点。`Login URI` / `login_uri` / `loginURI` 归一后相同 */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** 归一后的同义词表，建一次就够 */
const NORMALIZED: Array<[string, string[]]> = Object.entries(SYNONYMS)
  .map(([field, names]) => [field, names.map(normalizeHeader)] as [string, string[]]);

/** 一个表头属于哪个字段；认不出返回 null */
function fieldOf(header: string): string | null {
  const h = normalizeHeader(header);
  if (h.length === 0) return null;
  for (const [field, names] of NORMALIZED) {
    if (names.includes(h)) return field;
  }
  return null;
}

/**
 * 认出 CSV 用的是什么分隔符。
 *
 * ⚠️ 欧洲区域设置的 Excel 导出用 `;`（那些语言里逗号是小数点）。
 * 按逗号硬切会把整行读成一列，于是**每一行的名字都成了整行文本** ——
 * 导入「成功」了，但内容全错，用户要过很久才发现。
 *
 * 按**第一行**数引号外的候选符号，取最多的那个。
 */
export function splitDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const counts = new Map<string, number>([['\t', 0], [';', 0], [',', 0]]);

  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  // 平局时按 tab > ; > , 的顺序取 —— 越罕用的分隔符出现了就越说明是它
  for (const d of ['\t', ';', ',']) {
    if ((counts.get(d) ?? 0) > 0) return d;
  }
  return ',';
}

/** 按第一个冒号切 —— 值里带冒号是常事（URL、时间），全切会把值弄坏 */
function parseExtraFields(cell: string | null | undefined): ImportedField[] {
  const raw = (cell ?? '').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => {
    const idx = line.indexOf(':');
    if (idx < 0) return { name: line.trim(), value: '', type: 0 as const };
    return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim(), type: 0 as const };
  }).filter((f) => f.name.length > 0);
}

function orNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length === 0 ? null : t;
}

function truthy(v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
}

const TYPE_BY_NAME: Record<string, ImportedType> = {
  login: 'login', note: 'secureNote', securenote: 'secureNote', secure_note: 'secureNote',
  card: 'card', identity: 'identity',
  '1': 'login', '2': 'secureNote', '3': 'card', '4': 'identity',
};

/** 表头行 → 字段 → 列号 */
export interface ColumnLayout {
  readonly index: ReadonlyMap<string, number>;
  /** 归一后的表头，用于格式识别 */
  readonly headers: readonly string[];
}

export function layoutOf(rows: readonly string[][]): ColumnLayout {
  const header = rows[0] ?? [];
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const f = fieldOf(h);
    // 先出现的赢 —— 同名同义的列以第一列为准
    if (f !== null && !index.has(f)) index.set(f, i);
  });
  return { index, headers: header.map(normalizeHeader) };
}

/**
 * 通用的 CSV 解析。
 *
 * 不传格式也能用 —— 认列是按语义的，不依赖「这是哪家的文件」。
 * `detectCsvFormat` 的结果只是给 UI 预选用的提示。
 */
export function parseGenericCsv(text: string, _format?: unknown): ImportResult {
  const delimiter = splitDelimiter(text);
  const rows = delimiter === ',' ? parseCsv(text) : parseCsv(text.replaceAll(delimiter, ','));

  if (rows.length === 0) return { items: [], skipped: [] };
  const layout = layoutOf(rows);

  // 一个字段都认不出来 → 明确失败。硬导的话会得到一堆只有名字（或连名字都没有）的空条目
  if (layout.index.size === 0) {
    return {
      items: [],
      skipped: [{ rowNumber: 1, reason: '表头里认不出任何已知的列名（网址/用户名/密码/名称…）—— 这不像密码导出的 CSV' }],
    };
  }

  const at = (cells: readonly string[], field: string): string | undefined => {
    const i = layout.index.get(field);
    return i === undefined ? undefined : cells[i];
  };

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];
  const headerLen = rows[0]!.length;

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const rowNumber = r + 1;

    // 完全空的行不算「跳过」，不报 —— 那是末尾换行或手改文件留下的
    if (cells.every((c) => c.trim().length === 0)) continue;

    // 列数比表头少说明这行是坏的。硬按位置读会写出一个字段全空的条目 —— 那比不导入更糟
    if (cells.length < headerLen) {
      skipped.push({ rowNumber, reason: `只有 ${cells.length} 列，少于表头的 ${headerLen} 列` });
      continue;
    }

    // 名字缺失时退而用用户名/网址做名字 —— 有名字总比一片空白强
    const name = orNull(at(cells, 'name'))
      ?? orNull(at(cells, 'username'))
      ?? orNull(at(cells, 'uri'));
    if (name === null) {
      skipped.push({ rowNumber, reason: '没有名称（也没有用户名或网址可当名称）' });
      continue;
    }

    const username = orNull(at(cells, 'username'));
    const password = orNull(at(cells, 'password'));
    const totp = orNull(at(cells, 'totp'));
    const uri = orNull(at(cells, 'uri'));

    /*
     * 类型推断。
     *
     * ⚠️ 不能只看 type 列：大部分导出**根本没有这一列**。
     * 那样会把一堆登录条目当成安全笔记导进来 —— 用户名密码还在，
     * 但自动填充一条都匹配不上，用户完全不知道发生了什么。
     *
     * 所以缺类型时看**内容**：只要登录字段里有东西，它就是登录。
     */
    const typeCell = (at(cells, 'type') ?? '').trim().toLowerCase();
    const hasLoginData = [username, password, totp, uri].some((v) => v !== null);
    const type: ImportedType = TYPE_BY_NAME[typeCell]
      ?? (typeCell.length === 0 && hasLoginData ? 'login' : 'secureNote');

    const extra = orNull(at(cells, 'fields'));

    /*
     * 笔记。两个来源，**与条目类型无关**：
     *   - `notes` / `comment` / `memo` 这类明确的备注列
     *   - LastPass 那种把备注写在 `extra` 里的
     *
     * ⚠️ 早先只在**非登录**条目上回退到 `extra`，而 LastPass 导出的行
     * 全都是登录 —— 于是用户的备注整批丢掉，且不会有人报错。
     */
    const notesCell = orNull(at(cells, 'notes')) ?? orNull(at(cells, 'extra'));
    // 笔记类条目：登录字段里的东西不能丢，挪进 notes（宁可放错地方，不可丢）
    const notes = type === 'login' ? notesCell : (notesCell ?? username ?? password);

    items.push({
      name,
      type,
      folderName: orNull(at(cells, 'folder')),
      favorite: truthy(at(cells, 'favorite')),
      notes,
      login: type === 'login' ? { username, password, totp, uri } : null,
      customFields: parseExtraFields(extra),
      rowNumber,
    });
  }

  return { items, skipped };
}

export interface CsvFormatGuess {
  id: string;
  label: string;
}

/**
 * 猜是哪家的导出。
 *
 * ⚠️ **这只是给 UI 预选用的提示，不是判据。** 1Password 与 Chrome 的 CSV
 * 都是 `...,url,username,password,...`，光看列名分不开 —— 所以界面上必须
 * 让用户能自己改，而猜错也**不能**导致导入失败（解析本身是按语义的）。
 */
export function detectCsvFormat(text: string): CsvFormatGuess | null {
  const rows = parseCsv(text);
  if (rows.length === 0) return null;
  const h = new Set(rows[0]!.map(normalizeHeader));

  const has = (...names: string[]): boolean => names.every((n) => h.has(normalizeHeader(n)));

  if (has('folder', 'reprompt', 'login_uri')) return { id: 'bitwarden', label: 'Bitwarden (CSV)' };
  if (has('OTPAuth', 'Archived', 'Favorite')) return { id: '1password', label: '1Password (CSV)' };
  if (has('grouping', 'fav')) return { id: 'lastpass', label: 'LastPass (CSV)' };
  if (has('httpRealm', 'formActionOrigin')) return { id: 'firefox', label: 'Firefox (CSV)' };
  if (has('otpSecret') || (has('title', 'category') && has('username2'))) {
    return { id: 'dashlane', label: 'Dashlane (CSV)' };
  }
  // 认得出「有名字/网址/用户名/密码」就按通用的 Chromium 系处理 ——
  // Chrome / Edge / Brave / Opera / Vivaldi 的表头完全一样
  if (has('name', 'url', 'username', 'password')) {
    return { id: 'chromium', label: '浏览器导出（Chrome / Edge / Brave …）' };
  }
  if (has('url', 'username', 'password')) return { id: 'generic', label: '通用 CSV' };
  return null;
}
