# 派单系统 Phase 1：任务台账与四个出口

> 基线：`a7e37bd`。范围：Rust/Python/TS 客户端不变；只补中枢任务模型、管理端任务 API 与管理台「任务」tab。
> 目标：把「claim 之后去哪儿」变成中枢可查询、可操作的状态机，不再只存在于聊天正文里。

## 1. 现状与问题

当前任务状态机只有：

```
open ──claim──▶ claimed ──release(state=done)──▶ done / released（有交付待取）
```

管理台只有消息流和交付箱，没有任务台账。管理员看不到：

- 谁在 claim、lease 还剩多久；
- 任务是不是已交付但还有交付待取（`released`）；
- 一个节点名下有哪些 open/claimed/released；
- 陈旧 open 任务如何关闭、如何从旧节点取回、如何改派。

管理员只能在自己的记录里对账，SSOT 仍是聊天正文。

## 2. 任务模型

`Task` 在 ProjectRoom storage 中保存，字段：

| 字段 | 说明 |
|---|---|
| `task_id` | 业务 ID，`^[a-zA-Z0-9._:-]{1,64}$` |
| `title` / `body` | 派单正文 |
| `state` | `open` / `claimed` / `released` / `done` / `blocked` |
| `owner` | 当前 claim 的 agent；`claimed` 时有值，其余为 null |
| `lease_until` | claim 租约到期时间；心跳会续租，过期由 cron 收回 |
| `to` | 指派目标；null 表示管理池，可被任意 agent claim |
| `pending_submissions` | `released` 时还未被管理侧取走的交付数 |
| `created_at` / `updated_at` | 创建/最后状态变更 |
| `closed_at` / `closed_by` | 关单时间与来源 `agent`/`admin`/`collection` |
| `reclaimed_at` / `reassigned_at` | 管理侧取回/转派最近一次时间 |
| `created_by` | 创建者 |

`state` 语义：

- `open`：可 claim；`to` 为空是公共池，`to` 有值是定向给某节点。
- `claimed`：有 owner 和 lease；只有 owner 能 release。
- `released`：执行侧已完成、但有交付未被管理侧取走；不是终态。
- `done`：终态，不再可 claim/release/reassign。
- `blocked`：执行侧显式阻塞；保留为诊断状态，管理员可通过取回/转派恢复。

## 3. 四个出口（Phase 1 核心）

### 3.1 完成

**Agent 完成**：`POST /p/{project}/tasks/release`，body `{task_id, state:"done"}`。
- 没有待取交付：→ `done`，`closed_by="agent"`。
- 有待取交付：→ `released`，`pending_submissions=N`；管理侧取走最后一件后由 `submissionSettled` 自动 `done`。

**Admin 关单**：`POST /admin/p/{project}/tasks/close`，body `{task_id}`。
- 任意非 `done` 任务可直接 → `done`，`closed_by="admin"`，`closed_at`。
- 仍保留 `pending_submissions` 快照；不删除交付记录。UI 在有待取交付时二次确认。

### 3.2 Agent 自己放弃

`POST /p/{project}/tasks/release`，body `{task_id, state:"open"}`。
- `owner=null`、`lease_until=0`，任务回到 `open`。
- `to` 保留：原定向关系仍在；如果管理员要放回公共池，用「取回」。
- 事件 `kind="open"`，payload 带 `abandoned_by`。

### 3.3 Admin 取回

`POST /admin/p/{project}/tasks/reclaim`，body `{task_id}`。
- 任意非 `done` 任务 → `open`。
- `owner=null`、`lease_until=0`、`to=null`：回到公共池，任何节点都可 claim。
- 保留 `pending_submissions`；`reclaimed_at` 记录时间。
- 事件 `kind="reclaimed"`，payload 带 `prev_owner`、`prev_to`。

### 3.4 Admin 转派

`POST /admin/p/{project}/tasks/reassign`，body `{task_id, to}`。
- 任意非 `done` 任务 → `open`，`to=<新节点>`。
- `owner=null`、`lease_until=0`；旧 owner 立即失去操作权（再 release 会 `not_owner`）。
- 校验目标 agent 在项目内存在、未吊销、未过期；允许目标离线（离线节点上线后 claim）。
- 事件 `kind="reassigned"`，payload 带 `prev_owner`、`to`。

状态迁移表：

| 当前 | 动作 | 结果 | 谁可执行 |
|---|---|---|---|
| open | claim | claimed | 目标 agent / 任意 agent（`to=null`） |
| claimed | release done | done / released | 当前 owner |
| claimed | release open | open | 当前 owner |
| open/claimed/released/blocked | close | done | admin |
| open/claimed/released/blocked | reclaim | open（公共池） | admin |
| open/claimed/released/blocked | reassign | open（定向） | admin |
| released | 最后一件交付 collect | done | 系统 |

`done` 是终态；如需重开，Phase 2 再引入显式 `reopen`，不在本期混入。

## 4. 租约与续租

