import {
  decryptString, derivePasswordKey, encryptString, parseEncString, randomBytes,
  stretchMasterKey, toBase64, zeroize, zeroizeKey, type KdfConfig,
} from '@1warden/crypto';

type Envelope = Record<string, unknown>;

function objectOf(data: Uint8Array): Envelope | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(data));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Envelope : null;
  } catch { return null; }
}

/** Includes account-restricted exports so callers can give a specific error. */
export function isEncryptedJsonExport(data: Uint8Array): boolean {
  return objectOf(data)?.['encrypted'] === true;
}

function kdfOf(doc: Envelope): KdfConfig {
  const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  const iterations = doc['kdfIterations'];
  if (doc['kdfType'] === 0 && integer(iterations, 1, 2_000_000)) return { kdf: 0, iterations };
  const memory = doc['kdfMemory'];
  const parallelism = doc['kdfParallelism'];
  // Bounds apply before allocation/WASM: at most 256 MiB and a bounded work product.
  if (doc['kdfType'] === 1 && integer(iterations, 1, 10) && integer(memory, 8, 256)
    && integer(parallelism, 1, 16) && iterations * memory <= 768) {
    return { kdf: 1, iterations, memory, parallelism };
  }
  throw new Error('加密文件的 KDF 参数无效或超出安全处理上限，请在原客户端重新导出');
}

function ciphertext(value: unknown): string {
  if (typeof value !== 'string') throw new Error('加密文件格式不正确或已损坏');
  try {
    const parsed = parseEncString(value);
    if (parsed.type !== 2 || parsed.data.length === 0 || parsed.data.length % 16 !== 0) throw new Error();
  } catch { throw new Error('加密文件格式不正确或已损坏'); }
  return value;
}

/** Portable Bitwarden format; never uses the account key or email. */
export async function decryptJsonExport(data: Uint8Array, password?: string): Promise<string> {
  const doc = objectOf(data);
  if (!doc || doc['encrypted'] !== true) throw new Error('加密文件格式不正确');
  if (doc['passwordProtected'] !== true) throw new Error('这是账户限定的加密导出，请在原客户端改用独立密码保护的 JSON 导出');
  const kdf = kdfOf(doc);
  const salt = doc['salt'];
  if (typeof salt !== 'string' || salt.length === 0 || salt.length > 1024) throw new Error('加密文件的盐格式不正确');
  const validation = ciphertext(doc['encKeyValidation_DO_NOT_EDIT']);
  const encryptedData = ciphertext(doc['data']);
  if (password === undefined || password.length === 0) throw new Error('请输入此导出文件的独立密码');
  const raw = await derivePasswordKey(password, salt, kdf);
  const key = await stretchMasterKey(raw);
  zeroize(raw);
  try {
    try { await decryptString(validation, key); }
    catch { throw new Error('文件密码不正确或文件已损坏，请检查密码后重试'); }
    try { return await decryptString(encryptedData, key); }
    catch { throw new Error('加密文件内容已损坏，无法读取'); }
  } finally { zeroizeKey(key); }
}

/**
 * Matches Bitwarden BaseVaultExportService.buildPasswordExport and makePinKey:
 * https://github.com/bitwarden/clients/blob/cli-v2025.2.0/libs/tools/export/vault-export/vault-export-core/src/services/base-vault-export.service.ts
 * PBKDF2(exact UTF-8 salt) -> HKDF-expand enc/mac -> type-2 AES-CBC/HMAC.
 */
export async function encryptJsonExport(clearText: string, password: string): Promise<string> {
  if (!password.trim()) throw new Error('请设置独立的导出密码');
  const salt = toBase64(randomBytes(16));
  const kdf = { kdf: 0, iterations: 600_000 } as const;
  const raw = await derivePasswordKey(password, salt, kdf);
  const key = await stretchMasterKey(raw);
  zeroize(raw);
  try {
    return JSON.stringify({ encrypted: true, passwordProtected: true, salt,
      kdfType: kdf.kdf, kdfIterations: kdf.iterations,
      encKeyValidation_DO_NOT_EDIT: await encryptString(crypto.randomUUID(), key),
      data: await encryptString(clearText, key),
    }, null, 2);
  } finally { zeroizeKey(key); }
}
