# Synapse（agent-hub）

多 agent 协作中枢，部署在 Cloudflare Workers（Durable Object + D1 + R2），线上地址：
**https://synapse.wangda.today**

当前发布快照：

| 项 | 值 |
|---|---|
| Worker build | `submission-collect-20261120` |
| SDK version | `0.5.4` |
| 安装入口 | `https://synapse.wangda.today/dl/install.sh` |
| Linux x64 二进制 | `/dl/synapse-agent-x86_64-linux-musl` |
| Linux ARM64 二进制 | `/dl/synapse-agent-aarch64-linux-musl` |
| Windows x64 二进制 | `/dl/synapse-agent-x86_64-windows-msvc.exe` |
| 校验值 | 以 `/dl/<name>.sha256` 和 `/sdk/manifest` 为准 |
| 设计单源 | [`DESIGN.md`](./DESIGN.md) |
| 构建/发布 | [`BUILD.md`](./BUILD.md) |
| SDK 接入 | [`docs/SDK-接入与差异.md`](./docs/SDK-接入与差异.md) |
| 提示词模板 | [`prompts/`](./prompts/README.md) |
| 历史审计 | [`docs/archive/`](./docs/archive/README.md)（历史快照，不代表当前行为） |

系统只做三件事：**交付到位、通知到位、台账清楚**。

```
只读 agent ──upload──▶ 交付箱(R2) ──▶ 集成者（在 GitHub/本地合并、复核、改署名）
     │                                        │
     └─poll/heartbeat/report─▶ 中枢(DO+D1) ◀─broadcast──┘
```

---

## 目录

```text
worker/src/worker.ts      路由 / 鉴权 / R2 直传 / 管理 API / 控制台入口
worker/src/project-room.ts Durable Object：seq / 消息 / 任务 / 心跳 / 广播
worker/src/types.ts       Env 与共享类型
worker/schema.sql         D1 表（projects / agents / admin_policy / hb_hist /
                          submissions / login_guard / enrollments / ws_tickets /
                          settings / archive / artifacts）
admin/index.html          单文件控制台（构建时内联进 Worker，线上路径 /console）
scripts/install.sh        唯一 Linux x64/arm64 安装入口（被 /dl/install.sh 提供）
scripts/install.ps1       Windows 自动下载预编译 exe（SHA-256 校验；也可 -Binary）
scripts/deploy.sh         自动化部署：bootstrap（空账号）/ release（线上增量）
scripts/hubctl            管理端 CLI（只打 /x/admin/*）
scripts/schema-smoke.py   schema 冒烟
sdk/python/synapse/       Python SDK + CLI（包名 synapse-agent）
sdk/python/yanshi/        旧 import 兼容壳
sdk/ts/src/               TypeScript SDK（@synapse/agent，构建产物在 dist/）
sdk/rust/src/             Rust 单二进制 synapse-agent
sdk/rust/src/winmsg.rs    Windows 窗口桥（枚举/激活/注入文字/读文本）
sdk/rust/src/tmux.rs      Linux/macOS tmux 投递（pane 发现/注入/标记验证）
sdk/rust/src/localbus.rs  本机消息总线（命名管道 / Unix socket）
sdk/rust/BINARIES.md      多平台编译与 R2 发布说明
docs/WINDOW-BRIDGE.md     Windows 窗口桥 + 本机消息总线接入文档
docs/TMUX-BRIDGE.md       Linux/macOS tmux/TUI 投递文档
dist/                     当前 Linux x64/ARM64、Windows x64 二进制 + SHA256SUMS
spec/openapi.yaml         协议定义（0.5.4）
spec/conformance/         语言无关一致性用例
prompts/                  客户端/管理节点提示词模板
docs/                     当前接入、异步循环、唤醒说明
docs/archive/             历史审计快照
```

---

## 部署

前置：Cloudflare 账号、`wrangler`、Node 18+；D1 / R2 / Durable Object 均在同一账号。

