import type { HttpClient } from './http';
import type {
  CipherDto, CipherLoginDto, CipherFieldDto, CipherPasswordHistoryDto, CipherSshKeyDto,
  CipherBankAccountDto, CipherDriversLicenseDto, CipherPassportDto,
} from './types';

/**
 * ⚠️ 这里刻意把 `login` / `fields` / `passwordHistory` 写成**具体 DTO** 而不是 `unknown`。
 *
 * `unknown` 能通过编译但会让调用方对自己的输出一无所知 —— 写错字段名、
 * 忘了某个字段都不会有人提醒，直到用户发现 passkey 或自定义字段没了。
 * 组装这一层的价值就在于它**知道**自己该产出什么形状，就该把它写出来。
 *
 * Native type blocks with modeled contracts use concrete DTOs; unknown source
 * properties are retained separately by the vault preservation layer.
 */
export interface CipherWriteBody {
  /** Unknown native fields retained by the vault serializer. */
  [key: string]: unknown;
  collectionIds?: string[];
  type: number;
  name: string;
  notes: string | null;
  folderId: string | null;
  organizationId: string | null;
  favorite: boolean;
  reprompt: number;
  key?: string | null;
  login?: CipherLoginDto;
  card?: unknown;
  identity?: unknown;
  secureNote?: unknown;
  sshKey?: CipherSshKeyDto;
  bankAccount?: CipherBankAccountDto;
  driversLicense?: CipherDriversLicenseDto;
  passport?: CipherPassportDto;
  fields?: CipherFieldDto[] | null;
  passwordHistory?: CipherPasswordHistoryDto[] | null;
  lastKnownRevisionDate?: string | null;
  archivedDate?: string | null;
}

/**
 * 组装请求体。两个必须显式处理的字段：
 *
 * ⚠️ **`encryptedFor` 必填**，且必须等于当前用户 uuid。
 * 缺失导致的是**反序列化失败**（不是校验错误）；不等会导致 422 "Invalid user cipher"。
 *
 * ⚠️ **`folderId` 必须总是发送**。省略会让服务端把条目**移出文件夹** ——
 * `folder_id` 是 `Option<FolderId>`，缺省得到 `None`，进而删除 `folders_ciphers` 关联行。
 *
 * ⚠️ **`archivedDate` 的语义是反的**：`Some(date)` = 归档，`None` = **取消归档**。
 * 因此只在调用方显式提供时才带上 —— 否则一次普通的改名会把已归档条目悄悄"取消归档"。
 */
function buildBody(userId: string, b: CipherWriteBody): Record<string, unknown> {
  const out: Record<string, unknown> = { ...b, encryptedFor: userId };
  return out;
}

export async function createCipher(
  http: HttpClient, userId: string, body: CipherWriteBody,
): Promise<CipherDto> {
  return http.request<CipherDto>('POST', '/api/ciphers', { json: buildBody(userId, body) });
}

export async function getCipher(http: HttpClient, id: string): Promise<CipherDto> {
  return http.request<CipherDto>('GET', `/api/ciphers/${encodeURIComponent(id)}`);
}

export async function updateCipher(
  http: HttpClient, id: string, userId: string, body: CipherWriteBody,
): Promise<CipherDto> {
  return http.request<CipherDto>('PUT', `/api/ciphers/${id}`, { json: buildBody(userId, body) });
}

/**
 * 软删除 —— 条目进入回收站，**可恢复**。
 *
 * ⚠️ 对应的是 **`PUT /delete`**。这与直觉相反：
 * `POST /delete` 与 `DELETE /{id}` 都是**永久删除**。
 * 写反了用户会永久丢失数据，且没有撤销。
 */
export async function softDeleteCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/delete`);
}

/**
 * 硬删除 —— **永久，不可恢复**。会级联删除附件文件、密码历史与收藏记录。
 *
 * ⚠️ 对应的是 **`DELETE /{id}`**。
 * UI 上必须在调用此函数前做二次确认，且要明确告诉用户「无法恢复」。
 */
export async function hardDeleteCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('DELETE', `/api/ciphers/${id}`);
}

export async function restoreCipher(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/restore`);
}

export async function setArchived(http: HttpClient, id: string, archived: boolean): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/${archived ? 'archive' : 'unarchive'}`);
}

export async function moveCiphers(
  http: HttpClient, folderId: string | null, ids: string[],
): Promise<void> {
  // 空列表没有意义，且服务端会返回一个令人困惑的错误 —— 直接短路
  if (ids.length === 0) return;
  await http.request<void>('POST', '/api/ciphers/move', { json: { folderId, ids } });
}

/**
 * 局部更新：只改 folderId 与 favorite。
 *
 * 这是**唯一能作用于只读条目**的更新路径 —— 服务端对这条路由只校验可读性，
 * 不校验可写性。也因此它**不做** `lastKnownRevisionDate` 的乐观并发检查。
 * Both fields are required: Vaultwarden clears folder membership if folderId is omitted.
 */
export async function updateCipherPartial(
  http: HttpClient, id: string, p: { folderId: string | null; favorite: boolean },
): Promise<void> {
  await http.request<void>('PUT', `/api/ciphers/${id}/partial`, { json: { folderId: p.folderId, favorite: p.favorite } });
}
