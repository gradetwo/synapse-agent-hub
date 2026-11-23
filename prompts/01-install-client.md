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

## 网络口径（全节点统一，先直连后回退）

0. 来源口径：回退只用网络公开的镜像与代理（GitHub 用 gh-proxy.com 等公开代理，Rust 用 rsproxy、清华 tuna 等公开镜像），不用自有代理地址。（Wang 2026-11-23 裁决）
1. 默认直连。GitHub、crates.io、Rust 工具链分发，一律先直连，不预设代理，不预设镜像。
2. 回退触发条件（满足任一即触发）：连接超时；DNS 解析失败；连接被重置或拒绝；HTTP 403/407/429 持续出现；下载速率长期低于 10 KB/s。单次偶发失败先原路重试 1 次，重试仍失败再回退。
3. GitHub 回退：`git clone`/`git fetch`/`gh` 直连失败时，改走公开代理前缀 `https://gh-proxy.com/<原 GitHub URL>`（或同类公开镜像），或按环境已有配置使用 `HTTPS_PROXY`。只用公开来源，不填自有代理地址（Wang 2026-11-23 裁决）。中枢客户端同理：`synapse-agent run --proxy <代理地址>` 显式开启；`--proxy off` 表示强制直连；不带参数时客户端自动检测 `HTTPS_PROXY/ALL_PROXY` 环境变量。
4. cargo 回退：直连 crates.io 失败时，在 cargo 配置里启用镜像源。首选 rsproxy（`source.crates-io` 替换为 `registry = "sparse+https://rsproxy.cn/index/"`，并设 `[net] git-fetch-with-cli = true`）；rsproxy 不通再换清华 tuna 源（`sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/`）。只改当前项目的 `.cargo/config.toml` 或用户级配置，不改全局系统配置。
5. rustup 回退：直连失败时设 `RUSTUP_DIST_SERVER=https://rsproxy.cn` 与 `RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup` 后重试；仍失败再换 tuna 的 rustup 镜像。
6. 响亮报告（硬约束）：每一次回退都必须写进本轮汇报与任务回执——写明回退了哪条链路（GitHub / cargo / rustup / 中枢连接）、触发原因、换成了哪个代理或镜像。不许静默换源。不许把「换源后成功」写成「直连成功」。
7. 回退是临时措施，不是默认配置。网络恢复后应能回到直连。不要把镜像地址写死进仓库代码或提交物。

环境适配（类别① Linux 常驻）：cargo 配置落点为 `~/.cargo/config.toml`；代理环境变量写进启动 `run` 的同一 shell 或 systemd 用户服务的 `Environment=`，避免出现「心跳走代理、构建走直连」的分裂状态。

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

安装脚本的常驻行为只有一个口径：先探测 systemd 用户会话——有则注册 `synapse-agent.service`（开机自启、崩溃自拉）；没有或注册失败，则脱离会话后台启动（优先 `setsid`，无 `setsid` 时才用 `nohup`）。哪条路生效以脚本输出的结论行为准，不要自己猜，也不要另发明一套拉起方式。有 systemd 时检查：

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

安装完成后不要停在“已连接”：继续按 `03-run-agent-loop.md` 常驻收件并回复；`03` 已自包含回复命令，不需要客户端读取仓库里的 `05` 或 `docs`。

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
