# 1Warden 浏览器扩展

Chrome / Edge 和 Firefox / Zen 直接运行桌面端的 `src/App.tsx` 与 screens。浏览器入口只安装宿主能力与 `ApplicationClient` 消息适配器，不维护第二套保险库界面。

## 构建与载入

在仓库根目录运行：

```bash
bun install
bun run build:extension          # apps/desktop/dist-extension
bun run build:extension-firefox  # 同时构建 Chrome 与 apps/desktop/dist-firefox
```

- Chrome：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → `apps/desktop/dist-extension`。
- Firefox：`about:debugging#/runtime/this-firefox` → 临时载入附加组件 → `apps/desktop/dist-firefox/manifest.json`。临时安装在浏览器退出后失效；正式分发需要签名。
- Edge 使用 `edge://extensions`，载入 `dist-extension`；Zen 使用同一 `about:debugging` 入口，载入 `dist-firefox`。

Firefox 构建复制同一份 UI、background 与 content 产物，仅转换 manifest：Chrome 使用 module service worker；Firefox 使用 module event page，移除 `offscreen` 与 `minimum_chrome_version`，保留共享权限并声明 Gecko ID。不要直接把 Chrome manifest 载入 Firefox。后台差异见 [MDN background 文档](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)。

`storage` 保存会话和非敏感设置；`scripting` / 站点权限用于填充；`alarms` 用于后台期限；剪贴板权限用于复制后有条件清理；`downloads` 用于用户请求的附件下载。所有 WebExtension API 经 `ext-api.ts` 选择 Firefox 的 Promise `browser` 或 Chrome 的 `chrome`。

## 可重复的真实浏览器 smoke

`scripts/browser-smoke.ts` 安装真实构建到全新的临时 profile，启动本机临时登录页，并向 `storage.session` 写入人工构造的测试会话。它不访问个人浏览器配置，也不连接现有 Vaultwarden 账户。每次结束关闭浏览器并删除 profile，截图和 JSON 报告保留在输出目录。

先安装可选测试工具到仓库外。本机已有 Edge / Zen 时直接使用，无需下载浏览器：

```bash
npm install --prefix /tmp/coffer-browser-tools puppeteer-core@25.12.0
export COFFER_PUPPETEER=/tmp/coffer-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export COFFER_SMOKE_OUT=/tmp/coffer-local-browser-smoke
bun scripts/browser-smoke.ts edge
bun scripts/browser-smoke.ts zen
```

macOS 默认从 `/Applications/Microsoft Edge.app` 和 `/Applications/Zen.app` 启动，可用 `COFFER_EDGE` / `COFFER_ZEN` 覆盖可执行文件。报告分别为 `edge-report.json` / `zen-report.json`，记录真实产品、引擎版本、路径与构建哈希；不会把它们称为 Chrome / Firefox 实测。

需要官方 Chrome / Firefox 时，下载测试浏览器（或指定已有可执行文件）：

```bash
npm install --prefix /tmp/coffer-browser-tools puppeteer-core@25.12.0 @puppeteer/browsers@3.2.3
/tmp/coffer-browser-tools/node_modules/.bin/browsers install chrome@stable --path /tmp/coffer-browser-tools/browsers
/tmp/coffer-browser-tools/node_modules/.bin/browsers install firefox@stable --path /tmp/coffer-browser-tools/browsers

export COFFER_PUPPETEER=/tmp/coffer-browser-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
export COFFER_CHROME='<上面输出的 Chrome 可执行文件绝对路径>'
export COFFER_FIREFOX='<上面输出的 Firefox 可执行文件绝对路径>'
export COFFER_SMOKE_OUT=/tmp/coffer-browser-smoke
bun scripts/browser-smoke.ts chrome
bun scripts/browser-smoke.ts firefox
```

