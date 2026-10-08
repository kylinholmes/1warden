# 1Warden 计划 1：基础设施 + 密码学核心

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 monorepo 骨架与本地 Vaultwarden 测试服务，并实现经**官方 Bitwarden CLI 互操作验证**的 Bitwarden 客户端密码学库 `@1warden/crypto`。

**Architecture:** 纯函数式密码学库，无状态、无 I/O、无网络，全部密钥显式传参。密钥派生用 `hash-wasm`（Argon2id/PBKDF2 的 WASM 实现，浏览器与 Node 通用），对称加密与 RSA 用 WebCrypto 原生 API。HKDF-Expand 需手写（WebCrypto 的 HKDF 强制做 extract+expand，与 Bitwarden 只做 expand 的语义不符）。

**Tech Stack:** Bun workspaces · TypeScript (strict) · Vitest · hash-wasm · WebCrypto · Vaultwarden 1.37.3（本地编译）

**Spec:** `docs/superpowers/specs/2026-10-04-onewarden-design.md`

## Global Constraints

- **包管理器**：`bun`（registry 已在 `bunfig.toml` / `.npmrc` 指向 `https://registry.npmmirror.com`）
- **TypeScript**：`strict: true`，`noUncheckedIndexedAccess: true`，不允许 `any`（用 `unknown` + 收窄）
- **`@1warden/crypto` 零网络、零 I/O、零全局状态**：所有密钥必须作为参数传入
- **绝不记录敏感数据**：密码、密钥、明文、token 不得出现在 `console.*`、错误消息或测试快照中
- **解密失败必须抛错**，不得静默返回空串
- **MAC 比较必须常量时间**
- **目标运行时**：Node 26 / 现代浏览器 / Tauri WebView —— 只用三者都有的 API（`globalThis.crypto.subtle`、`TextEncoder`、`Uint8Array`）
- **不引入任何未经许可的 1Password 品牌资产**（名称、logo、图标）

## Review Focus

以下输入/条件在 spec 中未明说，但真实用户一定会遇到。每个都在拥有该代码的任务里配了对应测试：

1. **Argon2id 账户登录** — 参数单位若理解错（KiB vs MiB），PBKDF2 账户一切正常而 Argon2 账户永远登录失败，且报错是"密码错误"，极难排查。
2. **Unicode 主密码与条目内容** — 中文/emoji 密码、中文条目名。WebCrypto 的 `TextEncoder` 处理 UTF-8 正常，但 base64 转换与字节长度假设容易出错。
3. **含 `|` 或 `.` 的密文边界情况** — EncString 用 `.` 和 `|` 分隔，解析必须从**第一个** `.` 与**前两个** `|` 切分，否则内容里的分隔符会导致误解析。
4. **空字符串与 `null` 条目字段** — Bitwarden 大量字段是空串或缺失（如没填的用户名）。空串必须能加密/解密往返，缺失字段不得导致崩溃。
5. **剪贴板/内存中的明文泄漏** — 见 Global Constraints。测试会扫描序列化输出，断言不含明文。

---

## Task 1: Monorepo 骨架

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: 无
- Produces: bun workspaces 根配置；`tsconfig.base.json` 供所有子包 `extends`；`bun run test` 统一跑全仓测试

- [ ] **Step 1: 创建根 `package.json`**

```json
{
  "name": "onewarden",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --build --force"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "5.0.3",
    "@types/node": "24.9.2"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: 创建 `.gitignore`**

```
node_modules/
dist/
*.tsbuildinfo
.dev/
vendor/
.DS_Store
coverage/
playwright-report/
test-results/
```

- [ ] **Step 4: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: 安装依赖并验证**

Run: `bun install && bun run test`
Expected: 安装成功；vitest 报 "No test files found"（退出码非 0 属正常，因为还没有测试）

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .gitignore vitest.config.ts bunfig.toml .npmrc bun.lock
git commit -m "chore: bootstrap bun workspaces monorepo"
```

---

## Task 2: 本地 Vaultwarden 测试服务

**Files:**
- Create: `scripts/build-vaultwarden.sh`
- Create: `scripts/dev-server.sh`
- Create: `scripts/dev-env.sh`

**Interfaces:**
- Consumes: 无
- Produces: `scripts/dev-server.sh start|stop|reset|status` —— 在 `http://127.0.0.1:8080` 提供干净可重置的 Vaultwarden；数据目录 `.dev/vaultwarden-data/`；测试账号 `onewarden-test@example.com` / `Test-Master-Password-123!`

> **背景**：Vaultwarden 官方 **不发布 macOS 预编译二进制**（1.37.3 的 GitHub release 无任何 asset），Homebrew 也没有 formula。所以走 **cargo 从源码编译**，产出纯原生 arm64 可执行文件，不用虚拟机。crates 走已配置好的 rsproxy 镜像，编译有 sccache 加速。

- [ ] **Step 1: 创建 `scripts/build-vaultwarden.sh`**

```bash
#!/usr/bin/env bash
# 编译 Vaultwarden 到 vendor/vaultwarden（幂等：已存在则跳过）
set -euo pipefail

VW_VERSION="${VW_VERSION:-1.37.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
SRC="$VENDOR/src"
BIN="$VENDOR/vaultwarden"

if [[ -x "$BIN" ]]; then
  echo "✓ 已存在: $BIN"
  "$BIN" --version || true
  exit 0
fi

mkdir -p "$VENDOR" "$SRC"

if [[ ! -d "$SRC/vaultwarden-$VW_VERSION" ]]; then
  echo "→ 下载 Vaultwarden $VW_VERSION 源码..."
  curl -fL --retry 3 --max-time 900 \
    -o "$SRC/vw.tar.gz" \
    "https://codeload.github.com/dani-garcia/vaultwarden/tar.gz/refs/tags/$VW_VERSION"
  tar xzf "$SRC/vw.tar.gz" -C "$SRC"
fi

echo "→ 编译中（首次约 5-15 分钟，有 sccache 会快很多）..."
cd "$SRC/vaultwarden-$VW_VERSION"
cargo build --release --features sqlite

# cargo 的 target-dir 可能被 ~/.cargo/config.toml 重定向，两处都找
for cand in "$ROOT/target/release/vaultwarden" "/tmp/cargo_target/release/vaultwarden"; do
  if [[ -x "$cand" ]]; then cp "$cand" "$BIN"; break; fi
done
[[ -x "$BIN" ]] || { echo "✗ 未找到编译产物" >&2; exit 1; }

echo "✓ 编译完成: $BIN"
"$BIN" --version
```

- [ ] **Step 2: 创建 `scripts/dev-env.sh`（共享配置）**

```bash
#!/usr/bin/env bash
# 被 dev-server.sh / 测试脚本 source，集中管理测试服务参数
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export VW_BIN="$ROOT/vendor/vaultwarden"
export VW_DATA="$ROOT/.dev/vaultwarden-data"
export VW_PORT="${VW_PORT:-8080}"
export VW_URL="http://127.0.0.1:$VW_PORT"
export VW_PIDFILE="$ROOT/.dev/vaultwarden.pid"
export VW_LOG="$ROOT/.dev/vaultwarden.log"

# 测试账号（仅供本地开发）
export ONEWARDEN_TEST_EMAIL="onewarden-test@example.com"
export ONEWARDEN_TEST_PASSWORD='Test-Master-Password-123!'

export VW_ENV=(
  "DATA_FOLDER=$VW_DATA"
  "ROCKET_PORT=$VW_PORT"
  "ROCKET_ADDRESS=127.0.0.1"
  "DOMAIN=$VW_URL"
  "SIGNUPS_ALLOWED=true"
  "SIGNUPS_VERIFY=false"
  "INVITATIONS_ALLOWED=true"
  "WEBSOCKET_ENABLED=true"
  "SHOW_PASSWORD_HINT=false"
  "LOG_LEVEL=warn"
  "I_REALLY_WANT_VOLATILE_STORAGE=false"
)
```

- [ ] **Step 3: 创建 `scripts/dev-server.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/dev-env.sh"

cmd="${1:-status}"

start() {
  [[ -x "$VW_BIN" ]] || { echo "✗ 未找到 $VW_BIN，请先运行 scripts/build-vaultwarden.sh" >&2; exit 1; }
  if is_up; then echo "✓ 已在运行: $VW_URL"; return 0; fi
  mkdir -p "$VW_DATA" "$(dirname "$VW_LOG")"
  echo "→ 启动 Vaultwarden..."
  env "${VW_ENV[@]}" "$VW_BIN" > "$VW_LOG" 2>&1 &
  echo $! > "$VW_PIDFILE"
  for _ in $(seq 1 60); do
    is_up && { echo "✓ 就绪: $VW_URL"; return 0; }
    sleep 0.5
  done
  echo "✗ 启动超时，日志尾部：" >&2; tail -30 "$VW_LOG" >&2; exit 1
}

stop() {
  if [[ -f "$VW_PIDFILE" ]]; then
    kill "$(cat "$VW_PIDFILE")" 2>/dev/null || true
    rm -f "$VW_PIDFILE"
    echo "✓ 已停止"
  else
    echo "· 未在运行"
  fi
}

reset() {
  stop
  rm -rf "$VW_DATA"
  echo "✓ 数据已清空（下次 start 得到全新实例）"
}

is_up() { curl -fsS --max-time 3 "$VW_URL/api/config" >/dev/null 2>&1; }

status() { is_up && echo "● 运行中: $VW_URL" || echo "○ 未运行"; }

case "$cmd" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  reset) reset ;;
  status) status ;;
  *) echo "用法: $0 {start|stop|restart|reset|status}" >&2; exit 1 ;;
esac
```

- [ ] **Step 4: 编译并启动，验证服务可用**

```bash
chmod +x scripts/*.sh
./scripts/build-vaultwarden.sh
./scripts/dev-server.sh start
curl -fsS http://127.0.0.1:8080/api/config | head -c 300
```

Expected: `/api/config` 返回 JSON，含 `"version"` 字段（形如 `"2026.4.0"`）

- [ ] **Step 5: 验证可以注册账号**

```bash
curl -fsS -X POST http://127.0.0.1:8080/identity/accounts/prelogin \
  -H 'Content-Type: application/json' \
  -d '{"email":"onewarden-test@example.com"}'
```

Expected: `{"Kdf":0,"KdfIterations":600000,...}` —— 记下实际的 `Kdf` 与 `KdfIterations` 值，Task 4 的测试向量要用

- [ ] **Step 6: Commit**

```bash
git add scripts/
git commit -m "chore: add native Vaultwarden dev server scripts (cargo build, no VM)"
```

---

## Task 3: `@1warden/crypto` 包骨架 + 字节工具

**Files:**
- Create: `packages/crypto/package.json`
- Create: `packages/crypto/tsconfig.json`
- Create: `packages/crypto/src/bytes.ts`
- Test: `packages/crypto/src/bytes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `tsconfig.base.json`
- Produces:
  - `toBase64(bytes: Uint8Array): string` / `fromBase64(s: string): Uint8Array`
  - `toBase64Url(bytes: Uint8Array): string` / `fromBase64Url(s: string): Uint8Array`
  - `utf8Encode(s: string): Uint8Array` / `utf8Decode(b: Uint8Array): string`
  - `randomBytes(n: number): Uint8Array`
  - `sha256(data: Uint8Array): Promise<Uint8Array>`
  - `constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean`
  - `zeroize(b: Uint8Array): void`
  - `concatBytes(...parts: Uint8Array[]): Uint8Array`

> **关键实现陷阱**：浏览器 `btoa` 只接受 latin1 字符串，中文/emoji 会抛 `InvalidCharacterError`。必须逐字节拼字符串，不能用 `String.fromCharCode(...bytes)`（大数组会爆栈，且长参数列表有上限）。

- [ ] **Step 1: 创建包配置**

`packages/crypto/package.json`:
```json
{
  "name": "@1warden/crypto",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "hash-wasm": "4.12.0" }
}
```

`packages/crypto/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: 写失败的测试 `packages/crypto/src/bytes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  toBase64, fromBase64, toBase64Url, fromBase64Url,
  utf8Encode, utf8Decode, constantTimeEqual, concatBytes, zeroize,
} from './bytes';

describe('base64', () => {
  it('round-trips ASCII', () => {
    expect(fromBase64(toBase64(utf8Encode('hello')))).toEqual(utf8Encode('hello'));
  });

  it('uses standard alphabet with padding', () => {
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('round-trips a 70KB buffer without stack overflow', () => {
    const big = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });

  it('uses url-safe alphabet without padding', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(fromBase64Url('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
  });
});

describe('utf8', () => {
  it('round-trips Chinese text', () => {
    const s = '我的密码🔐';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});

describe('constantTimeEqual', () => {
  it('is true for equal buffers', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it('is false for different buffers', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  it('is false for different lengths', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('concatBytes', () => {
  it('concatenates in order', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])))
      .toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('sha256', () => {
  it('matches the NIST vector for "abc"', async () => {
    expect(toBase64(await sha256(utf8Encode('abc'))))
      .toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('produces 32 bytes', async () => {
    expect(await sha256(new Uint8Array(0))).toHaveLength(32);
  });
});

describe('zeroize', () => {
  it('overwrites every byte with zero', () => {
    const b = new Uint8Array([1, 2, 3]);
    zeroize(b);
    expect(b).toEqual(new Uint8Array([0, 0, 0]));
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun run test packages/crypto/src/bytes.test.ts`
Expected: FAIL —— 无法解析模块 `./bytes`

