-- S1/S2/S4：交付绑定审计 + accepted/approved 裁决中间态
-- 单次执行；已加过列的库不要重复跑 ALTER（D1 会报 duplicate column）。
ALTER TABLE submissions ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE submissions ADD COLUMN reviewed_at INTEGER;
ALTER TABLE submissions ADD COLUMN reviewed_by TEXT;
ALTER TABLE submissions ADD COLUMN task_assignee TEXT;
ALTER TABLE submissions ADD COLUMN overtake INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN overtake_reason TEXT;

-- 旧自由文本 result 回填裁决态；非枚举文本一律保留为 pending，避免把人工评语误判成裁决。
UPDATE submissions
   SET review_state = CASE
     WHEN result LIKE 'approved%' THEN 'approved'
     WHEN result LIKE 'accepted%' THEN 'accepted'
     WHEN result LIKE 'rejected%' THEN 'rejected'
     ELSE 'pending'
   END
 WHERE review_state = 'pending';

CREATE INDEX IF NOT EXISTS idx_submissions_task_review
  ON submissions (project, task_id, review_state, created_at DESC);
