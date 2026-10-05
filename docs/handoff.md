# 交接：Coffer（个人密码管理器）

> 写给接手的人（或 AI）。重点在**没做完的部分**和**会浪费你时间的坑**。
> 已完成的部分在 `docs/restructure-plan.md` 里有更细的过程记录。

## 一、这是什么 / 目标

一个**面向普通个人用户**的密码管理器：

- **UI 和功能上参考或复刻 1Password**（不是 Bitwarden 那种企业向的界面）
- **后端对接 Vaultwarden**（自建服务器）
- 仓库是空项目起步，**主要由 AI 驱动**

## 二、需求（用户原话，优先级按出现顺序）

| 原话 | 含义 |
|---|---|
| 「PC版我调整窗口大小成 竖向的, 是否可以自动对于调整UI和布局… 这个逻辑直接应用到拓展和移动端上, 他们就是从横屏 调整到了竖屏的 PC端」 | **验收判据**：布局靠容器查询自适应；扩展和移动端是同一套逻辑的另外两个宽度档 |
| 「不同端的UI本质上是一个东西」 | 三端**渲染同一份代码**，不是三份长得像的代码 |
| 「拓展端不是单独的UI, 就是同一套」 | 同上，用户对当前状态**不满意**（见第六节） |
| 「不是重写来的」 | 要**抽取**，不要重写。把已有的那份搬进共享包，两端都用它 |
| 「UI要完全一致, 我看你改半天也没改好」 | 端之间的可见差异 = bug |
| 「全部做，有区别吗? 还先做哪个?」 | 都要做，不要挑 |

## 三、硬约束（违反了就是错的）

| 约束 | 出处 |
|---|---|
| **主密码必须服务端校验**，没有离线解锁路径 | 删过一次本地 `wrappedUserKey`：服务端改了密码，本地缓存仍能用旧密码打开 |
| **明文密钥/密码绝不落盘**（spec 不变量 S1）；**扩展弹窗只收摘要** | 这是共享列表按「摘要」而不是 `VaultItem` 设计的**原因** |
| **不用 Tauri 插件**，自己写 | 「他们问题更大」 |
| **吃性能/调用频繁的地方用 Rust，不用 TS** | |
| 提交署名 `DeepSeek-Flash <deepseek@deepseek.com>` | 绝不署 Claude |
| 「1Password 那套」是设计参照，但要**走出自己的特色** | 借鉴不克隆 |

## 四、架构现状

```
packages/
  crypto/   WebAssembly 密钥派生、加解密
  vault/    领域层：DTO↔领域模型、会话状态机、同步、搜索、Watchtower、TOTP
  ui/       共享组件 + theme.css + components.css   ← 三端共用的是这里
apps/desktop/            ← **只有一个 app 目录**（旧的 apps/extension 已删）
  src/                   桌面端（Tauri 壳，也是三端共享源码的所在）
  extension/             扩展端专属运行时（background / content / popup）
  preview/               桌面预览仪器
  preview-extension/     扩展预览仪器（假 chrome.*）
  src-tauri/             Rust 壳
  vite*.config.ts        5 个构建配置 + mobile
```

- **`__PLATFORM__`** 是**编译期**常量（`'desktop' | 'extension' | 'mobile'`），
  各构建配置各自 `define`。它管**能力分支**，不管「构建哪份代码」。
  实测过：桌面专属代码**不进**移动端产物。
- **`Host` 接口**（`fetch` + `storage`）是仅有的两处真实平台差异。
  桌面：`tauriFetch` + `localStorage`；扩展：直连 `fetch` + `chrome.storage.local`。
- **已经三端/两端共用的**：`icons` / `ItemIcon` / `ItemRow` / `NavRail` /
  `NavDrawer` / `NavTrigger` / `SecretField` / `Section` / `CopyButton` /
  `ConnectScreen` / `ItemEditor` / `GeneratorBody` / `ImportView` /
  `SecurityReportView` / `TwoFactorForm` / `Segmented` / `FloatingPanel` /
  `summary`（`ItemSummary` + `summarise`）

## 五、做完了什么

`git log --oneline` 共 202 个提交。最近这一轮（移动端 + 一致性）：

| 提交 | 内容 |
|---|---|
| `642ddec` | 摘要有三份 → 合一（`packages/ui/src/summary.ts`） |
| `5ab6f2d` | 生成 Xcode 工程 + 修 `gen/` 被整个 gitignore 的问题 |
| `6d02217` | 抽屉一拉开是「214px 宽、没有标签的图标条」 |
| `603b115` | 第一个 mobile 构建目标 |
| `02fb6a4` | iPhone 被判成 macOS → 顶上白空 28px |
| `8ca3afb` | Rust 第一次对着 iOS target 编过 |
| `8eb707c` | 每台 iPhone 都被判成 macOS（UA 里含 `like Mac OS X`） |

