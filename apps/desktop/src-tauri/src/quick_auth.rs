//! Credentials cross a one-shot, caller-checked mailbox. Events contain IDs only.
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroize;

const MAILBOX_LIFETIME: Duration = Duration::from_secs(30);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthKey { generation: u64, request_id: u64 }

#[derive(Clone, Copy, serde::Serialize)]
pub struct AuthCancellation { #[serde(flatten)] key: AuthKey, unlocked: bool, expired: bool }

#[derive(PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action { Select, Password, TwoFactor }

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthRequest {
    generation: u64, request_id: u64, account_id: String, action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remember: Option<bool>,
}
impl AuthRequest {
    fn key(&self) -> AuthKey { AuthKey { generation: self.generation, request_id: self.request_id } }
    fn validate(&self) -> Result<(), String> {
        if self.generation > MAX_SAFE_INTEGER || self.request_id == 0 || self.request_id > MAX_SAFE_INTEGER
            || self.account_id.is_empty() || self.account_id.len() > 4096 { return Err("认证请求无效".into()); }
        let valid = match self.action {
            Action::Select => self.password.is_none() && self.code.is_none() && self.provider.is_none() && self.remember.is_none(),
            Action::Password => self.password.as_ref().is_some_and(|value| !value.is_empty() && value.len() <= 16_384)
                && self.code.is_none() && self.provider.is_none() && self.remember.is_none(),
            Action::TwoFactor => self.password.is_none() && self.code.as_ref().is_some_and(|value| !value.is_empty() && value.len() <= 1024)
                && self.provider.is_some(),
        };
        if valid { Ok(()) } else { Err("认证请求无效".into()) }
    }
}
impl Drop for AuthRequest {
    fn drop(&mut self) {
        if let Some(password) = &mut self.password { password.zeroize(); }
        if let Some(code) = &mut self.code { code.zeroize(); }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage { Password, TwoFactor, Unlocked }
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthResult {
    generation: u64, request_id: u64, account_id: String, stage: Stage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    providers: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct Mailbox {
    last: Option<AuthKey>,
    current: Option<(AuthKey, String, bool)>,
    request: Option<(AuthRequest, Instant)>,
}
impl Mailbox {
    fn insert(&mut self, request: AuthRequest) -> Result<AuthKey, String> {
        request.validate()?;
        let key = request.key();
        if self.last.is_some_and(|last| key.generation < last.generation
            || (key.generation == last.generation && key.request_id <= last.request_id)) {
            return Err("认证请求已过期".into());
        }
        self.last = Some(key);
        self.current = Some((key, request.account_id.clone(), false));
        self.request = Some((request, Instant::now()));
        Ok(key)
    }
    fn is_current(&self, key: AuthKey) -> bool { self.current.as_ref().is_some_and(|(current, _, _)| *current == key) }
    fn take(&mut self, key: AuthKey) -> Option<AuthRequest> {
        if !self.is_current(key) { return None; }
        // The expiry timer owns cancellation notification, even if main tries
        // to consume the request just after its deadline.
        if self.request.as_ref()?.1.elapsed() >= MAILBOX_LIFETIME { return None; }
        let (request, _) = self.request.take()?;
        Some(request)
    }
    fn cancel(&mut self) -> Option<AuthCancellation> {
        self.request = None;
        self.current.take().map(|(key, _, unlocked)| AuthCancellation { key, unlocked, expired: false })
    }
    fn expire(&mut self, key: AuthKey) -> Option<AuthCancellation> {
        if self.is_current(key) && self.request.as_ref().is_some_and(|(_, created)| created.elapsed() >= MAILBOX_LIFETIME) {
            self.cancel().map(|mut cancellation| { cancellation.expired = true; cancellation })
        } else { None }
    }
}
#[derive(Default)]
pub struct QuickAuthState { mailbox: Mutex<Mailbox> }

fn require_caller(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected { Ok(()) } else { Err("此窗口无权执行认证操作".into()) }
}
fn window_current(app: &AppHandle, generation: u64) -> bool { crate::quick::is_current(app, generation) }
fn notify_cancel(app: &AppHandle, key: AuthCancellation) {
    let _ = app.emit_to("main", "1warden:quick-auth-cancelled", key);
    let _ = app.emit_to("quick", "1warden:quick-auth-cancelled", key);
}
pub fn cancel_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<QuickAuthState>() {
        let key = state.mailbox.lock().ok().and_then(|mut mailbox| mailbox.cancel());
        if let Some(key) = key { notify_cancel(app, key); }
    }
}

#[tauri::command]
pub fn quick_auth_request(app: AppHandle, window: tauri::WebviewWindow, request: AuthRequest) -> Result<(), String> {
    require_caller(window.label(), "quick")?;
    let state = app.state::<QuickAuthState>();
    let key = {
        let mut mailbox = state.mailbox.lock().map_err(|_| "认证状态不可用")?;
        if !window_current(&app, request.generation) { return Err("快速搜索已关闭或重新打开".into()); }
        mailbox.insert(request)?
    };
    if let Err(error) = app.emit_to("main", "1warden:quick-auth-request", key) {
        cancel_all(&app); return Err(error.to_string());
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MAILBOX_LIFETIME).await;
        let key = app.state::<QuickAuthState>().mailbox.lock().ok().and_then(|mut mailbox| mailbox.expire(key));
        if let Some(key) = key { notify_cancel(&app, key); }
    });
    Ok(())
}
#[tauri::command]
pub fn quick_auth_take(app: AppHandle, window: tauri::WebviewWindow, key: AuthKey) -> Result<Option<AuthRequest>, String> {
    require_caller(window.label(), "main")?;
    let state = app.state::<QuickAuthState>();
    let mut mailbox = state.mailbox.lock().map_err(|_| "认证状态不可用")?;
    if !window_current(&app, key.generation) { return Ok(None); }
    Ok(mailbox.take(key))
}
#[tauri::command]
pub fn quick_auth_is_current(app: AppHandle, window: tauri::WebviewWindow, key: AuthKey) -> Result<bool, String> {
    require_caller(window.label(), "main")?;
    let state = app.state::<QuickAuthState>();
    let mailbox = state.mailbox.lock().map_err(|_| "认证状态不可用")?;
    Ok(window_current(&app, key.generation) && mailbox.is_current(key))
}
#[tauri::command]
pub fn quick_auth_cancel(app: AppHandle, window: tauri::WebviewWindow, generation: u64) -> Result<(), String> {
    require_caller(window.label(), "quick")?;
    let state = app.state::<QuickAuthState>();
    let key = {
        let mut mailbox = state.mailbox.lock().map_err(|_| "认证状态不可用")?;
        if mailbox.current.as_ref().is_some_and(|(key, _, _)| key.generation == generation) { mailbox.cancel() } else { None }
    };
    if let Some(key) = key { notify_cancel(&app, key); }
    Ok(())
}
#[tauri::command]
pub fn quick_auth_complete(app: AppHandle, window: tauri::WebviewWindow, result: AuthResult) -> Result<bool, String> {
    require_caller(window.label(), "main")?;
    let state = app.state::<QuickAuthState>();
    // Keep cancellation and result publication ordered under the same lock.
    let mut mailbox = state.mailbox.lock().map_err(|_| "认证状态不可用")?;
    let key = AuthKey { generation: result.generation, request_id: result.request_id };
    if window_current(&app, key.generation) && mailbox.current.as_ref().is_some_and(|(current, account, _)| *current == key && *account == result.account_id) {
        let unlocked = matches!(&result.stage, Stage::Unlocked) && result.error.is_none();
        app.emit_to("quick", "1warden:quick-auth-result", result).map_err(|error| error.to_string())?;
        if let Some((_, _, accepted)) = &mut mailbox.current { *accepted |= unlocked; }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(generation: u64, request_id: u64) -> AuthRequest {
        AuthRequest { generation, request_id, account_id: "account-A".into(), action: Action::Password,
            password: Some("test-password".into()), code: None, provider: None, remember: None }
    }
    #[test] fn only_intended_windows_can_submit_and_consume() {
        assert!(require_caller("quick", "quick").is_ok()); assert!(require_caller("main", "main").is_ok());
        for label in ["quick", "", "extension"] { assert!(require_caller(label, "main").is_err()); }
        assert!(require_caller("main", "quick").is_err());
    }
    #[test] fn credentials_are_taken_once_and_events_only_contain_ids() {
        let mut mailbox = Mailbox::default(); let key = mailbox.insert(request(1, 1)).unwrap();
        assert_eq!(serde_json::to_string(&key).unwrap(), "{\"generation\":1,\"requestId\":1}");
        assert!(mailbox.take(AuthKey { generation: 2, request_id: 1 }).is_none());
        assert_eq!(mailbox.take(key).unwrap().password.as_deref(), Some("test-password"));
        assert!(mailbox.take(key).is_none()); assert!(mailbox.is_current(key));
    }
    #[test] fn cancel_clears_credentials_and_old_keys_cannot_be_reused() {
        let mut mailbox = Mailbox::default(); let old = mailbox.insert(request(1, 1)).unwrap();
        assert!(mailbox.cancel().is_some()); assert!(mailbox.request.is_none()); assert!(!mailbox.is_current(old));
        assert!(mailbox.insert(request(1, 1)).is_err());
        let new = mailbox.insert(request(2, 1)).unwrap(); assert!(!mailbox.is_current(old)); assert!(mailbox.is_current(new));
        assert!(mailbox.insert(request(1, 10)).is_err());
    }
    #[test] fn unconsumed_credentials_expire_without_expiring_a_consumed_challenge() {
        let mut mailbox = Mailbox::default(); let key = mailbox.insert(request(1, 1)).unwrap();
        mailbox.request.as_mut().unwrap().1 = Instant::now() - MAILBOX_LIFETIME;
        assert!(mailbox.expire(key).is_some()); assert!(mailbox.request.is_none()); assert!(!mailbox.is_current(key));
        let key = mailbox.insert(request(1, 2)).unwrap(); mailbox.take(key);
        assert!(mailbox.expire(key).is_none()); assert!(mailbox.is_current(key));
    }
    #[test] fn payload_validation_rejects_mixed_credentials() {
        let mut value = request(1, 1); assert!(value.validate().is_ok());
        value.code = Some("123456".into()); assert!(value.validate().is_err());
        value.action = Action::Select; assert!(value.validate().is_err());
        value.password = None; value.code = None; assert!(value.validate().is_ok());
    }
}
