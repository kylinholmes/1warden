//! Main-WebView-only Windows copy. No read API or password is exposed to quick.
use std::{time::Duration, sync::{OnceLock, atomic::{AtomicU64, Ordering}}};
use windows_sys::Win32::{Foundation::{GlobalFree, HGLOBAL, HWND}, System::{DataExchange::*, Memory::*}};
const UNICODE_TEXT: u32 = 13;
const CLEAR_AFTER: Duration = Duration::from_secs(30);
static COPY_ID: AtomicU64 = AtomicU64::new(1);
static FORMATS: OnceLock<Formats> = OnceLock::new();
struct Formats { marker: u32, exclude_monitoring: u32, allow_history: u32, allow_cloud: u32 }
fn registered_formats() -> Result<&'static Formats, String> {
    fn register(name: &str) -> u32 {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }
    let formats = FORMATS.get_or_init(|| Formats {
        marker: register("1Warden.ClipboardExpiry"),
        exclude_monitoring: register("ExcludeClipboardContentFromMonitorProcessing"),
        allow_history: register("CanIncludeInClipboardHistory"),
        allow_cloud: register("CanUploadToCloudClipboard"),
    });
    if [formats.marker, formats.exclude_monitoring, formats.allow_history, formats.allow_cloud].contains(&0) {
        return Err("无法启用剪贴板隐私保护，未复制".into());
    }
    Ok(formats)
}
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
impl Allocation {
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let memory = Self(unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) });
        if memory.0.is_null() { return Err("无法分配剪贴板内存".into()); }
        let destination = unsafe { GlobalLock(memory.0) };
        if destination.is_null() { return Err("无法写入剪贴板内存".into()); }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast::<u8>(), bytes.len());
            GlobalUnlock(memory.0);
        }
        Ok(memory)
    }
    // The caller holds the open clipboard for the complete write transaction.
    fn publish(&mut self, format: u32) -> Result<(), String> {
        if unsafe { SetClipboardData(format, self.0) }.is_null() {
            // Never leave partial content (or a secret without its protections).
            unsafe { EmptyClipboard(); }
            return Err("无法完成受保护的剪贴板复制，请重试".into());
        }
        self.0 = std::ptr::null_mut(); // Windows now owns the allocation.
        Ok(())
    }
}
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
    let formats = registered_formats()?;
    let token = COPY_ID.fetch_add(1, Ordering::SeqCst);
    let mut marker = Allocation::from_bytes(&token.to_ne_bytes())?;
    // EmptyClipboard only clears the current value; it cannot remove Win+V
    // history or cloud copies. Opt out when writing, before exposing any text.
    // https://learn.microsoft.com/windows/win32/dataxchg/clipboard-formats#cloud-clipboard-and-clipboard-history-formats
    // Exclusion takes any non-NULL data; the other two formats require DWORD 0.
    // All handles contain actual data, not NULL (which means delayed rendering).
    let mut exclude_monitoring = Allocation::from_bytes(&1u32.to_ne_bytes())?;
    let mut allow_history = Allocation::from_bytes(&0u32.to_ne_bytes())?;
    let mut allow_cloud = Allocation::from_bytes(&0u32.to_ne_bytes())?;
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
    exclude_monitoring.publish(formats.exclude_monitoring)?;
    allow_history.publish(formats.allow_history)?;
    allow_cloud.publish(formats.allow_cloud)?;
    marker.publish(formats.marker)?;
    memory.publish(UNICODE_TEXT)?;
    // Validate publication without reading back any clipboard text. Keep the
    // lock until this check completes, so another writer cannot race it.
    if unsafe { GetClipboardOwner() != owner || IsClipboardFormatAvailable(UNICODE_TEXT) == 0 } {
        unsafe { EmptyClipboard(); }
        return Err("剪贴板未能提供可粘贴的文本，请重试".into());
    }
    Ok((formats.marker, token))
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
