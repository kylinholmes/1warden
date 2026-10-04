# 1Password → Vaultwarden 映射决策

> 来源：对 1Password 官方文档的调研 + 对 Vaultwarden 源码的核实。
> 本文档记录**会改变架构的决策**，以及**做不到的事**（诚实清单）。
>
> ⚠️ 状态：密码生成器 / Watchtower / TOTP / URL 匹配四节仍待补强（当前证据为二手）。

---

## 1. 已经确定、且影响架构的五个决策

### 决策 1：Archive/Trash 用一个三态表达，但配套逻辑要自己写

1Password 有 **Archive** 和 **Trash** 两个独立状态。Vaultwarden 用 `deletedDate`（回收站）和较新的 `archivedDate`（归档）表达。

**要做的事**：
- 模型上用三态：`活跃 / 已归档 / 已删除`（`archivedDate != null` 与 `deletedDate != null`）
- **`/api/sync` 会返回已删除和已归档的条目** —— 服务端不做过滤，**分区必须客户端做**
- **搜索与自动填充必须排除这两类** —— 服务端不会帮你排除
- 设 `TRASH_AUTO_DELETE_DAYS=30` 以匹配 1Password 的 30 天回收站语义
  （Vaultwarden 默认**从不**自动清空回收站 —— 不设的话用户会发现"删了的密码永远在"）

### 决策 2：1Password 的 Vault → Bitwarden 的 Folder

1Password 的 Vault 是带权限的硬容器；Bitwarden 个人账户只有扁平的 Folder（无权限）。

对**单用户个人库**：`Vault → Folder`，一对一，无信息损失。
组织 + Collections 在 Vaultwarden 上确实能用，但涉及组织密钥的 RSA 包装链路，
对单人用户不值得 —— 非目标。

### 决策 3：Tags 和 Section 都用 custom field 表达

Bitwarden **没有**标签，也没有编辑器里的"分区"概念。两者都借用 `fields[]`：

| 1Password 概念 | 实现方式 |
|---|---|
| 标签（一个条目多个） | 命名空间化的 Hidden/Text 自定义字段 |
| 编辑器的分区 | `type: 0` 的标记字段 |

⚠️ **只能发 `type` 0–3**（Text/Hidden/Boolean/Linked）。
Vaultwarden 在 `type` 缺失或不可解析时回退到 **1（Hidden）** ——
这是为了防止意外泄露，但会让本该可见的字段变成隐藏。

⚠️ **往返风险**：这些是借用约定，不是协议的一部分。数据经官方客户端走一圈后
能否保持，需要实测。**不要把不经过往返验证的约定当成稳定存储。**

### 决策 4：Secret Key 没有对应物 —— 这是无法绕过的一处差距

1Password 的 Secret Key 是 128 位、存在 Emergency Kit 里的第二因子，
与主密码**共同**派生账户密钥 —— 也就是说**光有主密码不足以解密**。
服务端拿到的任何东西都不足以暴力破解弱主密码。

Bitwarden/Vaultwarden 的模型是：**主密码单独决定一切**。
服务端存的是 `PBKDF2(masterPasswordHash, server_salt, N)`，
安全强度完全取决于主密码本身和服务端的 KDF 迭代数。

**结论**：保持 Bitwarden 互操作就**无法**实现 Secret Key 等价物。这是架构性差距，不是工程量问题。

**对策**（诚实版本）：
- 默认使用 **Argon2id**（而非 PBKDF2）创建账户
- 强主密码校验 + 明确的强度提示
- **文案上如实说明**：没有 Secret Key 这层保护 —— 不要暗示有

### 决策 5：Passkey 只在浏览器扩展做，桌面端不做系统级支持

这是**最容易低估工作量**的一项。1Password 在各平台是靠**操作系统级集成点**提供 passkey 的：

| 平台 | 机制 | 门槛 |
|---|---|---|
| macOS | **Credential Provider 扩展** | macOS 14+，需要签名 bundle + Swift/ObjC 扩展 target |
| Windows | 系统 passkey provider API | **Windows 11 + MSIX 打包** |
| Linux | **完全不支持** | 1Password 自己也不支持 |
| 浏览器扩展 | 浏览器自身的 WebAuthn 流程 | 无 OS 门槛 ✅ |

**Tauri 给不了 Credential Provider 扩展** —— 那是一个独立的 Swift/ObjC target，
外加签名与发布流程的改动。这是**打包结构问题，不是一个功能开关**。

**结论**：
- ✅ 浏览器扩展里的 passkey：可行（本质是 WebAuthn + 密码学问题，我们已有的能力）
- ⚠️ 桌面端系统级 passkey：**单独立项，v1 不要承诺**
- ⭕ Linux：无对标对象

**好消息**：这是全表里**唯一一处 1:1 干净映射** ——
1Password 的 passkey 存在 Login 条目的 passkey 字段里（无独立条目类型），
Bitwarden 的 `login.fido2Credentials[]` 结构完全相同。无映射决策要做。

---

## 2. 做不到的事（诚实清单）

| 1Password 能力 | 能否实现 | 替代方案与用户可见差异 |
|---|---|---|
| **Secret Key** | ❌ 不可能 | 见决策 4。差异是真实的安全强度差距 |
| **系统级 passkey（桌面）** | ❌ v1 不做 | 需原生扩展 + 特殊打包。扩展内可用 |
| **多 Vault 带权限** | ❌ 非目标 | 用文件夹；个人用户无权限需求 |
| **标签** | 🔧 借用自定义字段 | 经官方客户端往返后是否保持**待实测** |
| **Watchtower** | 🔧 全客户端实现 | 服务端 `/api/reports/*` 完全不存在 |
| **TOTP 生成** | 🔧 全客户端实现 | 服务端无任何 TOTP 端点 |
| **密码生成** | 🔧 全客户端实现 | 服务端无生成器端点 |
| **1Password 桌面导出 passkey** | ❌ 谁都做不到 | 1PUX/CSV **静默丢弃** passkey，官方也只支持 iOS/Android 用 CXP 标准迁移 |
| **Travel Mode** | ❌ 不可能 | 服务端无此概念 |
| **新设备验证** | ⚠️ Vaultwarden 未实现 | 端点存在但是 stub，恒返回 disabled |

---

## 3. 额外发现：新版官方 CLI 与 Vaultwarden 不兼容

`@bitwarden/cli` **2026.x** 登录后会执行「用户密钥 ID 回填」迁移，
调用 Vaultwarden 未实现的端点（`/api/accounts/key-management/user-key-id`）而失败
（`KeyIdBackfillError`，404）。登录**本身**是成功的，失败发生在登录之后。

这不是我们的 bug，而是**上游的兼容性缺口** —— 真实用户用新版 CLI 或新版官方客户端
对接自建 Vaultwarden 时会撞到。值得写进产品文档的"已知问题"。

对我们的客户端而言：**不要调用这个端点**。

---

## 4. 待补强

以下四节目前只有二手证据，正在用一手来源补：
- 密码生成器的模式与默认值
- Watchtower 的报告类别清单
- TOTP 在条目编辑器里的位置与扫码流程
- 扩展的自动填充交互细节与 URL 匹配规则
