//! 原生窗口自动输入 —— 桌面端的差异化功能（spec §7.4）。
//!
//! ## 为什么先做「自动输入」而不是「读字段再填」
//!
//! 调研结论（见 `docs/reference/native-autofill.md`）指出：原生控件**没有**
//! HTML 里 `autocomplete="username"` 的等价物，区分用户名框和密码框只能靠
//! 猜。那是最贵、最不可靠、隐私叙事也最难讲的一块。
//!
//! 而「合成按键把凭据敲进当前焦点」不需要读任何东西 —— 只要目标应用接受
//! 键盘输入就行。KeePassXC 和 Bitwarden(Windows) 用的都是这个模型。
//! 它拿到大部分用户可感价值，代价却小得多，而且**完全不读别人的窗口内容**。
//!
//! ## 两条硬不变量（spec §7.4）
//!
//! **I1**：绝不主动读取任何应用的界面内容。这里只往当前焦点**写**。
//! 这一条就是这个功能与键盘记录器的分界线，也是对用户最好解释的一条。
//!
//! **I2**：合成按键**没有**「写回读验证」的可能 —— 我们看不到目标控件。
//! 所以必须如实告知用户「已发送按键」而不是「已填充」。措辞上不能含糊：
//! 一个声称填充成功但实际没填的密码管理器，比一个响亮失败的更糟。

use std::sync::atomic::{AtomicBool, Ordering};

/// `CGEventKeyboardSetUnicodeString` 在 **20 个 UTF-16 码元**处截断。
///
/// ⚠️ 是**码元**不是字符：一个 emoji 占 2 个，一个 CJK 汉字占 1 个。
/// 按「字符个数」分块会在含 emoji 的密码上切错位置，结果是**密码被静默截短** ——
/// 用户看到的是「登录失败」，永远查不到原因。
const MAX_UTF16_UNITS: usize = 20;

