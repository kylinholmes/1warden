//! Native WebSockets retain HTTP's system roots and explicit certificate pins.
//! Events are private IPC channels, and errors never include authenticated URLs.
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_tls_with_config, Connector, tungstenite::{Message, protocol::WebSocketConfig}};
use crate::http::HttpState;

#[derive(Default, Clone)]
pub struct WebSocketState(Arc<Mutex<HashMap<String, mpsc::Sender<Message>>>>);

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
pub enum SocketEvent { Open, Text(String), Binary(Vec<u8>), Close, Error }

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "推送地址无效")?;
    if !matches!(parsed.scheme(), "ws" | "wss") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("推送地址无效".into());
    }
    Ok(())
}

fn owner(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("此窗口不能建立推送连接".into()); }
    Ok(())
}

#[tauri::command]
pub fn websocket_open(window: tauri::WebviewWindow, state: tauri::State<'_, WebSocketState>,
    http: tauri::State<'_, HttpState>, id: String, url: String, events: Channel<SocketEvent>) -> Result<(), String> {
    owner(&window)?;
    open_socket(&state, &http, id, url, events)
}

fn open_socket(state: &WebSocketState, http: &HttpState, id: String, url: String, events: Channel<SocketEvent>) -> Result<(), String> {
    validate_url(&url)?;
    let (tx, mut rx) = mpsc::channel::<Message>(32);
    {
        let mut sockets = state.0.lock().map_err(|_| "推送状态不可用")?;
        if sockets.contains_key(&id) || sockets.len() >= 32 { return Err("推送连接数量超出限制".into()); }
        sockets.insert(id.clone(), tx);
    }
    let sockets = state.0.clone();
    let tls = http.tls.clone();
    tauri::async_runtime::spawn(async move {
        let config = WebSocketConfig::default().max_message_size(Some(1024 * 1024)).max_frame_size(Some(1024 * 1024));
        let connection = tokio::select! {
            // Close also cancels a DNS/TLS/handshake still in progress.
            _ = rx.recv() => None,
            result = tokio::time::timeout(Duration::from_secs(15),
                connect_async_tls_with_config(&url, Some(config), false, Some(Connector::Rustls(tls)))) => Some(result),
        };
        let mut clean = true;
        if let Some(Ok(Ok((mut stream, _)))) = connection {
            if events.send(SocketEvent::Open).is_ok() {
                loop {
                    tokio::select! {
                        outgoing = rx.recv() => {
                            match outgoing {
                                Some(Message::Close(_)) | None => { let _ = stream.close(None).await; break; }
                                Some(message) => { if stream.send(message).await.is_err() { clean = false; break; } }
                            }
                        }
                        incoming = stream.next() => {
                            let event = match incoming {
                                Some(Ok(Message::Text(text))) => SocketEvent::Text(text.to_string()),
                                Some(Ok(Message::Binary(bytes))) => SocketEvent::Binary(bytes.to_vec()),
                                // tungstenite queues a Pong; flush it even with no application writes.
                                Some(Ok(Message::Ping(_))) => { if stream.flush().await.is_err() { clean = false; break; } continue; }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Ok(_)) => continue,
                                Some(Err(_)) => { clean = false; break; }
                            };
                            if events.send(event).is_err() { break; }
                        }
                    }
                }
            }
        } else if connection.is_some() { clean = false; }
        if let Ok(mut sockets) = sockets.lock() { sockets.remove(&id); }
        let _ = events.send(if clean { SocketEvent::Close } else { SocketEvent::Error });
    });
    Ok(())
}

#[tauri::command]
pub async fn websocket_send(window: tauri::WebviewWindow, state: tauri::State<'_, WebSocketState>,
    id: String, text: Option<String>, bytes: Option<Vec<u8>>) -> Result<(), String> {
    owner(&window)?;
    let message = match (text, bytes) {
        (Some(text), None) if text.len() <= 1024 * 1024 => Message::Text(text.into()),
        (None, Some(bytes)) if bytes.len() <= 1024 * 1024 => Message::Binary(bytes.into()),
        _ => return Err("推送消息无效".into()),
    };
    let tx = state.0.lock().map_err(|_| "推送状态不可用")?.get(&id).cloned().ok_or("推送连接已关闭")?;
    tx.send(message).await.map_err(|_| "推送连接已关闭".into())
}

#[tauri::command]
pub async fn websocket_close(window: tauri::WebviewWindow, state: tauri::State<'_, WebSocketState>, id: String) -> Result<(), String> {
    owner(&window)?;
    let tx = state.0.lock().map_err(|_| "推送状态不可用")?.get(&id).cloned();
    if let Some(tx) = tx { let _ = tx.send(Message::Close(None)).await; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_socket_urls_without_echoing_credentials() {
        assert!(validate_url("wss://vault.test/base/notifications/hub?access_token=secret").is_ok());
        assert!(validate_url("ws://localhost:8080/notifications/hub").is_ok());
        for url in ["https://vault.test", "wss://user:secret@vault.test/hub", "wss://vault.test/hub#secret"] {
            let error = validate_url(url).unwrap_err();
            assert!(!error.contains("secret"));
        }
    }

    #[tokio::test]
    async fn native_transport_delivers_frames_and_answers_server_ping() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/notifications/hub", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.send(Message::Text("{}\u{1e}".into())).await.unwrap();
            ws.send(Message::Binary(vec![2, 145, 6].into())).await.unwrap();
            ws.send(Message::Ping(vec![1, 2, 3].into())).await.unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap(), Message::Pong(vec![1, 2, 3].into()));
            ws.close(None).await.unwrap();
        });
        let state = WebSocketState::default();
        let http = HttpState::new(std::env::temp_dir().join(format!("onewarden-socket-test-{}.json", std::process::id()))).unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body { let _ = events.send(serde_json::from_str::<serde_json::Value>(&json).unwrap()); }
            Ok(())
        });
        open_socket(&state, &http, "test".into(), url, channel).unwrap();
        let mut frames = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
            if event["type"] == "close" { break; }
            frames.push(event);
        }
        assert_eq!(frames, vec![serde_json::json!({"type":"open"}),
            serde_json::json!({"type":"text", "data":"{}\u{1e}"}),
            serde_json::json!({"type":"binary", "data":[2,145,6]})]);
        assert!(state.0.lock().unwrap().is_empty());
        peer.await.unwrap();
    }
}
