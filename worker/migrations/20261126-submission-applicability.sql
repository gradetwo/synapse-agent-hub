-- 0077：交付基线适用性 + 失效补丁修正链。
-- 单次执行；已加过列的库不要重复跑 ALTER（D1 会报 duplicate column）。
ALTER TABLE submissions ADD COLUMN apply_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE submissions ADD COLUMN apply_target_sha TEXT;
ALTER TABLE submissions ADD COLUMN apply_checked_at INTEGER;
ALTER TABLE submissions ADD COLUMN apply_checked_by TEXT;
ALTER TABLE submissions ADD COLUMN apply_engine TEXT;
ALTER TABLE submissions ADD COLUMN apply_result_json TEXT;
ALTER TABLE submissions ADD COLUMN supersedes_id TEXT;
ALTER TABLE submissions ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_submissions_apply
  ON submissions (project, state, apply_state, created_at DESC);