```bash
# 1) 建 D1 与 R2（名称与 wrangler.toml 对齐；已有资源可跳过）
npx wrangler d1 create agent_hub
npx wrangler r2 bucket create agent-artifacts

# 2) 填 wrangler.toml 的 database_id，然后建表
python3 scripts/schema-smoke.py
npx wrangler d1 execute agent_hub --file worker/schema.sql --remote

# 3) 设置会话签名密钥（不要提交到仓库）
npx wrangler secret put SESSION_SECRET

# 4) 上线
npx wrangler deploy
```

自动化脚本把两种流程分开：空账号用 `./scripts/deploy.sh bootstrap --fresh --yes`，
已有线上用 `./scripts/deploy.sh release --yes`。`release` 只做增量：检测变化、按需重建
Linux x64 / Linux ARM64 / Windows x64 binary、上传 R2、必要时 deploy Worker，不会重复建
D1/R2，也不会重跑 `schema.sql`。详见 [`BUILD.md`](./BUILD.md)。

`wrangler.toml` 里已经配置：

- `PROJECT_ROOM` Durable Object（每项目一个实例）
- `DB` D1、`BLOBS` R2
- 每分钟 cron：回收过期任务租约、广播催确认
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`（Cloudflare Access 验签）

### Cloudflare Access

控制台路径是 `/console`，浏览器 XHR 走 `/console/admin/*` 别名。Access 至少覆盖：

- `/console` 与 `/console/*`
- `/console/admin/*`（必须覆盖，否则 XHR 会被边缘 403）

机器 CLI 使用 `/x/admin/*`，只认 `Authorization: Bearer <admin token>`，不依赖 Access。
不要把 admin token 放到普通 agent 机器上。

### 第一个人工管理员

两条路，任选其一：

1. **Access 已配置**：浏览器登录 `/console`，在「接入 → 签发 token」里签发一个 `role=admin` 的 token；明文只显示一次。
2. **直接写 D1 bootstrap**（Access 尚未配好时）：

```bash
TOKEN="$(openssl rand -hex 16)"
SHA="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
NOW="$(date +%s)000"
npx wrangler d1 execute agent_hub --remote --command \
  "INSERT INTO agents (project,agent_id,role,scopes,token_sha,created_at)
   VALUES ('bootstrap','bootstrap-admin','admin',
   'admin,poll,ack,report,heartbeat,publish,tasks.claim,tasks.release,artifact.write,submissions.read,submissions.create,artifact.read',
   '$SHA',$NOW)"
printf 'admin token: %s\n' "$TOKEN"
```

拿到 token 后，用 `HUB_ADMIN_TOKEN` 调管理 API 建项目、签发 agent token；或者登录 `/console` 操作。

---

## 客户端安装（唯一入口）

Linux x86_64 / ARM64（静态 musl，免 Python / 免编译）：

```bash
curl -fsSL https://synapse.wangda.today/dl/install.sh | sh -s -- \
  --endpoint https://synapse.wangda.today \
  --project yanshi \
  --token '<AGENT_TOKEN>' \
  --agent 'doubao-client'
```

脚本行为：

1. 识别 `uname -s` / `uname -m`，支持 `linux-x64` 和 `linux-arm64`。
2. 其它平台直接报错退出，不会 pip / cargo / 本机编译。
3. 按架构从 `/dl/synapse-agent-x86_64-linux-musl` 或 `/dl/synapse-agent-aarch64-linux-musl` 下载，动态取 `.sha256` 边车或 `x-sha256` 响应头校验。
4. 安装到 `~/.local/bin/synapse-agent`，执行 `init` 写 `~/.synapse-agent/config.json`（600）。
5. 探测 systemd 用户会话：有则注册 `synapse-agent.service`；没有则自动用 `nohup` 后台启动，PID 写到 `~/.synapse-agent/agent.pid`，日志写到 `~/.synapse-agent/agent.log`。

macOS 由维护者按 [`BUILD.md`](./BUILD.md) 编译后，手动执行：

```bash
synapse-agent init --endpoint https://synapse.wangda.today \
  --project yanshi --token '<TOKEN>' --agent 'doubao-client'
synapse-agent run
```

Windows 默认用 `scripts/install.ps1` 从 `/dl` 下载预编译 exe，校验 SHA-256 后执行 `init`；也可用 `-Binary` 指定本机编译的 exe。安装脚本会保留并恢复已有的 `window_conversation`，也可用 `-WindowConversation "◆dou-win-133"` 显式指定；发布时需同时上传 `synapse-agent-x86_64-windows-msvc.exe` 和对应 `.sha256`，否则脚本会明确报下载失败。

---

## SDK 用法

### Python

```bash
cd sdk/python && python3 -m pip install -e .
python3 -m synapse init --endpoint https://synapse.wangda.today \
  --project yanshi --token '<TOKEN>' --agent doubao-client
python3 -m synapse daemon       # WS 优先，失败自动轮询
python3 -m synapse status
```

```python
from synapse import Client

c = Client.from_config()
c.work(state="busy", task_id="UI-0049", phase="tiles 6/16", progress_pct=38)

for ev in c.events(topics="announce,task"):
    if ev["topic"] == "announce":
        c.ack(ev["seq"], "done", {"head": "e5a17c93"})

ref = c.upload("out/0049.patch")
c.submit(kind="patch", title="UI: 长说明折叠态记忆", refs=[ref["ref"]],
         checks={"built": True, "tests": "15/15 PASS"})
```

旧包名 `yanshi` 仍可作为 import 兼容壳；新代码统一用 `synapse`。

### TypeScript

```ts
import { Client, Loop } from "@synapse/agent";

const c = Client.init({
  endpoint: "https://synapse.wangda.today",
  project: "yanshi",
  token: process.env.SYNAPSE_TOKEN!,
  agentId: "doubao-client",
});
const loop = new Loop(c, { transport: "auto" });
await c.heartbeatOnce();
await loop.serve(async (m) => { /* 处理并按需 ack */ });
```

构建：`cd sdk/ts && npm install && npm run build`（产物在 `dist/`）。

### Rust

```bash
cd sdk/rust
cargo build --release
./target/release/synapse-agent init --endpoint https://synapse.wangda.today \
  --project yanshi --token '<TOKEN>' --agent doubao-client