Chrome 使用 [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/download-test-binaries)，Firefox 使用官方发行版。测试通过 Puppeteer 的 CDP / Firefox WebDriver BiDi 驱动；扩展安装接口见 [Puppeteer 文档](https://pptr.dev/api/puppeteer.browser.installextension)。

覆盖：连接表单、440×600 标签页中的扩展界面、后台摘要投影、排序、搜索、详情、显式显示/隐藏密码、编辑与取消、详情返回、生成器/报告/导入/设置导航、真实 content script 消息、内容上下文调用敏感 RPC 被拒绝、向真实页面填充、锁定清除密钥、重新打开仍保持锁定。这个脚本显式设置标签页视口，不验证工具栏弹窗的原生尺寸。

原生工具栏尺寸单独由 `scripts/toolbar-popup-smoke.ts` 检查。它默认使用无界面的临时 profile，通过 `action.openPopup()` 打开工具栏弹窗；从 `extension.getViews({ type: 'popup' })` 读取窗口、body 和根节点的实际尺寸，全程不设置弹窗视口。连接页与模拟解锁页都应为 440×600，根节点不能溢出。需要可见窗口时显式设置 `COFFER_SMOKE_HEADED=1`。

```bash
# 默认无界面；开启可见窗口时应与其他 GUI 操作分开，焦点变化会关闭弹窗。
bun scripts/toolbar-popup-smoke.ts edge
bun scripts/toolbar-popup-smoke.ts zen
```

此脚本沿用 `COFFER_PUPPETEER`、`COFFER_EDGE` / `COFFER_ZEN` 与 `COFFER_SMOKE_OUT`，输出 `edge-toolbar-report.json` / `zen-toolbar-report.json`。可通过 `COFFER_TOOLBAR_DIST` 指定旧构建复现尺寸回归。不要将固定视口标签页的通过结果当作原生工具栏尺寸验证。

无界面 Chromium 默认虚拟屏幕只有 800×600；仅放大浏览器窗口仍会把工具栏弹窗裁到 502px 高。脚本通过 `--screen-info` 提供 1600×1200 的虚拟屏幕，并记录实际屏幕和浏览器窗口尺寸；它不改弹窗视口。

`bun scripts/connection-smoke.ts edge` / `zen` 使用同一工具路径和无界面临时 profile，向本地模拟服务发起失败登录，验证关闭重开后的地址、邮箱、错误提示与未提交修改恢复。它不使用真实账户，不会自动重试登录；主密码不写入表单草稿，关闭弹窗后清除。

`bun scripts/inline-smoke.ts edge` / `zen` 验证网页输入框中的账户选择、实际点击打开解锁弹窗、解锁后恢复选项、真实填充和敏感 RPC 拒绝。使用临时 profile、本地模拟认证服务和人工记录；通过记录实际点击所发消息的回复验证解锁，不再补发第二条模拟请求代替点击结果。

`COFFER_PANEL_PREVIEW=apps/desktop/dist-preview bun scripts/panel-motion-smoke.ts` 验证共享页面的窄屏全窗口卡片、宽屏居中面板、右滑进出、退出期间不可交互、焦点恢复、顶层 Esc 与减少动画偏好。先运行 `bun run --cwd apps/desktop preview:build`；它使用无界面 Edge 和人工预览数据。

Firefox 157 / 当前 Zen 的 BiDi 不支持扩展页面的原生输入和截图；脚本在实际浏览器上通过 DOM 事件操作实际界面，并在报告中明确标记这一限制。Chrome / Edge 使用原生指针/键盘并保存截图。

扩展检查按需开启：`COFFER_SMOKE_ATTACHMENTS=1` 从本机下载加密附件，经真实后台解密和 UI Blob 下载后逐字节验证；Firefox / Zen 的 `saveAs` 需要原生 Save 对话框，可以加 `COFFER_SMOKE_HEADED=1` 手动确认。`COFFER_SMOKE_CLIPBOARD=1` 使用实际复制按钮，两次关闭页面 32 秒，分别检查到期清除与保留后来复制的内容；它会使用系统剪贴板，应单独运行，避免与其他剪贴板测试并行。

此 smoke 用模拟会话，不证明服务器登录、写入或 Passkey 注册成功。服务器集成使用另一个测试：`bun run e2e:extension:setup` 后运行 `bun run e2e:extension`；该脚本目前使用 Edge 和专用开发账户，不能把它的结果称为 Chrome / Firefox 验证。

## 运行边界

- UI 只收到摘要、选中条目详情和显式操作结果；密钥与整库明文保留在后台和内存会话区。内容脚本无权调用 UI 的敏感 RPC。
- 填充由后台计算，明文通过 `scripting.executeScript` 的参数直接注入目标输入框；常驻 content script 负责字段识别和提交事件。
- `storage.session` 允许后台重启后恢复，绝不能改用磁盘上的 `storage.local` 保存密钥。会话带绝对到期时间，锁定清除解锁记录并保留账户信息。
- 剪贴板清理由后台管理，Chrome 使用 offscreen 文档，Firefox 使用后台文档；弹窗关闭后仍可继续。仅当内容仍等于本次复制值时清空，避免覆盖后来复制的内容。
- content script 必须输出自包含 IIFE，不能含顶层 ES module `import`。它使用独立 `vite.content.config.ts` 构建。
- 扩展网络由浏览器校验证书。自建服务的 TLS 证书需要浏览器信任；桌面端的证书确认界面不适用于扩展。
