# 原生窗口自动填充 —— 可行性与实现依据

> 来源：对 Apple SDK 头文件、1Password 官方文档、Electron/Chromium/Microsoft 文档、
> KeePassXC 与 Bitwarden 的**发布源码**、OSV/GitHub 安全公告库的直接查阅。
> 目标系统实测为 macOS 26.6.2 (Tahoe) arm64。

---

## 1. ⚠️ 先纠正一个我写错的假设

我原先在 spec 里把 macOS 的两种机制混为一谈了。**它们是两个完全独立的功能：**

| | 机制 | 覆盖范围 |
|---|---|---|
| **A. Universal Autofill** | **辅助功能 API**（`AXUIElement`） | **任意原生应用**的自定义登录框 ← 我们要的 |
| B. 系统 AutoFill | **凭证提供程序扩展**（Credential Provider） | 只用系统凭证 UI 的应用：Safari、passkey |

**关键点**：凭证提供程序扩展**够不到**任意原生应用的自定义表单。
1Password 填原生应用走的是**辅助功能**这条路。

**这对我们是好消息** —— 辅助功能 API 在 Tauri 的 Rust 后端可以直接调，
不需要任何 App Extension。**iOS 那边才需要扩展，macOS 桌面端不需要。**

---

## 2. macOS 实现细节

### 2.1 权限（有个 macOS 26 的新问题）

用户要在**系统设置 → 隐私与安全性 → 辅助功能**里手动授权，按应用的**代码签名身份**记录。

**⚠️ macOS 26 上的新情况**：从本机 `tccd` 里提取的字符串显示：

```
Service kTCCServiceAccessibility does not allow prompting; returning preflight_unknown
Service %{public}@ does not allow prompting for unentitled binaries; returning denied.
```

也就是说**弹窗提示这条路在 macOS 26 上可能已经不可靠了**。

**应对**：不要依赖 `AXIsProcessTrustedWithOptions` 的弹窗。
设计成：检查 `AXIsProcessTrusted()` → 若为假，**解释清楚**并深链到
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`。

**开发期的坑**：未签名/ad-hoc 签名的构建没有稳定身份，**每次重新编译授权都会失效**。
开发时要固定签名身份，否则会反复手动授权。

**还有一个容易被忽视的权限**：合成按键归 `CGEventPost` 管，是**另一个 TCC 服务**（PostEvent）。
另外读窗口标题若走 `CGWindowListCopyWindowInfo` 需要**屏幕录制**权限 ——
**改用 AX 的 `kAXTitleAttribute` 读，可以避开这个权限。**

### 2.2 读取聚焦元素

```
AXUIElementCreateSystemWide() → kAXFocusedUIElementAttribute / kAXFocusedApplicationAttribute
AXUIElementGetPid() → 拿到是哪个应用
```

**必须处理的三个坑**：

1. **超时**：`AXUIElementSetMessagingTimeout` —— **每个真实实现都设了它**。
   不设的话，一个卡住的目标应用会把我们阻塞住。启动时全局设 0.5–1 秒。
2. **元素失效**：焦点可能在两次调用之间变化，会返回 `kAXErrorInvalidUIElement` (-25202)。
   不要缓存，重新读。
3. 其它要处理的错误码：`kAXErrorCannotComplete` (-25204)、`kAXErrorAttributeUnsupported` (-25205)、
   `kAXErrorAPIDisabled` (-25211)。

### 2.3 找用户名/密码框

**⚠️ 密码框是 `subrole` 不是 `role`**：

```c
#define kAXTextFieldRole          CFSTR("AXTextField")
#define kAXSecureTextFieldSubrole CFSTR("AXSecureTextField")   // ← 注意是 Subrole
```

所以要**同时检查 role 和 subrole**（少数应用会把它报成 role）。

**⚠️ 没有标准区分用户名和密码框的方法** —— 没有 HTML 里 `autocomplete="username"` 的等价物。
**这是与浏览器自动填充最大的定性差别，也是这个功能成本的主要来源。**

### 2.4 ⚠️ 写入会**静默失败**

Apple 头文件原文：

> *"Writable — Generally yes. However, it does not need to be writable if some other form of
> direct manipulation is more appropriate for causing a value change."*

Hammerspoon 的文档更直白：

> *"the element may not be settable (surprisingly this does not return an error,
> even when `isAttributeSettable` returns false)"*

**所以必须按这个顺序做：**

1. `AXUIElementIsAttributeSettable()` 先问能不能写
2. `AXUIElementSetAttributeValue()`
3. **读回来验证** —— 这是唯一可靠的检查
4. 失败则回退：聚焦该字段 → 合成按键

> **一个报告「已填充」但实际没填的密码管理器，比一个响亮失败的更糟。**

### 2.5 ⚠️ Electron 和 Chromium 应用的可访问性树默认是**隐藏的**

**这条会在第一时间咬到我们** —— 大量应用的登录窗口是 Electron 写的。

Electron 官方文档说明：应用只在**检测到辅助技术存在时**才启用可访问性。有两个不同的激活属性：

| 应用类型 | 需要设置的属性 |
|---|---|
| Electron 应用 | `AXManualAccessibility`（Electron 自己加的，Chromium 里根本没有） |
| Chrome / Edge | `AXEnhancedUserInterface`（Chromium 内部属性） |

**实用规则：遍历树之前先检查是否为空，若为空则设置相应激活属性后重查。**

| 应用类型 | 可访问性支持 |
|---|---|
| 原生 AppKit | 最好 |
| Electron / Chromium | **需先激活**（见上） |
| Java (Swing/AWT) | 部分，历史上较弱 |
| Qt | 通常可用 |
| Flutter | 惰性构建语义树 |
| 游戏 / 自绘 UI | **完全没有树** |

### 2.6 Rust 侧

**推荐 `accessibility-sys` 0.2.0**（MIT/Apache-2.0）—— 需要的函数和常量全都有，
而且野外发现的 8 个真实 Tauri 应用用的就是它。

备选 `objc2-application-services` 0.3.2，签名更好看，但**两个坑**：
`kAX*` 字符串常量**没有绑定**（要硬编码 `"AXValue"` 等）；
`objc2-accessibility` 是**另一个完全不同的框架**，一个 `AXUIElement` 都没有。

**按键合成用 `core-graphics` 0.25**。注意两个 macOS 上的地雷：
`CGEventKeyboardSetUnicodeString` **在 20 个字符处截断**；
`set_string` 在**区块以 `\n`/`\t`/`\r` 开头时会静默失败**。

**不要用**：`rdev`（2023-06 后无更新）、`inputbot`（**根本没有 macOS 模块**）、
`device_query`（仓库 2026-03 归档）。

### 2.7 ⚠️ Tauri 的线程陷阱

Tauri 文档原文：

> *"Commands without the `async` keyword are executed on the **main thread**."*

而 AX 调用是**带超时的同步 IPC**。所以一个同步的 `#[tauri::command]`
会在目标应用卡住时**阻塞 Tauri 的 UI 线程**。

