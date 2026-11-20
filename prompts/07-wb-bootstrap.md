# 07 · WorkBuddy 沙箱 Agent 自助接入（bootstrap）

> 你是运行在 **WorkBuddy/CodeBuddy 沙箱**里的回合制 LLM agent。目标：自己生成 token、
> 自助注册、安装客户端、等管理员批准，然后进入「收件 / 回执 / 回复 / 上报 / 交付」循环。
>
> 这份提示词**自包含**，不需要读仓库其它文档。但在接入前请确认你的环境仍满足
> `docs/环境接入-回合制沙箱Agent.md` 里列出的三条硬约束（无 systemd、回合制、进程跨轮不保活）。
>
> 与通用版 `06-bootstrap-client.md` 的差异：**所有状态落 `/workspace` 持久区；不依赖 systemd/nohup 常驻；
> 用 wait 等待链代替 run+日志；等待批准改为回合内有限等待。**

不要向我要 token，不要 echo / 打印 / 写入日志 / 上传 token 明文。

## 参数

```
ENDPOINT=https://synapse.wangda.today
PROJECT=<项目 slug>          # 例如 yeban
AGENT_ID=<你的 agent id>     # 例如 doubao-dev-001
STATE=/workspace/.synapse-state   # 持久区状态目录（关键！见下）
```

### 为什么用 STATE 覆盖 HOME

沙箱根分区是持久 overlay，但 `~/.synapse-agent` 在 `/root` 下，某些沙箱重建场景会丢。
**统一用 `STATE` 作为 HOME 的隔离目录**，让 `~/.synapse-agent` 实际落到
`/workspace/.synapse-state/.synapse-agent/`，配置、游标、epoch 全部持久保留。
后续所有客户端命令都带 `HOME="$STATE"` 前缀；多实例各用不同 STATE，绝不共用同一份 config.json。

---

## 阶段 1：本地生成 token

```bash
mkdir -p "$STATE/.synapse-agent"
umask 077
TOKEN="$(openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(32))')"
printf '%s' "$TOKEN" > "$STATE/.synapse-agent/enrollment.token"
chmod 600 "$STATE/.synapse-agent/enrollment.token"
TOKEN_SHA="$(printf '%s' "$TOKEN" | sha256sum | awk '{print $1}')"
# TOKEN_SHA 用于阶段 3 上报；TOKEN 明文不得出现在任何日志/消息/交付物
```

## 阶段 2：安装客户端（不依赖 systemd）

沙箱 **PID 1 是 supervisord，不是 systemd**。最新版 install.sh 已能自动检测并走 nohup 分支
（提交 `4faa99b`），所以直接跑官方安装即可：

```bash
HOME="$STATE" sh -c '
  curl -fsSL "$0/dl/install.sh" | sh -s -- \
    --endpoint "$0" --project "$1" --token "$2" --agent "$3"
' "$ENDPOINT" "$PROJECT" "$TOKEN" "$AGENT_ID"
```

安装脚本会：下载静态 musl 二进制 → 校验 sha256 → init 写配置(600) →
检测无 systemd → **用 nohup 后台起 `run`**。

**重要认知**：这个 nohup 进程在本沙箱**活不过当前回合**——回合结束或沙箱休眠后会被回收。
所以安装只为「拿到二进制和配置」，**不要把它当作长期常驻**。阶段 6 会改用 wait 等待链。

未批准时 `run` 会 401 并自动重试，这是正常现象，**不要反复重装**。

## 阶段 3：提交自助注册

接口读的字段是 `token_sha`（不是 token），不要发错。

```bash
BODY="$(python3 - "$PROJECT" "$AGENT_ID" "$TOKEN_SHA" "$(hostname)" <<'PY'
import json, sys
project, agent_id, token_sha, machine = sys.argv[1:5]
print(json.dumps({
    "project": project, "agent_id": agent_id, "token_sha": token_sha,
    "scopes": ["heartbeat","poll","publish","report","ack",
               "submissions.create","artifact.write","artifact.read"],
    "machine": machine
}))
PY
)"

RESP="$(curl -fsS -X POST "$ENDPOINT/p/enroll" \
  -H 'content-type: application/json' --data "$BODY")"

ENROLLMENT_ID="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
ENROLLMENT_CODE="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')"
```

把 `ENROLLMENT_ID`、`PROJECT`、`AGENT_ID` 报告给用户，**不要报告 TOKEN**，让管理员在控制台「待审注册」批准。

## 阶段 4：等待批准（回合内有限等待）

通用版用 `while :; do sleep 5; done` 无限等——在回合制沙箱里这会卡死整个回合。
**改成有限次轮询**：每次检查把状态写到持久区，回合结束前返回；下一轮从文件续上。

```bash
STATUS_FILE="$STATE/.synapse-agent/enrollment.status"
[ -f "$STATUS_FILE" ] || printf 'pending\n' > "$STATUS_FILE"

check_once() {
  R="$(curl -fsS "$ENDPOINT/p/enroll/$ENROLLMENT_ID?code=$ENROLLMENT_CODE" 2>/dev/null)" || return 0
  S="$(printf '%s' "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)" || return 0
  printf '%s\n' "$S" > "$STATUS_FILE"
  case "$S" in
    approved) return 1 ;;                 # 用返回码 1 表示「批准了」
    rejected|expired) echo "注册状态：$S"; exit 1 ;;
    *) return 0 ;;
  esac
}

# 本回合内最多查 N 次（例 20 次 × 5s = 100s），不阻塞整个回合
for i in $(seq 1 20); do
  check_once || break
  sleep 5
done
echo "当前注册状态: $(cat "$STATUS_FILE")（未批准则本轮结束，下轮继续查）"
```

每回合开头先读 `enrollment.status`，是 `approved` 就直接进阶段 5；否则再查一轮。

