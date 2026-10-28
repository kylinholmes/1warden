# 1Warden 浏览器扩展商店发布方案

核对日期：2026-10-28。源码依据：界面优化 `195f447` 与回归脚本修复 `c24ffce`。本文回答首次上架需要什么、现有包能否使用、项目还需补哪些材料，以及后续如何自动更新。没有登录商店后台、支付注册费或提交审核。

两家商店均可沿用现有扩展构建，不需要另写一套界面。建议首次通过网页后台完成信息和审核，之后再接自动化。当前 GitHub Release 的扩展 ZIP 是手动安装/提交用构建，不代表已经商店上架或经过 Mozilla 签名。

## 现状与差距

| 项目 | 已有 | 上架前补齐 |
| --- | --- | --- |
| Chromium | Manifest V3，Chrome 116+；CI 生成 `1Warden-<版本>-chromium.zip`，根目录有 manifest | 开发者账号、隐私页面、商店描述/截图、权限理由、测试说明；首次上传后核对正式扩展 ID |
| Firefox | 独立转换 manifest；模块后台事件页；去除 Chrome 专用 offscreen/key；固定 ID `1warden@1warden.app` | 必须补 `data_collection_permissions`；决定旧版 Firefox 的同意流程；提供对应源码及可复现构建说明 |
| 视觉素材 | 现有 128px 扩展图标、可用的深浅主题与虚构数据预览 | Chrome 至少一张 1280×800 截图；建议准备保险库、网页填充、生成器三张，全部使用虚构数据 |
| 文档 | 构建说明、公开仓库、问题反馈入口 | 仓库未发现产品隐私政策或根许可证；需要确定实际发布者、支持邮箱、隐私政策地址和许可方式 |

代码证据：[Chromium manifest](../apps/desktop/extension/public/manifest.json)、[Firefox manifest 转换](../scripts/extension-manifest.ts)、[Firefox 打包](../scripts/build-extension-firefox.ts)、[构建工作流](../.github/workflows/build.yml)。已有可运行构建与商店材料完整是两回事，上表不代表已通过商店审核。

## Chrome Web Store 首次发布