- [ ] **Step 4: 实现 `packages/crypto/src/bytes.ts`**

```ts
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeWith(alphabet: string, bytes: Uint8Array, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2]!;
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) { if (pad) out += '=='; break; }
    out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) { if (pad) out += '='; break; }
    out += alphabet[b2 & 0x3f]!;
  }
  return out;
}

function decodeWith(alphabet: string, s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0, bits = 0, o = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v === -1) throw new Error(`Invalid base64 character: ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out;
}

export const toBase64 = (b: Uint8Array): string => encodeWith(B64, b, true);
export const fromBase64 = (s: string): Uint8Array => decodeWith(B64, s);
export const toBase64Url = (b: Uint8Array): string => encodeWith(B64URL, b, false);
export const fromBase64Url = (s: string): Uint8Array => decodeWith(B64URL, s);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const utf8Encode = (s: string): Uint8Array => encoder.encode(s);
export const utf8Decode = (b: Uint8Array): string => decoder.decode(b);

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function zeroize(b: Uint8Array): void {
  b.fill(0);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun run test packages/crypto/src/bytes.test.ts`
Expected: PASS（全部 11 个用例）

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add byte, base64 and utf8 primitives"
```

---

## Task 4: 密钥派生（PBKDF2 + Argon2id）

**Files:**
- Create: `packages/crypto/src/kdf.ts`
- Test: `packages/crypto/src/kdf.test.ts`

**Interfaces:**
- Consumes: `bytes.ts` 的 `utf8Encode`、`toBase64`、`utf8Decode`
- Produces:
  - `type KdfConfig = { kdf: 0; iterations: number } | { kdf: 1; iterations: number; memory: number; parallelism: number }`
  - `deriveMasterKey(password: string, email: string, kdf: KdfConfig): Promise<Uint8Array>` — 32 字节
  - `hashMasterPassword(masterKey: Uint8Array, password: string): Promise<string>` — base64
  - `KDF_TYPE_PBKDF2 = 0` / `KDF_TYPE_ARGON2ID = 1`

> ⚠️ **本任务最大的风险点**：Argon2id 的 `memory` 单位。Bitwarden 服务端返回的 `KdfMemory` 与 Argon2 库期望的内存参数单位可能不一致（MiB vs KiB）。**Step 6 专门验证这一点**：如果单位错了，PBKDF2 账户一切正常，而 Argon2 账户会永远提示"密码错误"，且几乎无法排查。代码里把换算写成**唯一一处具名常量**，就是为了让它可被单独修正。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/kdf.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import { deriveMasterKey, hashMasterPassword, KDF_TYPE_PBKDF2, KDF_TYPE_ARGON2ID } from './kdf';
import { toBase64, utf8Encode, sha256 } from './bytes';

describe('deriveMasterKey / PBKDF2', () => {
  it('matches a known-answer vector', async () => {
    // 固定输入 → 固定输出。这组值由本实现首次运行产生后固化，
    // 用于捕获未来任何意外的行为改变（算法、盐、编码、迭代次数）。
    const key = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_PBKDF2, iterations: 600_000,
    });
    expect(key).toHaveLength(32);
    expect(toBase64(key)).toMatchInlineSnapshot();
  });

  it('normalises the email salt (trim + lowercase)', async () => {
    const a = await deriveMasterKey('pw', '  User@Example.COM  ', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    const b = await deriveMasterKey('pw', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(a).toEqual(b);
  });

  it('produces different keys for different passwords', async () => {
    const cfg = { kdf: KDF_TYPE_PBKDF2, iterations: 1000 } as const;
    expect(await deriveMasterKey('a', 'u@e.com', cfg)).not.toEqual(await deriveMasterKey('b', 'u@e.com', cfg));
  });

  it('handles a Chinese master password', async () => {
    const key = await deriveMasterKey('我的密码🔐', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(key).toHaveLength(32);
  });

  it('rejects an unsupported kdf type', async () => {
    // @ts-expect-error 故意传入非法值
    await expect(deriveMasterKey('pw', 'u@e.com', { kdf: 99, iterations: 1 })).rejects.toThrow(/Unsupported KDF/);
  });
});

describe('deriveMasterKey / Argon2id', () => {
  it('derives a 32-byte key', async () => {
    const key = await deriveMasterKey('password123', 'user@example.com', {
      kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4,
    });
    expect(key).toHaveLength(32);
  }, 30_000);

  it('is deterministic for the same parameters', async () => {
    const cfg = { kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4 } as const;
    const a = await deriveMasterKey('pw', 'u@e.com', cfg);
    const b = await deriveMasterKey('pw', 'u@e.com', cfg);
    expect(a).toEqual(b);
  }, 60_000);

  // ⚠️ 最关键的一个断言：Argon2id 的盐是 SHA-256(邮箱)，不是邮箱原文。
  // 用同一个 argon2id 库独立复算两条路径，断言实现走的是「盐先哈希」那条。
  // 若有人把 sha256() 去掉，这里会立刻变红。
  it('salts with SHA-256(email), not the raw email', async () => {
    const email = 'user@example.com';
    const emailSalt = utf8Encode(email);
    const shared = {
      password: utf8Encode('pw'),
      parallelism: 4, iterations: 3,
      memorySize: 64 * 1024,          // 64 MiB → KiB
      hashLength: 32, outputType: 'binary',
    } as const;

    const withHashedSalt = await argon2id({ ...shared, salt: await sha256(emailSalt) });
    const withRawSalt = await argon2id({ ...shared, salt: emailSalt });

    // 先确认两条路径确实不同 —— 否则这个测试证明不了任何事
    expect(withHashedSalt).not.toEqual(withRawSalt);

    const actual = await deriveMasterKey('pw', email, {
      kdf: KDF_TYPE_ARGON2ID, iterations: 3, memory: 64, parallelism: 4,
    });
    expect(actual).toEqual(withHashedSalt);
  }, 60_000);
});

describe('hashMasterPassword', () => {
  it('is base64 of 32 bytes', async () => {
    const mk = new Uint8Array(32).fill(7);
    const hash = await hashMasterPassword(mk, 'password123');
    expect(Buffer.from(hash, 'base64')).toHaveLength(32);
  });

  it('differs from the master key itself', async () => {
    const mk = await deriveMasterKey('password123', 'user@example.com', { kdf: KDF_TYPE_PBKDF2, iterations: 1000 });
    expect(await hashMasterPassword(mk, 'password123')).not.toBe(toBase64(mk));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/kdf.test.ts`
Expected: FAIL —— 无法解析模块 `./kdf`

- [ ] **Step 3: 实现 `packages/crypto/src/kdf.ts`**

```ts
import { argon2id, pbkdf2 } from 'hash-wasm';
import { toBase64, utf8Encode, sha256 } from './bytes';

export const KDF_TYPE_PBKDF2 = 0;
export const KDF_TYPE_ARGON2ID = 1;

export type KdfConfig =
  | { kdf: typeof KDF_TYPE_PBKDF2; iterations: number }
  | { kdf: typeof KDF_TYPE_ARGON2ID; iterations: number; memory: number; parallelism: number };

/**
 * Bitwarden 服务端返回的 KdfMemory 单位（MiB）→ hash-wasm 期望的 KiB。
 * 已由 bitwarden/sdk-internal 源码确认：`let memory = memory.get() * 1024; // Convert MiB to KiB`
 */
const ARGON2_MEMORY_UNIT_MULTIPLIER = 1024;

/**
 * masterKey = KDF(password, salt)
 *
 * ⚠️ **两种 KDF 的盐不同，这是最容易踩且最难排查的坑：**
 *   - PBKDF2   → 盐 = lowercase(trim(email)) 原文
 *   - Argon2id → 盐 = **SHA-256(lowercase(trim(email)))**，即先把邮箱哈希一次
 *
 * 官方实现（`bitwarden-crypto/src/keys/kdf.rs`）对 Argon2 分支显式做了
 * `Sha256::new().chain_update(salt).finalize()`。搞错的话：PBKDF2 账户一切正常，
 * Argon2id 账户永远提示「密码错误」，且没有任何线索指向盐。
 */
export async function deriveMasterKey(
  password: string,
  email: string,
  kdf: KdfConfig,
): Promise<Uint8Array> {
  const emailSalt = utf8Encode(email.trim().toLowerCase());
  const pw = utf8Encode(password);

  switch (kdf.kdf) {
    case KDF_TYPE_PBKDF2:
      return pbkdf2({
        password: pw, salt: emailSalt, iterations: kdf.iterations, hashLength: 32, hashFunction: 'sha256',
      });

    case KDF_TYPE_ARGON2ID:
      return argon2id({
        password: pw,
        salt: await sha256(emailSalt),   // ← 注意：盐先被 SHA-256 了一次
        parallelism: kdf.parallelism,
        iterations: kdf.iterations,
        memorySize: kdf.memory * ARGON2_MEMORY_UNIT_MULTIPLIER,
        hashLength: 32,
        outputType: 'binary',
      });

    default:
      throw new Error(`Unsupported KDF type: ${(kdf as { kdf: number }).kdf}`);
  }
}

/**
 * masterPasswordHash = base64(PBKDF2-SHA256(masterKey, password, 1 iteration))
 * 发送给服务端做认证。主密码本身永不离开设备。
 */
export async function hashMasterPassword(masterKey: Uint8Array, password: string): Promise<string> {
  const hash = await pbkdf2({
    password: masterKey,
    salt: utf8Encode(password),
    iterations: 1,
    hashLength: 32,
    hashFunction: 'sha256',
  });
  return toBase64(hash);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/kdf.test.ts`
Expected: PASS。首次运行后 `toMatchInlineSnapshot()` 会自动写入快照 —— 检查写入的 base64 值确实是 32 字节密钥的 base64（44 字符、以 `=` 结尾）

- [ ] **Step 5: 交叉验证 PBKDF2 结果与非本实现的独立来源一致**

用 Python 独立算一遍，确认我们的 PBKDF2 实现没有偏移：

```bash
python3 -c "
import hashlib, base64
email='user@example.com'; pw='password123'
mk=hashlib.pbkdf2_hmac('sha256', pw.encode(), email.encode(), 600000, 32)
print('masterKey  =', base64.b64encode(mk).decode())
print('mpHash     =', base64.b64encode(hashlib.pbkdf2_hmac('sha256', mk, pw.encode(), 1, 32)).decode())
"
```

Expected: 两个值与 Node 侧算出的完全一致。**不一致就是实现有 bug，必须在这里解决，不要往下走。**

- [ ] **Step 6: 验证 Argon2id 单位（关键）**

用官方 Bitwarden CLI 创建一个 **Argon2id** 账户，再用本实现登录，确认单位假设正确。若此时 CLI 尚未安装，记录为待办，在 Task 10 一并完成 —— **但绝不允许跳过**。

```bash
# 安装官方 CLI（作为密码学的参照实现）
bun add -g @bitwarden/cli
bw config server http://127.0.0.1:8080
# 注册时选择 Argon2id，然后：
bw login            # 若本实现派生的 masterKey 错误，这里会返回「用户名或密码错误」
```

- [ ] **Step 7: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add Bitwarden KDF (PBKDF2 + Argon2id) and master password hashing"
```

---

## Task 5: EncString 编解码 + AES-256-CBC + HMAC-SHA256

**Files:**
- Create: `packages/crypto/src/encstring.ts`
- Test: `packages/crypto/src/encstring.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`
- Produces:
  - `type EncString = string`
  - `EncryptionType = { AesCbc256_B64: 0; AesCbc128_HmacSha256_B64: 1; AesCbc256_HmacSha256_B64: 2; Rsa2048_OaepSha256_B64: 3; Rsa2048_OaepSha1_B64: 4; Rsa2048_OaepSha256_HmacSha256_B64: 5; Rsa2048_OaepSha1_HmacSha256_B64: 6 }`
  - `parseEncString(s: EncString): { type: number; iv?: Uint8Array; data: Uint8Array; mac?: Uint8Array }`
  - `serializeEncString(type: number, iv: Uint8Array | undefined, data: Uint8Array, mac?: Uint8Array): EncString`
  - `class DecryptError extends Error { readonly kind: 'malformed' | 'macMismatch' | 'unsupportedType' }`
  - `aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>`
  - `aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>`
  - `hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>`

> **关键陷阱**：解析时分隔符必须从**第一个** `.` 和前**两个** `|` 处切分。若用 `split('.')` 或 `split('|')` 取全部，密文内容里恰好出现分隔符时（base64 标准字母表含 `+` `/` `=`，不含 `.` 和 `|`，所以实际安全，但**长度校验和段数校验必须严格**，否则畸形输入会被静默接受）。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/encstring.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  parseEncString, serializeEncString, DecryptError,
  aesCbcEncrypt, aesCbcDecrypt, hmacSha256,
} from './encstring';
import { fromBase64, toBase64, utf8Encode, utf8Decode } from './bytes';

describe('EncString parsing', () => {
  it('parses a type-2 string', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    const p = parseEncString(s);
    expect(p.type).toBe(2);
    expect(p.iv).toHaveLength(16);
    expect(p.data).toHaveLength(8);
    expect(p.mac).toHaveLength(32);
  });

  it('parses a type-0 string with no MAC segment', () => {
    const s = `0.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(4))}`;
    const p = parseEncString(s);
    expect(p.type).toBe(0);
    expect(p.mac).toBeUndefined();
  });

  it('parses a type-4 string (RSA, no IV)', () => {
    const p = parseEncString(`4.${toBase64(new Uint8Array(256))}`);
    expect(p.type).toBe(4);
    expect(p.iv).toBeUndefined();
    expect(p.data).toHaveLength(256);
  });

  it('round-trips through serialize', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    const p = parseEncString(s);
    expect(serializeEncString(p.type, p.iv, p.data, p.mac)).toBe(s);
  });

  it('throws DecryptError(malformed) on a missing separator', () => {
    try { parseEncString('2.abc'); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).kind).toBe('malformed');
    }
  });

  it('throws DecryptError(malformed) on a non-numeric type', () => {
    expect(() => parseEncString('x.a|b')).toThrow(DecryptError);
  });

  it('throws DecryptError(malformed) on wrong IV length', () => {
    const s = `2.${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(32))}`;
    try { parseEncString(s); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('malformed'); }
  });

  it('throws DecryptError(malformed) on wrong MAC length', () => {
    const s = `2.${toBase64(new Uint8Array(16))}|${toBase64(new Uint8Array(8))}|${toBase64(new Uint8Array(16))}`;
    try { parseEncString(s); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('malformed'); }
  });
});

describe('AES-CBC + HMAC primitives', () => {
  it('round-trips through AES-256-CBC with PKCS#7 padding', async () => {
    const key = new Uint8Array(32).fill(1);
    const iv = new Uint8Array(16).fill(2);
    const pt = utf8Encode('hello world');
    const ct = await aesCbcEncrypt(key, iv, pt);
    expect(ct.length % 16).toBe(0);
    expect(utf8Decode(await aesCbcDecrypt(key, iv, ct))).toBe('hello world');
  });

  it('round-trips an empty plaintext', async () => {
    const key = new Uint8Array(32).fill(1), iv = new Uint8Array(16).fill(2);
    const ct = await aesCbcEncrypt(key, iv, new Uint8Array(0));
    expect(await aesCbcDecrypt(key, iv, ct)).toEqual(new Uint8Array(0));
  });

  it('round-trips Chinese text', async () => {
    const key = new Uint8Array(32).fill(1), iv = new Uint8Array(16).fill(2);
    const pt = utf8Encode('我的密码🔐 与中文');
    expect(utf8Decode(await aesCbcDecrypt(key, iv, await aesCbcEncrypt(key, iv, pt)))).toBe('我的密码🔐 与中文');
  });

  it('computes HMAC-SHA256 correctly (RFC 4231 test case 1)', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const mac = await hmacSha256(key, utf8Encode('Hi There'));
    expect(toBase64(mac)).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/encstring.test.ts`
Expected: FAIL —— 无法解析模块 `./encstring`

- [ ] **Step 3: 实现 `packages/crypto/src/encstring.ts`**

```ts
import { fromBase64, toBase64 } from './bytes';

export const EncryptionType = {
  AesCbc256_B64: 0,
  AesCbc128_HmacSha256_B64: 1,
  AesCbc256_HmacSha256_B64: 2,
  Rsa2048_OaepSha256_B64: 3,
  Rsa2048_OaepSha1_B64: 4,
  Rsa2048_OaepSha256_HmacSha256_B64: 5,
  Rsa2048_OaepSha1_HmacSha256_B64: 6,
} as const;

export type EncString = string;

export class DecryptError extends Error {
  constructor(readonly kind: 'malformed' | 'macMismatch' | 'unsupportedType', message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

export interface ParsedEncString {
  type: number;
  iv: Uint8Array | undefined;
  data: Uint8Array;
  mac: Uint8Array | undefined;
}

/** 各类型的固定分段长度。用于严格校验，畸形输入绝不静默通过。 */
const SHAPE: Record<number, { iv: number; mac: number }> = {
  0: { iv: 16, mac: 0 },
  1: { iv: 16, mac: 32 },
  2: { iv: 16, mac: 32 },
  3: { iv: 0, mac: 0 },
  4: { iv: 0, mac: 0 },
  5: { iv: 0, mac: 32 },
  6: { iv: 0, mac: 32 },
};

export function parseEncString(s: EncString): ParsedEncString {
  const dot = s.indexOf('.');
  if (dot <= 0) throw new DecryptError('malformed', 'EncString 缺少类型前缀');

  const type = Number(s.slice(0, dot));
  if (!Number.isInteger(type) || !(type in SHAPE)) {
    throw new DecryptError('unsupportedType', `未知的加密类型: ${s.slice(0, dot)}`);
  }
  const shape = SHAPE[type]!;
  const body = s.slice(dot + 1);
  // 段数 = (有 IV ? 1 : 0) + 1(数据段) + (有 MAC ? 1 : 0)
  // 注意 type 0 是 iv|data 两段（无 MAC），不是三段
  const expectedSegments = (shape.iv > 0 ? 1 : 0) + 1 + (shape.mac > 0 ? 1 : 0);
  const segments = body.split('|');
  if (segments.length !== expectedSegments) {
    throw new DecryptError('malformed', `类型 ${type} 期望 ${expectedSegments} 段，实际 ${segments.length} 段`);
  }

  let iv: Uint8Array | undefined;
  let data: Uint8Array;
  let mac: Uint8Array | undefined;

  if (shape.iv > 0) {
    iv = fromBase64(segments[0]!);
    if (iv.length !== shape.iv) throw new DecryptError('malformed', `IV 长度应为 ${shape.iv}，实际 ${iv.length}`);
    data = fromBase64(segments[1]!);
    if (shape.mac > 0) {
      mac = fromBase64(segments[2]!);
      if (mac.length !== shape.mac) throw new DecryptError('malformed', `MAC 长度应为 ${shape.mac}，实际 ${mac.length}`);
    }
  } else {
    data = fromBase64(segments[0]!);
    if (shape.mac > 0) {
      mac = fromBase64(segments[1]!);
      if (mac.length !== shape.mac) throw new DecryptError('malformed', `MAC 长度应为 ${shape.mac}，实际 ${mac.length}`);
    }
  }

  if (data.length === 0) throw new DecryptError('malformed', '密文数据为空');
  return { type, iv, data, mac };
}

export function serializeEncString(
  type: number, iv: Uint8Array | undefined, data: Uint8Array, mac?: Uint8Array,
): EncString {
  const parts = [iv ? toBase64(iv) : undefined, toBase64(data), mac ? toBase64(mac) : undefined]
    .filter((p): p is string => p !== undefined);
  return `${type}.${parts.join('|')}`;
}

// —— 底层算法 ——

async function importAesKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-CBC' }, false, [usage]);
}

async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

export async function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(key, 'encrypt');
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, plaintext as BufferSource);
  return new Uint8Array(ct);
}

export async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new DecryptError('malformed', `密文长度 ${ciphertext.length} 不是 16 的倍数`);
  }
  const k = await importAesKey(key, 'decrypt');
  try {
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, ciphertext as BufferSource);
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError('malformed', 'AES-CBC 解密失败（填充错误）');
  }
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await importHmacKey(key);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, data as BufferSource));
}
```

> **不要在这里转出 `bytes.ts` 的符号**：`index.ts` 用 `export *` 聚合所有模块，
> 两个模块导出同名符号会造成歧义导出（TS 报错），且这些符号在 `keys.ts` 里才用到。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/encstring.test.ts`
Expected: PASS（全部 12 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add EncString codec and AES-CBC/HMAC-SHA256 primitives"
```

---

## Task 6: 密钥层级（拉伸主密钥 / 用户密钥 / 对称加解密）

**Files:**
- Create: `packages/crypto/src/keys.ts`
- Test: `packages/crypto/src/keys.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`、`encstring.ts`
- Produces:
  - `interface SymmetricKey { encKey: Uint8Array; macKey: Uint8Array }`
  - `stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey>` — HKDF-Expand-SHA256，info `"enc"` / `"mac"`，各 32 字节
  - `makeUserKey(): SymmetricKey` — 随机 64 字节（32 enc + 32 mac）
  - `encryptString(plain: string, key: SymmetricKey): Promise<EncString>`
  - `decryptString(enc: EncString, key: SymmetricKey): Promise<string>`
  - `encryptBytes(data: Uint8Array, key: SymmetricKey): Promise<EncString>`
  - `decryptBytes(enc: EncString, key: SymmetricKey): Promise<Uint8Array>`
  - `zeroizeKey(key: SymmetricKey): void`

> ⚠️ **WebCrypto 的 HKDF 不能直接用**：`subtle.deriveBits` 的 HKDF 实现是 Extract-then-Expand，而 Bitwarden 需要的是**只用 Expand**（把 masterKey 直接当作 PRK）。故 Step 3 手写 HKDF-Expand：`T(1) = HMAC-SHA256(masterKey, info || 0x01)`。输出 32 字节时只需一轮。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/keys.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  stretchMasterKey, makeUserKey, encryptString, decryptString,
  encryptBytes, decryptBytes, zeroizeKey,
} from './keys';
import { toBase64, utf8Encode, utf8Decode, fromBase64 } from './bytes';
import { DecryptError } from './encstring';

describe('stretchMasterKey', () => {
  it('produces 32-byte enc and mac keys', async () => {
    const k = await stretchMasterKey(new Uint8Array(32).fill(9));
    expect(k.encKey).toHaveLength(32);
    expect(k.macKey).toHaveLength(32);
  });

  it('is deterministic', async () => {
    const mk = new Uint8Array(32).fill(9);
    const a = await stretchMasterKey(mk), b = await stretchMasterKey(mk);
    expect(a.encKey).toEqual(b.encKey);
    expect(a.macKey).toEqual(b.macKey);
  });

  it('produces different enc and mac keys (info string separation)', async () => {
    const k = await stretchMasterKey(new Uint8Array(32).fill(9));
    expect(k.encKey).not.toEqual(k.macKey);
  });

  it('matches the HKDF-Expand definition', async () => {
    // 独立复算 T(1) = HMAC-SHA256(PRK, "enc" || 0x01)
    const mk = new Uint8Array(32).fill(9);
    const hmacKey = await crypto.subtle.importKey('raw', mk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const info = new Uint8Array([...utf8Encode('enc'), 0x01]);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, info));
    expect((await stretchMasterKey(mk)).encKey).toEqual(expected);
  });

  // 🔑 官方测试向量 —— 唯一的「外部权威答案」。
  // 来源：bitwarden/sdk-internal, crates/bitwarden-crypto/src/keys/utils.rs::test_stretch_kdf_key
  // 这一条能同时抓住：HMAC 用错、info 串写错、enc/mac 顺序颠倒、
  // 以及最阴险的「误用 WebCrypto 的 extract+expand HKDF」（那样两个值都会不同）。
  it('matches the official stretch_key test vector', async () => {
    const masterKey = fromHex('1f4f68e29647b15ac250acd1118184518aa745a7fe95021b27c5402a16c3564b');
    const k = await stretchMasterKey(masterKey);
    expect(toHex(k.encKey)).toBe('6f1fb22dee9825728fd77c5387adc3178e8678f93d84a3b671c5bdccbc15ed60');
    expect(toHex(k.macKey)).toBe('dd7fceea651bca265634221c4e1cb910303d7fa6d1f7c257e81a3055c1f9b39b');
  });
});

// 测试辅助
function fromHex(s: string): Uint8Array {
  return new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
}
function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('makeUserKey', () => {
  it('produces 32-byte keys and is random per call', () => {
    const a = makeUserKey(), b = makeUserKey();
    expect(a.encKey).toHaveLength(32);
    expect(a.macKey).toHaveLength(32);
    expect(a.encKey).not.toEqual(b.encKey);
  });
});

describe('symmetric encrypt/decrypt', () => {
  const key = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

  it('round-trips a string as a type-2 EncString', async () => {
    const enc = await encryptString('hello', key);
    expect(enc.startsWith('2.')).toBe(true);
    expect(await decryptString(enc, key)).toBe('hello');
  });

  it('round-trips an empty string', async () => {
    expect(await decryptString(await encryptString('', key), key)).toBe('');
  });

  it('round-trips Chinese text and emoji', async () => {
    const s = '我的密码🔐!@#$%^&*()';
    expect(await decryptString(await encryptString(s, key), key)).toBe(s);
  });

  it('round-trips a long string', async () => {
    const s = 'x'.repeat(100_000);
    expect(await decryptString(await encryptString(s, key), key)).toBe(s);
  });

  it('uses a fresh IV every time (no deterministic ciphertext)', async () => {
    expect(await encryptString('same', key)).not.toBe(await encryptString('same', key));
  });

  it('round-trips raw bytes', async () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
    expect(await decryptBytes(await encryptBytes(data, key), key)).toEqual(data);
  });

  it('throws macMismatch when the ciphertext is tampered with', async () => {
    const enc = await encryptString('hello', key);
    const [type, rest] = enc.split('.') as [string, string];
    const [iv, ct, mac] = rest.split('|') as [string, string, string];
    const ctBytes = fromBase64(ct); ctBytes[0]! ^= 0x01;
    const tampered = `${type}.${iv}|${toBase64(ctBytes)}|${mac}`;
    try { await decryptString(tampered, key); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('macMismatch'); }
  });

  it('throws macMismatch when the MAC is tampered with', async () => {
    const enc = await encryptString('hello', key);
    const [type, rest] = enc.split('.') as [string, string];
    const [iv, ct, mac] = rest.split('|') as [string, string, string];
    const macBytes = fromBase64(mac); macBytes[0]! ^= 0x01;
    const tampered = `${type}.${iv}|${ct}|${toBase64(macBytes)}`;
    try { await decryptString(tampered, key); expect.unreachable(); }
    catch (e) { expect((e as DecryptError).kind).toBe('macMismatch'); }
  });

  it('throws macMismatch when the IV is swapped', async () => {
    const key2 = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(3) };
    const enc = await encryptString('hello', key);
    await expect(decryptString(enc, key2)).rejects.toBeInstanceOf(DecryptError);
  });

  it('never returns a plaintext-shaped string on MAC failure', async () => {
    const wrong = { encKey: new Uint8Array(32).fill(9), macKey: new Uint8Array(32).fill(9) };
    await expect(decryptString(await encryptString('secret', key), wrong)).rejects.toThrow();
  });
});

describe('zeroizeKey', () => {
  it('overwrites both key buffers', () => {
    const k = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };
    zeroizeKey(k);
    expect(k.encKey).toEqual(new Uint8Array(32));
    expect(k.macKey).toEqual(new Uint8Array(32));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/keys.test.ts`
