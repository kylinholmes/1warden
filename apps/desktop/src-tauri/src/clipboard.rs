//! Main-WebView-only Windows copy. No read API or password is exposed to quick.
use std::{time::Duration, sync::{OnceLock, atomic::{AtomicU64, Ordering}}};
use windows_sys::Win32::{Foundation::{GlobalFree, HGLOBAL, HWND}, System::{DataExchange::*, Memory::*}};
const UNICODE_TEXT: u32 = 13;
const CLEAR_AFTER: Duration = Duration::from_secs(30);
static COPY_ID: AtomicU64 = AtomicU64::new(1);
static MARKER_FORMAT: OnceLock<u32> = OnceLock::new();
fn authorize(label: &str) -> Result<(), String> {
    if label == "main" { Ok(()) } else { Err("只能由主窗口复制保险库内容".into()) }
}
fn encode(value: &str) -> Result<Vec<u16>, String> {
    if value.len() > 65_536 || value.contains('\0') { return Err("内容过长或包含不支持的空字符，未复制".into()); }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}
struct Clipboard;
impl Clipboard {
    fn open(owner: HWND) -> Result<Self, String> {
        for _ in 0..10 {
            // SAFETY: owner's live HWND; a foreground document is not required.
            if unsafe { OpenClipboard(owner) } != 0 { return Ok(Self); }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("剪贴板正在被其他应用使用，请重试".into())
    }
}
impl Drop for Clipboard { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
struct Allocation(HGLOBAL);
impl Drop for Allocation { fn drop(&mut self) { if !self.0.is_null() { unsafe { GlobalFree(self.0); } } } }
fn unchanged(expected: u64, current: u64) -> bool { expected != 0 && expected == current }
fn clear_if_unchanged(owner: usize, format: u32, token: u64) {
    // Windows may increment its sequence when CloseClipboard synthesizes formats.
    // A private non-secret marker plus the owner identifies this exact copy instead.
    // Compare and clear under the same lock; never read or retain clipboard text.
    if let Ok(_clipboard) = Clipboard::open(owner as HWND) {
        unsafe {
            if GetClipboardOwner() != owner as HWND { return; }
            let marker = GetClipboardData(format);
            if marker.is_null() || GlobalSize(marker) < std::mem::size_of::<u64>() { return; }
            let data = GlobalLock(marker);
            if data.is_null() { return; }
            let actual = std::ptr::read_unaligned(data.cast::<u64>());
            GlobalUnlock(marker);
            if unchanged(token, actual) { EmptyClipboard(); }
        }
    }
}
fn write(owner: HWND, value: &str) -> Result<(u32, u64), String> {
    let format = *MARKER_FORMAT.get_or_init(|| {
        let name: Vec<u16> = "1Warden.ClipboardExpiry".encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    });
    if format == 0 { return Err("无法设置剪贴板清理标记".into()); }
    let token = COPY_ID.fetch_add(1, Ordering::SeqCst);
    let mut marker = Allocation(unsafe { GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u64>()) });
    if marker.0.is_null() { return Err("无法分配剪贴板内存".into()); }
    let marker_data = unsafe { GlobalLock(marker.0) };
    if marker_data.is_null() { return Err("无法写入剪贴板标记".into()); }
    unsafe { std::ptr::write_unaligned(marker_data.cast::<u64>(), token); GlobalUnlock(marker.0); }
    let mut units = encode(value)?;
    let bytes = units.len() * std::mem::size_of::<u16>();
    // SAFETY: allocation fits the complete UTF-16 string and NUL terminator.
    let mut memory = Allocation(unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) });
    if memory.0.is_null() { return Err("无法分配剪贴板内存".into()); }
    let destination = unsafe { GlobalLock(memory.0) };
    if destination.is_null() { return Err("无法写入剪贴板内存".into()); }
    unsafe {
        std::ptr::copy_nonoverlapping(units.as_ptr(), destination.cast::<u16>(), units.len());
        GlobalUnlock(memory.0);
    }
    units.fill(0);
    let _clipboard = Clipboard::open(owner)?;
    if unsafe { EmptyClipboard() } == 0 { return Err("无法更新剪贴板".into()); }
    if unsafe { SetClipboardData(UNICODE_TEXT, memory.0) }.is_null() { return Err("复制失败，请重试".into()); }
    memory.0 = std::ptr::null_mut(); // Windows owns the memory after SetClipboardData.
    if unsafe { SetClipboardData(format, marker.0) }.is_null() {
        unsafe { EmptyClipboard(); } // Never leave a secret without its cleanup marker.
        return Err("无法安排剪贴板清理，已取消复制".into());
    }
    marker.0 = std::ptr::null_mut();
    Ok((format, token))
}
#[tauri::command]
pub async fn clipboard_copy(window: tauri::WebviewWindow, value: String) -> Result<(), String> {
    authorize(window.label())?;
    let owner = window.hwnd().map_err(|_| "主窗口不可用")?.0 as usize;
    let (format, token) = write(owner as HWND, &value)?;
    // The timer retains only this copy's identifier, not plaintext.
    if std::thread::Builder::new().name("1warden-clipboard-expiry".into()).spawn(move || {
        std::thread::sleep(CLEAR_AFTER); clear_if_unchanged(owner, format, token);
    }).is_err() {
        clear_if_unchanged(owner, format, token);
        return Err("无法安排剪贴板清理，已取消复制，请重试".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_main_can_write() { assert!(authorize("main").is_ok()); assert!(authorize("quick").is_err()); }
    #[test] fn unicode_is_lossless_and_nul_is_rejected() {
        let units = encode("密🔑a").unwrap(); assert_eq!(units.last(), Some(&0));
        assert_eq!(String::from_utf16(&units[..units.len()-1]).unwrap(), "密🔑a");
        assert!(encode("a\0b").is_err()); assert!(encode(&"a".repeat(65_537)).is_err());
    }
    #[test] fn expiry_only_clears_the_original_copy() {
        assert!(unchanged(42, 42)); assert!(!unchanged(42, 43)); assert!(!unchanged(0, 0));
    }
}