- `claim` 租约统一为 `TASK_LEASE_MS = 10 分钟`（原 120 秒过短）。
- `heartbeat` 会为 `owner=该 agent && state=claimed` 的任务续租到 `now + TASK_LEASE_MS`；agent 心跳正常时不会因执行时间长而被误回收。
- `cron/tick` 只回收真正过期且心跳也没续上的 `claimed`，转为 `open` 并写 `reclaimed` 事件。
- 管理台任务行显示「租约剩余」；剩余 ≤60 秒标黄，≤0 标红。

## 5. 管理端 API

全部在 `/admin/p/{project}/` 下，沿用 admin scope / Cloudflare Access。

```
GET  /admin/p/{project}/tasks
POST /admin/p/{project}/tasks                 # 创建/派单
POST /admin/p/{project}/tasks/close           # 完成
POST /admin/p/{project}/tasks/reclaim         # 取回
POST /admin/p/{project}/tasks/reassign        # 转派
```

列表响应在 Task 基础上补：

```json
{
  "tasks": [{
    "task_id": "T-FIX-71",
    "state": "claimed",
    "owner": "dou-win-133",
    "to": "dou-win-133",
    "lease_left_ms": 412000,
    "owner_online": true,
    "pending_submissions": 0,
    "updated_at": 1760000000000
  }]
}
```

`owner_online` 依据 DO 的 `agent:` 心跳（120 秒在线、300 秒迟到、否则离线）。列表排序：active（claimed/open/released）优先，再按 `updated_at` 倒序。

## 6. 管理台「任务」tab

新增独立 tab，放在「总览」之后：

- **新建/派单**：`task_id`、标题、正文、指派给（不指派 / 具体 agent）。
- **筛选**：状态（全部/open/claimed/released/blocked/done）、节点、关键字。
- **台账列**：任务、状态、执行节点、租约、待取交付、更新时间、操作。
- **操作**：完成、取回、转派。
  - 完成：二次确认；有 pending 交付时提示「交付仍留在交付箱」。
  - 取回：回到公共池，清空 `to`。
  - 转派：行内 agent 选择器；目标离线也允许。
- **计数**：tab 上显示 active 任务数；空/全部项目视图明确提示「选择具体项目」。

UI 不直接改任务状态；所有动作都走上面的 API，页面刷新以中枢为准。

## 7. 验收

1. 创建任务后立即出现在「任务」tab，state=open，owner=空。
2. agent claim 后 tab 显示 owner、lease；心跳持续时 lease 剩余保持 >0。
3. agent release `done` 且无交付 → done；有交付 → released，并在交付取走后自动 done。
4. agent release `open` → open，owner 清空，`to` 保留。
5. admin close → done；再 claim 返回 409。
6. admin reclaim → open、`to=null`，其他 agent 可 claim。
7. admin reassign → open、`to=目标`；旧 owner release 返回 403；目标 agent 可 claim。
8. 非 admin 调四个管理动作返回 403；不存在的 task 返回 404。
9. 全部项目视图不显示可写任务表单，提示切换到具体项目。
10. `cargo test` 与 `npm`/`tsc` 不因本次改动破坏；Worker 部署前 dry-run 通过。

## 8. Phase 2（不在本期实现）

- 优先级/依赖/队列位置与按节点队列视图；
- 交付格式门（回执、checks 必填、task 存在性/归属校验）；
- 仓库绑定、CI/合入结果回写；
- 交付/任务变更的主动推送；
- arm64-gnu 发布矩阵与 `/ver` 版本标。

## 9. 上游十项需求映射（2026-11-22）

Muse 管理侧提交的 `docs/REQUIREMENTS-20261122.md` 按 ROI 列了 R1–R10。本期只落地与「任务出口/管理台台账」直接相关的部分，其余排期如下：

| 需求 | 本期状态 | 说明 |
|---|---|---|
| R1 交付与任务绑定 | 后端字段已支持，客户端待补 | `submissions` 已有可选 `task_id`；Rust/Python/TS 客户端尚未暴露，下一期补协议与校验 |
| R2 交付格式门 | 未开始 | 需要定义代码类交付的回执/checks 结构，避免误伤文档类交付 |
| R3 管理员关单与状态纠错 | **本期已实现** | `tasks/close`、`tasks/reclaim`、`tasks/reassign`，写任务事件审计 |
| R4 队列顺序/优先级/按节点视图 | 未开始 | 需要 `priority`、`after`、`repo` 字段与领取约束 |
| R5 租约与在岗状态 | **本期部分实现** | 租约 10 分钟 + heartbeat 续租；台账显示剩余租约与 owner 在线状态；`running/stale` 细分留到下一期 |
| R6 派单唤醒 | 未开始 | 本期只做「目标离线」可视化，不做 webhook/长轮询 |
| R7 任务与仓库绑定 | 未开始 | 依赖 R4 的 `repo` 字段 |
| R8 合入/CI 回写 | 未开始 | 需要新增 task 下游状态字段与详情页 |
| R9 管理侧事件推送 | 未开始 | 与 R6 共用通道 |
| R10 arm64-gnu / 动态版本标 | 未开始 | 本期只把 `BUILD_TAG` 更新为当前部署标 |

本期交付标准以第 7 节验收为准；R1/R2/R4–R10 不会因为文档存在而被误标为已完成。
