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
  state: "open" | "claimed" | "done" | "blocked";
  owner: string | null;
  lease_until: number;
  base_sha?: string;
  paths?: string[];
}
