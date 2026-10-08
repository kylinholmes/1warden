//! 1Warden 桌面端的外壳。
//!
//! 目前这一层刻意保持**极薄**：界面与密码学都在 Web 侧。
//! 后续会往这里搬三样东西，都有明确的理由：
//!
//! 1. **安全存储** —— refresh token 与设备密钥进系统钥匙串。
//!    放进 Web 侧意味着它躺在 localStorage 里，任何 XSS 都能拿走。
//!    计划用 `SecAccessControl(.userPresence)` 保护，让**操作系统**强制
//!    「必须先通过生物识别才能取出密钥」—— 而不是靠 JS 层的一个 if。
//!
//! 2. **网络请求** —— 把 HTTP 搬到 Rust 侧可以让 access token 不进入 WebView。
//!    顺带解决自签证书问题（Rust 侧可以控制 TLS 信任）。
//!
//! 3. **原生窗口自动填充** —— spec §7.4 的桌面端核心差异化功能。
//!    走 macOS 辅助功能 API（`AXUIElement`），Rust 后端可以直接调，
//!    不需要任何 App Extension。
//!
//! ⚠️ 两条硬不变量（spec §7.4）：
//!   I1. **绝不主动读取**其他应用的界面内容。当前实现只往当前焦点**写**。
//!   I2. 合成按键**没有**读回验证的可能（看不到目标控件），所以界面上
//!       只能说「按键已发送」，**不能**说「已填充」。

/*
 * 模块的平台归属 —— 三种情况，别混。
 *
 * | | 怎么写 | 为什么 |
 * |---|---|---|
 * | 两端都要 | 不写 cfg | `http` 是网络层，移动端一样要走 |
 * | **自己管自己** | 不写 cfg | `autotype` / `hotkey` 在文件顶上写了 `#![cfg(...)]`，别处不用再写一遍 |
 * | **要在这里管** | `#[cfg(desktop)]` | `save` / `tray` —— 它们**自己不知道**自己只属于桌面端 |
 *
 * ⚠️ 第三种是最容易漏的：`save.rs` 里没有任何 `cfg`，它只是**用了** `rfd`。
 * 而 `rfd` 在 iOS 上编不过（见 Cargo.toml 那一节），于是错会报在依赖里 ——
 * 指向一个和我们代码无关的地方。所以「用了桌面专属的 crate」这件事，
 * 必须在这张表上体现出来。
 *
 * ⚠️ `cfg(desktop)` / `cfg(mobile)` 是 `tauri_build::build()` 通过 build script
 * 发的（tauri-build 的 `cfg_alias`，实测确认过），所以在这个 crate 里可用。
 * 这和 Cargo.toml 里**不能**用它们是同一件事的两面 —— 那边只有 target triple。
 */
mod http;
mod autotype;
#[cfg(desktop)]
mod save;
#[cfg(desktop)]
mod website;
mod hotkey;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(all(test, target_os = "windows"))]
#[path = "../build_support.rs"]
mod build_support;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod quick;
#[cfg(target_os = "windows")]
mod clipboard;
#[cfg(target_os = "macos")]
mod biometric;

use tauri::Manager;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn app_updates_supported(window: tauri::WebviewWindow) -> bool {
    cfg!(target_os = "macos") && window.label() == "main"
}

/// 已验证的更新安装到原应用路径后，由用户选择重启来运行新版本。
/// 复用 Tauri 的进程重启，无需另引入 process 插件；快速窗口不能调用。
#[cfg(desktop)]
#[tauri::command]
fn restart_app(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只能从主窗口重启应用".into());
    }
    app.restart();
}

/*
 * ⚠️ 下面这三条是**桌面端专属**的，因为它们都是「第二个窗口」这件事的一部分 ——
 * 快速面板是一个 `alwaysOnTop` / `skipTaskbar` 的常驻小窗（见 tauri.conf.json），
 * 移动端没有这个形态：那边一个应用就是一块屏幕。
 *
 * 这里的 `#[cfg(desktop)]` 不是我加的洁癖 —— 不加**编不过**：
 * `WebviewWindow::minimize` / `unminimize` 在 Tauri 里本身就是桌面端才有的方法。
 * 换句话说，这条 cfg 只是把「本来就成立的事实」写出来。
 *
 * 调用方（`quick/main.tsx`、`AutotypeAction.tsx`）也都在桌面端专属的入口里，
 * 所以移动端不会出现「调一个不存在的命令」那种失败 —— 那种失败报的是
 * 一句英文的 `command not found`，和真正的原因离得很远。
 */

