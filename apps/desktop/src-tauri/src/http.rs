//! 原生 HTTP 传输层 + 服务器证书信任（TOFU）。
//!
//! ## 为什么网络请求必须在 Rust 侧，而不是 WebView 里的 `fetch`
//!
//! WebView 的页面 origin 是 `tauri://localhost`。向 Vaultwarden 发请求就是跨源，
//! 浏览器安全模型要求响应必须带 `Access-Control-Allow-Origin`，而 Vaultwarden
//! 只会对**配置的 DOMAIN** 回显这个头：
//!
//! ```text
//! Origin: https://vault.example.com  → Access-Control-Allow-Origin: https://vault.example.com
//! Origin: tauri://localhost          → （无此头）→ WebView 拦掉整个响应
//! ```
//!
//! 这不是配置问题，改不了 —— 所以桌面端不可能用浏览器请求直连。搬到 Rust 侧之后
//! 顺带解决另外两件事：
//!
//! 1. **自签证书**：自建 Vaultwarden 大多没上公信证书，Rust 侧能自己决定信任谁。
//! 2. **令牌不入 WebView**：access token 不再经过页面内存，XSS 拿不到。
//!
//! ## 证书策略：TOFU（首次使用即信任）+ 指纹固定
//!
//! 绝不用「接受任意证书」那种开关 —— 那等于关掉 TLS 校验，中间人可以为所欲为。
//! 这里的做法是：
//!
//! - 证书能通过正常校验 → 放行（绝大多数情况，用户无感）。
//! - 校验失败 → **不放行**，把指纹和证书信息交回界面，让用户看着决定。
//! - 用户确认后，把该主机的指纹固定下来；之后只有**完全相同的证书**才放行。
//!
//! 也就是说，中间人即使能伪造证书，也过不了指纹这一关。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// ── 对外类型 ──

#[derive(Debug, Default, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RedirectMode {
    #[default]
    Follow,
    Error,
    Manual,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// 二进制体（base64）。与 `body` 二选一，同时给就以这个为准。
    ///
    /// Tauri 的 IPC 是 JSON，二进制只能编码过来。附件上传走的就是这条路。
    ///
    /// ⚠️ 另一条路（把二进制 `TextDecoder` 成字符串再发）**不能走** ——
    /// 那不是转错，是**静默改字节**：不合法的 UTF-8 序列会被替换成 U+FFFD，
    /// 传上去的文件损坏而上传会「成功」，用户要等下载回来才发现。
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub redirect: RedirectMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// 文本体。与 `body_base64` 二选一
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 二进制体（base64）。图标、以及**附件下载**走这条
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

impl HttpResponse {
    /// 按字节决定走哪条通道 —— 与请求侧 `body_base64` 对称。
    ///
    /// 规则：**合法的 UTF-8 一律当文本**。即便一份二进制恰好是合法 UTF-8，
    /// 走文本通道也是无损的（UTF-8 → String → UTF-8 不改字节），
    /// 所以这条规则不可能损坏数据 —— 它只在「当文本会损坏」时才改走 base64。
    pub fn from_body(status: u16, headers: HashMap<String, String>, bytes: Vec<u8>) -> Self {
        let (body, body_base64) = if bytes.is_empty() {
            // 两个都不给。发一个空的 base64 只会让前端白解一次
            (None, None)
        } else {
            match String::from_utf8(bytes) {
                Ok(text) => (Some(text), None),
                // 解不开时 `FromUtf8Error` 会把**原始字节**还给我们
                Err(e) => (None, Some(B64.encode(e.as_bytes()))),
            }
        };
        Self { status, headers, body, body_base64 }
    }
}

/// 错误分成几类，界面才能给出不同的话术 ——
/// 「证书不受信任」和「连不上」对用户来说是完全不同的两件事。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpError {
    /// network | timeout | certUntrusted | invalidRequest | tls
    pub kind: String,
    pub message: String,
    /// 仅 certUntrusted：被拒证书的 SHA-256 指纹（大写十六进制，冒号分隔）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

impl HttpError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), fingerprint: None }
    }
}

/// 证书详情 —— 交给用户做信任决定。指纹对普通用户没有意义，
/// 所以「是不是自签的」「谁签发的」「什么时候过期」都要给出来。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub is_self_signed: bool,
    /// 是否已固定过同一个指纹
    pub already_trusted: bool,
}

