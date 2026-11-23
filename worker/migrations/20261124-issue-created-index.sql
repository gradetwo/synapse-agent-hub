-- Issue 上报节流查询：WHERE project = ? AND created_at > ?。
-- CREATE INDEX 可重复执行；只加索引，不改数据。
CREATE INDEX IF NOT EXISTS idx_issues_project_created
  ON issues(project, created_at);
