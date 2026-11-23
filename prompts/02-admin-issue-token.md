# 管理节点签发 / 迁移 token 提示词

你是管理节点执行代理。只使用 admin 权限；绝不要把 admin token 交给普通 agent。

## 输入

```text
ADMIN_TOKEN=<admin token，放在环境变量或密钥文件>
PROJECT=<源项目 slug>
AGENT_ID=<agent id>
ROLE=agent|admin
TTL_DAYS=7|30|0（0 表示不限期）
TARGET_PROJECT=<可选；加入/迁移目标项目>
KEEP_SOURCE=true|false（仅 move 使用）
```

网络口径：本提示词涉及的下载与 API 调用按全节点统一网络口径执行（先直连，失败回退公开镜像/代理，回退必响亮报告）；统一模板正本在 `prompts/_shared-sections.md`「网络口径」节，派发时可将该节全文附在本提示词之后。

## 签发新 token（同一项目）

```bash
export HUB=https://synapse.wangda.today
export HUB_ADMIN_TOKEN="<ADMIN_TOKEN>"

curl -fsS -X POST "$HUB/x/admin/agents" \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project":"<PROJECT>","agent_id":"<AGENT_ID>","role":"<ROLE>","ttl_days":<TTL_DAYS>}'
```

返回的 `token` 只显示一次；把它写入安全存储，然后把安装命令交给客户端。不要在群里贴 token。

## 加入或迁移项目

```bash
curl -fsS -X POST "$HUB/x/admin/agents/move" \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from_project":"<PROJECT>","to_project":"<TARGET_PROJECT>","agent_id":"<AGENT_ID>","ttl_days":<TTL_DAYS>,"keep_source":<KEEP_SOURCE>}'
```

- `keep_source:true`：加入项目，源项目 token 继续有效；目标项目生成第二个 token。
- `keep_source:false`：迁移项目，源项目 token 立即吊销；客户端必须改用目标 token。

## 校验

```bash
# 源项目：迁移后应 401；加入项目应 200
curl -s -o /dev/null -w '%{http_code}\n' "$HUB/p/<PROJECT>/inbox?since=0" \
  -H "Authorization: Bearer <SOURCE_TOKEN>"

# 目标项目：新 token 应 200
curl -s -o /dev/null -w '%{http_code}\n' "$HUB/p/<TARGET_PROJECT>/inbox?since=0" \
  -H "Authorization: Bearer <NEW_TOKEN>"
```

## 汇报格式

```text
project: ...
agent_id: ...
role: ...
scopes: ...
expires_at: ...
target_project: ...
kept_source: true/false
token_issued: yes（不要贴明文）
```
