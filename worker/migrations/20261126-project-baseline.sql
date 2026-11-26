-- 项目级基线仓库配置；NULL/空表示继承 Worker 环境变量 GITHUB_REPO / GITHUB_BRANCH。
-- 部署：npx wrangler d1 execute agent_hub --remote --file worker/migrations/20261126-project-baseline.sql
ALTER TABLE projects ADD COLUMN github_repo TEXT;
ALTER TABLE projects ADD COLUMN github_branch TEXT;
