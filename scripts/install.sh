#!/bin/sh
# Synapse agent 安装脚本：识别平台 → 选通道 → 校验 → 写配置（600）→ 常驻
set -eu

ENDPOINT=""; PROJECT=""; TOKEN=""; AGENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="$2"; shift 2;;
    --project)  PROJECT="$2";  shift 2;;
    --token)    TOKEN="$2";    shift 2;;
    --agent)    AGENT="$2";    shift 2;;
    *) shift;;
  esac
done
[ -n "$ENDPOINT" ] && [ -n "$PROJECT" ] && [ -n "$TOKEN" ] || {
  echo "usage: install.sh --endpoint URL --project NAME --token TOKEN [--agent ID]"; exit 2; }
ENDPOINT="${ENDPOINT%/}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; esac

echo "→ endpoint=$ENDPOINT project=$PROJECT os=$OS arch=$ARCH"

# 唯一发布通道：Linux 预编译 musl 二进制（x64 / arm64）。
# 不在客户端做 pip/cargo 回退：PyPI 版本落后，cargo 又要求本机编译，均不符合统一安装入口。
case "$OS-$ARCH" in
  linux-x64)   BIN="synapse-agent-x86_64-linux-musl" ;;
  linux-arm64) BIN="synapse-agent-aarch64-linux-musl" ;;
  *)
    echo "✗ 当前只发布 Linux x64 / arm64 预编译包；你的平台是 ${OS}-${ARCH}。"
    echo "  已停止安装，不会自动 pip/cargo，也不会在本机编译。请让管理员提供对应平台安装包。"
    exit 1
    ;;
esac

echo "→ 通道：预编译二进制（静态 musl，免 glibc）"
  mkdir -p "${HOME}/.local/bin"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT INT TERM
  curl -fsSL "$ENDPOINT/dl/${BIN}" -o "$TMP" || { echo "✗ 下载失败：$ENDPOINT/dl/${BIN}"; exit 1; }
  # 校验值动态取服务端：先 .sha256 边车，再 /dl 响应头；都拿不到就拒绝安装
  WANT="$(curl -fsSL "$ENDPOINT/dl/${BIN}.sha256" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  if [ -z "$WANT" ]; then
    WANT="$(curl -fsSI "$ENDPOINT/dl/${BIN}" 2>/dev/null | awk 'tolower($1)=="x-sha256:"{print $2}' | tr -d '\r' | head -1 || true)"
  fi
  [ -n "$WANT" ] || { echo "✗ 拿不到 sha256，拒绝安装未校验的二进制"; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"
  else echo "✗ 本机没有 sha256sum/shasum，拒绝安装"; exit 1; fi
  [ "$WANT" = "$GOT" ] || { echo "✗ 校验失败 want=$WANT got=$GOT"; exit 1; }
  echo "  ✓ sha256 校验通过 ($GOT)"
  install -m 755 "$TMP" "${HOME}/.local/bin/synapse-agent"
  "${HOME}/.local/bin/synapse-agent" init --endpoint "$ENDPOINT" --project "$PROJECT" --token "$TOKEN" ${AGENT:+--agent "$AGENT"}
  UNIT_CMD="${HOME}/.local/bin/synapse-agent run"

CFG="${HOME}/.synapse-agent/config.json"
if [ -f "$CFG" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${HOME}/.config/systemd/user"; mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/synapse-agent.service" <<UNIT
[Unit]
Description=synapse agent heartbeat daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${UNIT_CMD}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload >/dev/null 2>&1
  systemctl --user enable --now synapse-agent >/dev/null 2>&1 && \
    echo "✓ 已注册 systemd 用户服务（开机自启，崩溃自拉）" || \
    echo "！systemd 注册失败，可手动： systemctl --user enable --now synapse-agent"
else
  echo "→ 未检测到 systemd 用户会话；请自行常驻："
  echo "    nohup ${UNIT_CMD} >/dev/null 2>&1 &"
fi

echo "✓ 完成。配置在 ~/.synapse-agent/config.json（600），token 只在本地。"
