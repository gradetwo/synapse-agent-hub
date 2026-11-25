# Linux/macOS tmux 投递（TUI）

> 适用：`synapse-agent` Rust 客户端，Linux / macOS。Windows 用 [`WINDOW-BRIDGE.md`](./WINDOW-BRIDGE.md)。
>
> 多 agent 批量拉起与隔离状态目录见 [TMUX-AGENT-FLEET.md](./TMUX-AGENT-FLEET.md)。

> 目的：`synapse-agent run` 收到 Hub 消息后，直接把正文注入配置好的 tmux pane（通常是正在运行的 agent TUI），并在 TUI 输入框中回车提交；**确认 pane 里出现 `[Synapse #seq]` 标记后才 ACK**，否则消息留在本地 WAL，空闲时每 5 秒重试。

```
Hub ──WS/poll──▶ synapse-agent ──tmux send-keys/paste-buffer──▶ pane（agent TUI）
                       │
                       └─ 未见标记：保留 WAL，不 ACK，5s 后重试
```

---

## 1. 选择目标 pane

先列出当前 tmux server 的 pane：

```bash
synapse-agent tmux-list
```

输出里看 `command`（如 `node` / `python` / `claude`）和 `path`，找到运行 agent TUI 的那一项，记下 `target`（如 `agent:0.0`）或 `pane_id`（如 `%3`）。

也可以直接用 pane id：

```bash
synapse-agent tmux-config --target '%3'
```

`tmux-config --target` 会同时写入 `tmux_target` 并打开 `tmux_forward`。查看/关闭/清除：

```bash
synapse-agent tmux-config --show
synapse-agent tmux-config --enable 0     # 只关闭自动投递，保留目标
synapse-agent tmux-config --clear        # 清除目标和开关
```

配置文件仍是 `~/.synapse-agent/config.json`（600），字段为：

```json
{
  "tmux_target": "%3",
  "tmux_forward": true,
  "role": "agent"
}
```

`role` 只影响本地 TUI 是否接收无收件人的项目广播：普通 agent 保持 `agent`；管理 agent 用 `init --role admin` 或 `SYNAPSE_AGENT_ROLE=admin` 才放行。服务端仍以 token 的 role 为准。

---

## 2. 启动 run

```bash
# 使用 tmux-config 保存的目标
synapse-agent run --tmux 1

# 本次临时指定目标（同时开启）
synapse-agent run --tmux agent:0.0

# 环境变量方式（适合 systemd / launchd / CI）
SYNAPSE_TMUX_TARGET='%3' SYNAPSE_TMUX_FORWARD=1 synapse-agent run

# macOS launchd PATH 不含 Homebrew 时，显式指定 tmux
SYNAPSE_TMUX_BIN=/opt/homebrew/bin/tmux synapse-agent run --tmux 1
```

`--tmux 0` 可显式关闭本次投递。`--window 1` 和 `--tmux ...` 不能同时开启；Linux/macOS 用 tmux，Windows 用窗口桥。

### alternate-screen TUI：关闭标记验证（避免重投风暴）

`deliver` 靠 `capture-pane` 读到 `[Synapse #seq]` 才认为投递成功并 ACK。但 CodeBuddy / Claude 这类
**alternate-screen TUI** 用自绘输入框，`send-keys` 的文字不回显到 tmux pane 缓冲区 → 永远读不到标记 →
WAL 不 ACK、每 5 秒重投 → **同一条消息被反复粘贴进输入框**。表现就是 pane 里同一条消息刷十几遍。

对这类 TUI 关闭标记验证，改为「tmux 注入命令成功即 ACK」，靠 WAL `_window_delivered` + `dedupe_key` 防重：

```bash
synapse-agent tmux-config --verify 0        # 写入 config.json 的 tmux_verify:false，永久生效
# 或临时覆盖：SYNAPSE_TMUX_VERIFY=0 synapse-agent run --tmux 1
# 或单次：synapse-agent run --tmux-verify 0 --tmux 1
synapse-agent tmux-config --show            # 确认 tmux_verify:false
```

代价：不再确认 TUI 真的把文字上屏（只确认 tmux 命令执行成功）。仅用于不回显的 TUI；普通 shell/回显型
TUI 保持默认 `verify=true` 更安全。

