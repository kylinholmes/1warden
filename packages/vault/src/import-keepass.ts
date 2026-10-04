/**
 * KeePass 2 XML 导入。
 *
 * ⚠️ 这是**一次性**操作，所以留在 TS 里 —— 不满足「调用频繁」那条判据
 * （见 `scripts/bench-hot-paths.ts` 顶部的说明）。
 *
 * ## 两个容易搞错的地方
 *
 * 1. **被保护的字段值是 base64，不是加密的。** `Protected="True"` 只表示
 *    「KeePass 界面上把它显示成圆点」—— .kdbx 才加密，导出的 XML 是明文。
 *    不解码的话用户的密码会变成一串 base64 乱码。
 * 2. **分组是嵌套的，文件夹要用最内层那层名字。** 用最外层的话，
 *    「工作 / 客户 A / 服务器」全都挤进「工作」一个文件夹里。
 */
import { fromBase64 } from '@coffer/crypto';
import { parseXml, xmlChildren, xmlText, type XmlElement } from './xml';
import type { ImportedField, ImportedItem, ImportResult } from './import';

/** KeePass 自己的固定键 —— 其余的都是用户自定义字段 */
const STANDARD_KEYS = new Set([
  'title', 'username', 'password', 'url', 'notes', 'otp',
  // 有些导出用这些写法
  'totp seed', 'totp', 'timeotp',
]);

export function looksLikeKeePassXml(text: string): boolean {
  const head = text.slice(0, 2048);
  return head.includes('<KeePassFile');
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** 被保护的字段：值是 base64，解出来才是明文。解不开就原样留着，不猜 */
function stringValue(el: XmlElement): string {
  const valueEl = xmlChildren(el, 'Value')[0];
  if (valueEl === undefined) return '';
  const raw = valueEl.text;

  if (valueEl.attrs['Protected']?.toLowerCase() === 'true') {
    try {
      return new TextDecoder().decode(fromBase64(raw));
    } catch {
      // 不是合法 base64 —— 原样留着。宁可给用户一串他能自己认出来的东西，
      // 也不要在这里抛错让整条条目丢掉
      return raw;
    }
  }
  return raw;
}

/** 一条 `<Entry>` → 键值对 */
function stringsOf(entry: XmlElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of xmlChildren(entry, 'String')) {
    const key = xmlText(s, 'Key');
    if (key.length === 0) continue;
    // 先出现的赢 —— 同一键重复出现时以第一个为准
    if (!out.has(key)) out.set(key, stringValue(s));
  }
  return out;
}

/** 在键值对里按几个可能的写法找一个键 */
function pick(map: Map<string, string>, ...names: string[]): string | null {
  for (const n of names) {
    for (const [k, v] of map) {
      if (k.toLowerCase() === n) {
        const t = str(v);
        if (t !== null) return t;
      }
    }
  }
  return null;
}

export function parseKeePassXml(text: string): ImportResult {
  if (!looksLikeKeePassXml(text)) {
    return {
      items: [],
      skipped: [{
        rowNumber: 1,
        reason: '这不像是 KeePass 导出的 XML（找不到 <KeePassFile>）—— '
          + '注意 .kdbx 是加密数据库、不是 XML，需要先在 KeePass 里「导出为 XML」',
      }],
    };
  }

  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (e) {
    // ⚠️ 明确报错，而不是返回「0 条」——
    // 那和「文件里真的没有条目」在界面上长得一模一样
    return {
      items: [],
      skipped: [{ rowNumber: 1, reason: `XML 损坏或格式不受支持：${e instanceof Error ? e.message : '解析失败'}` }],
    };
  }

  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  /** 递归走分组。`folder` 是**最内层**那层的名字 */
  const walk = (group: XmlElement, folder: string | null): void => {
    const name = str(xmlText(group, 'Name'));
    const here = name ?? folder;

    for (const entry of xmlChildren(group, 'Entry')) {
      const rowNumber = items.length + skipped.length + 1;
      const map = stringsOf(entry);

      const title = pick(map, 'title');
      const username = pick(map, 'username');
      const password = pick(map, 'password');
      const url = pick(map, 'url');
      const notes = pick(map, 'notes');
      const totp = pick(map, 'otp', 'totp', 'totp seed', 'timeotp');

      // 三者全空才跳过 —— 那行确实什么都给不出来
      const itemName = title ?? username ?? url;
      if (itemName === null) {
        skipped.push({ rowNumber, reason: '没有标题、用户名或网址' });
        continue;
      }

      /*
       * ⚠️ 只有密码、没有用户名和网址的条目**也是有效凭据**。
       * 判成笔记的话自动填充一条都匹配不上，而用户完全不知道发生了什么。
       */
      const hasLogin = username !== null || password !== null || url !== null || totp !== null;

      const customFields: ImportedField[] = [];
      for (const [key, value] of map) {
        if (STANDARD_KEYS.has(key.toLowerCase())) continue;
        customFields.push({ name: key, value, type: 0 });
      }

      items.push({
        name: itemName,
        type: hasLogin ? 'login' : 'secureNote',
        folderName: here,
        favorite: false,   // KeePass 的「收藏」在 XML 里没有稳定的表示
        // 笔记类条目没有登录字段，把内容留在 notes 里
        notes: notes ?? (hasLogin ? null : password),
        login: hasLogin
          ? { username, password, totp, uri: url, uris: url === null ? [] : [{ uri: url, match: null }] }
          : null,
        customFields,
        rowNumber,
      });
    }

    for (const child of xmlChildren(group, 'Group')) walk(child, here);
  };

  for (const rootEl of xmlChildren(root, 'KeePassFile.Root')) {
    for (const group of xmlChildren(rootEl, 'Group')) walk(group, null);
  }

  return { items, skipped };
}
