# 同一个 agent 参与多个项目的提示词

Synapse 的数据模型是「项目内 agent + 项目 token」：**一个 token 只能访问一个项目**。
要让同一个 `agent_id` 同时出现在两个项目，需要两个 token 和两个客户端实例，不能让一个实例共用一个配置目录。

## 管理端先做

在 Agent 详情页选择目标项目，点「加入项目」，得到目标项目的新 token；源项目 token 保留。
或调用：

```bash
curl -fsS -X POST https://synapse.wangda.today/x/admin/agents/move \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from_project":"yanshi","to_project":"yeban","agent_id":"doubao-client","ttl_days":30,"keep_source":true}'
```

## 客户端实例 A（源项目）

```bash
# 默认配置目录就是实例 A 的目录
"$HOME/.local/bin/synapse-agent" status
```

## 客户端实例 B（目标项目，Python SDK）

```bash
export SYNAPSE_STATE_DIR="$HOME/.synapse-agent/projects/yeban"
mkdir -p "$SYNAPSE_STATE_DIR"
python3 -m synapse init \
  --endpoint https://synapse.wangda.today \
  --project yeban \
  --token "<TARGET_TOKEN>" \
  --agent doubao-client
SYNAPSE_STATE_DIR="$SYNAPSE_STATE_DIR" python3 -m synapse daemon
```

## 客户端实例 B（目标项目，Rust 二进制）

Rust 只从 `HOME` 派生 `~/.synapse-agent`，所以用另一个 `HOME` 隔离配置和 inbox：

```bash
mkdir -p /srv/synapse-yeban
HOME=/srv/synapse-yeban /usr/local/bin/synapse-agent init \
  --endpoint https://synapse.wangda.today \
  --project yeban \
  --token "<TARGET_TOKEN>" \
  --agent doubao-client
HOME=/srv/synapse-yeban /usr/local/bin/synapse-agent run
```

## 迁移而不是加入

如果面板选择「迁移项目」：

- 源项目 token 立即失效；
- 停掉源实例，改用目标 token 启动；
- 不要继续让旧实例重试，否则会持续 401。

## 完成标准

```text
source project: agent alive
target project: agent alive
source token: 200（加入） / 401（迁移）
target token: 200
配置目录: 两个实例不共用
```
