/**
 * 线上 JSON 的原始形态。
 *
 * ⚠️ **字段名必须是 lowerCamelCase** —— 这是 Vaultwarden 实际发出的形式
 * （`viewPassword`、`organizationUseTotp`、`folderId`），不是 C# / TS 里的属性名。
 *
 * 本包内所有「加密」字段都是**不透明字符串**（EncString）。api 层不解析它们，
 * 也不导入 `@coffer/crypto` —— 这条边界让「协议写错了」和「解密写错了」
 * 成为两种可区分的失败。
 */

export interface CipherLoginUriDto {
  uri: string | null;
  /** ⚠️ 数字枚举：null=默认 0=Domain 1=Host 2=StartsWith 3=Exact 4=Regex 5=Never */
  match: number | null;
  uriChecksum?: string | null;
}

/**
 * 一条 passkey 的**线上**形态。
 *
 * ⚠️ 只有 `keyValue`（PKCS#8 私钥）是 EncString，其余字段都是**明文**。
 * 这是 Bitwarden 客户端的约定 —— 别处的凭据元数据（rpId、用户名）本来也不是秘密，
 * 真正的秘密只有那把私钥。整条一起加密的话，官方客户端读不出来。
 *
 * ⚠️ `counter` 与 `discoverable` 是**字符串**，不是数字与布尔。
 */
export interface CipherFido2CredentialDto {
  credentialId?: string | null;
  keyType?: string | null;
  keyAlgorithm?: string | null;
  keyCurve?: string | null;
  /** EncString，内容是 base64url 的 PKCS#8 私钥 */
  keyValue?: string | null;
  rpId?: string | null;
  rpName?: string | null;
  userHandle?: string | null;
  userName?: string | null;
  userDisplayName?: string | null;
  counter?: string | null;
  discoverable?: string | null;
  creationDate?: string | null;
}

/** SSH 密钥的三个字段，全是 EncString */
export interface CipherSshKeyDto {
  privateKey?: string | null;
  publicKey?: string | null;
  fingerprint?: string | null;
}

export interface CipherLoginDto {
  username?: string | null;
  password?: string | null;
  passwordRevisionDate?: string | null;
  /** EncString，内容是 otpauth:// URI 或裸 base32 */
  totp?: string | null;
  uris?: CipherLoginUriDto[] | null;
  autofillOnPageLoad?: boolean | null;
  /** passkey。Vaultwarden 原样存取，结构上与 1Password 的 passkey 字段一一对应。 */
  fido2Credentials?: CipherFido2CredentialDto[] | null;
  /** 服务端为向后兼容自动补的，等于 uris[0].uri —— 不要依赖它做判断 */
  uri?: string | null;
}

export interface CipherFieldDto {
  name: string | null;
  value: string | null;
  /**
   * 0=Text 1=Hidden 2=Boolean 3=Linked
   * ⚠️ 只发 0–3。Vaultwarden 在 type 缺失或不可解析时回退到 **1（Hidden）**，
   * 那是为了防止意外泄露 —— 但会让本该可见的字段变成隐藏。
   */
  type: number;
  /**
   * ⚠️ 是**数字 ID**（100–418），不是 `"login.username"` 这种字符串。
   * 那个字符串形态只存在于 CSV 导入导出的列名里，不是线上格式。
   */
  linkedId?: number | null;
}

export interface CipherPasswordHistoryDto {
  lastUsedDate: string;
  password: string;
}

export interface CipherAttachmentDto {
  id: string;
  /** 绝对 URL，每次 sync 重新生成，**会过期** */
  url: string;
  fileName: string | null;
  /** ⚠️ 是**字符串**，不是数字 */
  size: string;
  sizeName: string;
  key: string | null;
}

export interface CipherDto {
  id: string;
  /** CipherType，见下方 CIPHER_TYPE。超出 1–8 会让服务端的 to_json 报错 */
  type: number;
  name: string | null;
  notes: string | null;
  folderId: string | null;
  favorite: boolean;
  /** 0=None, 1=PasswordOnView */
  reprompt: number;
  organizationId: string | null;
  /** 每条目独立密钥（EncString）。存在时该条目所有字段都用它解密。 */
  key: string | null;
  creationDate: string;
  revisionDate: string;
  /** 非 null = 在回收站。⚠️ 服务端**不会**因此把它从 sync 里过滤掉 */
  deletedDate: string | null;
  /** 非 null = 已归档。同上，需要客户端自己分区 */
  archivedDate: string | null;
  /** 旧字段。优先读 permissions，回退到这两个 */
  edit?: boolean;
  viewPassword?: boolean;
  permissions?: { delete?: boolean; restore?: boolean };
  login?: CipherLoginDto | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  secureNote?: { type: number } | null;
  /**
   * SSH 密钥（type 5）。三个字段**都是 EncString**。
   *
   * ⚠️ 服务端在 `Bitwarden-Client-Version` 低于 2024.12.0 时会把这类条目
   * **从 sync 结果里整个过滤掉** —— 不是报错，是当作不存在。
   * 我们发的是 2026.10.0（见 http.ts 的 CLIENT_VERSION）。
   */
  sshKey?: CipherSshKeyDto | null;
  fields?: CipherFieldDto[] | null;
  passwordHistory?: CipherPasswordHistoryDto[] | null;
  /** ⚠️ 无附件时是 **null**，不是空数组 */
  attachments?: CipherAttachmentDto[] | null;
  collectionIds?: string[];
  /** Vaultwarden 恒为 true，无信息量 —— 不要据此做判断 */
  organizationUseTotp?: boolean;
}

export interface FolderDto {
  id: string;
  name: string | null;
  revisionDate: string;
  // ⚠️ 文件夹**没有** creationDate
}

export interface ProfileDto {
  id: string;
  email: string;
  name: string | null;
  /** 用户对称密钥（EncString），被拉伸主密钥包装 */
  key: string | null;
  /** RSA 私钥（EncString），被用户密钥包装 */
  privateKey: string | null;
  [k: string]: unknown;
}

export interface SyncResult {
  profile: ProfileDto;
  folders: FolderDto[];
  ciphers: CipherDto[];
  collections: unknown[];
}

/**
 * CipherType。
 * ⚠️ 6/7/8 是 2026 年新增的，老服务端不认识 —— 按接口稳定性原则，
 * 收到时按「未知类型」只读展示，不提供编辑。
 */
export const CIPHER_TYPE = {
  login: 1, secureNote: 2, card: 3, identity: 4,
  sshKey: 5, bankAccount: 6, driversLicense: 7, passport: 8,
} as const;

export const FIELD_TYPE = { text: 0, hidden: 1, boolean: 2, linked: 3 } as const;

/** URI 匹配策略。linkedId 与它的数字段见 bitwarden-api-notes.md §2.5 */
export const URI_MATCH = {
  domain: 0, host: 1, startsWith: 2, exact: 3, regularExpression: 4, never: 5,
} as const;
