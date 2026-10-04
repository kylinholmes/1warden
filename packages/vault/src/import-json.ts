/**
 * 结构化格式的导入 —— Bitwarden JSON 与 1Password 的 1PIF。
 *
 * ## 为什么这两种必须单独做，不能压成 CSV
 *
 * CSV 只有那几列。用户的卡片有效期、身份里的地址、网址的匹配方式、
 * 自定义字段的隐藏标记 —— 在 CSV 里**没有地方放**，只能丢。
 *
 * 而 Bitwarden 的 JSON 与 1Password 的导出是**无损**的：结构完整地在里面。
 * 把它们当 CSV 处理，用户拿到的是「导入成功」四个字和一库残缺的数据。
 *
 * ## 两条规则与 CSV 那条路径一致
 *
 * 1. **不丢内容** —— 认不出的类型当笔记留下，而不是整条丢掉。
 * 2. **跳过的条目标出来** —— 并说清楚是哪一条、为什么。
 */
import type {
  ImportedCard, ImportedField, ImportedIdentity, ImportedItem, ImportedType,
  ImportResult, ImportedUri,
} from './import';

export interface JsonFormatGuess {
  id: string;
  label: string;
}

/**
 * 1PIF 的记录分隔行：`***<uuid>***`。
 *
 * ⚠️ 中间那段刻意写得宽（不限定必须是十六进制 UUID）：真实文件里出现过
 * 各种变体，卡太死会让**整个文件被当成一条记录** —— 然后那一条解析失败，
 * 用户看到的是「导入了 0 条」，而文件明明是好的。
 */
const PIF_SEPARATOR = /^\*\*\*[^*]+\*\*\*$/;

