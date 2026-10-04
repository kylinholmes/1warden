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
import { parseGenericCsv } from './import-csv';

export type ImportedType = 'login' | 'secureNote' | 'card' | 'identity' | 'sshKey';

export interface ImportedField {
  name: string;
  value: string;
  /** 0=文本 1=隐藏 —— 与 Bitwarden 的字段类型一致 */
  type: 0 | 1;
}

/** 一条网址及其匹配方式。`match` 的含义见 model.ts 的 `LoginUri` */
export interface ImportedUri {
  uri: string;
  match: number | null;
}

export interface ImportedLogin {
  username: string | null;
  password: string | null;
  totp: string | null;
  /** 主网址。CSV 这类只有一列的格式用它 */
  uri: string | null;
  /**
   * 完整网址列表 —— Bitwarden 的 JSON 与 1Password 的导出都能挂多个，
   * 而且每个各带自己的匹配方式。有它时以它为准。
   */
  uris?: ImportedUri[];
}

export interface ImportedCard {
  cardholderName: string | null;
  brand: string | null;
  number: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
}

/**
 * SSH 密钥。三个字段都是**明文**（这是「已经解出来的导入数据」，
 * 加密是落库那一步的事）。
 */
export interface ImportedSshKey {
  privateKey: string | null;
  publicKey: string | null;
  fingerprint: string | null;
}

export interface ImportedIdentity {
  title: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  ssn: string | null;
  username: string | null;
  passportNumber: string | null;
  licenseNumber: string | null;
}

export interface ImportedItem {
  name: string;
  type: ImportedType;
  folderName: string | null;
  favorite: boolean;
  notes: string | null;
  login: ImportedLogin | null;
  /**
   * 卡片与身份。
   *
   * ⚠️ CSV 只有登录那几列，所以这两项在 CSV 路径上一直是空的 ——
   * 但 **Bitwarden 的 JSON 和 1Password 的导出里它们是完整存在的**。
   * 丢掉的话，用户导入之后会发现所有的卡都不见了，而导入报告说「全部成功」。
   */
  card?: ImportedCard | null;
  identity?: ImportedIdentity | null;
  sshKey?: ImportedSshKey | null;
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

/**
 * 解析 Bitwarden 格式的 CSV。
 *
 * ⚠️ **只是通用引擎的一个入口**，不再是独立实现。
 *
 * 早先这里是一份专门写 Bitwarden 列名的解析器，而通用引擎（`import-csv.ts`）
 * 是另一份 —— 同一件事有两个实现，改了一处忘了另一处，两边行为就会漂移。
 * 这一整轮里已经因为「同一个事实有两个来源」栽过好几次，就不在这里再添一个。
 *
 * Bitwarden 的列名（`login_uri` / `login_username` / `fields` …）都在通用引擎的
 * 同义词表里，所以委托过去的结果与原先一致。
 */
export function parseBitwardenCsv(text: string): ImportResult {
  return parseGenericCsv(text);
}
