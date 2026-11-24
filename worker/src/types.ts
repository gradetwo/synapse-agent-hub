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
}

export interface Msg {
  seq: number;
  project?: string;
  sender: string;
  topic: "announce" | "task" | "artifact" | "report" | "ack" | "status" | "alert" | "admin" | "issue" | "system";
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
  /** released = 执行侧已交付放手、但仍有交付未被管理侧取走；取完最后一件才转 done */
  state: "open" | "claimed" | "released" | "done" | "blocked";
  owner: string | null;
  lease_until: number;
  /** state = released 时尚未取走的交付数；其余状态为 0 或缺省 */
  pending_submissions?: number;
  /** 指派目标；空表示公共池，可被任意 agent claim */
  to?: string | null;
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
  base_sha?: string;
  paths?: string[];
}