// ── 指纹固定的存储 ──

/// 主机（`host:port`）→ 指纹。
///
/// 用主机名做键而不是 IP：换 IP 不代表换了服务器，但换主机名意味着换了目标。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CertPins {
    hosts: HashMap<String, String>,
}

impl CertPins {
    fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self).unwrap_or_default())
    }

    pub fn get(&self, host: &str) -> Option<&String> {
        self.hosts.get(host)
    }

    pub fn set(&mut self, host: &str, fingerprint: &str) {
        self.hosts.insert(host.to_string(), fingerprint.to_string());
    }

    pub fn remove(&mut self, host: &str) {
        self.hosts.remove(host);
    }
}

/// 把 DER 证书算成 SHA-256 指纹，格式 `AB:CD:EF:...`。
///
/// 用大写冒号分隔是 OpenSSL / 系统钥匙串的通用写法 —— 用户拿它跟服务器上
/// `openssl x509 -fingerprint -sha256` 的输出对照时，格式一致才不会看岔。
pub fn fingerprint_of(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// 从 URL 里拆出 `(主机名, 端口)`，用于建立连接。
pub fn host_and_port_of(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;   // 去掉 user:pass@
    if host_port.is_empty() {
        return None;
    }
    let default_port = if url.starts_with("https://") { 443 } else { 80 };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (host_port, default_port),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_ascii_lowercase(), port))
}

/// 证书固定的键：**只有主机名，不含端口**，统一小写。
///
/// ⚠️ 这里**必须**和 `PinningVerifier` 用的键完全一致。TLS 的 SNI 只带主机名，
/// rustls 交给校验器的 `ServerName` 里没有端口 —— 早先用 `host:port` 做键，
/// 于是存进去是 `localhost:8443`、查的时候是 `localhost`，永远匹配不上，
/// 表现为「信任过了却依然连不上」。这个 bug 是集成测试抓到的。
///
/// 顺带一提，不含端口也是 TLS 本身的语义：证书标识的是**主机**，不是端口。
/// 代价是同一台主机上不同端口的两张证书会互相顶掉 —— 罕见，且会以
/// 「证书变了，请重新确认」的形式暴露出来，不会静默放行。
pub fn pin_key_of(url: &str) -> Option<String> {
    host_and_port_of(url).map(|(host, _)| host)
}

// ── 证书校验器：正常校验 + 指纹固定 ──

#[derive(Debug)]
pub struct PinningVerifier {
    /// 已经通过正常校验的证书也要记下来，供「查看服务器证书」用
    captured: Arc<Mutex<Option<CapturedCert>>>,
    pins: Arc<Mutex<CertPins>>,
    inner: Arc<rustls::client::WebPkiServerVerifier>,
    /// 显式持有加密后端 —— `WebPkiServerVerifier` 本身不暴露它，
    /// 而 TLS 1.2/1.3 的签名校验需要用到它的算法列表
    provider: Arc<rustls::crypto::CryptoProvider>,
}

#[derive(Debug, Clone)]
pub struct CapturedCert {
    pub fingerprint: String,
    pub der: Vec<u8>,
}

