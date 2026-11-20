export interface Env {
  PROJECT_ROOM: DurableObjectNamespace;
  DB: D1Database;
  BLOBS: R2Bucket;
  SESSION_SECRET: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  HEARTBEAT_PERIOD_S: string;
  LEASE_TTL_S: string;
  MAX_SUBMISSION_MB: string;
}

export interface Msg {
  seq: number;
  project?: string;
  sender: string;
  topic: "announce" | "task" | "artifact" | "report" | "ack" | "status" | "alert" | "admin";
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
  /** released = 执行侧已交付放手、但仍有交付未被管理侧取走；取完最后一件才转 done */
  state: "open" | "claimed" | "released" | "done" | "blocked";
  owner: string | null;
  lease_until: number;
  /** state = released 时尚未取走的交付数；其余状态为 0 或缺省 */
  pending_submissions?: number;
  base_sha?: string;
  paths?: string[];
}
