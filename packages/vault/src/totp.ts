import { generateTotp, parseOtpauthUri } from '@coffer/crypto';
import type { VaultItem, CustomField } from './model';

/**
 * 自定义字段里用来存 OTP 的名字。
 *
 * 1Password 允许把一次性密码加在**任意条目类型**上，而 Bitwarden 的 `login.totp`
 * 只存在于登录条目。非登录条目上我们借用自定义字段表达。
 *
 * ⚠️ 字段名是有功能的，不是装饰：1Password 的 CLI 也是靠名字
 * （`one-time password` / `mfa serial`）来识别多因素凭据的。
 */
export const TOTP_FIELD_NAME = '一次性密码';

/** 兼容 1Password 的英文命名 —— 读取时都认 */
const TOTP_FIELD_ALIASES = new Set([TOTP_FIELD_NAME, 'one-time password', 'One-Time Password', 'otp', 'OTP']);

function isTotpField(f: CustomField): boolean {
  return TOTP_FIELD_ALIASES.has(f.name);
}

/**
 * 读取 TOTP 种子。**双路径**：
 *   1. 原生 `login.totp`（Bitwarden 标准，官方客户端也认）
 *   2. 名为「一次性密码」的自定义字段（1Password 兼容，非登录条目用）
 */
export function readTotpSecret(item: VaultItem): string | null {
  const native = item.login?.totp;
  if (typeof native === 'string' && native.length > 0) return native;
  const field = item.customFields.find(isTotpField);
  if (field && field.value.length > 0) return field.value;
  return null;
}

export interface TotpWriteResult {
  loginTotp: string | null;
  customFields: CustomField[];
}

/**
 * 写入 TOTP 种子。**原生优先**：
 * 登录条目写 `login.totp`，只有原生表达不了的（非登录条目）才写自定义字段。
 *
 * ⚠️ 这个选择的理由很实际：`login.totp` 是 Bitwarden 原生字段，
 * 写进自定义字段的话，**用户在官方 App 里看不到验证码**，互操作性受损。
 *
 * 不修改传入的 item —— 返回新的字段值，由调用方组装。
 */
export function writeTotpSecret(item: VaultItem, secret: string | null): TotpWriteResult {
  const others = item.customFields.filter((f) => !isTotpField(f));

  if (item.type === 'login') {
    // 原生能表达，就清掉可能存在的自定义字段，避免两处不一致
    return { loginTotp: secret, customFields: others };
  }

  if (secret === null) return { loginTotp: null, customFields: others };
  return {
    loginTotp: null,
    customFields: [...others, { name: TOTP_FIELD_NAME, value: secret, type: 1, linkedId: null }],
  };
}

export interface TotpCode {
  code: string;
  period: number;
  remaining: number;
}

/**
 * 生成验证码。没有种子或种子坏了都返回 null ——
 * 用户从别处粘贴来的种子可能是任何东西，不该让整个条目详情页崩掉。
 */
export async function totpCode(item: VaultItem, at?: number): Promise<TotpCode | null> {
  const secret = readTotpSecret(item);
  if (secret === null) return null;
  try {
    return await generateTotp(secret, at);
  } catch {
    return null;
  }
}

/** 条目上是否配了验证码 —— UI 用它决定要不要显示那一行 */
export function hasTotp(item: VaultItem): boolean {
  return readTotpSecret(item) !== null;
}

export { parseOtpauthUri };