impl PinningVerifier {
    fn capture(&self, der: &[u8]) {
        let fp = fingerprint_of(der);
        if let Ok(mut c) = self.captured.lock() {
            *c = Some(CapturedCert { fingerprint: fp, der: der.to_vec() });
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        self.capture(end_entity.as_ref());

        // 小写归一：SNI 是大小写不敏感的，`Vault.Example.com` 与
        // `vault.example.com` 是同一台机器，不该被当成两个条目
        let key = server_name.to_str().to_ascii_lowercase();
        let pinned = self.pins.lock().ok().and_then(|p| p.get(&key).cloned());

        if let Some(expected) = pinned {
            // 已固定：只有一模一样的证书才放行，**不管**链能不能验通。
            // 自签证书本来就验不通，这里是指纹说了算。
            let actual = fingerprint_of(end_entity.as_ref());
            return if actual == expected {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::InvalidCertificate(
                    rustls::CertificateError::ApplicationVerificationFailure,
                ))
            };
        }

        // 未固定：走标准校验。失败时不放行 —— 让用户看着指纹决定。
        self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// 只用于 `probe_certificate`：接受任何证书，但把叶子证书抄下来。
///
/// ⚠️ 它**只**用来读取证书信息给用户看，用完即弃，绝不参与真正的请求。
#[derive(Debug)]
struct CaptureOnlyVerifier {
    captured: Arc<Mutex<Option<CapturedCert>>>,
}

impl rustls::client::danger::ServerCertVerifier for CaptureOnlyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fp = fingerprint_of(end_entity.as_ref());
        if let Ok(mut c) = self.captured.lock() {
            *c = Some(CapturedCert { fingerprint: fp, der: end_entity.as_ref().to_vec() });
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ── 状态 ──

pub struct HttpState {
    client: reqwest::Client,
    no_redirect_client: reqwest::Client,
    pins: Arc<Mutex<CertPins>>,
    pins_path: PathBuf,
    /// 最近一次被 TLS 校验拒掉的证书 —— 界面要拿它给用户看
    rejected: Arc<Mutex<Option<CapturedCert>>>,
}

impl HttpState {
    pub fn new(pins_path: PathBuf) -> Result<Self, String> {
        // rustls 需要进程级默认加密后端；显式装 ring，
        // 免得依赖 reqwest 的默认选择（aws-lc-rs 那条路在部分机器上要 cmake）
        // install_default 会拿走所有权，所以装一个、留一个
        let _ = rustls::crypto::ring::default_provider().install_default();
        let provider = Arc::new(rustls::crypto::ring::default_provider());

        let mut roots = rustls::RootCertStore::empty();
        // 用系统信任库而不是内置根证书列表：用户把自签证书装进钥匙串之后，
        // 应用就应该直接认 —— 这是 macOS 用户的合理预期
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _ = roots.add(cert);
        }

        let inner = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|e| format!("无法建立证书校验器：{e}"))?;

        let pins = Arc::new(Mutex::new(CertPins::load(&pins_path)));
        let rejected = Arc::new(Mutex::new(None));

        let verifier = Arc::new(PinningVerifier {
            captured: rejected.clone(),
            pins: pins.clone(),
            inner,
            provider,
        });

        let tls = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();

        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls.clone())
            .build()
            .map_err(|e| format!("无法建立 HTTP 客户端：{e}"))?;

        // Restricted redirects retain exactly the same system roots, pinning
        // verifier, and captured certificate state as ordinary requests.
        let no_redirect_client = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("无法建立 HTTP 客户端：{e}"))?;

        Ok(Self { client, no_redirect_client, pins, pins_path, rejected })
    }

    fn take_rejected(&self) -> Option<CapturedCert> {
        self.rejected.lock().ok().and_then(|mut r| r.take())
    }
}

// ── 命令 ──

#[tauri::command]
pub async fn http_request(
    state: tauri::State<'_, HttpState>,
    req: HttpRequest,
) -> Result<HttpResponse, HttpError> {
    execute(&state, req).await
}

/// 命令体本体。抽出来是为了能在测试里直接调 —— `tauri::State` 没法在测试里构造。
pub async fn execute(state: &HttpState, req: HttpRequest) -> Result<HttpResponse, HttpError> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| HttpError::new("invalidRequest", format!("不支持的 HTTP 方法：{}", req.method)))?;

    let client = if req.redirect == RedirectMode::Follow {
        &state.client
    } else {
        &state.no_redirect_client
    };
    let mut builder = client
        .request(method, &req.url)
        .timeout(std::time::Duration::from_millis(req.timeout_ms.unwrap_or(30_000)));

    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    // 二进制优先。两者同时给说明调用方有问题，但按约定以 base64 为准，
    // 并且**解码失败要当场报错** —— 静默降级成空体会发出一个内容缺失的请求
    if let Some(encoded) = req.body_base64 {
        let bytes = B64.decode(encoded.as_bytes()).map_err(|e| {
            HttpError::new("invalidRequest", format!("bodyBase64 不是合法的 base64：{e}"))
        })?;
        builder = builder.body(bytes);
    } else if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let res = match builder.send().await {
        Ok(r) => r,
        Err(e) => return Err(classify(&state, &req.url, e)),
    };

    let status = res.status().as_u16();
    if req.redirect == RedirectMode::Error && matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Err(HttpError::new("network", "服务器返回了不允许的重定向"));
    }
    let headers = res
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();

    // ⚠️ 取**字节**，不能取 `res.text()`。后者是有损 UTF-8 解码：非法序列
    // 变成 U+FFFD 且不报错，下载的附件与图标会静默损坏。
    let bytes = res.bytes().await
        .map_err(|e| HttpError::new("network", format!("读取响应失败：{e}")))?
        .to_vec();

    Ok(HttpResponse::from_body(status, headers, bytes))
}

