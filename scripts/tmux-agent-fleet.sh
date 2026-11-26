#!/usr/bin/env bash
# 在一个 tmux server 里批量拉起多个隔离的 Synapse agent。
#
# 每个 agent 独占一个状态目录、一个 pane、一个 agent_id、一个后台 run：
#   init -> tmux-config -> 启动 TUI 命令 -> 投递 bootstrap 说明 -> run
#
# 关键点：不同 agent 必须使用不同 --config-dir；本脚本默认把状态目录放到
# ~/.synapse-agent/fleet/<session>/，不会碰默认 ~/.synapse-agent 的配置。
#
# 用法：
#   ./scripts/tmux-agent-fleet.sh up \
#     --count 3 \
#     --session dev-fleet \
#     --command 'codex' \
#     --project yeban \
#     --endpoint https://synapse.wangda.today \
#     --tokens-file ~/.synapse-tokens.txt
#
# tokens 文件格式（每行一个，二选一）：
#   agent-a=<token>
#   agent-b=<token>
# 或按 agent 顺序只写 token（agent_id 用 --agent-prefix/--count 生成）：
#   <token-1>
#   <token-2>
#
# 也可以不提供 token 文件，让脚本用管理员 token 现场签发：
#   SYNAPSE_ADMIN_TOKEN=... ./scripts/tmux-agent-fleet.sh up --issue-tokens ...
# 或 --admin-token-file <只含 admin token 的文件> --issue-tokens ...
#
# 关闭：
#   ./scripts/tmux-agent-fleet.sh down --session dev-fleet
#   # down 只停 run/tmux，保留各 agent 的 config.json 与 token。
#   # 重新拉起原来的配置（不重新 init，不需要 token 文件）：
#   ./scripts/tmux-agent-fleet.sh up --session dev-fleet --reuse --command 'codex'
#
set -euo pipefail
umask 077

CMD=up
COUNT=0
SESSION=""
COMMAND=""
WORKDIR="$PWD"
STATE_ROOT=""
ENDPOINT="${SYNAPSE_ENDPOINT:-https://synapse.wangda.today}"
PROJECT="${SYNAPSE_PROJECT:-yeban}"
AGENT_PREFIX="agent"
AGENT_IDS_CSV=""
TOKENS_FILE=""
ONE_TOKEN=""
ISSUE_TOKENS=0
ADMIN_TOKEN_FILE=""
TOKEN_TTL_DAYS=30
LAYOUT="windows"
TMUX_VERIFY=0
STARTUP_WAIT=6
BOOTSTRAP_DELAY=5
READY_REGEX=""
READY_TIMEOUT=30
BOOTSTRAP=1
BOOTSTRAP_TEXT=""
START_RUN=1
ATTACH=0
KEEP_SESSION=0
REUSE=0
BIN="${SYNAPSE_AGENT_BIN:-synapse-agent}"
TMUX_BIN="${SYNAPSE_TMUX_BIN:-tmux}"

usage() {
  cat <<'EOF'
用法:
  tmux-agent-fleet.sh up [选项]
  tmux-agent-fleet.sh down [--session NAME] [--state-root DIR] [--keep-session]

up 必填:
  --count N                  agent 数量，或 --agent-ids a,b,c
  --command CMD              每个 pane 启动的 TUI 命令，如 'codex' / 'claude' / 'bash -lc codex'
  --project NAME             项目，默认 $SYNAPSE_PROJECT 或 yeban
  --endpoint URL             默认 $SYNAPSE_ENDPOINT 或 https://synapse.wangda.today
  token 来源（三选一；--reuse 时可省略）:
    --tokens-file PATH       每行 agent_id=token，或按顺序只写 token
    --token TOKEN            仅 count=1 时可用
    --issue-tokens           用 admin token 现场签发（需要 --admin-token-file 或 SYNAPSE_ADMIN_TOKEN）

常用:
  --session NAME             默认 synapse-fleet-<时间戳>
  --state-root DIR           默认 ~/.synapse-agent/fleet/<session>
  --reuse                    复用状态目录里已有的 config.json；用于 down 后原地重启，不需要 token
  --agent-prefix NAME        默认 agent，生成 agent-1..N
  --agent-ids a,b,c          显式 ID；与 --count 二选一
  --layout windows|panes     默认 windows（每个 agent 一个 tmux window）
  --workdir DIR              TUI 工作目录，默认当前目录
  --tmux-verify 0|1          默认 0；alternate-screen TUI 用 0
  --startup-wait SEC         默认 6
  --bootstrap-delay SEC      TUI ready 后、发送第一条 bootstrap/启动 run 前固定等待，默认 5
  --ready-regex REGEX        等待 pane 内容匹配后再投递 bootstrap
  --ready-timeout SEC        默认 30
  --no-bootstrap             不投递启动说明
  --bootstrap-text TEXT      自定义启动说明
  --no-run                   只 init/config/TUI，不启动后台 run
  --attach                   完成后 attach/switch 到 session
  --bin PATH                 默认 $SYNAPSE_AGENT_BIN 或 synapse-agent
  --tmux-bin PATH            默认 $SYNAPSE_TMUX_BIN 或 tmux
  -h, --help

安全:
  默认 bootstrap 是在 pane 里“输入并回车”。如果 --command 启动的是普通 shell，
  这段说明会被 shell 当命令执行；请让 --command 启动真正的 TUI，或用 --no-bootstrap。
EOF
}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '→ %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '！%s\n' "$*" >&2; }

trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
shellq() { printf '%q' "$1"; }

# 只读 config.json 的指定字段；失败返回非零，不输出 token。
cfg_value() {
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    sys.exit(2)
v = cfg.get(sys.argv[2], "")
print(v if isinstance(v, str) else "")
PY
}

cfg_has_token() {
  python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    sys.exit(2)
print(1 if str(cfg.get("token", "")).strip() else 0)
PY
}

need_arg() {
  [ "$#" -ge 2 ] || die "选项 $1 需要参数"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    up|down) CMD="$1"; shift ;;
    --count|-n) need_arg "$1" "$@"; COUNT="$2"; shift 2 ;;
    --session|-s) need_arg "$1" "$@"; SESSION="$2"; shift 2 ;;
    --command|-c) need_arg "$1" "$@"; COMMAND="$2"; shift 2 ;;
    --workdir) need_arg "$1" "$@"; WORKDIR="$2"; shift 2 ;;
    --state-root) need_arg "$1" "$@"; STATE_ROOT="$2"; shift 2 ;;
    --endpoint) need_arg "$1" "$@"; ENDPOINT="$2"; shift 2 ;;
    --project) need_arg "$1" "$@"; PROJECT="$2"; shift 2 ;;
    --agent-prefix) need_arg "$1" "$@"; AGENT_PREFIX="$2"; shift 2 ;;
    --agent-ids) need_arg "$1" "$@"; AGENT_IDS_CSV="$2"; shift 2 ;;
    --tokens-file) need_arg "$1" "$@"; TOKENS_FILE="$2"; shift 2 ;;
    --token) need_arg "$1" "$@"; ONE_TOKEN="$2"; shift 2 ;;
    --issue-tokens) ISSUE_TOKENS=1; shift ;;
    --admin-token-file) need_arg "$1" "$@"; ADMIN_TOKEN_FILE="$2"; shift 2 ;;
    --token-ttl-days) need_arg "$1" "$@"; TOKEN_TTL_DAYS="$2"; shift 2 ;;
    --layout) need_arg "$1" "$@"; LAYOUT="$2"; shift 2 ;;
    --tmux-verify) need_arg "$1" "$@"; TMUX_VERIFY="$2"; shift 2 ;;
    --startup-wait) need_arg "$1" "$@"; STARTUP_WAIT="$2"; shift 2 ;;
    --bootstrap-delay) need_arg "$1" "$@"; BOOTSTRAP_DELAY="$2"; shift 2 ;;
    --ready-regex) need_arg "$1" "$@"; READY_REGEX="$2"; shift 2 ;;
    --ready-timeout) need_arg "$1" "$@"; READY_TIMEOUT="$2"; shift 2 ;;
    --no-bootstrap) BOOTSTRAP=0; shift ;;
    --bootstrap-text) need_arg "$1" "$@"; BOOTSTRAP_TEXT="$2"; shift 2 ;;
    --no-run) START_RUN=0; shift ;;
    --attach) ATTACH=1; shift ;;
    --keep-session) KEEP_SESSION=1; shift ;;
    --reuse) REUSE=1; shift ;;
    --bin) need_arg "$1" "$@"; BIN="$2"; shift 2 ;;
    --tmux-bin) need_arg "$1" "$@"; TMUX_BIN="$2"; shift 2 ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

