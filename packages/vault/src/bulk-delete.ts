import { partitionCiphers, type CipherDto } from '@1warden/api';
import type { SymmetricKey } from '@1warden/crypto';
import { decryptCipher } from './decrypt';
import { isProfileItem } from './profile';

export type BulkDeleteScope = 'vault' | 'trash';
export interface BulkDeletePreview {
  token: string;
  scope: BulkDeleteScope;
  count: number;
  account: { serverUrl: string; email: string };
}
export interface BulkDeleteResult {
  completed: number;
  skipped: number;
  failed: { name: string; reason: string }[];
}

/** Only owner memory retains IDs. The presentation receives a count and opaque token. */
export interface BulkDeleteCandidate { id: string; name: string; deletedDate: string | null }

export function inBulkDeleteScope(dto: CipherDto, scope: BulkDeleteScope): boolean {
  if (dto.organizationId) return false;
  if (dto.deletedDate == null || dto.deletedDate === '') return scope === 'vault';
  // Browsing keeps malformed records visible. Bulk cleanup must instead preserve
  // uncertain records, and permanent deletion must use the same trash partition.
  if (typeof dto.deletedDate !== 'string' || !Number.isFinite(Date.parse(dto.deletedDate))) return false;
  return scope === 'trash' && partitionCiphers([dto]).trashed.length === 1;
}

export async function readBulkDeleteCandidate(dto: CipherDto, scope: BulkDeleteScope, key: SymmetricKey): Promise<BulkDeleteCandidate | null> {
  if (!inBulkDeleteScope(dto, scope)) return null;
  let name = '无法解密的条目';
  try {
    const item = await decryptCipher(dto, key);
    if (isProfileItem(item)) return null;
    // Profiles are secure notes with an encrypted marker. A damaged marker must
    // never make an internal record look like an ordinary user record.
    if (dto.type === 2 && (item.nameFailed || item.notesFailed || item.preservation?.failures.length)) {
      throw new Error('无法确认安全笔记是否为个人资料，请用兼容客户端检查后重试');
    }
    if (!item.nameFailed) name = item.name || '未命名条目';
  } catch {
    if (dto.type === 2) throw new Error('无法确认安全笔记是否为个人资料，请用兼容客户端检查后重试');
  }
  return { id: dto.id, name, deletedDate: dto.deletedDate ?? null };
}
