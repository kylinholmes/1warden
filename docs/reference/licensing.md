# 开源复用与许可证结论

> 来源：逐份阅读真实的 `LICENSE` 文件、npm/crates 注册表元数据、以及**下载并解开**的 npm 包内容。
> 调研日期：2026-10-05。注意 GitHub 的许可证 API 在这些仓库上**不可靠**（多处误报 NOASSERTION），
> 所以一切以 `LICENSE` 文件与注册表元数据为准。

---

## 1. 最重要的三条结论

### 1.1 ⚠️ 官方 Bitwarden SDK **禁止**用于 Vaultwarden

`LICENSE_SDK.txt` v2 原文：

> **§1.3** 「Compatible Application」必须与 **Bitwarden 公司分发的**服务端产品互操作 ——
> **Vaultwarden 不是 Bitwarden 公司分发的**，所以我们的应用**根本不构成 Compatible Application**。
>
> **§3.1** 「在任何情况下，Compatible Application 都不得提供给、许可给或出售给第三方。」
>
> **§3.3** 「不得使用本 SDK 开发用于 **Bitwarden 以外的软件**（包括 Bitwarden 的非兼容实现）的应用。」

**两条独立的理由各自足以排除**：服务端不是 Bitwarden + 我们面向第三方分发。

**唯一可用的授权是 GPL-3.0 那一支**，而它带完整的传染性。

### 1.2 整个客户端引擎**确实**以 GPL-3.0 提供

`@bitwarden/sdk-internal`（npm，WASM，GPL-3.0）导出了 **50 个类**，
是一套完整的客户端引擎：KDF、密钥层级、EncString 加密、同步、保险库 CRUD、
TOTP、生成器、导入导出。两个构建：7.8MB 和 26MB 的 wasm。

**所以真正的选择不是「自己写 vs 用库」，而是：**

| 选项 | 代价 |
|---|---|
| 采用整套引擎 | **整个产品变成 GPL-3.0**，必须提供源码 |
| 自己写加密与协议层 | 保住自己的许可证 |

### 1.3 🔑 **任何语言都没有宽松许可的 Bitwarden 加密实现**

这是对我们最重要的一条：**不存在**可以拿来用的、非 GPL 的 Bitwarden 加密库。

唯一的 TypeScript 实现是 `cozy-keys-lib`，**GPL-3.0**。

**所以「自己写密码学」不是我们的偏好，是唯一的路。** 我们已完成并验证的
`@coffer/crypto` 因此是一项**无法从开源获得替代**的资产。

---

## 2. ⚠️ 一个真实的坑：`@bitwarden/cli` 的许可证不干净

- 它的 `package.json` 写着 `SEE LICENSE IN LICENSE.txt`，但**发布的 tarball 里没有 `LICENSE.txt`**
- 仓库里 `apps/cli` 构建的是 `configName: "OSS"`（GPL-3.0）
- **但发布的 2026.9.1 包里包含了商业许可的 wasm-bindgen 胶水代码**
  （`class CommercialPasswordManagerClient`，注释写着 "Client for bitwarden licensed operations"）
- 而纯 GPL 的 `@bitwarden/sdk-internal` 包里**完全没有** `Commercial` 字样

**结论：`@bitwarden/cli` 不能当作干净的 GPL-3.0 来源看待。**

**对我们的影响**：它只是我们的**测试参照工具**（`@bitwarden/cli@2025.2.0`，仅本地验证用，
不分发、不链接进产品）。**保持这个用法是安全的**，但
**绝不能把它打进产品，也不能复制它的代码**。

> 调研者标注：这条是**推断**而非确凿证据 —— 它验证了商业胶水存在，
> 但没能完成 WASM 二进制的哈希比对（npm 限流）。**这是最值得独立法律复核的一条。**

---

## 3. ✅ 好消息：AGPL **不会**传染我们的客户端

- **我们的客户端不是 AGPL 衍生作品**。AGPL §13（网络传染）约束的是
  **你通过网络提供的那个程序**，而不是「通过 HTTP API 与它通信的软件」。
  独立编写的客户端使用 Bitwarden API，**不构成服务端的衍生作品**。
- **自托管未经修改的 Vaultwarden 不产生任何义务** —— §13 的触发条件是
  **修改** + **让他人通过网络交互**。
- **要警惕的触发点**：如果你**修改了** Vaultwarden 并且**除你以外的人**通过网络与它交互，
  你必须向那些用户提供修改版的对应源码。

**做法**：不复制 `bitwarden/server` 或 `vaultwarden` 的代码，只对着 API 重新实现。

---

## 4. 官方没有可用的设计系统

