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

## 一·七、下一件：扩展端不能新建 / 编辑条目

这是**功能缺口**，不是「两边不一致」—— 扩展端压根没有这一屏。
用户明确要求过对齐（«这些逻辑, 拓展上 是不是应该和桌面对齐? 都需要有啊我感觉»）。

### 外部依赖只有三处

读过 `ItemEditor.tsx` 之后，它和 app 的耦合面比 587 行看起来的小：

| 依赖 | 桌面端 | 扩展端 |
|---|---|---|
| `client.saveItem(draft)` | 进程内直接调 | 需要新的 `coffer:save-item` 消息 → 后台 `c.saveItem` |
| `client.getSession().folders` | 进程内 | 已有 `coffer:folders`（id + name） |
| `FloatingPanel`（外壳） | 桌面端组件 | 弹窗整屏只有 440px，浮层没意义 —— 和生成器同一种分法：**两个外壳，一份内容** |

`draft` 是完整的 `VaultItem`（`blankItem()` 造一个空的）。

### ⚠️ 坎在「编辑」，不在「新建」—— 两者难度差一个量级

**新建**：用户从零敲进去，弹窗手里的明文是**他自己刚打的**，没有任何
额外泄露 → 直接做，和桌面端同一份。

**编辑**：弹窗要先**拿到条目现有的字段**才能显示在表单里，而它现在拿不到
—— 读那条路是刻意封死的（`coffer:item` 只回 notes / card / identity /
sshKey / secureNote，**不含 login 的密码**；密码要 `coffer:reveal` 一个字段
一个字段地要）。

所以编辑有两条路，**得先决定**：

- **(a) 打开编辑器时整条揭示给弹窗。** 简单，但那是把读那条不变量
  （S1 的精神：弹窗只拿摘要）开一个口子 —— 而那个口子一旦开了，
  以后没人记得它为什么在。
- **(b) 弹窗只改它拿得到的那几个字段**，密码走「留空 = 不改」。
  不开口子，但用户会疑惑「为什么这里看不到密码」。

我倾向 (b) —— 它和 `SecretField` 现有的「揭示」交互是一致的，
而且**留空即不改**本来就是密码表单的常规语义。但这是产品决定，
不是实现细节，所以写在这儿而不是直接做。

### ⚠️ 第三个决策点：固定底栏由表单状态驱动

`ItemEditor` 的「保存 / 取消 / 错误」在 `FloatingPanel` 的 `footer` 属性里
—— 那是**滚动区外面**、面板底部固定的一条。而它读的是 `save` / `busy` /
`error` / `confirming`，全是表单自己的状态。

拆外壳的时候这一条会卡住：底栏跟着内容走，布局就变了（那个文件顶上写着
「底栏不滚 —— 「保存」必须永远在手指底下」）；底栏留在外壳里，就得把表单
状态捅出去。

三条路：

| | 做法 | 代价 |
|---|---|---|
| A | `renderFooter: (state) => ReactNode` 渲染属性 | 能用，但接口难看 |
| B | 底栏挪进内容，用 `position: sticky; bottom: 0` 钉住 | 布局等价，但要**肉眼核对**才能确认没变 |
| C | 抽 `useItemEditor(...)` hook，两端各自画头和底栏 | 头尾写两遍 —— 正是这一族要消掉的东西 |

我倾向 **B**：它能让「一份内容」这条不破，而 sticky 在滚动容器里钉住底部
是这个场景的标准做法。但它是**布局改动**，而布局改动恰恰是这一族里唯一
必须肉眼验证的一类 —— 所以得在动手时留出截图核对的余量。

### 建议的切法

先做**新建**（不需要揭示，和桌面端完全同构），编辑单独一轮。
两件事的数据通道不一样，混在一起做的话，测试的时候分不清是哪一半出的问题。

## 一·八、最后一对：详情屏 —— 弹窗少三样

同一族里唯一没合的一对。桌面端的详情在 `VaultView.tsx` 里（内联），
弹窗的在 `extension/popup/ItemDetail.tsx`。

