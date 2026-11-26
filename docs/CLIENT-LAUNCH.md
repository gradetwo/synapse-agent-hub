# 客户端启动参数采集

管理台 Client 详情页的「客户端启动」区块展示该 agent **最后一次**上报的启动现场。数据随心跳上报，不需要额外接口；客户端重启后新的 `started_at` 会覆盖旧快照。

## 上报字段

心跳 `POST /p/{project}/heartbeat` 增加可选的 `launch` 对象（`schema=synapse.launch.v1`）：

```json
{
  "launch": {
    "kind": "rust",
    "version": "0.5.10",
    "started_at": 1764140000000,
    "argv": ["synapse-agent", "run", "--window", "0"],
    "cwd": "/home/user",
    "config_dir": "/home/user/.synapse-agent",
    "platform": "linux",
    "arch": "x86_64",
    "pid": 12345,
    "delivery": {
      "auto": false,
      "kind": "none",
      "target": "",
      "window_forward": false,
      "tmux_forward": false,
      "tmux_verify": true
    },
    "effective": {
      "cmd": "run",
      "role": "agent",
      "heartbeat_s": 60,
      "exec": null,
      "event_cmd": null,
      "window_forward": false,
      "tmux_forward": false
    }
  }
}
```

- `argv` 是实际启动命令行；客户端和服务端都会对 `--token`、`--admin-token`、`--api-key`、`--secret`、`--password`、`--proxy` 的取值脱敏。
- `effective` 是解析 config.json、环境变量和命令行后的生效值，不是原始配置文件。管理台展示「自动投送是否关闭」以此为准。
- `delivery.auto` 表示该客户端是否有外部自动投送：Rust 为生效的 `window_forward || tmux_forward`（含服务端远程覆盖）；Python SDK 为 `notify_cmd` 是否已配置且未被远程强制关闭（`kind=notify_cmd`，不暴露原始命令）；TS SDK 没有外部投送，恒为 `false`。
- `delivery.kind` 只会是 `window`、`tmux`、`notify_cmd` 或 `none`；`target` 为窗口应用或 tmux pane，`notify_cmd` 不写命令原文。
- 不采集任意环境变量；`cwd`、`config_dir`、`pid`、平台和架构用于定位启动环境。服务端限制为 64 个 argv、每个 512 字符、生效值 1200 字符。

## 存储与接口

- Durable Object 的 `agent:{agent_id}` 热记录保存 `launch` 和 `launch_received_ms`，心跳覆盖写；旧客户端没有 `launch` 时保留上一次已知快照。
- `GET /do/agent/get?id=...` 返回完整启动快照，仅供管理 API 内部读取。
- `GET /admin/agents` 的节点列表只返回 `launch_summary`（自动投送开关、类型、启动/上报时间），避免每次名册轮询传输完整 argv。
- `GET /admin/p/{project}/agent/{agent_id}` 返回 `client`（含 `launch`）和 `client_available`；详情页据此渲染启动参数。

## 增量快照、投送健康与参数来源

心跳不再每拍都发送完整 `launch`，避免 31–200 个节点时把 argv 反复放大：

- 第一次心跳、客户端本地参数变化、或服务端返回 `launch_required=true` 时，发送完整 `launch`。
- 其余心跳只发送 `launch_hash`（`launch` 的稳定 JSON 排序后 SHA-256）。
- 服务端保存完整 `launch` 和 `launch_hash`；hash 不匹配且没有完整快照时，下一次心跳响应要求客户端补全。
- 服务端计算 `restart_count`（`started_at` 变化）、`auto_since_ms` / `auto_off_since_ms`（自动投送连续开关时长）和 `launch_change_count`。

`launch` 新增：

