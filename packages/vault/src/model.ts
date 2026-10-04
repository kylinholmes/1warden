/**
 * 领域模型 —— **已解密**的形状。
 *
 * 与 `@coffer/api` 的 DTO 严格分开：
 *   DTO       = 线上形状，敏感字段都是不透明字符串（EncString）
 *   VaultItem = 解密后的形状，字段是明文
 *
 * ⚠️ 本文件里的任何值都是**明文**，只允许存在于内存中（spec 不变量 S1）。
 * 这个包不得导入 fs / localStorage / indexedDB / 任何持久化 API —— 有一条 grep 检查把关。
 */

// 只借类型。passkey.ts 反过来不依赖本文件，不构成循环。
import type { StoredPasskey } from './passkey';

export const ITEM_TYPES = ['login', 'secureNote', 'card', 'identity', 'sshKey', 'unknown'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface LoginUri {
  uri: string;
  /** 0=Domain 1=Host 2=StartsWith 3=Exact 4=Regex 5=Never；null = 用默认 */
  match: number | null;
}

export interface LoginFields {
  username: string | null;
  password: string | null;
  /** otpauth:// URI、steam:// URI 或裸 base32 */
  totp: string | null;
  uris: LoginUri[];
  passwordRevisionDate: string | null;
  /** 该条目上的 passkey。与 1Password 一样**不单独成条目类型**，就挂在登录条目上。 */
  fido2Credentials: StoredPasskey[];
}

export interface CardFields {
  cardholderName: string | null;
  /** ⚠️ 是**字符串**（"Visa" / "Amex" / "Diners Club" / …），不是数字枚举 */
  brand: string | null;
  number: string | null;
  expMonth: string | null;
  expYear: string | null;
  code: string | null;
}

export interface IdentityFields {
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
  /** ⚠️ 全小写 —— 服务端对 SSN 有特殊的大小写归一化 */
  ssn: string | null;
  username: string | null;
  passportNumber: string | null;
  licenseNumber: string | null;
}

export interface SecureNoteFields {
  type: number;
}

export interface CustomField {
  name: string;
  value: string;
  /** 0=Text 1=Hidden 2=Boolean 3=Linked */
  type: 0 | 1 | 2 | 3;
  /** 数字 ID（100–418），**不是** "login.username" 这种字符串 */
  linkedId: number | null;
}

export interface PasswordHistoryEntry {
  lastUsedDate: string;
  password: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  /** ⚠️ 是字符串，不是数字 */
  size: string;
  url: string;
  /** 附件的独立 64 字节密钥（仍是密文）。用它解密附件内容 */
  key: string | null;
  failed: boolean;
}

export interface VaultItem {
  id: string;
  type: ItemType;
  /** 原始数字类型 —— 未知类型时 UI 需要它来提示用户 */
  rawType: number;
  name: string;
  /** 名解密失败 —— 列表里显示「无法解密」而不是一片空白 */
  nameFailed: boolean;
  notes: string | null;
  notesFailed: boolean;
  folderId: string | null;
  favorite: boolean;
  /** 0=None 1=PasswordOnView（查看前需要再次验证主密码） */
  reprompt: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  /** 该条目是否带独立密钥（存在时**所有**字段都用它解密） */
  hasItemKey: boolean;

  login: LoginFields | null;
  card: CardFields | null;
  identity: IdentityFields | null;
  secureNote: SecureNoteFields | null;

  customFields: CustomField[];
  passwordHistory: PasswordHistoryEntry[];
  attachments: Attachment[];
}

export interface VaultFolder {
  id: string;
  name: string;
  nameFailed: boolean;
  updatedAt: string;
}

/**
 * 数字的 CipherType → 领域类型。
 *
 * ⚠️ 6/7/8（BankAccount / DriversLicense / Passport）是 2026 年新增的，
 * **老服务端不认识**。按接口稳定性原则当作「未知类型」—— 只读展示，不提供编辑，
 * 因为编辑会把它们降级成别的类型，等于破坏数据。
 */
export function cipherTypeToItemType(raw: number): ItemType {
  switch (raw) {
    case 1: return 'login';
    case 2: return 'secureNote';
    case 3: return 'card';
    case 4: return 'identity';
    case 5: return 'sshKey';
    default: return 'unknown';
  }
}

/** 每次都返回全新对象 —— 共享可变状态会让两条条目互相污染 */
export function emptyLogin(): LoginFields {
  return { username: null, password: null, totp: null, uris: [], passwordRevisionDate: null, fido2Credentials: [] };
}

export function emptyCard(): CardFields {
  return { cardholderName: null, brand: null, number: null, expMonth: null, expYear: null, code: null };
}

export function emptyIdentity(): IdentityFields {
  return {
    title: null, firstName: null, middleName: null, lastName: null,
    address1: null, address2: null, address3: null, city: null, state: null,
    postalCode: null, country: null, company: null, email: null, phone: null,
    ssn: null, username: null, passportNumber: null, licenseNumber: null,
  };
}
