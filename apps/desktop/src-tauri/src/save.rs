//! 把字节保存到用户选的位置。
//!
//! ## 为什么必须有对话框，不能默默写进下载目录
//!
//! 附件是**用户自己的文件**，而且解出来是明文 —— 导出的是身份证扫描件、
//! 钥匙照片、合同之类。落到一个可预测的位置（`~/Downloads/xxx`）而不问一声，
//! 意味着任何能读那个目录的进程都能拿到它，而用户根本不知道文件被写到哪了。
//!
//! ## 为什么自己引 rfd 而不是用 Tauri 的 dialog 插件
//!
//! 插件要额外的权限声明与打包配置，而我们只需要「问用户存哪」这一件事。
//! 这跟托盘、全局热键的处理是一致的 —— 那几个也是自己写的。
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;

/// 保存结果。`None` 表示用户取消了 —— 那**不是错误**，UI 不该报错。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    /// 用户取消时为 null
    pub path: Option<String>,
}

#[tauri::command]
pub async fn save_file(default_name: String, bytes_base64: String) -> Result<SaveOutcome, String> {
    let bytes = B64
        .decode(bytes_base64.as_bytes())
        .map_err(|e| format!("内容不是合法的 base64：{e}"))?;

    // ⚠️ 对话必须跑在**主线程**上 —— macOS 的原生面板不是线程安全的。
    // `rfd` 的异步版内部会切回主线程，所以这里 await 它而不是用阻塞版。
    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await;

    let Some(handle) = picked else {
        // 用户取消 —— 正常路径，不是错误
        return Ok(SaveOutcome { path: None });
    };

    let path = handle.path().to_path_buf();
    std::fs::write(&path, bytes).map_err(|e| format!("写文件失败：{e}"))?;

    Ok(SaveOutcome { path: Some(path.to_string_lossy().into_owned()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ 这条守的是「内容中途被改」。界面把解密后的字节转成 base64 再送过来，
    /// 编码错一位写出去的文件就是坏的，而**保存会成功** ——
    /// 用户要等打开文件才发现。
    #[test]
    fn decodes_bytes_without_altering_them() {
        // 含 0x00 / 0x89 / 0xFF —— 不是合法 UTF-8，正是会被文本路径改掉的那几个
        let original: Vec<u8> = vec![0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00];
        let encoded = B64.encode(&original);
        assert_eq!(B64.decode(encoded.as_bytes()).unwrap(), original);
        assert!(std::str::from_utf8(&original).is_err(), "这组字节本来就该不是合法 UTF-8");
    }

    #[test]
    fn rejects_invalid_base64_instead_of_writing_a_truncated_file() {
        assert!(B64.decode(b"not base64!!").is_err());
    }
}
