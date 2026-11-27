/** 空闲提醒默认值；管理台可按项目覆盖。 */
export const IDLE_AFTER_DEFAULT_S = 600;
export const IDLE_FOLLOWUP_DEFAULT_S = 600;
export const IDLE_ONLINE_MS = 120_000;
export const IDLE_DEFAULT_MESSAGE =
  "你已在线且连续 {idle_minutes} 分钟名下没有任务，也没有查看任务池或 Issue。" +
  "请立即 GET {task_endpoint} 领取公共任务，或用 POST {issue_endpoint} 上报你发现的缺口；" +
  "再过 {followup_minutes} 分钟没有任何主动调用会被管理台标记。";

export interface Env {
  PROJECT_ROOM: DurableObjectNamespace;
  DB: D1Database;
  BLOBS: R2Bucket;
  SESSION_SECRET: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** 允许直接进入管理台的 Access 邮箱，逗号分隔；留空时使用内置默认管理员。 */
  ADMIN_EMAILS?: string;
  HEARTBEAT_PERIOD_S: string;
  /** claim 租约秒数；缺省/非法时 12h；旧部署遗留值 120 按 12h 处理。 */
  LEASE_TTL_S: string;
  MAX_SUBMISSION_MB: string;
  /** S2：校验 base/merged 提交是否真实存在；留空则跳过远端存在性检查。 */
  GITHUB_REPO?: string;
  /** S2：仓库默认分支，缺省 main；用于 main 前进检测。 */
  GITHUB_BRANCH?: string;
  GITHUB_TOKEN?: string;
}

/** 客户端实时事件：与消息共用 seq，但语义稳定、可直接按 type 订阅。 */
export interface ClientEvent {
  id: string;
  version: 1;
  source: "synapse-agent-hub";
  project: string;
  type: string;
  seq: number;
  ts: string;
  actor: string;
  to: string | string[] | null;
  task_id?: string;
  submission_id?: string;
  state?: string;
  review_state?: string;
  data: Record<string, unknown>;
}

export interface Msg {
  seq: number;
  project?: string;
  sender: string;
  topic: "announce" | "task" | "artifact" | "submission" | "report" | "ack" | "status" | "alert" | "admin" | "issue" | "system";
  kind: string;
  payload: unknown;
  dedupe_key?: string;
  to?: string;
  ts: string;
}

export interface Task {
  task_id: string;
  /** 兼容旧记录；新记录只写 task_id */
  id?: string;
  title?: string;
  body?: string;
  /** released = 执行侧已交付放手、但仍有交付未被管理侧取走；取完最后一件才转 done；
   *  failed = 已达最大失败次数、进入死信，不再自动派发，需管理端显式重试 */
  state: "open" | "claimed" | "released" | "done" | "blocked" | "failed";
  owner: string | null;
  lease_until: number;
  /** 调度优先级：0=P0 最高，3=P3 最低；默认 P2。排队 30 分钟提升一级，避免饿死。 */
  priority?: number;
  /** 截止时间（epoch ms）；逾期任务提升到 P0，并在可观测面板计入 SLA 违约。 */
  deadline_at?: number | null;
  /** 首次被 claim 的时间，用于区分“排队等待”和“执行耗时”。 */
  claimed_at?: number;
  /** 自动重试上限，默认 3；达到后进 failed/dead_letter。 */
  max_attempts?: number;
  /** 已失败次数；手动重试会重置为 0，并累加 manual_retries。 */
  attempts?: number;
  last_error?: string | null;
  last_failed_at?: number;
  /** 下一次可重新派发的时间；未来时间内的任务不参与 promoteQueue。 */
  next_retry_at?: number | null;
  dead_letter?: boolean;
  dead_lettered_at?: number;
  manual_retries?: number;
  retried_at?: number;
  /** state = released 时尚未取走的交付数；其余状态为 0 或缺省 */
  pending_submissions?: number;
  /** 指派目标；空表示公共池，可被任意 agent claim */
  to?: string | null;
  /**
   * 定向任务的派发状态。state 仍表示任务生命周期；dispatch_state 只表示
   * “是否已经下发到目标窗口/循环”，用于单飞队列。
   * queued: 已创建但未下发；notified: 已下发消息、尚未 claim；
   * active: 已被目标 agent claim；closed: 已释放/关闭/完成，不再占并发槽。
   */
  dispatch_state?: "queued" | "notified" | "active" | "closed";
  /** 同一条任务第几次下发；每次重新下发递增，用于消息去重。 */
  dispatch_count?: number;
  notified_at?: number;
  project?: string;
  created_at?: number;
  updated_at?: number;
  created_by?: string;
  /** 由 issue 派发出的任务；任务 done 时用于回写 issues.status=closed */
  issue_id?: string | null;
  closed_at?: number;
  closed_by?: "agent" | "admin" | "collection";
  reclaimed_at?: number;
  reclaimed_from?: string | null;
  reassigned_at?: number;
  reassigned_from?: string | null;
  blocked_at?: number;
  /** 最近一次 blocked 释放的原因；由 release 或后续 report 回填，供节点/管理台判断。 */
  blocked_reason?: string;
  /** 发起 blocked 的 agent；管理侧挂起时由管理端写入。 */
  blocked_by?: string | null;
  /** 解除阻塞的条件（自由文本），例如“等 fix/xxx 合入 main”。 */
  unblock_when?: string | null;
  /** 合入回写：READY 补丁落到 main 后的提交与时间；只由管理端/CI 回写。 */
  merged_sha?: string | null;
  merged_at?: number;
  merged_by?: string | null;
  merged_branch?: string | null;
  merge_note?: string | null;
  /** 退回公共池审计：从哪个定向节点退回、何时。 */
  requeued_at?: number;
  requeued_from?: string | null;
  base_sha?: string;
  paths?: string[];
}
