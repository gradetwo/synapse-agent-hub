# 客户端升级后如何学习服务端新能力

## 问题

服务端发布 S8 后，`/ver`、`/capabilities`、`/skill` 已是公开入口；但客户端升级只替换二进制，`run/init` 不读这些入口，agent 仍使用旧 bootstrap。结果：GitHub 成了唯一能知道新能力的地方，`--help` 只能看到 CLI 子命令，看不到服务端能力。

## 契约

`/ver` 是廉价摘要，不要求认证：

```json
{
  "build": "events-visibility-20261125",
  "sdk": "0.5.8",
  "skill_url": "/skill",
  "skill_sha256": "...",
  "capabilities_url": "/capabilities",
  "capabilities_sha256": "...",
  "capabilities": ["server.version", "events.visibility", "..."]
}
```

`/capabilities` 是程序判定面；每条能力至少带：

```json
{
  "id": "events.replay",
  "since": "0.5.8",
  "status": "beta",
  "audience": "agent",
  "min_sdk": "0.5.8",
  "title": "断线补拉与事件游标",
  "summary": "...",
  "method": "GET",
  "path": "/p/{project}/events",
  "scope": "rust"
}
```

`/skill` 是人读的 Markdown，从同一份能力表生成；`x-skill-sha256` / ETag 用于缓存。`/ver` 的 `capabilities` 数组不能替代 `/capabilities` 的 `status/scope/min_sdk`。

## 客户端行为

1. `upgrade` 替换/下载新二进制后写 `$STATE_DIR/upgrade-pending.json`，记录 from/to/platform。
2. 新二进制首次 `run` / `init` 调用 `GET /ver`。`wait` / `peek` 只在有 pending、缓存缺失或超过 6h 时刷新。
3. 只有 `capabilities_sha256` 或 `skill_sha256` 变化时，才拉 `/capabilities` 和 `/skill`。
4. 写入：
   - `$STATE_DIR/capabilities.json`
   - `$STATE_DIR/SKILL.md`
   - `$STATE_DIR/WHATS-NEW.md`
   - `$STATE_DIR/discovery.json`（build/sdk、两个 hash、capability IDs、noticed key）
5. 能力表有新增/变更时，在配置了窗口或 tmux 的表面投递一条 **一次性通知**：
   `[Synapse 能力更新] ... 完整说明已缓存到 .../SKILL.md；请按 /capabilities 能力 ID 核对，不要只看 --help。`
   这不是任务，不占 task/lease，不 ACK；投递失败保留到下次 `run` 重试。
6. 无外部投递面时打印同一句到日志；agent 仍可读 `SKILL.md`。

## 兼容与失败

- `/capabilities` 不可用：回退到 `/ver` 的 ID 列表，仍写 `capabilities.json`，不阻塞启动。
- 网络失败：保留旧 `SKILL.md`/`capabilities.json`，只提示一次。
- 旧服务端没有 hash：用 `build` + ID 列表比较；仍然不会要求 GitHub。
- `status=beta/partial` 的能力客户端不得当作已验收；`required` + `min_sdk` 不满足时明确告警。

## 不做

- 不新增 `synapse-agent capabilities` 子命令；`--help` 只负责 CLI。
- 不把 GitHub 作为运行时能力来源。
- 不把 `/skill` 整份重复注入每次启动；只在 hash 变化时刷新。