---

## 3. 单次诊断

```bash
# 直接往 pane 发一行，不回车
synapse-agent tmux-send --target '%3' --text "hello" --enter 0

# 发带 [Synapse #seq] 标记的正文并验证（会回车）
synapse-agent tmux-send --target '%3' --text "[Synapse #9] git pull" --enter 1 --verify 1

# 发文件 / stdin，避免命令行长度和转义问题
synapse-agent tmux-send --target '%3' --file ./task.txt --enter 1 --verify 1
cat task.txt | synapse-agent tmux-send --target '%3' --stdin --enter 1 --verify 1
```

`tmux-send` 的 `--enter` 默认是 1（粘贴后提交）；只粘贴不提交用 `--enter 0`。

`--verify 1` 会先从 pane 里找正文开头的 `[Synapse #seq]` 标记：标记已存在就不再粘贴（`--enter 1` 时补一次回车，兼容上次只粘贴未提交的重试）；粘贴后看不到标记就不按回车，返回 `verified=false` 并退出 1。

---

## 4. 投递规则

和 Windows 窗口投递共用同一套消息过滤：

- **放行**：`to` 明确指向本 agent 的消息；管理端 `announce` 广播；`role=admin` 的本地投递面额外放行其他管理广播；
- **过滤**：其他 agent 的 `artifact` 交付单、任务板 `claimed/released/done` 生命周期事件、其他普通 agent 的 `issue/announce/report/status` 无收件人广播；
- **任务单飞**：定向任务由服务端按 agent 并发槽排队，一次只发一条 `task`；客户端在 `active_task.json` 存在时不再接收第二条任务，只允许提醒/系统通知插入。任务 `done/released/blocked/failed/reopened/reassigned/requeued` 的 raw 消息或事件帧都会释放本地 active 锁，然后才放行下一条；
- **普通 agent 不接同事广播**：其他普通 agent 发出的无收件人 Issue/Report/Status 只进管理台，普通 agent 的 TUI 不会再被这些内容灌满。

正文格式：

- `run --tmux` 默认把标题/正文**压成一行**再发，避免 TUI 把正文里的换行当成回车提前提交；
- `tmux-send` 不做压缩，带换行的正文走 `paste-buffer -p`（bracketed paste），尽量让 TUI 整体接收；
- 单行正文走 `send-keys -l`，不经过 shell，不会把正文当命令执行；
- `tmux-send --file/--stdin` 的手动多行正文只在支持 bracketed paste 的 TUI 上建议使用，`run` 默认压成单行最稳。

去重与重试：

1. 投递前先 `capture-pane` 查 `[Synapse #seq]`；已存在就不再粘贴，`enter=1` 时补一次回车（兼容只粘贴未提交的重试）；
2. 注入后最多等约 1 秒（5×200ms）；看到完整标记才按回车；只看到 `[Synapse #seq` 局部标记时，说明文字已进输入区，只补回车、不再重复粘贴；
3. 完全看不到标记就**不按回车**，返回失败；`run` 保留 WAL、不 ACK，空闲重试线程每 5 秒补发；
4. 回车后不再因为回读失败而重投，避免同一条消息重复提交。

---

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `无法执行 tmux` | Linux 装 `tmux`；macOS `brew install tmux`，并确认 `tmux` 在 PATH |
| `target 不是有效 pane` | 用 `tmux-list` 重新选；pane 可能已关闭或换了 session |
| 一直不 ACK | 目标 pane 不是 TUI、TUI 输入框没聚焦，或正文太长被折叠；用 `tmux-send --verify 1` 单独试 |
| 消息重复 | 不要同时开 `--window 1` 和 `--tmux`；确认目标 pane 只有一个 agent TUI |
| 长正文被截断 | tmux buffer 或 TUI 输入限制；可用 `--file` / `--stdin`，或拆短 |

> 目标必须是 agent TUI 的输入 pane，不要指向普通 shell。`send-keys` 末尾会按回车；如果目标是 shell，正文会被 shell 当成命令执行。

> `run` 必须和 TUI 在同一个 tmux server（同一用户）。用 systemd/launchd 常驻时，先确保目标 session 已存在；需要自定义 socket 目录时让两边使用同一个 `TMUX_TMPDIR`。
