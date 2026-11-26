# Agent Hub 设计文档

> 多 agent 协作中枢（Cloudflare Workers）。本文件是唯一设计单源；代码按此实现。
> 版本 v0.5.11 · 2026-11-20

---

## 0. 目标与非目标

### 目标

1. 多个 agent（多为**只读 git**）围绕**一个仓库**协作，产出通过本站交付。
2. 中枢提供：**交付箱**（补丁/产物）、**广播**（基线变更通知）、**点收**（进度与资源上报）、**名册**（谁活着、在忙什么、机器多重）。
3. 支持**多个项目同时运行**（如 `yanshi` 偃师、`yeban` 夜半），互相隔离。
4. agent 侧**安装即接入**：一条命令 + 一个 token，SDK 托管心跳、游标、重试。
5. 管理员可以看**全部项目**或**面板配置的少数项目**。

### 非目标（明确不做）

- ✗ 不做代码评审与合并（在 GitHub / 本地由集成者完成）
- ✗ 不托管仓库、不持有 git 凭据、不执行 git 命令
- ✗ 不保证 commit 署名（署名由集成者在系统外决定）
- ✗ 不做 CI 复现验证（编译与测试结果由 agent 声明，留档但不校验）

> 系统只负责三件事：**东西到位、通知到位、台账清楚**。

---

## 1. 系统定位

```
只读 agent ──upload──▶ 交付箱(R2) ──download──▶ 集成者
   │                                              │
   └─poll/heartbeat/report─▶ 中枢(DO+D1) ◀──broadcast──┘
                                  │
                          在 GitHub/本地合并、复核、改署名
                                  │
                            回写 result（可选，纯信息）
```

---

## 2. 角色与权限

### 两类主体

| 主体 | 凭证 | 平面 |
|---|---|---|
| agent | 32 位十六进制 token，绑定单一项目 | data plane `/p/{project}/…` |
| admin（集成者） | 同表的 `role=admin` token，或 Cloudflare Access JWT/cookie | control plane `/admin/…`、`/x/admin/…` |

### agent 默认 scope（签发时可增减，但**不可**含 `admin`）

```
poll, ack, report, heartbeat, publish, tasks.claim, tasks.release, tasks.read, issues.read, issues.report, artifact.write, submissions.read, submissions.create
```

管理员默认 scope 在上面基础上加 `artifact.read` 与 `admin`。普通 agent 不允许携带 `admin`；
管理员 token 与 agent token 存在同一张 `agents` 表，只是 `role='admin'`。

### 权限矩阵

| 能力 | agent | admin |
|---|---|---|
| poll / inbox / ack / report / heartbeat | ✅ | ✅ |
| publish 普通消息 | ✅ | ✅ |
| 领取 / 完成任务（tasks/claim、tasks/release） | ✅ | ✅ |
| 上传产物 + 建 submission | ✅ | ✅ |
| 标记 collected / archived、写 result | ✗ | ✅ |
| 广播（含 git_pull） | ✗ | ✅ |
| 签发/吊销/轮换 token | ✗ | ✅ |
| 可见性策略配置 | ✗ | ✅ |

**为什么分开**：admin token 不该出现在 agent 的机器上；agent 机器上放管理钥匙是设计事故。

---

## 3. 多项目

### 隔离点

| 面 | 做法 |
|---|---|
| 序列 | 每项目一个 DO（`idFromName("v9:" + project)`），`seq` 各自独立 |
| 令牌 | token 绑定 `project`，跨项目请求 403 |
| 存储 | R2 key `p/{project}/artifacts/{sha256}`，**不做跨项目去重**（去重会造成越权读） |
| 配额 | 每项目独立：`max_agents` / `max_storage_mb` / `max_msgs_per_min` / `retention_days` |
| 成员 | 没有全局 membership 表；同一 `agent_id` 在不同项目各有一行 token，面板按项目展示 |

### 项目表

```sql
projects(project PK, display_name, status, max_agents, max_storage_mb,
         max_msgs_per_min, retention_days, created_at)
```

`display_name` 用于面板显示中文名（偃师 / 夜半），slug 只做路由。

### 跨项目广播

逐项目各写一条自己的 `seq`，不引入全局序列（全局序列会破坏 seq 独立性与续传语义）。

### 项目参与（加入 / 迁移）

面板的「加入项目」和「迁移项目」都调用同一个管理接口 `POST /admin/agents/move`：