export function detectJsonFormat(text: string): JsonFormatGuess | null {
  const head = text.slice(0, 4096).trimStart();

  if (head.startsWith('***')) return { id: '1pif', label: '1Password (1PIF)' };

  if (head.startsWith('{')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      // Bitwarden 的未加密导出：有 items 数组；加密导出有 encrypted + data
      if (typeof o === 'object' && o !== null && (Array.isArray(o['items']) || o['encrypted'] === true)) {
        return { id: 'bitwarden', label: 'Bitwarden (JSON)' };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function fieldsOf(raw: unknown): ImportedField[] {
  return arr(raw).map((f) => {
    const o = obj(f) ?? {};
    const type = o['type'];
    return {
      name: str(o['name']) ?? '',
      value: typeof o['value'] === 'string' ? o['value'] : '',
      // 只认 0/1，别的一律当文本 —— 写坏了会把可见字段变成隐藏
      type: (type === 1 ? 1 : 0) as 0 | 1,
    };
  }).filter((f) => f.name.length > 0);
}

function cardOf(raw: unknown): ImportedCard | null {
  const o = obj(raw);
  if (o === null) return null;
  return {
    cardholderName: str(o['cardholderName']),
    brand: str(o['brand']),
    number: str(o['number']),
    expMonth: str(o['expMonth']),
    expYear: str(o['expYear']),
    code: str(o['code']),
  };
}

const IDENTITY_KEYS: Array<keyof ImportedIdentity> = [
  'title', 'firstName', 'middleName', 'lastName', 'address1', 'address2', 'address3',
  'city', 'state', 'postalCode', 'country', 'company', 'email', 'phone', 'ssn',
  'username', 'passportNumber', 'licenseNumber',
];

function identityOf(raw: unknown): ImportedIdentity | null {
  const o = obj(raw);
  if (o === null) return null;
  const out = {} as ImportedIdentity;
  for (const k of IDENTITY_KEYS) out[k] = str(o[k]);
  return out;
}

/** Bitwarden 的数字类型 → 我们的类型。认不出的当笔记（内容保住，用户能自己归类） */
function bitwardenType(n: unknown): ImportedType {
  switch (n) {
    case 1: return 'login';
    case 3: return 'card';
    case 4: return 'identity';
    case 2: return 'secureNote';
    default: return 'secureNote';
  }
}

/**
 * Bitwarden 的未加密 JSON 导出。
 *
 * ⚠️ **加密导出（`encrypted: true`）要明确拒绝**，而不是硬解。
 * 那种文件里是一整块密文，硬当普通 JSON 读会得到零条「成功导入」——
 * 用户以为导完了，其实什么都没有，而报告上一个字都没提。
 */
export function parseBitwardenJson(text: string): ImportResult {
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    const o = obj(parsed);
    if (o === null) throw new Error('not an object');
    root = o;
  } catch {
    return { items: [], skipped: [{ rowNumber: 1, reason: '这不是一个合法的 JSON 文件' }] };
  }

  if (root['encrypted'] === true) {
    return {
      items: [],
      skipped: [{
        rowNumber: 1,
        reason: '这是 Bitwarden 的**加密**导出，无法直接读取 —— 请在 Bitwarden 里重新导出一份未加密的 JSON（或 CSV）',
      }],
    };
  }

  const folderName = new Map<string, string>();
  for (const f of arr(root['folders'])) {
    const o = obj(f) ?? {};
    const id = str(o['id']);
    const name = str(o['name']);
    if (id !== null && name !== null) folderName.set(id, name);
  }

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];
  const list = arr(root['items']);

  for (let i = 0; i < list.length; i++) {
    const o = obj(list[i]);
    const rowNumber = i + 1;
    if (o === null) {
      skipped.push({ rowNumber, reason: '这一项不是一个对象' });
      continue;
    }

    const name = str(o['name']);
    if (name === null) {
      skipped.push({ rowNumber, reason: '没有名称' });
      continue;
    }

    const type = bitwardenType(o['type']);
    const loginRaw = obj(o['login']);
    const uris: ImportedUri[] = arr(loginRaw?.['uris']).map((u) => {
      const uo = obj(u) ?? {};
      return { uri: str(uo['uri']) ?? '', match: typeof uo['match'] === 'number' ? uo['match'] : null };
    }).filter((u) => u.uri.length > 0);

    items.push({
      name,
      type,
      folderName: folderName.get(str(o['folderId']) ?? '') ?? null,
      favorite: o['favorite'] === true,
      notes: str(o['notes']),
      login: type === 'login' && loginRaw !== null
        ? {
          username: str(loginRaw['username']),
          password: str(loginRaw['password']),
          totp: str(loginRaw['totp']),
          uri: uris[0]?.uri ?? null,
          uris,
        }
        : null,
      card: type === 'card' ? cardOf(o['card']) : null,
      identity: type === 'identity' ? identityOf(o['identity']) : null,
      customFields: fieldsOf(o['fields']),
      rowNumber,
    });
  }

  return { items, skipped };
}

/** 1PIF 的 `typeName` → 我们的类型 */
function pifType(name: string | null): ImportedType {
  switch (name) {
    case 'Logins': return 'login';
    case 'Credit Cards': return 'card';
    case 'Identities': return 'identity';
    case 'Secure Notes': return 'secureNote';
    // 认不出的（Software Licenses / Passwords / …）当笔记 —— 内容留住，用户能自己归类
    default: return 'secureNote';
  }
}

/** `09/2028` 或 `9/28` → 月与年。拆不开就原样留在月份里，不猜 */
function splitExpiry(raw: string | null): { month: string | null; year: string | null } {
  if (raw === null) return { month: null, year: null };
  const m = /^(\d{1,2})\s*[/-]\s*(\d{2,4})$/.exec(raw.trim());
  if (m === null) return { month: raw, year: null };
  const year = m[2]!.length === 2 ? `20${m[2]!}` : m[2]!;
  return { month: String(Number(m[1])), year };
}

/**
 * 1PIF —— 1Password 的旧版交换格式（8 之前）。
 *
 * 记录之间用 `***<uuid>***` 这样的整行分隔，每条记录是一段 JSON。
 * 字段名与 1PUX 完全不同（`typeName` / `secureContents` / `designation`），
 * 所以两者不能共用解析。
 */
export function parse1Pif(text: string): ImportResult {
  const lines = text.split(/\r?\n/);

  /** 切出每一条记录：分隔行之间的那些行 */
  const records: { rowNumber: number; body: string }[] = [];

  /**
   * ⚠️ 从第 1 行就开始收，而不是等第一个分隔行。
   *
   * 第一个分隔行**之前**的内容同样是一条记录 —— 丢掉它意味着：如果文件开头
   * 有损坏的一段，用户会看到「导入成功」而那一整段凭空消失，报告里一个字都没有。
   * 正常文件的开头是空的（分隔行在最前），会被下面的空内容检查跳过。
   */
  let current: { start: number; lines: string[] } = { start: 1, lines: [] };
  let sawSeparator = false;

  lines.forEach((line, i) => {
    if (PIF_SEPARATOR.test(line.trim())) {
      sawSeparator = true;
      records.push({ rowNumber: current.start, body: current.lines.join('\n') });
      current = { start: i + 2, lines: [] };   // 记录从分隔行的下一行开始（1-based 行号）
      return;
    }
    current.lines.push(line);
  });
  records.push({ rowNumber: current.start, body: current.lines.join('\n') });

  /*
   * 一行分隔符都没有 → 这不是 1PIF。
   *
   * ⚠️ 这个判断要**先于**逐条解析：否则整份文件会被当成「一条坏记录」，
   * 用户看到的理由变成「这一条不是合法的 JSON」—— 听起来像是文件里有一条坏的，
   * 而其实是选错了格式。理由指错方向比没有理由更糟。
   */
  if (!sawSeparator) {
    return {
      items: [],
      skipped: [{ rowNumber: 1, reason: '这不像一个 1PIF 文件（找不到记录分隔行）' }],
    };
  }

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  for (const rec of records) {
    const body = rec.body.trim();
    if (body.length === 0) continue;

    let raw: Record<string, unknown>;
    try {
      const parsed = obj(JSON.parse(body) as unknown);
      if (parsed === null) throw new Error('not an object');
      raw = parsed;
    } catch {
      // ⚠️ 单条坏记录不该让整份文件失败 —— 用户手里只有这一份导出
      skipped.push({ rowNumber: rec.rowNumber, reason: '这一条不是合法的 JSON，已跳过' });
      continue;
    }

    const sc = obj(raw['secureContents']) ?? {};
    const name = str(sc['title']);
    if (name === null) {
      skipped.push({ rowNumber: rec.rowNumber, reason: '没有名称' });
      continue;
    }

    const type = pifType(str(raw['typeName']));
    const uris: ImportedUri[] = arr(sc['URLs']).map((u) => {
      const uo = obj(u) ?? {};
      return { uri: str(uo['url']) ?? '', match: null };
    }).filter((u) => u.uri.length > 0);

    /*
     * ⚠️ 字段**按 `designation` 认，不按位置**。
     *
     * 真实文件里 `fields` 的顺序并不固定（用户改过、版本差异、导入来源不同），
     * 按位置读会把用户名和密码对调 —— 而那是一次静默的、灾难性的错位：
     * 两条都「有值」，用户要等到某次登录失败才会发现。
     */
    const byDesignation = new Map<string, string>();
    for (const f of arr(sc['fields'])) {
      const o = obj(f) ?? {};
      const d = str(o['designation']);
      const v = str(o['value']);
      if (d !== null && v !== null && !byDesignation.has(d)) byDesignation.set(d, v);
    }

    const expiry = splitExpiry(str(sc['expiry']));

    items.push({
      name,
      type,
      folderName: str(sc['folder']) ?? null,
      favorite: sc['favorite'] === 1 || sc['favorite'] === true,
      notes: str(sc['notesPlain']),
      login: type === 'login'
        ? {
          username: byDesignation.get('username') ?? null,
          password: byDesignation.get('password') ?? null,
          totp: byDesignation.get('totp') ?? null,
          uri: uris[0]?.uri ?? null,
          uris,
        }
        : null,
      card: type === 'card'
        ? {
          cardholderName: str(sc['cardholder']),
          brand: str(sc['type']),
          number: str(sc['number']),
          expMonth: expiry.month,
          expYear: expiry.year,
          code: str(sc['verificationNumber']),
        }
        : null,
      identity: null,
      customFields: fieldsOf(
        arr(sc['fields']).filter((f) => {
          const d = str((obj(f) ?? {})['designation']);
          return d === null;   // 有 designation 的已经归到 login 里了
        }),
      ),
      rowNumber: rec.rowNumber,
    });
  }

  return { items, skipped };
}
