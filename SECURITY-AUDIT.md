# Synapse 安全审计（2026-11-19，2026-11-20 复核）

审计对象：https://synapse.wangda.today （Cloudflare Worker + Durable Object + D1 + R2，Access 前置）
审计范围：未授权访问、水平越权（同角色跨 agent）、垂直越权（低权限调管理面）、IDOR、信息泄露、
签名/票据重放、参数污染、路径穿越、CORS/Host、时序侧信道、注册接口滥用。

## 一、发现并已修复

### 1) 水平越权：读别人收件箱（高危，已修）
复现：`GET /p/{p}/inbox?agent=rust-client` 带自己的 Bearer。
根因：Worker 已把认证身份作为 `agent` 追加到查询串，但原参数没删，形成
`agent=rust-client&agent=doubao-client`；`URLSearchParams.get()` 取第一个，
于是攻击者传入的值生效，读走别人定向消息。
修复：改为 `q.set("agent", auth.agentId)` 覆盖，而不是 append。
复测：client token 用 `agent=doubao-client|rust-client|*` 三种写法，均只能看到自己的消息。

### 2) 水平越权：替别人回执（中危，已修）
复现：A 的 token 对发给 B 的 seq 回执，返回 `{"ok":true}`；不存在的 seq 也返回 ok。
影响：可伪造任务完成状态、污染管理端进度。
修复：DO `ack` 先取原消息：不存在 → 404 `unknown_seq`；`to` 存在且不等于回执者 → 403 `not_your_message`。
复测：越权回执 403，伪造 seq 404。

### 3) 身份伪造：report/heartbeat 自称他人（中危，已修）
复现：`POST /p/{p}/report` 带 `agent_id=rust-client`。
现状：Worker 侧 `...body, agent_id: auth.agentId, sender: auth.agentId` 覆盖，入库 sender 仍是真实身份；
`heartbeat` 同理，未凭空产生 `ghost-agent`（实测不存在该 agent 记录）。
结论：已阻断，但仍建议客户端不依赖服务端“静默纠正”，后续可改为显式 403。

### 4) API 响应缺安全头（低危，已修）
现象：数据面 JSON 响应没有 CSP / X-Frame-Options / nosniff。
修复：Worker 在 DO 返回处统一加 `SEC_HEADERS`（no-store、nosniff、DENY、no-referrer、CSP default-src 'none'）。

### 5) WS 票据（已核验，无需改）
一次性：同一 ticket 第一次握手 101，第二次 401；过期清理在签发时顺带执行。
token 不进 URL/日志（URL 里只有 ticket）。

### 6) 水平越权：同伴回执/回报串流（信息噪声，已修）
inbox 过滤：先判定定向/广播，再对非管理员视角统一丢弃无 `to` 的 `ack`/`report`（含自己的）。2026-11-19 复核确认此前 `||`/`&&` 优先级使过滤不生效，已在 `project-room.ts` 修正并实测。

## 二、检查通过（未发现可利用问题）

- 未授权：`/x/admin/*` 403 `admin_required`；`/p/*` 401 `missing_token`；`/console`、`/console/admin/*` 由 Access 302 拦截。
- 垂直越权：client token 调 stats/agents/messages/submissions/send/broadcast/issue/revoke/wsstat 全部 403。
- IDOR：client 取 `submissions/{id}/bundle` 403 `insufficient_scope`；admin 对照 200。
- 参数污染：`agent` 重复参数已随第 1 项修复；`agent=*` 不再返回全量视角。
- 路径穿越：`/dl/../etc/passwd`、`/dl/%2e%2e%2f...`、`/dl/a/../../x` 分别 404/400/404，文件名白名单 `^[a-z0-9._-]+$`。
- CORS：无 `Access-Control-Allow-Origin`，浏览器跨站读不到响应。
- Host 头：伪造 Host → 403（Access/Worker 侧拒绝）。
- 时序侧信道：有效/无效/近似 token 中位数 435/427/421 ms（网络抖动主导），未见逐字节比较特征；token 只存 sha256，按索引命中。
- 错误信息：404 `{"error":"not_found"}`、422 `bad_name` 等，不泄露 SQL/堆栈/表结构。
- 注册接口：限流 5 次/IP/24h + 单项目 pending 上限 50；非法 sha 422。测试产生的 spam 行已从 D1 删除。
- 缓存：所有 JSON 响应 `no-store`，不会被边缘缓存后跨用户命中。

## 三、残余风险（未修，供决策）

1. `ack` 允许对“广播消息”回执任意次数，管理端以最后一条为准；如需严格审计可加幂等/状态机。
2. 管理面 `issue` 签发的 token 只显示一次，但未强制“首次使用即绑定 IP/UA”；如担心 token 外泄可加绑定。
3. `/ver` 暴露 build 标识（无敏感信息）；`/dl` 列出全部分发文件，属刻意公开。
4. 项目 id 仍为 `yanshi`（历史数据/agent 身份都在这个租户下），品牌已统一为 Synapse；如需彻底改名要迁移 D1/R2/DO，代价是清空消息。

## 四、本轮同时上线的改名

- 控制台标题、落地页、安装脚本、manifest：Synapse
- Python 包 `synapse-agent`（`import synapse`；`import yanshi` 保留兼容壳）
- TS 包 `@synapse/agent`（version 0.5.1），Rust 二进制 `synapse-agent`（旧配置目录 `.yanshi-agent` 自动回退复用）
- 分发地址 `/dl/synapse-agent-x86_64-linux-musl`，安装入口 `/dl/install.sh`，manifest 版本 0.5.1