if [ "$CMD" = "down" ]; then
  [ -n "$SESSION" ] || die "down 需要 --session NAME"
  if [ -z "$STATE_ROOT" ]; then
    STATE_ROOT="$HOME/.synapse-agent/fleet/$SESSION"
  fi
  if [ -d "$STATE_ROOT" ]; then
    shopt -s nullglob
    for pidfile in "$STATE_ROOT"/*/run.pid; do
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        info "停止 $(basename "$(dirname "$pidfile")") pid=$pid"
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    done
    shopt -u nullglob
  fi
  if [ "$KEEP_SESSION" -eq 0 ]; then
    if "$TMUX_BIN" has-session -t "=$SESSION" 2>/dev/null; then
      "$TMUX_BIN" kill-session -t "=$SESSION" && ok "已关闭 tmux session $SESSION" || warn "关闭 session 失败"
    else
      warn "tmux session 不存在：$SESSION"
    fi
  else
    ok "保留 tmux session $SESSION"
  fi
  exit 0
fi

[ -n "$COMMAND" ] || die "up 需要 --command '<TUI 命令>'"
[ -d "$WORKDIR" ] || die "--workdir 不存在：$WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"
ENDPOINT="${ENDPOINT%/}"
[[ "$ENDPOINT" =~ ^https?://[^[:space:]]+$ ]] || die "--endpoint 非法：$ENDPOINT"
[[ "$PROJECT" =~ ^[a-z0-9-]{2,40}$ ]] || die "--project 只允许小写字母、数字、短横线（2-40）：$PROJECT"
[[ "$COMMAND" != *$'\n'* ]] || die "--command 不支持多行；请用一行命令"
[[ "$COUNT" =~ ^[0-9]+$ ]] || die "--count 必须是非负整数"
[[ "$TMUX_VERIFY" == "0" || "$TMUX_VERIFY" == "1" ]] || die "--tmux-verify 只能是 0 或 1"
[[ "$STARTUP_WAIT" =~ ^[0-9]+$ ]] || die "--startup-wait 必须是非负整数"
[[ "$BOOTSTRAP_DELAY" =~ ^[0-9]+$ ]] || die "--bootstrap-delay 必须是非负整数"
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || die "--ready-timeout 必须是非负整数"
[[ "$TOKEN_TTL_DAYS" =~ ^[0-9]+$ ]] || die "--token-ttl-days 必须是非负整数"
[ "$LAYOUT" = "windows" ] || [ "$LAYOUT" = "panes" ] || die "--layout 只能是 windows 或 panes"

if [ -z "$SESSION" ]; then
  SESSION="synapse-fleet-$(date +%Y%m%d-%H%M%S)"
fi
[[ "$SESSION" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || die "--session 只允许字母、数字、点、下划线、短横线"
if [ -z "$STATE_ROOT" ]; then
  STATE_ROOT="$HOME/.synapse-agent/fleet/$SESSION"
fi
mkdir -p "$STATE_ROOT"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd)"
[ "$STATE_ROOT" != "$HOME/.synapse-agent" ] || die "state-root 不能直接用 ~/.synapse-agent；每个 agent 必须放独立子目录"
command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ] || die "找不到 synapse-agent 二进制：$BIN（用 --bin 指定）"
command -v "$TMUX_BIN" >/dev/null 2>&1 || [ -x "$TMUX_BIN" ] || die "找不到 tmux：$TMUX_BIN"
command -v curl >/dev/null 2>&1 || true
if [ "$REUSE" -eq 1 ] && ! command -v python3 >/dev/null 2>&1; then
  die "--reuse 需要 python3 读取已有 config.json"
fi
if [ "$REUSE" -eq 1 ] && [ "$ISSUE_TOKENS" -eq 1 ]; then
  die "--reuse 与 --issue-tokens 不能同时使用"
fi

if "$TMUX_BIN" has-session -t "=$SESSION" 2>/dev/null; then
  die "tmux session 已存在：$SESSION；换一个 --session 或先执行 down"
fi

declare -a AGENT_IDS=()
declare -a FILE_IDS=()
declare -a FILE_TOKENS=()
declare -A TOKENS_BY_ID=()
FILE_HAS_IDS=0
FILE_HAS_PLAIN=0

if [ -n "$TOKENS_FILE" ]; then
  [ -r "$TOKENS_FILE" ] || die "tokens 文件不可读：$TOKENS_FILE"
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="$(trim "$raw")"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    if [[ "$line" == *=* ]]; then
      id="$(trim "${line%%=*}")"
      token="$(trim "${line#*=}")"
      [ -n "$id" ] && [ -n "$token" ] || die "tokens 行格式错误（避免回显 token）"
      FILE_HAS_IDS=1
    elif [[ "$line" == *$'\t'* ]]; then
      id="$(trim "${line%%$'\t'*}")"
      token="$(trim "${line#*$'\t'}")"
      [ -n "$id" ] && [ -n "$token" ] || die "tokens 行格式错误（避免回显 token）"
      FILE_HAS_IDS=1
    elif [[ "$line" == *[[:space:]]* ]]; then
      id="$(trim "${line%%[[:space:]]*}")"
      token="$(trim "${line#*[[:space:]]}")"
      [ -n "$id" ] && [ -n "$token" ] || die "tokens 行格式错误（避免回显 token）"
      FILE_HAS_IDS=1
    else
      id=""
      token="$line"
      FILE_HAS_PLAIN=1
    fi
    FILE_IDS+=("$id")
    FILE_TOKENS+=("$token")
  done < "$TOKENS_FILE"
  [ "$FILE_HAS_IDS" -eq 0 ] || [ "$FILE_HAS_PLAIN" -eq 0 ] || die "tokens 文件不能混用 id=token 和纯 token"
  [ "${#FILE_TOKENS[@]}" -gt 0 ] || die "tokens 文件为空"
fi

if [ -n "$AGENT_IDS_CSV" ]; then
  IFS=',' read -r -a AGENT_IDS <<< "$AGENT_IDS_CSV"
  for i in "${!AGENT_IDS[@]}"; do AGENT_IDS[$i]="$(trim "${AGENT_IDS[$i]}")"; done
fi

# --reuse 未显式给 ID 时，直接从原 state-root 的 config.json 目录发现 agent。
if [ "$REUSE" -eq 1 ] && [ "${#AGENT_IDS[@]}" -eq 0 ] && [ "$FILE_HAS_IDS" -eq 0 ]; then
  shopt -s nullglob
  for cfg in "$STATE_ROOT"/*/config.json; do
    id="$(basename "$(dirname "$cfg")")"
    [[ "$id" =~ ^[A-Za-z0-9._-]{2,40}$ ]] || die "状态目录里有非法 agent-id：$id"
    AGENT_IDS+=("$id")
  done
  shopt -u nullglob
  [ "${#AGENT_IDS[@]}" -gt 0 ] || die "--reuse 在 $STATE_ROOT 下没有找到 */config.json"
