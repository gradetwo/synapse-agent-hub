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
- `delivery.auto` 表示该客户端是否有外部自动投送：Rust 为 `window_forward || tmux_forward`；Python SDK 为 `notify_cmd` 是否已配置（`kind=notify_cmd`，不暴露原始命令）；TS SDK 没有外部投送，恒为 `false`。
- `delivery.kind` 只会是 `window`、`tmux`、`notify_cmd` 或 `none`；`target` 为窗口应用或 tmux pane，`notify_cmd` 不写命令原文。
- 不采集任意环境变量；`cwd`、`config_dir`、`pid`、平台和架构用于定位启动环境。服务端限制为 64 个 argv、每个 512 字符、生效值 1200 字符。

## 存储与接口

- Durable Object 的 `agent:{agent_id}` 热记录保存 `launch` 和 `launch_received_ms`，心跳覆盖写；旧客户端没有 `launch` 时保留上一次已知快照。
- `GET /do/agent/get?id=...` 返回完整启动快照，仅供管理 API 内部读取。
- `GET /admin/agents` 的节点列表只返回 `launch_summary`（自动投送开关、类型、启动/上报时间），避免每次名册轮询传输完整 argv。
- `GET /admin/p/{project}/agent/{agent_id}` 返回 `client`（含 `launch`）和 `client_available`；详情页据此渲染启动参数。

## 兼容与验收

- 旧客户端不发送 `launch`：详情页显示「启动参数未上报」，不会误报为关闭。
- DO 暂时读取失败：详情页显示「启动参数读取失败」，其它统计、活动趋势和消息仍可用。
- 用带 `--window 0` 或 `--tmux 0` 的客户端启动一次，管理台详情应显示「消息自动投送：关闭」；用 `--window 1` 启动应显示「开启 · 窗口注入」，并展示启动时间、命令行、生效配置和 pid。