/// 探取服务器证书 —— 用户要在看到指纹和信息之后，才能决定信不信。
///
/// 入参是完整 URL 而不是 host/port：主机名的解析规则（默认端口、去凭据、
/// 去路径）只该有一处实现，就是这里的 `host_and_port_of`。前端再写一遍必然走样。
#[tauri::command]
pub async fn probe_certificate(
    state: tauri::State<'_, HttpState>,
    url: String,
) -> Result<CertInfo, HttpError> {
    // 里面是阻塞的 TCP + TLS 握手，别占着异步运行时
    let pins = state.pins.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&pins, &url))
        .await
        .map_err(|e| HttpError::new("network", format!("读取证书失败：{e}")))?
}

/// 命令体本体。阻塞式 —— 调用方负责放进 `spawn_blocking`。
pub fn probe(pins: &Arc<Mutex<CertPins>>, url: &str) -> Result<CertInfo, HttpError> {
    let (host, port) = host_and_port_of(url)
        .ok_or_else(|| HttpError::new("invalidRequest", format!("无法解析服务器地址：{url}")))?;
    let key = host.clone();

    let captured = Arc::new(Mutex::new(None));
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(CaptureOnlyVerifier { captured: captured.clone() }))
        .with_no_client_auth();

    let server_name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|_| HttpError::new("invalidRequest", format!("无法解析主机名：{host}")))?;

    let conn = rustls::ClientConnection::new(Arc::new(config), server_name)
        .map_err(|e| HttpError::new("tls", format!("TLS 初始化失败：{e}")))?;

    let addr = format!("{host}:{port}");
    let sock = std::net::TcpStream::connect(&addr)
        .map_err(|e| HttpError::new("network", format!("连不上 {addr}：{e}")))?;
    let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(10)));

    let mut tls = rustls::StreamOwned::new(conn, sock);
    // 握手在第一次 IO 时真正发生
    let _ = tls.conn.complete_io(&mut tls.sock);

    let cert = captured.lock().ok().and_then(|mut c| c.take()).ok_or_else(|| {
        HttpError::new("tls", format!("{addr} 没有提供证书 —— 它可能不是 HTTPS 服务"))
    })?;

    let already_trusted = pins
        .lock()
        .ok()
        .and_then(|p| p.get(&key).map(|f| f == &cert.fingerprint))
        .unwrap_or(false);

    let info = describe_cert(&cert.der, cert.fingerprint, already_trusted);
    Ok(info)
}

/// 记住这台服务器的证书指纹。之后只有一模一样的证书才会被接受。
#[tauri::command]
pub fn trust_certificate(
    state: tauri::State<'_, HttpState>,
    url: String,
    fingerprint: String,
) -> Result<(), HttpError> {
    trust(&state.pins, &state.pins_path, &url, &fingerprint)
}

/// 命令体本体。
pub fn trust(
    pins: &Arc<Mutex<CertPins>>, pins_path: &PathBuf, url: &str, fingerprint: &str,
) -> Result<(), HttpError> {
    let key = pin_key_of(url)
        .ok_or_else(|| HttpError::new("invalidRequest", format!("无法解析服务器地址：{url}")))?;
    let mut pins = pins
        .lock()
        .map_err(|_| HttpError::new("invalidRequest", "证书存储不可用"))?;
    pins.set(&key, fingerprint);
    pins.save(pins_path)
        .map_err(|e| HttpError::new("invalidRequest", format!("无法保存证书信任：{e}")))?;
    Ok(())
}

/// 撤销对某台服务器的证书信任。
#[tauri::command]
pub fn forget_certificate(
    state: tauri::State<'_, HttpState>,
    url: String,
) -> Result<(), HttpError> {
    forget(&state.pins, &state.pins_path, &url)
}