数过字段，弹窗少了三样，**而且这三样不能照搬**：

| | 桌面端 | 弹窗 | 为什么不能直接搬 |
|---|---|---|---|
| `customFields` | ✅ `SecretField masked={type===1}` | ❌ | 隐藏字段（type 1）里通常放的就是密钥 |
| `passwordHistory` | ✅ 显示**历史密码原文** | ❌ | 那是明文旧密码，给了弹窗就是开口子 |
| `attachments` | ✅ 名字 + 下载 | ❌ | 下载要 URL + token |

### 做法（已经推演完，下一步是机械的）

**自定义字段**：`coffer:item` 回 `{ name, type, value }[]`，但 **type === 1 的
`value` 回 `null`**；揭示走扩展后的 `coffer:reveal`（`field: 'custom'` + 序号）。

⚠️ 关键发现：**`SecretField` 已经有 `getValue`**（异步，现在只用于复制）。
把「揭示」也接到它上面就够 —— 现在的揭示读的是同步的 `value`，
而它已经有那条异步取值的路了。改完之后桌面端**免费**拿到同样的惰性
（它现在是先把明文拿在手里，其实不必）。

**密码历史**：只回 `lastUsedDate`（**不含值**），界面列「用过 N 个旧密码」
+ 日期。要看原文在桌面端。这不是偷懒 —— 历史密码原文没有任何理由
进浏览器扩展。

**附件**：名字 + 大小可以回；下载要另想办法（扩展里可以用
`chrome.downloads` 或直接开一个带 token 的 URL，而 token 在后台）。
**这一项单独一轮**：它和上面两项的数据通道不一样。

### 顺序

先做自定义字段（它顺带把 `SecretField` 的惰性揭示补上，后面两项都受益），
再密码历史，附件最后。

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

## 三·五、验收标准在**手机尺寸**上核过了

用户给的判据是「PC 版窗口调窄，UI 自动跟着变……这个逻辑直接用到扩展和
移动端上」。这条我复述了很多次，但直到现在才在**真正的手机视口**上看过：

```
bun run scripts/ui-shot.ts apps/desktop/dist-preview '/?screen=vault' m.png 390 844
```

390×844（iPhone 逻辑分辨率）下的结果：

- rail 收成搜索框左边的汉堡按钮（不是消失，也不是压住内容）
- 搜索 + 排序 + 「+」在**一行里**排得下
- 列表铺满整宽，长名字正常截断
- **没有横向溢出**

主界面成立。安全报告那一屏也核过（`/?screen=messy`，窄留白生效、评分卡换行）。

⚠️ 这是**桌面预览**在手机尺寸下渲染的，Tauri 的标题栏和红绿灯留白不在场。
布局逻辑同一套，但真机上还要再核一次。

⚠️ 扩展弹窗是**固定** 440×560，不参与这件事 —— 它已经在这个档位里了。

## 三·六、端到端：真实浏览器里跑过一遍

这一整个会话的验证一直是「单测 + 截图」。那两样都有一个共同的盲区：
**它们不碰真实浏览器的扩展运行时** —— content script 的注入时序、
`executeScript` 在真实页面里能不能取到 DOM、service worker 被杀了又醒、
`navigator.credentials` 的替换。这些单测证不了。

仓库里有 `scripts/e2e-extension.ts`（CDP 驱动真实 Chromium），
这一轮跑了一次：

```
./scripts/dev-server.sh start      # Vaultwarden
bun run build:extension
bun run scripts/e2e-extension.ts
```

**42 项检查全过，0 失败，退出码 0。** 七个环节：

| | |
|---|---|
| 1 | 扩展加载与页面注入 |
| 2 | 解锁扩展 |
| 3 | 提交表单 → 捕获 → 保存 |
| 4 | 自动填充 |
| 5 | 复制到剪贴板 · 已存过的密码不该再提示 |
| 6 | passkey（create/get、**断言签名用注册时的公钥验过**、rpId 越权拒绝） |
| 7 | 清理 |

