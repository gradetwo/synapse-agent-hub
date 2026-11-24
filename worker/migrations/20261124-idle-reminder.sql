-- 普通 agent 空闲提醒：项目配置 + 每个 agent 的空闲/提醒/上榜状态。
CREATE TABLE IF NOT EXISTS idle_reminder_config (
  project            TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 1,
  idle_after_s       INTEGER NOT NULL DEFAULT 600,
  followup_after_s   INTEGER NOT NULL DEFAULT 600,
  message            TEXT NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_idle (
  project            TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  idle_since_ms      INTEGER NOT NULL DEFAULT 0,
  reminded_at        INTEGER NOT NULL DEFAULT 0,
  flagged_at         INTEGER NOT NULL DEFAULT 0,
  last_task_list_ms  INTEGER NOT NULL DEFAULT 0,
  last_issue_list_ms INTEGER NOT NULL DEFAULT 0,
  last_active_ms     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_idle_flagged
  ON agent_idle (project, flagged_at);
