# Coffer 设计系统

> 原则：**借鉴成熟的比例与结构，但配色、字体、动效是我们的**。
> 目标是让用户觉得「熟悉顺手」，而不是「换皮的 1Password」。

---

## 1. 参照测量（来自本机 1Password 8.12.34 的 CSS）

> 测量它的**刻度与结构**用于校准，**不复用任何值**。它的品牌色、图标、图片一律不碰。

| 维度 | 它的做法 | 我们借鉴什么 |
|---|---|---|
| 间距 | 4px 基准：1/4/8/12/16/24/32/48/64/128 | 4px 基准是行业通例，沿用 |
| 圆角 | 4 / 8 / 12 px 三档，按钮与卡片用 8 | 三档结构合理；**值我们自定** |
| 字号 | 正文 12/14/16，标题 12/16/20/28 | 分层合理；**中文字号需单独调** |
| 动效 | 75 / 175 / 250 / 300 / 500 ms，5 种缓动 | 分档过细；**我们收敛到 3 档** |
| 颜色 | 分层表面色 + 文字层级 + 独立强调色角色组 | **结构直接学**，这是最值得借鉴的一点 |

它的颜色组织方式尤其值得学：把「表面」和「文字」各自编号成层级，
而不是给每个组件单独定义颜色 —— 组件只引用层级，换主题时只改层级的值。

---

## 2. 我们的 token

### 2.1 间距（4px 基准）

```
--space-hairline: 1px      --space-sm:  12px      --space-2xl: 48px
--space-2xs:      4px      --space-md:  16px      --space-3xl: 64px
--space-xs:       8px      --space-lg:  24px      --space-xl:  32px
```
组件默认内边距 `--space-md`（16px），区块间距 `--space-lg`（24px）。

### 2.2 圆角

```
--radius-sm: 6px     --radius-md: 10px     --radius-lg: 16px     --radius-full: 9999px
```
比 1Password 略大一点（6/10/16 对 4/8/12）—— 这是我们自己的手感，
更柔和，也和它区分开。**按钮与卡片用 `--radius-md`。**

### 2.3 字号与字体

```
--text-xs:   12px      --text-lg:   17px
--text-sm:   13px      --text-xl:   22px
--text-md:   14px      --text-2xl:  30px
```

**字体栈**（Latin 用 Inter，CJK 回退系统字体 —— 中文不能直接用 Inter，字形会不匹配）：

```
--font-ui: Inter, -apple-system, "PingFang SC", "Noto Sans SC",
           "Microsoft YaHei", sans-serif;
--font-secret: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

`--font-secret` **只用于密码、密钥、验证码** —— 等宽让用户能核对字符，
也避免 `l`/`1`、`O`/`0` 混淆。选 JetBrains Mono（OFL 许可，可自由分发），
**不是** 1Password 用的那款（那是它的资产）。Inter 同为 OFL。

字体必须**内嵌进应用**，不能依赖 CDN —— 这是密码管理器，
任何外部请求都是隐私问题，也违背"无第三方遥测"的约束。

### 2.4 动效（收敛到 3 档）

```
--dur-fast:   150ms     /* 悬停、按下、揭示 */
--dur-base:   220ms     /* 展开、切换、复制反馈 */
--dur-slow:   320ms     /* 锁定过渡、面板进入 */

--ease-out:   cubic-bezier(0.16, 1, 0.3, 1);    /* 进入、揭示 */
--ease-inout: cubic-bezier(0.65, 0, 0.35, 1);   /* 移动、切换 */
```

只用透明度与位移。**尊重 `prefers-reduced-motion`** —— 全部动效降为 0ms。

### 2.5 颜色：分层结构

学它的组织方式，值全部自己定。

**表面层**（背景由浅到深，亮色主题）：

| Token | 用途 |
|---|---|
| `--surface-base` | 窗口底色 |
| `--surface-raised` | 卡片、输入框 |
| `--surface-sunken` | 侧栏、代码块 |
| `--surface-overlay` | 弹窗、下拉 |

**文字层**：

| Token | 用途 | 对比度要求 |
|---|---|---|
| `--ink-primary` | 正文、条目名 | ≥ 7:1 |
| `--ink-secondary` | 副标题、用户名 | ≥ 4.5:1 |
| `--ink-tertiary` | 时间戳、提示 | ≥ 4.5:1 |
| `--ink-inverse` | 深色底上的文字 | ≥ 7:1 |

**强调色**（我们自己的深青蓝，刻意区别于 1Password 的品牌蓝）：

```
--accent:        oklch(0.52 0.09 220)    /* 深青蓝 */
--accent-hover:  oklch(0.46 0.10 220)
--accent-tint:   oklch(0.95 0.02 220)    /* 选中行背景 */
--accent-ring:   oklch(0.62 0.10 220)    /* 焦点环 */
--accent-ink:    oklch(0.98 0.01 220)    /* 强调色底上的文字 */
```

**语义色**（只用于安全状态，不用于装饰）：

```
--safe:      oklch(0.62 0.13 150)   /* 强密码 */
--caution:   oklch(0.72 0.14  75)   /* 重复使用 */
--risk:      oklch(0.58 0.18  25)   /* 已泄露 / 弱密码 */
```

用 `oklch` 而非 hex：**亮暗主题可以用同一个色相和色度、只调亮度**，
换主题时不会出现色相偏移。

### 2.6 层级（阴影）

比 1Password 克制 —— 安全工具不该看起来浮夸。用「1px 描边 + 极轻阴影」而非重投影：

```
--elev-1: 0 0 0 1px var(--border-subtle), 0 1px 2px rgb(0 0 0 / 0.04);
--elev-2: 0 0 0 1px var(--border-subtle), 0 4px 12px rgb(0 0 0 / 0.06);
--elev-3: 0 0 0 1px var(--border-subtle), 0 8px 28px rgb(0 0 0 / 0.10);
```

---

## 3. 我们与 1Password 有意的差异

| 维度 | 1Password | Coffer | 为什么 |
|---|---|---|---|
| 强调色 | 品牌蓝 | **深青蓝** | 自有识别度 |
| 圆角 | 4/8/12 | **6/10/16** | 更柔和的手感 |
| 动效 | 5 档 / 5 种缓动 | **3 档 / 2 种缓动** | 够用即可，减少不一致 |
| 阴影 | 多层叠加投影 | **描边为主 + 极轻阴影** | 安全工具应沉静不浮夸 |
| 组织 | Vault + Tags 两套 | **只有文件夹** | 降低认知负担 |
| TOTP | 独立「验证器」板块 | **内联在登录条目上** | 用户找的是"GitHub 的密码" |

---

## 4. 待办

- [ ] 中文排版需实测：PingFang SC 在 13–14px 下的可读性，必要时上调到 14–15px
- [ ] 实际色值需在 `oklch` 定稿后用对比度工具验证全部组合达到 WCAG AA
- [ ] 暗色主题需单独验证（不能只做亮度翻转）
- [ ] `prefers-reduced-motion` 与 `prefers-contrast` 的降级路径