**当前状态**：`bun run typecheck` 干净，**850 个测试全过**。工作区干净。

## 六、⚠️ 没做完的（重点）

### ① 列表栏两端仍是两份 —— **用户正在为这个不满意**

用户画了个红框：桌面端那一栏是
`[汉堡] [搜索] [排序▾] [＋]`，而扩展弹窗是
`[站点条]` 然后 `[汉堡] [搜索] [＋]` —— **整个排序控件不存在**。

| | 文件 | 行数 | 形态 |
|---|---|---|---|
| 桌面端 | `apps/desktop/src/screens/VaultView.tsx` | 1202 | `band` 里一排控件 + 扁平 `<ul>`，数据是 **`VaultItem`** |
| 扩展端 | `apps/desktop/extension/popup/Popup.tsx` | 989 | 站点条 + 一排控件（**无排序**）+ `ListSection` 分组列表，数据是 **`ItemSummary`** |

**下一步**：抽一个 `VaultListColumn` 进 `@coffer/ui`：

```tsx
interface ListSection { label: string | null; items: ItemSummary[] }

<VaultListColumn
  query / onQueryChange
  sortBy / onSortChange        // SORT_BY / SORT_LABEL 在 @coffer/vault，现成的
  onNew
  sections={ListSection[]}     // 分组由调用方算 —— 它才知道自己的数据源
  selectedId / onSelect
  empty={ReactNode}            // 「为什么空」只有调用方知道
  dragRegion                   // 桌面端顶部带子能拖窗口
/>
```

⚠️ 桌面端要**先降到摘要**（`summarise(item)` 已经在共享包里了）。
这是这个改动唯一有风险的地方 —— `VaultView` 的详情栏仍需要整条
`VaultItem`，别把它一起降级了。

### ② 移动端**一次都没在设备上跑过**

编得过、构建得出来、能在手机视口下截图核对。但**没启动过**。

卡在：`cargo-mobile2` 拿 **SDK 版本（27.0）** 和已装**运行时（26.5）**比，
报「Xcode Simulator SDK 27.0 is not installed」—— **这句是错的**。
要跑 `xcodebuild -downloadPlatform iOS`，**约 8GB**（用户 2026-10-06 决定先不下）。
真机路线要签名证书，也走不通（`No code signing certificates found`）。

### ③ 移动端：附件**取不回**

`canSaveFiles()`（`apps/desktop/src/save.ts`）在移动端返回 false，
「取回」按钮不渲染 —— `save_file` 命令在移动端是 `#[cfg(desktop)]`。
iOS 的对应物是**分享面板**（「存到文件」），**还没写**。
现状：移动端上附件**看得到、取不回**。

### ④ 没有 CI

根目录没有 `.github`、没有 `.gitlab-ci.yml`，**而且没有 git remote** ——
纯本地仓库。所以加 CI 配置是写一个**不会运行**的文件。

已经有的是不依赖 remote 的版本：
```
bun run check        # typecheck + 850 个测试，无前置
bun run check:all    # 再加端到端（42 项，需先 e2e:extension:setup）
```

### ⑤ 摘要有**第四份**没合

`apps/desktop/src/use-quick-bridge.ts:27` 里还有一个 `summarise`，
返回 `QuickItem`（快速面板的另一个窗口用）。它**也把「无法解密」揉进了 `name`** ——
和刚合掉的那三份是同一个毛病。要么合进 `summary.ts`，要么至少别再揉。

### ⑥ 一条偶发失败的测试（没查清）

`packages/crypto/src/keys.test.ts` 的
`throws DecryptError (not DOMException) for a wrong-size key`
失败过**一次**，之后 27 次运行一次都没复现。当时没抓到断言原文。

这值得查而不是划掉：它守的是「MAC 校验失败时不能吐出一个像明文的串」。

### ⑦ 小的遗留

- `VaultView.tsx:495` 删除确认框直接显示 `item.name`，没管 `nameFailed`
  （**改动前就是这样**，不是新引入的）
- `apps/desktop/src/styles.css` 里 `.app-sidebar { --nav-w: var(--rail-w) }`
  **从来没生效过**（`.vault-rail[data-expanded='true']` 更具体），
  只是两处恰好都是 214px
- 附件大小的 KB/MB 分支只在预览里核过，没在真数据上核

## 七、怎么验证