/// 把文本切成可以安全交给 CGEvent 的块。
///
/// 保证：不切开代理对（surrogate pair）、每块 ≤ 20 个 UTF-16 码元、
/// 拼起来与原文完全一致。这三条在下面都有测试。
pub fn chunk_for_keystrokes(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut units = 0usize;

    for ch in text.chars() {
        let w = ch.len_utf16();
        // 单个字符就超过上限（不可能，但别让循环卡住），或者放不下就收尾
        if units + w > MAX_UTF16_UNITS && !current.is_empty() {
            out.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(ch);
        units += w;
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// 一次自动输入的按键动作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeAction {
    Text(String),
    Tab,
    Return,
}

/// 组装完整动作序列。
///
/// 顺序是 `用户名 → Tab → 密码`：绝大多数登录表单就是这个顺序，
/// 而它同时是 KeePassXC 的默认序列。
///
/// ⚠️ **默认不自动提交。** 原生窗口没有 HTML 表单语义可供校验，
/// 按下去就是真的提交了 —— 在浏览器里这个默认值可以激进，在这里不行。
pub fn autotype_sequence(username: Option<&str>, password: &str, submit: bool) -> Vec<TypeAction> {
    let mut actions = Vec::new();

    // 用户名为空时**不能**只发 Tab —— 那会把焦点从用户名框推进密码框，
    // 然后密码被敲进用户名框。宁可不发 Tab，让用户在正确的位置手动开始。
    if let Some(u) = username {
        if !u.is_empty() {
            actions.extend(chunk_for_keystrokes(u).into_iter().map(TypeAction::Text));
            actions.push(TypeAction::Tab);
        }
    }

    actions.extend(chunk_for_keystrokes(password).into_iter().map(TypeAction::Text));
    if submit {
        actions.push(TypeAction::Return);
    }
    actions
}

// ── 权限 ──

/// 辅助功能授权的当前状态。
///
/// ⚠️ 合成按键（`CGEventPost`）需要它。更要紧的是 macOS 26 上**弹窗引导
/// 可能已经不可靠**（`tccd` 里有 `does not allow prompting` 的字样），
/// 所以界面要能说清楚「去哪儿手动开」，而不是只弹一个我们控制不了的系统框。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionState {
    Granted,
    /// 没授权。界面需要给出深链，让用户自己去系统设置里开。
    Denied,
}

/// 检查辅助功能授权。
///
/// 用 `AXIsProcessTrusted()` 而**不是** `AXIsProcessTrustedWithOptions(prompt=true)`：
/// 后者会弹系统框，而 macOS 26 上那个框可能根本不出现 —— 于是用户点了按钮
/// 什么都没发生，也不知道该去哪儿。
#[cfg(target_os = "macos")]
pub fn accessibility_permission() -> PermissionState {
    // SAFETY: AXIsProcessTrusted 无参数、无副作用、线程安全
    if unsafe { accessibility_sys::AXIsProcessTrusted() } {
        PermissionState::Granted
    } else {
        PermissionState::Denied
    }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_permission() -> PermissionState {
    PermissionState::Denied
}

/// 打开「系统设置 → 隐私与安全性 → 辅助功能」。
///
/// 不依赖任何 Tauri 插件 —— 直接让系统用 URL scheme 打开。
#[cfg(target_os = "macos")]
pub fn open_accessibility_settings() -> Result<(), String> {
    const URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    std::process::Command::new("open")
        .arg(URL)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开系统设置：{e}"))
}

#[cfg(not(target_os = "macos"))]
pub fn open_accessibility_settings() -> Result<(), String> {
    Err("这个平台还不支持".into())
}

/// 自动输入的开关状态 —— 由前端控制，因为「用户是否想要这个功能」
/// 是产品决定，不该埋在壳里。
static AUTOTYPE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_autotype_enabled(on: bool) {
    AUTOTYPE_ENABLED.store(on, Ordering::Relaxed);
}

pub fn autotype_enabled() -> bool {
    AUTOTYPE_ENABLED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_short_text_whole() {
        assert_eq!(chunk_for_keystrokes("abc"), vec!["abc"]);
    }

    #[test]
    fn chunks_empty_text_into_nothing() {
        assert!(chunk_for_keystrokes("").is_empty());
    }

    /// ⚠️ 核心：按 **UTF-16 码元**分块，不是按字符数。
    /// 20 个 ASCII 刚好一块，21 个就必须切。
    #[test]
    fn splits_at_twenty_utf16_units() {
        let twenty = "a".repeat(20);
        assert_eq!(chunk_for_keystrokes(&twenty).len(), 1);

        let twenty_one = "a".repeat(21);
        let chunks = chunk_for_keystrokes(&twenty_one);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 20);
        assert_eq!(chunks[1].len(), 1);
    }

    /// 中文一个字占 1 个码元 —— 20 个字一块
    #[test]
    fn counts_cjk_as_one_unit() {
        let s = "密".repeat(40);
        let chunks = chunk_for_keystrokes(&s);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), 20);
    }

    /// ⚠️ emoji 占 2 个码元。19 个 ASCII + 1 个 emoji = 21 码元，必须切成两块 ——
    /// 若按「字符数」算会以为只有 20 个，于是整串交给 CGEvent，
    /// 第 21 个码元被悄悄丢掉。
    #[test]
    fn counts_emoji_as_two_units() {
        let s = format!("{}🔐", "a".repeat(19));
        assert_eq!(s.chars().count(), 20);        // 按字符数是 20
        assert_eq!(s.encode_utf16().count(), 21); // 按码元是 21

        let chunks = chunk_for_keystrokes(&s);
        assert_eq!(chunks.len(), 2, "21 个码元必须切成两块");
    }

    /// 绝不能把代理对切开 —— 切开的半个 emoji 是无效 UTF-16
    #[test]
    fn never_splits_a_surrogate_pair() {
        // 每个 emoji 2 个码元，20 个码元刚好放 10 个
        let s = "🔐".repeat(11);
        let chunks = chunk_for_keystrokes(&s);
        assert_eq!(chunks.len(), 2);
        for c in &chunks {
            // 能还原成合法的 char 序列，说明没有半个代理对
            assert!(c.chars().count() > 0);
            assert_eq!(c.encode_utf16().count() % 2, 0, "块内码元数应为偶数：{c}");
        }
    }

    #[test]
    fn chunks_join_back_to_the_original() {
        for s in [
            String::from("short"),
            "a".repeat(100),
            "混合 mixed 文本 🔐🔑 with emoji and 中文".repeat(3),
            "🔐".repeat(50),
        ] {
            let joined: String = chunk_for_keystrokes(&s).concat();
            assert_eq!(joined, s, "分块后拼回来必须与原文逐字一致");
        }
    }

    #[test]
    fn every_chunk_fits_the_limit() {
        for s in [
            "a".repeat(137),
            "🔐中文混合".repeat(23),
            String::from("x").repeat(20),
        ] {
            for c in chunk_for_keystrokes(&s) {
                assert!(c.encode_utf16().count() <= MAX_UTF16_UNITS, "块超限：{c}");
            }
        }
    }

    // ── 动作序列 ──

    #[test]
    fn types_username_then_tab_then_password() {
        assert_eq!(
            autotype_sequence(Some("me@example.com"), "pw123", false),
            vec![
                TypeAction::Text("me@example.com".into()),
                TypeAction::Tab,
                TypeAction::Text("pw123".into()),
            ],
        );
    }

    /// ⚠️ 没有用户名时**不能**只发 Tab —— 那会把焦点推进密码框，
    /// 然后密码被敲进用户名框里
    #[test]
    fn omits_the_tab_when_there_is_no_username() {
        assert_eq!(
            autotype_sequence(None, "pw123", false),
            vec![TypeAction::Text("pw123".into())],
        );
        assert_eq!(
            autotype_sequence(Some(""), "pw123", false),
            vec![TypeAction::Text("pw123".into())],
        );
    }

    #[test]
    fn appends_return_only_when_submitting() {
        assert_eq!(autotype_sequence(None, "pw", true).last(), Some(&TypeAction::Return));
        assert_ne!(autotype_sequence(None, "pw", false).last(), Some(&TypeAction::Return));
    }

    #[test]
    fn long_passwords_are_chunked_inside_the_sequence() {
        let pw = "p".repeat(45);
        let actions = autotype_sequence(Some("u"), &pw, false);
        // 用户名 + Tab + 3 块密码
        assert_eq!(actions.len(), 5);
        let typed: String = actions.iter().filter_map(|a| match a {
            TypeAction::Text(t) => Some(t.as_str()),
            _ => None,
        }).collect();
        assert_eq!(typed, format!("u{pw}"));
    }

    #[test]
    fn an_empty_password_still_produces_no_text_action() {
        assert_eq!(autotype_sequence(None, "", false), vec![]);
    }
}