## 阶段 5：批准后确认连接

回合制沙箱**没有 systemd 服务可重启**（阶段 2 的 nohup 进程可能已被回收），
所以不执行 `systemctl restart`，而是直接用一次性命令确认：

```bash
HOME="$STATE" "$STATE/.local/bin/synapse-agent" status
curl -fsS "$ENDPOINT/p/$PROJECT/wsstat" -H "Authorization: Bearer $TOKEN" \
  || echo "wsstat 暂不可达（回合制下属正常）"
```

> 注意：install.sh 把二进制装到 `$HOME/.local/bin/`，我们设了 `HOME=$STATE`，
> 所以实际路径是 `$STATE/.local/bin/synapse-agent`。若安装时没带 HOME 覆盖，请按实际路径调整。

不要打印 config.json。

## 阶段 6：进入收件 / 回执 / 回复 / 上报 / 交付循环

先分清三件事：
- `wait` 自动 ack 只代表「收到」，**不是回复正文**；
- 回复管理端、汇报任务/结果/资源，用 `POST /p/$PROJECT/report`；
- `send` / `broadcast` 是 admin 接口，普通 agent 会 403，**不要用**。

读取本机配置（不打印 token）：

```bash
CFG="$STATE/.synapse-agent/config.json"
get_cfg() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CFG" | head -1 | cut -d'"' -f4
}
ENDPOINT=$(get_cfg endpoint)
PROJECT=$(get_cfg project)
TOKEN=$(get_cfg token)
AGENT_ID=$(get_cfg agent_id)
BIN="$STATE/.local/bin/synapse-agent"
[ -n "$ENDPOINT" ] && [ -n "$PROJECT" ] && [ -n "$TOKEN" ] || { echo "配置读取失败" >&2; exit 2; }
```

定义回复函数（第一个参数原消息 `seq`，第二个正文，第三个可选 `task_id`）：

```bash
hub_reply() {
  seq="$1"; body="$2"; task_id="${3:-}"
  report_id="reply-$seq-$AGENT_ID"
  tmp="$(mktemp)"
  python3 - "$report_id" "$seq" "$body" "$task_id" > "$tmp" <<'PY'
import json, sys
report_id, seq, body, task_id = sys.argv[1:5]
task = {"reply_to": int(seq), "state": "done", "body": body}
if task_id: task["task_id"] = task_id
print(json.dumps({"report_id": report_id, "task": task, "resources": {}}, ensure_ascii=False))
PY
  curl -fsS -X POST "$ENDPOINT/p/$PROJECT/report" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$tmp"
  rm -f "$tmp"
}
```

### 收件：用 wait 等待链（本环境核心模式）

**不要依赖阶段 2 的 nohup `run` 常驻**：它跨轮不保活，且回合制没有常驻事件循环去读日志。
正确做法是把 `wait` 挂到宿主的「后台任务 + 阻塞等待」能力上：

```bash
# 每轮：挂一个后台 wait（YANSHI_WAIT 超时退出码 3 = 没消息）
YANSHI_WAIT=30 HOME="$STATE" "$BIN" wait > "$STATE/wait.out" 2>&1 &
WAIT_PID=$!
# 宿主侧：用「阻塞等待后台任务」能力等 WAIT_PID，到点/收到消息即返回
# - 收到消息：wait 打印一条 JSON 并自动 ack（仅 ack_required=true）
# - 退出码 3：本轮无消息，回合可结束
```

拿到消息后：

```bash
MSG="$(cat "$STATE/wait.out")"
SEQ="$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("seq",""))' 2>/dev/null)"
[ -z "$SEQ" ] && exit 0
# 执行任务 ...
hub_reply "$SEQ" "已完成，结果见交付 sub-xxxx"
# 回合结束前必须再挂一次 wait（保住唤醒链，见 WAKE-LOOPS.md）
```

### 交付：一条命令到位（本环境推荐）

Rust 版已补齐 upload/submit/deliver，无需 Python 补位：

```bash
HOME="$STATE" "$BIN" deliver --file out/result.patch \
  --kind patch --title "<标题>" --base-sha <7-64位hex> \
  --checks '{"built":true}'
# → {"ok":true,"sha256":"...","submission_id":"...","state":"delivered"}
```

- `base_sha` 必须 7-64 位小写 hex；非 git 环境显式 `--base-sha`；
- `--checks` 是 JSON 字符串，zsh 里引用变量拼值用 `${VAR}` 花括号（避免 `$VAR:suffix` 被错误展开）；
- 多文件：先逐个 `upload`，再 `submit` 用多个 `--ref`。

## 阶段 7：处理纪律

- 严格按 `seq` 顺序，不跳过积压；`wait` 内部已对 `ack_required=true` 自动 ack。
- 回复必须带 `reply_to`（原 seq）或 `task_id`，用 `hub_reply` 固化该字段。
- `ack` 的 `detail` 不是正文，结果只写 report/交付，不要只写在 ack 里。
- 自己发的广播会被回声过滤，别写「收到就回复自己」的循环。
- 长任务保持心跳，避免 120 秒租约被回收。
- 不把 token 写进日志、payload 或交付物。
- 产物先 upload 再 submission；`base_sha` 必须合法 hex。
- **回合结束前务必再挂一次 wait**，否则下一轮没人收（本平台实测硬约束）。
- 连接断开不要重建配置，等待自动重连。

## 汇报格式

```
enrollment_id: <ID>
status: approved
project: <PROJECT>
agent_id: <AGENT_ID>
state_dir: /workspace/.synapse-state
transport: poll（回合制等待链）
last_seq: <数字>
reply: report（已启用 hub_reply）
delivered: <submission_id 或 无>
wait_rearmed: true
```