```bash
bun run check                 # typecheck + 850 测试
bun run check:all             # 再加 42 项真实浏览器端到端
bun run build:mobile          # 移动端产物
bun run --cwd apps/desktop preview:build             # 桌面预览
bun run --cwd apps/desktop preview:mobile:build      # ★ 移动端预览（__PLATFORM__: mobile）
bun run --cwd apps/desktop preview:extension:build   # 扩展预览
```

截图（**这是本项目最有价值的验证手段**）：

```bash
bun run scripts/ui-shot.ts <产物目录> '/?screen=vault' out.png 390 844
COFFER_SHOT_TOUCH=1  bun run scripts/ui-shot.ts ...   # 触摸模拟（手机）
COFFER_SHOT_TAP='.nav-trigger' bun run scripts/ui-shot.ts ...  # 触摸点一下再拍
```

### ⚠️ 为什么截图不可替代

这一整个项目里，**有五个以上的 bug 是「typecheck + 全部测试 + 构建全绿」的
情况下，只有截图能发现的**：弹窗缩成一条、导航按钮压在红绿灯上、浮层透明、
生成器截断密码、抽屉拉开没有标签。

**而且有两次，是「故意把代码改坏，看测试红不红」才发现测试本身是空转的**
（`safe-area.test.ts` 第一版匹配到了文档注释；`drawer-css.test.ts` 因此
自带一条自检）。写守卫时**必须**验它会红。

## 八、会浪费你时间的坑（都已踩过）

### 1. `cargo`/`rustc` 是 Homebrew 的，不是 rustup 的

`which rustc` → `/opt/homebrew/bin/rustc`。rustup 装的目标对它**不可见**，
跨目标构建报 `can't find crate for 'core'` + 一句**错误的**提示
（「用 rustup target add 装一下」—— 装了也没用）。

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo check --target aarch64-apple-ios-sim
```

`tauri ios build` 同样中招（它自己调 cargo，继承调用者的 PATH）。

### 2. `dist-firefox` 会**静默过期**

`bun run build:extension` 只产出 `dist-extension`。
Firefox 那份要另外跑 `bun run build:extension-firefox`，而它**只在你记得跑的时候**才更新。

用户就撞上了：他载入的 `dist-firefox` 比 `dist-extension` 旧一个多小时，
**少了汉堡按钮和「＋」**，看起来像「扩展端 UI 不一样」——而代码是对的。
文档还写着「载入 `dist-firefox/manifest.json`」，等于把人往这个坑里引。

**建议**：加一条守卫 —— `dist-firefox/` 除 `manifest.json` 外每个文件
都应和 `dist-extension/` **逐字节相同**（脚本只改 manifest）。
两者都不存在时跳过。

### 3. 块注释里不要写 glob

`*/` 会把块注释提前闭合，报的是「Unexpected token」这种**指错方向**的错。
在这个仓库里犯过**三次**。

### 4. Vite 会把 `import.meta.glob` 的键规范化成最短形式

而最短形式**取决于测试文件住在哪**。用**后缀**查，或者干脆用根绝对路径
（`/apps/desktop/src/...`）。踩过两次。

### 5. `cfg(desktop)` 在 `Cargo.toml` 里**不能用**

那两个 cfg 是 `tauri-build` 通过 build script 发给 **rustc** 的
（`cfg_alias`，读过源码确认），Cargo 解析 `Cargo.toml` 时还没有 build script。
依赖表里只能写 `target.'cfg(not(any(target_os = "android", target_os = "ios")))'`。

### 6. `.vault-shell` 不能是 `container-type: inline-size`

弹窗按内容撑开，加了它整个弹窗会塌成 0 宽（踩过两次）。
守卫在 `extension/shared-css-wiring.test.ts`。

### 7. 预览页的 viewport meta 必须和产品那份一致

`preview/index.html` 一度完全不写 viewport。桌面浏览器上毫无影响，
但一开移动模拟，**布局视口变成 980px 默认值** —— 截出来是桌面三栏布局，
而它会被当成「390px 下的手机界面」看。**仪器骗人比没有仪器更糟。**

## 九、这个项目的做事方式

用户反复表达过的、体现在这个仓库里的：

- **产物看起来是好的 ≠ 它是对的。** 「类名在 DOM 上、规则不在产物里」
  「桩和真实类型脱节」「永远绿的守卫」都是同一族
- **注释写「为什么」，尤其是「这里差点错成什么样」** —— 上面这些坑
  基本都在代码注释里记着
- **两端各写一份 = 迟早漂，而且不报错。** 这是本项目最常见的一类 bug