fi

if [ "${#AGENT_IDS[@]}" -eq 0 ] && [ "$FILE_HAS_IDS" -eq 1 ]; then
  AGENT_IDS=("${FILE_IDS[@]}")
fi
if [ "${#AGENT_IDS[@]}" -eq 0 ]; then
  [ "$COUNT" -gt 0 ] || die "需要 --count N 或 --agent-ids（tokens 文件带 id 时可省略）"
fi
if [ "${#AGENT_IDS[@]}" -eq 0 ]; then
  for ((i=1; i<=COUNT; i++)); do AGENT_IDS+=("${AGENT_PREFIX}-${i}"); done
fi
if [ "$COUNT" -eq 0 ]; then COUNT="${#AGENT_IDS[@]}"; fi
[ "$COUNT" -eq "${#AGENT_IDS[@]}" ] || die "--count=$COUNT 与 agent 数量 ${#AGENT_IDS[@]} 不一致"
[ "$COUNT" -ge 1 ] && [ "$COUNT" -le 50 ] || die "agent 数量必须在 1-50"
for id in "${AGENT_IDS[@]}"; do
  [[ "$id" =~ ^[A-Za-z0-9._-]{2,40}$ ]] || die "非法 agent-id：$id"
done
# 重复 ID 拒绝
for id in "${AGENT_IDS[@]}"; do
  n=0
  for x in "${AGENT_IDS[@]}"; do [ "$x" = "$id" ] && n=$((n+1)); done
  [ "$n" -eq 1 ] || die "agent-id 重复：$id"
done