1. 使用长期维护的 Google 账号进入 [开发者后台](https://chrome.google.com/webstore/devconsole/)。完成开发者注册、一次性注册费、发布者名称及联系邮箱验证，并启用两步验证。Google 2026 年的官方说明仍列首次新建发布者注册费为 US$5，实际结算以注册页为准。[账号注册](https://developer.chrome.com/docs/webstore/register)、[发布者注册费说明](https://developer.chrome.com/blog/cws-role-expansion-developer-dashboard)、[两步验证要求](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)、[账号资料](https://developer.chrome.com/docs/webstore/set-up-account)。
2. 从对应 GitHub Release 下载 **chromium.zip**，选择 Add new item 上传。不要上传 GitHub 的 Source code ZIP，也不要把整个仓库当扩展包。上传的 ZIP 应在根目录包含 `manifest.json`。[官方上传流程](https://developer.chrome.com/docs/webstore/publish)。
3. 填写名称、简短/完整描述、语言、分类、支持地址，以及图标和截图。现行文档要求 128×128 商店图标与至少一张 1280×800 截图，最多五张；宣传图和视频可后补。[商店信息及图片要求](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)。
4. 填写 Privacy：单一用途、逐项权限理由、远程代码与用户数据使用声明，附可公开访问的隐私政策地址。说明必须与实际实现一致；Google 明确要求披露仅在本机处理的数据。[隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[用户数据 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)。
5. 在 Test instructions 提供可用的隔离测试服务器、虚构账户和操作步骤，通过后台的审核专用字段交付凭据。提交审核后可选择自动公开或审核通过后手动公开。审核时长取决于实际审查，不承诺固定天数。[提交与发布选项](https://developer.chrome.com/docs/webstore/publish)。

可采用的单一用途描述草案：**连接用户指定的 Vaultwarden 服务器，在浏览器中管理、生成和填充登录凭据。** 其余功能说明围绕密码库管理展开，明确账户/服务器前提和可选网络功能。

首次上传后在 Package → View public key 获取正式公钥，与开发版 `key` 对齐，验证正式 ID 下的存储、填充和 Passkey 流程。现有 `key` 用于本地身份稳定，不能据此声称商店已分配同一个 ID。[Chrome 官方 ID 指引](https://developer.chrome.com/docs/extensions/reference/manifest/key)。

## 1Warden 的权限理由草稿

以下根据当前代码整理，可作为后台填写的基础，正式提交时再逐项核对实际构建。

| 权限 | 对应功能与说明 |
| --- | --- |
| `storage` | 保存服务器/账户资料、偏好、加密缓存，并在浏览器内存会话区维持解锁状态；不是把密钥改存到磁盘 |
| `scripting` | 用户选择凭据后向已验证的目标文档填入字段；配合受控的页面/文档授权 |
| `activeTab` | 用户触发扩展操作时识别当前页面，匹配并填入对应凭据 |
| `alarms` | 自动锁定与复制内容到期清理，弹窗关闭后仍可执行 |
| `downloads` | 用户发起的附件及导出文件下载 |
| `offscreen`（Chrome） | 使用后台文档执行剪贴板操作，支持关闭弹窗后的到期清理 |
| `clipboardWrite` | 用户主动复制用户名、密码等字段 |
| `clipboardRead` | 到期清理前比较当前剪贴板与本次复制值，避免清除用户后来复制的内容 |
| HTTP/HTTPS 主机权限与内容脚本匹配 | 在用户访问的网站识别登录表单并填充，也用于连接用户自定义的服务地址；需清楚说明为什么不能只列固定服务器域名 |

来源：[后台](../apps/desktop/extension/background.ts)、[填充](../apps/desktop/extension/fill.ts)、[剪贴板](../apps/desktop/extension/clipboard-store.ts)、[下载](../apps/desktop/extension/download-file.ts)、[会话存储](../apps/desktop/extension/session-store.ts)。本次调研没有增加或删除权限。

## Firefox AMO 首次发布

1. 使用 Mozilla 账号进入 [AMO Developer Hub](https://addons.mozilla.org/developers/)，选择 Submit a New Add-on → **On this site**，让用户可在商店搜索和安装。[官方提交流程](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)。
2. 上传 **firefox.zip**，通过校验。使用固定的 `1warden@1warden.app` 作为后续更新身份；保留同一个条目，不要每次创建新扩展。现有 ZIP 没有 AMO 签名，仅改成 `.xpi` 文件名不会获得签名。[提交流程](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)、[签名与测试说明](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)。
3. 补齐数据声明：自 **2025-11-03** 起，新扩展必须声明 `browser_specific_settings.gecko.data_collection_permissions`。目前转换函数没有这个字段，这是首次上架的具体缺项。认证信息、邮箱、同步数据及站点图标等外发行为要按真实数据流分类，不能因没有广告或遥测而直接填 `required: ["none"]`。[官方数据同意规范](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)、[manifest 定义](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)。
4. 处理最低版本：现有 `strict_min_version` 为 **128.0**，而桌面 Firefox 的内建数据同意流程从 **140** 才支持。建议首个商店版最低为 140，使用内建流程；如坚持支持 128–139，需要实现旧版本安装后的明确同意体验。本文只提出方案，没有改动当前兼容性。[版本与回退选项](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)。
5. 另上传匹配该版本的**源码 ZIP**。项目使用 TypeScript、React 和 Vite 打包，单独提交压缩后的扩展或公开仓库链接不足以代替源码附件。源码包需包含 workspace 源码、锁文件、固定工具版本与构建说明；每个需审查的版本都提供匹配源文件。[源码提交要求](https://extensionworkshop.com/documentation/publish/source-code-submission/)。
6. 填写名称、说明、分类、许可、支持信息、隐私政策和 Notes for Reviewers；提供专用测试账户及服务器。提交后跟进校验/人工审查反馈；有账号功能时，Mozilla 明确要求可用的测试信息和凭据。[上架字段](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)、[审核规则](https://extensionworkshop.com/documentation/publish/add-on-policies/)。

## 隐私材料需要描述的实际数据流

| 数据流 | 当前代码证据 | 披露重点 |
| --- | --- | --- |
| 指定服务器的登录、注册及加密密码库同步 | `packages/api/src`，`packages/vault/src/client.ts` | 邮箱/认证请求与加密密码库的用途、接收方、保存及删除方式；明确用户选择的服务器与应用发布者的区别 |
| 页面凭据识别与填充 | `apps/desktop/extension/content.ts`、`background.ts`、`fill.ts` | 读取哪些表单信息、何时保存/填充，不能概括为“不接触密码” |
| 站点图标 | `packages/vault/src/icons.ts`、`packages/ui/src/icon-store.ts` | 本地图标以外的域名会用于用户服务器 `/icons/{domain}/icon.png` 请求 |
| 可选密码泄露检查 | `packages/vault/src/health.ts` | 用户显式开启后，向 `api.pwnedpasswords.com` 发送 SHA-1 前五位前缀并在本地比对；不会发送明文密码 |
| 版本检查 | `apps/desktop/src/updates/manual.ts` | 访问 GitHub Release 的公开 `latest.json`；读取版本数据，不下载并执行远程扩展代码 |
| 复制/到期清理、加密缓存与会话 | `clipboard-store.ts`、`session-store.ts` | 剪贴板使用目的、保留时间、锁定/退出行为，以及本机数据保留方式 |

这是填写隐私政策和数据分类的事实底稿，不是未经核实就可提交的“零数据收集”承诺。正式分类应同时覆盖必需同步与用户选择开启的功能；可选数据权限若采用运行时请求，也需要实际处理拒绝后的行为。

## 可复现构建与自动化安排

现有 CI 使用 Ubuntu 24.04、Node **26.8.1**、Bun **1.3.14** 构建浏览器包。源码附件应从实际发布标签取得，而非混入当前未提交草稿。README-AMO 中记录上述环境与以下命令：

```sh
bun install --frozen-lockfile
bun run scripts/build-version.ts
bun run build:extension-firefox
```

生成目录：`apps/desktop/dist-extension` 与 `apps/desktop/dist-firefox`。在干净环境重建并比较扩展文件内容后再提交。不要声称“锁文件存在”就已经验证了可复现性；当前尚未完成跨环境逐文件复现验证。审查者必须能从所交源码构建与发布包一致的文件。[Mozilla 构建说明要求](https://extensionworkshop.com/documentation/publish/source-code-submission/)。

Firefox 提交前使用固定版本 `web-ext` 做本地校验。调研时 npm registry 的版本为 **10.8.0**；工具运行可放在临时缓存，不需要改产品依赖。`lint` 不需要商店密钥，也不会提交商店：

```sh
npm exec --yes --package=web-ext@10.8.0 -- web-ext lint --source-dir apps/desktop/dist-firefox --output json
```

本轮已对重新构建的 Firefox 包实际运行该命令：**0 errors、3 warnings**。其中一条为 `MISSING_DATA_COLLECTION_PERMISSIONS`，与上文 manifest 缺项一致；另两条 `UNSAFE_VAR_ASSIGNMENT` 位于 `popup.js`。通过 sourcemap 定位，两处均对应 `react-dom@19.3.0` 的内部 `innerHTML` 赋值；业务源码搜索未发现 `dangerouslySetInnerHTML` 或直接 `innerHTML` 赋值。该结果不能代替商店审核，源码附件应保留对应依赖版本，方便审查。没有修改第三方库来隐藏警告。证据保存在本地 `artifacts/release-2026-10-28/firefox-store-lint.json` 与 `firefox-lint-sources.json`。

后续将 lint、源码包生成和文件比对接入 CI，先产出人工提交所需材料。首次条目信息完整后，再选用 Chrome Web Store API V2 和 Firefox `web-ext sign --channel listed --upload-source-code ...` 自动提交版本；`unlisted` 仅签名自行分发，不会获得商店搜索展示。Chrome V2 也支持服务账号，应按发布权限配置专用身份，避免个人凭据写入仓库。[Chrome API](https://developer.chrome.com/docs/webstore/api)、[服务账号](https://developer.chrome.com/docs/webstore/service-accounts)、[web-ext 命令](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)。

首次上架的建议顺序：先确定发布者/账号和公开支持信息，再完成隐私页面、Firefox 数据同意和源码复现，最后准备截图与隔离测试环境，同时提交两家商店。以上账号、最终隐私承诺与许可选择需由实际发布者确定，本轮未代为注册或提交。
