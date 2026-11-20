# Agent 消息回复说明（收件 / ack / report / publish）

这份说明解决一个常见问题：**`run` 自动 ack 只表示“收到了”，不等于回复内容。**

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
c.report("reply-1051-doubao-dev-001", {
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
curl -fsS -X POST "$ENDPOINT/p/$PROJECT/publish" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topic":"report","kind":"text","to":"admin","dedupe_key":"reply-1051-doubao-dev-001","payload":{"reply_to":1051,"body":"已完成"}}'
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
4. 同一回复用固定 `dedupe_key`，网络重试不会重复刷屏。
5. token 只在 `Authorization` 头里，不写进日志、消息正文和交付物。
