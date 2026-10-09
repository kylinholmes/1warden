#!/usr/bin/env bun
/**
 * 用**我们自己的** @1warden/crypto 在本地 Vaultwarden 上注册测试账户（幂等）。
 *
 * 为什么不用官方 CLI 注册：CLI 2026.9.1 **没有 register 命令**。
 * 而且用自己的代码注册反而更有价值 —— 注册本身就顺带跑通了整条密钥层级
 * （KDF → masterPasswordHash → HKDF 拉伸 → 生成并包装用户密钥 → 生成并包装 RSA 私钥），
 * 随后只要官方 CLI 能用同一个主密码登录并解开保险库，就证明我们这套是对的。
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from '../packages/crypto/src/index';
import { BW_BIN, assertBwVersion, prepareBwEnv } from './bw-cli';
import { localVaultwardenUrl, registerLocalVaultwardenAccount, RegistrationRejected } from './vaultwarden-registration';

// 必须在任何 fetch 之前备好环境（跳过自签证书校验 + CLI 状态目录）。
// 官方 CLI 拒绝明文 HTTP，所以本地服务也走 HTTPS —— 详见 scripts/dev-env.sh。
prepareBwEnv();

// 默认与 scripts/dev-env.sh 保持一致（HTTPS + 自签证书：官方 CLI 拒绝明文 HTTP）
const BASE = localVaultwardenUrl(process.env.VW_URL ?? 'https://localhost:8443');
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';
const ITERATIONS = 600_000;

/**
 * KDF 可选，用于验证两种 KDF 都正确。
 * Argon2id 尤其重要：它的盐是 **SHA-256(邮箱)** 而 PBKDF2 用邮箱原文 ——
 * 搞错的话 PBKDF2 账户一切正常、Argon2 账户永远「密码错误」，且毫无线索。
 *
 *   bun run seed                                   # PBKDF2（默认）
 *   ONEWARDEN_KDF=argon2 ONEWARDEN_TEST_EMAIL=a@e.com bun run seed
 */
const KDF_KIND = process.env.ONEWARDEN_KDF ?? 'pbkdf2';
const ARGON2 = { iterations: 3, memory: 64, parallelism: 4 };
const kdfConfig = KDF_KIND === 'argon2'
  ? { kdf: KDF_TYPE_ARGON2ID as const, ...ARGON2 }
  : { kdf: KDF_TYPE_PBKDF2 as const, iterations: ITERATIONS };

async function main() {
  console.log(`→ 目标服务器: ${BASE}`);
  console.log(`→ 测试账户:   ${EMAIL}`);

  console.log(`→ KDF:     ${KDF_KIND}${KDF_KIND === 'argon2' ? ` ${JSON.stringify(ARGON2)}` : ` ${ITERATIONS} 轮`}`);

  // New Vaultwarden registration requires a verification token even without SMTP.
  try {
    await registerLocalVaultwardenAccount({ serverUrl: BASE, email: EMAIL, password: PASSWORD,
      name: '1Warden Interop', kdf: kdfConfig });
    console.log('✓ 注册成功');
  } catch (error) {
    // The server deliberately conflates duplicate accounts and disabled signups.
    // Do not call this success: the mandatory CLI login/unlock below must prove
    // that the configured test identity already exists with these credentials.
    if (!(error instanceof RegistrationRejected) || error.status !== 400 || error.phase !== 'finish') throw error;
    console.warn('· 服务器拒绝完成注册；可能账户已存在。接下来必须通过官方 CLI 登录并解锁验证，失败则退出。');
  }

  // 5. 让官方 CLI 登录 —— 这是第一道互操作证明
  console.log('\n→ 用官方 Bitwarden CLI 登录同一个账户…');
  assertBwVersion();
  // 三个流都 pipe：execFileSync 才会把 stdout 作为返回值交出来。
  // 若把 stdout 设为 inherit，返回值是空的，看起来像「命令没输出」，极难排查。
  const bwRun = (args: string[]): string =>
    execFileSync(BW_BIN, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    }).trim();

  // 顺序不能反：CLI 要求「先登出才能改服务器地址」，而「已登录时不能再次 login」。
  // 两个约束合起来意味着每次都得：登出 → 配置服务器 → 登录。
  try { bwRun(['logout']); } catch { /* 本来就没登录 */ }
  bwRun(['config', 'server', BASE]);

  let session: string;
  try {
    session = bwRun(['login', EMAIL, PASSWORD, '--raw']);
  } catch (e) {
    console.error('✗ 官方 CLI 登录失败 —— 说明我们的密钥派生与官方不一致');
    console.error(String(e));
    process.exit(1);
  }
  console.log('✓ 官方 CLI 用同一个主密码登录成功（= 我们的 KDF 与 masterPasswordHash 正确）');

  // unlock 会真正解开 Key 字段，这一步验证 HKDF 拉伸与 EncString 加密
  const unlocked = bwRun(['unlock', PASSWORD, '--raw']);
  console.log('✓ 官方 CLI 解锁成功（= 我们的 HKDF 拉伸与 EncString 加密正确）');

  // 写进文件，免得在 shell 里做字符串搬运（也避免 bw 因缺 session 转成交互式提示）
  const sessionFile = `${process.env.ROOT ?? process.cwd()}/.dev/bw-session`;
  await writeFile(sessionFile, unlocked || session, { mode: 0o600 });
  console.log(`✓ 会话已写入 ${sessionFile}`);
  console.log('\n下一步： bun run test:interop');
}

main().catch((e) => { console.error(e); process.exit(1); });
