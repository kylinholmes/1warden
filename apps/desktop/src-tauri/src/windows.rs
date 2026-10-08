//! Windows chrome, keyboard output and global shortcut. No UI content is read.
use std::{ptr::null_mut, sync::mpsc, time::Duration};
use tauri::AppHandle;
use windows_sys::Win32::{
    System::Threading::GetCurrentThreadId,
    UI::{
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};
use crate::autotype::{autotype_enabled, TypeAction};
use tauri::{utils::config::WindowEffectsConfig, window::Effect};
use windows_sys::{Wdk::System::SystemServices::RtlGetVersion, Win32::System::SystemInformation::OSVERSIONINFOW};

fn windows_version() -> Option<(u32, u32)> {
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: initialized, correctly sized OSVERSIONINFOW; no pointers are retained.
    // Unlike GetVersionEx, RtlGetVersion is not capped by the application manifest.
    (unsafe { RtlGetVersion(&mut version) } >= 0).then_some((version.dwMajorVersion, version.dwBuildNumber))
}

fn effect_for_version(version: Option<(u32, u32)>) -> Option<Effect> {
    match version {
        Some((10, 22000..)) => Some(Effect::Mica),
        Some((10, 17763..22000)) => Some(Effect::Blur),
        _ => None,
    }
}

fn set_main_effect(config: &mut tauri::Config, version: Option<(u32, u32)>) {
    if let Some(window) = config.app.windows.iter_mut().find(|window| window.label == "main") {
        let effect = effect_for_version(version);
        // Tao adds invisible non-client resize insets for an undecorated shadow.
        // Windows 10 Blur paints those insets too, exposing a glass strip beyond
        // the WebView. Without that shadow, Tao still handles edge/corner resizing
        // inside the window. Keep the native shadow/rounded frame for Win11 Mica.
        window.shadow = matches!(effect, Some(Effect::Mica));
        window.window_effects = effect.map(|effect| WindowEffectsConfig {
            effects: vec![effect],
            ..Default::default()
        });
    }
}

/// Choose before window creation. Tauri takes the first Windows effect, not the
/// first one supported by the OS. Acrylic lags during dragging on Windows 10;
/// Blur can lag on Windows 11 22H2+, so a static fallback list is not sufficient.
pub fn configure_effects(config: &mut tauri::Config) {
    set_main_effect(config, windows_version());
}

pub const SHORTCUT: &str = "Ctrl+Shift+\\";
const HOTKEY_ID: i32 = 0x434f;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowAction { Minimize, ToggleMaximize, Close }

#[tauri::command]
pub fn window_action(window: tauri::WebviewWindow, action: WindowAction) -> Result<bool, String> {
    if window.label() != "main" { return Err("只能操作主窗口".into()); }
    let result = match action {
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() },
        WindowAction::Close => window.close(),
    };
    result.map_err(|e| e.to_string())?;
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_theme(window: tauri::WebviewWindow, theme: Option<tauri::Theme>) -> Result<(), String> {
    if window.label() != "main" { return Err("只能操作主窗口".into()); }
    window.set_theme(theme).map_err(|e| e.to_string())
}

/// Own the message thread until app shutdown; unregister on that same thread.
pub struct Hotkey(u32, Option<std::thread::JoinHandle<()>>);
impl Drop for Hotkey {
    fn drop(&mut self) {
        // SAFETY: only posts termination to the thread we created.
        unsafe { PostThreadMessageW(self.0, WM_QUIT, 0, 0); }
        if let Some(worker) = self.1.take() { let _ = worker.join(); }
    }
}

pub fn register_hotkey(app: AppHandle) -> Result<Hotkey, String> {
    let (ready, receive) = mpsc::sync_channel(1);
    let worker = std::thread::Builder::new().name("1warden-hotkey".into()).spawn(move || {
        // SAFETY: null HWND associates the registration with this message thread.
        unsafe {
            if RegisterHotKey(null_mut(), HOTKEY_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_OEM_5 as u32) == 0 {
                let _ = ready.send(Err(format!("快捷键 {SHORTCUT} 注册失败：{}", std::io::Error::last_os_error())));
                return;
            }
            let mut message = MSG::default();
            // Create the queue before publishing its ID, including for immediate shutdown.
            PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
            if ready.send(Ok(GetCurrentThreadId())).is_err() {
                UnregisterHotKey(null_mut(), HOTKEY_ID);
                return;
            }
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                if message.message == WM_HOTKEY && message.wParam == HOTKEY_ID as usize {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || crate::quick::show(&handle));
                }
            }
            UnregisterHotKey(null_mut(), HOTKEY_ID);
        }
    }).map_err(|e| e.to_string())?;
    match receive.recv().map_err(|e| e.to_string())? {
        Ok(id) => Ok(Hotkey(id, Some(worker))),
        Err(error) => { let _ = worker.join(); Err(error) }
    }
}

