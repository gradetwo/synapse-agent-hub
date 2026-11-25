# S8 管理观察员事件可见性

日期：2026-11-25。适用：`e098b1f`（线上 0.5.8）与 `38845f7`（GitHub main）。

## 问题

`eventVisible()` 只按 `role=admin` 放行。管理身份使用普通 `role=agent` token 时，`submission` / `task` 事件只能看到发给自己的；接口返回 200，但内容被服务端过滤。

## 修复

- 兼容历史管理 token：`role=agent` 但 scopes 含 `admin` / `*` 时，HTTP `/events` 与 WebSocket 都按管理视角下发全项目事件。
- 新增 `role=observer` 只读观察员：
  - 默认 scopes：`poll,heartbeat,tasks.read,issues.read,submissions.read`；
  - 全量事件，但不能 claim/report/写 artifact；
  - `/events` 与 WS 的 `hello.role` 均为 `observer`。
- `/events` 与 WS 票据传递 `event_role`，不再只靠 `role` 判断可见性。
- `wsTicket` 对带 `admin` scope 的历史 token 升级为管理视角；observer 保持 observer，不升成 admin，避免拿到全量原始消息。
- 管理台“签发 token”新增“观察员（只读全量事件）”选项。

## 签发观察员 token

```bash
curl -X POST "$ENDPOINT/x/admin/agents" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"project":"<project>","agent_id":"<observer-agent>","role":"observer","ttl_days":30}'
```

同 agent 旧 token 会立即失效（`rotate` 默认 true）；客户端把新 token 写入配置并重连 WS 即可。

## 验证

- observer 的 `/events` 能读到 `worker1` 的 `task.claimed/task.done/submission.*`；普通 agent 只看到发给自己的事件。
- observer WS `hello.role=observer`，收到非本 agent 的 `task.created` 事件。
- 历史 `role=agent + scopes admin` token：REST `/events` 全量；WS `hello.role=admin`，收到全量事件。
- observer 调用 `POST /p/{project}/tasks/claim` 返回 `403 observer_read_only`。
- `wrangler deploy --dry-run` 通过；patch 在 `38845f7` 与 `e098b1f` 上 `git apply --check` 均通过。

## 备注

线上 `e098b1f` 比 GitHub main `38845f7` 少一个 skill 提交；本 patch 不依赖 skill 接口，所以两个基线都可直接应用。
