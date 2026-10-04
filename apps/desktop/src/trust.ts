/**
 * 服务器证书信任。
 *
 * 自建 Vaultwarden 大多没上公信证书，而「验证失败就直接拒绝」会让用户
 * 完全没法用。但「接受任意证书」等于关掉 TLS —— 中间人可以为所欲为。
 *
 * 折中是 TOFU：验证失败时**不**偷偷放行，而是把证书信息摆给用户看，
 * 由用户决定；确认后把指纹固定下来，之后只有完全相同的证书才通过。
 * 真正的判定逻辑在 `src-tauri/src/http.rs`，这里只是调用口。
 */
import { invoke } from '@tauri-apps/api/core';

export interface CertInfo {
  /** SHA-256，大写十六进制冒号分隔 —— 与 `openssl x509 -fingerprint -sha256` 同格式 */
  fingerprint: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** 自己签自己 —— 自建服务的典型形态，也是「需要用户拍板」的信号 */
  isSelfSigned: boolean;
  alreadyTrusted: boolean;
}

export function probeCertificate(serverUrl: string): Promise<CertInfo> {
  return invoke<CertInfo>('probe_certificate', { url: serverUrl });
}

export function trustCertificate(serverUrl: string, fingerprint: string): Promise<void> {
  return invoke<void>('trust_certificate', { url: serverUrl, fingerprint });
}

export function forgetCertificate(serverUrl: string): Promise<void> {
  return invoke<void>('forget_certificate', { url: serverUrl });
}
