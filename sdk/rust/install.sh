#!/bin/sh
# synapse-agent 二进制下载辅助（维护者用）
# 客户端主入口是 https://synapse.wangda.today/dl/install.sh（含 init/token/systemd）
# 用法：
#   sh sdk/rust/install.sh
# 可选环境变量：
#   YANSHI_BASE     服务地址（默认 https://synapse.wangda.today）
#   YANSHI_BIN_DIR  安装目录（默认 /usr/local/bin，不可写时退到 ~/.local/bin）
#   YANSHI_VERSION  保留位，当前只发布 latest
set -eu

BASE="${YANSHI_BASE:-https://synapse.wangda.today}"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }
need uname
need curl
need sha256sum

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS-$ARCH" in
  linux-x86_64|linux-amd64) ASSET="synapse-agent-x86_64-linux-musl" ;;
  linux-aarch64|linux-arm64)
    die "aarch64 版未发布；请由维护者按 BUILD.md 编译，客户端不要在本机编译" ;;
  darwin-*)
    die "macOS 版未发布；请由维护者按 BUILD.md 编译，客户端不要在本机编译" ;;
  *)
    die "不支持的平台：$OS-$ARCH" ;;
esac

# 选安装目录：优先用户指定 → /usr/local/bin（可写） → ~/.local/bin
if [ -n "${YANSHI_BIN_DIR:-}" ]; then
  DEST="$YANSHI_BIN_DIR"
elif [ -w /usr/local/bin ]; then
  DEST=/usr/local/bin
else
  DEST="$HOME/.local/bin"
fi
mkdir -p "$DEST" || die "无法创建目录 $DEST"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "→ 下载 $ASSET"
curl -fsSL --retry 3 --connect-timeout 10 -o "$TMP/agent" "$BASE/dl/$ASSET" \
  || die "下载失败：$BASE/dl/$ASSET"

say "→ 校验 sha256"
SHA_URL="$BASE/dl/$ASSET.sha256"
if curl -fsSL --retry 2 -o "$TMP/agent.sha256" "$SHA_URL" 2>/dev/null; then
  EXPECT=$(awk '{print $1}' "$TMP/agent.sha256" | head -1)
  ACTUAL=$(sha256sum "$TMP/agent" | awk '{print $1}')
  if [ "$EXPECT" != "$ACTUAL" ]; then
    die "校验不一致：期望 $EXPECT，实际 $ACTUAL"
  fi
  say "  ok $ACTUAL"
else
  # 没有 .sha256 就退回服务端响应头；两者都拿不到就拒绝安装（fail-closed）
  EXPECT=$(curl -fsSI --retry 2 "$BASE/dl/$ASSET" 2>/dev/null | awk 'tolower($1)=="x-sha256:"{print $2}' | tr -d '\r' | head -1)
  if [ -z "$EXPECT" ]; then
    die "拿不到任何 sha256（$SHA_URL 与服务端 x-sha256 都为空），拒绝安装未校验的二进制"
  fi
  ACTUAL=$(sha256sum "$TMP/agent" | awk '{print $1}')
  [ "$EXPECT" = "$ACTUAL" ] || die "校验不一致：期望 $EXPECT，实际 $ACTUAL"
  say "  ok $ACTUAL（来自响应头）"
fi

say "→ 安装到 $DEST/synapse-agent"
install -m 0755 "$TMP/agent" "$DEST/synapse-agent" 2>/dev/null \
  || { cp "$TMP/agent" "$DEST/synapse-agent" && chmod 0755 "$DEST/synapse-agent"; }

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) say "  ! $DEST 不在 PATH 里，请自行加入： export PATH=\"$DEST:\$PATH\"" ;;
esac

say ""
say "✓ 装好了：$DEST/synapse-agent"
say ""
say "下一步（把三个占位换成你自己的）："
say "  1) 开通 agent：在控制台「注册审批」里批准，拿到 token"
say "  2) 长连接常驻："
say "     synapse-agent ws --endpoint $BASE --project <项目> --token <token> --agent <名字> \\"
say "       --exec '你的任务脚本'"
say "  3) 只想测通："
say "     synapse-agent peek --endpoint $BASE --project <项目> --token <token> --agent <名字>"