# 校验 tokens 文件与 agent 列表
if [ -n "$TOKENS_FILE" ]; then
  if [ "$FILE_HAS_IDS" -eq 1 ]; then
    [ "${#FILE_IDS[@]}" -eq "$COUNT" ] || die "tokens 文件条数与 agent 数量不一致"
    for idx in "${!AGENT_IDS[@]}"; do
      [ "${FILE_IDS[$idx]}" = "${AGENT_IDS[$idx]}" ] || die "tokens 文件 agent 顺序不匹配：期望 ${AGENT_IDS[$idx]}，实际 ${FILE_IDS[$idx]}"
    done
  else
    [ "${#FILE_TOKENS[@]}" -eq "$COUNT" ] || die "tokens 文件条数与 agent 数量不一致"
  fi
fi
if [ -n "$ONE_TOKEN" ] && [ -n "$TOKENS_FILE" ]; then die "--token 与 --tokens-file 不能同时使用"; fi
if [ -n "$ONE_TOKEN" ] && [ "$COUNT" -ne 1 ]; then die "--token 只适用于 count=1"; fi
if [ -z "$TOKENS_FILE" ] && [ -z "$ONE_TOKEN" ] && [ "$ISSUE_TOKENS" -eq 0 ]; then
  if [ "$REUSE" -eq 0 ]; then
    die "缺少 token：用 --tokens-file、--token（count=1），或 --issue-tokens；已有配置可用 --reuse"
  fi
fi

# 组装 token
if [ -n "$TOKENS_FILE" ]; then
  if [ "$FILE_HAS_IDS" -eq 1 ]; then
    for idx in "${!AGENT_IDS[@]}"; do TOKENS_BY_ID["${AGENT_IDS[$idx]}"]="${FILE_TOKENS[$idx]}"; done
  else
    for idx in "${!AGENT_IDS[@]}"; do TOKENS_BY_ID["${AGENT_IDS[$idx]}"]="${FILE_TOKENS[$idx]}"; done
  fi
elif [ -n "$ONE_TOKEN" ]; then
  TOKENS_BY_ID["${AGENT_IDS[0]}"]="$ONE_TOKEN"
fi

issue_token() {
  local id="$1" body hdr resp token
  body="$(printf '{"project":"%s","agent_id":"%s","role":"agent","ttl_days":%s}' "$PROJECT" "$id" "$TOKEN_TTL_DAYS")"
  hdr="$(mktemp "${TMPDIR:-/tmp}/synapse-admin-hdr.XXXXXX")"
  printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$hdr"
  if ! resp="$(curl -fsS --config "$hdr" -X POST "$ENDPOINT/x/admin/agents" \
      -H 'content-type: application/json' --data "$body" 2>/dev/null)"; then
    rm -f "$hdr"
    die "签发 token 失败：agent=$id（检查 admin token、项目配额、网络）"
  fi
  rm -f "$hdr"
  token="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
  [ -n "$token" ] || die "签发 token 返回中没有 token：agent=$id"
  printf '%s' "$token"
}

if [ "$ISSUE_TOKENS" -eq 1 ] && [ -z "$TOKENS_FILE" ] && [ -z "$ONE_TOKEN" ]; then
  command -v python3 >/dev/null 2>&1 || die "--issue-tokens 需要 python3 解析返回 JSON"
  if [ -n "$ADMIN_TOKEN_FILE" ]; then
    [ -r "$ADMIN_TOKEN_FILE" ] || die "admin token 文件不可读：$ADMIN_TOKEN_FILE"
    ADMIN_TOKEN="$(trim "$(cat "$ADMIN_TOKEN_FILE")")"
  else
    ADMIN_TOKEN="${SYNAPSE_ADMIN_TOKEN:-${HUB_ADMIN_TOKEN:-}}"
  fi
  [ -n "$ADMIN_TOKEN" ] || die "--issue-tokens 需要 --admin-token-file 或 SYNAPSE_ADMIN_TOKEN/HUB_ADMIN_TOKEN"
  for id in "${AGENT_IDS[@]}"; do
    info "签发 token：$id"
    TOKENS_BY_ID["$id"]="$(issue_token "$id")"
  done
fi

declare -a DIRS=()
declare -a PANES=()
declare -a RUN_PIDS=()
mkdir -p "$STATE_ROOT/logs"