/// 命令体本体。
pub fn forget(pins: &Arc<Mutex<CertPins>>, pins_path: &PathBuf, url: &str) -> Result<(), HttpError> {
    let key = pin_key_of(url)
        .ok_or_else(|| HttpError::new("invalidRequest", format!("无法解析服务器地址：{url}")))?;
    let mut pins = pins
        .lock()
        .map_err(|_| HttpError::new("invalidRequest", "证书存储不可用"))?;
    pins.remove(&key);
    pins.save(pins_path)
        .map_err(|e| HttpError::new("invalidRequest", format!("无法保存证书信任：{e}")))?;
    Ok(())
}

// ── 内部 ──

/// 把 reqwest 的错误翻译成界面能分辨的几类。
fn classify(state: &HttpState, url: &str, err: reqwest::Error) -> HttpError {
    if err.is_timeout() {
        return HttpError::new("timeout", "服务器响应超时");
    }

    // TLS 失败：把被拒的证书指纹带上，界面才能提示用户去信任它
    if let Some(cert) = state.take_rejected() {
        return HttpError {
            kind: "certUntrusted".into(),
            message: format!("{} 的证书无法验证", pin_key_of(url).unwrap_or_else(|| url.into())),
            fingerprint: Some(cert.fingerprint),
        };
    }

    if err.is_connect() {
        return HttpError::new("network", "连不上服务器，请检查地址与网络");
    }

    HttpError::new("network", format!("请求失败：{err}"))
}

