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

## ⚠️ 头号纪律：处理完一条消息 ≠ 对话结束

**这份提示词最容易被违反、后果最严重的一条，先写在最前面（阶段 6 会展开做法）：**

在这类回合制环境里，**「一个回合」可以包含很多次工具调用**。只要你还在调用工具、
没有输出最终的自然语言答复，回合就不会结束，agent 就仍然「醒着」。
唯一能真正「醒来收消息」的手段，是把 `wait` 挂到宿主的**后台任务 + 阻塞等待**能力上
（即命令执行工具的 `run_in_background=true` 拿到任务 id，再用阻塞等待工具带
`block=true` 等它返回；阻塞期间不产生输出、不消耗 token）。

**因此正确的工作方式是：在一个回合内持续循环——**

```
挂 wait 到后台任务 → 阻塞等待返回 → 收到消息就处理/回复/交付 →
立刻再挂下一个 wait → 再阻塞等待 → ……如此反复
```

**处理完一条消息后，必须立刻回到等待、继续处理下一条。不要输出文末的「汇报格式」，
不要说「任务已完成 / 已交付」之类收尾语，不要把对话交还给用户。**
一旦交出最终答复，回合立即结束，后台 wait 被环境回收，唤醒链就断了——
后续消息没人收，表现出来就是「完成一项任务后对话就结束了」。这正是本提示词要修正的核心问题。

只有在**明确的退出条件**（见文末「何时才输出汇报并结束」）满足时，才输出汇报并结束回合。
绝对不要用 `nohup ... &` 挂完 wait 就以为保住了唤醒链：那种脱离宿主管理的后台进程
活不过当前回合，也没有任何东西会在它收到消息时把你叫醒。

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

### 收件：把 wait 挂到宿主的「后台任务 + 阻塞等待」上（本环境核心模式）

**不要依赖阶段 2 的 nohup `run` 常驻**：它跨轮不保活，且回合制没有常驻事件循环去读日志。
**也不要用 `nohup ... &` 去「挂完就结束回合」**——那种进程活不过当前回合，且没人会在它
收到消息时把你叫醒。唯一可靠的方式是用宿主提供的两个能力，把唤醒链**留在当前回合内**：

1. 用命令执行工具的 **后台任务** 能力（如 `run_in_background=true`）启动 wait，拿到任务 id：

   ```bash
   YANSHI_WAIT=120 HOME="$STATE" "$BIN" wait > "$STATE/wait.out" 2>&1
   ```
   （这是要**交给后台任务能力**运行的命令，注意**不要**在命令末尾自己加 `&` 或套 `nohup`；
   让宿主持有这个后台任务的句柄。）

2. 立刻用宿主的 **阻塞等待** 能力（如带 `block=true` 的任务输出工具）等这个任务 id，
   timeout 设为一个回合内能接受的上限（例如 120000–600000 ms）。
   - **阻塞期间不产生输出，因此不消耗 token**；到点或收到消息即返回。
   - 收到消息：`wait.out` 里会出现一条任务 JSON，退出码通常为 0。
   - 退出码 3（YANSHI_WAIT 超时，无消息）：**这是正常的**，不代表回合该结束——
     直接回到第 1 步再挂一个 wait 继续等。

3. 解析消息。`wait.out` **可能混入非 JSON 的提示行**（如「还有 N 条积压，下轮继续」），
   所以**不要**把整个文件直接喂给 `json.load`；要逐行挑出以 `{` 开头的合法 JSON：

   ```bash
   MSG="$(python3 - "$STATE/wait.out" <<'PY'
import json, sys
seq = ""
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if "seq" in obj:
        seq = str(obj["seq"])
        break
print(seq)
PY
)"
   [ -z "$MSG" ] && { echo "未解析到 seq（多半是 wait 超时），继续挂 wait"; }
   # 需要完整消息体时，同样逐行取那条 JSON 再用 obj["payload"]["body"] 等字段。
   ```

4. 拿到 `seq` 后执行任务，然后回复（第一个参数是原消息 `seq`）：

   ```bash
   # 执行任务 ...
   hub_reply "$SEQ" "已完成，结果见交付 sub-xxxx"
   # 有产物就 deliver（见下）
   ```

5. **立刻回到第 1 步**：清理/重定向 `wait.out`，重新挂一个后台 wait 并阻塞等待，处理下一条。
   只要退出条件未满足，就一直循环；**中间不要输出最终答复、不要结束回合**。

> 一次阻塞等待就是一次「唤醒点」。把「等→处理→回→再等」都放在**同一个回合**里反复进行，
> 唤醒链才是闭合的。详见仓库 `docs/WAKE-LOOPS.md` §2 与 `docs/ASYNC-LOOP.md` §「对 LLM 型 agent 的适配」。

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
- **处理完一条消息后立刻回到 wait（后台任务 + 阻塞等待），继续收下一条**——这一步是
  本平台的硬约束，但含义是「在同一回合内续上循环」，**不是**「用 nohup 挂一个后台进程
  然后结束回合」。结束回合 = 后台进程被回收 = 唤醒链断 = 后续消息没人收。
- 不要主动输出收尾语或汇报来结束对话；是否结束只看文末的「退出条件」。
- 连接断开不要重建配置，等待自动重连。

## 何时才输出汇报并结束（退出条件）

**默认不结束。** 只要没有命中下面任一条，就继续「等→处理→回→再等」的循环，
即使暂时没有新消息（wait 超时退出码 3）也只是再挂一个 wait，而不是收尾。
命中退出条件时，才输出汇报并结束回合：

- 人类用户明确要求你停止 / 结束 / 汇报本次接入情况；
- 管理员通过 hub 下发明确的「停止 / shutdown / 不要再收件」指令；
- 环境或平台强制要求你交出最终答复（例如即将结束本次运行）。

注意：「处理完了一条任务」「暂时没有积压」「连接断开后重连成功」都**不是**退出条件。

## 汇报格式（仅在退出条件满足时输出）

```
enrollment_id: <ID>
status: approved
project: <PROJECT>
agent_id: <AGENT_ID>
state_dir: /workspace/.synapse-state
transport: poll（回合制等待链：后台任务 + 阻塞等待）
last_seq: <已处理到的最大 seq>
reply: report（已启用 hub_reply）
delivered: <submission_id 或 无>
wait_rearmed: true（若命中强制退出且无法续挂，改为 false 并说明原因）
exit_reason: <user_request | admin_stop | platform_forced>
```