- `keep_source:true`：在目标项目签发同 `agent_id` 的新 token，源项目 token 保留；这是“加入”。
- `keep_source:false`：签发目标 token 后立即吊销源 token；这是“迁移”。
- 目标项目必须 `active`，源 agent 必须活跃；目标项目要过 `max_agents` 配额。
- 目标项目已存在同 `agent_id` 的活跃 token 时，先作废旧目标 token 再签发。

数据模型仍是“项目内 agent + 项目 token”，加入项目不等于一个客户端进程自动连两个项目；
客户端需要两个实例，分别使用两个 token 和不同状态目录（见 §11）。

---

## 4. 数据模型

### 分层

| 层 | 存什么 | 为什么 |
|---|---|---|
| **DO**（每项目） | `seq`、最近 200 条消息、dedupe 索引、任务、agent 心跳记录、广播待确认名单 | 强一致 + 单线程 ⇒ 免锁 |
| **D1**（共享） | projects / agents(token) / hb_hist / submissions / admin_policy | 可查询、可留档 |
| **R2**（共享） | 内容寻址产物 | 便宜、天然去重（项目内） |

### 消息信封

```json
{
  "seq": 1043, "id": "ulid", "project": "yanshi", "sender": "agent-a",
  "topic": "announce|task|artifact|report|ack|status|alert|admin",
  "kind": "broadcast|claimed|patch|done|...",
  "payload": {}, "refs": [{"sha256": "...", "name": "..."}],
  "dedupe_key": "bc:bc-20261119-01", "ts": "2026-11-19T09:02:11Z"
}
```

**规则**

- `seq` 是排序与续传的唯一依据（不用时间戳，时钟不可信）
- 大文件不进消息，只带 `sha256` 引用
- 消息体 ≤ 64 KB
- `ack` / `report` 是给管理端的控制消息，写入时带 `to:"admin"`；普通 agent 不会收到，管理台显示为“管理端”，不是广播
- 普通 agent 的无 `to` 项目事件（ack/report、announce、artifact、dm、task 生命周期）只进管理台；`status`/`alert` 广播仍可互见

### 心跳历史

`hb_hist(project, agent_id, bucket, cpu_pct, mem_used_mb, mem_total_mb, disk_used_pct, work_state)`

- `bucket = floor(ts / 300s)`，每 5 分钟一行
- 保留 **14 天**（才看得出磁盘下降趋势）
- 绝不每条心跳都写 D1

---

## 5. API

### data plane

| 方法 | 路径 | scope | 说明 |
|---|---|---|---|
| POST | `/p/{p}/publish` | publish | 幂等（`dedupe_key` 必填） |
| GET | `/p/{p}/inbox?since=&topics=&timeout=` | poll | 返回 `messages / next_cursor / has_more` |
| POST | `/p/{p}/heartbeat` | heartbeat | 覆盖写 + 顺带续租 + 5 分钟采样 |
| POST | `/p/{p}/ack` | ack | `status: done \| refused \| blocked \| stale` |
| POST | `/p/{p}/report` | report | 任务 + 资源详单 |
| GET | `/p/{p}/tasks` | tasks.read | 公共池：只列 `open` 且无 `to` 的任务 |
| GET | `/p/{p}/tasks?mine=1` | tasks.read | 自查名下任务（open 定向/claimed/blocked/released），带 `counts_toward_limit` |
| GET | `/p/{p}/tasks/{task_id}` | tasks.read | 自查单条任务；非本人名下 404 |
| POST | `/p/{p}/tasks/claim` | tasks.claim | 认领公共任务；租约默认 12h（`LEASE_TTL_S`）；`claimed` ≥5 时 409 `agent_task_limit_exceeded` |
| GET | `/p/{p}/issues` | issues.read | 只列 `open` 且 `task_id IS NULL` 的 Issue |
| POST | `/p/{p}/issues/{id}/claim` | issues.report | 任意项目 agent 把未指派 open Issue 转成自己的任务；同样受 ≥5 限制 |
| POST | `/p/{p}/tasks/release` | publish | `done \| blocked`；目标 done 且该任务仍有待取交付时只进 `released`（见 §7 联动） |
| PUT | `/p/{p}/artifact/{sha256}` | artifact.write | 流式直传 R2 |
| GET | `/p/{p}/artifact/{sha256}` | poll | 下载 |
| GET | `/p/{p}/submissions` | submissions.read（存量 token 可用 submissions.create 兼容） | 返工节点只读交付列表；管理面 GET 同路径仍可看全字段 |
| GET | `/p/{p}/submissions/{id}/bundle` | submissions.read（同上） | 下载补丁 bundle；数据面不返回管理审计字段 |
| POST | `/p/{p}/submissions` | submissions.create | 建交付（校验 blob 存在 + base_sha） |
| GET | `/p/{p}/ws-ticket` | 任意有效 token（无需额外 scope） | 一次性 WebSocket 票据（90s） |
| GET | `/p/{p}/wsstat` | 任意有效 token（无需额外 scope） | 当前在线连接数 |
| POST | `/p/enroll` | 公开（限流） | 自助注册，待管理员审批 |

