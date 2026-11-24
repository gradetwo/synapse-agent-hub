-- 旧默认值是 20；只把仍在使用旧默认值的项目抬到 200，保留手工设置的其他配额。
UPDATE projects SET max_agents = 200 WHERE max_agents = 20;
