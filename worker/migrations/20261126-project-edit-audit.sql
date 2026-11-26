-- 项目管理：可修改项目显示名/状态/配额，并记录管理员变更审计。
-- 部署：npx wrangler d1 execute agent_hub --remote --file worker/migrations/20261126-project-edit-audit.sql
ALTER TABLE projects ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE projects ADD COLUMN updated_by TEXT;
ALTER TABLE projects ADD COLUMN updated_at INTEGER;
UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS project_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'admin',
  at          INTEGER NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_project_audit_project_at
  ON project_audit(project, at DESC);
