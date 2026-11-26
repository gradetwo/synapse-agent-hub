-- 共享层表结构（项目注册 / 令牌 / 历史 / 交付索引）
-- 真源在 Durable Object；这里的表用于管理端查询与长期留档。

CREATE TABLE IF NOT EXISTS projects (
  project         TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',   -- active|paused|archived
  max_agents      INTEGER NOT NULL DEFAULT 200,
  max_storage_mb  INTEGER NOT NULL DEFAULT 2048,
  max_msgs_per_min INTEGER NOT NULL DEFAULT 60,
  retention_days  INTEGER NOT NULL DEFAULT 30,
  created_at      INTEGER NOT NULL
);

-- 令牌：只存 sha256，明文仅在签发时返回一次
CREATE TABLE IF NOT EXISTS agents (
  project     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'agent',        -- agent|admin
  scopes      TEXT NOT NULL,                        -- 逗号分隔
  token_sha   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  expires_at  INTEGER,
  PRIMARY KEY (project, agent_id, token_sha)
);
CREATE INDEX IF NOT EXISTS idx_token ON agents(token_sha);

-- 管理端可见性策略：scope='*' 表示全局策略；也可按 admin 单独配置
--   mode='all'  ⇒ 看全部项目（默认）
--   mode='list' ⇒ 只看 projects_json 里列出的项目
CREATE TABLE IF NOT EXISTS admin_policy (
  scope         TEXT PRIMARY KEY,                   -- '*' 或某 admin 标识
  mode          TEXT NOT NULL DEFAULT 'all',
  projects_json TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL
);

-- 心跳历史：每 5 分钟一行，保留 14 天
CREATE TABLE IF NOT EXISTS hb_hist (
  project       TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  bucket        INTEGER NOT NULL,                   -- floor(ts/300s)
  cpu_pct       INTEGER,
  mem_used_mb   INTEGER,
  mem_total_mb  INTEGER,
  disk_used_pct INTEGER,
  work_state    TEXT,
  PRIMARY KEY (project, agent_id, bucket)
);

-- 交付索引（文件本体在 R2；状态三态：delivered|collected|archived）
CREATE TABLE IF NOT EXISTS submissions (
  project       TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  task_id       TEXT,
  base_sha      TEXT,
  kind          TEXT NOT NULL,
  title         TEXT,
  refs_json     TEXT NOT NULL,
  checks_json   TEXT,
  result        TEXT,
  review_state  TEXT NOT NULL DEFAULT 'pending',
  reviewed_at   INTEGER,
  reviewed_by   TEXT,
  task_assignee TEXT,
  overtake      INTEGER NOT NULL DEFAULT 0,
  overtake_reason TEXT,
  -- 当前基线适用性：unknown|ok|conflict|error；main 前进后由 apply-check 更新
  apply_state   TEXT NOT NULL DEFAULT 'unknown',
  apply_target_sha TEXT,
  apply_checked_at INTEGER,
  apply_checked_by TEXT,
  apply_engine  TEXT,
  apply_result_json TEXT,
  -- 失效补丁修正链：新交付指向旧交付；旧交付标记被谁取代
  supersedes_id TEXT,
  superseded_by TEXT,
  state         TEXT NOT NULL DEFAULT 'delivered',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (project, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_submissions_task_review
  ON submissions (project, task_id, review_state, created_at DESC);

-- 登录失败防护：按 IP 计数 + 阶梯封禁（-1 表示永久）
CREATE TABLE IF NOT EXISTS login_guard (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  first_fail_at INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

-- 自助注册：agent 本地生成 token，只把 sha256 报上来；管理端审批后才进 agents 表
CREATE TABLE IF NOT EXISTS enrollments (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  token_sha   TEXT NOT NULL,
  code        TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  machine     TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|expired
  decided_at  INTEGER,
  decided_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_enr_status ON enrollments(project, status);

CREATE TABLE IF NOT EXISTS ws_tickets (
  ticket   TEXT PRIMARY KEY,
  project  TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role     TEXT NOT NULL,
  exp_ms   INTEGER NOT NULL,
  used     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_exp ON ws_tickets(exp_ms);

-- 运行期键值（会话 epoch 等）。吊销端点依赖此表，缺表会 500
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 消息归档：热窗口之外仍可回读、ack；按 room 分段防止换命名空间后 seq 覆盖
CREATE TABLE IF NOT EXISTS archive (
  project      TEXT NOT NULL,
  room         TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  sender       TEXT NOT NULL DEFAULT '',
  topic        TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT '',
  to_agent     TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           TEXT NOT NULL,
  PRIMARY KEY (project, room, seq)
);
CREATE INDEX IF NOT EXISTS idx_archive_rate ON archive(project, sender, ts);

-- 产物台账：按项目累计字节数，max_storage_mb 依赖此表
CREATE TABLE IF NOT EXISTS artifacts (
  project    TEXT NOT NULL,
  sha        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project, sha)
);

-- D1 配额相关：避免管理台 /admin/stats 与 /admin/analytics 轮询触发全表扫描
CREATE INDEX IF NOT EXISTS idx_hb_bucket_cover
  ON hb_hist(bucket, project, agent_id);
CREATE INDEX IF NOT EXISTS idx_archive_project_ts
  ON archive(project, ts);
CREATE INDEX IF NOT EXISTS idx_submissions_project_created
  ON submissions(project, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_project_state
  ON submissions(project, state);
CREATE INDEX IF NOT EXISTS idx_agents_project_active
  ON agents(project, revoked_at, expires_at);

-- Issue（问题单）：所有 agent 可上报；合并/关闭/重开/派发只走 /admin。
-- 任务完成后由 ProjectRoom 按 task_id / issue_id 自动关闭（closed_by=task）。
CREATE TABLE IF NOT EXISTS issues (
  project      TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',   -- open | closed | merged
  priority     TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
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
CREATE INDEX IF NOT EXISTS idx_issues_project_created
  ON issues(project, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_task
  ON issues(project, task_id);
CREATE INDEX IF NOT EXISTS idx_issues_status
  ON issues(status);
