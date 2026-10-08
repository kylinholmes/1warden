//! Native owner for all quick-window entry points and its temporary pin.
use std::{path::PathBuf, sync::{Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Preferences { enabled: bool }
impl Default for Preferences { fn default() -> Self { Self { enabled: true } } }

pub struct QuickState {
    preferences: Mutex<Preferences>, path: PathBuf,
    pinned: AtomicBool, generation: AtomicU64,
    shortcut_error: Mutex<Option<String>>,
    #[cfg(target_os = "windows")]
    shortcut: Mutex<Option<crate::windows::Hotkey>>,
}

impl QuickState {
    pub fn new(path: PathBuf) -> Self {
        let preferences = std::fs::read(&path).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default();
        Self { preferences: Mutex::new(preferences), path, pinned: AtomicBool::new(false), generation: AtomicU64::new(0),
            shortcut_error: Mutex::new(None), #[cfg(target_os = "windows")] shortcut: Mutex::new(None) }
    }
    fn enabled(&self) -> bool { self.preferences.lock().map(|p| p.enabled).unwrap_or(false) }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickStatus { enabled: bool, shortcut_error: Option<String> }
#[derive(serde::Serialize)]
pub struct WindowState { pinned: bool, generation: u64 }

pub fn update_shortcut(app: &AppHandle) {
    let state = app.state::<QuickState>();
    let result: Result<(), String> = (|| {
        #[cfg(target_os = "windows")]
        {
            let mut shortcut = state.shortcut.lock().map_err(|_| "快捷键状态不可用")?;
            if !state.enabled() { *shortcut = None; }
            else if shortcut.is_none() { *shortcut = Some(crate::windows::register_hotkey(app.clone())?); }
        }
        #[cfg(target_os = "macos")]
        {
            if state.enabled() { crate::hotkey::register(app.clone(), crate::hotkey::DEFAULT_KEYCODE, crate::hotkey::MOD_CMD | crate::hotkey::MOD_SHIFT)?; }
            else { crate::hotkey::unregister()?; }
        }
        Ok(())
    })();
    if let Ok(mut error) = state.shortcut_error.lock() { *error = result.err(); };
}

pub fn show(app: &AppHandle) {
    let state = app.state::<QuickState>();
    if !state.enabled() { return; }
    if let Some(window) = app.get_webview_window("quick") {
        if !window.is_visible().unwrap_or(false) {
            state.pinned.store(false, Ordering::SeqCst);
            state.generation.fetch_add(1, Ordering::SeqCst);
        }
        let _ = window.show(); let _ = window.set_focus();
        let _ = app.emit_to("quick", "1warden:quick-open", ());
    }
}
pub fn hide(app: &AppHandle) {
    let state = app.state::<QuickState>();
    state.pinned.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("quick") { let _ = window.hide(); }
}
pub fn focus_lost(app: &AppHandle) {
    if let Some(state) = app.try_state::<QuickState>() {
        if !state.pinned.load(Ordering::SeqCst) { hide(app); }
    }
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" { Ok(()) } else { Err("只能从主窗口更改快速搜索设置".into()) }
}
#[tauri::command]
pub fn quick_status(app: AppHandle, window: tauri::WebviewWindow) -> Result<QuickStatus, String> {
    require_main(window.label())?;
    let state = app.state::<QuickState>();
    let shortcut_error = state.shortcut_error.lock().map_err(|_| "快捷键状态不可用")?.clone();
    Ok(QuickStatus { enabled: state.enabled(), shortcut_error })
}
#[tauri::command]
pub fn quick_set_enabled(app: AppHandle, window: tauri::WebviewWindow, enabled: bool) -> Result<QuickStatus, String> {
    require_main(window.label())?;
    let state = app.state::<QuickState>();
    {
        let mut prefs = state.preferences.lock().map_err(|_| "设置状态不可用")?;
        let next = Preferences { enabled };
        if let Some(parent) = state.path.parent() { std::fs::create_dir_all(parent).map_err(|_| "无法保存快速搜索设置")?; }
        std::fs::write(&state.path, serde_json::to_vec(&next).map_err(|_| "无法保存设置")?).map_err(|_| "无法保存快速搜索设置")?;
        *prefs = next;
    }
    update_shortcut(&app);
    crate::tray::set_quick_enabled(&app, enabled);
    if !enabled { hide(&app); }
    quick_status(app, window)
}
#[tauri::command]
pub fn quick_window_state(app: AppHandle, window: tauri::WebviewWindow) -> Result<WindowState, String> {
    if window.label() != "quick" { return Err("只用于快速搜索窗口".into()); }
    let state = app.state::<QuickState>();
    Ok(WindowState { pinned: state.pinned.load(Ordering::SeqCst), generation: state.generation.load(Ordering::SeqCst) })
}
#[tauri::command]
pub fn quick_set_pinned(app: AppHandle, window: tauri::WebviewWindow, pinned: bool) -> Result<bool, String> {
    if window.label() != "quick" { return Err("只用于快速搜索窗口".into()); }
    let state = app.state::<QuickState>();
    if !state.enabled() || !window.is_visible().map_err(|e| e.to_string())? { return Err("快速搜索未打开".into()); }
    state.pinned.store(pinned, Ordering::SeqCst);
    if !pinned && !window.is_focused().unwrap_or(false) { hide(&app); }
    Ok(pinned)
}
pub fn enabled(app: &AppHandle) -> bool { app.state::<QuickState>().enabled() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn preferences_round_trip_without_persisting_pin() {
        assert!(Preferences::default().enabled);
        let json = serde_json::to_string(&Preferences { enabled: false }).unwrap();
        assert_eq!(json, "{\"enabled\":false}");
        assert!(!serde_json::from_str::<Preferences>(&json).unwrap().enabled);
    }
    #[test] fn only_main_can_change_global_preferences() {
        assert!(require_main("main").is_ok());
        for label in ["quick", "", "extension"] { assert!(require_main(label).is_err()); }
    }
}