Expected: FAIL —— 无法解析模块 `./keys`

- [ ] **Step 3: 实现 `packages/crypto/src/keys.ts`**

```ts
import {
  concatBytes, constantTimeEqual, randomBytes, utf8Encode, utf8Decode, zeroize,
} from './bytes';
import {
  EncryptionType, DecryptError, parseEncString, serializeEncString,
  aesCbcEncrypt, aesCbcDecrypt, hmacSha256,
} from './encstring';

export interface SymmetricKey {
  encKey: Uint8Array;
  macKey: Uint8Array;
}

/**
 * HKDF-Expand-SHA256，只做 Expand 不做 Extract
 * （masterKey 直接作为 PRK —— 这正是 Bitwarden 的语义，
 *   而 WebCrypto 的 HKDF 会先做 Extract，所以不能直接用）。
 * 输出 32 字节只需一轮：T(1) = HMAC-SHA256(PRK, info || 0x01)
 */
async function hkdfExpand(prk: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const infoBytes = utf8Encode(info);
  let okm = new Uint8Array(0);
  let prev = new Uint8Array(0);
  for (let counter = 1; okm.length < length; counter++) {
    prev = await hmacSha256(prk, concatBytes(prev, infoBytes, new Uint8Array([counter])));
    okm = concatBytes(okm, prev);
  }
  return okm.slice(0, length);
}

export async function stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey> {
  const [encKey, macKey] = await Promise.all([
    hkdfExpand(masterKey, 'enc', 32),
    hkdfExpand(masterKey, 'mac', 32),
  ]);
  return { encKey, macKey };
}

export function makeUserKey(): SymmetricKey {
  return { encKey: randomBytes(32), macKey: randomBytes(32) };
}

export function zeroizeKey(key: SymmetricKey): void {
  zeroize(key.encKey);
  zeroize(key.macKey);
}

/** 用 type-2（AesCbc256_HmacSha256_B64）加密任意字节：encrypt-then-MAC */
export async function encryptBytes(data: Uint8Array, key: SymmetricKey): Promise<string> {
  const iv = randomBytes(16);
  const ct = await aesCbcEncrypt(key.encKey, iv, data);
  const mac = await hmacSha256(key.macKey, concatBytes(iv, ct));
  return serializeEncString(EncryptionType.AesCbc256_HmacSha256_B64, iv, ct, mac);
}

export async function decryptBytes(enc: string, key: SymmetricKey): Promise<Uint8Array> {
  const parsed = parseEncString(enc);
  if (parsed.type !== EncryptionType.AesCbc256_HmacSha256_B64) {
    throw new DecryptError('unsupportedType', `对称解密只支持类型 2，收到类型 ${parsed.type}`);
  }
  const { iv, data, mac } = parsed as { iv: Uint8Array; data: Uint8Array; mac: Uint8Array };

  // 先验 MAC，再解密（encrypt-then-MAC）
  const expected = await hmacSha256(key.macKey, concatBytes(iv, data));
  if (!constantTimeEqual(expected, mac)) {
    throw new DecryptError('macMismatch', 'MAC 校验失败：数据可能被篡改，或密钥不匹配');
  }
  return aesCbcDecrypt(key.encKey, iv, data);
}

export async function encryptString(plain: string, key: SymmetricKey): Promise<string> {
  return encryptBytes(utf8Encode(plain), key);
}

export async function decryptString(enc: string, key: SymmetricKey): Promise<string> {
  return utf8Decode(await decryptBytes(enc, key));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/keys.test.ts`