**所有碰 AX 的 command 都必须是 async**，并且要设 `AXUIElementSetMessagingTimeout`。
这是两道防线，缺一不可。

---

## 3. 安全设计（这个功能的真正难点）

### 3.1 1Password 自己在这个边界上出过事

| 编号 | 问题 |
|---|---|
| GHSA-p8g3-hwcg-gr94 | **进程校验绕过** —— 同机恶意软件可在 1Password 解锁时窃取机密 |
| GHSA-q3fp-vrq4-532q | **XPC 进程间通信校验不足** —— 本地攻击者可窃取保险库条目 |
| CVE-2024-42218 | **降级攻击** —— 加载旧版 1Password 绕过 macOS 保护 |

**教训：接受填充请求的那个边界是最高价值的攻击面，必须用密码学方式验证身份，绝不用名字或 PID。**

### 3.2 1Password 的做法（可借鉴）

- **每次填充都需要用户操作** —— 官方明确说这是**反钓鱼机制**：「1Password 永远不会在没有你输入的情况下自动填充，即使只有一个候选项」
- **无法验证目标时弹出显式同意框**（仅此一次 / 始终允许 / 取消），"始终允许"会写入**应用↔条目的链接**
- **填充前验证代码签名** —— 并且**拒绝填充进未签名的 Chromium**
- 敏感条目类型有**额外确认**

### 3.3 我们要写的安全不变量

1. **绝不在后台读取 AX 树。** 不轮询、不挂观察者。只在用户按下快捷键后读**一次**聚焦元素。
   —— 这一条就把这个功能和间谍软件区分开了，也是最好向用户解释的。
2. **按代码签名（bundle ID + Team ID）绑定条目与应用**，绝不用应用名、窗口标题或 PID。
   写入前**立即重新验证**，前台应用变了就中止。（Bitwarden 在 Windows 上就是这么做的：
   `active application changed since verification; cancelling.`）
3. **界面上显示的目标应用名与图标必须来自操作系统**（`NSRunningApplication`），
   不能来自任何应用能影响的东西。
