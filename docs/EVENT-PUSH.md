# 事件推送（客户端实时事件 / Webhook）

目标：任务状态变化、交付到达、交付裁决不再依赖管理侧轮询。管理 agent 和普通业务 agent 使用同一套事件模型：连接客户端实时通道，按角色自动过滤可见范围；外部自动化系统可另配 Webhook。

## 1. 三条通道

| 通道 | 适用 | 说明 |
|---|---|---|
| 客户端 WebSocket | Rust / Python / TS SDK、管理 agent | `/p/{project}/ws`，帧类型 `event`；延迟最低，推荐。 |
| 客户端事件拉取 | 无 WS 的 SDK、降级通道 | `GET /p/{project}/events`，独立事件游标，不消费任务消息。 |
| 项目 Webhook | 外部管理端 / 自动化系统 | 管理端配置 URL 与签名密钥；交付/任务事件直接 POST，失败自动重试。 |

管理 agent 用 `role=admin` 的 token 连接时，服务端下发全项目事件；普通 agent 只收到自己相关的任务/交付事件和项目级公告。过滤在服务端完成，客户端不需要也不应该自行放开全量事件。

## 2. 事件格式

```json
{
  "type": "event",
  "event": {
    "id": "evt-testp-124",
    "version": 1,
    "source": "synapse-agent-hub",
    "project": "testp",
    "type": "task.done",
    "seq": 124,
    "ts": "2026-11-25T01:17:03.182Z",
    "actor": "qclient2",
    "to": "qclient2",
    "task_id": "evtq-live2",
    "state": "done",
    "data": {
      "task_id": "evtq-live2",
      "title": "event live2",
      "body": "do live2",
      "closed_by": "collection"
    }
  }
}
```

- `id` / `seq` 同一条消息唯一；客户端按 `id` 或 `seq` 去重。
- `actor` 是触发者；`to` 是收件人（可为 null、字符串或数组）。
- `task_id` / `submission_id` / `state` / `review_state` 是顶层快捷字段，`data` 保留原始业务字段。
- 事件和原始 `msg` 共用 seq；WS 会同时发送 `msg`（任务正文/聊天）和 `event`（通知）。事件帧不进入任务队列，不 ACK，也不会被窗口/tmux 注入。

主要 `type`：

| 类别 | 类型 |
|---|---|
| 任务 | `task.created`、`task.queued`、`task.dispatched`、`task.claimed`、`task.released`、`task.blocked`、`task.done`、`task.reopened`、`task.reclaimed`、`task.reassigned`、`task.failed`、`task.retry_scheduled`、`task.retried`、`task.dead_lettered`、`task.merged`、`task.requeued`、`task.updated` |
| 交付 | `submission.created`、`submission.reviewed`、`submission.collected`、`submission.archived` |
| Issue | `issue.created`、`issue.closed`、`issue.reopened`、`issue.merged`、`issue.dispatched`、`issue.updated` |
| CI | `ci.status`（main CI 红/绿/待定） |
| 通知 | `announcement.created`、`notice.created`、`system.notice`、`report.created`、`issue.created`、`status.changed`、`alert.created` |

`task.queued` 是单飞队列新增的事件：任务已创建但目标节点并发槽已满，管理端和客户端都能立刻看到“在排队”，不用等真正下发。

## 3. 客户端接入

### Python

WS 长连接（`Loop` 已内置）：

```python
from synapse import Client, Loop

c = Client.from_config()
c.on_event(lambda e: print("event:", e["type"], e.get("task_id"), e.get("submission_id")))

loop = Loop(c)          # 默认 transport=auto：WS 优先，失败自动轮询
# 管理 agent 用 role=admin 的 token 时，收到的是全项目事件
```

没有 WS 时可直接拉事件流，使用独立 `event_cursor.json`，不会推进任务消息游标：

```python
for e in c.event_stream(topics="task,submission"):
    print(e["type"])
```

### TypeScript

```ts
import { Client, Loop } from "@synapse/agent";

const c = Client.init({ endpoint, project, token, agentId: "manager" });
c.onEvent((e) => console.log(e.type, e.task_id, e.submission_id));

const loop = new Loop(c);       // WS 帧 type=event 会直接回调，不进入任务队列
// 无 WS 时：
for await (const e of c.eventStream("task,submission")) console.log(e.type);
```

### Rust

`run` / `ws` 自动识别 `event` 帧：

