-- 普通 agent 新增公共任务池 / open Issue 的只读发现权限。
-- 只补缺失项，已有自定义 scope 不重排、不删除。
UPDATE agents
SET scopes = trim(
  COALESCE(scopes, '') ||
  CASE WHEN instr(',' || COALESCE(scopes, '') || ',', ',tasks.read,') = 0
       THEN ',tasks.read' ELSE '' END ||
  CASE WHEN instr(',' || COALESCE(scopes, '') || ',', ',issues.read,') = 0
       THEN ',issues.read' ELSE '' END,
  ','
)
WHERE revoked_at IS NULL;

UPDATE enrollments
SET scopes = trim(
  COALESCE(scopes, '') ||
  CASE WHEN instr(',' || COALESCE(scopes, '') || ',', ',tasks.read,') = 0
       THEN ',tasks.read' ELSE '' END ||
  CASE WHEN instr(',' || COALESCE(scopes, '') || ',', ',issues.read,') = 0
       THEN ',issues.read' ELSE '' END,
  ','
)
WHERE status = 'pending';