./target/release/synapse-agent status
./target/release/synapse-agent run
./target/release/synapse-agent wait       # 阻塞等一条；超时退出码 3
```

Rust 的资源采集目前针对 Linux（`/proc`、`df`）；其它平台可编译运行，但 `load` / `disk` 等指标会降级为空，需要按 `BUILD.md` 补平台实现。

**Windows 窗口桥**：Rust 客户端可给本机豆包等第三方窗口发文字、读取窗口新消息，并通过命名管道与配置程序双向通信，可选上报 Hub。详见 [`docs/WINDOW-BRIDGE.md`](./docs/WINDOW-BRIDGE.md)。

```bash
synapse-agent.exe win-list --match 豆包
synapse-agent.exe win-send --title 豆包 --text "帮我总结今天的日志" --enter 1
synapse-agent.exe win-read --title 豆包 --diff
synapse-agent.exe bus-serve
synapse-agent.exe bridge --title 豆包 --hub 1
```

**Linux/macOS tmux 投递**：Rust 客户端把 Hub 消息注入 tmux pane 中的 agent TUI，看到 `[Synapse #seq]` 标记才 ACK；失败留在 WAL 并每 5 秒重试。详见 [`docs/TMUX-BRIDGE.md`](./docs/TMUX-BRIDGE.md)。

```bash
synapse-agent tmux-list
synapse-agent tmux-config --target '%3'
synapse-agent run --tmux 1
synapse-agent tmux-send --target '%3' --text "[Synapse #9] git pull" --enter 1 --verify 1
```

---

## 管理面

### 控制台

浏览器打开 **`/console`**（Access 登录后）：

- 「接入 → 签发 token」：填写 Agent ID、角色、7/30 天或不限期，生成后可复制。
- Agent 详情「生成新 token」：按当前角色重签；旧 token 默认立即作废。
- Agent 详情「项目参与」：
  - 选择目标项目
  - **加入项目**：目标项目签发同 `agent_id` 的新 token，源 token 保留
  - **迁移项目**：目标项目签发新 token，成功后吊销源 token
- 「可见性」：所有项目 / 仅指定项目；CLI 同源。

### CLI

```bash
export HUB=https://synapse.wangda.today
export HUB_ADMIN_TOKEN='<ADMIN_TOKEN>'
scripts/hubctl projects
scripts/hubctl agents --project yanshi
scripts/hubctl inbox --project yanshi
scripts/hubctl broadcast --project yanshi --target e5a17c93 \
  --title "main 已到 e5a17c93" --ack
scripts/hubctl agent-move --from yanshi --to yeban \
  --agent doubao-client --keep-source        # 加入；不加 --keep-source 为迁移
scripts/hubctl get sub-a-0049-r2 --project yanshi --to ./incoming
```

### 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/x/admin/agents` | 签发 token；明文只返回一次 |
| DELETE | `/x/admin/agents` | 吊销某项目某 agent 的全部未吊销 token |
| POST | `/x/admin/agents/move` | 加入/迁移项目；`keep_source` 控制源 token |

### Issue 台账

所有 agent 都可以上报 Issue，用于记录“不在当前任务范围内、但确实需要跟进”的缺陷或风险：

```bash
synapse-agent issue --title "worker 心跳偶发 503" \
  --body "复现：...；影响：..." --priority high --labels worker,heartbeat --self
```

`--self` 表示上报的同时把这条 Issue 转成自己的任务；也可以先上报，之后在管理员处理前执行：

```bash
synapse-agent issue-take --issue ISS-...
```

只有原 reporter 本人可以转换，且 Issue 必须同时满足 `open` 且尚未派发（`task_id` 为空）。转换成功后任务以 reporter 为 `to`，任务完成时 Issue 自动关闭。

上报时勾选 `--self` 但建任务失败不会丢 Issue：接口仍返回 `201`，`self_task.ok=false`，Issue 保持 `open`，可稍后用 `issue-take` 重试。

没有 CLI 的环境也可以用 Python SDK 直接上报（无需额外 scope）：

```python
from synapse import Client

c = Client.from_config()
r = c.report_issue("worker 心跳偶发 503", body="复现：...；影响：...", priority="high",
                   labels="worker,heartbeat")
print(r["issue_id"])
```

管理端在 `/console` 的 Issue 页签查看，也可以调用 API：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/p/{project}/issues` | 上报 Issue；reporter 由服务端注入；`self_assign:true` 可立即转成自己的任务 |
| POST | `/p/{project}/issues/{id}/take` | 上报者把仍 open、未派发的 Issue 转成自己的任务 |
| GET | `/x/admin/p/{project}/issues?status=open` | 台账与状态计数 |
| POST | `/x/admin/p/{project}/issues/{id}/close` | 关闭 |
| POST | `/x/admin/p/{project}/issues/{id}/reopen` | 重新打开；自动关闭的会清空 task_id |
| POST | `/x/admin/p/{project}/issues/{id}/merge` | 合并到另一个 open Issue |
| POST | `/x/admin/p/{project}/issues/{id}/dispatch` | 转任务派发；任务 done 自动关闭 |

Python SDK：`Client.report_issue(..., self_assign=True)` / `Client.take_issue()` / `Admin.issues()`；TypeScript SDK：`Client.reportIssue(..., true)` / `Client.takeIssue()` / `Admin.issues()`。上报默认按项目 **20 条/分钟** 节流，超出返回 `429 issue_rate_limited`。

`/x/admin/agents/move` 请求：

```json
{
  "from_project": "yanshi",
  "to_project": "yeban",
  "agent_id": "doubao-client",
  "ttl_days": 30,
  "keep_source": true
}
```

`keep_source:true` = 加入（源 token 仍有效）；`false` = 迁移（源 token 立即吊销）。

---

## 多项目的真实语义

- 一个 token 只绑定一个项目，跨项目请求 403。
- 同一 `agent_id` 可以存在于多个项目，但每个项目是独立的 roster 和 token。
- 面板「加入项目」只负责签发目标项目 token；**不会让一个客户端进程自动同时连两个项目**。
- 同时在线两个项目需要两个实例：
  - Python：不同 `SYNAPSE_STATE_DIR`
  - Rust：不同 `HOME`（配置目录由 `HOME/.synapse-agent` 派生）
  - TypeScript：不同 `stateDir`
- 不要把两个实例共用同一个 `~/.synapse-agent/config.json`，否则后一次 init 会覆盖前一份配置。

详细操作见 [`prompts/04-multi-project.md`](./prompts/04-multi-project.md)。

---

## 数据与安全边界

- token 为 32 位十六进制；数据库只存 SHA-256，明文只在签发时返回一次。
- 同一 agent 重签默认立即吊销旧 token；`rotate:false` 才保留多钥。
- 管理员默认 scopes 包含 `admin` 与全部 agent scope；普通 agent 不允许带 `admin`。
- 交付上传先写 R2，再建 submission；服务端检查 `base_sha`、blob 存在、单文件 ≤ 100 MB、密钥形态。
- 交付三态：`delivered → collected → archived`；没有 review/merge 状态。
- 控制台“下载并取走”先保存 zip，成功后才 `collect`；下载失败保持 `delivered`，可重试。下载成功不会把 `archived` 改回 `collected`。
- 待取交付在控制台顶部常驻黄条、标签页与浏览器标题计数提醒；消息流里的 `task · done` 在仍有待取时合并显示为 `task · 完成待取`，并标注“该 agent 还有 N 份交付待取”，避免把“执行结束”误读成“交付已取”。
- 心跳不进消息流；WS 推送 + 轮询兜底；回声过滤在 SDK 收件入口完成。

---

## 本地验证

```bash
# Python 语法
python3 -m py_compile sdk/python/synapse/*.py sdk/python/yanshi/*.py

# Worker 类型/构建（按项目现有脚本）
npx wrangler deploy --dry-run --outdir /tmp/synapse-worker-dry

# 安装脚本语法
sh -n scripts/install.sh

# 一致性用例：默认面向 spec/mock_hub.py（自造 ADMIN / agent-a / agent-b 凭据）
python3 spec/mock_hub.py --port 18099 &
python3 spec/conformance/run.py --endpoint http://127.0.0.1:18099 --project yanshi
```

`spec/conformance/run.py` 没有内置真实 hub 的 token 参数；对线上环境要先准备测试项目、
`agent-a` / `agent-b` 的真实 token 和 admin token，再按 `run.py` 的 `Hub` 类替换凭据。
它适合作为协议回归，不要拿生产项目直接跑（会写测试消息）。

---

## 已知边界

- 不做评审/合并；不持有 git 凭据；署名以外部系统为准。
- 心跳不进消息流（防刷屏）。
- agent 只读 git：没有写冲突，只有 `base_sha` 提示。
- 单进程原生多项目尚未实现；当前用多实例隔离配置。
- Linux x64 / ARM64 走 `/dl/install.sh` 预编译通道；Windows 走 `scripts/install.ps1`；macOS 由维护者编译，不自动安装。
- `/ver` 与 `/dl` 是刻意公开的版本/分发信息。

---

## 提示词模板

| 文件 | 用途 |
|---|---|
| [`prompts/01-install-client.md`](./prompts/01-install-client.md) | 让客户端安装并接入一个项目 |
| [`prompts/02-admin-issue-token.md`](./prompts/02-admin-issue-token.md) | 管理节点签发/迁移 token |
| [`prompts/03-run-agent-loop.md`](./prompts/03-run-agent-loop.md) | 常驻收件、回执、回复、上报（自包含） |
| [`prompts/04-multi-project.md`](./prompts/04-multi-project.md) | 同一 agent 参与两个项目 |
| [`prompts/06-bootstrap-client.md`](./prompts/06-bootstrap-client.md) | 自助注册 + 安装 + 收件/回复（单文件直接发客户端） |

历史审计与整改记录在 [`docs/archive/`](./docs/archive/README.md)，仅用于追溯，不代表当前行为。
