//! File access is granted only by a real main-window OS drop. JavaScript receives
//! an expiring one-use ticket, never a path or a general-purpose file-read API.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::{
    fs::{self, File}, io::Read, path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering}, Mutex}, time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const TICKET_LIFETIME: Duration = Duration::from_secs(30);
const EXPIRED: &str = "拖入文件已过期，请重新拖入";
const READ_ERROR: &str = "无法读取导入文件，请检查文件是否存在及读取权限";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile { name: String, data_base64: String }

struct PendingDrop { id: String, paths: Vec<PathBuf>, created: Instant }
#[derive(Default)]
pub struct DroppedFileState { pending: Mutex<Option<PendingDrop>>, next: AtomicU64 }

impl DroppedFileState {
    fn offer(&self, label: &str, paths: &[PathBuf]) -> Option<String> {
        if label != "main" { return None; }
        let id = self.next.fetch_add(1, Ordering::Relaxed).to_string();
        // At most one ticket and two paths (enough to reject a multi-file drop).
        *self.pending.lock().ok()? = Some(PendingDrop {
            id: id.clone(), paths: paths.iter().take(2).cloned().collect(), created: Instant::now(),
        });
        Some(id)
    }
    fn claim(&self, label: &str, id: &str, accept: bool) -> Result<Option<Vec<PathBuf>>, String> {
        if label != "main" { return Err("只能在主窗口导入拖入文件".into()); }
        let mut pending = self.pending.lock().map_err(|_| READ_ERROR.to_string())?;
        if pending.as_ref().is_none_or(|drop| drop.id != id) { return Err(EXPIRED.into()); }
        let drop = pending.take().ok_or(EXPIRED)?;
        if !accept { return Ok(None); }
        if drop.created.elapsed() >= TICKET_LIFETIME { return Err(EXPIRED.into()); }
        Ok(Some(drop.paths))
    }
    fn discard(&self, id: Option<&str>) {
        if let Ok(mut pending) = self.pending.lock() {
            if id.is_none() || pending.as_ref().is_some_and(|drop| Some(drop.id.as_str()) == id) {
                *pending = None;
            }
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DropEvent { Dragging { dragging: bool }, Offered { id: String } }

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" { return; }
    let Some(state) = window.app_handle().try_state::<DroppedFileState>() else { return; };
    if matches!(event, tauri::WindowEvent::Destroyed) { state.discard(None); return; }
    let tauri::WindowEvent::DragDrop(event) = event else { return; };
    let payload = match event {
        tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => DropEvent::Dragging { dragging: true },
        tauri::DragDropEvent::Leave => DropEvent::Dragging { dragging: false },
        tauri::DragDropEvent::Drop { paths, .. } => {
            let Some(id) = state.offer(window.label(), paths) else { return; };
            let app = window.app_handle().clone();
            let expires = id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(TICKET_LIFETIME).await;
                if let Some(state) = app.try_state::<DroppedFileState>() { state.discard(Some(&expires)); }
            });
            DropEvent::Offered { id }
        }
        _ => return,
    };
    // A targeted Window event matches getCurrentWindow().listen and excludes quick.
    let _ = window.emit_to(tauri::EventTarget::Window { label: "main".into() }, "1warden:file-drop", payload);
}

#[tauri::command]
pub async fn claim_dropped_file(
    window: tauri::WebviewWindow, state: tauri::State<'_, DroppedFileState>, id: String, accept: bool,
) -> Result<Option<DroppedFile>, String> {
    let Some(paths) = state.claim(window.label(), &id, accept)? else { return Ok(None); };
    tauri::async_runtime::spawn_blocking(move || read_dropped_file(&paths)).await
        .map_err(|_| READ_ERROR.to_string())?.map(Some)
}