⚠️ 这是**某一次运行**的结果，不是持续保证 —— 它依赖跑着的 Vaultwarden 和
一份测试账号。放进 CI 之前得先把前置固化下来。

## 三·七、提交前跑什么

```
bun run check        # typecheck + 843 个测试 —— 不需要任何前置
bun run check:all    # 再加端到端（先跑一次 e2e:extension:setup）
```

### ⚠️ 一条**没查清**的观察：`keys.test.ts` 有过一次偶发失败

记在这里而不是假装没发生：`bun run check` 有一次报

```
packages/crypto/src/keys.test.ts
  it('throws DecryptError (not DOMException) for a wrong-size key')
  Tests  1 failed | 842 passed
```

**之后 27 次运行（6 次全量 + 20 次单跑 + 1 次单包）一次都没复现。**
当时没抓到断言原文，所以下面这些只是**待查的方向，不是结论**：

- 最可疑的是 `expect(decryptString(...), '消息').rejects` 这种写法里，
  被拒的 promise 和挂上去的处理器之间的**微任务时序** —— 拒得太早会变成
  unhandled rejection，而它报出来的样子和断言失败不一样、也不稳定
- 其次是 57 个 worker 并行时的超时

**为什么值得记而不是划掉**：这是**密码学**的测试，守的是
「MAC 校验失败时不能吐出一个像明文的串」。一条会偶发失败的 MAC 测试，
比一条没有的 MAC 测试更危险 —— 它让人习惯性地重跑，而真正的间歇性
bug 就藏在「又是它，重跑一下」里面。

下次再出现时**先把断言原文留下**，再决定是修测试还是修实现。

## ⚠️ 这个仓库**没有 CI**，而且现在加不了

查过了：根目录没有 `.github`、没有 `.gitlab-ci.yml`，
**而且没有 git remote** —— 仓库是纯本地的。

所以加一份 `.github/workflows/ci.yml` 是写一个**不会运行**的文件。
那正是这一整个会话在防的那类东西：产物看起来是好的，实际什么都没做。

`check` / `check:all` 就是那份 CI 会跑的内容。等有了 remote，
配置本身是五行的事 —— 缺的是「这个仓库托管在哪」，那是决定，不是实现。

## 三·八、跨目标构建：一个指向**反方向**的错

装好 iOS 目标、然后

```
cargo check --target aarch64-apple-ios-sim
```

得到的是：

```
error[E0463]: can't find crate for `core`
  = help: consider downloading the target with `rustup target add aarch64-apple-ios-sim`
```

**这个提示是错的，照它做也没用。** 目标确实装着 —— `rustup target list
--installed` 里有，`~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/
aarch64-apple-ios-sim/lib/` 里 `libcore-*.rlib` 也在。我按提示重装了一遍，
仍然是同一个错。

真正的原因在这台机器的 PATH 上：

```
$ which -a rustc
/opt/homebrew/bin/rustc          ← 胜出的是这个
/Users/kylin/.cargo/bin/rustc
```

Homebrew 的 rustc（1.98.1）是一份**独立发行版**，sysroot 在
`/opt/homebrew/Cellar/rust/`，里面没有 rustup 装的那些目标。而 cargo 是用
**裸名字**去调编译器的 —— `cargo check -v` 打出来的命令行就是
`rustc --crate-name libc ...`，于是 PATH 解析到 Homebrew 那份，
**rustup 装的目标对它根本不可见**。

至于 rustup 的 shim 为什么没把工具链的 bin 顶到前面，没查出确凿原因
（`~/.cargo/bin/cargo` 确实是 shim，自报 1.98.0，`~/.cargo/bin/rustc
--print sysroot` 也指对了工具链）。但事实很清楚：**cargo 调的是裸
`rustc`，PATH 上胜出的是 Homebrew 那份**。

### 怎么办