Expected: PASS（全部 15 个用例）

- [ ] **Step 5: 创建 `packages/crypto/src/index.ts` 导出全部公开 API**

```ts
export * from './bytes';
export * from './kdf';
export * from './encstring';
export * from './keys';
```

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `bun run test && bun run typecheck`
Expected: 全部 PASS，无类型错误

- [ ] **Step 7: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add key hierarchy with HKDF-Expand and symmetric encryption"
```

---

## Task 7: RSA-2048 私钥解密（OAEP）

**Files:**
- Create: `packages/crypto/src/rsa.ts`
- Test: `packages/crypto/src/rsa.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`、`encstring.ts`
- Produces:
  - `decryptWithPrivateKey(enc: EncString, privateKeyDer: Uint8Array): Promise<Uint8Array>`
  - `encryptWithPublicKey(data: Uint8Array, publicKeyDer: Uint8Array): Promise<EncString>`

> Bitwarden 的 RSA 公钥/私钥是 **DER 编码的 PKCS#8（私钥）/ SPKI（公钥）**，类型 4 = OAEP-SHA1，类型 3 = OAEP-SHA256。个人版大部分场景用不到（无组织共享），但**协议要求能解出私钥**，且部分服务器在登录响应里就要求处理它。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/rsa.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { decryptWithPrivateKey, encryptWithPublicKey } from './rsa';
import { DecryptError } from './encstring';
import { toBase64, utf8Decode, utf8Encode } from './bytes';

async function makeKeyPair() {
  const kp = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1',
    },
    true, ['encrypt', 'decrypt'],
  ) as CryptoKeyPair;
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { priv, pub };
}

describe('RSA-OAEP', () => {
  it('round-trips data encrypted with the public key (type 4, SHA-1)', async () => {
    const { priv, pub } = await makeKeyPair();
    const enc = await encryptWithPublicKey(utf8Encode('user-key-material'), pub);
    expect(enc.startsWith('4.')).toBe(true);
    expect(utf8Decode(await decryptWithPrivateKey(enc, priv))).toBe('user-key-material');
  }, 30_000);

  it('throws DecryptError on a malformed RSA EncString', async () => {
    const { priv } = await makeKeyPair();
    await expect(decryptWithPrivateKey('4.!!!not-base64!!!', priv)).rejects.toBeInstanceOf(DecryptError);
  }, 30_000);

  it('throws DecryptError when the wrong private key is used', async () => {
    const a = await makeKeyPair(), b = await makeKeyPair();
    const enc = await encryptWithPublicKey(utf8Encode('secret'), a.pub);
    await expect(decryptWithPrivateKey(enc, b.priv)).rejects.toBeInstanceOf(DecryptError);
  }, 60_000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/rsa.test.ts`
Expected: FAIL —— 无法解析模块 `./rsa`

- [ ] **Step 3: 实现 `packages/crypto/src/rsa.ts`**

```ts
import { DecryptError, parseEncString, serializeEncString, EncryptionType } from './encstring';

async function importPrivateKey(der: Uint8Array, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey> {
  try {
    return await globalThis.crypto.subtle.importKey(
      'pkcs8', der as BufferSource, { name: 'RSA-OAEP', hash }, false, ['decrypt'],
    );
  } catch {
    throw new DecryptError('malformed', '私钥导入失败：不是合法的 PKCS#8 DER');
  }
}

async function importPublicKey(der: Uint8Array, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey> {
  try {
    return await globalThis.crypto.subtle.importKey(
      'spki', der as BufferSource, { name: 'RSA-OAEP', hash }, false, ['encrypt'],
    );
  } catch {
    throw new DecryptError('malformed', '公钥导入失败：不是合法的 SPKI DER');
  }
}

export async function decryptWithPrivateKey(enc: string, privateKeyDer: Uint8Array): Promise<Uint8Array> {
  const parsed = parseEncString(enc);
  const hash = parsed.type === EncryptionType.Rsa2048_OaepSha1_B64
    || parsed.type === EncryptionType.Rsa2048_OaepSha1_HmacSha256_B64
    ? 'SHA-1' : 'SHA-256';

  if (parsed.type !== EncryptionType.Rsa2048_OaepSha1_B64
    && parsed.type !== EncryptionType.Rsa2048_OaepSha256_B64
    && parsed.type !== EncryptionType.Rsa2048_OaepSha1_HmacSha256_B64
    && parsed.type !== EncryptionType.Rsa2048_OaepSha256_HmacSha256_B64) {
    throw new DecryptError('unsupportedType', `不是 RSA 类型: ${parsed.type}`);
  }

  const key = await importPrivateKey(privateKeyDer, hash);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, parsed.data as BufferSource));
  } catch {
    throw new DecryptError('malformed', 'RSA 解密失败（密钥不匹配或数据损坏）');
  }
}

/** 用类型 4（OAEP-SHA1）加密 —— 老客户端默认期望的格式 */
export async function encryptWithPublicKey(data: Uint8Array, publicKeyDer: Uint8Array): Promise<string> {
  const key = await importPublicKey(publicKeyDer, 'SHA-1');
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, data as BufferSource));
  return serializeEncString(EncryptionType.Rsa2048_OaepSha1_B64, undefined, ct);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/rsa.test.ts`
Expected: PASS（3 个用例；RSA 生成较慢，属正常）

- [ ] **Step 5: 更新 `packages/crypto/src/index.ts` 追加导出**

```ts
export * from './rsa';
```

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add RSA-2048 OAEP key wrapping"
```

---

## Task 8: TOTP 生成（RFC 6238）

**Files:**
- Create: `packages/crypto/src/totp.ts`
- Test: `packages/crypto/src/totp.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`、`encstring.ts` 的 `hmacSha256`
- Produces:
  - `interface TotpOptions { digits?: number; period?: number; algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512' }`
  - `type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'`
  - `generateTotp(secretOrUri: string, at?: number, opts?: TotpOptions): Promise<{ code: string; period: number; remaining: number }>` —— 接受裸 base32 / `otpauth://` / `steam://` 三种形态
  - `parseOtpauthUri(uri: string): { secret: string; digits: number; period: number; algorithm: TotpAlgorithm; issuer: string | undefined; account: string | undefined; isSteam: boolean }`
  - `base32Decode(s: string): Uint8Array`

> **用途**：`login.totp` 字段存的是加密的 URI。用户从 GitHub 等处拿到的是 `otpauth://` 形式。
> **Steam 特例**：字面量 `steam://<base32>` 前缀 → 自定义字母表 `23456789BCDFGHJKMNPQRTVWXY`、5 位、30 秒。
> 官方实现**只**认这个前缀；`otpauth://totp/Steam:...` 会被当成普通 TOTP。我们跟随官方，
> 否则同一条目我们算出 5 位、官方客户端算出 6 位。
> **base32 不是标准实现**：非法字符被丢弃而非报错，见实现处的说明。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/totp.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generateTotp, parseOtpauthUri, base32Decode } from './totp';