fn read_dropped_file(paths: &[PathBuf]) -> Result<DroppedFile, String> {
    if paths.len() != 1 { return Err("请一次拖入一个导入文件".into()); }
    let path = &paths[0];
    let metadata = fs::symlink_metadata(path).map_err(|_| READ_ERROR.to_string())?;
    if metadata.is_dir() { return Err("不能导入文件夹，请拖入一个文件".into()); }
    if !metadata.is_file() { return Err("请拖入普通文件，不支持链接或特殊文件".into()); }
    if metadata.len() > MAX_FILE_BYTES { return Err("导入文件不能超过 50 MiB".into()); }
    let file = File::open(path).map_err(|_| READ_ERROR.to_string())?;
    let opened = file.metadata().map_err(|_| READ_ERROR.to_string())?;
    if !opened.is_file() { return Err("请拖入普通文件".into()); }
    if opened.len() > MAX_FILE_BYTES { return Err("导入文件不能超过 50 MiB".into()); }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    // A file may grow after metadata was read. Bound the read itself as well.
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| READ_ERROR.to_string())?;
    if bytes.is_empty() { return Err("导入文件为空".into()); }
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("导入文件不能超过 50 MiB".into()); }
    let name = path.file_name().ok_or(READ_ERROR)?.to_string_lossy().into_owned();
    Ok(DroppedFile { name, data_base64: B64.encode(bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::{self, File}, sync::atomic::{AtomicU64, Ordering}, time::Duration};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("1warden-drop-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name); fs::write(&path, bytes).unwrap(); path
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn reads_one_regular_file_preserving_bytes_and_only_its_basename() {
        let fixture = Fixture::new();
        let file = read_dropped_file(&[fixture.file("vault.json", &[0, 137, 255])]).unwrap();
        assert_eq!(file.name, "vault.json"); assert_eq!(file.data_base64, "AIn/");
        assert_eq!(serde_json::to_value(file).unwrap(), serde_json::json!({ "name": "vault.json", "dataBase64": "AIn/" }));
    }
    #[test]
    fn rejects_zero_or_multiple_paths_before_opening_any_path() {
        for paths in [vec![], vec![PathBuf::from("missing-a"), PathBuf::from("missing-b")]] {
            assert!(read_dropped_file(&paths).err().unwrap().contains("一个"));
        }
    }
    #[test]
    fn rejects_empty_files() {
        let fixture = Fixture::new();
        assert!(read_dropped_file(&[fixture.file("empty.json", &[])]).err().unwrap().contains("空"));
    }
    #[test]
    fn rejects_directories_without_reading_them() {
        let fixture = Fixture::new();
        assert!(read_dropped_file(&[fixture.0.clone()]).err().unwrap().contains("文件夹"));
    }
    #[test]
    fn rejects_files_larger_than_fifty_mib_before_allocating_them() {
        let fixture = Fixture::new(); let path = fixture.file("large.json", &[]);
        File::options().write(true).open(&path).unwrap().set_len(50 * 1024 * 1024 + 1).unwrap();
        assert!(read_dropped_file(&[path]).err().unwrap().contains("50 MiB"));
    }
    #[test]
    fn read_errors_do_not_expose_filesystem_paths() {
        let error = read_dropped_file(&[PathBuf::from("/private/synthetic-secret/vault.json")]).err().unwrap();
        assert!(error.contains("读取")); assert!(!error.contains("synthetic-secret"));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links_as_nonregular_drops() {
        let fixture = Fixture::new(); let target = fixture.file("vault.json", b"{}");
        let link = fixture.0.join("shortcut"); std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(read_dropped_file(&[link]).err().unwrap().contains("普通文件"));
    }
    #[test]
    fn only_main_can_offer_or_claim_a_real_drop() {
        let state = DroppedFileState::default(); let paths = [PathBuf::from("from-os.json")];
        assert!(state.offer("quick", &paths).is_none());
        assert!(state.claim("main", "arbitrary-path", true).is_err());
        let id = state.offer("main", &paths).unwrap();
        assert!(state.claim("quick", &id, true).is_err());
        assert_eq!(state.claim("main", &id, true).unwrap().unwrap(), paths);
        assert!(state.claim("main", &id, true).is_err());
    }
    #[test]
    fn rejecting_a_drop_removes_its_one_use_ticket_without_opening_a_file() {
        let state = DroppedFileState::default(); let id = state.offer("main", &[PathBuf::from("does-not-exist")]).unwrap();
        assert!(state.claim("main", &id, false).unwrap().is_none());
        assert!(state.pending.lock().unwrap().is_none());
        assert!(state.claim("main", &id, true).is_err());
    }
    #[test]
    fn keeps_only_latest_drop_and_stale_claim_cannot_consume_it() {
        let state = DroppedFileState::default();
        let old = state.offer("main", &[PathBuf::from("old")]).unwrap();
        let new = state.offer("main", &[PathBuf::from("new")]).unwrap();
        assert_ne!(old, new); assert!(state.claim("main", &old, false).is_err());
        assert_eq!(state.claim("main", &new, true).unwrap().unwrap(), [PathBuf::from("new")]);
    }
    #[test]
    fn expired_tickets_cannot_read_files() {
        let state = DroppedFileState::default();
        let id = state.offer("main", &[PathBuf::from("old")]).unwrap();
        state.pending.lock().unwrap().as_mut().unwrap().created = Instant::now() - Duration::from_secs(31);
        assert!(state.claim("main", &id, true).err().unwrap().contains("过期"));
        assert!(state.pending.lock().unwrap().is_none());
    }
}
