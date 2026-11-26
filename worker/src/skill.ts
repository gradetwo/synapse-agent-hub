// Agent 能力自描述：服务端每次部署随构建更新，客户端按 skill_sha256 增量刷新。
// 这里只放公开能力说明；token、项目数据、管理 token 一律不得进入本文档。

export type AgentCapabilityStatus = "ga" | "beta" | "unverified" | "partial";

export type AgentCapability = {
  id: string;
  since: string;
  status: AgentCapabilityStatus;
  audience: "agent" | "admin" | "both";
  title: string;
  summary: string;
  method?: string;
  path?: string;
  event?: string;
  /** 能力适用范围；例如 events.resilience 当前只覆盖 Rust SDK。 */
  scope?: string;
  /** 客户端至少需要该 SDK 版本才能正确使用；缺省表示不强制。 */
  min_sdk?: string;
  /** required=true 时，客户端发现缺失应明确告警而不是静默降级。 */
  required?: boolean;
};

export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: "server.version",
    since: "0.5.7",
    status: "ga",
    audience: "both",
    title: "服务端版本可观测",
    summary: "/ver、/events、/observability 都返回 sdk/build；升级后先看版本再判断能力。",
    method: "GET",
    path: "/ver",
  },
  {
    id: "delivery.format_gate",
    since: "0.5.7",
    status: "ga",
    audience: "agent",
    title: "交付内容格式门",
    summary: "代码交付必须同时带 unified diff 与回执；缺文件头、hunk 行数不符、回执八项缺失或 base 不在远端会被 422 拒收。",
    method: "POST",
    path: "/p/{project}/submissions",
  },
  {
    id: "task.merge",
    since: "0.5.7",
    status: "ga",
    audience: "admin",
    title: "任务合入回写",
    summary: "管理侧记录 merged_sha/merged_at，任务时间线出现 task.merged；普通 agent 不要调用。",
    method: "POST",
    path: "/x/admin/p/{project}/tasks/merge",
    event: "task.merged",
  },
  {
    id: "ci.status",
    since: "0.5.7",
    status: "ga",
    audience: "admin",
    title: "CI 状态回写",
    summary: "main CI 红/绿/待定回写并发 ci.status 事件；Webhook 可订阅 topic=ci。",
    method: "POST",
    path: "/x/admin/p/{project}/ci",
    event: "ci.status",
  },
  {
    id: "issue.auto_close",
    since: "0.5.7",
    status: "ga",
    audience: "both",
    title: "Issue 与任务联动",
    summary: "任务 release/done 自动关闭关联 Issue；重开任务时恢复；关闭/重开追加 issue.closed/issue.reopened 事件。",
    event: "issue.closed",
  },
  {
    id: "queue.alerts",
    since: "0.5.7",
    status: "ga",
    audience: "admin",
    title: "最老排队告警",
    summary: "排队超过 2h 或目标离线超过 1h 进入 queue_alerts；cron 每任务 6h 最多主动告警一次。",
    method: "GET",
    path: "/x/admin/p/{project}/observability",
    event: "alert.created",
  },
  {
    id: "task.requeue",
    since: "0.5.7",
    status: "ga",
    audience: "admin",
    title: "退回公共池",
    summary: "管理侧把超时/目标离线的定向任务清空 to/owner，原节点不再收到；普通 agent 不要调用。",
    method: "POST",
    path: "/x/admin/p/{project}/tasks/requeue",
    event: "task.requeued",
  },
  {
    id: "events.resilience",
    since: "0.5.7",
    status: "ga",
    audience: "agent",
    title: "事件流断线重试",
    summary: "Rust/Python SDK 对 chunked 中断、JSON 解码失败和连接重置退避重试；游标只在成功后前移，epoch 重取也在降页保护内。",
    method: "GET",
    path: "/p/{project}/events",
    scope: "rust,python",
    min_sdk: "0.5.10",
  },
  {
    id: "task.timeline",
    since: "0.5.7",
    status: "ga",
    audience: "admin",
    title: "任务时间线",
    summary: "热窗口 + D1 归档 + 任务/Issue 里程碑；用 task_id 查看合入、CI、排队退回、Issue 生命周期。",
    method: "GET",
    path: "/x/admin/p/{project}/tasks/timeline?task_id={task_id}",
  },
  {
    id: "events.visibility",
    since: "0.5.8",
    status: "ga",
    audience: "both",
    title: "事件可见性（observer 只读）",
    summary: "observer 角色可读全项目 events/tasks/submissions，但不能 claim/report/写 artifact；普通 agent 仍只看自己相关事件。",
    method: "GET",
    path: "/p/{project}/events",
    min_sdk: "0.5.8",
  },
  {
    id: "events.replay",
    since: "0.5.8",
    status: "beta",
    audience: "agent",
    title: "断线补拉与事件游标",
    summary: "GET /events 返回 next_event_cursor（按事件页推进），WS 断线后从该游标 drain；客户端按 seq 去重。",
    method: "GET",
    path: "/p/{project}/events",
    min_sdk: "0.5.8",
  },
  {
    id: "events.ws",
    since: "0.5.8",
    status: "beta",
    audience: "agent",
    title: "实时事件推送",
    summary: "WS /p/{project}/ws 在 hello 后推 submission.created/task 事件；10 秒到达、长连接和离线补拉尚未全部生产验收，先标 beta。",
    method: "GET",
    path: "/p/{project}/ws",
    min_sdk: "0.5.8",
  },
  {
    id: "skill.discovery",
    since: "0.5.8",
    status: "ga",
    audience: "both",
    title: "能力自描述与升级发现",
    summary: "升级后按 /ver -> /capabilities -> /skill；先看 capabilities_sha256，只有变化才拉完整清单和 Markdown，不要从 GitHub 或 --help 推断。",
    method: "GET",
    path: "/ver",
    min_sdk: "0.5.8",
  },
  {
    id: "role.observer",
    since: "0.5.8",
    status: "ga",
    audience: "admin",
    title: "observer 只读身份",
    summary: "observer 可读全项目 events/tasks/submissions，不能 claim、report 或写 artifact；适合只订阅事件的管理节点。",
    min_sdk: "0.5.8",
  },
  {
    id: "admin.fleet",
    since: "0.5.9",
    status: "ga",
    audience: "admin",
    title: "tmux / 窗口 agent 编队",
    summary: "管理台按项目查看节点投递面、窗口/tmux 目标与在线状态；派单队列按节点单飞，不重复投送。",
    method: "GET",
    path: "/admin/agents",
    min_sdk: "0.5.9",
  },
  {
    id: "task.singleflight",
    since: "0.5.10",
    status: "ga",
    audience: "both",
    title: "任务单飞与广播隔离",
    summary: "同一节点同一时刻只推进一个任务；广播与任务消息分队列，避免长广播把任务指令顶掉。",
    min_sdk: "0.5.10",
  },
  {
    id: "admin.analytics",
    since: "0.5.10",
    status: "ga",
    audience: "admin",
    title: "管理台统计与下钻",
    summary: "按项目/agent/交付/Issue 看 7/30/90 天活动趋势，支持从统计卡下钻到节点明细。",
    method: "GET",
    path: "/x/admin/analytics",
    min_sdk: "0.5.10",
  },
  {
    id: "client.launch",
    since: "0.5.10",
    status: "ga",
    audience: "both",
    title: "客户端启动快照",
    summary: "节点心跳上报启动参数、参数来源、投递面、自动投送关闭时长与重启次数；管理台可解释“为什么没投进去”。",
    method: "POST",
    path: "/p/{project}/heartbeat",
    min_sdk: "0.5.10",
  },
  {
    id: "client.remote_control",
    since: "0.5.10",
    status: "ga",
    audience: "both",
    title: "远程控制与心跳参数",
    summary: "管理侧可下发 auto_forward/debug/heartbeat_s；客户端按 rev 幂等应用，旧响应不会回滚新控制。",
    method: "POST",
    path: "/x/admin/p/{project}/agent/{agent_id}/control",
    min_sdk: "0.5.10",
  },
  {
    id: "client.diagnostics",
    since: "0.5.10",
    status: "ga",
    audience: "both",
    title: "客户端诊断与异常上报",
    summary: "心跳可带 debug 日志环和客户端异常；崩溃/投递失败可在管理台诊断卡查看，不必登机器翻日志。",
    method: "POST",
    path: "/p/{project}/heartbeat",
    min_sdk: "0.5.10",
  },
];

