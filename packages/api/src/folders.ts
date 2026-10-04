import type { HttpClient } from './http';
import type { FolderDto } from './types';

/**
 * ⚠️ Vaultwarden **没有批量删除文件夹的端点** ——
 * `DELETE /api/folders`（批量）与 `DELETE /api/folders/all` 都会 404，
 * 官方客户端有这两个调用但我们这里用不了。只能逐个删。
 *
 * 删除文件夹会删除 folders_ciphers 关联行，**条目本身存活**，变成无文件夹。
 * 所以 UI 上「删除文件夹」不该吓唬用户说会删掉里面的密码。
 */
export async function listFolders(http: HttpClient): Promise<FolderDto[]> {
  const raw = await http.request<unknown>('GET', '/api/folders');
  const root = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Array.isArray(root['data']) ? (root['data'] as FolderDto[]) : [];
}

export async function createFolder(http: HttpClient, name: string): Promise<FolderDto> {
  return http.request<FolderDto>('POST', '/api/folders', { json: { name } });
}

export async function updateFolder(http: HttpClient, id: string, name: string): Promise<FolderDto> {
  return http.request<FolderDto>('PUT', `/api/folders/${id}`, { json: { name } });
}

export async function deleteFolder(http: HttpClient, id: string): Promise<void> {
  await http.request<void>('DELETE', `/api/folders/${id}`);
}
