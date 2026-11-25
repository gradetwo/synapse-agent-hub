# 调度、重试与效率观测（0057）

本批在 0056 客户端事件通道之上补齐三项运维闭环：优先级/公平调度、任务失败重试与死信、端到端可观测性。所有新增能力都向后兼容：旧客户端不传 `priority` / `deadline_at` / `max_attempts` 时按默认值运行。

## 1. 优先级与公平调度

任务新增字段：

| 字段 | 说明 |
|---|---|
| `priority` | `0..3`，0=P0 最高，3=P3 最低；缺省 2 |
| `deadline_at` | epoch ms 或 ISO 时间；逾期任务自动按 P0 排序，并计入 SLA 违约 |
| `effective_priority` | 服务端按排队时长计算的有效优先级，越小越先下发 |

排序规则（定向任务的 `queued` 队列）：

1. 有效优先级：基础优先级每排队 30 分钟提升一级，最低到 P0，避免低优先级饿死；
2. 截止时间更早的优先；
3. 同优先级按创建时间 FIFO。

`deadline_at` 在 10 分钟内到期时至少提升到 P1；已逾期直接按 P0 排序。排队期间不会提前注入任务，仍由 `promoteQueue` 在并发槽释放时按上述顺序补位。

创建任务时可直接传：

```json
{
  "task_id": "T-0057",
  "title": "fix parser",
  "body": "...",
  "to": "agent-a",
  "priority": 0,
  "deadline_at": "2026-11-25T12:00:00+08:00",
  "max_attempts": 3
}
```

管理台“任务”卡片新增优先级、截止时间、最多尝试三个输入；任务表的 P0/P1 徽标、截止时间和“退避 Ns”都直接来自服务端记录。

## 2. 失败重试与死信

执行节点在 `claimed` 状态下上报失败：

```http
POST /p/{project}/tasks/fail
Authorization: Bearer <agent token>
Content-Type: application/json

{"task_id":"T-0057","error":"parser crash at line 42","retryable":true}
```

服务端行为：

- `attempts` 加 1；未达到 `max_attempts` 时进入 `open + queued + next_retry_at`，按 15s 起指数退避（封顶 5 分钟）自动重新参与优先级队列；
- 达到上限或 `retryable:false` 时进入 `state=failed`、`dead_letter=true`，不再自动派发；
- 失败会立即释放并发槽位，队列里的其它任务先补位；失败任务在退避结束前不会被 `promoteQueue` 提前下发；
- 有未取走交付的任务拒绝失败上报，避免把已交付的工作当成失败；
- 管理端 `POST /x/admin/p/{project}/tasks/retry`（body `{task_id, reason}`）可手动重试死信/阻塞任务：清零本轮 `attempts`，累加 `manual_retries`，重新入优先级队列。

新增事件：`task.failed`、`task.retry_scheduled`、`task.retried`、`task.dead_lettered`。事件只通知，不进入任务队列；真正的工作正文仍是带 `work_item:true` 的 `task.dispatched` / `task.retried`。

SDK：

- Python：`client.fail_task(task_id, error, retryable=True)`
- TypeScript：`client.failTask(taskId, error, retryable = true)`
- Rust CLI：`task-fail --task <id> --error <text> [--retryable false]`（省略 `--task` 时使用 `active_task.json`）

成功上报失败后，SDK/CLI 会清掉本地 active task，避免 dispatcher 继续把下一条任务挡住。

## 3. 端到端可观测性

### API

```http
GET /x/admin/p/{project}/observability?window_ms=86400000
```

返回：

- `summary`：活跃/WIP、队列深度、退避中、公共池、窗口完成数、失败数、死信数、SLA 违约数、等待 P50/P95、周期 P50/P95、失败率、每小时吞吐；
- `lanes`：每个节点的在线状态、并发上限、在途数、队列数、退避数、最老等待、等待 P95、利用率、窗口完成/失败/死信；
- `recent_dead`：最近的死信任务、失败原因和尝试次数；
- `health`：`ok` / `warn` / `bad` 及原因（死信、最老排队超过 2 小时、排队目标离线、等待 P95 超过 30 分钟）。

单任务时间线：

```http
GET /x/admin/p/{project}/tasks/timeline?task_id=T-0057
```

合并热窗口消息、D1 归档消息、交付记录和任务字段里程碑，返回 `task.created → task.queued → task.dispatched → task.claimed → task.failed/task.retry_scheduled → task.retried → task.done` 的完整链路；实际消息和字段记录会自动去重。

### 管理台

“任务 / 效率观测”页新增：

- 六项 KPI：队列深度、最老等待、周期 P95、吞吐、失败率、死信/SLA；
- 节点队列 lane：并发、排队、退避、最老等待、等待 P95、窗口完成/失败；
- 死信列表：点击直接打开任务时间线并重试；
- 任务行新增“时间线”按钮；死信/失败任务额外显示“重试”。

### 指标口径

- **等待**：`created_at → notified_at`；当前仍在排队的任务按 `now - created_at` 计入；
- **周期**：`created_at → closed_at`，仅统计窗口内 `done` 的任务；
- **失败率**：窗口内 `failed_window / (done_window + failed_window)`；
- **吞吐**：窗口内完成数 / 窗口小时数；
- **利用率**：节点在途任务数 / 该节点的并发上限。

## 4. 兼容与边界

- 旧任务记录没有 `priority`、`attempts`、`max_attempts` 时分别按 2、0、3 读取；
- 旧版客户端仍可 claim/release；只有调用 `tasks/fail` 才进入新重试状态；
- 交付被拒后的 `reopen_on_reject` 与自动重试是两条独立路径：前者是验收驳回，后者是执行失败，不会互相覆盖；
- 手动重试会保留 `last_error` 作为审计记录，但清零 `attempts`，避免死信永远无法恢复。
