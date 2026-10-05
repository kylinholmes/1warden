# 目录重组：从两个 app 到一个 app、两个目标

> 用户的原始要求：「把现在的 extension 删了，拿现有的 PC 版本，去增加打包方式，
> 打包成 extension」，以及「PC 版缺的，你拷贝过去保留着，UI 要完全一致」。
>
> **第一步已经执行完了**（见下面「已完成」）。这份文档现在记的是**剩下的**：
> 界面层本身的合并。它比搬家难，因为它不是搬文件，是**把两份实现合成一份**。

---

## 一、已经做完的：搬家

提交 `1db9fa3`。`apps/extension` 已经不存在，**没有删掉任何代码** ——
所有文件都搬进了 `apps/desktop`，扩展降级成一个构建目标。

| 目标 | 配置 | 入口 | 产物 |
|---|---|---|---|
| 桌面 | `vite.config.ts` | `index.html` / `quick.html` | `dist/` |
| 扩展 | `vite.extension.config.ts` | `extension/popup.html`、`background.ts`、`offscreen.html` | `dist-extension/` |
| 注入脚本 | `vite.content.config.ts` | `extension/content.ts`、`extension/webauthn-inject.ts` | 同上（`emptyOutDir: false`） |
| 桌面预览 | `vite.preview.config.ts` | `preview/` | `dist-preview/` |
| 扩展预览 | `vite.preview-extension.config.ts` | `preview-extension/` | `dist-preview-extension/` |
| Firefox 打包 | `scripts/build-extension-firefox.ts` | 改写 `dist-extension/` | `dist-firefox/` |

**为什么目录还叫 `desktop` 而不是改成 `app`。** 用户的原话是「拿现有的 PC 版本，
去增加打包方式」—— 保留 PC 版本的目录就是字面执行。改名的代价是 `src-tauri` 的
`tauri.conf.json`、`Cargo.toml`、根脚本、`.gitignore` 全要跟着动，而收益只是名字。
名字不对是**读代码时**的成本，改名出错是**用户在跑的那个二进制**的成本。

**为什么搬家时所有路径引用都没改。** `apps/extension/src/` 和
`apps/desktop/extension/` 离仓库根**都是 3 层** —— 守卫测试的 glob、
`styles.css` 的 `@source`、`preview.css` 的 `@import` 全部原样有效。
只有两处例外，都记在提交信息里。

### 搬家顺手修好的三件事

1. **`preview-extension/stub-chrome.ts` 从来没做过类型检查**（老扩展的 tsconfig
   只 include 了 `src/**`）。并进来当场报出两处真错误。
2. **合并 tsconfig 拆掉了一道天然防线**：`chrome` 类型现在对桌面端也可见了。
   防线挪进 `chrome-api-guard.test.ts`，扫描范围扩到 `../src`。
3. **`Popup.tsx` 渲染了 `NavDrawer` 却没有 `NavTrigger`** —— 而触发器是唯一
   能打开抽屉的东西（面板绝对定位，抽屉在流里宽度为 0）。**弹窗的导航此前
   完全够不着**。已修，并加了守卫。

---

## 一·五、进度：界面层已经合掉的两对

| 提交 | 合掉了什么 | 合并时发现 |
|---|---|---|
| `86a9244` | 安全报告 → `@coffer/ui/SecurityReportView` | 弹窗那份**少两栏**（已泄露的密码、即将到期）—— 功能缺失，不是样式差异 |
| 本次 | 两步验证 → `@coffer/ui/TwoFactorForm` | 扩展端**从来没有接过 `TwoFactorChallenge`**（整个目录里 `twoFactor` 出现 0 次）—— **开了两步验证的 Vaultwarden 用户登不进扩展** |

两件的形状一样：不是「两边写得不一样」，是**一边根本没写**，
而类型检查、测试、构建全都不会报。

### 仪器：`?state=2fa` 已补上

