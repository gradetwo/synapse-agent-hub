-- D1 免费额度治理（2026-11-22）：管理台高频轮询的两个全表扫描。
-- 线上实测 /admin/stats 一次 rows_read=3914（hb_hist 全表），
-- 15~30 秒刷新一天可读 6.6M 行，超过 D1 Free 5M rows/day，随后所有鉴权查询 500 → CF 1101。
-- 本迁移只加索引，不改数据；可重复执行。
--
-- 部署：npx wrangler d1 execute agent_hub --remote --file worker/migrations/20261122-d1-quota-indexes.sql

-- /admin/stats: bucket 范围过滤；覆盖 project/agent_id，避免回表
CREATE INDEX IF NOT EXISTS idx_hb_bucket_cover
  ON hb_hist(bucket, project, agent_id);

-- /admin/analytics: project IN (...) + ts >= 最近 7 天
CREATE INDEX IF NOT EXISTS idx_archive_project_ts
  ON archive(project, ts);

-- /admin/analytics + 交付箱: project + created_at / state
CREATE INDEX IF NOT EXISTS idx_submissions_project_created
  ON submissions(project, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_project_state
  ON submissions(project, state);

-- 名册/配额查询：project + 活跃条件；表小，但避免每次全表
CREATE INDEX IF NOT EXISTS idx_agents_project_active
  ON agents(project, revoked_at, expires_at);
