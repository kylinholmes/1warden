/**
 * 官方 Bitwarden CLI 的调用入口。两个脚本共用，保证解析方式和版本检查一致。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** CLI 状态目录放在仓库内，不污染 ~/.config */
export const BW_APPDATA = fileURLToPath(new URL('../.dev/bw-cli', import.meta.url));

/**
 * 备好运行 CLI 所需的环境变量。
 *
 * 这两个变量原先只写在 scripts/dev-env.sh 里，而它**只有 dev-server.sh 会 source** ——
 * 于是文档里「dev-server.sh start; bun run seed; bun run test:interop」的流程
 * 在全新 shell 里第二步就挂，报错还是 "self signed certificate"，完全指不到真正原因。
 * 放在这里，任何调用方式都能跑通。
 */
export function prepareBwEnv(): void {
  mkdirSync(BW_APPDATA, { recursive: true });
  process.env.BITWARDENCLI_APPDATA_DIR ??= BW_APPDATA;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
}

/**
 * 显式解析到仓库内 pin 的那个 CLI，**不走 PATH**。
 *
 * 走 PATH 会导致「实际用哪个版本」取决于调用方式：`bun run test:interop` 会把
 * node_modules/.bin 前置，而直接 `bun scripts/interop-test.ts` 则解析到全局安装的版本。
 * 2026.x 的 CLI 登录后会做「用户密钥 ID 回填」迁移，调用 Vaultwarden 未实现的端点而失败
 * （KeyIdBackfillError，404）—— 于是同一个测试在不同调用方式下一过一挂，极难排查。
 */
export const BW_BIN = fileURLToPath(new URL('../node_modules/.bin/bw', import.meta.url));

/** 已知与 Vaultwarden 1.37.3 兼容的 CLI 主版本 */
const REQUIRED_MAJOR = '2025.';

let checked = false;

/** 首次调用时校验版本，不匹配就响亮地失败，而不是给出难以理解的错误 */
export function assertBwVersion(): void {
  if (checked) return;
  prepareBwEnv();
  let version: string;
  try {
    version = execFileSync(BW_BIN, ['--version'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').pop()!.trim();
  } catch {
    throw new Error(`找不到官方 CLI：${BW_BIN}\n请先运行： bun add -D @bitwarden/cli@2025.2.0`);
  }
  if (!version.startsWith(REQUIRED_MAJOR)) {
    throw new Error(
      `需要 @bitwarden/cli ${REQUIRED_MAJOR}x，实际是 ${version}。\n` +
      '2026.x 登录后会调用 Vaultwarden 未实现的端点（KeyIdBackfillError）而失败。\n' +
      '修复： bun add -D @bitwarden/cli@2025.2.0',
    );
  }
  checked = true;
}
