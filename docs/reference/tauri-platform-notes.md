# Tauri 平台注意事项（桌面 + 移动）

> 来源：对 Tauri CLI 源码的阅读、官方插件源码的阅读、以及社区项目的实证。
> 标注：**[已验证]** = 读过源码或一手来源；**[推断]** = 合理推理未实证；**[未验证]** = 需自行确认。

---

## 1. ⚠️ 直接影响本轮桌面端的三条发现

### 1.1 `tauri-plugin-biometric` **是纯 UI 挡板，没有密码学绑定**

**[已验证 —— 读的是插件源码]**

iOS 侧的实现里，`authenticate()` 成功时调用的是 **`invoke.resolve()` 且不带任何 payload**，
整个文件里**没有任何 Keychain / `SecAccessControl` / `CryptoObject` 代码**。

**这意味着什么**：它只告诉你"用户通过了生物识别"，但**不把任何密钥绑定到这次验证上**。
一个被篡改的前端（或任何能注入 JS 的路径）可以直接跳过这个 gate。

**对我们的影响**：生物识别解锁**不能**建立在这个插件上。正确做法是：
把「生物识别通过」作为**解封 Keychain 条目的条件** ——
即用 `SecAccessControl(.userPresence)` 保护的 Keychain item，
让**操作系统**来强制「必须先通过生物识别才能取出密钥」。
密钥取不出来，绕过 JS gate 也拿不到东西。

### 1.2 `tauri-plugin-stronghold` **已废弃**

**[已验证]** 官方 issue 明确说：*"will not be developed further… will not be available in Tauri v3"*，
上游 `stronghold` crate 也不再维护。**不要采用。**

### 1.3 `tauri-plugin-store` **是明文 JSON**

**[已验证 —— 官方文档明说]** 永远不要用它存任何敏感数据。

**结论**：三个官方存储/生物识别插件都不能直接用于密钥保管。**需要自己写一层**。

**可选方案**（按推荐度）：
1. **自己写 Swift/Kotlin 插件** —— 用 `SecAccessControl(.userPresence)`（iOS）和
   `setUserAuthenticationRequired` + `BiometricPrompt.CryptoObject`（Android）
2. Rust 的 `keyring` 4.2.0（MIT/Apache-2.0，活跃）有真实的 iOS/Android 后端，
   但**它不调用 `setUserAuthenticationRequired`**，因此**不受生物识别保护** [未验证]
3. `impierce/tauri-plugin-keystore` 2.1.0-alpha.2 —— 模式是**对的**
   （iOS `SecAccessControl(.userPresence)`、Android `BiometricPrompt.CryptoObject`），
   但是 alpha 且只有 ~4 星 [未验证]

> **关键区分** [未验证]：Keychain item **不等于** Secure Enclave 密钥。
> 只有用 `kSecAttrTokenIDSecureEnclave` 创建的 EC 密钥才是真正不可导出的。

---

## 2. 移动端（本轮已押后，此处存档）

### 2.1 ✅ iOS 原生扩展**可以**并入 Tauri 工程

**这是之前最大的未知，现在有答案了：[已验证]**

| 问题 | 答案 |
|---|---|
| Tauri 的 iOS 工程能加 app extension 吗？ | **能** |
| `tauri ios init` 会覆盖手工改动吗？ | **不会** —— `ios/project.rs` 只在文件**不存在时**才写模板 |
| `tauri ios build` 会重新生成吗？ | **不会** —— `ios/build.rs` 根本不调用 `project::generate` |

`gen/apple/project.yml` 是一份**可手工编辑的 XcodeGen 规格**。
社区实例：
- `Keyfount/desktop`（MIT）有 `AutofillExtension/CredentialProviderViewController.swift`
  和声明 `type: app-extension` 的 `project.yml` —— 但是个 **WIP spike**（0 star）
- `team-reflect/reflect-open`（MIT）发布了 share + widget 扩展
- `hafgit99/kalderashield` 发布了 Tauri 2 **安卓**的 `AutofillService`

**没有任何已上架 App Store 的先例。** 有机制上的先例，没有产品上的先例。

### 2.2 ⚠️ 但有一个**在关键路径上的未修复 bug**

**[已验证]** [tauri#15663](https://github.com/tauri-apps/tauri/issues/15663)：
使用 App Store Connect API-key 签名时，`build.rs` 的 `skip_signing` 分支
**只对主 app 二进制强制签名**，嵌入的 `.appex` 会在导出时**静默丢失 entitlements**。
**构建会成功，扩展就是不出现。**

### 2.3 ⚠️ 扩展内存上限是**真实约束**

**[已验证]** 苹果不公布具体数值，社区实测约 **120 MB**。
KeePassXC 报告 **128 MB 的 Argon2 会导致 iOS 扩展静默崩溃**。

**设计结论**：**绝不要在扩展里跑 Argon2id**。
在主 App 里解锁一次，把派生出的密钥封进**共享 Keychain**，扩展只负责解密。

### 2.4 ✅ WebCrypto 在 Tauri 移动端是**完整的**

**[已验证 origin/secure-context 推理，设备上为推断]**

- iOS：WKWebView + `tauri://localhost`（WKURLSchemeHandler）
- 安卓：系统 Chromium WebView + `http://tauri.localhost`

两者都被视为**安全上下文**，所以 `crypto.subtle` 可用 ——
**AES-CBC、RSA-OAEP、HMAC-SHA1、SHA-256 全都有**。WASM 也能跑，
所以 `hash-wasm` / Argon2id **可以原样使用**。

**这意味着我们的 TS 核心在移动端无需修改。** 这正是选 Tauri 而非 React Native 的价值：
Hermes 引擎**没有 `crypto`、没有 `crypto.subtle`、也没有 WebAssembly**。

### 2.5 诚实的成熟度评价

**[已验证]** 运行时本身稳定（2.0 于 2024-10 发布 → 2.12 于 2026-09），有真实上架应用。

**但保密相关的部分是幼稚的**：app extension **没有官方文档**（issue 自 2024-04 开着），
每个项目都在逆向；#15663 未修复；唯一的自动填充先例是个 spike；没有官方 keychain 插件。

> **原话**：*"trustworthy enough to hold secrets; not trustworthy enough to make the
> autofill surface framework-supported work. **Budget it as bespoke native code you own forever.**"*

---

## 3. 本轮不采用但要记住的

- React Native 的逃生方案是 `react-native-quick-crypto`（MIT，原生模块，支持 Argon2id），
  但它有个互操作坑：[PR #951](https://github.com/margelo/react-native-quick-crypto/pull/951)
  显示它把 OAEP 哈希默认成了 SHA-256，而 **Node 用的是 SHA-1** ——
  对 Bitwarden 的类型 4 RSA 是致命的。本轮不走 RN，记下备用。

---

## 4. 尚未确认的问题（留给移动端那一轮）

- 苹果是否**自助**授予 autofill entitlement（还是需要人工审核）
- 扩展内存上限的**确切数值**
- 是否有任何 Tauri autofill 扩展**通过过 App Store 审核**
