//! Coffer 桌面端的外壳。
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

mod http;
mod autotype;
mod hotkey;
mod tray;

use tauri::Manager;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 最小化主窗口。
///
/// ⚠️ 走 Rust 命令而不是前端的 `getCurrentWindow().minimize()`：
/// Tauri v2 的 `core:window:default` 里**只有只读权限**（一堆 getter），
/// `minimize` 不在其中。前端直接调会因为没有 ACL 授权而失败，
/// 而我们的调用点又用 `.catch(() => {})` 兜着 —— 于是它**一直静默失败**：
/// 自动输入倒计时结束时主窗口根本没让出焦点，按键有可能敲进我们自己的界面。
///
/// 自定义命令不受 ACL 约束，所以这条路既安全又不用放宽权限。
#[tauri::command]
fn main_minimize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

/// 收起快速面板。Esc、选中条目、失焦都走它。
#[tauri::command]
fn quick_hide(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
}

/// 从快速面板切到主窗口 —— 面板一次只够做一件事，需要完整界面时把主窗口叫出来。
#[tauri::command]
fn quick_open_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_version,
            http::http_request,
            http::probe_certificate,
            http::trust_certificate,
            http::forget_certificate,
            autotype::autotype_status,
            autotype::autotype_set_enabled,
            autotype::autotype_open_settings,
            autotype::autotype_type,
            main_minimize,
            quick_hide,
            quick_open_main,
        ])
        .setup(|app| {
            // 证书指纹固定存在应用数据目录里 —— 它属于「这台机器信任了什么」，
            // 不属于用户数据，卸载应用时应当随之消失
            let dir = app.path().app_data_dir()?;
            let state = http::HttpState::new(dir.join("trusted-certs.json"))
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(state);

            // 开发期打开 devtools 会方便很多；发布版刻意没有这个入口 ——
            // 密码管理器不该在正式版里留一个能看到内存中明文的调试器。
            // 菜单栏图标。密码管理器大部分时间不在前台，用户需要它的时候
            // 正在别处登录一个网站 —— 常驻入口比主窗口重要。
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("[coffer] 菜单栏图标不可用：{e}");
            }

            // 全局快捷键（⌘⇧\）：在别的应用里也能呼出 Coffer。
            // 注册失败**不影响启动** —— 组合键被占用是很常见的情况，
            // 为了这个让应用起不来是本末倒置。
            #[cfg(target_os = "macos")]
            if let Err(e) = hotkey::register(
                app.handle().clone(),
                hotkey::DEFAULT_KEYCODE,
                hotkey::MOD_CMD | hotkey::MOD_SHIFT,
            ) {
                eprintln!("[coffer] 全局快捷键不可用：{e}");
            }

            // 开发期打开 devtools 会方便很多；发布版刻意没有这个入口 ——
            // 密码管理器不该在正式版里留一个能看到内存中明文的调试器。
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("启动 Coffer 失败");
}
