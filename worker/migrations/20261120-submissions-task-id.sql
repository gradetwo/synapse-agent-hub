-- 交付与任务联动（2026-11-20）：submissions 记录所属任务。
-- release 时 DO 按 (project, task_id, state='delivered') 查待取数；
-- collect/archive 后 Worker 回调 DO，released 任务待取归零即收成 done。
-- 部署：scripts/deploy.sh --migration worker/migrations/20261120-submissions-task-id.sql
ALTER TABLE submissions ADD COLUMN task_id TEXT;
