/**
 * 1PUX —— 1Password 现在的导出格式（8 及以后）。
 *
 * 它是一个 ZIP，里面 `export.data` 是一份 JSON：`accounts → vaults → items`。
 *
 * ## 为什么这个必须做好
 *
 * 1PUX 是 1Password 用户**唯一无损**的迁移路径。CSV 与 1PIF 都会丢东西
 * （卡片有效期、身份地址、网址匹配方式、自定义字段的隐藏标记），
 * 而 1PUX 是完整结构。
 *
 * 用户走到这一步通常已经决定要换了 —— 这时候让他发现「银行卡全没了」，
 * 他不会去查文档，他会直接卸载。
 *
 * ## 与 1PIF 的区别
 *
 * 字段名完全不同：1PUX 用 `categoryUuid` / `overview` / `details.loginFields`，
 * 1PIF 用 `typeName` / `secureContents.fields[].designation`。
 * 两者不能共用解析 —— 硬凑一个「通用」解析器只会两边都做不对。
 */
import { readZip } from './zip';
import type {
  ImportedCard, ImportedField, ImportedIdentity, ImportedItem, ImportedType,
  ImportResult, ImportedUri,
} from './import';

/** ZIP 的本地文件头签名 —— 用来在解压之前先看出「这是不是个 ZIP」 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * 1PUX 的分类 UUID → 我们的类型。
 *
 * ⚠️ **认不出的不是丢掉，是当笔记留下**（见 `parse1Pux` 里的兜底）。
 * 1Password 有几十个分类（银行账户、驾照、护照、软件许可、医疗记录…），
 * 我们的模型只有四种。丢掉等于用户的那些记录凭空消失。
 */
const CATEGORY: Record<string, ImportedType> = {
  '001': 'login',
  '002': 'card',
  '003': 'secureNote',
  '004': 'identity',
  '005': 'login',      // Password：没有用户名但有密码，最接近登录
  '006': 'secureNote', // Document
};

/** 这些字段 id 是 1Password 的固定语义，不是用户自定义的 */
const CARD_FIELDS: Record<string, keyof ImportedCard> = {
  cardholder: 'cardholderName',
  type: 'brand',
  number: 'number',
  expiry: 'expMonth',       // 下面拆成月/年
  verificationNumber: 'code',
};

const IDENTITY_FIELDS: Record<string, keyof ImportedIdentity> = {
  title: 'title', firstname: 'firstName', initial: 'middleName', lastname: 'lastName',
  address: 'address1', address2: 'address2', city: 'city', state: 'state',
  zip: 'postalCode', country: 'country', company: 'company',
  email: 'email', phone: 'phone', ssn: 'ssn', username: 'username',
  passportnumber: 'passportNumber', licensenumber: 'licenseNumber',
};

export function looksLike1Pux(data: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => data[i] === b);
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

/** 1PUX 的有效期是 `202809` 这种紧凑写法 */
function splitExpiry(raw: string | null): { month: string | null; year: string | null } {
  if (raw === null) return { month: null, year: null };
  const compact = /^(\d{4})(\d{2})$/.exec(raw.trim());
  if (compact !== null) return { month: String(Number(compact[2])), year: compact[1]! };
  const slashed = /^(\d{4})\s*[/-]\s*(\d{1,2})$/.exec(raw.trim());
  if (slashed !== null) return { month: String(Number(slashed[2])), year: slashed[1]! };
  // 拆不开就原样留在月份里，不猜 —— 猜错的年份比没有年份更糟
  return { month: raw, year: null };
}

interface SectionField { id: string | null; title: string | null; value: string; fieldType: string | null }

function sectionFields(details: Record<string, unknown>): SectionField[] {
  const out: SectionField[] = [];
  for (const s of arr(details['sections'])) {
    for (const f of arr((obj(s) ?? {})['fields'])) {
      const o = obj(f) ?? {};
      const value = typeof o['value'] === 'string' ? o['value'] : null;
      if (value === null || value.trim().length === 0) continue;
      out.push({
        id: str(o['id']),
        title: str(o['title']),
        value,
        fieldType: str(o['fieldType']),
      });
    }
  }
  return out;
}

/** 1PUX 的 `fieldType`：P = 隐藏字段，其余按文本 */
function fieldKind(t: string | null): 0 | 1 {
  return t === 'P' ? 1 : 0;
}

