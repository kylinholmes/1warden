# 构建与下载

GitHub Actions 在每次 push、Pull Request 和手动运行时执行类型检查、单元测试，并生成浏览器扩展和 macOS 安装包。打开 [Actions](https://github.com/kylinholmes/1warden/actions)，选择成功的 `1Warden builds` 运行，在页面底部下载 Artifacts；构建产物保留 30 天。推送与包版本一致的 `v` 标签后，流水线会把相同的安装包和 SHA-256 校验文件发布到 [Releases](https://github.com/kylinholmes/1warden/releases)。代码与发布包已按用户选择设为公开；桌面自动更新无需 GitHub 登录。

| 产物 | 用途 |
| --- | --- |
| `1Warden-<版本>-chromium.zip` | Chrome、Edge 等 Chromium 浏览器 |
| `1Warden-<版本>-firefox.zip` | Firefox 128 及以上 |
| `1Warden-<版本>-macos-apple-silicon.dmg` | Apple Silicon Mac 的安装包，macOS 13 及以上 |
| `1Warden-<版本>-macos-apple-silicon.app.zip` | 同一 macOS 应用的压缩包 |
| `SHA256SUMS*.txt` | 下载文件的 SHA-256 校验值 |

Actions 下载的是外层 artifact ZIP，先解压它，再使用其中的安装包。项目只构建 Apple Silicon（ARM64），不提供 Intel 版本。

## 安装测试包

Chromium：解压 `chromium.zip`，打开浏览器的扩展管理页（Chrome 为 `chrome://extensions`，Edge 为 `edge://extensions`），启用开发者模式，选择“加载已解压的扩展程序”，指向包含 `manifest.json` 的目录。

Firefox：解压 `firefox.zip`，打开 `about:debugging#/runtime/this-firefox`，选择“临时载入附加组件”，打开解压目录的 `manifest.json`。临时扩展会在重启 Firefox 后移除；这些包尚未经过 Mozilla 商店签名。

macOS：打开 DMG，把 `1Warden.app` 拖到“应用程序”。也可以解压 `.app.zip` 后移动应用。当前流水线使用 [Tauri 支持的 ad-hoc 签名](https://v2.tauri.app/distribute/sign/macos/)，无需 Apple 签名凭据，但没有 Developer ID 签名或公证。首次打开被系统阻止时，按 [Apple 官方说明](https://support.apple.com/102445)在“系统设置 → 隐私与安全性”中选择“仍要打开”，确认来源后再打开。应用保留 `app.coffer.desktop` 标识，兼容既有本地设置和钥匙串条目。

## 本地构建

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
