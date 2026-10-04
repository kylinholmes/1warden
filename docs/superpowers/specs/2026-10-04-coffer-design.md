# Coffer — 设计文档

> 一个面向普通个人用户的密码管理器。UI/UX 参考 1Password，后端对接 Vaultwarden（Bitwarden 兼容协议）。
>
> 状态：待评审 · 日期：2026-10-04

---

## 1. 目标与成功标准

**目标**：让一个不懂技术的普通人，能自己host一个 Vaultwarden，然后用一个**好看、好用、可信**的客户端管理全部密码。

**成功标准**（按优先级）：

1. **密码学正确** — 本客户端写入的数据，官方 Bitwarden 客户端/Vaultwarden 网页版能正确解密；反之亦然。这是不可妥协的底线。
2. **零学习成本** — 一个从没用过密码管理器的人，能在不读文档的情况下完成：登录 → 解锁 → 找到一条密码 → 复制到网站。
3. **安全感** — 通过视觉与交互让用户确信"我的密码是安全的"：永不默认明文展示、复制后自动清除剪贴板、清晰的锁定状态与倒计时。
4. **日常够用** — 登录/解锁、浏览/搜索、增删改查、密码生成、文件夹、收藏、TOTP、自动锁定、浏览器自动填充。

**形态**：**桌面 + 浏览器扩展 + 移动端**（iOS / Android），**三端统一用 Tauri**。

三者共用同一套 TypeScript 核心（crypto / api / vault），各平台只写自己的壳与平台特有集成。

> **移动端框架已定：Tauri 2 Mobile**（用户决策：「统一点」）。
> 好处是 Tauri 移动端跑的是**系统 WebView**（iOS WKWebView / 安卓系统 WebView），
> 所以 TS 核心可以**原样复用** —— 不必为手机重写加密逻辑，
> 也避开了 React Native 上 WebCrypto（尤其 RSA-OAEP）支持不全的问题。
>
> ⚠️ **待确认的关键风险**：iOS 的**系统级自动填充**（在「密码」菜单里出现）
> 需要 **AutoFill Credential Provider 扩展** —— 一个独立的原生 Swift bundle target。
> 这与桌面端 passkey 遇到的是同一类问题：**不是写代码，是加一个打包目标**。
> 需要确认 Tauri 2 的工程结构能否容纳 iOS app extension。
> 若不能，则移动端自动填充需降级为「App 内填充 + 复制」，或另建原生壳。
> 专项调研进行中。

> **本轮范围（用户决策，2026-10-05）：只做桌面 + 浏览器扩展。**
> 移动端押后 —— 「这块后续做了测测看再说吧」。届时需要先实测两个未决问题：
> iOS 系统级自动填充所需的 app extension 能否并入 Tauri 工程、以及扩展进程的内存上限
> 是否扛得住本地解密。
>
> 但**架构仍然为三端共存设计** —— 核心包不得假设 DOM，不得依赖 Node 专有 API，
> 平台能力一律由外壳注入。这样后面加移动端是「加一个壳」，不是「重写核心」。

---

## 2. 非目标（YAGNI）

明确**不做**，避免范围蔓延：

| 不做 | 原因 |
|---|---|
| 团队/组织/集合（Collections） | 面向个人用户。Vaultwarden 若返回 collections 则只读展示，不提供管理 UI |
| 多账户切换 | 个人用户一个账户。架构上预留，UI 不做 |
| Send（临时分享）、Emergency Access | 属进阶功能，非个人日常刚需 |
| 自建服务端 / 部署向导 | 用户已有 Vaultwarden |
| 移动端（首版） | 三端共用核心，但移动端 App 在桌面与扩展之后交付 |
| 密码共享 / 家庭组 | 同上 |
| 生物识别解锁（首版） | 第二阶段做（macOS Touch ID / Face ID / 安卓生物识别），架构预留接口 |
| 系统级 passkey（桌面/移动） | 需操作系统级凭证提供程序扩展 + 特殊打包（macOS 需独立 Swift target，Windows 需 MSIX）。**v1 只做浏览器扩展内的 passkey** |