### control plane

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/projects` | 按可见性策略过滤，返回 `{policy, projects, hidden}` |
| POST | `/admin/projects` | 新建项目 |
| GET/POST | `/admin/visibility` | 看全部 / 只看列表 |
| GET | `/admin/agents` | 全部可见项目的聚合名册（每行带 `project`，控制台“全部项目”视图用） |
| GET | `/admin/p/{p}/agents` | 单项目名册（含 alive/late/offline + age_s） |
| GET | `/admin/p/{p}/snapshot` | seq + agents + tasks |
| GET/PUT | `/admin/p/{p}/idle` | 空闲提醒配置 + 待唤醒列表 / 保存配置 |
| POST | `/admin/p/{p}/idle/check` | 立即执行一次租约回收与空闲扫描 |
| POST | `/admin/p/{p}/broadcast` | 广播（幂等 `broadcast_id`） |
| GET/POST | `/admin/p/{p}/submissions` | 交付箱列表 / 新建（测试用） |
| POST | `/admin/p/{p}/submissions/{id}/collect` | 标记取走 |
| POST | `/admin/p/{p}/submissions/{id}/archive` | 归档 |
| POST | `/admin/p/{p}/submissions/{id}/result` | 写备注（纯信息） |
| POST | `/admin/agents` | 签发 token（明文只返回一次，库中只存 SHA-256） |
| DELETE | `/admin/agents` | 吊销某项目某 agent 的全部未吊销 token |
| POST | `/admin/agents/move` | 加入/迁移项目；`keep_source` 控制源 token |

浏览器通过 `/console/admin/*` 访问同一套管理 API（Access 会话 cookie）；CLI 走 `/x/admin/*`（Bearer admin token）。
**越界**：`policy.mode=list` 且项目不在列表 ⇒ `403 project_not_visible`（面板与 CLI 同一套判断）。

---

## 6. 广播 / 确认 / 点收

### 广播报文

```json
{
  "broadcast_id": "bc-20261119-01", "severity": "info|action|freeze",
  "title": "main 已到 e5a17c93",
  "body": "请各自 git pull 后重新编译",
  "action_required": {
    "kind": "git_pull|report|none", "target_commit": "e5a17c93",
    "deadline": "2026-11-19T10:30:00Z", "ack_required": true
  },
  "supersedes": "bc-20261118-03"
}
```

### 双状态语义

| 状态 | 判定 | 谁写 |
|---|---|---|
| `received` | cursor 越过该 seq | 系统自动 |
| `acted` | agent 回 `/ack` | agent |

### 回执

```json
{"seq": 1051, "status": "done",
 "detail": {"before": "b34ecb2a", "after": "e5a17c93", "dirty": false, "pull": "fast-forward"}}
```

- 拉不动（有本地改动）⇒ `blocked`，**不自动 stash**（会制造"改动消失"事故）
- 已被 `supersedes` ⇒ `stale`，不执行旧动作
- `ack_required=false` 的 `info` 级广播**不进消息流默认视图**，只进广播台（压噪声）

### 点收 report

```json
{"report_id": "rc-1119-01",
 "task": {"current": "UI-0049", "state": "in_progress", "progress_pct": 60,
          "base_sha": "b34ecb2a", "blockers": []},
 "resources": {"cpu_pct": 37, "load1": 1.8, "mem_used_mb": 589, "mem_total_mb": 4032,
               "disk_free_gb": 12.4, "disk_used_pct": 78},
 "env": {"git_head": "b34ecb2a", "dirty": true}}
```

---

### 6.1 空闲提醒（普通 agent）

- `agent_idle` 按 `(project, agent_id)` 记录 `idle_since_ms`、`reminded_at`、`flagged_at`、最近任务/Issue list 和最近主动调用。心跳、自动 ack、收件轮询不算主动调用。
- cron 每分钟扫描在线（心跳 ≤120s）且名下已 claim 任务为 0 的普通 agent：连续 `idle_after_s` 无主动调用即发定向 `system/idle_reminder` 私信；再经过 `followup_after_s` 仍无任务、无主动调用，则进入管理台“待唤醒”列表。
- `idle_after_s` 与 `followup_after_s` 相互独立，默认 600 秒；项目级配置存 `idle_reminder_config`，支持开关与文案模板变量。
- 管理员派单或 agent 自己领到任务后，下一次扫描会清空空闲/提醒/上榜状态；关闭开关时也会清空提醒与上榜，重新打开从新的空闲周期开始。

### 6.2 旧客户端提醒

- 心跳写入 `sdk_version`、`sdk_latest`、`sdk_outdated`；`sdk_version` 缺失或低于 `SDK_VERSION` 视为旧版。
- 旧版客户端会收到定向 `system/sdk_upgrade` 私信，提示 `/dl/install.sh`；按 agent + 当前版本 + 最新版本 + UTC 日期去重，每天最多一次。
- 心跳响应附 `upgrade` 对象；管理台名册显示“旧版”徽标和数量统计，不强制拒绝旧客户端。

## 7. 交付协议（只读 agent 的唯一产出通道）

### 三态（不设 review/merge 状态）

```
delivered ──▶ collected ──▶ archived
```

- `delivered`：上传完成，等取
- `collected`：集成者已取走
- `archived`：到期或手工归档

**没有 rejected/merged**——外部真相不归系统管。保留自由文本 `result` 作台账备注（不改状态）。

### 取走与提醒

- 控制台的“下载并取走”是一个原子动作：先保存 zip，保存成功后再调用 `collect`。
- 下载失败时不得改状态，仍保持 `delivered` 以便重试；已归档的交付不会被下载动作改回 `collected`。
- 待取交付必须在控制台顶部常驻黄条、标签页角标和浏览器标题计数中可见；新交付出现时弹一次 toast。
- `task · done` 只表示 agent 的执行结束，不是交付已取；仍有待取时控制台合并显示为 `task · 完成待取`，并标注“该 agent 还有 N 份交付待取”。

### 任务与交付的联动（2026-11-20）

- 交付建单时可带 `task_id`（落库 `submissions.task_id`，迁移见 `worker/migrations/20261120-submissions-task-id.sql`）。
- `tasks/release` 目标为 `done` 时，DO 按 `(project, task_id, state='delivered')` 查待取数：大于 0 则任务只进 `released`（已交付待取，`pending_submissions` 记待取数），不许直接 `done`；显式传 `blocked` 等其它状态不走联动。release 响应带 `state` 与 `pending_submissions`。
- 管理侧 `collect` / `archive` 一件带 `task_id` 的交付后，Worker 回调 DO `tasks/submission-settled` 重算待取数；`released` 且归零时 DO 把任务收成 `done` 并追加一条 `kind=done`（`closed_by: "collection"`）。回调失败不回滚取走状态，但 collect 响应的 `task_link` 会把失败响亮标出。
- 没有 `task_id` 的旧交付与无交付的任务行为与此前完全一致（release 直接 `done`）。

### 提交清单

```json
{"submission_id": "sub-a-0049-r2", "agent_id": "agent-a", "base_sha": "b34ecb2a",
 "kind": "patch|bundle|report|asset", "title": "…",
 "refs": [{"sha256": "9f2c…", "name": "0049.patch", "bytes": 4096}],
 "checks": {"built": true, "tests": "15/15 PASS"}, "notes": "…"}
```

### 服务端卫生检查（只查"齐不齐"，不查"好不好"）

| 检查 | 不通过 |
|---|---|
| `base_sha` 存在且 hex | 422 |
| refs 指向的 blob 都在 R2 | 422 `blob_missing:<sha>` |
| 单文件 > 100 MB | 413 |
| 命中密钥形态（`AKIA` / `BEGIN PRIVATE KEY` / `ghp_`） | 422 |
| 同 `submission_id` 重复 | 幂等返回原记录 |

### 署名

系统只记**来源**：`agent_id`（来自 token，不可伪造）+ 可选 `author_hint`（仅建议）。打包时附 `PROVENANCE.json`：

```json
{"submission_id": "…", "agent_id": "agent-a", "author_hint": "…",
 "base_sha": "b34ecb2a", "created_at": "…", "files": [...],
 "note": "署名与作者信息以集成系统为准；本文件仅记录投递来源"}
```

---

## 8. 心跳与在线判定

### 报文

```json
{"hb": 42, "agent_id": "agent-a",
 "work": {"state": "busy|idle|blocked", "task_id": "UI-0049", "phase": "tiles 6/16", "progress_pct": 38},
 "load": {"cpu_pct": 37, "load1": 1.8, "cores": 4, "mem_used_mb": 589, "mem_total_mb": 4032,
          "disk": [{"mount": "/", "free_gb": 12.4, "used_pct": 78}], "procs": 3, "uptime_s": 5400},
 "env": {"git_head": "b34ecb2a", "dirty": true}}
```

**三条硬规则**

1. `cpu_pct` 必须是**区间均值**（`/proc/stat` 差值），不是瞬时
2. 磁盘按 mount 给，至少 `/`
3. `work.state` 只有三值，不要发明第四种（"等确认"归 `blocked`）

### 判定阈值

| 状态 | 条件 |
|---|---|
| `alive` | `age ≤ 2 × period`（120s） |
| `late` | `≤ 5 × period`（300s） |
| `offline` | `> 5 × period` |
| `unknown` | 从未上报（新签发 token） |

`late` 中间档是必要的：agent 跑 275 秒长命令会漏拍，一刀切 offline 会造成假警报。

### 采样与成本

- 心跳 **60s ± 15s 抖动**，不因 idle 降频（失联发现优先于省写）
- 服务端**覆盖写**一份 agent 记录（永远一行）；D1 每 5 分钟一行
- 任务租约**挂心跳续租**（默认 12h，`LEASE_TTL_S` 可调），agent 一死到期自动可被接手，不需要独立检测器

### 告警（自动上/自动下）

| 规则 | 阈值 |
|---|---|
| 失联 | `> 10 min` |
| 磁盘将满 | `used ≥ 90%` 或 `free < 2 GB` |
| 内存吃紧 | `≥ 90%` 持续 10 分钟 |
| CPU 打满 | `≥ 95%` 持续 15 分钟 |
| 任务卡住 | 进度 30 分钟未变且 `busy` |
| 基线落后 | `git_head ≠ 最近广播 target`（淡提示，不报警） |

---

## 9. 管理端

### 信息架构

```
总览（所有可见项目一屏 6 列）
  └─ 项目页：交付箱 / 广播台 / 名册 / 台账
       └─ 抽屉：单条详情 + 危险操作
```

### 信息密度规则（硬约束）

- 表格默认 **3–6 列**，其余进抽屉
- 长文本默认**折一行**，点 `＋` 展开
- 正常值**灰字**，仅异常上色
- 空闲 agent 整行降透明度
- 危险按钮不与普通按钮同排，放抽屉底部二次确认
- 空状态一句话，不铺占位图

### 可见性配置

```
设置 → 数据范围
  ◉ 所有项目（默认）
  ○ 仅指定项目  [x] 偃师  [ ] 夜半  …
```

存 `admin_policy(scope='*', mode, projects_json)`，面板与 `hubctl` 共用。

---

## 10. SDK（Python / TS / Rust）

### 单源

`spec/openapi.yaml` + `spec/conformance/cases.json` + `spec/conformance/run.py`。**任何语言实现都只是协议客户端**，不许自造字段。命名统一 `snake_case`。

### 能力分档

| 语言 | 档 | 内容 |
|---|---|---|
| Python 3.9+ | A | 心跳线程、events 迭代、upload、submit、任务租约、outbox |
| TypeScript 18+ | A | 同上（Workers 内禁线程，用 `ctx.waitUntil`） |
| Rust 1.75+ | A | 单二进制 `synapse-agent`；Linux 静态 musl 已发布，其它平台由维护者编译 |

**档 A 硬要求**：游标原子落盘、离线 outbox 重放、心跳自动续租。做不到不许标 A。

### 平台差异（真会踩）

| 项 | Linux（当前实现） | macOS / Windows（当前实现） |
|---|---|---|
| CPU / load | `/proc/stat` 差值、`/proc/loadavg` | 无采集，`degraded=true` |
| 内存 | `/proc/meminfo` + cgroup v2 | 无采集，`degraded=true` |
| 磁盘 | `df -BG` | `df` 参数不兼容，通常为空 |
| 游标原子写 | temp + `rename` | Python `os.replace`；Rust temp + rename |
| 配置目录 | `~/.synapse-agent`（Python 可 `SYNAPSE_STATE_DIR` 覆盖） | 同一路径；Rust 用 `HOME`，Windows 用 `USERPROFILE` |

采集失败不崩：`load.degraded = true`，面板标"数据不全"。
macOS / Windows 的资源采集是**后续平台补丁**，不是已实现能力；编译通过不等于指标完整。

### 一致性测试（发布门槛）

`spec/conformance/run.py` 当前有 7 个语言无关用例（心跳、游标、幂等、上传/提交、outbox、租约、广播+ack+supersedes）。**全绿才进 releases**。

---

## 11. 安装与鉴权

### 一条命令

```bash
curl -fsSL https://synapse.wangda.today/dl/install.sh | sh -s -- \
  --endpoint https://synapse.wangda.today --project yanshi --token '<TOKEN>' --agent doubao-client
```

`install.sh`：识别 `uname -s/-m`；当前只接受 `linux-x64`，下载静态 musl 二进制并从 `.sha256` 边车或
`x-sha256` 头动态校验；校验通过后 `synapse-agent init`（写配置 chmod 600）→ systemd 用户服务（可用时）→ `status`。
**非 Linux x64 直接报错退出，不在客户端 pip/cargo，也不在本机编译。**其它平台由维护者按 `BUILD.md` 编译后手动接入。

### token 生命周期

| 动作 | 细节 |
|---|---|
| 签发 | 明文只显示一次；库中只存 `sha256` |
| 绑定 | `agent_id` + `project` + scopes |
| 轮换 | 默认 `rotate:true`：签发新 token 时立即吊销同 agent 旧 token；`rotate:false` 才保留多钥 |
| 吊销 | 立即 401，SDK 打印明确原因并停止重试 |

### 安全约束

1. token 永不进日志（只显示前 6 位）
2. 拒绝明文 `http`（`127.0.0.1` 调试例外）
3. 配置优先级：CLI > 环境变量 > 配置文件
4. SDK 在心跳里上报 `sdk_version`；服务端记录并对比 `SDK_VERSION`，旧版或未上报时发定向升级提醒（每天每版本一次），但不做强制版本拒绝

---

## 12. 集成者工具

| 场景 | 工具 |
|---|---|
| 日常看一眼 | 面板 |
| 取交付箱 | 面板"下载/打包" 或 `python3 scripts/hubctl get <id> --to dir` |
| 合并后通知 | `python3 scripts/hubctl broadcast --target <sha> --ack`（CI 里跑） |
| 加入/迁移项目 | `python3 scripts/hubctl agent-move --from <p> --to <p> --agent <id> [--keep-source]` |
| 自动化消费 | `synapse.admin.AdminClient`（只认 `HUB_ADMIN_TOKEN`） |

**`hubctl` 命令 → API 一一对应**，不发明新概念。CI 示例：

```yaml
- run: hubctl broadcast --project yanshi --target "$(git rev-parse --short HEAD)" \
        --title "main 已到 $(git rev-parse --short HEAD)" --ack \
        --broadcast-id "bc-$(date +%Y%m%d%H%M)"
```

显式 `broadcast_id` ⇒ Action 重跑不会重复广播。

---

## 13. 部署

```toml
[[durable_objects.bindings]]  PROJECT_ROOM
[[migrations]] new_sqlite_classes = ["ProjectRoom"]
[[d1_databases]] DB
[[r2_buckets]] BLOBS
[triggers] crons = ["* * * * *"]
```

步骤：`wrangler d1 create` → `wrangler d1 execute --file worker/schema.sql` → `wrangler r2 bucket create` → `wrangler secret put SESSION_SECRET` → `wrangler deploy` → Access 保护 `/console*` 与 `/console/admin/*`。

**cron 每分钟**：逐项目回收过期租约（并发限 3）。

---

## 14. 失败模式

| 场景 | 后果 | 对策 |
|---|---|---|
| agent 崩溃在任务中 | 任务永锁 | 默认 12h 租约 + cron 回收 + `task.reclaimed` |
| 管理员在 agent 做工时转派/取回 | 已完成工作被判越权 | 有效租约默认 409 `task_active_lease`；`force:true` 才覆盖，并向旧 owner 定向发停止通知 |
| 消息重复投递 | 重复产出 | `dedupe_key` 双端去重 |
| 处理一半崩溃 | 产出残缺 | 游标只在成功后前移 |
| 长任务漏拍 | 假 offline | `late` 中间档 + 抖动 |
| 心跳风暴 | DO 尖峰 | 抖动 + 限流 60/min |
| 两个 agent 改同一文件 | 后合冲突 | 系统不管，摆清 `base_sha`；广播新 HEAD 后后者重交 |
| 补丁基于旧 base | 外部合并冲突 | 抽屉显示"已前进 N commit" |
| 大文件上传中断 | 半截 blob | 上传完成才建 submission |
| 项目刷爆 | 别人拿不到 | 每项目配额 + 429 |
| 心跳时钟不准 | 时间戳乱 | 服务端盖章 |

---

## 15. 验收清单

1. 两项目并行，token 互不可用；seq 各自独立
2. 拔网 30s 重连，inbox 不丢条，cursor 只在处理后前移
3. 同一 `submission_id` 连发两次 ⇒ 箱中一条
4. 48 MB bundle 下载后 sha256 与 manifest 一致
5. 含 `AKIA…` 的补丁 ⇒ 422 + 告警
6. 广播后 30s 内三 agent ack 变绿；离线者 10 分钟后被催
7. 心跳 60s 一拍，名册从 `unknown` 60s 内变 `alive`
8. 停掉一个 agent，租约到期后其任务可被他人 claim
9. `visibility.mode=list` 时，越界项目在面板与 CLI 均 403
10. Python/TS/Rust 三 SDK 均通过 7 个一致性用例（`spec/conformance/run.py`）

---

## 16. 分期

| 期 | 范围 | 产出 |
|---|---|---|
| P1 | 项目/令牌/心跳/名册 | 能安装、能看到谁活着 |
| P2 | 交付箱（上传 + 三态） | 只读 agent 能交补丁 |
| P3 | 广播 + ack + 点收 | 基线变更通知闭环 |
| P4 | 面板（总览 + 项目页 + 可见性） | 日常可用 |
| P5 | TS / Rust SDK + hubctl + 一致性测试 | 多语言接入 |

---

## 17. 决策记录（ADR）

| # | 决策 | 理由 | 否决项 |
|---|---|---|---|
| D1 | 一项目一 DO | 单线程 ⇒ 递增 seq + 免锁 CAS | KV 做锁（最终一致，禁止） |
| D2 | 不用 Queues | 消费者必须常驻，而 agent 会休眠 | Queues |
| D3 | pull 为主，WS 只给面板 | agent 无公网入口 | Webhook 推送 |
| D4 | 合并不入系统 | 集成者在外部完成 | 内置 review/merge 状态机 |
| D5 | 署名不保证 | 由集成者决定 | 强制 `format-patch --from` |
| D6 | 心跳不进消息流 | 防刷屏 | 每条心跳都 append |
| D7 | 心跳 60s 不降频 | 失联发现优先 | idle 3 分钟一拍 |
| D8 | 历史保留 14 天 | 才看得出磁盘趋势 | 7 天 |
| D9 | 跨项目广播逐项目写 | 保持 seq 独立性 | 全局序列 |
| D10 | R2 不跨项目去重 | 去重会带来越权读 | 全局内容寻址 |
| D11 | SDK 仅 Python/TS/Rust | 维护成本可控 | Go / Shell 全套 |
| D12 | admin 走 CLI/API 而非 SDK | 权限边界 | 单一 SDK 全包 |
| D13 | 可见性策略存 D1 并可配 | 面板即配置 | 写死代码 |

---

## 18. 已知未决

1. 是否做**单进程原生多项目**客户端（当前必须多实例隔离状态目录）
2. 是否需要项目级 operator（多个人分管不同项目）
3. 交付箱保留期 30/180 天是否够（可改永久 + 手动清）
4. 每 agent 每日交付配额（默认 20 份）是否放宽
5. macOS / Windows 的 Rust 资源采集仍为降级实现，需要平台补丁

## 19. 长连接（WebSocket）

### 19.1 目标

把“空闲时每 2–5 秒一次空请求”压到 0，同时把消息到达从秒级降到百毫秒级。

### 19.2 接入方式

| 主体 | 凭证 | 路径 |
|---|---|---|
| agent | 一次性 ticket（90s、用过即废） | `GET /p/{p}/ws-ticket` → `GET /p/{p}/ws?ticket=` |
| 控制台 | Access 会话 cookie（`hub_sess`） | 同路径，不带 ticket |

不用 Bearer 直连的原因：WebSocket 握手不能自定义 header（浏览器尤其），token 塞 URL 会进日志与代理记录。

### 19.3 服务端形态

```
agent ──WS──► Worker（验票/验会话）──► DO
                                       ├─ acceptWebSocket（hibernation，空闲不计费）
                                       └─ append() 后遍历在线连接推送
```

- 推送点在 `append()`，因此 `publish / broadcast / send` 都会即时到达在线 agent；
- 离线 agent 仍靠游标补拉，两条路径并存，WS 不是唯一通道；
- DO 单实例持有连接集合，断线只是连接消失，不影响消息落库。

### 19.4 断线与降级

- 客户端退避重连（1→2→4→…→30s），重连后按游标补拉断线期间消息；
- 游标错位自愈：发现 `max(seq) < 本地游标`（换 DO 命名空间后 seq 归零）就归零重拉；
- 握手失败/环境不支持 WebSocket → SDK 自动回退轮询，行为与无 WS 时一致。

### 19.5 实测

| 路径 | 结果 |
|---|---|
| agent 侧 `Loop` | 唤醒 0.4–0.9s（含管理端发送耗时） |
| 控制台 | 收到推送后 400ms 防抖刷新，顶栏显示 `● 实时` |
| Rust | 收到任务后约 0.6s 打印并自动回执 |

### 19.6 回声过滤

广播语义下，agent 自己发的消息也会出现在自己的收件箱里。若 handler 采用“收到就回一条”，
就会自己回复自己，几十秒可刷出数十条。因此 SDK 在收件入口统一丢弃
`sender == 自身 && to 为空` 的消息；定向消息（`to` 含自己）不受影响。

### 19.7 移动端布局约定

- 弹层结构为「固定标题栏 + 独立滚动体」：`.sheet` 纵向 flex，`.sheetHead` 不参与滚动，`.sheetBody` 负责滚动；
- 高度一律用 `dvh` 并配 `box-sizing:border-box`，避免 `100vh` 含地址栏导致内容顶到状态栏；
- canvas 的 CSS 高度必须显式钉住（否则位图属性 `height×dpr` 会把它放大 2–3 倍）；
- 首屏不立即连 WS：等 `current`（项目名）确定后再连，否则 URL 拼不全，徽标会假性停在“轮询”；
- 未连上时点击徽标 = 重试，而不是切换到轮询。

### 19.8 控制台可观测性

- 徽标显示 `● 实时` 或 `○ 轮询·<原因>`，点击即切换传输方式，选择存 `localStorage.hub.live`；
- 「更新页面」= 注销 SW + 清 Cache + `?reset=1` 重载，专治 PWA 缓存；
- `GET /p/{p}/wsstat` 返回在线连接数，用于区分“浏览器没连上”和“服务端没推”。

### 19.9 注意

HTTP/3 不解决推送问题：CF 边缘已提供 h3（`alt-svc`），但 h3 只是传输层优化，没有应用层推送。


## 20. 项目参与与 token 迁移（当前实现）

### 20.1 为什么不是 membership 表

系统没有全局 membership 表。一个 agent 的“参与项目”在存储上表现为：
同一 `agent_id` 在不同项目的 `agents` 表里各有一行（各自独立的 token、scopes、过期时间）。
这保证：

- 一个 token 跨项目请求必然 403；
- 每个项目的 seq、消息、交付、配额互相隔离；
- 项目删除/归档不会误删另一个项目的成员。

### 20.2 管理面动作

| 动作 | API | 结果 |
|---|---|---|
| 签发同项目新钥 | `POST /admin/agents`（`rotate` 缺省 true） | 旧钥立即吊销，返回新明文一次 |
| 加入项目 | `POST /admin/agents/move` + `keep_source:true` | 目标项目新增同 `agent_id` token；源 token 保留 |
| 迁移项目 | `POST /admin/agents/move` + `keep_source:false` | 目标项目新增 token；源 token 立即吊销 |
| 吊销 | `DELETE /admin/agents` | 该项目该 agent 的全部未吊销 token 失效 |

### 20.3 客户端配合

- 加入：源、目标各一个实例；源实例继续用旧 token，目标实例用新 token。
- 迁移：停掉源实例；目标实例用新 token 启动；旧实例继续重试只会得到 401。
- 隔离方式：Python `SYNAPSE_STATE_DIR`；Rust `HOME`；TypeScript `stateDir`。
- 不要共用默认 `~/.synapse-agent/config.json`；第二次 `init` 会覆盖第一份配置。

### 20.4 面板位置

Agent 详情页「项目参与」：

- `#dMoveTo`：目标项目下拉（排除当前项目）
- `#dJoinProject`：加入项目
- `#dMoveProject`：迁移项目
- 成功后 token 显示在 `#dToken`，带复制按钮；提示会说明源 token 是否仍有效。
