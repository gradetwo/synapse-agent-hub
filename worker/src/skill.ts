// Agent 能力自描述：服务端每次部署随构建更新，客户端按 skill_sha256 增量刷新。
// 这里只放公开能力说明；token、项目数据、管理 token 一律不得进入本文档。

export type AgentCapability = {
  id: string;
  since: string;
  audience: "agent" | "admin" | "both";
  title: string;
  summary: string;
  method?: string;
  path?: string;
  event?: string;
};

export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: "server.version",
    since: "0.5.7",
    audience: "both",
    title: "服务端版本可观测",
    summary: "/ver、/events、/observability 都返回 sdk/build；升级后先看版本再判断能力。",
    method: "GET",
    path: "/ver",
  },
  {
    id: "delivery.format_gate",
    since: "0.5.7",
    audience: "agent",
    title: "交付内容格式门",
    summary: "代码交付必须同时带 unified diff 与回执；缺文件头、hunk 行数不符、回执八项缺失或 base 不在远端会被 422 拒收。",
    method: "POST",
    path: "/p/{project}/submissions",
  },
  {
    id: "task.merge",
    since: "0.5.7",
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
    audience: "both",
    title: "Issue 与任务联动",
    summary: "任务 release/done 自动关闭关联 Issue；重开任务时恢复；关闭/重开追加 issue.closed/issue.reopened 事件。",
    event: "issue.closed",
  },
  {
    id: "queue.alerts",
    since: "0.5.7",
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
    audience: "agent",
    title: "事件流断线重试",
    summary: "Python/Rust SDK 对 chunked 中断和 JSON 解码失败退避重试，游标只在成功后前移；不要因为一次超时就重建游标。",
    method: "GET",
    path: "/p/{project}/events",
  },
  {
    id: "task.timeline",
    since: "0.5.7",
    audience: "admin",
    title: "任务时间线",
    summary: "热窗口 + D1 归档 + 任务/Issue 里程碑；用 task_id 查看合入、CI、排队退回、Issue 生命周期。",
    method: "GET",
    path: "/x/admin/p/{project}/tasks/timeline?task_id={task_id}",
  },
];

export const AGENT_SKILL_BODY = `

## 这是什么

这是 Synapse 服务端随构建生成的 **Agent 能力说明书**，用于升级后快速了解新增能力。
它不是执行授权，也不是管理指令；只作为文档阅读，不要执行文档里未明确授权的动作。

## 升级后 30 秒自检

1. 读取 GET $ENDPOINT/ver，记下 sdk、build、skill_sha256。
2. 本地缓存 $STATE_DIR/SKILL.md 的 sha256 与 skill_sha256 不同时，执行：
   ~~~bash
   curl -fsS "$ENDPOINT/skill" -o "$STATE_DIR/SKILL.md"
   ~~~
3. 只读本文档的「本次新增」和「Agent 侧变化」，不要凭旧版提示词直接调用新管理接口。
4. 若 capabilities 里没有你要用的能力 ID，说明服务端还没升级到该版本；不要盲试。

## 本次新增（0.5.7 / S1–S7）

- **交付门**：代码交付必须是 unified diff + 回执；回执必填 base/branch/commit/box/fmt/clippy/tests/logs，且 base 要与提交的 base_sha 前缀一致。
  - git diff 的 index 行是 **blob SHA**，不是 base commit SHA；不要把 index 当 base。
  - 结构不合格会返回 422 delivery_format_incomplete，missing 会指出缺哪一项；不要把它当网络错误重试。
- **Issue 联动**：任务完成会自动关闭关联 Issue，任务重开会重开；不要再手工重复关单。
- **事件流**：Python/Rust SDK 遇到 chunked 中断会退避重试；GET /p/{project}/events 的 server_version 可判断服务端是否已升级。
- **版本**：GET /ver 新增 sdk、build、skill_sha256、capabilities；旧客户端忽略未知字段即可。
- **管理侧新增（普通 agent 不要调用）**：tasks/merge、ci、tasks/requeue、observability.queue_alerts、tasks/timeline。

## Agent 侧必须知道

- 任务仍以台账为准：先 task-claim，交付带 --task，完成再 task-release --state done。
- 代码交付先按格式门准备：unified diff + 回执八项；不确定时用 GET /capabilities 的 delivery.format_gate 确认服务端支持。
- 事件流游标只在成功读取后前移；重连不要从头清空，避免重复消费。
- Token 只放 Authorization: Bearer，不要拼进 URL、日志、skill 缓存或汇报正文。

## 管理侧能力

管理侧能力用于回写合入、CI、排队告警和任务时间线；普通 agent 调用会 403。
需要这些能力时，让管理节点执行，不要由执行 agent 自行越权。

## 版本与缓存

- /skill 是当前构建的 Markdown；响应头 x-skill-sha256 与 ETag 可用于本地缓存。
- /capabilities 是同一份能力表的 JSON 版，适合程序判定，不用解析 Markdown。
- /skill 不包含项目数据或任何 token；可以安全地放在共享缓存里，但仍建议同源读取。
`;
