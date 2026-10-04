#!/usr/bin/env bash
# 编译 Vaultwarden 到 vendor/vaultwarden（幂等）。
#
# 为什么从源码编译：Vaultwarden 官方**不发布 macOS 预编译二进制**
# （1.37.3 的 GitHub release 没有任何 asset），Homebrew 也没有 formula。
# 编译产出的是纯原生 arm64 可执行文件，不需要任何虚拟机或容器运行时。
#
# 我们只需要 API 服务端 —— 不需要它自带的网页版前端（客户端是我们自己写的），
# 所以跳过 web-vault 的下载，纯 cargo build 即可。
set -euo pipefail

VW_VERSION="${VW_VERSION:-1.37.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
SRC="$VENDOR/src"
BIN="$VENDOR/vaultwarden"

if [[ -x "$BIN" ]]; then
  echo "✓ 已存在: $BIN"
  "$BIN" --version || true
  exit 0
fi

mkdir -p "$VENDOR" "$SRC"

# ~/.cargo/config.toml 可能把 target-dir 重定向到了别处。若已有编译产物就直接复用，
# 避免重复付出一次完整的 release 编译（数分钟）。
for cand in "$ROOT/target/release/vaultwarden" "/tmp/cargo_target/release/vaultwarden"; do
  if [[ -x "$cand" ]]; then
    echo "→ 复用已有的编译产物: $cand"
    cp "$cand" "$BIN"
    echo "✓ $BIN"
    "$BIN" --version
    exit 0
  fi
done

if [[ ! -d "$SRC/vaultwarden-$VW_VERSION" ]]; then
  echo "→ 下载 Vaultwarden $VW_VERSION 源码..."
  curl -fL --retry 3 --max-time 900 \
    -o "$SRC/vw.tar.gz" \
    "https://codeload.github.com/dani-garcia/vaultwarden/tar.gz/refs/tags/$VW_VERSION"
  tar xzf "$SRC/vw.tar.gz" -C "$SRC"
fi

echo "→ 编译中（首次约 5-15 分钟）..."
cd "$SRC/vaultwarden-$VW_VERSION"
cargo build --release --features sqlite

for cand in "$ROOT/target/release/vaultwarden" "/tmp/cargo_target/release/vaultwarden"; do
  if [[ -x "$cand" ]]; then cp "$cand" "$BIN"; break; fi
done
[[ -x "$BIN" ]] || { echo "✗ 未找到编译产物" >&2; exit 1; }

echo "✓ 编译完成: $BIN"
"$BIN" --version
