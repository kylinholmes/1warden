import type { HttpClient } from './http';
import type { ProfileDto } from './types';

/** 与 `Sync.Profile` 返回的是同一个对象（服务端就是同一个函数） */
export async function getProfile(http: HttpClient): Promise<ProfileDto> {
  return http.request<ProfileDto>('GET', '/api/accounts/profile');
}

/**
 * 校验主密码是否仍然正确。
 *
 * 用途：修改主密码、密钥轮换、删除账户等敏感操作前的**再认证**。
 * 注意服务端的通用再认证信封是 `PasswordOrOtpData` ——
 * `masterPasswordHash` 与 `otp` **只能给一个**，两个都给会报 "No validation provided"。
 * 这里只走 hash 那一路。
 */
export async function verifyPassword(http: HttpClient, masterPasswordHash: string): Promise<void> {
  await http.request<unknown>('POST', '/api/accounts/verify-password', {
    json: { masterPasswordHash },
  });
}
