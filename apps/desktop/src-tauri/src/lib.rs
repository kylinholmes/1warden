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
//! ⚠️ 写这些时记住两条硬不变量（spec §7.4）：
//!   I1. AX 读取只在用户按下快捷键后发生一次，**绝不在后台**
//!   I2. 写入之后必须**读回验证** —— 该 API 有文档记载会静默失败

use tauri::Manager;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .setup(|app| {
            // 开发期打开 devtools 会方便很多；发布版没有这个入口
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Coffer 失败");
}
