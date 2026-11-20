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

CFG="${HOME}/.synapse-agent/config.json"
PID_FILE="${HOME}/.synapse-agent/agent.pid"
LOG_FILE="${HOME}/.synapse-agent/agent.log"
BIN="${HOME}/.local/bin/synapse-agent"

[ -f "$CFG" ] || { echo "✗ 配置未生成：$CFG"; exit 1; }

stop_nohup() {
  if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "→ 停止旧的后台进程 pid=$OLD_PID"
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

start_nohup() {
  if ! command -v nohup >/dev/null 2>&1; then
    echo "→ 未找到 nohup；请手动常驻："
    echo "    ${BIN} run"
    return 0
  fi
  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
  nohup "${BIN}" run >"$LOG_FILE" 2>&1 &
  NEW_PID=$!
  printf '%s\n' "$NEW_PID" > "$PID_FILE"
  chmod 600 "$PID_FILE" 2>/dev/null || true
  sleep 1
  if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "✓ 已用 nohup 后台启动（pid=$NEW_PID）"
    echo "  日志：$LOG_FILE"
  else
    echo "！后台进程启动后退出，最近日志："
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
}

# 先探测 systemd 用户会话；有就注册服务，没有就自动用 nohup 常驻。
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  echo "→ 检测到 systemd 用户会话，注册 synapse-agent.service"
  stop_nohup
  UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/synapse-agent.service" <<UNIT
[Unit]
Description=synapse agent heartbeat daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${BIN} run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if systemctl --user enable --now synapse-agent >/dev/null 2>&1 \
     && systemctl --user restart synapse-agent >/dev/null 2>&1; then
    echo "✓ 已注册并启动 systemd 用户服务（开机自启，崩溃自拉）"
  else
    echo "！systemd 注册失败，回退 nohup"
    rm -f "$UNIT_DIR/synapse-agent.service" 2>/dev/null || true
    start_nohup
  fi
else
  echo "→ 未检测到可用 systemd 用户会话，使用 nohup 后台启动"
  start_nohup
fi

echo "✓ 完成。配置在 ${CFG}（600），token 只在本地。"