fn key_pair(vk: u16, scan: u16, flags: u32) -> [INPUT; 2] {
    [0, KEYEVENTF_KEYUP].map(|up| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags | up, time: 0, dwExtraInfo: 0 } },
    })
}

fn inputs(action: &TypeAction) -> Vec<INPUT> {
    match action {
        TypeAction::Text(text) => text.encode_utf16().flat_map(|unit| key_pair(0, unit, KEYEVENTF_UNICODE)).collect(),
        TypeAction::Tab => key_pair(VK_TAB, 0, 0).to_vec(),
        TypeAction::Return => key_pair(VK_RETURN, 0, 0).to_vec(),
    }
}

pub fn perform(actions: &[TypeAction]) -> Result<(), String> {
    if !autotype_enabled() { return Err("自动输入已关闭".into()); }
    // SAFETY: these APIs inspect only foreground identity and modifier state, not app content.
    let target = unsafe { GetForegroundWindow() };
    if target.is_null() { return Err("请先切换到目标窗口".into()); }
    let mut process = 0;
    unsafe { GetWindowThreadProcessId(target, &mut process); }
    if process == std::process::id() { return Err("请先切换到其他应用，再发送按键".into()); }
    let modifiers = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    if modifiers.iter().any(|key| unsafe { GetAsyncKeyState(*key as i32) } < 0) {
        return Err("请松开 Ctrl、Shift、Alt 和 Windows 键后重试".into());
    }
    for action in actions {
        if !autotype_enabled() || unsafe { GetForegroundWindow() } != target {
            return Err("目标窗口已改变，已停止发送按键".into());
        }
        let events = inputs(action);
        if events.is_empty() { continue; }
        // SAFETY: events is a live INPUT array with the required struct size.
        let sent = unsafe { SendInput(events.len() as u32, events.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if sent != events.len() as u32 {
            return Err("Windows 未接受全部按键；请确认目标窗口不是以管理员身份运行".into());
        }
        std::thread::sleep(Duration::from_millis(12));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn effects_avoid_known_slow_windows_compositors() {
        for build in [17763, 18362, 19044, 19045, 21999] {
            assert_eq!(effect_for_version(Some((10, build))), Some(Effect::Blur));
        }
        for build in [22000, 22621, 26100] {
            assert_eq!(effect_for_version(Some((10, build))), Some(Effect::Mica));
        }
        for version in [None, Some((6, 7601)), Some((10, 17762))] {
            assert_eq!(effect_for_version(version), None);
        }
    }
    #[test]
    fn only_main_gets_a_version_selected_effect() {
        let mut config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        config.app.windows = serde_json::from_value(overlay["app"]["windows"].clone()).unwrap();
        let quick = config.app.windows.iter().find(|window| window.label == "quick").unwrap().clone();
        set_main_effect(&mut config, Some((10, 19044)));
        assert_eq!(config.app.windows[0].window_effects.as_ref().unwrap().effects, vec![Effect::Blur]);
        assert!(!config.app.windows[0].shadow, "Blur must not paint the invisible native resize frame");
        assert!(config.app.windows[0].resizable);
        assert_eq!(config.app.windows.iter().find(|window| window.label == "quick").unwrap(), &quick);
        set_main_effect(&mut config, Some((10, 22621)));
        assert_eq!(config.app.windows[0].window_effects.as_ref().unwrap().effects, vec![Effect::Mica]);
        assert!(config.app.windows[0].shadow, "Windows 11 retains its native Mica frame");
        set_main_effect(&mut config, None);
        assert!(config.app.windows[0].window_effects.is_none());
        assert!(!config.app.windows[0].shadow);
    }
    #[test]
    fn native_version_probe_is_available_on_supported_windows() {
        assert!(matches!(windows_version(), Some((10.., _))));
    }
    #[test]
    fn unicode_surrogates_and_key_releases_round_trip() {
        let events = inputs(&TypeAction::Text("密🔑a".into()));
        let units: Vec<_> = events.chunks_exact(2).map(|pair| unsafe {
            assert_eq!(pair[0].Anonymous.ki.wVk, 0);
            assert_eq!(pair[0].Anonymous.ki.dwFlags, KEYEVENTF_UNICODE);
            assert_eq!(pair[1].Anonymous.ki.dwFlags, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            assert_eq!(pair[0].Anonymous.ki.wScan, pair[1].Anonymous.ki.wScan);
            pair[0].Anonymous.ki.wScan
        }).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "密🔑a");
    }
    #[test]
    fn navigation_uses_virtual_keys() {
        for (action, key) in [(TypeAction::Tab, VK_TAB), (TypeAction::Return, VK_RETURN)] {
            let events = inputs(&action);
            unsafe {
                assert_eq!(events[0].Anonymous.ki.wVk, key);
                assert_eq!(events[0].Anonymous.ki.dwFlags, 0);
                assert_eq!(events[1].Anonymous.ki.dwFlags, KEYEVENTF_KEYUP);
            }
        }
    }
}
