//! Launch only web URLs in the system browser, without a shell or WebView navigation.

fn website_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "网址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("只能打开不含登录凭据的 HTTP 或 HTTPS 网址".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub async fn open_website(url: String) -> Result<(), String> {
    let url = website_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = std::process::Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        let status = command.arg(url).status().map_err(|e| format!("无法打开浏览器：{e}"))?;
        if status.success() { Ok(()) } else { Err("无法打开浏览器".to_string()) }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::website_url;

    #[test]
    fn accepts_websites_and_rejects_commands_or_credentials() {
        assert_eq!(website_url("https://example.com").unwrap(), "https://example.com/");
        assert!(website_url("http://127.0.0.1:8080/security").is_ok());
        for invalid in ["--args", "file:///tmp/item", "javascript:alert(1)",
            "https://user:secret@example.com", "data:text/plain,x"] {
            assert!(website_url(invalid).is_err(), "{invalid}");
        }
    }
}