// RFC 6238 附录 B 的官方测试向量。
// 密钥 "12345678901234567890" 的 base32 编码：
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32Decode', () => {
  it('decodes the RFC 6238 secret to ASCII digits', () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe('12345678901234567890');
  });

  // 官方单元测试向量 —— 来源：bitwarden-vault/src/totp.rs
  it('matches the official decode vectors', () => {
    expect([...base32Decode('ABCD123')]).toEqual([0, 68, 61]);
    expect([...base32Decode('WQIQ25BRKZYCJVYP')])
      .toEqual([180, 17, 13, 116, 49, 86, 112, 36, 215, 15]);
  });

  it('silently drops characters outside the alphabet', () => {
    // '1'、'!'、'=' 都不在字母表里，会被丢掉 —— 官方行为就是如此，不是 bug
    expect(base32Decode('PIUD1IS!EQYA=')).toEqual(base32Decode('PIUDISEQYA'));
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq=='))
      .toEqual(base32Decode(RFC_SECRET));
  });

  it('is case-insensitive', () => {
    expect(base32Decode('wqiq25brkzycjvyp')).toEqual(base32Decode('WQIQ25BRKZYCJVYP'));
  });
});

describe('generateTotp — RFC 6238 官方测试向量 (SHA-1, 8 位)', () => {
  const cases: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [time, expected] of cases) {
    it(`T=${time} → ${expected}`, async () => {
      const { code } = await generateTotp(RFC_SECRET, time * 1000, { digits: 8 });
      expect(code).toBe(expected);
    });
  }
});

describe('generateTotp — 6 位（默认）', () => {
  it('uses the last 6 digits of the 8-digit value', async () => {
    // 6 位与 8 位是同一个动态截断结果的不同取模，故取后 6 位
    expect((await generateTotp(RFC_SECRET, 59_000)).code).toBe('287082');
    expect((await generateTotp(RFC_SECRET, 1111111109_000)).code).toBe('081804');
    expect((await generateTotp(RFC_SECRET, 1234567890_000)).code).toBe('005924');
  });

  it('reports the seconds remaining in the current window', async () => {
    const r = await generateTotp(RFC_SECRET, 60_000); // 窗口 [60,90)，剩 30 秒
    expect(r.period).toBe(30);
    expect(r.remaining).toBe(30);
  });

  it('pads codes shorter than the digit count with leading zeros', async () => {
    expect((await generateTotp(RFC_SECRET, 1234567890_000)).code).toHaveLength(6);
  });
});

describe('generateTotp — SHA-256 / SHA-512 (RFC 6238 向量)', () => {
  it('SHA-256, T=59 → 46119246', async () => {
    const s = base32Encode(new TextEncoder().encode('12345678901234567890123456789012'));
    expect((await generateTotp(s, 59_000, { digits: 8, algorithm: 'SHA-256' })).code).toBe('46119246');
  });
});

// 🔑 官方 Bitwarden 测试向量 —— 覆盖裸 base32 / 小写 / 含非法字符 / steam:// / 前导零补齐
// 来源：bitwarden-vault/src/totp.rs 的单元测试
describe('generateTotp — 官方 Bitwarden 测试向量', () => {
  const T = Date.UTC(2023, 0, 1); // 2023-01-01T00:00:00.000Z

  const cases: Array<[string, string]> = [
    ['WQIQ25BRKZYCJVYP', '194506'],
    ['wqiq25brkzycjvyp', '194506'],
    ['PIUDISEQYA', '829846'],
    ['PIUD1IS!EQYA=', '829846'],
    ['steam://HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ', '7W6CJ'],
    ['steam://ABCD123', 'N26DF'],
    ['HJSGFJHDFDJDJKSDFD', '000034'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, async () => {
      expect((await generateTotp(input, T)).code).toBe(expected);
    });
  }
});

describe('parseOtpauthUri', () => {
  it('parses a standard TOTP URI', () => {
    const u = parseOtpauthUri('otpauth://totp/GitHub:kylin?secret=ABCDEFGH&issuer=GitHub&digits=6&period=30');
    expect(u.secret).toBe('ABCDEFGH');
    expect(u.digits).toBe(6);
    expect(u.period).toBe(30);
    expect(u.issuer).toBe('GitHub');
    expect(u.account).toBe('kylin');
    expect(u.isSteam).toBe(false);
  });

  it('accepts an uppercase scheme and missing options', () => {
    const u = parseOtpauthUri('OTPAUTH://TOTP/x?secret=ABCDEFGH');
    expect(u.digits).toBe(6);
    expect(u.period).toBe(30);
    expect(u.algorithm).toBe('SHA-1');
  });

  it('does NOT infer Steam from an otpauth URI (matches official behaviour)', () => {
    // 官方只用字面量 `steam://` 前缀识别 Steam。跟随官方，
    // 否则同一条目我们算 5 位、官方客户端算 6 位，产生分歧。
    const u = parseOtpauthUri('otpauth://totp/Steam:kylin?secret=ABCDEFGH&encoder=steam');
    expect(u.isSteam).toBe(false);
  });

  it('lowercases the whole URI, so parameter names are case-insensitive', () => {
    const u = parseOtpauthUri('otpauth://totp/x?SECRET=ABCDEFGH&DIGITS=8&PERIOD=60');
    expect(u.secret).toBe('abcdefgh');
    expect(u.digits).toBe(8);
    expect(u.period).toBe(60);
  });

  it('clamps out-of-range digits and period', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=999').digits).toBe(10);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&digits=-5').digits).toBe(0);
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&period=0').period).toBe(1);
  });

  it('falls back to SHA-1 for an unknown algorithm', () => {
    expect(parseOtpauthUri('otpauth://totp/x?secret=AB&algorithm=md5').algorithm).toBe('SHA-1');
  });

  it('rejects a non-totp URI', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow(/otpauth/i);
  });

  it('rejects a URI with no secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/x?issuer=GitHub')).toThrow(/secret/i);
  });
});

// 测试辅助：base32 编码（仅测试用）
function base32Encode(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(acc >> bits) & 31]; }
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/totp.test.ts`
Expected: FAIL —— 无法解析模块 `./totp`

- [ ] **Step 3: 实现 `packages/crypto/src/totp.ts`**

```ts
import { hmacSha256 } from './encstring';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/**
 * ⚠️ Bitwarden 的 base32 解码器**刻意不是标准实现** —— 见 `bitwarden-vault/src/totp.rs`
 * 中 `decode_b32` 的注释原文：「not technically a correct base32 decoder since we
 * filter out various characters, and use exact chunking」。它的实际行为是：
 *   1. 整个字符串转大写
 *   2. **字母表外的字符被静默丢弃**（而不是报错）—— `=`、`-`、空格、`0/1/8/9` 都会被丢掉
 *   3. 每个保留字符出 5 bit
 *   4. 末尾不足 8 位的残余 bit **被丢弃**
 *
 * 结果：`"PIUD1IS!EQYA="` 与 `"PIUDISEQYA"` 必须解出完全相同的值。
 * 如果照抄标准 base32（遇到非法字符就抛错），一部分用户的验证码会直接算不出来。
 */
export function base32Decode(input: string): Uint8Array {
  const kept = input.toUpperCase().split('').filter((c) => BASE32_ALPHABET.includes(c));
  const out = new Uint8Array(Math.floor((kept.length * 5) / 8));
  let acc = 0, bits = 0, o = 0;
  for (const ch of kept) {
    acc = (acc << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 0xff; }
  }
  return out.subarray(0, o); // 末尾残余 bit 自然被丢弃
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

export interface TotpResult {
  code: string;
  period: number;
  remaining: number;
}

export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

/**
 * 生成 TOTP 验证码。`secretOrUri` 支持官方实现的三种输入形态：
 *   - `steam://<base32>`            → Steam Guard（5 位、自定义字母表、强制 SHA-1）
 *   - `otpauth://totp/...?secret=`  → 按 URI 里的参数
 *   - 裸 base32                     → 按 `opts`（默认 6 位 / 30 秒 / SHA-1）
 */
export async function generateTotp(
  secretOrUri: string,
  at: number = Date.now(),
  opts: TotpOptions = {},
): Promise<TotpResult> {
  const lower = secretOrUri.toLowerCase(); // 官方实现先把整个字符串小写再判断前缀

  if (lower.startsWith('steam://')) {
    return computeCode(secretOrUri.slice('steam://'.length), at, {
      digits: 5, period: 30, algorithm: 'SHA-1', steam: true,
    });
  }

  if (lower.startsWith('otpauth://')) {
    const p = parseOtpauthUri(secretOrUri);
    return computeCode(p.secret, at, {
      digits: p.digits, period: p.period, algorithm: p.algorithm, steam: p.isSteam,
    });
  }

  return computeCode(secretOrUri, at, {
    digits: opts.digits ?? 6,
    period: opts.period ?? 30,
    algorithm: opts.algorithm ?? 'SHA-1',
    steam: false,
  });
}

async function computeCode(
  secret: string,
  at: number,
  o: { digits: number; period: number; algorithm: TotpAlgorithm; steam: boolean },
): Promise<TotpResult> {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / o.period);

  // 64 位大端计数（JS 位运算只有 32 位，拆成高低位写入）
  const cb = new Uint8Array(8);
  const dv = new DataView(cb.buffer);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);

  // Steam Guard 强制 SHA-1，忽略 URI 里的 algorithm
  const mac = await hmacWith(o.steam ? 'SHA-1' : o.algorithm, key, cb);

  // 动态截断（RFC 4226 §5.3）
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;

  const code = o.steam
    ? steamCode(binary, o.digits)
    : String(binary % 10 ** o.digits).padStart(o.digits, '0');

  return { code, period: o.period, remaining: o.period - (Math.floor(at / 1000) % o.period) };
}

/** Steam Guard 字母表：从最低位开始取，逐位整除 */
function steamCode(binary: number, digits: number): string {
  let full = binary & 0x7fffffff;
  let out = '';
  for (let i = 0; i < digits; i++) {
    out += STEAM_ALPHABET[full % STEAM_ALPHABET.length]!;
    full = Math.floor(full / STEAM_ALPHABET.length);
  }
  return out;
}

async function hmacWith(alg: TotpAlgorithm, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await globalThis.crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: alg }, false, ['sign'],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, data as BufferSource));
}

export interface ParsedOtpauth {
  secret: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
  issuer: string | undefined;
  account: string | undefined;
  isSteam: boolean;
}

function normaliseAlgorithm(raw: string | null): TotpAlgorithm {
  switch ((raw ?? 'SHA1').toUpperCase()) {
    case 'SHA256': return 'SHA-256';
    case 'SHA512': return 'SHA-512';
    default: return 'SHA-1'; // 未知值回退到 SHA-1（与官方一致）
  }
}

