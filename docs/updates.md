# 跨端应用更新

各端从公开的 [GitHub Releases 更新清单](https://github.com/kylinholmes/1warden/releases/latest/download/latest.json)检查新版本。桌面及移动端启动 10 秒后检查，运行期间每 6 小时复查；扩展在打开弹窗时立即检查，避免短暂打开时错过提示。设置的“关于 → 应用更新”支持主动检查。预览页和桌面快速窗口不启动检查。

| 客户端 | 更新行为 |
| --- | --- |
| Apple Silicon macOS | 下载并验签后替换 `.app`，提示“重启更新”，也可退出后下次打开生效 |
| Windows x64 安装版 | 后台下载并验签，提示“安装并重启”；仅用户点击后启动 NSIS 安装器，由安装器重新打开应用 |
| Windows 免安装版及其他桌面构建 | 检查版本并弹出更新提示，前往 Releases 按原方式手动更新 |
| Chromium / Firefox 扩展 | 弹出新版本提示，通过扩展管理页或原安装渠道更新；手动加载的扩展需下载新包并重新加载 |
| iOS / Android 移动端 | 弹出新版本提示，提示通过应用商店、测试分发或原安装包渠道更新，并提供可选择的发布说明网址 |

Windows 通过应用目录中 NSIS 的 `uninstall.exe` 区分安装版和免安装版。Windows 不会在后台直接调用 `downloadAndInstall`：该 API 会退出进程，因此先调用 `download`，等用户确认再 `install`。退出时未安装的下载不会保留，下次启动会重新检查；不会承诺“下次打开自动生效”。行为依据 [Tauri 更新器文档](https://v2.tauri.app/plugin/updater/)及固定版本的原生/JS 实现。

原生检查遇到清单缺少当前平台等错误时，会尝试读取公开版本信息，发现新版本则提示手动更新。下载、签名验证或安装失败时，保留已知新版本，弹窗提供重试和手动更新入口。无法获取版本时不会误报“已是最新版本”。“稍后”只关闭本次窗口中该版本/状态的提示，设置入口仍然保留。提示不抢焦点、不自动重启、不接触保险库。

移动端提示目前比较同一项目的发布版本，不能证明商店/测试渠道已上架该版本；当前 Release 流水线不产出移动安装包。提示明确引导用户检查原渠道，不能在移动端安装桌面包。扩展和移动端产物不包含原生 updater 安装代码。

桌面自动安装由官方 Tauri 2 updater 插件处理，Rust 和 JavaScript 依赖都固定为 `2.13.1`。只有 macOS / Windows 主窗口拥有检查和下载/安装权限；快速窗口及移动端没有原生更新安装权限。macOS 重启复用 Tauri 的 `AppHandle.restart()`，仅主窗口的主动操作可调用，无需 process 插件。

更新包采用 Tauri 的 minisign 签名，应用内置公开验证密钥；验证失败不进入安装步骤。`requireSignedVersion: true` 要求签名中的版本与清单一致，`allowDowngrades: false` 禁止降级。macOS 构建生成签名 `.app.tar.gz`；Windows 的已验证 NSIS 安装包由最终发布 job 使用固定版本 Tauri CLI 的 `signer sign --app-version` 签名。清单必须同时包含 `darwin-aarch64` 和 `windows-x86_64` 的真实签名及版本化地址，缺失安装包或签名则拒绝发布。Windows 测试/构建 job 仍不读取签名密钥。手动提示只读取公开版本元数据，不执行任何远程文件。要求来自 [官方更新器文档](https://v2.tauri.app/plugin/updater/)及[固定版本的配置说明](https://docs.rs/tauri-plugin-updater/2.13.1/tauri_plugin_updater/struct.Config.html)。

私钥只保存在仓库外的受限文件和 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 中，不提交到 Git。只有受信任的 `main` push 的 macOS 构建和最终发布 job 使用签名私钥；普通分支和 Pull Request 不读取私钥。保管好原始签名私钥，已有客户端只信任对应公钥，丢失私钥后无法继续向它们发布同一信任链下的更新。

项目此前不使用官方存储/生物识别插件，是因为它们不能满足保险库密钥保管要求。更新器是用户授权的明确例外：它不保存保险库密钥，提供签名验证和原生安装流程。应用沿用 `app.onewarden.desktop` 身份，不迁移或重置本地设置及认证条目。

更新签名与 Apple 的应用签名是两套机制。当前应用采用 ad-hoc 代码签名，仍未经过 Developer ID 签名或公证；首次安装的 Gatekeeper 操作见[构建与下载](builds.md)。更新需要联网并能写入应用安装目录；网络、签名或安装失败会在界面显示错误，用户可重试。

`bun run check` 覆盖版本比较、平台选择、原生/手动回退、失败重试、Windows 延迟安装和发布清单。`bun run test:ui -- ui --only=updater` 运行真实 Edge 中的更新界面回归，覆盖下载完成前不提示、用户主动重启、手动提示、失败兜底、窄屏和“稍后”后保留设置入口。此回归使用合成下载，不运行真实安装器。

新逻辑只能在安装包含本次修改的客户端后生效。旧 Windows、扩展和移动客户端需要先按原方式升级一次。跨版本的真实 Windows 安装/重启、macOS 原生安装及移动设备提示仍需对应发布包和设备验收。