两步验证那一屏一度**没有预览状态**，只能靠读代码想象。补它的拦路石是
React 的受控输入：直接赋 `el.value` 它看不出变化、不重渲染，表单卡在
`required` 上 —— 而**看起来就像这一屏坏了**（一个指向错误方向的症状）。
要走原型上的原生 setter 才改得动。

现在 `preview-extension/main.tsx` 里的 `?state=2fa` 会填好三个输入框并提交，
`stub-chrome.ts` 相应地回一个 `twoFactor` 挑战。截过一次，排版正常。

**下一对合并之前先确认：新开的那一屏有没有对应的 `?state=`。**
这个盲区在本次会话里已经放过三次 bug 过去（弹窗缩成一条、导航按钮压在
macOS 红绿灯上、截图里少一个按钮）—— 全都是只有肉眼看得见的。

## 一·六、下一对：`Connect` —— 推演出来的两个决策点

扩展端**没有**记住的账户、没有快速解锁。回访用户每次打开弹窗都要重敲
服务器地址和邮箱；桌面端能「点一下 + 敲密码」。

搬家时会撞上两件事，都是先想清楚才不用返工的：

### ① ✅ 已做：账户存储搬进 `@coffer/ui/accounts.ts`

`useAccounts()` 加载中回 `null`（和「一个都没存」的 `[]` 分开），
`Connect.tsx` 在 `null` 时渲染占位、**不渲染表单**。⚠️ 占位放在 JSX 里
而不是提前返回 —— 那个函数后面还有 hook。

搬完还发现一件事，值得记下来：**预览的仪器跟着坏了一次**。
账户存储以前直接读 `localStorage`，预览不需要宿主；搬进宿主接口之后
`readAccounts()` 会抛、被吞掉、回 `[]`，于是预览里**恒为「一个都没存」**，
账户选择那一屏截不到 —— 而症状只是「截图里少了几行」，不报任何错。
现在预览也装了一份等价的宿主（不走 `installDesktopHost()`，
那会把 Rust 的 `tauriFetch` 带进来）。

### ①·二 ✅ 已做：整个连接屏合进 `@coffer/ui/ConnectScreen`

账户存储做出来之后，整块就搬得动了 —— 桌面端的连接屏删成「外壳 + 证书插槽」，
弹窗接同一个组件。**两端从此只有一份**：账户列表、快速解锁、完整表单、
两步验证全在里面。

弹窗补上了它一直没有的两屏（记住的账户、快速解锁），以及服务器地址的示例提示。

⚠️ 仪器又踩了一次，两次都是同一类：预览要**手工维护**「哪些状态算未登录」，
新加的 `?state=quick` 漏进去时，那一屏会连同整个保险库一起渲染出来 ——
截图看起来只是「内容不对」，不报错。名单现在提成了一个具名的常量数组。

⚠️ 还有一次：`?state=quick` 原本用 `querySelector('ul button')` 找账户按钮，
结果点中了**导航抽屉**的（未登录时它照样渲染，而且在 DOM 里排前面）。
按文字找才对 —— 这个文件里其他状态本来就是这么写的。

### ①·原推演：账户存储必须走 `host().storage`，而它是**异步**的

桌面端现在直接读 `localStorage`（同步），所以在 `useState(readAccounts)`
里一句话就拿到了。换成 `host().storage` 之后必须 `await` ——
于是**首帧拿不到账户**，会先渲染完整表单、再跳成账户列表。

这个闪烁不能靠「先渲染表单」糊过去：有记住账户的人看到的是
「咦，怎么又要我填服务器地址」。做法是让 `useAccounts()` 在加载中回
**`null`**（和「一个都没存」的 `[]` 区分开），调用方在 `null` 时渲染占位。

⚠️ 注意不能为此写提前返回 —— `Connect.tsx` 在 `passwordRef` 那个
`useEffect` 之后还有 hook，提前返回就是「有条件地调 hook」，
`hooks-order-guard.test.ts` 会（正确地）拦下来。占位要放在 JSX 里。

### ② 共享组件的边界：`onConnect` 要能**表达四种结果**

