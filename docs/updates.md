# 桌面自动更新

Apple Silicon macOS 桌面版从公开的 [GitHub Releases 更新清单](https://github.com/kylinholmes/1warden/releases/latest/download/latest.json)检查新版本，下载并验证更新后替换当前 `.app`。当前进程继续运行；下次退出后重新打开会运行新版本，也可以在界面中主动选择“重启更新”。这与 [Tauri 更新器的 macOS 行为](https://docs.rs/tauri-plugin-updater/2.13.1/tauri_plugin_updater/struct.Update.html#method.download_and_install)一致。浏览器扩展和移动端不使用此更新器。

更新由官方 Tauri 2 updater 插件处理，Rust 和 JavaScript 依赖都固定为 `2.13.1`。主窗口在 macOS 上拥有检查和下载/安装权限；快速窗口及移动端没有更新权限。重启复用 Tauri 的 `AppHandle.restart()`，仅主窗口的主动操作可调用，无需 process 插件。

更新包采用 Tauri 的 minisign 签名，应用内置公开验证密钥；验证失败不进入安装步骤。`requireSignedVersion: true` 要求签名中的版本与清单一致，`allowDowngrades: false` 禁止降级。发布流程使用带版本绑定的 Tauri CLI 签名，生成 `.app.tar.gz` 与 `.sig`，再把真实签名文本和 `darwin-aarch64` 下载地址写入 `latest.json`。这些要求来自 [官方更新器文档](https://v2.tauri.app/plugin/updater/)及[固定版本的配置说明](https://docs.rs/tauri-plugin-updater/2.13.1/tauri_plugin_updater/struct.Config.html)。

私钥只保存在仓库外的受限文件和 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 中，不提交到 Git。只有受信任的版本标签构建生成签名更新包；普通分支和 Pull Request 构建关闭 updater artifacts，不读取签名私钥。保管好原始签名私钥，已有客户端只信任对应公钥，丢失私钥后无法继续向它们发布同一信任链下的更新。

项目此前不使用官方存储/生物识别插件，是因为它们不能满足保险库密钥保管要求。更新器是用户授权的明确例外：它不保存保险库密钥，提供签名验证和原生安装流程。本次应用身份切换为 `app.onewarden.desktop`，钥匙串服务同步换新，不迁移旧身份的本地设置或认证条目。后续沿用新身份的更新不会主动重置这些设置。

更新签名与 Apple 的应用签名是两套机制。当前应用采用 ad-hoc 代码签名，仍未经过 Developer ID 签名或公证；首次安装的 Gatekeeper 操作见[构建与下载](builds.md)。更新需要联网并能写入应用安装目录；网络、签名或安装失败会在界面显示错误，用户可重试。