- **`@bitwarden/components`、`@bitwarden/vault` 在 npm 上不存在（404）** ——
  它们是仓库内的工作区库，从未发布
- 其源码在 `clients/libs/*`，是 **GPL-3.0**

**所以没有官方设计系统可以借鉴代码。** 这与我们「自己建设计系统」的决定一致 ——
我们测量 1Password 的比例、自己定值，这条路是对的。

---

## 5. 可以直接用（宽松许可）

| 用途 | 包 | 许可证 | 版本 | 备注 |
|---|---|---|---|---|
| Argon2id | **`hash-wasm`** | MIT | 4.12.0 | **我们已在用** ✓ 11.6kB gzip，WASM 内嵌 base64 |
| HKDF/PBKDF2/HMAC | `@noble/hashes` | MIT | 2.4.0 | 我们用 WebCrypto 替代了，够用 |
| TOTP | `otpauth` | MIT | 9.5.2 | 见下方说明 |
| UI 原语 | **`radix-ui`**（统一包） | MIT | 1.6.7 | 无样式，运行时 |
| UI 组件 | **`shadcn/ui`** | MIT | CLI 4.21.1 | **复制源码，代码归你**，可闭源分发 |
| 无障碍优先 | `react-aria-components` | Apache-2.0 | 1.21.1 | 键盘/辅助技术支持最好 |
| 虚拟列表 | `@tanstack/react-virtual` | MIT | 3.14.13 | 仅 DOM |
| 模糊搜索 | **`@leeoniya/ufuzzy`** | MIT | 1.0.19 | **4kB gzip，无需建索引**，162k 条约 5ms |
| 密钥存储（Rust） | `keyring` crate | MIT OR Apache-2.0 | 4.2.0 | 覆盖 macOS/Windows/Linux/iOS/Android |
| 保险库导入导出 | `bitwarden/credential-exchange` | MIT | — | **罕见**：官方仓库里的 MIT，FIDO CXP 标准 |

### 关于 TOTP 的说明

调研建议用 `otpauth` 而不要手写。**但我们保留自己的实现**，理由：

1. 我们的实现已用 **RFC 6238 官方向量**与 **Bitwarden 官方测试向量**验证
2. 我们实现了 Bitwarden 特有的两个行为，通用库不一定有：
   - **base32 解码器静默丢弃非法字符**（而非抛错）
   - **只认字面量 `steam://` 前缀**（与官方一致，避免同一条目两边算出不同码）
3. `otpauth` 的行为是否与 Bitwarden 逐位一致**未经验证**

**做法**：保留自己的实现，把 `otpauth` 作为**交叉验证**的参照（类似官方 CLI 之于密码学）。

---

## 6. 不要碰

| 不要碰 | 原因 |
|---|---|
| `bitwarden/server`、`vaultwarden` 的**源码** | AGPL-3.0 —— 运行没问题，复制/修改后分发不行 |
| `bitwarden/clients` 源码（含 `libs/*` 设计系统） | GPL-3.0 —— **不能抄它的 UI** |
| `@bitwarden/commercial-sdk-internal` | SDK 许可 v2：仅内部使用，禁止第三方分发 |
| `bitwarden/sdk-sm` / `sdk-go` / `@bitwarden/sdk-napi` | SDK 许可 v1，专有 |
| **`@bitwarden/cli`（打进产品）** | 见 §2 —— 含商业代码 |
| `bitwarden/sdk-swift` | **无许可证声明** = 保留所有权利 |
| `cozy-keys-lib` | GPL-3.0 |

**注意**：`@bitwarden/cli` 作为**本地测试参照**使用是安全的（我们就是这么用的），
只是不能打进产品、不能抄代码。

---

## 7. 值得参考的实现（MIT）

| 项目 | 许可证 | 说明 |
|---|---|---|
| **`doy/rbw`** | **MIT** | **最好的参考**：一份完整、成熟、独立的 Bitwarden API + 密码学 Rust 重实现。1520 star。是二进制不是库 —— 拿来读，不是拿来依赖 |
| `quexten/goldwarden` | MIT | Go 客户端 + SSH agent。作者已宣布暂停开发 |
| `mvdan/bitw` | BSD-3 | 已归档，可作参考 |

---

## 8. 未解决 / 需自行确认

1. **§2 的 CLI 商业代码发现是推断** —— 最值得独立法律复核
2. npm 声明的 `GPL-3.0` vs crate 声明的 `GPL-3.0-only`（无 "or later"）**含义不同**
3. `@bitwarden/mcp-server` 有同样的 `SEE LICENSE IN LICENSE.txt` 模式，未检查其包内容
4. `bitwarden-vault` crate 的 4.0.0 版本**没有发布到 crates.io** —— 不要指望依赖它