不改用户的 PATH（那是他的机器，而且桌面端构建一直靠它正常工作 ——
Homebrew 的 rustc 编自己的宿主目标是没问题的），只在需要跨目标的命令里让路：

```
PATH="$HOME/.cargo/bin:$PATH" cargo check --target aarch64-apple-ios-sim
```

同一棵树，加前缀就 `Finished`，不加就 E0463 —— 这一条是**验过的**。

⚠️ 对 `tauri ios build` 同样成立：它自己去调 cargo，继承的是调用者的 PATH。
所以移动端的构建脚本里必须带上这个前缀，否则失败的样子还是「找不到 core」，
而那个样子会让人去查目标装没装 —— 一个已经查过、且结论是「装了」的地方。

## 三·九、移动端：第一次有东西了

在这一轮之前，移动端**一行都没有**：`IS_MOBILE` 在 `platform.ts` 里声明了，
全仓库出现 0 次；`__PLATFORM__` 有四个构建目标各自 `define`，
但**没有任何一处真的读它**。

现在：

| | 状态 |
|---|---|
| Rust 对着 `aarch64-apple-ios-sim` 编过 | ✅ `cargo check` Finished |
| `mobile` 构建目标（`bun run build:mobile`） | ✅ 桌面专属代码**不进产物** |
| 移动端预览（`preview:mobile:build`） | ✅ 可截图 |
| 模拟器/真机跑起来 | ❌ **还没做**（`tauri ios init` 那一步） |

### 怎么分的家

源码和 HTML **共用一份**。用户的判据是「PC 版窗口调窄，UI 自动跟着变……
这个逻辑直接用到移动端上」—— 布局层确实不用分家：容器查询在 390px 下
已经把 rail 收成抽屉了。分家的只有**能力**，由 `__PLATFORM__` 表达。

| | 桌面端 | 移动端 |
|---|---|---|
| `__PLATFORM__` | `'desktop'` | `'mobile'` |
| 入口 | `index.html` + `quick.html` | 只有 `index.html` |
| 产物 | `dist/` | `dist-mobile/` |

移动端没有 `quick.html`：快速面板是 `alwaysOnTop` / `skipTaskbar` 的常驻小窗，
移动端没有「另一个窗口」这个形态。

Rust 侧移进桌面端的：`rfd`（系统文件对话框）、`tray-icon` / `image-png`（托盘）；
`save` / `tray` / 快速面板那三条命令加了 `#[cfg(desktop)]`。
`autotype` 和 `hotkey` **不用加** —— 它们在文件顶上写了 `#![cfg(...)]`，自己管自己。

### ⚠️ 移动端**现在做不到**的一件事（别让它悄悄消失）

**附件取不回。** `canSaveFiles()` 在移动端返回 false，「取回」按钮不渲染 ——
`save_file` 那条命令在移动端不存在，而 iOS 的对应物是**分享面板**
（「存到文件」），不是「另存为」。那是另一套实现，**还没写**。

所以移动端上附件是**看得到、取不回**的。

### ⚠️ 三件事只有「拉开抽屉再截图」才看得见

这一轮改了三处，**每一处都是截图发现的，而且每一处都不是移动端独有的**：

**一、`detectOs` 把每一台 iPhone 都判成了 macOS。** iPhone 的 UA 里含有
`like Mac OS X`，于是 `--titlebar-h` 拿到 28px —— 那是给三个红绿灯圆点留的。
改成 `detectOs(ua = navigator.userAgent)`，先认 iOS 再认桌面系统。

**二、抽屉一拉开就是 214px 宽、一个标签都没有的图标条。**
`styles.css` 里有一块 `@container shell (max-width: 900px)` 在 `.app-sidebar`
里藏掉所有文字 —— 它以为那是常驻侧栏。但 `.app-sidebar` **只有抽屉一个使用者**，
而两档正好互补，所以这条规则**在抽屉打开时一定生效**。
（顺带：那个 `--nav-w: 56px` 从来没生效过，`.vault-rail[data-expanded='true']`
比它更具体。）

