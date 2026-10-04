#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-env.sh"

# -k：本地自签证书，跳过校验（仅限本地开发）
is_up() { curl -fsSk --max-time 3 "$VW_URL/api/config" >/dev/null 2>&1; }

# 端口通了不代表是我们启动的那个 —— 可能是别的 vaultwarden 实例占着。
# 光看端口会把「外来进程」误判成「已在运行」，之后所有测试都打在错误的服务器上。
is_ours() { [[ -f "$VW_PIDFILE" ]] && kill -0 "$(cat "$VW_PIDFILE")" 2>/dev/null; }

ensure_tls() {
  [[ -f "$VW_TLS_DIR/cert.pem" && -f "$VW_TLS_DIR/key.pem" ]] && return 0
  echo "→ 生成本地自签证书（官方 CLI 拒绝明文 HTTP，所以本地也走 HTTPS）..."
  mkdir -p "$VW_TLS_DIR"
  local openssl_bin
  openssl_bin="$(brew --prefix openssl@3 2>/dev/null)/bin/openssl"
  [[ -x "$openssl_bin" ]] || openssl_bin=/usr/bin/openssl
  "$openssl_bin" req -x509 -newkey rsa:2048 \
    -keyout "$VW_TLS_DIR/key.pem" -out "$VW_TLS_DIR/cert.pem" \
    -days 3650 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
}

start() {
  [[ -x "$VW_BIN" ]] || { echo "✗ 未找到 $VW_BIN，请先运行 scripts/build-vaultwarden.sh" >&2; exit 1; }
  ensure_tls
  if is_up; then
    if is_ours; then echo "✓ 已在运行: $VW_URL"; return 0; fi
    echo "✗ 端口 $VW_PORT 已被**其他**进程占用（不是本脚本启动的）：" >&2
    lsof -nP -iTCP:"$VW_PORT" -sTCP:LISTEN >&2 2>/dev/null || true
    echo "  请先结束它，或用 VW_PORT=<其他端口> 重试。" >&2
    exit 1
  fi
  mkdir -p "$VW_DATA" "$(dirname "$VW_LOG")"
  echo "→ 启动 Vaultwarden..."
  env "${VW_ENV[@]}" "$VW_BIN" > "$VW_LOG" 2>&1 &
  echo $! > "$VW_PIDFILE"
  for _ in $(seq 1 60); do
    is_up && { echo "✓ 就绪: $VW_URL"; return 0; }
    sleep 0.5
  done
  echo "✗ 启动超时，日志尾部：" >&2; tail -30 "$VW_LOG" >&2; exit 1
}

stop() {
  if [[ -f "$VW_PIDFILE" ]]; then
    kill "$(cat "$VW_PIDFILE")" 2>/dev/null || true
    rm -f "$VW_PIDFILE"
    echo "✓ 已停止"
  else
    echo "· 未在运行"
  fi
}

reset() {
  stop
  rm -rf "$VW_DATA"
  # 同时清掉 CLI 侧的状态。只删服务端数据的话，.dev/bw-session 里还留着
  # 一个指向「已不存在的账户」的会话，互操作测试会以像是密码学错误的方式失败。
  rm -rf "${BITWARDENCLI_APPDATA_DIR:-$ROOT/.dev/bw-cli}" "$ROOT/.dev/bw-session"
  echo "✓ 数据已清空（服务端 + CLI 状态；下次 start 得到全新实例）"
}

status() { is_up && echo "● 运行中: $VW_URL" || echo "○ 未运行"; }

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  reset) reset ;;
  status) status ;;
  *) echo "用法: $0 {start|stop|restart|reset|status}" >&2; exit 1 ;;
esac