> **原生窗口自动填充不在非目标内** —— 它是明确的一等目标，见下方 §7.4。
> 与 passkey 不同：passkey 需要苹果专有的凭证扩展（Tauri 无法产出），
> 而原生自动填充走的是**辅助功能 API**，Tauri 的 Rust 后端可以直接调用。

---

## 3. 架构总览

### 3.1 分层原则

核心约束：**每一层只能依赖它下面的层**。这让密码学可以脱离网络和 UI 被独立测试。

```
┌───────────────────────────────────────────────────────────┐
│ apps/desktop (Tauri)          apps/extension (MV3)        │
│  · 窗口/托盘/全局快捷键         · popup / content script    │
│  · Keychain / 生物识别          · 页面注入与填充            │
└───────────────┬───────────────────────────┬───────────────┘
                │                           │
                └──────────┬────────────────┘
                           ▼
┌───────────────────────────────────────────────────────────┐
│ @coffer/ui — React 设计系统                                │
│  纯展示组件：tokens / primitives / 条目视图 / 布局          │
│  不知道 HTTP、不知道加密，只消费领域对象                     │
├───────────────────────────────────────────────────────────┤
│ @coffer/vault — 领域层                                     │
│  模型 · 同步引擎 · 会话与锁定 · 搜索 · 密码生成 · TOTP      │
│  把「加密的 JSON」变成「可用的领域对象」                     │
├──────────────────────────┬────────────────────────────────┤
│ @coffer/crypto           │ @coffer/api                    │
│  Bitwarden 密码学原语     │  Bitwarden REST 客户端          │
│  纯函数 · 无网络 · 无 UI  │  只认 HTTP 和原始 JSON，不碰解密 │
└──────────────────────────┴────────────────────────────────┘
                           │
                    @coffer/i18n (zh-CN / en)
```

**为什么把 crypto 和 api 拆开**：`api` 只负责"把字节搬来搬去"，`crypto` 只负责"把字节变明文"。两者都不知道对方存在。这样：
- crypto 可以用**测试向量**独立验证，不需要网络。
- api 可以用**契约测试**独立验证，不需要正确实现加密。
- 两者的组合（`vault`）才是端到端逻辑。

### 3.2 目录结构

```
1warden/
├── package.json                    # bun workspaces
├── tsconfig.base.json
├── .npmrc                          # 淘宝源
├── packages/
│   ├── crypto/                     # @coffer/crypto
│   ├── api/                        # @coffer/api
│   ├── vault/                      # @coffer/vault
│   ├── i18n/                       # @coffer/i18n
│   └── ui/                         # @coffer/ui
├── apps/
│   ├── desktop/                    # Tauri 2 + React + Vite
│   │   ├── src/                    # React 前端
│   │   └── src-tauri/              # Rust 壳
│   └── extension/                  # MV3
├── scripts/
│   ├── dev-server.sh               # 启动本地 Vaultwarden
│   └── seed-vault.ts               # 造测试数据
└── docs/
```

**工具链**：Bun workspaces（简单、快，暂不引入 Turborepo）+ TypeScript（strict）+ Vitest + Playwright。

---

## 4. 模块设计

### 4.1 `@coffer/crypto`

**职责**：实现 Bitwarden 客户端密码学。纯函数，无状态，无 I/O。

**依赖**：`hash-wasm`（Argon2id / PBKDF2，浏览器与 Node 通用 WASM）+ WebCrypto（AES-CBC / HMAC / RSA-OAEP / HKDF 均原生支持）。

**公开接口**（示意）：

