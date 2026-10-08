# 构建与下载

GitHub Actions 在每次代码 push、Pull Request 和手动运行时执行类型检查、单元测试、跨端界面和真实扩展回归，并生成浏览器扩展、macOS 和 Windows 安装包/免安装程序（仅文档修改不触发）。Windows 构建还会运行真实 WebView2 回归。打开 [Actions](https://github.com/kylinholmes/1warden/actions)，选择成功的 `1Warden builds` 运行，在页面底部下载 Artifacts；构建产物保留 30 天，测试截图与日志保留 14 天。推送与包版本一致的 `v` 标签后，流水线会把相同的安装包和 SHA-256 校验文件发布到 [Releases](https://github.com/kylinholmes/1warden/releases)。代码与发布包已按用户选择设为公开；macOS 自动更新无需 GitHub 登录。

| 产物 | 用途 |
| --- | --- |
| `1Warden-<版本>-chromium.zip` | Chrome、Edge 等 Chromium 浏览器 |
| `1Warden-<版本>-firefox.zip` | Firefox 128 及以上 |
| `1Warden-<版本>-macos-apple-silicon.dmg` | Apple Silicon Mac 的安装包，macOS 13 及以上 |
| `1Warden-<版本>-macos-apple-silicon.app.zip` | 同一 macOS 应用的压缩包 |
| `1Warden-<版本>-windows-x64-setup.exe` | Windows 10/11 x64 的安装包 |
| `1Warden-<版本>-windows-x64-portable.exe` | 同一 Windows 程序，直接运行、无需安装应用 |
| `SHA256SUMS*.txt` | 下载文件的 SHA-256 校验值 |

Actions 下载的是外层 artifact ZIP，先解压它，再使用其中的安装包。macOS 只构建 Apple Silicon（ARM64），Windows 构建 x64。

免安装 EXE 同样需要 Microsoft Evergreen WebView2 Runtime；“免安装”指不安装 1Warden，不表示独立捆绑运行时，也不表示账户/设置保存在 EXE 旁边。它与安装版使用相同应用身份和系统应用数据目录，两者不要同时运行。缺少运行时时使用安装包，或从 [Microsoft 官方页面](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)安装 WebView2 Runtime。

## 自动回归 CI

`check` 先验证 workflow YAML/最小权限约束、版本一致性、TypeScript 和单元测试，然后允许以下独立工作开始：

| 检查 | 运行环境与覆盖 |
| --- | --- |
| Automated ui smoke | Windows Edge；桌面/移动端/扩展预览的宽度布局、返回/面包屑/焦点、动效溢出、主题、账户菜单、Zustand 生命周期 |
| Automated extensions smoke | Windows Edge 与 Firefox 的真实已编译扩展；搜索/详情/填充/锁定、失败连接恢复、资料自动保存/头像裁剪/加密同步 |
| Windows x64 packages and WebView2 smoke | Rust 单元测试、NSIS/EXE 构建，然后用独立原生进程验证快速窗口的快捷键、透明背景、失焦/临时固定/调用权限，以及真实 CSP 下的头像和资料同步 |

所有 smoke 只使用合成的 loopback 保险库、临时浏览器/WebView2 配置。原生套件还隔离 `APPDATA` 与 `LOCALAPPDATA`；禁止继承真实服务测试地址、剪贴板测试开关和调试配置。不启用真实剪贴板读写测试。每个脚本有限时，失败会让 job 失败；UI 矩阵互不取消，原生验证不通过时不发布 Windows 产物。标签发布必须等待 UI/扩展与原生验证完成。

测试包装器是 `scripts/ci-smoke.ts`，复用现有 smoke 脚本，不复制业务测试逻辑。它保存每一步日志、退出码、耗时、JSON 报告和截图，并产生 Actions 页面摘要；只收集白名单证据文件，**不上传浏览器 profile、Cookie、localStorage 数据库或账户缓存**。`test-results-*` artifacts 在失败时也上传，不匹配发布包的 `1Warden-*` 下载模式。

本地使用相同入口：

```powershell
bun install --frozen-lockfile
bun run check:ci
bun run test:ui                         # 自动构建预览/扩展并测试
bun run test:ui -- ui                   # 只跑共享界面套件
bun run test:ui -- extensions           # 只跑真实扩展套件
$env:ONEWARDEN_NATIVE_EXE='C:\path\to\1warden.exe'
bun run test:windows                    # 原生 EXE 已构建时运行
```

测试依赖固定为 `puppeteer-core` **25.11.0**，由项目锁文件安装，不需要本机 npm 临时缓存路径，也不会自动下载另一个浏览器；包装器显式选择 Edge/Firefox。非标准安装可通过 `ONEWARDEN_EDGE`、`ONEWARDEN_FIREFOX` 覆盖。`ONEWARDEN_CI_OUTPUT` 指定证据输出目录；默认自动创建临时目录。已有最新构建时可加 `--skip-build`，排查单个步骤可用 `--only=navigation` 等步骤名。Windows 若默认 Temp 位于不支持原生路径解析的内存盘，请先把本次命令的 `TEMP`/`TMP` 指向普通磁盘临时目录，不需要改动 Cargo 的缓存位置。

CI 固定 `windows-2022`，使用其预装浏览器并在启动原生测试前检查 WebView2 Runtime。浏览器与运行时仍随 runner 镜像更新，日志保留版本信息用于排查。[Runner 软件清单](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)、[Puppeteer 自行管理浏览器说明](https://pptr.dev/guides/installation)、[WebView2 运行时检测](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#detect-if-a-webview2-runtime-is-already-installed)。

工作流使用 `pull_request`（不是 `pull_request_target`），默认只有 `contents: read`，checkout 不保留凭据；新增 UI/原生测试不引用 secrets，所有 actions 固定完整提交 SHA。现有签名 secrets 仍仅用于原有标签发布路径，普通 main push 不发布 Release。[GitHub 权限规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)、[失败时保留日志](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#always)。

本轮只修改构建/测试配置，不迁移任何生产数据。若 CI 环境发生兼容问题，先看 `test-results-*` 和 runner 版本；可回退该 CI 提交恢复原流水线，不能用忽略失败或关闭安全限制代替修复。首次托管运行结果以 Actions 实际运行记录为准，本机通过不等于所有托管平台已经验证。

## 安装测试包

Chromium：解压 `chromium.zip`，打开浏览器的扩展管理页（Chrome 为 `chrome://extensions`，Edge 为 `edge://extensions`），启用开发者模式，选择“加载已解压的扩展程序”，指向包含 `manifest.json` 的目录。

Firefox：解压 `firefox.zip`，打开 `about:debugging#/runtime/this-firefox`，选择“临时载入附加组件”，打开解压目录的 `manifest.json`。临时扩展会在重启 Firefox 后移除；这些包尚未经过 Mozilla 商店签名。

macOS：打开 DMG，把 `1Warden.app` 拖到“应用程序”。也可以解压 `.app.zip` 后移动应用。当前流水线使用 [Tauri 支持的 ad-hoc 签名](https://v2.tauri.app/distribute/sign/macos/)，无需 Apple 签名凭据，但没有 Developer ID 签名或公证。首次打开被系统阻止时，按 [Apple 官方说明](https://support.apple.com/102445)在“系统设置 → 隐私与安全性”中选择“仍要打开”，确认来源后再打开。本次启用新的 `app.onewarden.desktop` 标识及钥匙串服务，不迁移旧身份的本地设置或认证条目，需要重新登录。

## 本地构建

Windows 使用每用户 NSIS 安装，不要求管理员权限；缺少 WebView2 时安装程序会下载运行时。当前 Windows 安装包未做 Authenticode 签名；Windows Hello 和应用内自动更新尚未接入，升级使用新版本安装程序。原生窗口关闭后保留托盘入口；从托盘菜单“退出”结束进程。快速面板为 `Ctrl+Shift+\`；自动输入使用 Win32 Unicode 按键事件，不支持向更高权限的管理员窗口输入。

Windows 主窗口在创建前按系统版本选择背景：Windows 10（1809+）使用 Blur，Windows 11 使用 Mica，避开 Acrylic 在 Windows 10 上的拖动卡顿；无法识别的系统不启用原生模糊。半透明侧栏和一体化标题栏保留，窗口按钮在右上角，支持拖动、双击最大化、最小化和关闭至托盘。所有平台按可用窗口宽度布局：小于 900 CSS px 使用逐级页面，900px 起使用分栏，不依据横竖方向、设备类型或操作系统判断。

Windows 10 的无边框 Blur 窗口关闭原生阴影框，避免隐形缩放边框被模糊后形成内容外的一圈玻璃；边缘和四角仍可缩放。Windows 11 的 Mica 保留原生阴影。可对独立测试进程运行 `scripts/windows-frame-smoke.ps1 -AppProcessId <PID>`，验证 Windows 10 内容与外框对齐及八个缩放命中区域。

Windows 本地构建（需 Visual Studio C++ Build Tools、Windows SDK、Rust MSVC 工具链）：

```powershell
bun install --frozen-lockfile
bun run check
bun run --cwd apps/desktop build
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
bun run build:windows -- --ci -- --locked
```

本地构建遵循 Cargo 的 `build.target-dir` 配置，不覆盖为项目目录；未配置时才使用 Cargo 默认的 `target`。可用 `cargo metadata --no-deps --format-version 1 --manifest-path apps/desktop/src-tauri/Cargo.toml` 中的 `target_directory` 确认位置。若配置为 `C:\ProgramData\Temp\target_cache`，可执行文件位于该目录下的 `x86_64-pc-windows-msvc/release/1warden.exe`，安装包在 `release/bundle/nsis/`。仅需可执行文件时使用 `bun run build:windows -- --no-bundle -- --locked`。

某些 ImDisk 内存盘可正常读写，但不支持原生最终路径查询。Tauri 2.12 扫描生成的核心权限文件时会因此得到空列表，其资源/代码生成也依赖同一接口。`build_support.rs` 只对这个特定错误（Windows 错误 1）启用兼容处理：编译缓存和最终 EXE 仍在原 `target-dir`，仅 Tauri 的 ACL、资源与嵌入资产生成文件放到 `%LOCALAPPDATA%/1Warden/build-metadata/`（须在普通磁盘，可用 `ONEWARDEN_TAURI_METADATA_DIR` 指定）。按项目/构建指纹隔离，不修改依赖源码、权限内容、能力配置、全局 Cargo 配置或盘符。Windows 配置单独放在 `tauri.windows.conf.json`，macOS 的材质和安装包配置不受影响。CI 显式设置缓存目录是为匹配流水线缓存与产物收集，不影响本地 Cargo 配置。

流水线固定 Bun **1.3.14**、Node.js **26.8.1**、Rust **1.98.1**，安装依赖使用已提交的 `bun.lock`、`Cargo.lock`。GitHub Actions 使用固定提交 SHA。macOS 构建使用 [GitHub 的 `macos-15` ARM64 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，并显式指定 `aarch64-apple-darwin`；产物检查也会拒绝非 ARM64 可执行文件。

在仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run check
bun run build:extension-firefox
```

两个扩展目录分别是 `apps/desktop/dist-extension` 和 `apps/desktop/dist-firefox`，压缩时应让 `manifest.json` 位于 ZIP 根目录。

在安装了 Xcode Command Line Tools 的 Apple Silicon Mac 上构建应用：

```sh
rustup toolchain install 1.98.1 --profile minimal
rustup default 1.98.1
rustup target add aarch64-apple-darwin
bun run --cwd apps/desktop build
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
CI=true APPLE_SIGNING_IDENTITY=- \
  CARGO_TARGET_DIR="$PWD/apps/desktop/src-tauri/target" \
  bun run build:desktop -- --ci --target aarch64-apple-darwin --bundles app,dmg -- --locked
```

`.app` 和 `.dmg` 位于 `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`。原生测试包含明确忽略的钥匙串签名/ACL 和真实服务集成测试，CI 不会自动调用个人 Vaultwarden 或系统认证对话框。应用 ZIP 使用 macOS `ditto --keepParent --sequesterRsrc` 打包以保留应用结构与资源。

## 外观与快速搜索验证

外观中的明暗模式与 9 种内置配色独立保存，桌面主窗口和快速窗口实时同步；浏览器扩展使用同一套界面与令牌。`bun scripts/appearance-smoke.ts` 检查选择、持久化、跨窗口同步、系统主题变化及窄屏下拉边界，需设置 `ONEWARDEN_PUPPETEER`（可选 `ONEWARDEN_EDGE`）。

桌面「设置 → 外观 → 快速搜索」可长期关闭快速窗口，原生层同时注销快捷键、禁用托盘入口。窗口默认失焦隐藏；右上角固定按钮只作用于本次打开，Esc 总能关闭。Windows 的快速复制由主窗口调用受窗口身份限制的原生剪贴板写入，30 秒后按原生所有者和每次复制的非敏感标记清理，不读取或覆盖后来复制的文本。快速窗口没有复制命令权限，也不接收密码。

`node scripts/windows-quick-smoke.mjs` 启动自己的临时 WebView2 配置，需设置 `ONEWARDEN_NATIVE_EXE` 和 `ONEWARDEN_PUPPETEER`。通过 `windows-quick-probe.ps1` 激活该测试主窗口，再仅向该进程投递快捷键消息并检查原生焦点行为，避免触发其他应用的同名快捷键。结束前恢复原快速搜索开关。`ONEWARDEN_TEST_CLIPBOARD=1` 额外测试失焦复制与真实 30 秒到期，**会以合成文本替换系统剪贴板**，不应与日常复制操作并行。macOS 原生行为仍需对应机器验证。

## 发布版本

当前包版本为 `0.1.0`。例如发布 `v0.1.1` 前，先把以下四处版本更新为 `0.1.1`：

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/extension/public/manifest.json`

运行 `bun install --lockfile-only` 更新 Bun workspace 锁文件，并运行一次不带 `--locked` 的 `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` 更新 Cargo 包版本；随后运行 `bun install --frozen-lockfile`、`bun run scripts/build-version.ts` 和 `bun run check`，提交版本及锁文件，再创建并推送 `v0.1.1` 标签。流水线会检查四处版本一致、标签匹配，然后发布安装包；手动运行只生成 Actions artifacts。现有 release 重新运行时会替换同名资产。


## 自动更新发布

普通分支、PR 和手动构建生成测试用安装包；只有与四处版本一致的 `v` 标签构建会读取 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`，启用 `createUpdaterArtifacts` 并生成签名的 `.app.tar.gz` / `.sig`。签名私钥留在开发机的仓库外目录与 GitHub Secret，不能提交到代码或写入构建日志。应用内只有公钥。

标签发布同时生成 `latest.json`，其中 `darwin-aarch64` 指向本版本的签名 archive。新 Release 先作为 draft 上传完整产物，成功后才公开；已有 Release 重试时先上传包和签名，再更新 manifest。应用使用公开的 `releases/latest/download/latest.json` 检查更新，不需要 GitHub token。下载校验通过且安装完成后显示重启提示；源码中的签名版本校验和禁止降级设置不能关闭。

Updater archive 供应用自动更新，DMG / `.app.zip` 供首次手动安装，两者用途不同。自动更新的交互及本地签名测试见 [桌面更新说明](updates.md)。
# 用户详情、资料同步与头像裁剪

详见 [account-details.md](account-details.md)：记录兼容性、跨设备偏好、设备历史范围、
桌面图片 CSP 修复和双客户端/Windows 原生回归命令。