/// 最小化主窗口。
///
/// ⚠️ 走 Rust 命令而不是前端的 `getCurrentWindow().minimize()`：
/// Tauri v2 的 `core:window:default` 里**只有只读权限**（一堆 getter），
/// `minimize` 不在其中。前端直接调会因为没有 ACL 授权而失败，
/// 而我们的调用点又用 `.catch(() => {})` 兜着 —— 于是它**一直静默失败**：
/// 自动输入倒计时结束时主窗口根本没让出焦点，按键有可能敲进我们自己的界面。
///
/// 自定义命令不受 ACL 约束，所以这条路既安全又不用放宽权限。
#[cfg(desktop)]
#[tauri::command]
fn main_minimize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

/// 收起快速面板。Esc、选中条目、失焦都走它。
#[cfg(desktop)]
#[tauri::command]
fn quick_hide(app: tauri::AppHandle) {
    quick::hide(&app);
}

/// 从快速面板切到主窗口 —— 面板一次只够做一件事，需要完整界面时把主窗口叫出来。
#[cfg(desktop)]
#[tauri::command]
fn quick_open_main(app: tauri::AppHandle) {
    quick::hide(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "quick" {
                match event {
                    tauri::WindowEvent::Focused(false) => quick::focus_lost(window.app_handle()),
                    tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); quick::hide(window.app_handle()); }
                    _ => {}
                }
            }
            // Keep the primary WebView alive for tray/quick access after closing on Windows.
            #[cfg(target_os = "windows")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(target_os = "windows"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_updates_supported,
            #[cfg(target_os = "windows")]
            clipboard::clipboard_copy,
            #[cfg(desktop)]
            quick::quick_status,
            #[cfg(desktop)]
            quick::quick_set_enabled,
            #[cfg(desktop)]
            quick::quick_window_state,
            #[cfg(desktop)]
            quick::quick_set_pinned,
            #[cfg(target_os = "windows")]
            windows::window_action,
            #[cfg(target_os = "windows")]
            windows::window_theme,
            #[cfg(desktop)]
            restart_app,
            http::http_request,
            http::probe_certificate,
            http::trust_certificate,
            http::forget_certificate,
            autotype::autotype_status,
            autotype::autotype_set_enabled,
            autotype::autotype_open_settings,
            autotype::autotype_type,
            #[cfg(desktop)]
            main_minimize,
            #[cfg(desktop)]
            quick_hide,
            #[cfg(desktop)]
            quick_open_main,
            // 存附件要弹系统对话框（`rfd`），移动端没有这个概念 ——
            // 那边走的是分享面板，是另一套东西，不是这一套的移植
            #[cfg(desktop)]
            save::save_file,
            #[cfg(desktop)]
            website::open_website,
            #[cfg(target_os = "macos")]
            biometric::biometric_status,
            #[cfg(target_os = "macos")]
            biometric::biometric_enroll,
            #[cfg(target_os = "macos")]
            biometric::biometric_unlock,
            #[cfg(target_os = "macos")]
            biometric::biometric_forget,
        ])
        .setup(|app| {
            // 证书指纹固定存在应用数据目录里 —— 它属于「这台机器信任了什么」，
            // 不属于用户数据，卸载应用时应当随之消失
            let dir = app.path().app_data_dir()?;
            let state = http::HttpState::new(dir.join("trusted-certs.json"))
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(state);
            #[cfg(desktop)]
            {
                app.manage(quick::QuickState::new(dir.join("quick-search.json")));
                quick::update_shortcut(app.handle());
            }

            // 菜单栏图标。密码管理器大部分时间不在前台，用户需要它的时候
            // 正在别处登录一个网站 —— 常驻入口比主窗口重要。
            //
            // ⚠️ 移动端**没有对应物**，不是「还没做」：iOS 的常驻入口是主屏幕
            // 图标，那属于系统，不属于应用。所以这里不是降级，是这一节整个不存在。
            #[cfg(desktop)]
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("[onewarden] 菜单栏图标不可用：{e}");
            }

            // 全局快捷键（⌘⇧\）：在别的应用里也能呼出 1Warden。
            // 注册失败**不影响启动** —— 组合键被占用是很常见的情况，
            // 为了这个让应用起不来是本末倒置。
            // Registration is owned by quick::QuickState and follows the saved preference.

            // 密码管理器不该在正式版里留一个能看到内存中明文的调试器。
            //
            // ⚠️ 移动端另一个概念：那边是 Safari 的 Web Inspector，由**构建设置**
            // 决定能不能连，不是一个可以在运行时「打开」的窗口。
            #[cfg(all(debug_assertions, desktop))]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }

            Ok(())
        });

    // updater 不访问保险库密钥；安装必须通过配置公钥的 minisign 验证。
    // Cargo 依赖和插件初始化都排除 iOS/Android。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    let context = {
        let mut context = context;
        windows::configure_effects(context.config_mut());
        context
    };
    builder
        .run(context)
        .expect("启动 1Warden 失败");
}