// ── 按键合成 ──

/// macOS 虚拟键码（`Events.h`）。只用得到这两个。
#[cfg(target_os = "macos")]
mod keycode {
    pub const TAB: u16 = 48;
    pub const RETURN: u16 = 36;
}

/// 把一串动作真的敲进**当前焦点所在的**应用。
///
/// ⚠️ 这里**不读**目标应用的任何内容（不变量 I1）。写进去之后也没法读回来
/// 验证（不变量 I2）—— 所以我们只能报告「按键已发送」，**不能**报告「已填充」。
#[cfg(target_os = "macos")]
pub fn perform(actions: &[TypeAction]) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    if !autotype_enabled() {
        return Err("自动输入已关闭".into());
    }

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建事件源".to_string())?;

    for action in actions {
        match action {
            TypeAction::Text(text) => {
                // 分块在上游做过 —— 每一块都不超过 20 个 UTF-16 码元
                let units: Vec<u16> = text.encode_utf16().collect();
                if units.is_empty() {
                    continue;
                }
                // keycode 0 只是载体：真正的字符由 unicode 字符串决定
                for down in [true, false] {
                    let ev = CGEvent::new_keyboard_event(source.clone(), 0, down)
                        .map_err(|_| "无法创建按键事件".to_string())?;
                    ev.set_string_from_utf16_unchecked(&units);
                    ev.post(CGEventTapLocation::HID);
                }
            }
            TypeAction::Tab => press(source.clone(), keycode::TAB)?,
            TypeAction::Return => press(source.clone(), keycode::RETURN)?,
        }
        // 相邻两次合成之间留一点间隔。太快的话，目标应用的事件循环
        // 可能把后一个事件合并或丢弃 —— 那是「密码少了一位」的另一个来源。
        std::thread::sleep(std::time::Duration::from_millis(12));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn press(
    source: core_graphics::event_source::CGEventSource,
    code: u16,
) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventTapLocation};
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(source.clone(), code, down)
            .map_err(|_| "无法创建按键事件".to_string())?;
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn perform(_actions: &[TypeAction]) -> Result<(), String> {
    Err("这个平台还不支持原生自动输入".into())
}

