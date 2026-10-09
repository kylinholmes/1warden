/**
 * 领域模型 —— **已解密**的形状。
 *
 * 与 `@1warden/api` 的 DTO 严格分开：
 *   DTO       = 线上形状，敏感字段都是不透明字符串（EncString）
 *   VaultItem = 解密后的形状，字段是明文
 *
 * ⚠️ VaultItem 是**明文**，完整记录只允许存在于内存中（spec 不变量 S1）。
 * 用户授权的 Profile 展示缓存由应用层单独提取并校验头像/名称，不持久化记录或备注。
 * 这个包不得导入 fs / localStorage / indexedDB / 任何持久化 API —— 有一条 grep 检查把关。
 */

// 只借类型。passkey.ts 反过来不依赖本文件，不构成循环。
import type { StoredPasskey } from './passkey';
import type { CipherDto } from '@1warden/api';

export const ITEM_TYPES = ['login', 'secureNote', 'card', 'identity', 'sshKey', 'bankAccount', 'driversLicense', 'passport', 'unknown'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface LoginUri {
  /** Opaque row identity; contains no server data. */
  sourceId?: string;
  uri: string;
  /** 0=Domain 1=Host 2=StartsWith 3=Exact 4=Regex 5=Never；null = 用默认 */
  match: number | null;
}

export interface LoginFields {
  autofillOnPageLoad?: boolean | null;
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

/**
 * SSH 密钥（Bitwarden 的 type 5）。
 *
 * ⚠️ 三个字段**都是密文**，包括 `fingerprint` —— 指纹是从公钥算出来的，
 * 但它本身也泄露「用户有哪些密钥」，所以服务端一样加密。
 */
export interface SshKeyFields {
  privateKey: string | null;
  publicKey: string | null;
  fingerprint: string | null;
}

/** Native Bitwarden type 6. All fields are encrypted on the wire. */
export interface BankAccountFields {
  bankName: string | null;
  nameOnAccount: string | null;
  accountType: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  branchNumber: string | null;
  pin: string | null;
  swiftCode: string | null;
  iban: string | null;
  bankContactPhone: string | null;
}

/** Native Bitwarden type 7. Dates remain strings, including legacy formats. */
export interface DriversLicenseFields {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  licenseNumber: string | null;
  issuingCountry: string | null;
  issuingState: string | null;
  issueDate: string | null;
  expirationDate: string | null;
  issuingAuthority: string | null;
  licenseClass: string | null;
}

/** Native Bitwarden type 8. No extension fields or custom type IDs. */
export interface PassportFields {
  surname: string | null;
  givenName: string | null;
  dateOfBirth: string | null;
  sex: string | null;
  birthPlace: string | null;
  nationality: string | null;
  issuingCountry: string | null;
  passportNumber: string | null;
  passportType: string | null;
  nationalIdentificationNumber: string | null;
  issuingAuthority: string | null;
  issueDate: string | null;
  expirationDate: string | null;
}

export interface SecureNoteFields {
  type: number;
}

export interface CustomField {
  sourceId?: string;
  /** Unsupported native type: preserve unchanged or explicitly delete. */
  unsupportedType?: number;
  name: string;
  value: string;
  /** 0=Text 1=Hidden 2=Boolean 3=Linked */
  type: 0 | 1 | 2 | 3;
  /** 数字 ID（100–418），**不是** "login.username" 这种字符串 */
  linkedId: number | null;
}

export interface PasswordHistoryEntry {
  sourceId?: string;
  lastUsedDate: string;
  password: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  /** ⚠️ 是字符串，不是数字 */
  size: string;
  /** 人可读的大小（"1.43 KB"）。服务端已经算好了，界面别再格式化一遍 */
  sizeName: string;
  url: string;
  /** 附件的独立 64 字节密钥（仍是密文）。用它解密附件内容 */
  key: string | null;
  failed: boolean;
}

/** Owner-only state. Never expose this object to a UI/detail/draft projection. */
export interface ItemPreservation {
  source: CipherDto;
  baseline: Omit<VaultItem, 'preservation'>;
  failures: string[];
}

export interface VaultItem {
  preservation?: ItemPreservation;
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
  /**
   * 该条目**包装后的**独立密钥（EncString）；null = 用用户密钥。
   *
   * ⚠️ 这里存的是**密文本身**，不是一个「有没有」的布尔标记。
   *
   * 早先只有一个 `hasItemKey: boolean`，于是保存时拿不到那把密钥 ——
   * `saveItem` 只能用用户密钥重新加密，而服务端的 `key` 字段还声明着
   * 「这条用独立密钥」：任何客户端按声明去解都会失败，**条目就废了**。
   * 而且保存和同步都「成功」，用户下次打开才发现里面是空的。
   *
   * 取附件时的密钥解包也卡在同一个地方。
   */
  wrappedKey: string | null;

  login: LoginFields | null;
  card: CardFields | null;
  identity: IdentityFields | null;
  secureNote: SecureNoteFields | null;
  sshKey: SshKeyFields | null;
  bankAccount?: BankAccountFields | null;
  driversLicense?: DriversLicenseFields | null;
  passport?: PassportFields | null;

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
 * Vaultwarden 1.37.4 supports types 1–8. Future unmodeled types remain read-only;
 * never reinterpret them as a different type during a save.
 */
export function cipherTypeToItemType(raw: number): ItemType {
  switch (raw) {
    case 1: return 'login';
    case 2: return 'secureNote';
    case 3: return 'card';
    case 4: return 'identity';
    case 5: return 'sshKey';
    case 6: return 'bankAccount';
    case 7: return 'driversLicense';
    case 8: return 'passport';
    default: return 'unknown';
  }
}

/** 每次都返回全新对象 —— 共享可变状态会让两条条目互相污染 */
export function emptyLogin(): LoginFields {
  return { username: null, password: null, totp: null, uris: [], passwordRevisionDate: null, fido2Credentials: [] };
}

/** 每次都返回全新对象 —— 共享可变状态会让两条条目互相污染 */
export function emptySshKey(): SshKeyFields {
  return { privateKey: null, publicKey: null, fingerprint: null };
}

export function emptyBankAccount(): BankAccountFields {
  return {
    bankName: null, nameOnAccount: null, accountType: null, accountNumber: null,
    routingNumber: null, branchNumber: null, pin: null, swiftCode: null, iban: null,
    bankContactPhone: null,
  };
}

export function emptyDriversLicense(): DriversLicenseFields {
  return {
    firstName: null, middleName: null, lastName: null, dateOfBirth: null,
    licenseNumber: null, issuingCountry: null, issuingState: null, issueDate: null,
    expirationDate: null, issuingAuthority: null, licenseClass: null,
  };
}

export function emptyPassport(): PassportFields {
  return {
    surname: null, givenName: null, dateOfBirth: null, sex: null, birthPlace: null,
    nationality: null, issuingCountry: null, passportNumber: null, passportType: null,
    nationalIdentificationNumber: null, issuingAuthority: null, issueDate: null,
    expirationDate: null,
  };
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
