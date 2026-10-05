# 目录重组方案：两个 app → 一个 app，两个目标

> 用户的要求：「把现在的 extension 删了，拿现有的 PC 版本，去增加打包方式，
> 打包成 extension」。
>
> 这份文档是**执行前的构思**，不是执行记录。前置工作已经做完（见「已经做完的」），
> 剩下的是一次纯搬家 —— 但搬家本身要动几十个文件，所以顺序要写清楚。

---

## 一、先划清哪些能合、哪些不能

用户的原话是「不同端的 UI 本质上是一个东西」。这句话**对界面成立**，
对下面这几样**不成立** —— 它们不是「同一个东西换种打包」，是
「跑在别人的页面旁边」的代码，PC 版没有对应物：

| 文件 | 跑在哪 | PC 版有吗 |
|---|---|---|
| `background.ts` | MV3 service worker | ❌ |
| `content.ts` | **注入到别人的页面里** | ❌ |
| `webauthn-inject.ts` | 页面的 MAIN world，替换 `navigator.credentials` | ❌ |
| `offscreen.ts` | 离屏文档（剪贴板定时清理） | ❌ |
| `manifest.json` | 扩展的身份 | ❌ |

**所以最终形状不是「一个 app 一个目标」**，而是「一个共享的界面层 + 宿主接口，
两个宿主实现 + 一组只有扩展才有的入口」。

---

## 二、目标结构

```
apps/app/
  src/
    ui/                    ← 两端**完全一样**的界面
      VaultView.tsx            (现在 apps/desktop/src/screens/)
      ItemDetail.tsx           (现在 apps/extension/src/popup/ItemDetail.tsx)
      SecurityReport.tsx  Import.tsx  Generator.tsx  Connect.tsx …
    host/
      types.ts               ← 已经从 packages/ui/src/host.ts 定好
      desktop.ts             ← 现在 apps/desktop/src/host-impl.ts
      extension.ts           ← 现在 apps/extension/src/host-impl.ts
    entries/
      desktop.tsx            ← Tauri 主窗口
      quick.tsx              ← Tauri 快速面板（只有桌面端有）
      popup.tsx              ← 扩展弹窗
      background.ts          ← ⚠️ 只有扩展目标构建
      content.ts             ← ⚠️ 只有扩展目标构建
      webauthn-inject.ts     ← ⚠️ 只有扩展目标构建
  vite.config.ts           ← 按 COFFER_TARGET 决定构建哪些入口
  src-tauri/               ← 桌面端独有，原样
```

---

## 三、已经做完的（不要重做）

这几步是这次整理的核心，都已在 `main` 上：

1. **`packages/ui/src/host.ts`** —— 宿主接口。归纳下来平台的**真差异只有两处**：
   - 发请求：桌面走 Rust（WebView 的 origin 是 `tauri://`，跨源被 CORS 拦）；
     扩展直接 `fetch`（host permission，不受 CORS 限制）
   - 落盘存储：`localStorage` / `chrome.storage.local`
2. **两端各一个 `host-impl.ts`**，装在四个入口上（桌面主窗口 / 快速面板 /
   弹窗 / service worker）
3. **`sync-cache.ts` 合成一份**（含 `kdfCache`）
4. **`icon-store.ts` + `icon-disk.ts` 合成一份**

搬运过程中挖出来的真 bug（都是「两端各写一遍」造成的，且**不会有任何东西报错**）：

- 分类词表两端不同（`信用卡` vs `卡片`）→ 用户在另一端找不到自己的条目
- 扩展端图标**没有落盘缓存** → 每次打开弹窗重拉，首个域名 1.5 秒
- 扩展端**没有 KDF 缓存** → 每次解锁多一次 `prelogin` 往返
- 缓存键前缀不一致（`synccache.` vs `coffer.synccache.`）

---

## 四、执行顺序（每一步都要保持可构建、可回滚）

**不要一次性 `git mv` 几十个文件。** 按下面的顺序，每步跑一遍
`bun run typecheck && bun run test` 再提交：

1. **建 `apps/app/` 骨架**，先把 `package.json` / `vite.config.ts` / `tsconfig.json`
   照 `apps/desktop` 复制过来，入口暂时 re-export 现有的。跑通空壳。
2. **搬宿主**：`host-impl.ts` 两份 → `apps/app/src/host/{desktop,extension}.ts`。
   这一步没有界面依赖，最安全。
3. **搬共享界面**：从 `packages/ui` 和两个 app 里把**两端一致的**界面组件
   收进 `apps/app/src/ui/`。判断标准是「两端渲染同一份代码」——
   `NavRail` / `NavDrawer` / `ItemRow` / `SecretField` / `Section` /
   `CopyButton` / `IconGlyph` 这些都已经是了，搬的是**还在 app 里的**那些
   （`Popup.tsx` 的列表层、`ItemDetail.tsx`、安全报告、导入、生成器）。
   ⚠️ 桌面端的 `ItemEditor` / `Settings` / `SecurityReport` 要逐个确认
   扩展端是否需要 —— 需要的才搬，不需要的留在桌面端目标里。
4. **搬入口**，按 `COFFER_TARGET` 决定构建哪些：
   ```ts
   const TARGET = process.env.COFFER_TARGET ?? 'desktop';
   const entries = TARGET === 'extension'
     ? ['popup.tsx', 'background.ts', 'content.ts', 'webauthn-inject.ts']
     : ['desktop.tsx', 'quick.tsx'];
   ```
5. **删掉 `apps/desktop` / `apps/extension` 的空壳**，更新根 `package.json`
   的脚本和 `vitest.config.ts` 的 include。
6. **把 `packages/ui` 里属于界面的部分也搬进 `apps/app/src/ui/`** ——
   `packages/ui` 到时候只剩 `theme.css` / `components.css` / `icons`。
   （可选：也可以让它继续做「共享设计系统」包。这一步取决于要不要留着
   给将来的移动端用。）

---

## 五、几条不该忘的约束

- **`__PLATFORM__` 是编译期常量**，各构建目标各自 `define`。它管**能力分支**
  （同一件事在不同平台做法不同），不管「构建哪份代码」—— 后者由
  `COFFER_TARGET` 决定。
- **扩展端的 `content.ts` 必须是自包含的 IIFE**：它注入到页面里，
  出现任何 `import` 会静默失败。见 `vite.content.config.ts` 顶部。
- **`.vault-shell` 不能是 `container-type: inline-size`**：它是弹窗的根元素，
  而弹窗按内容撑开 —— 加了它整个弹窗会塌成 0 宽（这个坑踩过两次）。
  有守卫盯着：`apps/extension/src/shared-css-wiring.test.ts`。
- **MAIN world 的脚本不能引 `@coffer/ui`**（那里没有扩展 API，shim 会拿到
  页面的 `chrome` 对象）。有守卫盯着。
- **Tailwind 要显式 `@source` 指向共享包**，否则那些组件里用到的工具类
  一个都不会被生成。有守卫盯着。

---

## 六、验收

用户给的判据：

> PC 版窗口调窄，UI 自动跟着变。可以就对了。这个逻辑直接用到扩展和移动端上 ——
> 它们就是从横屏调到竖屏的 PC 端。

**现在已经成立**：桌面端拖窄 = 扩展端（左上角导航按钮、列表铺满、
详情盖住列表）。重组之后这条**不能退化** —— 它是这次整理唯一的验收标准。