- 追加到 `<状态目录>/events.jsonl`；
- 若配置 `--event-cmd` / `config.json` 的 `event_cmd` / `SYNAPSE_EVENT_CMD`，把整条事件 JSON 从 stdin 交给命令；
- 事件游标写 `<状态目录>/event_cursor.txt`，与任务游标 `cursor.json` 独立；
- 轮询降级时也会拉 `/events`，不会丢通知。

```bash
synapse-agent run --event-cmd 'jq -c "{type:.type,task:.task_id}" >> /tmp/events.log'
synapse-agent status   # 输出 event_cursor / event_cmd
```

## 4. 事件拉取 API

`GET /p/{project}/events?since=<seq>&limit=<1-200>&topics=<task,submission>`，使用 agent token（admin token 也可）；响应带 `server_version: {sdk, build}`。

```json
{
  "events": [ ... ],
  "next_cursor": 124,
  "epoch": "a1b2c3d4"
}
```

- `topics` 过滤事件类别：`task`、`submission`、`announce`、`admin`、`system`、`report`、`issue`、`status`、`alert`；`artifact` 是 `submission` 的兼容别名，`all` 表示不过滤。事件类别按 `type` 判断，不按原始消息 topic，因此 `submission.created` 不会被 `topics=submission` 漏掉。
- `next_cursor` 与 `/inbox` 同源；即使整页都是不可见项目事件，客户端也必须保存 `next_cursor`，否则会反复拉旧段。
- 房间重建时 `epoch` 变化，客户端应把事件游标归零。

## 5. Webhook

管理 API（支持 `/admin`、`/console/admin`、`/x/admin` 前缀）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/p/{project}/webhook` | 读配置；只返回 `has_secret`，不返回密钥明文 |
| PUT/POST | `/admin/p/{project}/webhook` | 保存 `{url, enabled, topics, secret?}` |
| POST | `/admin/p/{project}/webhook/test` | 立即发一条 `webhook.test` |

`topics` 可选：`submission`（交付到达/裁决，默认）、`task`、`issue`、`ci`、`alert`、`announce`、`admin`、`system`、`all`。
启用时必须提供至少 8 位签名密钥；保存空 `secret` 表示沿用旧密钥。

Webhook 事件体与客户端事件相同（额外带 `sender` 兼容字段）。签名请求头：

```
X-Synapse-Event: submission.created
X-Synapse-Timestamp: 1795565246018
X-Synapse-Signature: sha256=<hex>
```

签名原文 `<timestamp>.<raw_body>`，HMAC-SHA256，密钥为配置的 secret；接收方应校验时间戳（建议 ±5 分钟）和签名。

投递：立即 POST，超时 5 秒，不阻塞提交接口；非 2xx/网络失败进入 `whq:*` 重试队列，5s、10s、20s…最多 8 次，DO alarm 触发、cron 兜底。至少一次投递，接收方按 `id`/`seq` 幂等。

## 6. 可见性规则

| 连接身份 | 可见事件 |
|---|---|
| `role=admin`（管理 agent / 管理台） | 全项目事件 |
| 历史管理 token：`role=agent` 但 scopes 含 `admin` / `*` | 全项目事件（按管理视角处理） |
| `role=observer`（只读观察员） | 全项目事件；token 默认只有心跳/事件/任务/Issue/交付只读 scope，不能 claim/report/写 artifact |
| 普通 agent | 定向给自己的任务事件、自己发起的任务/交付事件、自己的 `submission.*`、项目级 `announcement.created` |
| 其它 agent | 看不到别人的交付原文；只能看到与自己相关的任务事件 |

WS 与 `/events` 使用同一套判定：服务端按角色/scope 决定全量或定向，不把全量事件下发给普通连接再让客户端过滤。管理身份如果只需要看全量事件、不需要管理写权限，建议签发 `role=observer` 的 token，而不是 admin token。

WS 建连后服务端先发 `hello`，其中 `events: true`、`event_version: 1` 和 `event_types` 可供客户端做能力探测；旧客户端忽略未知帧即可，不影响原有 `msg` 通道。

## 7. 本地回归

- 管理 agent WS：收到 `task.queued → task.dispatched → task.claimed → submission.created → submission.collected → task.done` 全链路事件。
- 交付人 WS：同一任务只收到自己的事件；另一个 agent 的连接收不到该交付事件。
- `submission.reviewed`：管理端把交付标为 `rejected` 后，交付人立即收到事件。
- `/events`：管理 token 与 agent token 分别按角色返回；`next_cursor` 正确推进。
- Python `Loop`：`on_event` 在 WS 模式下收到实时 `task.dispatched`，事件不进入任务队列。