**这一条桌面端窄窗口同样中招**，不是移动端的问题。

**三、预览页没有 viewport meta。** `preview/index.html` 一直没写，
桌面浏览器上毫无影响 —— 但一开触摸模拟，**布局视口就变成 980px 的默认值**，
截出来是一张 980px 宽的桌面三栏图，而它会被当成「390px 下的手机界面」看。

### 这一轮的教训：**仪器本身也会骗人**

第三条尤其值得记：它不报错、不空白，给的是一张**看起来很正常的图**，
只是那张图不是你以为的那个东西。所以「手机视口」这件事得拆成两半：

| | 回答什么 |
|---|---|
| `390×844` | 排版在窄屏下成不成立 |
| `COFFER_SHOT_TOUCH=1` | 这套交互在**没有 hover 的手指下**成不成立 |

之前那次验收只做了前者（`mobile: false`）。现在 `ui-shot.ts` 两样都有，
还多了 `COFFER_SHOT_TAP=<选择器>` —— 用**触摸**点一下再拍。
（用 `element.click()` 是不行的：它走鼠标那条路，会把 `:hover` 也置上，
等于把要验的前提自己抹掉。）

顺带核过：抽屉在触摸下**能打开**（靠 sticky hover），所以「没有 hover
就够不着导航」那个担心不成立 —— 那个 bug 在扩展弹窗上已经犯过一次。

### 加了两条守卫

- `src/safe-area.test.ts` —— `env(safe-area-inset-*)` 和 `viewport-fit=cover`
  必须**成对**出现。少一个不报错：`env()` 一律返回 0，
  于是「让出了安全区」和「根本没让」在代码上长得一模一样
- `src/drawer-css.test.ts` —— 没有任何规则可以在 `.app-sidebar` 里藏文字

⚠️ 两条的第一版**都是空转的**，都是「故意改坏再看它红不红」发现的：
safe-area 那条匹配到了 HTML 里的**文档注释**（注释里就写着 `viewport-fit=cover`），
drawer 那条现在自带一条「判据能认出那段被删掉的规则吗」的自检。

### ⚠️ 卡在模拟器运行时上，而且错误信息又是错的

`tauri ios build -t aarch64-sim` 走到前端构建**成功**之后停住：

```
failed to build iOS app: Xcode Simulator SDK 27.0 is not installed, please open Xcode
```

**这句话是错的。** `xcodebuild -showsdks` 里 `iphonesimulator27.0` 好好地装着。

加 `-vv` 才看到真正在比较什么：

```
Debug [cargo_mobile2::apple::target] installed runtimes: 26.5
```

`cargo-mobile2` 拿 **SDK 版本（27.0）** 去和**已装的模拟器运行时**比，
而本机只有 **iOS 26.5** 的运行时 —— 于是它说「SDK 没装」。
「SDK」和「runtime」是两样东西，报错把它们混成了一个词。

要往下走需要 iOS 27.0 的模拟器运行时：

```
xcodebuild -downloadPlatform iOS
```

**约 8 GB**（现有的那个 26.5 运行时自己就占 7.9 GB）。
这是个下载决定，不是一个实现细节 —— 所以停在这里等一句话，没有自作主张。

⚠️ 换 `-t aarch64`（真机）绕不过去：那条路要签名证书，
而构建日志第一行就是 `No code signing certificates found`。

**这一条和上面那条 rustc 是同一个形状**：错误信息指向一个
已经查过、且结论是「没问题」的地方（SDK 装没装），
真正的原因（运行时版本对不上）一个字都没提。

## 四、验收

用户给的判据：

> PC 版窗口调窄，UI 自动跟着变。可以就对了。这个逻辑直接用到扩展和移动端上 ——
> 它们就是从横屏调到竖屏的 PC 端。

**现在成立**（搬家没有让它退化，扩展预览的 CSS 哈希与搬家前完全一致）。
合并界面层的每一步都**不能让它退化** —— 这是唯一的验收标准。