/// 解析证书，凑出给用户看的信息。
fn describe_cert(der: &[u8], fingerprint: String, already_trusted: bool) -> CertInfo {
    use x509_parser::prelude::*;

    let fallback = CertInfo {
        fingerprint: fingerprint.clone(),
        subject: "（无法解析）".into(),
        issuer: "（无法解析）".into(),
        not_before: String::new(),
        not_after: String::new(),
        is_self_signed: true,
        already_trusted,
    };

    let Ok((_, cert)) = X509Certificate::from_der(der) else { return fallback };

    CertInfo {
        fingerprint,
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        not_before: cert.validity().not_before.to_rfc2822().unwrap_or_default(),
        not_after: cert.validity().not_after.to_rfc2822().unwrap_or_default(),
        is_self_signed: cert.subject() == cert.issuer(),
        already_trusted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_uppercase_colon_separated_sha256() {
        // SHA-256 是 32 字节 → 32 组两位十六进制，用冒号连起来共 95 字符
        let fp = fingerprint_of(b"hello");
        assert_eq!(fp.len(), 95, "格式应为 32 组两位十六进制加 31 个冒号");
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
        assert!(fp.chars().filter(|c| c.is_ascii_alphabetic()).all(|c| c.is_ascii_uppercase()),
            "必须大写 —— 用户要拿它跟 openssl 的输出逐字对照");
        // 已知向量：SHA-256("hello")
        assert!(fp.starts_with("2C:F2:4D:BA:5F:B0:A3:0E:26:E8:3B:2A:C5:B9:E2:9E"));
    }

    /// ⚠️ `bodyBase64` 要走**字节**，不是把它当字符串发。
    ///
    /// 附件上传靠这条 —— 二进制经 `TextDecoder` 转字符串会被静默改字节
    /// （非法 UTF-8 序列变成 U+FFFD），传上去的文件损坏而上传「成功」。
    #[test]
    fn body_base64_decodes_to_the_original_bytes() {
        let original: Vec<u8> = vec![0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00];
        let encoded = B64.encode(&original);
        let decoded = B64.decode(encoded.as_bytes()).expect("应当能解回来");
        assert_eq!(decoded, original);

        // 这几个字节**不是**合法 UTF-8 —— 正是它们会被 TextDecoder 改掉
        assert!(std::str::from_utf8(&original).is_err(), "这组字节本来就该不是合法 UTF-8");
    }

    #[test]
    fn invalid_base64_is_rejected_rather_than_silently_dropped() {
        // 静默降级成空体会发出一个内容缺失的请求 —— 那比报错糟得多
        assert!(B64.decode(b"not base64!!").is_err());
    }

    #[test]
    fn fingerprint_differs_for_different_certs() {
        assert_ne!(fingerprint_of(b"cert-a"), fingerprint_of(b"cert-b"));
    }

    #[test]
    fn host_and_port_fills_in_the_default_port() {
        assert_eq!(host_and_port_of("https://a.com/x"), Some(("a.com".into(), 443)));
        assert_eq!(host_and_port_of("http://a.com/x"), Some(("a.com".into(), 80)));
        assert_eq!(host_and_port_of("https://a.com:8443/"), Some(("a.com".into(), 8443)));
        assert_eq!(host_and_port_of("http://127.0.0.1:8080/identity"), Some(("127.0.0.1".into(), 8080)));
    }

    #[test]
    fn host_and_port_ignores_path_query_and_credentials() {
        assert_eq!(host_and_port_of("https://u:p@a.com/x?y=1#z"), Some(("a.com".into(), 443)));
        assert_eq!(host_and_port_of("https://a.com?x=1"), Some(("a.com".into(), 443)));
    }

    #[test]
    fn host_and_port_rejects_garbage() {
        assert_eq!(host_and_port_of("not a url"), None);
        assert_eq!(host_and_port_of("https://"), None);
        assert_eq!(host_and_port_of("https://a.com:notaport"), None);
    }

    /// 固定的键**不含端口**，且统一小写 —— 必须与 `PinningVerifier` 里用的键
    /// 完全一致，否则「信任过了却依然连不上」。这个 bug 是集成测试抓到的。
    #[test]
    fn pin_key_is_host_only_and_lowercased() {
        assert_eq!(pin_key_of("https://a.com:8443/x").as_deref(), Some("a.com"));
        assert_eq!(pin_key_of("https://Vault.Example.COM/x").as_deref(), Some("vault.example.com"));
        assert_eq!(pin_key_of("https://a.com").as_deref(), Some("a.com"));
        // 大小写不同的同一个主机必须归到同一个键上
        assert_eq!(pin_key_of("https://A.com/x"), pin_key_of("https://a.com/y"));
    }

    #[test]
    fn pins_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("onewarden-pins-test-{}", std::process::id()));
        let path = dir.join("certs.json");
        let _ = std::fs::remove_dir_all(&dir);

        let mut pins = CertPins::default();
        pins.set("a.com:443", "AA:BB");
        pins.save(&path).expect("保存应当成功");

        let loaded = CertPins::load(&path);
        assert_eq!(loaded.get("a.com:443").map(String::as_str), Some("AA:BB"));
        assert_eq!(loaded.get("b.com:443"), None);

        // 撤销后不应再被记住
        let mut pins = loaded;
        pins.remove("a.com:443");
        pins.save(&path).unwrap();
        assert_eq!(CertPins::load(&path).get("a.com:443"), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_pin_file_is_not_an_error() {
        // 首次启动时文件不存在 —— 应该是空存储，而不是崩溃
        let path = std::env::temp_dir().join("onewarden-pins-does-not-exist/never.json");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        assert_eq!(CertPins::load(&path).get("a.com:443"), None);
    }

    #[test]
    fn corrupt_pin_file_falls_back_to_empty() {
        // 文件被写坏时宁可重新信任，也不能让应用起不来
        let dir = std::env::temp_dir().join(format!("onewarden-pins-corrupt-{}", std::process::id()));
        let path = dir.join("certs.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ 这不是 JSON").unwrap();
        assert_eq!(CertPins::load(&path).get("a.com:443"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 需要真实服务器的集成测试 ──
    //
    // 证书这条链路没法用假的糊弄过去：中间人防线是否成立，取决于
    // rustls 真的拿到那张证书之后做了什么决定。默认忽略，显式跑：
    //
    //   ./scripts/dev-server.sh start
    //   cargo test -- --ignored
    mod integration {
        use super::*;

        fn dev_url() -> String {
            std::env::var("ONEWARDEN_DEV_URL").unwrap_or_else(|_| "https://localhost:8443".into())
        }

        /// 建一个全新的 HttpState（意味着全新的连接池）。
        /// 同一个 pins 文件可以被多个 HttpState 读 —— 用来模拟重启。
        fn state_at(dir: &std::path::Path) -> HttpState {
            HttpState::new(dir.join("pins.json")).expect("HttpState 应当能建立")
        }

        fn scratch_dir(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("onewarden-tofu-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            dir
        }

        fn get(url: &str) -> HttpRequest {
            HttpRequest {
                method: "GET".into(),
                url: url.into(),
                headers: HashMap::new(),
                body: None,
                body_base64: None,
                timeout_ms: Some(10_000),
                redirect: RedirectMode::Follow,
            }
        }

        fn fetch(state: &HttpState, url: &str) -> Result<HttpResponse, HttpError> {
            tauri::async_runtime::block_on(execute(state, get(url)))
        }

        /// 自签证书的完整 TOFU 流程。
        #[test]
        #[ignore = "需要运行中的开发服务器（scripts/dev-server.sh start）"]
        fn self_signed_cert_is_rejected_then_trustable_then_pinned() {
            let base = dev_url();
            let dir = scratch_dir("flow");
            let state = state_at(&dir);
            let url = format!("{base}/api/config");

            // 1. 未固定 + 自签 → 必须拒绝。**绝不能**静默放行
            let err = fetch(&state, &url).expect_err("自签证书必须先被拒绝");
            assert_eq!(err.kind, "certUntrusted", "实际：{err:?}");
            let fingerprint = err.fingerprint.expect("必须带回指纹，否则用户无从核对");

            // 2. 探测拿到的必须是被拒的那张 —— 用户核对的就是它
            let info = probe(&state.pins, &base).expect("探测应当成功");
            assert_eq!(info.fingerprint, fingerprint, "探测到的与刚才被拒的不是同一张证书");
            assert!(info.is_self_signed, "本地开发证书应当是自签的");
            assert!(!info.already_trusted, "还没信任过");
            assert!(!info.issuer.is_empty() && !info.not_after.is_empty(), "证书详情不该是空的");

            // 3. 信任之后，同样的请求应当通过
            trust(&state.pins, &state.pins_path, &base, &fingerprint).expect("保存信任");
            let res = fetch(&state, &url).expect("信任之后应当能连上");
            assert_eq!(res.status, 200);
            let body = res.body.as_deref().expect("配置响应应当是文本");
            assert!(body.contains("environment"), "拿到的应当是 Vaultwarden 的配置：{body}");

            // 4. 重新探测应当显示已信任
            assert!(probe(&state.pins, &base).unwrap().already_trusted);

            // 5. **中间人防线**：指纹对不上时必须拒绝。
            //    这是「只接受完全相同的证书」与「接受任意证书」的分水岭。
            //
            //    ⚠️ 必须换一个全新的 HttpState：reqwest 会复用连接池里已经
            //    握手过的连接，而复用不会重新校验证书。生产上也一样 ——
            //    但这不构成漏洞：池子里的连接是当初通过校验时建立的，
            //    而中间人攻击**必然**是一次新的握手。
            trust(&state.pins, &state.pins_path, &base, "00:00:00:00").expect("写入一个错误的固定值");
            let mitm = state_at(&dir);
            let err = fetch(&mitm, &url).expect_err("指纹对不上时必须拒绝");
            assert_eq!(err.kind, "certUntrusted");

            // 6. 撤销信任之后同样回到「拒绝」
            forget(&mitm.pins, &mitm.pins_path, &base).expect("撤销信任");
            let after_forget = state_at(&dir);
            assert_eq!(
                fetch(&after_forget, &url).expect_err("撤销后必须重新拒绝").kind,
                "certUntrusted",
            );

            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 指纹固定要跨进程存活 —— 重启应用不该让用户重新信任一遍
        #[test]
        #[ignore = "需要运行中的开发服务器（scripts/dev-server.sh start）"]
        fn trust_survives_a_restart() {
            let base = dev_url();
            let url = format!("{base}/api/config");

            let dir = std::env::temp_dir().join(format!("onewarden-tofu-restart-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let path = dir.join("pins.json");

            let fingerprint = {
                let state = HttpState::new(path.clone()).unwrap();
                let fp = fetch(&state, &url).expect_err("首次必须被拒绝").fingerprint.unwrap();
                trust(&state.pins, &state.pins_path, &base, &fp).unwrap();
                fp
            };

            // 换一个全新的 HttpState 读同一个文件 —— 相当于重启应用
            let restarted = HttpState::new(path).unwrap();
            assert_eq!(
                fetch(&restarted, &url).expect("重启后应当仍然信任").status, 200,
                "指纹固定没有落盘（期望 {fingerprint}）",
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn redirect_modes_do_not_contact_target_unless_follow_requested() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let server_hits = hits.clone();
        let server_stop = stop.clone();
        let server = std::thread::spawn(move || {
            while !server_stop.load(Ordering::SeqCst) {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("local HTTP accept failed: {error}"),
                };
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0_u8; 1024];
                    let size = socket.read(&mut buffer).unwrap();
                    if size == 0 { break; }
                    request.extend_from_slice(&buffer[..size]);
                    if request.windows(4).any(|part| part == b"\r\n\r\n") { break; }
                }
                let target = String::from_utf8_lossy(&request).lines().next().unwrap_or("").contains(" /target ");
                let response = if target {
                    server_hits.fetch_add(1, Ordering::SeqCst);
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                } else {
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: /target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        let path = std::env::temp_dir().join(format!("onewarden-redirect-pins-{}.json", std::process::id()));
        let state = HttpState::new(path).unwrap();
        let mut outcomes = Vec::new();
        for mode in ["error", "manual", "follow"] {
            let req: HttpRequest = serde_json::from_value(serde_json::json!({
                "method": "POST", "url": format!("http://{address}/redirect"),
                "headers": { "Authorization": "Bearer synthetic" }, "body": "synthetic",
                "redirect": mode, "timeoutMs": 2000,
            })).unwrap();
            let response = tauri::async_runtime::block_on(execute(&state, req));
            outcomes.push((mode, response, hits.load(Ordering::SeqCst)));
        }
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
        let (_, error, error_hits) = &outcomes[0];
        assert!(error.is_err(), "redirect:error must reject the redirect response");
        assert_eq!(*error_hits, 0, "rejected redirect must never contact target");
        let (_, manual, manual_hits) = &outcomes[1];
        assert_eq!(manual.as_ref().unwrap().status, 307);
        assert_eq!(*manual_hits, 0, "manual redirect must never contact target");
        let (_, follow, follow_hits) = &outcomes[2];
        assert_eq!(follow.as_ref().unwrap().status, 200);
        assert_eq!(*follow_hits, 1, "follow mode proves target was available");
    }

    /// ⚠️ **二进制响应体必须在传输中保持原样。**
    ///
    /// 这个传输层原本是给 JSON API 写的，响应体一律走 `res.text()` ——
    /// 而 `text()` 是**有损**解码：非法 UTF-8 序列变成 U+FFFD，且**不报错**。
    ///
    /// 实测一张 33270 字节的 PNG 走完这一趟变成 60381 字节、13806 个 U+FFFD，
    /// 哈希面目全非。所以下载的附件一直是坏的，而用户看到的是「保存成功」。
    ///
    /// 请求侧早就有 `bodyBase64` 了（附件上传靠它），响应侧一直缺这一半 ——
    /// 传输层是不对称的，这个测试补的就是另一半。
    #[test]
    fn binary_response_body_survives_as_base64() {
        // PNG 的魔数：0x89 不是合法 UTF-8 的首字节，正是会被 text() 改掉的那类
        let png: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00];
        assert!(std::str::from_utf8(&png).is_err(), "这组字节本来就该不是合法 UTF-8");

        let res = HttpResponse::from_body(200, HashMap::new(), png.clone());

        assert!(res.body.is_none(), "二进制不该走文本通道");
        let encoded = res.body_base64.expect("二进制必须走 base64 通道");
        assert_eq!(B64.decode(encoded.as_bytes()).unwrap(), png, "字节必须一个不差地回来");
    }

    /// 反面：JSON 还得是文本，否则所有调用方都要改
    #[test]
    fn text_response_body_stays_text() {
        let res = HttpResponse::from_body(200, HashMap::new(), br#"{"a":1}"#.to_vec());
        assert_eq!(res.body.as_deref(), Some(r#"{"a":1}"#));
        assert!(res.body_base64.is_none());
    }

    /// 中文是合法 UTF-8，不该被误判成二进制
    #[test]
    fn non_ascii_text_is_still_text() {
        let res = HttpResponse::from_body(200, HashMap::new(), "保险库未解锁".as_bytes().to_vec());
        assert_eq!(res.body.as_deref(), Some("保险库未解锁"));
    }

    /// 响应体为空时两个字段都不给 —— 不要发一个空的 base64 让前端去解
    #[test]
    fn empty_body_produces_neither_field() {
        let res = HttpResponse::from_body(204, HashMap::new(), Vec::new());
        assert!(res.body.is_none());
        assert!(res.body_base64.is_none());
    }
}