桌面端的外壳里混着证书确认（Tauri 专有：`probeCertificate` /
`trustCertificate` 走 Rust），而扩展端**没有**这条路 —— TLS 校验在浏览器手里。

所以共享组件不能自己 `try/catch` 完事，得让 `onConnect` 回一个判别联合：

```ts
type ConnectOutcome =
  | { kind: 'ok' }
  | { kind: 'twoFactor'; providers: number[] }   // 弹 TwoFactorForm（已共享）
  | { kind: 'cert' }                             // 桌面端画 CertificatePrompt，扩展端永远不会回这个
  | { kind: 'error'; message: string };          // 两端都用 apiMessageOf
```

这样「视图切换」这一层是共享的，而**平台专有的那一屏**由各端当插槽塞进来。
证书那一屏本身（`CertificatePrompt`）是纯展示，也可以一起搬进共享包 ——
扩展端不渲染它，但搬过去不花什么代价，而且省得以后自建服务器的人
问「为什么扩展上不提示证书」。

### ③ 做完之后要新的 `?state=`

账户选择列表和快速解锁是**两个新屏**。预览里目前没有能造出
「已保存账户」的状态（桩没有 `host().storage` 的内容），得先给桩
预置几条 —— 否则又是「改完没肉眼看过」，见上一节。

### ①·三 ✅ 已做：生成器合进 `@coffer/ui/GeneratorBody`

`Segmented` 一并搬进共享包（它只依赖 react）。桌面端只剩浮层外壳，
弹窗把内容铺在列表那一层 —— **两个外壳，一份内容**。

弹窗那份原来**弱得多**：没有口令、只有两类字符、而且结果被 `truncate`
截断 —— 生成 64 位密码，屏幕上只有 `aB3$x…`，而用户正要把它抄走。
还有一个更安静的：弹窗把大小写写死成开、数字符号可关，**两类都关掉时
`generatePassword` 会抛**，而桌面端有一道 `disabled` 挡着。

### ①·四 ✅ 已做：导入合进 `@coffer/ui/ImportView`

同一族最后一个。弹窗那份违反了桌面端明写的三条硬要求里的两条
（跳过逐条、失败逐条），而导入是**一次性、不可重来**的操作。详见提交 `47f1d9a`。

顺带修掉：后台的格式选择被自动识别**静默压过**（`detect ?? req.format` 顺序反了）——
那个下拉存在的全部理由就是「自动识别不可靠时用户能自己指定」。

#### ⚠️ 那一块没核对过的，已经补上了（`0c03cba`）

补的时候踩到的坑值得记：**喂文件要走 `input.files = DataTransfer.files`
再派发 `change`** —— 和用户点选文件同一条路。这个文件里其他状态
（`detail` / `2fa`）本来就是这么写的，我上一轮漏了。

而且要**先切到导入那一项**再喂（这些状态验的是那一屏的后续阶段，
不是列表）—— 第一次截出来的是保险库列表，看起来像「这个状态没生效」。

桩也必须跟着改：`skipped` 要回**逐条的行号 + 原因**、`import-commit` 要回
**有名字有原因**的 failed。桩回旧的形状，这两段在预览里根本渲染不出来 ——
而它们正是要验的东西。

**遗留（`0c03cba` 记下未改）**：导入**完成之后**格式选择器会跳回
「自动识别出来的」那一个，而不是刚才实际用的那个（提交后 `preview` 被清成
`null`，选择器回落到 `autoFormat`）。终态里的纯外观问题，不影响正确性。

## 二、还剩什么：把两份界面合成一份

判据只有一条：**两端是否渲染同一份代码**。

### 已经在共享包里（不用动）

`icons` / `ItemIcon` / `ItemRow` / `NavRail` / `NavDrawer` / `NavTrigger` /
`SecretField` / `Section` / `CopyButton` / `clipboard` / `destinations` /
`host` / `icon-disk` / `icon-store` / `sync-cache` / `platform` /
`strength` / `report-labels` / `api-message` + `theme.css` / `components.css`

