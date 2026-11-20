# 客户端安装与接入提示词

你是客户端执行代理。请按下面步骤把这台机器接入 Synapse，不要自行修改 endpoint、项目名或 token。

## 输入

```text
ENDPOINT=https://synapse.wangda.today
PROJECT=<项目 slug，例如 yanshi>
TOKEN=<一次性 agent token>
AGENT_ID=<可选，建议填写稳定 ID，例如 doubao-client>
```

## 必须遵守

1. 不要输出、回显或上传 `TOKEN`；只报告“已写入本地配置”。
2. 不要执行 `pip install`、`cargo build` 或任何本机编译；Linux x64 只走预编译包。
3. 如果平台不是 Linux x86_64，停止安装，报告 `uname -s` / `uname -m`，让维护者按 `BUILD.md` 编译对应平台。
4. 安装失败时保留完整原始错误，不要用猜测的下载地址重试。

## 执行

```bash
set -eu
test "$(uname -s)" = "Linux"
test "$(uname -m)" = "x86_64"

curl -fsSL https://synapse.wangda.today/dl/install.sh | sh -s -- \
  --endpoint https://synapse.wangda.today \
  --project "<PROJECT>" \
  --token "<TOKEN>" \
  --agent "<AGENT_ID>"

# 校验安装结果；不要打印 config.json 内容
"$HOME/.local/bin/synapse-agent" status
curl -fsS https://synapse.wangda.today/ver
```

安装脚本会先探测 systemd 用户会话：有 systemd 就注册服务，没有就自动用 `nohup` 后台启动。有 systemd 时检查：

```bash
systemctl --user status synapse-agent --no-pager
```

无 systemd 时检查：

```bash
cat "$HOME/.synapse-agent/agent.pid"
tail -n 20 "$HOME/.synapse-agent/agent.log"
```

如果进程没有起来，先看日志；不要重复执行安装脚本。

## 完成标准

- `synapse-agent status` 显示正确的 `endpoint` / `project` / `agent_id`
- 配置在 `~/.synapse-agent/config.json`，权限为 `600`
- `/ver` 返回当前 build
- 60 秒内面板名册出现该 agent（`alive` 或 `late`）

## 汇报格式

```text
installed: yes/no
platform: linux-x86_64
project: <PROJECT>
agent_id: <AGENT_ID>
config: ~/.synapse-agent/config.json (600)
transport: ws/poll（以 status 为准）
build: <从 /ver 读取>
error: <仅失败时填写原始错误>
```