```ts
// —— 密钥派生 ——
type KdfConfig =
  | { kdf: 0; iterations: number }                                    // PBKDF2-SHA256
  | { kdf: 1; iterations: number; memory: number; parallelism: number } // Argon2id

deriveMasterKey(password: string, email: string, kdf: KdfConfig): Promise<Uint8Array>
hashMasterPassword(masterKey: Uint8Array, password: string): Promise<string>
stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey>

// —— 对称密钥 ——
interface SymmetricKey { encKey: Uint8Array; macKey: Uint8Array }
makeUserKey(): Promise<SymmetricKey>
expandKey(key: SymmetricKey): Promise<{ enc: CryptoKey; mac: CryptoKey }>

// —— EncString ——
type EncString = string   // "2.<b64 iv>|<b64 ct>|<b64 mac>"
encryptString(plain: string,  key: SymmetricKey): Promise<EncString>
decryptString(enc: EncString, key: SymmetricKey): Promise<string>
encryptBytes(data: Uint8Array,  key: SymmetricKey): Promise<EncString>
decryptBytes(enc: EncString,    key: SymmetricKey): Promise<Uint8Array>

// —— RSA ——
decryptWithPrivateKey(enc: EncString, privateKey: Uint8Array): Promise<Uint8Array>
encryptWithPublicKey(data: Uint8Array, publicKey: Uint8Array): Promise<EncString>

// —— 生成器 / TOTP ——
generatePassword(opts: PasswordOptions): string
generatePassphrase(opts: PassphraseOptions): string
generateTotp(secret: string, at?: number): Promise<{ code: string; period: number; remaining: number }>
```

**设计要求**：
- 所有函数**显式传入密钥**，绝不读取全局/单例状态 —— 这样才可测。
- 解密失败要抛**结构化错误**（`DecryptError` 带类型），不要静默返回空串。区分"MAC 校验失败"（数据被篡改/密钥错）和"格式不合法"。
- 常量时间比较 MAC。

### 4.2 `@coffer/api`

**职责**：Bitwarden/Vaultwarden REST 协议。只处理 HTTP 与原始 JSON。

**公开接口**（示意）：

```ts
class BitwardenApi {
  constructor(baseUrl: string, device: DeviceInfo)

  // 认证
  prelogin(email: string): Promise<PreloginResponse>
  loginPassword(p: LoginParams): Promise<TokenResponse>       // 可能抛 TwoFactorRequiredError
  loginTwoFactor(p: TwoFactorParams): Promise<TokenResponse>
  loginApiKey(clientId, clientSecret): Promise<TokenResponse>
  refresh(refreshToken: string): Promise<TokenResponse>
  register(p: RegisterParams): Promise<void>

  // 保险库
  sync(): Promise<SyncResponse>
  createCipher(c: CipherRequest): Promise<CipherResponse>
  updateCipher(id: string, c: CipherRequest): Promise<CipherResponse>
  softDeleteCipher(id): Promise<void>
  restoreCipher(id): Promise<void>
  deleteCipher(id): Promise<void>
  createFolder / updateFolder / deleteFolder

  // 账户
  getProfile() / changePassword() / changeKdf() / verifyPassword()
  getRevisionDate(): Promise<number>

  // 附件
  uploadAttachment(...) / downloadAttachment(...)
}
```

**设计要求**：
- **兼容两种 token 响应形态**：老版本返回扁平的 `Key` / `PrivateKey`；较新版本额外返回 `AccountKeys.publicKeyEncryptionKeyPair` 与 `UserDecryptionOptions.MasterPasswordUnlock`。解析时两者都要吃，老字段优先。注意 `Key` 字段在服务端为空时是**整个字段缺失**而非 `null`。
- 统一错误模型：`ApiError` 带 `status`、`kind`（network / auth / twoFactorRequired / rateLimited / captchaRequired / server）、原始 body。
- **自动 token 刷新**：401 时用 refresh_token 换新 token 并重放一次请求。
- 请求头模拟官方客户端（`Device-Type`、`Bitwarden-Client-Name`、`Bitwarden-Client-Version`），保证服务端行为一致。
- **绝不打印含密钥的 body 到日志**。

### 4.3 `@coffer/vault`

**职责**：把加密数据变成用户能用的东西。整个应用的"大脑"。

| 单元 | 做什么 |
|---|---|
| `models` | 领域模型：`VaultItem`（解密后）、`Folder`、`Account`。与 API 的 DTO 明确分开，转换函数双向可测 |
| `session` | 状态机：`loggedOut → locked → unlocking → unlocked`。持有内存中的密钥与明文 |
| `sync` | 全量 sync、增量合并、乐观更新与回滚。含并发去重（同一时刻只跑一个 sync） |
| `search` | 本地全文搜索（名称/用户名/网址/备注），带评分排序 |
| `generator` | 密码/口令生成，调用 crypto |
| `totp` | TOTP 计算与倒计时 |
| `watchtower` | 弱密码 / 重复使用 / 已泄露（HIBP k-anonymity） |

