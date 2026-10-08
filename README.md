# 1Warden

连接自建 Vaultwarden 的个人密码管理器。桌面 App 和浏览器扩展共用 React 界面，支持多账户、自动填充及加密的个人资料。

- **macOS App**：Apple Silicon，基于 Tauri；支持菜单栏、快速面板、原生自动输入及 Touch ID。
- **Windows App**：Windows 10/11 x64，基于 WebView2；支持原生窗口、托盘、`Ctrl+Shift+\` 快速面板和 Unicode 自动输入，提供 NSIS 安装包。Windows Hello 和自动更新尚未接入。
- **浏览器扩展**：Chromium / Edge，以及 Firefox / Zen；支持当前网站匹配和登录输入框中的账户选择。
- **桌面更新**：自动检查并准备签名更新，下载完成后弹出“稍后 / 重启更新”的小提示；不自动退出。
- **多账户**：按服务器地址与邮箱区分；已解锁账户直接切换，锁定、登出或到期后重新验证。添加账户可以返回原账户。
- **个人资料**：头像与名称保存在服务端加密的 Profile 安全备注中，解锁后同步，并按账户缓存展示信息。
- **共享界面**：所有平台按可用窗口宽度切换；不足 900px 时为单页流程，足够宽时分栏。详情、设置、编辑和生成器共用规则，调整窗口不清空正在编辑的内容。
- **设置与导航**：窄窗口设置为单列目录逐级进入；宽窗口设置保留侧栏。账户菜单统一提供用户详情、设置和返回账户首页；外观仅在设置中调整。左上角导航仅点击展开，不因悬停或聚焦打开，支持再次点击、点外部及 Esc 收起。

## 开发

需要 Bun 1.3.14。macOS 原生构建另需 Rust 与 Xcode Command Line Tools，安装包只面向 Apple Silicon。Windows 构建需要 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2。

```sh
bun install --frozen-lockfile
bun run check
bun run dev:desktop
```

本地 Vaultwarden 测试环境见 [scripts/dev-env.sh](scripts/dev-env.sh) 与 [开发交接](docs/handoff.md)。集成测试只应使用专用测试账户。

## 构建与下载

```sh
bun run build:extension-firefox  # Chromium 与 Firefox 两份扩展
bun run build:desktop            # 当前 Mac 的 .app 与 .dmg
bun run build:windows            # Windows x64 的 NSIS 安装包
```

Edge 的开发者模式加载 `apps/desktop/dist-extension`。Zen 在 `about:debugging#/runtime/this-firefox` 临时加载 `apps/desktop/dist-firefox/manifest.json`。商店发布及 Firefox 正式签名需要另行配置。

[GitHub Releases](https://github.com/kylinholmes/1warden/releases) 提供插件 ZIP 与 Apple Silicon macOS 安装包。GitHub Actions 自动验证、构建并发布签名更新；构建、下载和发布方法见 [构建说明](docs/builds.md)。

## 数据与会话

主密码只用于本地派生密钥。解锁仍需服务端验证；密码库密钥和解密记录留在内存中。浏览器后台通过仅受信任扩展页面可访问的 `storage.session` 保留多个账户的会话，浏览器重启会清空；每个账户各有原始的 15 分钟到期期限，切换不会续期。登出只清除所选账户。

持久化的 Profile 展示缓存只包含经过校验的名称与头像。头像也会保存在服务端加密的安全备注中，其他 Bitwarden 客户端可以看到这条 Profile 记录。

本版本使用全新的应用身份、扩展 ID 和数据命名空间，不自动迁移旧版的账户、偏好或资料标记。首次打开需要重新连接服务器；服务器中的密码条目不会被删除。旧格式的资料备注会作为普通条目保留。安装新版扩展后请停用旧版，避免两份扩展同时自动填充。