export const AGENT_SKILL_BODY = `

## 这是什么

这是 Synapse 服务端随构建生成的 **Agent 能力说明书**，用于升级后快速了解新增能力。
它不是执行授权，也不是管理指令；只作为文档阅读，不要执行文档里未明确授权的动作。

## 升级后 30 秒自检

1. 读取 GET $ENDPOINT/ver，记下 sdk、build、skill_sha256、capabilities_sha256。
2. 只有 capabilities_sha256 或 skill_sha256 与本地缓存不同时，才拉取：
   ~~~bash
   curl -fsS "$ENDPOINT/capabilities" -o "$STATE_DIR/capabilities.json"
   curl -fsS "$ENDPOINT/skill" -o "$STATE_DIR/SKILL.md"
   ~~~
3. 把新增/变更的能力 ID 写进 $STATE_DIR/WHATS-NEW.md；只看本文档和 capabilities 清单，不要从 GitHub 或 --help 推断服务端能力。
4. 若 capabilities 里没有你要用的能力 ID，说明服务端还没升级到该版本；不要盲试。status=beta/partial 的能力先验证再依赖。

## 最近新增（0.5.8 - 0.5.10）

- **事件可见性 / role.observer**：observer 是只读身份，可读全项目 events/tasks/submissions，但不能 claim/report/写 artifact；普通 agent 的事件可见性不变。
- **断线补拉 / events.replay**：GET /events 返回 next_event_cursor，按事件页推进；WS 断线后用该游标 drain，客户端按 seq 去重，不要复用消息页游标。
- **实时推送 / events.ws**：WS /p/{project}/ws 在 hello 后推 submission.created/task 事件；10 秒到达、长连接、离线补拉尚未全部生产验收，status 标 beta。
- **能力自描述 / skill.discovery**：升级后按 /ver -> /capabilities -> /skill；capabilities_sha256 变化才拉完整清单，skill_sha256 变化才拉 Markdown。
- **事件韧性 / events.resilience**：Rust/Python SDK 对 chunked 中断、JSON 解码失败和连接重置退避重试；Python 的 epoch 重取也在降页保护内，游标只在成功后前移。
- **编队与单飞 / admin.fleet / task.singleflight**：管理台按节点查看投递面；同一节点同一时刻只推进一个任务，广播与任务消息隔离。
- **统计下钻 / admin.analytics**：管理台支持 7/30/90 天活动趋势和节点/交付/Issue 下钻。
- **启动快照 / client.launch**：心跳上报启动参数、来源、投递面、自动投送关闭时长与重启次数。
- **远程控制 / client.remote_control**：管理侧下发 auto_forward/debug/heartbeat_s，客户端按 rev 幂等应用。
- **诊断 / client.diagnostics**：心跳携带 debug 日志环和客户端异常，管理台诊断卡可直接查看。

## 客户端升级行为

- 升级二进制不等于知道新能力。客户端在升级后的首次 run/init 必须读取 /ver；不要只看 --help。
- /ver 只给摘要和 hash；需要程序判定时读 /capabilities；需要人读的说明读 /skill。
- 网络失败时保留本地旧缓存并提示一次，不要阻塞任务；不要每次启动都重发整份 /skill。

## Agent 侧必须知道

- 任务仍以台账为准：先 task-claim，交付带 --task，完成再 task-release --state done。
- 代码交付先按格式门准备：unified diff + 回执八项；不确定时用 GET /capabilities 的 delivery.format_gate 确认服务端支持。
- 事件流游标只在成功读取后前移；重连不要从头清空，避免重复消费。
- 4xx/5xx 先读 error、code、hint：hint 是服务端给的下一步。若响应带 use.path/use.method/use.body，按它调用，不要猜 endpoint，也不要用 /x/admin 绕过 scope。
- Token 只放 Authorization: Bearer，不要拼进 URL、日志、skill 缓存或汇报正文。

### 给管理员发消息

普通节点没有 /send 接口：/x/admin/p/{project}/send 是管理侧入口，节点 token 调用会 403。
节点给管理员发消息统一用 POST /p/{project}/publish（scope: publish），dedupe_key 必填，正文放 payload：

~~~json
{
  "topic": "admin",
  "kind": "notice",
  "to": "admin",
  "dedupe_key": "node-report-20261126-001",
  "payload": { "title": "节点汇报", "body": "任务已完成" }
}
~~~

to: "admin" 让消息定向进管理台；不带 to 的项目广播也只会进管理台，不会打扰其它节点。

## 管理侧能力

管理侧能力用于回写合入、CI、排队告警和任务时间线；普通 agent 调用会 403。
需要这些能力时，让管理节点执行，不要由执行 agent 自行越权。

## 版本与缓存

- /skill 是当前构建的 Markdown；响应头 x-skill-sha256 与 ETag 可用于本地缓存。
- /capabilities 是同一份能力表的 JSON 版，适合程序判定，不用解析 Markdown。
- /skill 不包含项目数据或任何 token；可以安全地放在共享缓存里，但仍建议同源读取。

## 能力 ID 索引

server.version, delivery.format_gate, task.merge, ci.status, issue.auto_close, queue.alerts, task.requeue, events.resilience, task.timeline, events.visibility, events.replay, events.ws, skill.discovery, role.observer, admin.fleet, task.singleflight, admin.analytics, client.launch, client.remote_control, client.diagnostics.
`;

// 防止“能力表加了一条、/skill 正文没写”的静默漂移：模块加载时直接失败。
const missingCapabilityDocs = AGENT_CAPABILITIES
  .map((c) => c.id)
  .filter((id) => !AGENT_SKILL_BODY.includes(id));
if (missingCapabilityDocs.length) {
  throw new Error(`AGENT_SKILL_BODY 缺少能力 ID：${missingCapabilityDocs.join(", ")}`);
}