**关键设计**：
- **解密后的明文只存在于内存**。`VaultItem` 对象持有明文字符串，绝不序列化到磁盘。
- **持久化的只有**：服务器地址、邮箱、加密后的 vault 缓存、设置项。
- 锁定 = 清空 `session` 中的所有密钥与 `VaultItem`，并尽力覆写原缓冲区。

### 4.4 `@coffer/ui`

**职责**：React 设计系统。**纯展示**，不知道网络与加密。

- `tokens/` — 颜色、间距、圆角、字号、阴影、动效时长（CSS 变量，支持亮/暗）
- `primitives/` — Button、Input、Field、Dialog、Popover、Toast、Tooltip、Menu、Skeleton
- `patterns/` — `ItemRow`、`ItemDetail`、`SecretField`（遮蔽/显示/复制）、`CopyButton`、`PasswordStrength`、`TotpRing`、`EmptyState`
- `layout/` — `ThreePaneShell`（侧栏 / 列表 / 详情）、`LockScreen`、`QuickSearch`（Cmd+K）

**无障碍**：全部键盘可达，焦点可见，`aria-*` 正确，色彩对比 ≥ WCAG AA。

### 4.5 `apps/desktop`（Tauri 2）

**Rust 侧的职责**（前端不该做的事）：
- 窗口：主窗口、Quick Search 无边框浮窗、系统托盘
- 全局快捷键（默认 `Cmd+Shift+Space` 呼出快速搜索）
- **安全存储**：把 refresh token 存进 macOS Keychain（`keyring` crate），实现"记住此设备"
- 锁屏/休眠事件监听 → 触发自动锁定
- **本地 IPC 服务**：给浏览器扩展用的 loopback WebSocket + 握手密钥
- 剪贴板写入 + N 秒后清除

**为什么这些放 Rust 而不是 JS**：JS 侧无法可靠访问 Keychain、系统休眠事件，且明文密钥放在渲染进程内存里更易被 XSS 类问题波及。

### 4.6 `apps/extension`（MV3）

- `background` (service worker) — 会话持有、与桌面 App 建立 IPC、与 Vaultwarden 通信
- `content script` — 识别登录表单、填充、捕获提交以提示保存/更新
- `popup` — 当前站点匹配的条目列表、一键填充、生成密码
- **安全约束**：明文密码**不经过 content script 的 JS 堆**——填充通过 `chrome.debugger`/直接 DOM 赋值由 background 驱动，且 content script 只拿到"要填哪个字段"，拿不到值。

> **桌面 App 与扩展的关系**：扩展优先通过本地 IPC 复用桌面 App 已解锁的会话（1Password 模式）；桌面 App 未运行时，扩展可独立登录解锁作为降级。

---

## 5. 加密与安全模型

### 5.1 密钥层级

```
主密码 (用户输入, 永不离开设备)
   │  PBKDF2-SHA256 或 Argon2id（参数来自服务端 prelogin）
   ▼
主密钥 masterKey (32B)
   │  ├─ PBKDF2-SHA256(masterKey, password, 1 次) → base64 = masterPasswordHash  ──► 发给服务端做认证
   │  │                                                                            （服务端只存它的再哈希）
   │  └─ HKDF-Expand-SHA256(info="enc" 32B ‖ info="mac" 32B)
   ▼
拉伸主密钥 stretchedMasterKey (64B = 32 enc + 32 mac)
   │  解密 token 响应里的 Key 字段 (EncString type 2)
   ▼
用户对称密钥 userKey (64B = 32 enc + 32 mac)  ◄── 保险库里所有数据都用它加解密
   │
   │  解密 token 响应里的 PrivateKey 字段
   ▼
RSA-2048 私钥  ── 用于解密「组织密钥 / 他人共享」场景（个人版基本用不到，但协议要求能解出来）
```

**要点**：主密码本身**从不发送**到服务端，发出去的是 `masterPasswordHash`。服务端拿到的也不足以反推主密码。

### 5.2 密文格式（EncString）

