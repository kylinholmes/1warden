//! 全局快捷键。
//!
//! 用 Carbon 的 `RegisterEventHotKey` —— 它是**系统级注册**，
//! **不需要辅助功能权限**（合成按键才需要，那是另一件事）。
//!
//! ## 为什么自己写而不用现成的 crate
//!
//! 需要的只有三个 C 函数和两个常量，封装成 crate 反而多一层版本风险。
//! Carbon 虽然年年被说「废弃」，但这几个符号从 2001 年至今没动过，
//! 而且系统里所有做全局热键的应用走的都是它。
//!
//! ## ⚠️ 回调是 C 函数指针
//!
//! 它**不能捕获闭包**，所以 AppHandle 只能放静态变量。回调在主线程上执行 ——
//! 往里做重活会卡住整个界面，所以这里只做「显示窗口」这一件事。

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// 默认快捷键：⌘⇧\
///
/// 刻意避开 1Password 的 ⌘\ —— 用户很可能两个都装着，
/// 抢同一个组合键会变成「谁先启动谁赢」的随机行为。
pub const DEFAULT_KEYCODE: u32 = 42; // kVK_ANSI_Backslash
pub const MOD_CMD: u32 = 0x0100;
pub const MOD_SHIFT: u32 = 0x0200;

// Carbon 的四字符码，写成数值是为了不依赖任何头文件
const K_EVENT_CLASS_KEYBOARD: u32 = 0x6B65_7962; // 'keyb'
const K_EVENT_HOTKEY_PRESSED: u32 = 5;
const K_EVENT_PARAM_DIRECT_OBJECT: u32 = 0x2D2D_2D2D; // '----'
const TYPE_EVENT_HOTKEY_ID: u32 = 0x686B_6964; // 'hkid'

/// 用来在系统里标识我们的热键，避免和其他应用撞号
const SIGNATURE: u32 = 0x434F_4646; // 'COFF'

#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

type EventHandlerProc = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn InstallEventHandler(
        target: *mut c_void,
        handler: EventHandlerProc,
        num_types: u32,
        type_list: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut *mut c_void,
    ) -> i32;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        hot_key_id: EventHotKeyId,
        target: *mut c_void,
        options: u32,
        out_ref: *mut *mut c_void,
    ) -> i32;
    fn GetEventParameter(
        event: *mut c_void,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> i32;
}

/// 注册成功后的引用。丢了它热键就失效，所以必须留着一份。
static HOTKEY_REF: Mutex<Option<usize>> = Mutex::new(None);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// Carbon 的回调。**不能捕获任何东西** —— 所以状态只能走静态变量。
extern "C" fn on_hotkey(
    _next: *mut c_void,
    event: *mut c_void,
    _user_data: *mut c_void,
) -> i32 {
    // 读出是哪个热键被按下。我们只注册了一个，但参数还是要取 ——
    // 不取的话 Carbon 认为事件没被处理，会继续往上传。
    let mut id = EventHotKeyId { signature: 0, id: 0 };
    // SAFETY: 按 Carbon 文档传入正确的类型与缓冲区大小
    unsafe {
        GetEventParameter(
            event,
            K_EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<EventHotKeyId>(),
            std::ptr::null_mut(),
            &mut id as *mut EventHotKeyId as *mut c_void,
        );
    }
    if id.signature != SIGNATURE {
        return 0; // 不是我们的热键，交回去
    }

    // 只做「显示并聚焦窗口」——回调在主线程上，重活会卡住整个界面
    if let Ok(app) = APP.lock() {
        if let Some(app) = app.as_ref() {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
    }
    0 // noErr
}

/// 注册全局快捷键。返回可读的错误串，让界面能如实告诉用户为什么没生效。
pub fn register(app: AppHandle, key_code: u32, modifiers: u32) -> Result<(), String> {
    {
        let mut slot = APP.lock().map_err(|_| "内部状态不可用")?;
        *slot = Some(app);
    }

    // SAFETY: 这几个调用都是 Carbon 的标准用法，参数按文档给
    unsafe {
        let target = GetApplicationEventTarget();
        if target.is_null() {
            return Err("拿不到应用事件目标".into());
        }

        let spec = EventTypeSpec {
            event_class: K_EVENT_CLASS_KEYBOARD,
            event_kind: K_EVENT_HOTKEY_PRESSED,
        };
        let mut handler_ref: *mut c_void = std::ptr::null_mut();
        let install = InstallEventHandler(
            target,
            on_hotkey,
            1,
            &spec,
            std::ptr::null_mut(),
            &mut handler_ref,
        );
        if install != 0 {
            return Err(format!("安装事件处理器失败（Carbon 错误码 {install}）"));
        }

        let mut hotkey_ref: *mut c_void = std::ptr::null_mut();
        let status = RegisterEventHotKey(
            key_code,
            modifiers,
            EventHotKeyId { signature: SIGNATURE, id: 1 },
            target,
            0,
            &mut hotkey_ref,
        );
        if status != 0 {
            // -9868 = eventHotKeyExistsErr：被别的应用占了
            return Err(if status == -9868 {
                "这个组合键已被其他应用占用".into()
            } else {
                format!("注册全局快捷键失败（Carbon 错误码 {status}）")
            });
        }

        if let Ok(mut slot) = HOTKEY_REF.lock() {
            *slot = Some(hotkey_ref as usize);
        }
    }

    Ok(())
}

// ── 按键码的换算（纯逻辑，可测） ──

/// 一个按键组合的可读描述，用于界面显示与日志。
pub fn describe(modifiers: u32, key_code: u32) -> String {
    let mut s = String::new();
    if modifiers & 0x1000 != 0 { s.push('⌃'); }
    if modifiers & 0x0800 != 0 { s.push('⌥'); }
    if modifiers & MOD_SHIFT != 0 { s.push('⇧'); }
    if modifiers & MOD_CMD != 0 { s.push('⌘'); }
    s.push_str(match key_code {
        42 => "\\",
        43 => ",",
        44 => "/",
        47 => ".",
        49 => "Space",
        _ => "?",
    });
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_the_default_shortcut() {
        assert_eq!(describe(MOD_CMD | MOD_SHIFT, DEFAULT_KEYCODE), "⇧⌘\\");
    }

    #[test]
    fn modifier_order_is_the_conventional_one() {
        // macOS 的惯例顺序是 ⌃⌥⇧⌘
        assert_eq!(describe(0x1000 | 0x0800 | MOD_SHIFT | MOD_CMD, 42), "⌃⌥⇧⌘\\");
    }

    #[test]
    fn describes_a_bare_key() {
        assert_eq!(describe(0, 42), "\\");
    }
}