### 待合并（按难度排，从难到易）

| 现在在哪 | 对面是谁 | 结论 |
|---|---|---|
| `src/screens/VaultView.tsx`（1189 行） | `extension/popup/Popup.tsx` 的列表层 + `ItemDetail.tsx` | **最大的一块**。两边的数据来源不同（桌面在进程内、弹窗走 background 消息），所以要先把「数据来源」也抽成一个宿主接口（像 `Host` 那样），然后共用同一份列表/详情 |
| `src/screens/Connect.tsx`（500） | `Popup.tsx` 的 `ConnectForm` | 合并，**以桌面端为准** |
| `src/screens/SecurityReport.tsx`（276） | `Popup.tsx` 的 `SecurityReport` | 合并，同上 |
| `src/screens/Import.tsx`（341） | `Popup.tsx` 的 `ImportScreen` | 合并，同上 |
| `src/screens/Generator.tsx`（272） | `Popup.tsx` 的 `Generator` | **只共享逻辑**。桌面是浮层、弹窗是内联 —— 两个外壳，一个 `@coffer/crypto` |
| `src/screens/ItemEditor.tsx`（587） | **没有** | 留桌面端。⚠️ 用户要求过功能对齐，将来扩展也要 |
| `src/screens/Settings.tsx`（332） | **没有** | 留桌面端 |
| `src/screens/Unlock.tsx`（134） | **没有**（扩展的解锁在连接表单里） | 留桌面端 |
| `src/screens/QuickAccess.tsx`（161） | **没有**（桌面独有的快速面板） | 留桌面端 |

⚠️ 拆 `Popup.tsx` 时最容易搞错的一件事：它里面的 `ConnectForm` /
`SecurityReport` / `ImportScreen` / `Generator` **不是「扩展端的版本」**，
是「还没有和桌面端对齐的版本」。合并方向是**以桌面端那份为准**。

### 数据来源的差异（合并列表层之前必须先解决）

| | 桌面端 | 扩展端 |
|---|---|---|
| 条目 | `VaultClient` 在进程内，直接 `await` | `ext.runtime.sendMessage({type:'coffer:search'})` |
| 解锁态 | 进程内的会话状态 | 同上，走消息 |
| 明文 | 就在这个进程里 | **不出后台**（弹窗只收摘要） |

这不是能靠「抽个接口」抹平的差异 —— 扩展端**刻意**不让明文进弹窗（spec
不变量 S1）。所以共享的列表层要按**摘要**设计，桌面端也得先降级成摘要。

---

## 三、几条不该忘的约束

- **`__PLATFORM__` 是编译期常量**，各构建目标各自 `define`。它管**能力分支**
  （同一件事在不同平台做法不同），不管「构建哪份代码」。
- **扩展的 `content.ts` 必须是自包含的 IIFE**：注入到页面里，出现任何
  `import` 会静默失败。见 `vite.content.config.ts` 顶部。
- **`.vault-shell` 不能是 `container-type: inline-size`**：弹窗按内容撑开，
  加了它整个弹窗会塌成 0 宽（踩过两次）。守卫在
  `extension/shared-css-wiring.test.ts`。
- **MAIN world 的脚本不能引 `@coffer/ui`**（那里没有扩展 API）。守卫同上。
- **Tailwind 要显式 `@source` 指向共享包**。守卫同上。
- **块注释里不要写 glob** —— `星号斜杠` 会把注释提前闭合，报的是
  「Unexpected token」这种指错方向的错。这一轮犯了三次
  （`host-impl.ts` / `vitest.config.ts` / `vite.preview-extension.config.ts`）。

---

## 四、验收

用户给的判据：

> PC 版窗口调窄，UI 自动跟着变。可以就对了。这个逻辑直接用到扩展和移动端上 ——
> 它们就是从横屏调到竖屏的 PC 端。

**现在成立**（搬家没有让它退化，扩展预览的 CSS 哈希与搬家前完全一致）。
合并界面层的每一步都**不能让它退化** —— 这是唯一的验收标准。