`<type>.<base64(iv)>|<base64(ciphertext)>|<base64(mac)>`

| type | 含义 | 用途 |
|---|---|---|
| 0 | AesCbc256_B64 | 无 MAC（极少用） |
| 1 | AesCbc128_HmacSha256_B64 | 128 位密钥 + 256 位 MAC |
| 2 | AesCbc256_HmacSha256_B64 | **主力格式**：256 位 AES-CBC + 256 位 HMAC-SHA256 |
| 3/4/5/6 | RSA-2048 OAEP (SHA1/SHA256) ± HMAC | 保护用户密钥 |

加密流程（type 2）：随机 16B IV → AES-256-CBC(PKCS#7) 加密 → HMAC-SHA256 覆盖 `IV ‖ ciphertext` → 三段拼接。解密时**先验 MAC 再解密**（encrypt-then-MAC），MAC 不匹配直接拒绝。

### 5.3 每条目独立密钥

Cipher 可以带自己的 `Key` 字段（用 userKey 加密的 64B 密钥）。存在时必须用它解密该条目的所有字段，否则用 userKey。**这是共享/组织场景的设计，但个人库里也可能出现**，必须支持。

### 5.4 安全不变量（要写成测试）

| # | 不变量 |
|---|---|
| S1 | 明文密码/密钥**永不**写入磁盘、日志、崩溃报告、`localStorage` |
| S2 | 持久化数据只能是密文或非敏感元数据 |
| S3 | 剪贴板在 N 秒（默认 30）后自动清空 |
| S4 | 空闲 M 分钟（默认 15）、系统休眠、屏幕锁定 → 自动锁定 |
| S5 | 锁定即清空内存中的密钥与明文，并尽力覆写缓冲区 |
| S6 | 密钥、token、密码**不出现**在 URL query 里 |
| S7 | 错误信息不含敏感数据 |
| S8 | 所有出站请求仅允许用户配置的服务器域名（无第三方遥测） |

> **诚实的局限**：JS/TS 无法保证内存零化（GC 会复制字符串）。S5 是"尽力而为"，真正的密钥隔离靠 Rust 侧持有 refresh token + Keychain。这一点会写进文档而不是假装解决了。

---

## 6. 关键数据流

### 6.1 首次登录 + 解锁

```
用户输入 [服务器地址] [邮箱] [主密码]
   │
   ├─► GET  /api/config                        → 确认服务端可用、拿到各端点 URL
   ├─► POST /identity/accounts/prelogin {email} → { Kdf, KdfIterations, ... }
   │
   ├─ 本地派生 masterKey / masterPasswordHash（主密码不出设备）
   │
   ├─► POST /identity/connect/token (grant_type=password, deviceType, deviceIdentifier...)
   │      ├─ 400 + TwoFactorProviders → 弹 2FA 输入 → 重试
   │      └─ 200 → { access_token, refresh_token, Key, PrivateKey, Kdf... }
   │
   ├─ 本地：userKey = decrypt(Key, stretchedMasterKey)
   ├─► GET  /api/sync → { ciphers[], folders[], profile }
   ├─ 本地：逐条解密 → VaultItem[]（仅内存）
   ▼
解锁完成，进入主界面
```

### 6.2 保存一条新登录

```
用户在详情面板点「新建」→ 填写 → 保存
   ├─ 本地用条目密钥（或 userKey）加密各字段 → CipherRequest
   ├─► POST /api/ciphers
   ├─ 乐观更新本地列表（立即出现在 UI）
   └─ 失败 → 回滚并提示（保留用户输入，不丢数据）
```

### 6.3 扩展自动填充

```
页面加载 → content script 识别登录表单 → 通知 background
   ├─ background 按域名匹配条目
   ├─ popup 显示匹配项（需要用户已解锁）
   └─ 用户点击填充
        ├─ background 通过本地 IPC 向桌面 App 取明文（或用自己的会话）
        ├─ 通过 chrome.scripting 直接把值写入 DOM（值不经过 content script）
        └─ 捕获提交 → 若密码是新的 → 提示保存/更新
```

---

## 7. UI/UX 设计

### 7.1 设计语言

**气质关键词**：沉静、精确、可信、不喧哗。安全工具不该看起来像营销页面。

- **布局**：经典三栏 —— 侧栏（分类）/ 列表 / 详情。这个结构经过验证，一眼可扫，直接采用。
- **配色**：中性灰底 + 单一强调色。强调色用**深青蓝**（区别于 1Password 的品牌蓝，保持自有识别度）。语义色仅用于安全状态（弱/重复/泄露）。
- **排版**：系统字体栈（SF Pro / Inter 回退），标题克制，正文 14px 起。等宽字体用于密码与 TOTP。
- **形状**：8–10px 圆角，1px 低对比边框，极轻阴影。层次靠间距和边框而非重阴影。
- **动效**：120–200ms，只用透明度与位移。密码揭示、复制反馈、锁定过渡三处有动效，其余保持静默。尊重 `prefers-reduced-motion`。
- **图标**：条目优先显示网站 favicon（本地缓存），回退到类型图标。**不使用 1Password 的任何图标资产**。

### 7.2 核心界面

| 界面 | 要点 |
|---|---|
| **欢迎/服务器配置** | 单输入框问服务器地址，带"我该填什么？"说明。避免一上来就给用户一堆选项 |
| **解锁屏** | 居中、大输入框、清晰的头像/邮箱。错误提示明确区分「密码错」和「连不上服务器」 |
| **主界面** | 三栏。侧栏：全部/收藏/文件夹/安全报告。列表：图标+标题+副标题，键盘上下可选。详情：字段按「可复制」设计 |
| **SecretField** | 默认遮蔽。悬停显示 👁 与 📋。复制后 30s 倒计时环 + 可撤销。**永不默认明文** |
| **快速搜索** | `Cmd+Shift+Space` 全局呼出无边框浮窗。输入即搜，方向键选择，回车复制密码 |
| **编辑** | **详情面板内联编辑**，不跳页。字段可增删拖拽排序 |
| **密码生成器** | 两个 Tab（随机密码 / 易记口令），3 个预设（强/均衡/易输入），一个长度滑杆，实时强度与熵值 |
| **安全报告** | 三个卡片：弱密码 / 重复使用 / 已泄露。点进去是条目列表，可逐个跳转修改 |
| **锁定态** | 全局遮罩 + 剩余时间倒计时，点击立即解锁 |

### 7.4 原生窗口自动填充（桌面端的核心差异化功能）

用户明确指出：**「1Password 支持桌面原生窗口的自动补全，看能不能也加上。
这样在客户端侧把体验做到最好，用户才会认可」**。这是桌面端最重要的一项功能，
不是锦上添花 —— 浏览器扩展只能覆盖网页，而用户日常有大量密码输在原生应用里
（邮件客户端、SSH、数据库工具、游戏启动器、系统设置）。

**技术路径**（与 passkey 的关键区别）：

| | 需要的机制 | Tauri 能否做到 |
|---|---|---|
| Passkey（系统级） | 苹果**凭证提供程序扩展**（独立 Swift target + 签名 bundle） | ❌ 打包结构不支持 |
| **原生自动填充** | **辅助功能 API**（macOS `AXUIElement` / Windows UI Automation） | ✅ Rust 后端可调用 |

**基本工作方式**：全局快捷键触发 → 读取当前聚焦的 UI 元素 → 在保险库里匹配
当前应用 → 用户选择条目 → 把值写回目标字段（`AXUIElementSetAttributeValue`，
失败时回退为聚焦后合成按键）。

**⚠️ 安全设计是这个功能的前提，不是附属品。**
一个能读写其他应用输入框的密码管理器，在能力上与间谍软件无法区分。
而且 1Password 自己在这个边界上出过**三次安全公告**（进程校验绕过、XPC 校验不足、降级攻击），
说明这是真实且高价值的攻击面。

**两条硬约束（不变量，不是实现细节）：**

> **I1. AX 读取只在用户按下快捷键之后发生一次，绝不在后台。**
> 不轮询、不挂观察者、不缓存。这一条就是「工具」与「间谍软件」的分界，
> 而且是最容易向用户解释的一条。**任何实现都不得违反它。**
>
> **I2. 写入之后必须读回验证。**
> `AXUIElementSetAttributeValue` 有文档记载会**静默失败**（返回成功但值没写进去）。
> **报「已填充」但实际没填，比响亮地失败更糟。**

其余安全要求：

1. **按代码签名（bundle ID + Team ID）绑定条目与应用** —— 绝不用应用名、窗口标题或 PID。
   写入前**立即重新验证**，前台应用变了就中止
2. 界面上显示的目标应用名与图标必须来自操作系统，不能来自应用能影响的东西
3. 首次填入某应用需要显式确认；代码签名变了就拒绝
4. **「自动提交」对原生填充默认为关**（浏览器场景 1Password 默认开，但原生没有表单语义可校验）
5. **必须解锁才能填充**；考虑填充后 N 分钟重新锁定
6. 日志只记录：时间戳、目标 bundle ID、动作、结果、错误码、条目 uuid
   —— **绝不记录密码、用户名、字段内容、窗口标题**

**分期（MVP 刻意做得很小）：**

| 阶段 | 内容 | 相对成本 |
|---|---|---|
| **MVP** | **只做全局快捷键 + 自动输入，完全不做字段检测** | ~0.5x |
| 阶段 1 | 应用感知（只读前景应用那**一个属性**）+ 条目↔应用链接 | 小 |
| 阶段 2 | 字段检测 + 直接填充（含 Electron 激活、读回验证） | ~2–3x |
| 阶段 3 | Windows | macOS 基础上 ~1.5x |
| 阶段 4 | Linux | 1–2x，置信度低 |

**MVP 为什么这样切**：它是 KeePassXC 和 Bitwarden(Windows) 验证过的模型，
在任何接受键盘输入的应用里都能用，不需要字段启发式，只需要 PostEvent 权限。
**交付约 60–70% 的用户可感价值，且完全绕开「读取其他应用输入框」这个最难的隐私叙事。**

> 对比参考：**浏览器扩展的自动填充是 1x** —— DOM 标准化、字段是声明式的、
> 有 `autocomplete` 属性。原生填充阶段 2 约是它的 2–3 倍。

**⚠️ 上架 Mac App Store 基本不可能** —— 第三方沙箱应用拿不到按进程的辅助功能服务。
走 **Developer ID 签名 + 公证**。

**已知限制**（如实告知用户，不要等他们踩坑）：
- **永远做不到**：Windows UAC 提示与安全桌面、Windows 上提升权限的应用
  （**没有用户可授予的权限能解决**）、wlroots/Hyprland 下的 Wayland 按键合成、
  游戏与自绘 UI（没有可访问性树）
- **时好时坏**：Electron/Chromium 应用（需先激活可访问性）、Java/Qt/Flutter 应用、
  开了「安全键盘输入」的终端
- **权限成本**：手动授予辅助功能权限，且 macOS 26 上**可能无法弹窗引导**；
  开发期需固定签名身份否则每次重编都要重新授权

> 完整技术依据、错误码、Rust crate 选型与安全不变量见
> `docs/reference/native-autofill.md`。

### 7.3 相对 1Password 的简化（有意为之）

| 1Password | Coffer | 为什么更好 |
|---|---|---|
| 账户 + 多个 Vault 双层结构 | **单账户单库 + 文件夹** | 个人用户理解不了"Vault"是什么。Vaultwarden 原生模型就是文件夹 |
| 文件夹 **和** 标签两套组织方式 | **只有文件夹** | 两套并存是认知负担。映射服务端原生模型 |
| 独立的「验证器」板块 | **TOTP 直接内联在登录条目上** | 用户找的是"GitHub 的密码"，验证码就在旁边，不用切板块 |
| Watchtower 六类报告 | **三类**（弱/重复/泄露） | 三类覆盖 95% 价值，六类让人不想看 |
| 编辑跳转到独立页面 | **详情面板内联编辑** | 少一个模式切换 |
| 保存时弹窗问"更新还是新建" | **按域名自动判定，默认更新，可撤销** | 少一次打断 |

---

## 8. 测试与验证策略

分层，从最可靠到最贴近真实：

1. **密码学测试向量**（`crypto`）
   - 往返测试：加密→解密
   - 已知答案测试（KAT）：固定主密码 + 固定 KDF 参数 → 固定的 masterKey / hash / stretched key
   - 边界：空串、超长文本、Unicode、二进制
   - 篡改检测：改动 MAC 的任一 bit 必须解密失败

2. **🔑 互操作测试（最重要）** — `scripts/interop-test.ts`
   - 用**我们的代码**注册用户 + 写入条目 → 用**官方 Bitwarden CLI** 读取，验证能正确解密
   - 反向：官方 CLI 写入 → 我们的代码读取并解密
   - 这是唯一能证明"密码学真的对"的方法。**没有它，其他测试都只是自我一致**

   > ⚠️ **为什么这是不可省略的**：经源码核实，**Vaultwarden 服务端完全不实现客户端密码学**——它把用户密钥（`akey`）与私钥当作不透明字符串原样存储和转发，从不解析 EncString、不做 MAC 校验、不做任何长度检查。也就是说，**我们即使把加密写错，服务端也会静默接受**，直到用户某天发现密码解不开。服务端提供的是**零验证**。因此互操作测试是唯一能发现密码学错误的手段，不是"锦上添花的加分项"。

3. **API 契约测试**（`api`）— 对真实 Vaultwarden 实例跑 CRUD，验证字段名/状态码/错误格式

4. **领域单元测试**（`vault`）— 用内存版 fake API，测同步合并、乐观更新回滚、搜索排序、锁定清空

5. **UI 组件测试** — Testing Library，重点测键盘可达性与 SecretField 的遮蔽行为

6. **端到端**（Playwright）— 关键路径：首次配置 → 登录 → 解锁 → 新建 → 搜索 → 复制 → 锁定 → 重新解锁

7. **安全断言测试** — 一个专门的测试：执行完整流程后，扫描所有持久化存储，断言不含任何明文密码

---

## 9. 里程碑

| # | 里程碑 | 产出 | 验证方式 |
|---|---|---|---|
| M1 | 基础设施 | monorepo、本地 Vaultwarden、CI 骨架 | `dev-server.sh` 能起服务并注册用户 |
| M2 | 密码学核心 | `@coffer/crypto` 全绿 | 与官方 CLI 互操作测试通过 |
| M3 | API 客户端 | `@coffer/api` | 对真机跑通登录/同步/CRUD 契约测试 |
| M4 | 领域层 | `@coffer/vault` | 同步/搜索/生成器/TOTP 单测全绿 |
| M5 | 桌面 App | 可用的完整桌面客户端 | 端到端 Playwright 通过，能日常使用 |
| M6 | 浏览器扩展 | 自动填充 | 在真实网站完成填充 |
| M7 | 打磨 | 安全报告、i18n、暗色、无障碍 | 安全断言测试 + 无障碍审计 |

**每个里程碑都要能独立跑通并验证**，不做"三个里程碑一起才能看到效果"的规划。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 密码学实现细节理解错 | 数据解不开 = 项目失败 | **互操作测试作为主验证手段**，M2 必须通过才继续 |
| Argon2id 参数单位理解错（KiB vs MiB） | 用 Argon2 的账户登录失败 | 用固定向量验证；同时用 PBKDF2 账户做对照 |
| Vaultwarden 与官方服务端行为差异 | 换服务器后失效 | 契约测试直接打 Vaultwarden；协议层做好能力探测 |
| Tauri WebView 的 WebCrypto 支持差异 | 加密不可用 | 早期就在 Tauri 里跑 crypto 测试验证 |
| 明文泄漏到磁盘 | 严重安全事件 | 安全断言测试纳入 CI，任何新增持久化都要过这道关 |
| 范围蔓延（想做的太多） | 做不完 | 第 2 节的非目标清单是硬约束 |

---

## 11. 待确认

- **产品命名**：`Coffer` 为占位名（含义：保险箱），仅出现在品牌位与文案，改名成本 = 改一个常量 + i18n 词条。
- **界面语言**：默认 `zh-CN`，内置 `en`，i18n 架构一开始就搭好。
- **服务端**：开发用本地编译的 Vaultwarden；生产用用户提供的实例（稍后接入）。