export function parseOtpauthUri(input: string): ParsedOtpauth {
  // 官方实现先把整个字符串小写再解析，因此 `Secret=` 等同于 `secret=`
  const uri = input.toLowerCase();

  let url: URL;
  try { url = new URL(uri); }
  catch { throw new Error(`无法解析 otpauth URI: ${input.slice(0, 40)}`); }

  if (url.protocol !== 'otpauth:') throw new Error('不是 otpauth:// URI');
  if (url.host !== 'totp') throw new Error(`仅支持 totp，收到 ${url.host}`);

  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('otpauth URI 缺少 secret 参数');

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const sep = label.indexOf(':');
  const labelIssuer = sep >= 0 ? label.slice(0, sep) : undefined;
  const labelAccount = sep >= 0 ? label.slice(sep + 1) : label;

  // digits 钳制到 0..10（10**10 会溢出 32 位），period 至少 1
  const digits = Math.min(10, Math.max(0, Number(url.searchParams.get('digits') ?? 6) || 6));
  const period = Math.max(1, Number(url.searchParams.get('period') ?? 30) || 30);

  return {
    secret,
    digits,
    period,
    algorithm: normaliseAlgorithm(url.searchParams.get('algorithm')),
    issuer: url.searchParams.get('issuer') ?? labelIssuer,
    account: labelAccount || undefined,
    // ⚠️ 官方实现**只**通过字面量 `steam://` 前缀识别 Steam，
    // 不会从 `otpauth://totp/Steam:...` 或 `encoder=steam` 推断。
    // 这里保持一致 —— 否则同一条目我们算出 5 位、官方客户端算出 6 位，产生分歧。
    isSteam: false,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/totp.test.ts`
Expected: PASS（全部用例）。若 RFC 向量不通过，说明计数器字节序或动态截断有误 —— **必须修复到通过为止**，这是有官方权威答案的测试

- [ ] **Step 5: 更新 `packages/crypto/src/index.ts` 追加导出**

```ts
export * from './totp';
```

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add RFC 6238 TOTP with Steam Guard and otpauth URI parsing"
```

---

## Task 9: 密码 / 口令生成器

**Files:**
- Create: `packages/crypto/src/generator.ts`
- Test: `packages/crypto/src/generator.test.ts`

**Interfaces:**
- Consumes: `bytes.ts` 的 `randomBytes`
- Produces:
  - `interface PasswordOptions { length?: number; lowercase?: boolean; uppercase?: boolean; digits?: boolean; symbols?: boolean; avoidAmbiguous?: boolean }`
  - `interface PassphraseOptions { words?: number; separator?: string; capitalize?: boolean; includeNumber?: boolean }`
  - `generatePassword(opts?: PasswordOptions): string`
  - `generatePassphrase(opts?: PassphraseOptions): string`
  - `passwordStrength(pw: string): { score: 0|1|2|3|4; entropyBits: number }`
  - `estimateEntropyBits(pw: string, poolSize: number): number`

> ⚠️ **必须用拒绝采样**：`randomByte % poolSize` 会引入模偏差（modulo bias）——池大小不整除 256 时，靠前的字符出现概率更高，实际熵低于理论值。安全产品里这是真实缺陷，不是学术问题。

- [ ] **Step 1: 写失败的测试 `packages/crypto/src/generator.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generatePassword, generatePassphrase, passwordStrength, estimateEntropyBits, POOLS } from './generator';

describe('generatePassword', () => {
  it('honours the requested length', () => {
    expect(generatePassword({ length: 24 })).toHaveLength(24);
    expect(generatePassword({ length: 1 })).toHaveLength(1);
    expect(generatePassword({ length: 128 })).toHaveLength(128);
  });

  it('includes at least one character from every enabled class', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 8, lowercase: true, uppercase: true, digits: true, symbols: true });
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it('only uses enabled classes', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword({ length: 32, lowercase: true, uppercase: false, digits: false, symbols: false }))
        .toMatch(/^[a-z]+$/);
      expect(generatePassword({ length: 32, lowercase: false, uppercase: false, digits: true, symbols: false }))
        .toMatch(/^[0-9]+$/);
    }
  });

  it('excludes ambiguous characters when asked', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassword({ length: 64, avoidAmbiguous: true })).not.toMatch(/[Il1O0o]/);
    }
  });

  it('is non-deterministic across calls', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generatePassword({ length: 32 })));
    expect(seen.size).toBe(20);
  });

  it('rejects a length of 0 or negative', () => {
    expect(() => generatePassword({ length: 0 })).toThrow(/length/i);
    expect(() => generatePassword({ length: -1 })).toThrow(/length/i);
  });

  it('rejects when every class is disabled', () => {
    expect(() => generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }))
      .toThrow(/at least one/i);
  });

  it('rejects a length shorter than the number of enabled classes', () => {
    expect(() => generatePassword({ length: 2, lowercase: true, uppercase: true, digits: true, symbols: true }))
      .toThrow(/length/i);
  });

  // 模偏差回归测试：字符分布应大致均匀。
  // 用拒绝采样时，每个字符的出现频次接近 N/poolSize；
  // 若用 % 取模，靠前的字符会显著偏高。这里用宽松阈值捕获明显的偏差。
  it('has no significant modulo bias across the pool', () => {
    const N = 60_000;
    const pw = generatePassword({ length: N, lowercase: true, uppercase: false, digits: false, symbols: false });
    const counts = new Map<string, number>();
    for (const ch of pw) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const poolSize = POOLS.lowercase.length;
    const expected = N / poolSize;
    for (const [ch, n] of counts) {
      expect(Math.abs(n - expected) / expected, `字符 ${ch} 分布偏差过大`).toBeLessThan(0.15);
    }
  });
});

describe('generatePassphrase', () => {
  it('produces the requested number of words', () => {
    expect(generatePassphrase({ words: 5 }).split('-')).toHaveLength(5);
  });

  it('honours a custom separator', () => {
    expect(generatePassphrase({ words: 4, separator: ' ' }).split(' ')).toHaveLength(4);
  });

  it('capitalises words when asked', () => {
    for (const w of generatePassphrase({ words: 4, capitalize: true }).split('-')) {
      expect(w === String(Number(w)) ? true : w[0]).toMatch(/[A-Z]|^\d$/);
    }
  });

  it('appends a number when asked', () => {
    expect(generatePassphrase({ words: 4, includeNumber: true })).toMatch(/\d/);
  });
});

describe('entropy & strength', () => {
  it('computes entropy from pool size and length', () => {
    // log2(26) * 10 ≈ 47.0
    expect(estimateEntropyBits('a'.repeat(10), 26)).toBeCloseTo(47.0, 0);
  });

  it('scores a long mixed password as the strongest bucket', () => {
    expect(passwordStrength('kJ8#mPq2$vXn9!wZt4&bR').score).toBe(4);
  });

  it('scores a short numeric password as the weakest bucket', () => {
    expect(passwordStrength('1234').score).toBe(0);
  });

  it('scores an empty password as weakest without throwing', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('').entropyBits).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test packages/crypto/src/generator.test.ts`
Expected: FAIL —— 无法解析模块 `./generator`

- [ ] **Step 3: 实现 `packages/crypto/src/generator.ts`**

```ts
import { randomBytes } from './bytes';

export const POOLS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
} as const;

const AMBIGUOUS = /[Il1O0o]/g;

export interface PasswordOptions {
  length?: number;
  lowercase?: boolean;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
  avoidAmbiguous?: boolean;
}

/** 拒绝采样：拒绝落在不完整区间内的字节，消除模偏差 */
function randomIndex(bound: number): number {
  if (bound <= 0 || bound > 256) throw new Error(`randomIndex: bound 必须在 1..256，收到 ${bound}`);
  const limit = 256 - (256 % bound);
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % bound;
  }
}

function buildPool(opts: PasswordOptions): string {
  let pool = '';
  if (opts.lowercase ?? true) pool += POOLS.lowercase;
  if (opts.uppercase ?? true) pool += POOLS.uppercase;
  if (opts.digits ?? true) pool += POOLS.digits;
  if (opts.symbols ?? true) pool += POOLS.symbols;
  if (opts.avoidAmbiguous) pool = pool.replace(AMBIGUOUS, '');
  if (pool.length === 0) throw new Error('至少要启用一类字符');
  return pool;
}

export function generatePassword(opts: PasswordOptions = {}): string {
  const length = opts.length ?? 20;
  if (!Number.isInteger(length) || length < 1) throw new Error(`length 必须是正整数，收到 ${length}`);

  const classes: string[] = [];
  if (opts.lowercase ?? true) classes.push(POOLS.lowercase);
  if (opts.uppercase ?? true) classes.push(POOLS.uppercase);
  if (opts.digits ?? true) classes.push(POOLS.digits);
  if (opts.symbols ?? true) classes.push(POOLS.symbols);

  const filtered = opts.avoidAmbiguous
    ? classes.map((c) => c.replace(AMBIGUOUS, '')).filter((c) => c.length > 0)
    : classes;
  if (filtered.length === 0) throw new Error('至少要启用一类字符');
  if (length < filtered.length) {
    throw new Error(`length (${length}) 不能小于启用的字符类数 (${filtered.length})`);
  }

  const pool = buildPool(opts);
  // 每类先保底一个，保证生成的密码一定满足所选策略
  const chars = filtered.map((c) => c[randomIndex(c.length)]!);
  while (chars.length < length) chars.push(pool[randomIndex(pool.length)]!);

  // Fisher–Yates 洗牌，避免保底字符固定出现在开头
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface PassphraseOptions {
  words?: number;
  separator?: string;
  capitalize?: boolean;
  includeNumber?: boolean;
}

// 精简词表（EFF 风格，易读易拼）。完整版应在后续替换为完整 EFF 长词表。
const WORDS = [
  'amber','anchor','apple','arrow','atlas','autumn','bacon','badge','bamboo','banjo',
  'basil','beacon','beetle','bishop','bison','blossom','boulder','bracket','breeze','bronze',
  'bubble','cactus','camera','candle','canyon','carbon','cargo','cedar','celery','cello',
  'cherry','cobalt','cocoa','comet','copper','coral','cosmos','cotton','crater','cricket',
  'crimson','crystal','cymbal','daisy','dapper','delta','denim','desert','diesel','dolphin',
  'donut','dragon','dynamo','eagle','echo','ember','emerald','engine','fabric','falcon',
  'feather','fennel','ferry','fiddle','fjord','flamingo','flint','forest','fossil','galaxy',
  'garden','ginger','glacier','granite','guitar','harbor','hazel','helmet','hibiscus','honey',
  'hummus','igloo','indigo','island','ivory','jasmine','jigsaw','jungle','kayak','kernel',
  'kettle','kiwi','koala','lantern','lemon','leopard','lilac','limestone','lobster','lotus',
  'lunar','magnet','mango','maple','marble','meadow','melon','meteor','mint','mirror',
  'monsoon','moose','mosaic','mountain','nectar','needle','nickel','noodle','nutmeg','oasis',
  'ocean','olive','onyx','opal','orbit','orchid','otter','oyster','panda','papaya',
  'pebble','pelican','penguin','pepper','petal','piano','pigment','pillow','planet','plum',
  'pollen','poppy','prairie','prism','pumpkin','quartz','quilt','rabbit','radar','raven',
  'ribbon','river','robin','rocket','rosemary','saffron','sailor','salmon','sandal','sapphire',
  'saturn','sauna','scooter','sequoia','shadow','shrimp','silver','sleigh','solar','sparrow',
  'spruce','squash','stellar','stone','sugar','summit','sunset','sushi','syrup','tango',
  'teapot','tempo','thistle','thunder','timber','tomato','topaz','tornado','tortoise','tulip',
  'tundra','turtle','umbrella','unicorn','valley','vanilla','velvet','violet','volcano','walnut',
  'waffle','willow','window','winter','wizard','wombat','yarrow','yogurt','zebra','zenith',
];

export function generatePassphrase(opts: PassphraseOptions = {}): string {
  const count = opts.words ?? 4;
  if (!Number.isInteger(count) || count < 1) throw new Error(`words 必须是正整数，收到 ${count}`);
  const separator = opts.separator ?? '-';

  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = WORDS[randomIndex(WORDS.length)]!;
    if (opts.capitalize) w = w[0]!.toUpperCase() + w.slice(1);
    parts.push(w);
  }
  if (opts.includeNumber) parts.push(String(randomIndex(100)));
  return parts.join(separator);
}

export function estimateEntropyBits(password: string, poolSize: number): number {
  if (password.length === 0 || poolSize <= 1) return 0;
  return password.length * Math.log2(poolSize);
}

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; entropyBits: number } {
  if (pw.length === 0) return { score: 0, entropyBits: 0 };

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  if (pool === 0) pool = 26;

  const entropyBits = estimateEntropyBits(pw, pool);
  const score: 0 | 1 | 2 | 3 | 4 =
    entropyBits < 28 ? 0 : entropyBits < 50 ? 1 : entropyBits < 70 ? 2 : entropyBits < 100 ? 3 : 4;
  return { score, entropyBits };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun run test packages/crypto/src/generator.test.ts`
Expected: PASS（全部用例，含模偏差回归测试）

- [ ] **Step 5: 更新 `packages/crypto/src/index.ts` 追加导出**

```ts
export * from './generator';
```

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `bun run test && bun run typecheck`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): add password/passphrase generator with unbiased sampling"
```

---

## Task 10: 🔑 互操作测试 —— 与官方 Bitwarden CLI 对拍

**Files:**
- Create: `scripts/interop-test.ts`
- Modify: `package.json`（新增 `test:interop` 脚本）

**Interfaces:**
- Consumes: `@1warden/crypto` 全部公开 API；Task 2 的 `scripts/dev-env.sh` 中的测试账号常量
- Produces: `bun run test:interop` —— 退出码 0 表示密码学与官方实现兼容

> **这是整个计划里最重要的一个任务。**
>
> 经源码核实，**Vaultwarden 服务端完全不实现客户端密码学**：它把用户密钥（`akey`）与私钥当作不透明字符串存储转发，从不解析 EncString、不做 MAC 校验、不做长度检查。**我们即使加密写错，服务端也会静默接受**——直到用户发现密码解不开。
>
> 因此：**服务端提供零验证，官方 CLI 是唯一的裁判。**
>
> 本任务若不通过，**不得进入计划 2**。前面所有单测都只是"自我一致"，只有这里能证明"真的对"。

- [ ] **Step 1: 安装官方 Bitwarden CLI 作为参照实现**

```bash
bun add -g @bitwarden/cli
bw --version
./scripts/dev-server.sh start
bw config server http://127.0.0.1:8080
```

Expected: `bw --version` 输出版本号（形如 `2026.x.x`）

- [ ] **Step 2: 写互操作测试 `scripts/interop-test.ts`**

```ts
#!/usr/bin/env bun
/**
 * 互操作测试：证明 @1warden/crypto 与官方 Bitwarden 实现字节级兼容。
 *
 * 方向 A：我们用 bw 创建账户 + 写入条目 → 用我们的 crypto 解出正确明文
 * 方向 B：我们用 bw 读取 → 确认 bw 能解出我们自己加密的数据
 *
 * 前置：./scripts/dev-server.sh start，且 bw 已安装、已指向本地服务器。
 */
import { execFileSync } from 'node:child_process';
import {
  deriveMasterKey, hashMasterPassword, stretchMasterKey,
  encryptString, decryptString, KDF_TYPE_PBKDF2,
} from '../packages/crypto/src/index';

const BASE = process.env.VW_URL ?? 'http://127.0.0.1:8080';
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

/**
 * ⚠️ prelogin 的字段大小写**在服务端之间不一致**，同一个服务器上前后也不一致：
 *   - prelogin        → Vaultwarden 返回 **camelCase**：`{kdf, kdfIterations, ...}`
 *                       官方服务端返回 PascalCase
 *   - token 端点      → 两者都返回 **PascalCase**：`{Key, PrivateKey, Kdf, ...}`
 *
 * 已对运行中的 Vaultwarden 1.37.3 实测确认。只认一种大小写会直接读不到值，
 * 且表现为「KDF 参数为 undefined → 派生出的密钥全错 → 密码错误」，极难排查。
 */
async function prelogin(): Promise<{ kdf: number; iterations: number; memory?: number; parallelism?: number }> {
  const r = await fetch(`${BASE}/identity/accounts/prelogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  if (!r.ok) throw new Error(`prelogin 失败: ${r.status} ${await r.text()}`);
  const raw = (await r.json()) as Record<string, unknown>;
  const pick = <T>(a: string, b: string): T | undefined => (raw[a] ?? raw[b]) as T | undefined;

  const kdf = pick<number>('kdf', 'Kdf');
  const iterations = pick<number>('kdfIterations', 'KdfIterations');
  if (kdf === undefined || iterations === undefined) {
    throw new Error(`prelogin 响应缺少 KDF 字段（大小写不匹配？）：${JSON.stringify(raw)}`);
  }
  return {
    kdf,
    iterations,
    memory: pick<number>('kdfMemory', 'KdfMemory'),
    parallelism: pick<number>('kdfParallelism', 'KdfParallelism'),
  };
}

async function token(email: string, masterPasswordHash: string) {
  const body = new URLSearchParams({
    grant_type: 'password',
    username: email,
    password: masterPasswordHash,
    scope: 'api offline_access',
    client_id: 'cli',
    deviceType: '8',
    deviceIdentifier: crypto.randomUUID(),
    deviceName: 'onewarden-interop',
  });
  const r = await fetch(`${BASE}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token 失败: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ access_token: string; Key: string; PrivateKey: string }>;
}

async function main() {
  console.log(`\n互操作测试 → ${BASE}\n`);

  // ── 方向 A：用官方 CLI 注册账户，我们用纯 crypto 复现其密钥派生 ──
  console.log('方向 A：官方 CLI 建号 → 我们的 crypto 解出用户密钥');

  const kdf = await prelogin();
  console.log(`  服务器 KDF 参数: ${JSON.stringify(kdf)}`);
  if (kdf.kdf !== KDF_TYPE_PBKDF2) {
    throw new Error(`本测试假定 PBKDF2 账户，实际 KDF 类型为 ${kdf.kdf}。请用 bw 以 PBKDF2 注册测试账号。`);
  }

  const masterKey = await deriveMasterKey(PASSWORD, EMAIL, {
    kdf: KDF_TYPE_PBKDF2, iterations: kdf.iterations,
  });
  const mpHash = await hashMasterPassword(masterKey, PASSWORD);

  let tok: Awaited<ReturnType<typeof token>>;
  try {
    tok = await token(EMAIL, mpHash);
    check('用我们派生的 masterPasswordHash 通过服务端认证', true);
  } catch (e) {
    check('用我们派生的 masterPasswordHash 通过服务端认证', false, String(e));
    console.log('\n提示：若账户尚未创建，请先运行 scripts/seed-account.sh\n');
    process.exit(1);
  }

  const stretched = await stretchMasterKey(masterKey);
  let userKey: { encKey: Uint8Array; macKey: Uint8Array } | undefined;
  try {
    const raw = await decryptString(tok.Key, stretched);
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    userKey = { encKey: bytes.slice(0, 32), macKey: bytes.slice(32, 64) };
    check('用拉伸主密钥解出用户密钥（64 字节）', bytes.length === 64, `实际 ${bytes.length} 字节`);
  } catch (e) {
    check('用拉伸主密钥解出用户密钥', false, String(e));
  }

  // ── 方向 B：我们自己加密 → 官方 CLI 解密 ──
  console.log('\n方向 B：我们的 crypto 加密 → 官方 CLI 解密');

  if (!userKey) { console.log('\n❌ 未解出用户密钥，后续方向无法进行\n'); process.exit(1); }

  const secret = `interop-${Date.now()}-中文🔐`;
  const encName = await encryptString(secret, userKey);
  check('我们的加密输出符合 type-2 EncString 格式',
    /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(encName));
  check('往返解密一致', (await decryptString(encName, userKey)) === secret);
  check('同一明文两次加密得到不同密文（IV 随机）',
    (await encryptString(secret, userKey)) !== encName);

  // 我们用 REST 直接写入，再让官方 CLI 读回并解密 —— 证明官方实现能解开我们的密文
  let writtenId = '';
  try {
    const res = await fetch(`${BASE}/api/ciphers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        // ⚠️ encryptedFor 是必填字段，缺失会导致反序列化失败（不是校验错误）
        encryptedFor: jwtSub(tok.access_token),
        type: 1, name: encName, notes: null,
        favorite: false, reprompt: 0,
        folderId: null, organizationId: null,
        login: { username: null, password: null, totp: null, uris: [] },
        fields: null, passwordHistory: null,
      }),
    });
    if (!res.ok) throw new Error(`创建条目失败 ${res.status}: ${await res.text()}`);
    writtenId = ((await res.json()) as { id: string }).id;
    check('通过 REST 写入一条自加密条目', !!writtenId);
  } catch (e) {
    check('通过 REST 写入一条自加密条目', false, String(e));
  }

  if (writtenId) {
    try {
      bw(['sync', '--force']);
      const name = bwGetItemName(writtenId);
      check('🔑 官方 CLI 能解出我们加密的条目名', name === secret, `CLI 解出: ${JSON.stringify(name)}`);
    } catch (e) {
      check('🔑 官方 CLI 能解出我们加密的条目名', false, String(e));
    }
  }

  // ── 方向 B：官方 CLI 加密 → 我们解密 ──
  console.log('\n方向 B：官方 CLI 加密 → 我们的 crypto 解密');

  const bwSecret = `from-cli-${Date.now()}-中文🔐`;
  try {
    const item = {
      type: 1,
      name: bwSecret,
      notes: null,
      favorite: false,
      login: { username: 'someone@example.com', password: 'pw-from-cli', totp: null, uris: [] },
    };
    // bw create item 从 stdin 读 JSON（没有位置参数的条目名）
    const out = execFileSync('bw', ['create', 'item', '--raw'], {
      input: JSON.stringify(item),
      env: { ...process.env },
      encoding: 'utf8',
    });
    const cliId = (JSON.parse(out) as { id: string }).id;

    const sync = (await apiGet('/api/sync', tok.access_token)) as {
      ciphers: Array<{ id: string; name: string; login?: { username?: string; password?: string } }>;
    };
    const found = sync.ciphers.find((c) => c.id === cliId);
    check('在我们拉取的 sync 里找到 CLI 写入的条目', !!found);

    if (found) {
      const decName = await decryptString(found.name, userKey);
      check('🔑 我们能解出官方 CLI 加密的条目名', decName === bwSecret, `我们解出: ${JSON.stringify(decName)}`);
      if (found.login?.username && found.login?.password) {
        check('我们能解出 CLI 加密的用户名/密码',
          (await decryptString(found.login.username, userKey)) === 'someone@example.com'
          && (await decryptString(found.login.password, userKey)) === 'pw-from-cli');
      }
    }
  } catch (e) {
    check('方向 B 全流程', false, String(e));
  }

  console.log(failures === 0 ? '\n✅ 互操作测试全部通过\n' : `\n❌ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── 辅助 ──

/** 跑官方 CLI，自动带上 BW_SESSION（`bw get item` 等命令需要它） */
function bw(args: string[]): string {
  const session = process.env.BW_SESSION;
  if (!session) throw new Error('缺少 BW_SESSION —— 请先运行 `bun run seed` 并 export 它');
  return execFileSync('bw', [...args, '--session', session], { encoding: 'utf8' });
}

function bwGetItemName(id: string): string {
  return (JSON.parse(bw(['get', 'item', id, '--raw'])) as { name: string }).name;
}

/** 从 access token 的 JWT 载荷取用户 uuid —— 写入 cipher 时 encryptedFor 必填 */
function jwtSub(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('access token 不是合法 JWT');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
}

async function apiGet(path: string, token: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} 失败 ${r.status}: ${await r.text()}`);
  return r.json();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: 创建种子脚本 `scripts/seed-account.ts`**

```ts
#!/usr/bin/env bun
/**
 * 用官方 CLI 在本地服务器上创建一个测试账户（幂等）。
 * CLI 负责生成密钥层级，保证账户是「官方实现产出的标准账户」。
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.VW_URL ?? 'http://127.0.0.1:8080';
const EMAIL = process.env.ONEWARDEN_TEST_EMAIL ?? 'onewarden-test@example.com';
const PASSWORD = process.env.ONEWARDEN_TEST_PASSWORD ?? 'Test-Master-Password-123!';

console.log(`→ 配置 CLI 指向 ${BASE}`);
execFileSync('bw', ['config', 'server', BASE], { stdio: 'inherit' });

console.log('→ 尝试登录…');
try {
  const session = execFileSync('bw', ['login', EMAIL, PASSWORD, '--raw'], { encoding: 'utf8' }).trim();
  console.log('✓ 已存在账户，登录成功');
  console.log(`BW_SESSION=${session}`);
} catch {
  console.log('→ 账户不存在，正在注册…');
  const out = execFileSync('bw', ['register', EMAIL, PASSWORD], { encoding: 'utf8' });
  console.log(out);
  const session = execFileSync('bw', ['login', EMAIL, PASSWORD, '--raw'], { encoding: 'utf8' }).trim();
  console.log('✓ 注册并登录成功');
  console.log(`BW_SESSION=${session}`);
}
console.log('\n把上面的 BW_SESSION 导出后重跑 interop 测试：');
console.log('  export BW_SESSION=... && bun run test:interop');
```

- [ ] **Step 4: 在 `package.json` 中注册脚本**

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:interop": "bun scripts/interop-test.ts",
  "seed": "bun scripts/seed-account.ts",
  "typecheck": "tsc --build --force"
}
```

- [ ] **Step 5: 端到端跑一次互操作测试**

```bash
./scripts/dev-server.sh reset && ./scripts/dev-server.sh start
chmod +x scripts/*.ts
bun run seed
export BW_SESSION="<上一步输出的值>"
bun run test:interop
```

Expected: 全部 ✓，退出码 0

- [ ] **Step 6: 若 Argon2id 相关断言失败 —— 修正 `ARGON2_MEMORY_UNIT_MULTIPLIER`**

用官方 CLI 注册一个 **Argon2id** 账户（注册时 KDF 选 Argon2id），对其重复 Step 5。
若方向 A 的认证失败而 PBKDF2 账户正常，说明 `packages/crypto/src/kdf.ts` 中
`ARGON2_MEMORY_UNIT_MULTIPLIER` 的值不对 —— 在 `1024` 与 `1` 之间切换并重测。
**这是唯一需要改的地方**，改完重跑 Step 5 直到通过。

- [ ] **Step 7: Commit**

```bash
git add scripts/ package.json
git commit -m "test(crypto): add cross-implementation interop test against official Bitwarden CLI"
```

---

## 完成标准（计划 1 收尾）

- [ ] `bun run test` 全绿，`bun run typecheck` 无错误
- [ ] `bun run test:interop` 退出码 0（**PBKDF2 与 Argon2id 两种账户都验证过**）
- [ ] `./scripts/dev-server.sh reset && ./scripts/dev-server.sh start` 可从零复现干净实例
- [ ] 全仓 `grep -rn "console.log" packages/crypto/src` 无输出（库代码不得打印）
- [ ] `packages/crypto` 无任何网络调用、无 `fs` 导入

**下一份计划**：计划 2 —— `@1warden/api`（Bitwarden REST 客户端）+ `@1warden/vault`（领域层：同步引擎、会话状态机、搜索、Watchtower）。

---

# 附录：实施记录（执行台账）

> 以下是执行本计划时的原始台账。记录的是**过程决策**（研究修正、被测试抓到的真 bug、
> 与计划文本的偏差），与计划本身一起保留，供后续计划参考。

Executor: inline (executing-plans)

## Pre-flight scan

**Ruling: 用 git 分支而非 worktree 做隔离** — 仓库只有 1 个提交、无并行工作，
分支已提供所需的隔离；worktree 会额外付出 node_modules 与 cargo target 路径的代价。
— cost if wrong: 若后续要并行开发，需要补建 worktree（一次性成本）。

共享接口逐行核对：

| 生产者 → 消费者 | 接口 | 结果 |
|---|---|---|
| Task 3 → 4 | `toBase64`, `utf8Encode` | ✓ 一致 |
| Task 3 → 5 | `fromBase64`, `toBase64` | ✗→✓ 已修（见下 C1） |
| Task 3 → 9 | `randomBytes` | ✓ 一致 |
| Task 5 → 6 | `parseEncString`, `serializeEncString`, `EncryptionType`, `DecryptError`, `aesCbcEncrypt`, `aesCbcDecrypt`, `hmacSha256` | ✓ 一致 |
| Task 5 → 8 | `hmacSha256` | ✓ 一致 |
| Task 6 → 10 | `deriveMasterKey`, `hashMasterPassword`, `stretchMasterKey`, `encryptString`, `decryptString`, `KDF_TYPE_PBKDF2` | ✓ 一致 |
| Task 2 → 10 | `VW_URL`, `ONEWARDEN_TEST_EMAIL`, `ONEWARDEN_TEST_PASSWORD` | ✓ 一致 |

**冲突与裁决（动手前已修入计划）：**

- **C1 — 歧义星号导出（3 处）**：Task 5 `encstring.ts` 转出 `randomBytes`、
  Task 7 `rsa.ts` 转出 `toBase64`、Task 8 `totp.ts` 转出 `concatBytes`/`utf8Encode`，
  而 `index.ts` 用 `export *` 聚合 —— 同名符号会被 TS 判为歧义导出。
  三处转出**均未被任何代码使用**（纯属残留），已全部删除。
  *cost if wrong: 无（删除的是死代码）。*
- **C2 — EncString 段数计算错误**：`expectedSegments = shape.iv > 0 ? 3 : …`
  对 type 0（`iv|data` 两段，无 MAC）会算成 3 段，Task 5 自带的 type-0 测试
  必然失败。已改为 `(iv?1:0) + 1 + (mac?1:0)`。
  *cost if wrong: 无（原式在任何含 type-0 的输入上都是错的）。*

**遗留待验证（非阻塞，Task 4/10 定案）：**
~~Argon2id 的 `KdfMemory` 单位~~ → **已确认**，见 R3。

## 开工前的第二轮修正（基于密码学调研的源码核实）

官方实现源码（`bitwarden/sdk-internal` + `bitwarden-vault`）核实后又修了 5 处，
全部在动手前改入计划：

- **R1 — Argon2id 的盐是 `SHA-256(邮箱)`，不是邮箱原文。**
  PBKDF2 用邮箱原文，Argon2id 用哈希后的。搞错的话 PBKDF2 账户全对、
  Argon2id 账户永远「密码错误」，且无任何线索指向盐。
  已在 `kdf.ts` 修正，并加了一条**独立复算两条路径**的测试钉死它。
  *cost if wrong: 全部 Argon2id 用户无法登录。*
- **R2 — HKDF 测试从自拍快照换成官方 KAT。**
  用 `sdk-internal` 里 `test_stretch_kdf_key` 的真实向量
  （masterKey `1f4f68e2…` → encKey `6f1fb22d…` / macKey `dd7fceea…`）。
  这一条能同时抓住 HMAC 用错、info 串写错、enc/mac 顺序颠倒，
  以及最阴险的「误用 WebCrypto 的 extract+expand HKDF」。
  *cost if wrong: 无，只是测试更强。*
- **R3 — `ARGON2_MEMORY_UNIT_MULTIPLIER = 1024` 由源码确认。**
  `let memory = memory.get() * 1024; // Convert MiB to KiB`。不再是假设。
  *cost if wrong: 无。*
- **R4 — base32 解码器语义反了。**
  官方实现**静默丢弃**字母表外字符（而非抛错），并丢弃末尾不足 8 位的比特。
  我的实现和测试都写成了「非法字符抛错」。已改为过滤语义，
  并加入官方向量 `"ABCD123" → [0, 68, 61]` 与 `"PIUD1IS!EQYA=" == "PIUDISEQYA"`。
  *cost if wrong: 部分用户的验证码直接算不出来。*
- **R5 — Steam 只认字面量 `steam://` 前缀。**
  我原本还会从 `otpauth://totp/Steam:...` 和 `encoder=steam` 推断 Steam，
  但官方不这样做 —— 会导致同一条目我们算 5 位、官方客户端算 6 位。
  已改为完全跟随官方。
  *cost if wrong: 少一个便利特性；换成分歧则更糟。*

## 进度

Task 1: complete (commits f663f78..1faa20a, tests: bun run test → 0 files, expected "No test files found")
Task 3: complete (commits 1faa20a..f2189f8, tests: bun run test → 12/12 pass, typecheck clean)
Task 3: Ruling: 补建根 tsconfig.json（files:[] + references:[packages/crypto]）——
  计划 Task 1 的 "tsc --build --force" 脚本需要根 project references 文件，
  但计划没建它，导致 typecheck 无法运行。— cost if wrong: 无，标准 composite 布局。
Task 2: complete (commits 1faa20a..e9ac724, verified: /api/config + /identity/accounts/prelogin 实测通过)
Task 2: Ruling: 加 WEB_VAULT_ENABLED=false — 我们只用 API，不需要自带网页前端；
  不关掉 Vaultwarden 会因找不到 web-vault/ 拒绝启动。— cost if wrong: 无。
Task 2: Ruling: start() 增加「端口被外来进程占用」检测（is_ours）——
  原脚本只看端口通不通，会把别的 vaultwarden 实例误判成「已在运行」，
  导致后续所有测试打在错误的服务器上（本次真实踩到）。— cost if wrong: 无。
Task 2: Ruling: build 脚本优先复用已有 cargo 产物 —
  避免重复一次 5-15 分钟的 release 编译。— cost if wrong: 理论上可能复用到版本不符的产物，
  但路径固定且由同一个 pin 的源码产出。

Task 4-9: complete (commits e9ac724..b8b1739, tests: bun run test → 111/111 pass, typecheck clean)

期间被测试抓到的**真实实现 bug**（不是测试写错，是代码错）：
- **R6 — TOTP 的 SHA-1 分支被错写成 HMAC-SHA256。** hmacWith 里图省事把
  alg==='SHA-1' 短路成了 hmacSha256。SHA-1 是 TOTP 的默认算法，
  意味着绝大多数验证码会算错；而只测 SHA-256 的话完全发现不了。
  由 RFC 6238 官方向量抓到。— cost if wrong: 所有 TOTP 验证码错误。
- **R7 — randomIndex 只支持 bound ≤ 256。** 单字节拒绝采样，
  而 Fisher-Yates 洗牌需要 bound = 密码长度，generatePassword({length:300}) 直接抛错。
  改为按 bound 取足够字节。— cost if wrong: 长密码生成崩溃。
- **R8 — 模偏差测试的判别力不足。** 原本用「最大偏差 < 15%」，
  但 26 字符池用 % 取模的真实偏差只有 8.6%，测不出来；收紧又会随机翻红。
  改用卡方检验（均匀 ≈25，有偏 ≈348，阈值 60），两边都离得远。
  — cost if wrong: 测试形同虚设，模偏差悄悄上线。

计划文本与实际 API 的偏差（已实测修正）：
- **R9 — prelogin 字段大小写。** 实测 Vaultwarden 1.37.3 返回 **camelCase**
  （kdf/kdfIterations），而 token 端点返回 PascalCase（Key/PrivateKey）。
  同一个服务端两种风格。互操作测试已改为两种都吃。— cost if wrong: KDF 参数读不到 → 全盘失败。
- **R10 — hash-wasm 的 pbkdf2 API。** hashFunction 要 createSHA256() 实例而非
  'sha256' 字符串；且默认 outputType 是 'hex'（返回 64 字符），必须显式 'binary'。
  — cost if wrong: 派生出的密钥长度翻倍，全部认证失败。
- **R11 — parseOtpauthUri 保留展示用大小写。** 官方实现把整个 URI 小写再解析，
  副作用是 issuer 从 "GitHub" 变成 "github"（UI 受损）。改为只对参数名大小写不敏感。
  — cost if wrong: 无，纯 UI 改善。

测试自身的笔误（非实现问题）：HMAC 断言拿 base64 比 hex；totp.test.ts 少一个引号。

Task 10: complete (commits 68f6482, tests: bun run test:interop → 全部 ✓, exit 0)

## 计划 1 收尾验收（全部通过）

- bun run test          → 111/111 pass
- bun run typecheck     → 无错误
- bun run test:interop  → ✅ 双向兼容（PBKDF2 与 Argon2id 两种账户均验证）
- dev-server reset/start → 可从零复现干净实例
- packages/crypto 无 console.log、无网络调用、无 fs 导入

## Task 10 期间的裁决

- **R12 — 本地服务改走 HTTPS + 自签证书。** 官方 CLI 2026.x 拒绝明文 HTTP
  （InsecureUrlNotAllowedError），且没有开关。生产环境本就是 HTTPS，顺带更贴近真实。
  — cost if wrong: 无；仅本地开发，证书在 .dev/ 下（已 gitignore）。
- **R13 — 固定 @bitwarden/cli@2025.2.0。** 2026.x 登录后会做「用户密钥 ID 回填」迁移，
  调用 Vaultwarden 未实现的端点而失败（KeyIdBackfillError，404）。
  这是**新版官方 CLI 与 Vaultwarden 的兼容性缺口**，不是我们的 bug ——
  真实用户也会遇到，值得写进产品文档。
  ⚠️ 但注意：登录**本身**是成功的（错误发生在登录后），所以密码学验证不受影响。
  — cost if wrong: 参照实现停留在旧版本；协议本身未变（RFC 与密钥层级均一致）。
- **R14 — 用我们自己的 crypto 注册账户，而非 CLI。** CLI 2026.9.1 起**没有 register 命令**。
  改用自己注册反而更好：注册本身就跑通了完整密钥层级，随后官方 CLI 能登录即证明正确。
  — cost if wrong: 无。
- **R15 — `bw create item` 必须把 JSON 以 base64 作为参数传入。** 从 stdin 喂原始 JSON
  会报 "Error parsing the encoded request data."。— cost if wrong: 方向 B 无法执行。
- **R16 — bw 调用必须统一走辅助函数并带 `--session`。** 手写 execFileSync 漏掉 session 时，
  bw 会转为**交互式索要主密码**，非 TTY 下刷屏并抛 readline 错误，
  报错信息完全指向不到真正原因（本次为此浪费了两轮）。— cost if wrong: 极难排查的假失败。

## 最终审查（独立审查者，全新上下文）

结论：**无 Critical**。审查者独立复算了全部密码学向量（Python）、
亲自跑通了双向互操作、并核对了官方 CLI 自带的实现代码。

4 个 Important 已全部修复（每个先写失败测试）：
- I1 TOTP digits/period 钳制与官方不一致（真 bug）→ 改为只在 >0 时采纳
- I2 环境变量未接入文档流程 → 移入脚本自身，全新 shell 可跑通
- I3 bw 解析依赖调用方式，版本 pin 只是偶然 → 显式解析 + 版本断言
- I4 畸形输入漏出 TypeError/DOMException/URIError → 统一为 DecryptError

Minor 中一并修掉：dev-server reset 未清 CLI 状态（会让测试以"像密码学错误"的方式失败）。

未修（列入 deferred）：type 0 遗留账户、RSA 类型 5/6 的 MAC 语义、
明文扫描测试推迟到有持久化的计划、密码强度评分过于乐观（应在 vault 层用词典式评分）。
