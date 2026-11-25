# tmux 多 agent 一键拉起

脚本：`scripts/tmux-agent-fleet.sh`

用途：在同一个 Linux 用户、同一个 tmux server 下，批量创建多个隔离的
Synapse agent。每个 agent 有自己的：

- tmux pane（`windows` 布局下一个 window 一个 pane）
- `--config-dir` 状态目录
- `agent_id` / token
- 后台 `synapse-agent run`
- 自己的 `SKILL.md`、`capabilities.json` 和 `run` 日志

不会把配置写进默认的 `~/.synapse-agent`；状态目录默认是
`~/.synapse-agent/fleet/<session>/`。

## 1. 准备 token

服务端按 `agent_id` 区分身份，因此**每个 agent 要有自己的 token**。二选一：

### 已有 token 文件

```text
agent-a=0123456789abcdef...
agent-b=fedcba9876543210...
```

行格式是 `agent_id=token`；也可以按顺序只写 token，此时 agent id 由
`--agent-prefix` 和 `--count` 生成。不要把 token 写进脚本或聊天记录。

### 用管理员 token 现场签发

```bash
export SYNAPSE_ADMIN_TOKEN='<admin token>'
# 或者把它们放进 600 权限文件：
# printf '%s\n' '<admin token>' > ~/.synapse-admin-token
```

脚本会对每个 agent 调 `POST /x/admin/agents` 签发 token。admin token
只从环境变量或 `--admin-token-file` 读取，不放在命令行。

## 2. 拉起

```bash
./scripts/tmux-agent-fleet.sh up \
  --count 3 \
  --session yeban-fleet \
  --command 'codex' \
  --project yeban \
  --endpoint https://synapse.wangda.today \
  --tokens-file ~/.synapse-tokens.txt
```

默认 `--layout windows`：每个 agent 一个 tmux window；也可以：

```bash
--layout panes          # 同一 window 里 split 成 N 个 pane（tiled）
```

`--command` 是每个 pane 里启动的 TUI 命令。脚本会给它设置以下环境变量：

- `SYNAPSE_AGENT_ID`
- `SYNAPSE_AGENT_DIR`
- `SYNAPSE_AGENT_PROJECT`
- `SYNAPSE_AGENT_PANE`
- `SYNAPSE_SKILL_PATH`
- `SYNAPSE_CAPABILITIES_PATH`

脚本执行顺序：

1. 每个 agent 独立 `synapse-agent init --config-dir <dir> ...`
2. 创建 tmux session / pane
3. `tmux-config --target <pane>`，再单独 `tmux-config --verify <0|1>`
4. 在 pane 里启动 `--command`
5. 等待 TUI ready（固定 `--startup-wait`，或 `--ready-regex`）
6. 向 pane 发一条 bootstrap 消息，告诉 agent 自己的 ID、状态目录、
   `SKILL.md`/`capabilities.json` 位置，以及“只处理发给自己的任务”
7. 启动每个 agent 的后台 `synapse-agent run`

**第 6 步在第 7 步之前**：避免 run 先把任务注入一个还不知道自己身份的 TUI。
bootstrap 后 run 才接管收件。

## 3. 脚本不会做的事

- 不自动分配 tmux pane/window 名称以外的业务身份；`agent_id` 仍要唯一。
- 不把多个 agent 放进同一个 `--config-dir`。
- 不启动第二个 run 到同一个状态目录；`run.lock` 会拒绝。
- 不把普通 shell 当 TUI：如果 `--command` 是 `bash`/`sh`，bootstrap 会被
  shell 当命令执行。此时用 `--no-bootstrap`，或让命令启动真正的 TUI。
- 不支持多行 `--command`；TUI 命令请写成一行。

## 4. 查看 / 停止

```bash
tmux attach -t yeban-fleet
./scripts/tmux-agent-fleet.sh down --session yeban-fleet
```

`down` 会先停止各 agent 的 `run.pid`，再关闭 tmux session；加
`--keep-session` 只停 run、保留窗口。

日志在 `~/.synapse-agent/fleet/<session>/logs/`：

```text
agent-a.run.log
agent-a.init.log
agent-a.tmux-config.log
agent-a.bootstrap.log
```

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| session 已存在 | 换 `--session`，或先 `down` |
| 状态目录已有 `config.json` | 换 session/state-root，避免复用旧游标和 WAL |
| `init` 失败 | 看 `logs/<agent>.init.log`；常见是 token/project/网络 |
| bootstrap 输不进去 | 检查 TUI 是否 ready；用 `--ready-regex` 或调大 `--startup-wait` |
| run 立即退出 | 看 `logs/<agent>.run.log`；常见是 token、`run.lock`、WS/网络 |
| TUI 不回显 | alternate-screen TUI 用 `--tmux-verify 0`（脚本默认就是 0） |