// ── Tauri 命令 ──

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutotypeStatus {
    pub permission: PermissionState,
    pub enabled: bool,
    /// 全局快捷键的可读写法（如 `⇧⌘\`）。界面要把它显示出来 ——
    /// 用户不知道有快捷键，这个功能就等于不存在。
    pub shortcut: String,
}

#[tauri::command]
pub fn autotype_status() -> AutotypeStatus {
    AutotypeStatus {
        permission: accessibility_permission(),
        enabled: autotype_enabled(),
        #[cfg(target_os = "macos")]
        shortcut: crate::hotkey::describe(
            crate::hotkey::MOD_CMD | crate::hotkey::MOD_SHIFT,
            crate::hotkey::DEFAULT_KEYCODE,
        ),
        #[cfg(not(target_os = "macos"))]
        shortcut: String::new(),
    }
}

#[tauri::command]
pub fn autotype_set_enabled(on: bool) {
    set_autotype_enabled(on);
}

/// 打开系统设置的辅助功能页。
///
/// 为什么不让系统自己弹框：macOS 26 上那个框**可能根本不出现**
/// （`tccd` 里有 `does not allow prompting` 的字样）。用户点了按钮却什么都
/// 没发生，比明确告诉他「去哪儿手动开」糟糕得多。
#[tauri::command]
pub fn autotype_open_settings() -> Result<(), String> {
    open_accessibility_settings()
}

/// 把凭据敲进**当前焦点所在的**应用。
///
/// ⚠️ 必须是 `async`。Tauri 的文档写得很清楚：「不带 `async` 的 command
/// 在主线程上执行」。而这里每一步之间都要 sleep（太快目标应用会丢事件），
/// 同步执行就是**阻塞 UI 线程**。
///
/// ⚠️ 返回值只表示「按键已发送」，**不表示「已填充」** —— 我们看不到目标控件，
/// 无从验证（不变量 I2）。界面上的措辞必须与此一致。
#[tauri::command]
pub async fn autotype_type(
    username: Option<String>,
    password: String,
    submit: bool,
) -> Result<(), String> {
    if accessibility_permission() == PermissionState::Denied {
        return Err("还没有获得辅助功能授权，无法向其他应用发送按键".into());
    }
    if password.is_empty() {
        return Err("这条记录没有密码".into());
    }

    let actions = autotype_sequence(username.as_deref(), &password, submit);
    tauri::async_runtime::spawn_blocking(move || perform(&actions))
        .await
        .map_err(|e| format!("自动输入失败：{e}"))?
}
