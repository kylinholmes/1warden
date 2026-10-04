import { ApiError } from './errors';
import type { HttpClient } from './http';
import type { CipherDto, FolderDto, ProfileDto, SyncResult } from './types';

export async function sync(
  http: HttpClient,
  _token: string,
  opts: { excludeDomains?: boolean } = {},
): Promise<SyncResult> {
  // 非自动填充场景默认排除 equivalent-domains 载荷 —— 我们读不到也用不上
  const exclude = opts.excludeDomains ?? true;
  const raw = await http.request<unknown>('GET', `/api/sync?excludeDomains=${exclude}`);
  const root = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  return {
    profile: (root['profile'] ?? {}) as ProfileDto,
    folders: arr<FolderDto>(root['folders']),
    ciphers: arr<CipherDto>(root['ciphers']),
    collections: arr<unknown>(root['collections']),
  };
}

export interface PartitionedCiphers {
  active: CipherDto[];
  archived: CipherDto[];
  trashed: CipherDto[];
}

/**
 * 服务端给的是 ISO 日期或 null。**只有看起来像日期的字符串才算「已设置」** ——
 * 空串和垃圾值一律当作未设置。
 *
 * 方向很重要：畸形值若判为「已删除」，条目会被**藏起来**（用户看不到自己的密码）；
 * 判为「未删除」则照常显示（只是多一个条目）。**失败要可见，不要隐藏。**
 */
function isDateSet(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

/**
 * 把 sync 返回的条目分成三类。
 *
 * ⚠️ **`/api/sync` 会返回已删除和已归档的条目** —— 服务端不做任何过滤。
 * 分区必须由客户端完成，否则用户删除的密码会一直出现在列表和搜索结果里。
 *
 * 同时处于归档与删除状态时，**以删除为准**（回收站优先）。
 */
export function partitionCiphers(ciphers: CipherDto[]): PartitionedCiphers {
  const active: CipherDto[] = [];
  const archived: CipherDto[] = [];
  const trashed: CipherDto[] = [];
  for (const c of ciphers) {
    if (isDateSet(c.deletedDate)) trashed.push(c);
    else if (isDateSet(c.archivedDate)) archived.push(c);
    else active.push(c);
  }
  return { active, archived, trashed };
}

/**
 * 服务器数据的修订时间戳（**裸整数**，epoch 毫秒）。
 *
 * 若该值 ≤ 上次同步时间，可以**完全跳过 sync** —— 这是大保险库最重要的性能杠杆，
 * 官方客户端就是这么做的。
 */
export async function getRevisionDate(http: HttpClient, _token: string): Promise<number> {
  const raw = await http.request<unknown>('GET', '/api/accounts/revision-date');
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ApiError('malformedResponse', 'revision-date 不是数字', { body: raw });
  }
  return n;
}