```json
{
  "sources": { "window_forward": "config", "auto_forward": "remote", "heartbeat_s": "remote" },
  "control": { "rev": 3, "auto_forward": "inherit", "debug": false, "heartbeat_s": 30, "applied_at": 1764140000000 },
  "delivery": { "auto": true, "kind": "window", "target": "豆包" },
  "effective": { "auto_forward": "inherit", "debug": false, "heartbeat_s": 30 }
}
```

- `sources` 每个值的来源是 `cli`、`env`、`config`、`default` 或 `remote`；管理台用它解释“为什么投送是关的”。
- `control` 是客户端**已应用**的服务端控制版本；`applied_at=0` 表示尚未应用过任何远程控制。

心跳顶层新增：

```json
{
  "launch_hash": "sha256...",
  "delivery_health": {
    "last_attempt_ms": 1764140000100,
    "last_ok_ms": 1764140000200,
    "last_error": "",
    "consecutive_failures": 0
  },
  "debug": { "enabled": false },
  "errors": [
    { "id": "e1", "ts": 1764140000300, "kind": "exception",
      "message": "boom", "detail": "traceback..." }
  ]
}
```

- `delivery_health` 由客户端在每次窗口/tmux/notify 投递后更新；服务端归一出 `status=ok|failing|unknown`。
- `errors` 是客户端异常环形缓冲（最多 20 条，服务端按 `id` 去重并保留 30 条）。Rust 捕获 panic 并落盘 `error-outbox.json`，下次启动补报；Python/TS 捕获未处理异常和未处理 Promise rejection。
- `debug.logs` 仅在远程 debug 开启时上传（客户端最多 60 条，服务端保留 80 条）；关闭 debug 后服务端保留上一次日志供排查，但不再接收新日志。

## 远程运行控制

管理端接口：

```http
POST /admin/p/{project}/agent/{agent_id}/control
Authorization: Bearer <admin token>
Content-Type: application/json

{ "auto_forward": "on|off|inherit", "debug": true, "heartbeat_s": 30 }
```

- `auto_forward=inherit` 跟随客户端本地 config/CLI；`on` 强制开启；`off` 强制关闭。
- `on` 仅在客户端最近一次 `launch` 能看出窗口/tmux/notify 目标时允许，否则返回 `delivery_target_missing`。远程控制不会下发 `exec`、代理、token 或任意命令。
- `debug` 只控制诊断日志上传，不是远程执行开关。
- `heartbeat_s` 范围 15–300；传 `0` 或 `null` 清除覆盖，跟随客户端本地配置。
- 每次写入递增 `remote_control.rev` 并记录 `updated_by`。客户端在下一拍心跳响应中读取 `control`，应用到运行态，再把 `launch.control.rev` 回报；管理台对比 `remote_control.rev` 与 `control_applied_rev` 显示「等待应用 / 已应用」。
- Rust 用原子变量覆盖实际投递判断，并在远程从关到开时动态创建 `SurfacePump`；Python 的 `notify_cmd` 和 TS 的心跳也会在下一拍应用远程 debug/心跳周期。

## 管理台

- 名册新增筛选：投送关闭、投送开启、启动参数未上报、投送异常、有异常上报、debug 已开启、远程强制开/关、控制待应用、旧版 SDK。
- 行徽标新增：`投送关`、`投送异常×N`、`异常N`、`debug`、`控制待应用`；顶部统计显示投送关/投送异常/有异常节点数。
- 详情页新增「远程运行控制」和「客户端诊断」卡片；诊断包可一键复制（含 launch、remote_control、delivery_health、debug logs、errors）。

## 兼容与验收

- 旧客户端不发送 `launch`：详情页显示「启动参数未上报」，不会误报为关闭。
- DO 暂时读取失败：详情页显示「启动参数读取失败」，其它统计、活动趋势和消息仍可用。
- 用带 `--window 0` 或 `--tmux 0` 的客户端启动一次，管理台详情应显示「消息自动投送：关闭」；用 `--window 1` 启动应显示「开启 · 窗口注入」，并展示启动时间、命令行、生效配置和 pid。
