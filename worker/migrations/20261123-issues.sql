-- Issue 台账：状态 open/closed/merged；task_id 用于任务完成后自动关闭。
CREATE TABLE IF NOT EXISTS issues (
  project      TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  priority     TEXT NOT NULL DEFAULT 'normal',
  labels       TEXT NOT NULL DEFAULT '',
  reporter     TEXT NOT NULL,
  task_id      TEXT,
  merged_into  TEXT,
  close_reason TEXT,
  closed_by    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  PRIMARY KEY (project, issue_id)
);
CREATE INDEX IF NOT EXISTS idx_issues_project_status
  ON issues(project, status, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_project_updated
  ON issues(project, updated_at);
CREATE INDEX IF NOT EXISTS idx_issues_task
  ON issues(project, task_id);
CREATE INDEX IF NOT EXISTS idx_issues_status
  ON issues(status);