# 1) 每个 agent 独立 init（先于 run/TUI，保证状态目录和 SKILL.md 就绪）
for id in "${AGENT_IDS[@]}"; do
  dir="$STATE_ROOT/$id"
  if [ "$REUSE" -eq 1 ]; then
    [ -s "$dir/config.json" ] || die "--reuse 找不到配置：$dir/config.json；先用普通 up 初始化"
    cfg_agent="$(cfg_value "$dir/config.json" agent_id)" || die "无法解析 config.json：$dir"
    cfg_endpoint="$(cfg_value "$dir/config.json" endpoint)" || die "无法解析 config.json：$dir"
    cfg_project="$(cfg_value "$dir/config.json" project)" || die "无法解析 config.json：$dir"
    cfg_endpoint="${cfg_endpoint%/}"
    [ "$cfg_agent" = "$id" ] || die "config.json 里的 agent_id 不是 $id：$dir（实际 $cfg_agent）"
    [ "$cfg_endpoint" = "$ENDPOINT" ] || die "已有配置 endpoint 不一致：$dir（配置 $cfg_endpoint；如需沿用请加 --endpoint $cfg_endpoint）"
    [ "$cfg_project" = "$PROJECT" ] || die "已有配置 project 不一致：$dir（配置 $cfg_project；如需沿用请加 --project $cfg_project）"
    [ "$(cfg_has_token "$dir/config.json")" = "1" ] || die "已有配置里没有 token，不能 --reuse：$dir"
    if [ -f "$dir/run.pid" ]; then
      old_pid="$(cat "$dir/run.pid" 2>/dev/null || true)"
      if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        die "agent $id 的 run 仍在运行（pid=$old_pid）；先执行 down 或停止该进程"
      fi
      rm -f "$dir/run.pid"
    fi
    DIRS+=("$dir")
    ok "reuse $id -> $dir"
    continue
  fi
  if [ -e "$dir/config.json" ]; then
    die "状态目录已有配置：$dir；down 后重启请加 --reuse，或换 --session/--state-root"
  fi
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  initlog="$STATE_ROOT/logs/$id.init.log"
  if ! "$BIN" init --config-dir "$dir" --endpoint "$ENDPOINT" --project "$PROJECT" \
      --agent "$id" --token "${TOKENS_BY_ID[$id]}" >"$initlog" 2>&1; then
    cat "$initlog" >&2 || true
    die "init 失败：$id"
  fi
  [ -s "$dir/config.json" ] || die "init 未生成 config.json：$dir"
  # 旧客户端不会自己写 skill 缓存；服务端 /skill、/capabilities 是公开只读，给一个兜底。
  if [ ! -s "$dir/SKILL.md" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS "$ENDPOINT/skill" -o "$dir/SKILL.md" 2>/dev/null || warn "拉取 /skill 失败：$id"
  fi
  if [ ! -s "$dir/capabilities.json" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS "$ENDPOINT/capabilities" -o "$dir/capabilities.json" 2>/dev/null || warn "拉取 /capabilities 失败：$id"
  fi
  DIRS+=("$dir")
  ok "init $id -> $dir"
done

# 2) 创建 tmux session / pane
create_tmux() {
  local i pane first_window win last
  if [ "$LAYOUT" = "windows" ]; then
    first_window="agent-1"
    "$TMUX_BIN" new-session -d -s "$SESSION" -n "$first_window" -c "$WORKDIR"
    "$TMUX_BIN" set-option -t "=$SESSION" history-limit 5000 >/dev/null 2>&1 || true
    for ((i=0; i<COUNT; i++)); do
      if [ "$i" -eq 0 ]; then
        pane="$("$TMUX_BIN" list-panes -t "$SESSION:$first_window" -F '#{pane_id}' | head -n1 | tr -d '\r')"
      else
        win="agent-$((i+1))"
        pane="$("$TMUX_BIN" new-window -d -P -F '#{pane_id}' -t "$SESSION" -n "$win" -c "$WORKDIR")"
      fi
      [ -n "$pane" ] || die "创建 tmux pane 失败：index=$((i+1))"
      PANES+=("$pane")
    done
  else
    first_window="agents"
    "$TMUX_BIN" new-session -d -s "$SESSION" -n "$first_window" -c "$WORKDIR"
    "$TMUX_BIN" set-option -t "=$SESSION" history-limit 5000 >/dev/null 2>&1 || true
    last="$("$TMUX_BIN" list-panes -t "$SESSION:$first_window" -F '#{pane_id}' | head -n1 | tr -d '\r')"
    PANES+=("$last")
    for ((i=1; i<COUNT; i++)); do
      pane="$("$TMUX_BIN" split-window -d -P -F '#{pane_id}' -t "$last" -c "$WORKDIR")"
      [ -n "$pane" ] || die "split tmux pane 失败：index=$((i+1))"
      PANES+=("$pane")
      last="$pane"
    done
    "$TMUX_BIN" select-layout -t "$SESSION:$first_window" tiled >/dev/null 2>&1 || true
  fi
}
create_tmux
ok "tmux session=$SESSION layout=$LAYOUT panes=$COUNT"

# 3) 每个 agent 绑定自己的 pane
for idx in "${!AGENT_IDS[@]}"; do
  id="${AGENT_IDS[$idx]}"
  dir="${DIRS[$idx]}"
  pane="${PANES[$idx]}"
  pane_check="$("$TMUX_BIN" display-message -p -t "$pane" '#{pane_id}' 2>/dev/null | tr -d '\r' || true)"
  [ "$pane_check" = "$pane" ] || die "pane 无效：$pane（agent=$id）"
  if ! "$BIN" tmux-config --config-dir "$dir" --target "$pane" >"$STATE_ROOT/logs/$id.tmux-config.log" 2>&1; then
    cat "$STATE_ROOT/logs/$id.tmux-config.log" >&2 || true
    die "tmux-config 失败：$id"
  fi
  # tmux-config --verify 是独立分支，必须在 --target 之后单独调用。
  if ! "$BIN" tmux-config --config-dir "$dir" --verify "$TMUX_VERIFY" >>"$STATE_ROOT/logs/$id.tmux-config.log" 2>&1; then
    cat "$STATE_ROOT/logs/$id.tmux-config.log" >&2 || true
    die "tmux-config --verify 失败：$id"
  fi
  ok "tmux-config $id -> $pane (verify=$TMUX_VERIFY)"
done

# 4) 在 pane 里启动指定 TUI 命令，并把 agent 身份通过环境变量交给它
start_tui() {
  local idx id dir pane env_prefix
  for idx in "${!AGENT_IDS[@]}"; do
    id="${AGENT_IDS[$idx]}"; dir="${DIRS[$idx]}"; pane="${PANES[$idx]}"
    env_prefix="export SYNAPSE_AGENT_ID=$(shellq "$id") SYNAPSE_AGENT_DIR=$(shellq "$dir") SYNAPSE_AGENT_PROJECT=$(shellq "$PROJECT") SYNAPSE_AGENT_PANE=$(shellq "$pane") SYNAPSE_SKILL_PATH=$(shellq "$dir/SKILL.md") SYNAPSE_CAPABILITIES_PATH=$(shellq "$dir/capabilities.json")"
    "$TMUX_BIN" set-option -w -t "$pane" remain-on-exit on >/dev/null 2>&1 || true
    "$TMUX_BIN" send-keys -t "$pane" -l -- "$env_prefix; $COMMAND"
    "$TMUX_BIN" send-keys -t "$pane" Enter
    info "启动 TUI $id：$COMMAND"
  done
}
start_tui

# 5) 等 TUI ready；没有 regex 就固定等待
wait_one_tui() {
  local pane="$1" deadline out
  if [ -z "$READY_REGEX" ]; then
    [ "$STARTUP_WAIT" -eq 0 ] || sleep "$STARTUP_WAIT"
    return 0
  fi
  deadline=$((SECONDS + READY_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    out="$("$TMUX_BIN" capture-pane -p -J -t "$pane" 2>/dev/null || true)"
    if printf '%s' "$out" | grep -Eq "$READY_REGEX"; then return 0; fi
    sleep 0.3
  done
  return 1
}
for idx in "${!PANES[@]}"; do
  pane="${PANES[$idx]}"
  if ! wait_one_tui "$pane"; then
    die "TUI 未在 ${READY_TIMEOUT}s 内匹配 ready-regex：pane=$pane；session 保留，可手动 attach 排查"
  fi
done
ok "TUI ready（startup-wait=${STARTUP_WAIT}s）"

# 等 TUI 真正可输入后再投第一条消息；--ready-regex 命中也可能只是界面画出来了。
if { [ "$BOOTSTRAP" -eq 1 ] || [ "$START_RUN" -eq 1 ]; } && [ "$BOOTSTRAP_DELAY" -gt 0 ]; then
  info "等待 ${BOOTSTRAP_DELAY}s 再发送第一条消息"
  sleep "$BOOTSTRAP_DELAY"
fi

# 6) 投递 bootstrap：先让 agent 知道自己的 ID 和 skill 位置，再启动 run。
bootstrap_for() {
  local id="$1" dir="$2"
  if [ -n "$BOOTSTRAP_TEXT" ]; then printf '%s' "$BOOTSTRAP_TEXT"; return; fi
  if [ "$START_RUN" -eq 1 ]; then
    cat <<EOF
[Synapse 启动] agent-id=$id；project=$PROJECT；状态目录=$dir。
后台 synapse-agent run 将在本说明后启动；不要自己再起 run/wait，消息会由 run 注入本窗口。
第一步：先读 $dir/SKILL.md（服务端能力说明书），再读 $dir/capabilities.json，按 capability ID 核对能力；不要只看 --help 判断服务端能力。
你是 $id，只处理发给 $id 的任务；收到 [task:<task_id>] 时记住 task_id，交付时用 --task <task_id>。
EOF
  else
    cat <<EOF
[Synapse 启动] agent-id=$id；project=$PROJECT；状态目录=$dir。
本次没有启动后台 run。先读 $dir/SKILL.md 和 $dir/capabilities.json，按 capability ID 核对能力；不要只看 --help。
你是 $id，只处理发给 $id 的任务；按你的回合制模式用 synapse-agent wait --config-dir $dir 接任务。
EOF
  fi
}
if [ "$BOOTSTRAP" -eq 1 ]; then
  for idx in "${!AGENT_IDS[@]}"; do
    id="${AGENT_IDS[$idx]}"; dir="${DIRS[$idx]}"; pane="${PANES[$idx]}"
    text="$(bootstrap_for "$id" "$dir")"
    if ! "$BIN" tmux-send --config-dir "$dir" --target "$pane" --text "$text" --enter 1 --verify 0 \
        >"$STATE_ROOT/logs/$id.bootstrap.log" 2>&1; then
      cat "$STATE_ROOT/logs/$id.bootstrap.log" >&2 || true
      die "bootstrap 投递失败：$id（session 保留，可手动 attach）"
    fi
    ok "bootstrap -> $id ($pane)"
  done
fi

# 7) 启动每个 agent 的常驻 run（bootstrap 之后，避免任务先于身份说明到达）
if [ "$START_RUN" -eq 1 ]; then
  for idx in "${!AGENT_IDS[@]}"; do
    id="${AGENT_IDS[$idx]}"; dir="${DIRS[$idx]}"
    runlog="$STATE_ROOT/logs/$id.run.log"
    nohup "$BIN" run --config-dir "$dir" >>"$runlog" 2>&1 &
    pid=$!
    printf '%s\n' "$pid" > "$dir/run.pid"
    RUN_PIDS+=("$pid")
    sleep 0.2
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 20 "$runlog" >&2 || true
      die "run 启动即退出：$id（查看 $runlog）"
    fi
    ok "run $id pid=$pid log=$runlog"
  done
fi

# 8) 汇总
printf '\n%-14s %-10s %-42s %s\n' "AGENT" "PANE" "CONFIG" "RUN PID"
for idx in "${!AGENT_IDS[@]}"; do
  pid="-"
  if [ -f "${DIRS[$idx]}/run.pid" ]; then pid="$(cat "${DIRS[$idx]}/run.pid")"; fi
  printf '%-14s %-10s %-42s %s\n' "${AGENT_IDS[$idx]}" "${PANES[$idx]}" "${DIRS[$idx]}" "$pid"
done
printf '\n查看: %s attach -t %s\n' "$TMUX_BIN" "$SESSION"
printf '停止: %s down --session %s --state-root %s\n' "$0" "$SESSION" "$STATE_ROOT"

if [ "$ATTACH" -eq 1 ]; then
  if [ -n "${TMUX:-}" ]; then
    exec "$TMUX_BIN" switch-client -t "=$SESSION"
  else
    exec "$TMUX_BIN" attach -t "=$SESSION"
  fi
fi
