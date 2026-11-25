# 管理台统计分析

## 入口

- 总览页“近 7 天”卡片整块可点击，打开“活动趋势”详情。
- 详情支持 `7 天 / 30 天 / 90 天` 窗口，以及 `消息 / 交付 / Issue` 单指标切换。
- 单指标折线图使用自己的 Y 轴，避免消息量级压住交付和 Issue；下方三张小图分别自适应缩放。
- Agent 详情新增“活动趋势”小图，支持相同三个窗口；点“完整趋势”进入同一趋势详情，按该 agent 聚合。

## 全局聚合

`GET /admin/analytics?days=7|30|90&project={project}&fresh=1`

- `days` 仅接受 7、30、90，缺省 7。
- 返回 `daily`（UTC 日期桶）、`totals`、`previous`（上一个等长周期）、`range`。
- 消息来自 `archive` 的落库消息数；交付按 `submissions.created_at` 创建时间计数；Issue 按 `issues.created_at` 创建时间计数。
- 结果缓存 5 分钟；`fresh=1` 绕过缓存。
- 当前“消息”是 Hub 归档消息总数，不等于任务数。

## Agent 聚合

`GET /admin/p/{project}/agent/{agent_id}/activity?days=7|30|90`

- `messages`：`archive.sender = agent_id` 的消息数（发出消息）。
- `submissions`：`submissions.agent_id = agent_id` 的创建数。
- `issues`：`issues.reporter = agent_id` 的创建数。
- 返回 `available`、`daily`、`totals`、`previous`、`range`；D1 聚合失败时 `available=false`，不把 0 当作真实趋势。
- Agent 详情接口 `GET /admin/p/{project}/agent/{agent_id}?days=...` 同步返回 `activity`，详情页因此不需要额外请求即可画小图。

## 展示口径

- 所有日桶按 UTC 日期切分，避免管理台不同浏览器时区导致同一天数据漂移。
- “上一周期”是紧邻当前窗口的等长天数；本期包含今天，因此今天尚未结束时会天然低于完整周期，界面上只作为方向参考。
- 图表只展示聚合值，不展示消息正文、任务正文或交付内容。
