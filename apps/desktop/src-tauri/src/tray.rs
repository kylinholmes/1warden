//! 菜单栏图标。
//!
//! 密码管理器大部分时间不在前台，用户需要它的时候是「正在别处登录一个网站」。
//! 所以一个常驻的菜单栏入口比主窗口重要 —— 1Password 桌面版日常就是这个形态。
//!
//! 用的是 Tauri **核心**的托盘 API（`tray-icon` feature），不是任何插件。
//!
//! ## 菜单里为什么没有「复制密码」
//!
//! 托盘菜单是一次性的点击，点完就消失，没法在里面搜索选条目。硬塞一个
//! 「复制上一条」只会造出一个猜不出行为的按钮。要搜索就走**快速面板**
//! （⌘⇧\）—— 那才是干这件事的地方，菜单里只放一个入口指过去。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter as _, Manager};

/// 托盘菜单项的 id —— 与 `on_menu_event` 里的分支一一对应
const ID_OPEN: &str = "1warden.open";
const ID_QUICK: &str = "1warden.quick";
const ID_LOCK: &str = "1warden.lock";
const ID_QUIT: &str = "1warden.quit";
struct QuickMenu(MenuItem<tauri::Wry>);
pub fn set_quick_enabled(app: &AppHandle, enabled: bool) {
    if let Some(item) = app.try_state::<QuickMenu>() { let _ = item.0.set_enabled(enabled); }
}

/// 主窗口监听这个事件来锁定保险库。
///
/// ⚠️ 锁定必须由**前端**执行，不能在这里直接做：密钥和明文都在 WebView 的
/// 内存里，Rust 侧没有东西可清。壳唯一能做的是告诉前端「用户要求锁定」。
pub const EVENT_LOCK: &str = "1warden:tray-lock";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, ID_OPEN, "打开 1Warden", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, ID_QUICK, "快速搜索…", crate::quick::enabled(app), None::<&str>)?;
    let lock = MenuItem::with_id(app, ID_LOCK, "锁定保险库", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &quick, &sep, &lock, &sep, &quit])?;
    app.manage(QuickMenu(quick));

    let mut builder = TrayIconBuilder::with_id("onewarden-tray")
        .menu(&menu)
        // 左键点图标直接开面板，不弹菜单 —— 菜单留给右键。
        // 这是 macOS 菜单栏应用的惯例，用户的手比脑子先知道该点哪边。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_OPEN => show_main(app),
            ID_QUICK => show_quick(app),
            ID_LOCK => {
                // 前端不在（窗口被关了）就没什么可锁的
                let _ = app.emit_to("main", EVENT_LOCK, ());
            }
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键抬起才动作 —— 按下就动作会让「拖一下图标」也触发
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if crate::quick::enabled(tray.app_handle()) { show_quick(tray.app_handle()); }
                else { show_main(tray.app_handle()); }
            }
        });

    // macOS templates use alpha, so never pass the opaque app tile here.
    #[cfg(target_os = "macos")]
    let bytes = include_bytes!("../icons/tray-template.png").as_slice();
    #[cfg(not(target_os = "macos"))]
    let bytes = include_bytes!("../icons/tray-color.png").as_slice();
    builder = builder.icon(tauri::image::Image::from_bytes(bytes)?)
        .icon_as_template(cfg!(target_os = "macos"));

    builder.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_quick(app: &AppHandle) {
    crate::quick::show(app);
}
