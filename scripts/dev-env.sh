#!/usr/bin/env bash
# 被 dev-server.sh / 测试脚本 source，集中管理本地测试服务参数
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
export VW_BIN="$ROOT/vendor/vaultwarden"
export VW_DATA="$ROOT/.dev/vaultwarden-data"
export VW_TLS_DIR="$ROOT/.dev/tls"
export VW_PORT="${VW_PORT:-8443}"
export VW_URL="https://localhost:$VW_PORT"
export VW_PIDFILE="$ROOT/.dev/vaultwarden.pid"
export VW_LOG="$ROOT/.dev/vaultwarden.log"

# 仅供本地开发的测试账号 —— 绝不用于任何真实环境
export COFFER_TEST_EMAIL="coffer-test@example.com"
export COFFER_TEST_PASSWORD='Test-Master-Password-123!'

# 官方 Bitwarden CLI 与 SDK 拒绝明文 HTTP（InsecureUrlNotAllowedError），
# 所以本地也走 HTTPS + 自签证书。
# ⚠️ 仅限本地开发：这两项让 TLS 证书校验失效，绝不能出现在生产配置里。
export NODE_TLS_REJECT_UNAUTHORIZED=0
export BITWARDENCLI_APPDATA_DIR="$ROOT/.dev/bw-cli"

export VW_ENV=(
  "DATA_FOLDER=$VW_DATA"
  "ROCKET_PORT=$VW_PORT"
  "ROCKET_ADDRESS=127.0.0.1"
  "ROCKET_TLS={certs=\"$VW_TLS_DIR/cert.pem\",key=\"$VW_TLS_DIR/key.pem\"}"
  "DOMAIN=$VW_URL"
  "SIGNUPS_ALLOWED=true"
  "SIGNUPS_VERIFY=false"
  "INVITATIONS_ALLOWED=true"
  "WEBSOCKET_ENABLED=true"
  "SHOW_PASSWORD_HINT=false"
  "LOG_LEVEL=warn"
  "I_REALLY_WANT_VOLATILE_STORAGE=false"
  # 我们只需要 API 服务端 —— 自带网页前端是给浏览器用的，我们的客户端是自己写的。
  # 不关掉的话 Vaultwarden 会因为找不到 web-vault/ 目录而拒绝启动。
  "WEB_VAULT_ENABLED=false"
)
