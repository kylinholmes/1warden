/**
 * 导入的统一入口 —— 认格式、分发到对应的解析器。
 *
 * ## 为什么入口收**字节**而不是字符串
 *
 * 1PUX 是 ZIP，二进制。用 `TextDecoder` 把它读成字符串再传进来，
 * 字节就已经毁了 —— 而且毁得**看不出来**：字符串非空、解析器报的
 * 是一句「这不是 ZIP」，用户以为文件坏了。
 *
 * 所以这条边界按字节划。文本类格式在里面自己解码。
 *
 * ## 识别是提示，不是判据
 *
 * 1Password 与 Chrome 的 CSV 都是 `...,url,username,password,...`，
 * 光看列名分不开。所以界面上永远让用户能自己选，而**猜错不能让导入失败** ——
 * 选了具体格式就按那个格式解析，解析不出东西时给一句能看懂的话。
 */
import { parseBitwardenCsv } from './import';
import { parseGenericCsv, detectCsvFormat } from './import-csv';
import { parseBitwardenJson, parse1Pif, detectJsonFormat } from './import-json';
import { parse1Pux, looksLike1Pux } from './import-1pux';
import { parseKeePassXml, looksLikeKeePassXml } from './import-keepass';
import type { ImportResult } from './import';

export type ImportFormatId =
  | 'auto'
  | '1pux'
  | '1pif'
  | 'bitwarden-json'
  | 'bitwarden-csv'
  | 'keepass2'
  | 'csv';

export interface ImportFormat {
  id: ImportFormatId;
  label: string;
  /** 需要按**字节**读文件。界面据此决定用 `arrayBuffer()` 还是 `text()` */
  binary?: boolean;
}

/**
 * 界面上给用户挑的格式清单。
 *
 * ⚠️ 顺序有意义：把**用户最可能手里的**放前面。Bitwarden 用户手里是 JSON 或 CSV，
 * 1Password 用户手里是 .1pux —— 而「其它 CSV」是兜底，放最后。
 */
export const IMPORT_FORMATS: readonly ImportFormat[] = [
  { id: 'auto', label: '自动识别' },
  { id: '1pux', label: '1Password 导出（.1pux）', binary: true },
  { id: '1pif', label: '1Password 旧版导出（.1pif）' },
  { id: 'bitwarden-json', label: 'Bitwarden JSON（未加密）' },
  { id: 'bitwarden-csv', label: 'Bitwarden CSV' },
  { id: 'keepass2', label: 'KeePass 2 XML' },
  { id: 'csv', label: '其它 CSV（Chrome / Edge / LastPass / Excel …）' },
];

const EMPTY: ImportResult = { items: [], skipped: [] };

function utf8(data: Uint8Array): string {
  // ⚠️ 不传 `ignoreBOM` —— 默认就会剥掉 BOM，而那正是我们要的：
  // Excel 导出的 CSV 带 BOM，留着的话第一个列名前面多一个不可见字符，
  // 「按列名找字段」永远找不到，而文件在编辑器里看起来完全正常
  return new TextDecoder().decode(data);
}

/** 只看开头这段就够判断了 —— 没必要为了识别把几十兆的文件整个解码一遍 */
const SNIFF_BYTES = 4096;

/**
 * 猜这是什么格式。认不出返回 null。
 *
 * 同步的（只有 1PUX 需要异步，而它靠 ZIP 魔数就能认出来）。
 */
export function detectImportFormat(data: Uint8Array): ImportFormatId | null {
  if (data.byteLength === 0) return null;

  // ZIP 魔数优先 —— 二进制格式先排掉，免得被后面的文本判断误伤
  if (looksLike1Pux(data)) return '1pux';

  const head = utf8(data.subarray(0, Math.min(SNIFF_BYTES, data.byteLength)));

  // XML 要先判 —— 它既不是 JSON 也不是 CSV，落到后面只会得到「认不出」
  if (looksLikeKeePassXml(head)) return 'keepass2';

  const json = detectJsonFormat(head);
  if (json?.id === 'bitwarden') return 'bitwarden-json';
  if (json?.id === '1pif') return '1pif';

  const csv = detectCsvFormat(head);
  if (csv === null) return null;
  return csv.id === 'bitwarden' ? 'bitwarden-csv' : 'csv';
}

/**
 * 解析一份导入文件。
 *
 * `format` 不传或传 `'auto'` 时自动识别。
 */
export async function parseImport(data: Uint8Array, format?: ImportFormatId): Promise<ImportResult> {
  if (data.byteLength === 0) {
    return { items: [], skipped: [{ rowNumber: 1, reason: '这个文件是空的' }] };
  }

  const chosen = format === undefined || format === 'auto' ? detectImportFormat(data) : format;

  if (chosen === null) {
    return {
      items: [],
      skipped: [{
        rowNumber: 1,
        reason: '认不出这个文件的格式 —— 支持的格式在界面上可以手动选，选错了也会有具体提示',
      }],
    };
  }

  switch (chosen) {
    case '1pux':
      return await parse1Pux(data);
    case '1pif':
      return parse1Pif(utf8(data));
    case 'bitwarden-json':
      return parseBitwardenJson(utf8(data));
    case 'bitwarden-csv':
      return parseBitwardenCsv(utf8(data));
    case 'keepass2':
      return parseKeePassXml(utf8(data));
    case 'csv':
      return parseGenericCsv(utf8(data));
    default:
      return EMPTY;
  }
}

export { EMPTY as EMPTY_IMPORT };
