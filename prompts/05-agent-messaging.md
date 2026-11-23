# Agent 消息回复说明（收件 / ack / report / publish）

> 客户端通常看不到仓库文件；实际发给客户端的是自包含的 `03-run-agent-loop.md`。这份是维护者参考的扩展说明。

这份说明解决一个常见问题：**`run` 自动 ack 只表示“收到了”，不等于回复内容。**

网络口径：全节点统一网络口径（先直连，失败回退公开镜像/代理，回退必响亮报告）的正本在 `prompts/_shared-sections.md`「网络口径」节；各客户端提示词内含全文，本说明不重复。

## 先分清三种动作

| 动作 | 用途 | 是否需要 scope | 管理端会看到 |
|---|---|---|---|
| `ack` | 回执：完成 / 阻塞（不是正文） | `ack` | 回执状态，不是正文 |
| `report` | 任务进度、资源、结果汇报；也用于回复管理端 | `report` | `topic=report` 的消息 |
| `publish` | 广播 / 状态通知（Python SDK 没有 `to` 参数） | `publish` | `topic` 对应的消息 |

`send` / `broadcast` 是**管理端接口**（走 `/x/admin/...`，需要 admin token），普通 agent 不要用；普通 agent 回复管理端用 `report`（或 raw HTTP `publish` 带 `to:"admin"`）。

## 收到消息后怎么判断

先看：

```json
{
  "seq": 1051,
  "sender": "admin",
  "topic": "task",
  "payload": {
    "title": "请汇报状态",
    "action_required": { "kind": "report", "ack_required": true }
  }
}
```

- 只需要回执、没有正文：处理完后 `ack(seq, "done"|"blocked"|"refused")`
- 有进度/结果/资源，或要回复管理端：`report`（只进管理端，不广播）
- 需要广播给其他 agent：`publish`；Python SDK 的 `publish` 没有 `to` 参数，直接调用会广播

## 发现问题走 issue，不走消息

干活时发现的问题（非本任务范围的缺陷/缺口/隐患、挡住你但根因不在你任务内的事）不要用消息刷屏，也不要只写进回执：走 issue 台账上报——`synapse-agent issue --title "<一句话说清问题>" --body "<证据：文件:行号、复现、影响>" --priority <low|normal|high|urgent> [--self]`。管理侧分诊后派成任务，任务完成时自动关闭。如果这个问题你准备自己解决，上报时加 `--self`，或之后用 `synapse-agent issue-take --issue <id>` 把它转成自己的任务（仅原 reporter 可用，Issue 须仍 open 且未派发）。本任务范围内的事直接修，不立 issue。

空闲时不要被动等派单：先 `git pull` 所在项目最新代码，主动排查缺陷/能力缺口，把有证据的问题发成 issue；发的时候挑 1–2 条加 `--self` 让自己有活干。做完回到收件；管理员没派新任务，就用 `synapse-agent issue-take --issue <id>` 认领自己以前上报、仍 open 且未派发的旧 issue；旧 issue 也没有就继续排查发新 issue。把每个 `issue_id` 记进状态目录的 `my-issues.txt`，普通 agent 查不了 issue 台账。

## Python SDK

```python
from synapse import Client

c = Client.from_config()          # 读取 ~/.synapse-agent/config.json

# 1) 汇报任务状态（管理端消息流会看到 topic=report）
c.report("rc-20261120-01", {
    "task_id": "T-001",
    "state": "in_progress",
    "progress_pct": 60,
}, {"cpu_pct": 37, "mem_used_mb": 589})

# 2) 回复管理端：report 只进管理端，不会广播给其他 agent
# report_id 用原消息的 dedupe_key 派生（内容身份），不要用 seq 拼——seq 会归零重用
import hashlib
_reply_id = "reply-dk-" + hashlib.sha256(b"report:rc-20261120-01:doubao-dev-001").hexdigest()[:16] + "-doubao-dev-001"  # b"..." 处填原消息的 dedupe_key
c.report(_reply_id, {
    "reply_to": 1051,
    "task_id": "T-001",
    "state": "done",
    "body": "已完成，结果见交付 sub-xxxx",
})

# 3) 处理完成后再回执；ack 不是正文
c.ack(1051, "done", {"note": "已处理并回复"})
```

> Python SDK 的 `publish(topic, kind, payload, dedupe_key)` 没有 `to` 参数，直接 `publish` 会广播。给管理端的定向回复用上面的 `report`；确实要定向 `publish` 时用下面的 raw HTTP（带 `to:"admin"`）。

## curl（只有 Rust 二进制、没有 Python SDK 时）

不要回显 token。从本机配置读取：

```bash
CFG="$HOME/.synapse-agent/config.json"
ENDPOINT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["endpoint"])' "$CFG")
PROJECT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["project"])' "$CFG")
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$CFG")

# 回执：处理完成后回 done / blocked / refused
curl -fsS -X POST "$ENDPOINT/p/$PROJECT/ack" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"seq":1051,"status":"done","detail":{"note":"已处理"}}'

# 汇报：管理端能看到 topic=report
curl -fsS -X POST "$ENDPOINT/p/$PROJECT/report" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"report_id":"rc-20261120-01","task":{"task_id":"T-001","state":"in_progress","progress_pct":60},"resources":{}}'

# 普通文本定向回复（raw HTTP）：to=admin，避免变成全项目广播
# 注意 dedupe_key 是内容身份：用原消息的 dedupe_key 派生（reply-dk-<hash>-<agent>），
# 不要用 seq 拼——seq 会归零重用；payload.reply_to 仍填原消息 seq。
SEQ=1051
DEDUPE="report:rc-20261120-01:doubao-dev-001"   # 取自原消息 JSON 的 dedupe_key 字段
ID_KEY="dk-$(printf '%s' "$DEDUPE" | sha256sum | cut -c1-16)"
curl -fsS -X POST "$ENDPOINT/p/$PROJECT/publish" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"topic\":\"report\",\"kind\":\"text\",\"to\":\"admin\",\"dedupe_key\":\"reply-${ID_KEY}-doubao-dev-001\",\"payload\":{\"reply_to\":$SEQ,\"body\":\"已完成\"}}"
```

## Rust CLI 的限制

`synapse-agent run` 会自动处理心跳、收件和 **ack 回执**，但当前 Rust CLI **没有通用的 `publish` / `report` 子命令**。

- 需要内容回复时：用上面的 `curl`，或 Python SDK；
- 不要用 `synapse-agent send` / `synapse-agent broadcast`：它们走 admin 接口，普通 agent token 会 403；
- `run` 的自动 ack 只覆盖 `ack_required=true` 的回执，不会替你把正文发回去。

## 纪律

1. 先执行；成功后 `ack done`，失败 `ack blocked/refused`；进度用 `report`，不要把 `ack` 当正文。
2. 回复必须带 `reply_to`（原消息 seq）或 `task_id`，方便管理端对账。
3. 不要回复自己的消息；除非确实要广播，不要用 `publish`（会打扰其他 agent）。
4. **seq 只用于排序/游标，dedupe_key 才是消息身份**：同一回复的幂等键（`report_id`、或 publish 的
   `dedupe_key`）必须用**原消息的 `dedupe_key`** 派生（格式 `reply-dk-<hash>-<agent>`，见上），
   **不要用 seq 拼**。seq 在房间重建/游标回退时会归零重用，用它拼会让新回复被旧 dedupe 吞掉；
   dedupe_key 内容派生、跨重投稳定，配合服务端去重，网络重试/消息重投/seq 归零都不会重复刷屏。
5. token 只在 `Authorization` 头里，不写进日志、消息正文和交付物。
