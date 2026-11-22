-- 存量 agent 补齐任务领取/完成权限；可重复执行，不产生重复 scope。
UPDATE agents
SET scopes = CASE
  WHEN scopes LIKE '%tasks.claim%' AND scopes LIKE '%tasks.release%' THEN scopes
  WHEN scopes LIKE '%tasks.claim%' THEN scopes || ',tasks.release'
  WHEN scopes LIKE '%tasks.release%' THEN scopes || ',tasks.claim'
  ELSE scopes || ',tasks.claim,tasks.release'
END
WHERE role = 'agent' AND revoked_at IS NULL;