export async function parse1Pux(data: Uint8Array): Promise<ImportResult> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(data);
  } catch (e) {
    return {
      items: [],
      skipped: [{ rowNumber: 1, reason: `读不了这个文件：${e instanceof Error ? e.message : '不是有效的 ZIP'}` }],
    };
  }

  const raw = files.get('export.data');
  if (raw === undefined) {
    return {
      items: [],
      skipped: [{ rowNumber: 1, reason: '这个 ZIP 里没有 export.data —— 确认一下这是不是 1Password 导出的 .1pux 文件' }],
    };
  }

  let root: Record<string, unknown>;
  try {
    const parsed = obj(JSON.parse(new TextDecoder().decode(raw)) as unknown);
    if (parsed === null) throw new Error('not an object');
    root = parsed;
  } catch {
    return { items: [], skipped: [{ rowNumber: 1, reason: 'export.data 不是合法的 JSON（文件可能损坏了）' }] };
  }

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  for (const account of arr(root['accounts'])) {
    for (const vault of arr((obj(account) ?? {})['vaults'])) {
      const vaultObj = obj(vault) ?? {};
      const folderName = str((obj(vaultObj['attrs']) ?? {})['name']);

      for (const raw of arr(vaultObj['items'])) {
        const item = obj(raw);
        const rowNumber = items.length + skipped.length + 1;
        if (item === null) {
          skipped.push({ rowNumber, reason: '这一项不是一个对象' });
          continue;
        }

        const overview = obj(item['overview']) ?? {};
        const title = str(overview['title']);
        if (title === null) {
          skipped.push({ rowNumber, reason: '没有名称' });
          continue;
        }

        const details = obj(item['details']) ?? {};
        const category = str(item['categoryUuid']) ?? '';
        const type = CATEGORY[category] ?? 'secureNote';

        const uris: ImportedUri[] = arr(overview['urls']).map((u) => {
          const uo = obj(u) ?? {};
          return { uri: str(uo['url']) ?? '', match: null };
        }).filter((u) => u.uri.length > 0);

        /*
         * ⚠️ 登录字段按 `designation` 认，不按位置。
         *
         * 真实文件里 `loginFields` 的顺序不保证（1Password 自己也可能换序）。
         * 按位置读会把用户名和密码**对调** —— 两条都「有值」，导入报告一切正常，
         * 用户要等到某次登录失败才会发现。
         */
        const byDesignation = new Map<string, string>();
        for (const f of arr(details['loginFields'])) {
          const o = obj(f) ?? {};
          const d = str(o['designation']);
          const v = str(o['value']);
          if (d !== null && v !== null && !byDesignation.has(d)) byDesignation.set(d, v);
        }

        const sections = sectionFields(details);
        const notesPlain = str(details['notesPlain']);

        let card: ImportedCard | null = null;
        let identity: ImportedIdentity | null = null;
        let customFields: ImportedField[] = [];

        if (type === 'card') {
          const byId = new Map(sections.filter((f) => f.id !== null).map((f) => [f.id!, f]));
          const expiry = splitExpiry(byId.get('expiry')?.value ?? null);
          card = {
            cardholderName: byId.get('cardholder')?.value ?? null,
            brand: byId.get('type')?.value ?? null,
            number: byId.get('number')?.value ?? null,
            expMonth: expiry.month,
            expYear: expiry.year,
            code: byId.get('verificationNumber')?.value ?? null,
          };
          // 卡片上用户自己加的字段仍然要留住
          customFields = sections
            .filter((f) => f.id === null || !(f.id in CARD_FIELDS))
            .map((f) => ({ name: f.title ?? f.id ?? '', value: f.value, type: fieldKind(f.fieldType) }));
        } else if (type === 'identity') {
          identity = {
            title: null, firstName: null, middleName: null, lastName: null,
            address1: null, address2: null, address3: null, city: null, state: null,
            postalCode: null, country: null, company: null, email: null, phone: null,
            ssn: null, username: null, passportNumber: null, licenseNumber: null,
          };
          for (const f of sections) {
            const key = f.id === null ? undefined : IDENTITY_FIELDS[f.id.toLowerCase()];
            if (key !== undefined) identity[key] = f.value;
          }
          customFields = sections
            .filter((f) => f.id === null || !(f.id.toLowerCase() in IDENTITY_FIELDS))
            .map((f) => ({ name: f.title ?? f.id ?? '', value: f.value, type: fieldKind(f.fieldType) }));
        } else {
          customFields = sections.map((f) => ({
            name: f.title ?? f.id ?? '', value: f.value, type: fieldKind(f.fieldType),
          }));
        }

        /*
         * ⚠️ **认不出的分类，兜底把内容挪进备注。**
         *
         * 1Password 有几十个分类，我们只有四种。银行账户、驾照、护照这些
         * 落进 `secureNote` 时，如果只留一个标题，用户的记录就等于没了。
         * 宁可把字段塞进备注（不好看），也不能让内容消失。
         */
        const unmapped = !(category in CATEGORY) && type === 'secureNote' && notesPlain === null;
        const notes = unmapped && sections.length > 0
          ? sections.map((f) => `${f.title ?? f.id ?? ''}: ${f.value}`).join('\n')
          : notesPlain;

        // 标签是 1Password 里独立于保险库的一层，丢掉可惜 —— 塞进自定义字段留住
        const tags = arr(overview['tags']).map((t) => str(t)).filter((t): t is string => t !== null);

        items.push({
          name: title,
          type,
          folderName,
          favorite: typeof item['favIndex'] === 'number' && item['favIndex'] > 0,
          notes,
          login: type === 'login'
            ? {
              username: byDesignation.get('username') ?? null,
              password: byDesignation.get('password') ?? str(details['password']),
              totp: byDesignation.get('totp') ?? null,
              uri: uris[0]?.uri ?? null,
              uris,
            }
            : null,
          card,
          identity,
          customFields: tags.length === 0
            ? customFields
            : [...customFields, { name: '标签', value: tags.join(', '), type: 0 }],
          rowNumber,
        });
      }
    }
  }

  return { items, skipped };
}