4. **首次填入某应用需要确认**；代码签名变了就拒绝填充。
5. **「自动提交」对原生填充默认为关。** 浏览器场景 1Password 默认开，
   但原生场景没有 HTML 表单语义可供校验，风险不同。
6. **必须解锁才能填充**（不可协商）；考虑填充后 N 分钟重新锁定。
7. **日志只记录**：时间戳、目标 bundle ID、动作、结果、AX 错误码、条目 uuid。
   **绝不记录**：密码、用户名、字段内容、窗口标题、AX 树。

> **可选的本地填充审计日志**（用户可查看）是一个真正的差异点，而且很便宜。

### 3.4 ⚠️ 上架 Mac App Store 基本不可能

本机沙箱配置显示：第三方沙箱应用只被允许访问 `com.apple.iphone.axserver-systemwide`
（iPhone 投屏用），**拿不到按进程的 `com.apple.axserver`**。
这与 1Password 8 Mac 只走直接下载是吻合的。

**结论：走 Developer ID 签名 + 公证，不做 MAS。**

---

## 4. Windows 与 Linux

### Windows：可行但有**三道走不通的墙**

- **提升权限的应用（高完整性级别）** —— 中等完整性的进程**看不到**，而且**用户无法授予任何权限**来修复
- **UAC 安全桌面** —— 只有 Windows 进程能访问。**永远不要承诺能在 UAC 提示里填充**
- 替代方案 `UIAccess` 微软明确说「不应被非辅助技术类应用使用」，且需要 Authenticode 签名 + 装进 Program Files

**关键差异**：Windows **没有** macOS 辅助功能那种用户可授予的权限门。
真正的门槛是**完整性级别**。

**实现要点**：UIA 必须在**独立的 MTA 线程**上调用（且该线程不拥有窗口），
这在 Tauri 里需要专门设计。`SendInput` **不会重置键盘状态** ——
用户还按着我们的快捷键，所以要**只发修饰键的释放事件**。

**实际先例**：**Bitwarden 和 KeePassXC 都用 `SendInput` + unicode 扫描码，都不用 UIA 直接设值。**

### Linux：比想象中更碎，而且**先例是负面的**

- **Bitwarden 根本没有 Linux 自动填充** —— 源码里就是 `todo!("Bitwarden does not yet support Linux autotype")`，macOS 也是 `todo!()`
- **KeePassXC 2026-06 才支持 Wayland 自动填充**（issue 开了 8 年），代价是：
  `hasWindowAccess()` 返回 **false**、`windowTitles()` 返回空、`activeWindow()` 返回 **-1**，
  窗口标题和 URL 匹配的设置项**在 UI 里被隐藏了** —— **在 Wayland 下它根本不知道你在哪个应用里**
- Wayland 合成按键要走 **RemoteDesktop portal**，只存在于 GNOME 和 KDE；
  **wlroots（sway/river）和 Hyprland 根本没有这个 portal**
- GNOME 50 已完全移除 X11 会话，XTest 路线只剩 XWayland 应用

**结论：Linux 远期再说，且要如实告知其天花板。**

---

## 5. 分期方案（重要 —— MVP 可以很小）

### 🎯 最小可用版：**只做全局快捷键 + 自动输入，完全不做字段检测**

1. 全局快捷键（不需要辅助功能权限）
2. 呼出可搜索的快速面板
3. 选中后**输入用户名 → Tab → 密码**到当前焦点，用 CGEvent 合成按键
4. 可选自动提交

**这是 KeePassXC 和 Bitwarden(Windows) 验证过的模型**，在任何接受键盘输入的应用里都能用，
不需要字段启发式，只需要 PostEvent 权限。

**它交付了大约 60–70% 的用户可感价值，只花很小一部分成本，
而且完全绕开了「读取其他应用输入框」这个最难的隐私叙事。**

### 后续分期

| 阶段 | 内容 | 相对成本 |
|---|---|---|
| **MVP** | 快捷键 + 自动输入 | **约 0.5x**（以浏览器扩展自动填充为 1x） |
| 阶段 1 | 应用感知（只读前景应用那**一个属性**）+ 条目↔应用链接 | 小 |
| 阶段 2 | 字段检测 + 直接填充（含 Electron 激活、读回验证） | **约 2–3x** |
| 阶段 3 | Windows | 在 macOS 基础上 **约 1.5x** |
| 阶段 4 | Linux | 约 1–2x，**置信度低** |

> 对比：浏览器扩展的自动填充是 **1x** —— DOM 是标准化的、字段是声明式的、
> 有 `autocomplete` 属性可用。**它明显比原生便宜。**

---

## 6. 做不到的事（要如实告知用户，不要等他们踩坑）

**永远做不到：**
- Windows UAC 提示 / 安全桌面
- Windows 上提升权限的应用（**没有用户可授予的权限能解决**）
- 以 System 完整性级别运行的应用
- wlroots/Hyprland 下的 Wayland 按键合成（**没有 portal 存在**）
- 游戏、Unity/Unreal、自绘 UI（**没有可访问性树**）
- 没有 TTY 机制的 `sudo`/终端提示（1Password 自己也得用 Apple Events 自动化才行）

**时好时坏，需要逐应用测试：**
- Electron / Chromium 应用（要先激活，见 §2.5）
- Java / Qt / Flutter 应用（树不完整）
- **直接给安全字段设值** —— **未经验证**，且有文档记载会静默失败
- 读回被填充的安全字段做验证 —— 可能被掩码
- 开了「安全键盘输入」的终端

**必须提前告知的成本：**
- 需要用户手动授予辅助功能权限，且 macOS 26 上**可能无法弹窗引导**
- 终端需要额外一个 Automation（Apple Events）权限
- **开发期需固定签名身份**，否则每次重编都要重新授权
- **基本告别 Mac App Store**

---

## 7. 待实测（不能靠推理，必须真机验证）

1. `AXUIElementSetAttributeValue` 对 `AXSecureTextField` 到底能不能写成功 ——
   **要在原生 AppKit、Electron、Safari/WebKit、Java 四类应用上分别测**
2. macOS 26 上辅助功能授权弹窗到底还出不出得来
3. Developer ID 更新后授权是否真的保留

---

## 8. 对 spec §7.4 的两处修正

1. **加一条不变量**：AX 读取**只在按下快捷键之后**发生，**绝不在后台**。
   这一条就是「工具」与「间谍软件」的分界，值得写进设计文档作为硬约束。
2. **回退路径要加读回验证**：`SetAttributeValue` 之后必须读回来确认。
   该 API 有文档记载会静默失效，**报「已填充」但实际没填是比失败更糟的结果**。

---

## 9. 实现记要（2026-10-05）

按第 5 节的 MVP 路线落地：**只做全局快捷键 + 自动输入，不做字段检测**。

| 位置 | 内容 |
|---|---|
| `src-tauri/src/autotype.rs` | 分块、动作序列、`CGEvent` 合成、权限状态 |
| `src-tauri/src/hotkey.rs` | Carbon `RegisterEventHotKey`（⌘⇧\） |
| `src/autotype.ts` | 调用口与统一的文案常量 |
| `src/components/AutotypeAction.tsx` | 倒计时 → 最小化自己 → 发按键 |

### 落地时确认的几件事

**20 码元截断是真的，而且按「字符数」算会切错。** `CGEventKeyboardSetUnicodeString`
在 20 个 **UTF-16 码元**处截断：19 个 ASCII 加 1 个 emoji 是 20 个字符但 21 个码元。
按字符数分块会在这一步**静默截短密码**，用户只会看到「登录失败」。
`chunk_for_keystrokes` 因此按码元计数，并保证不切开代理对 —— 三条性质都有测试。

**用户名为空时不能发 Tab。** 只发 Tab 会把焦点从用户名框推进密码框，
然后密码被敲进用户名框里。宁可不发，让用户自己在正确的位置开始。

**热键不需要辅助功能权限，但合成按键需要。** 这两件事的权限是分开的，
界面上的引导话术也要分开讲 —— 否则用户会以为授权了热键就等于能自动输入。

**倒计时期间必须让本应用失去焦点**，否则按键会敲进我们自己的窗口。
实现里先 `minimize()` 再等 350ms 再发 —— 把「切窗口」这件事明确交给用户，
而不是偷偷记住上一个前台应用再自动切回去（那在多显示器和全屏空间下行为不一致，
而且用户完全不知道发生了什么）。

### 尚未验证（如实记录）

**辅助功能授权后的真实行为没有实测过。** 需要用户在系统设置里手动勾选，
而开发期的构建每次重编身份都会变、授权随之失效 —— 这正是第 2.1 节预告的成本。

具体没验证的是：`CGEventPost` 打给其他应用是否真的生效；
macOS 26 上授权项是否如预期出现。**在这两点被实测之前，
这个功能只能算「按设计实现」，不能算「可用」。**

另外：`AXIsProcessTrusted()` 只能告诉我们「有没有授权」，
没法告诉我们「授权之后到底能不能用」—— 后者只能在真机上试。
