# 两态模型：忙时异步，闲时阻塞

> 一句话：**有活干就异步收，没活干就同步等**。
> 这不是风格选择，是 agent 的物理约束——干活时不能阻塞，等活时不阻塞就没人叫得醒它。

## 状态机

```
        ┌──────────────────────────────┐
        │                              │
   IDLE │  await loop.idle()           │
 (闲)   │  内部按 pollMs 轮询，阻塞语义 │
        │                              │
        └──────────┬───────────────────┘
                   │ 收到一条任务/广播
                   ▼
        ┌──────────────────────────────┐
        │                              │
   BUSY │  后台线程定时收件 → 队列       │
 (忙)   │  loop.check() 非阻塞取走       │
        │  心跳照常（管理端看到"在忙什么"）│
        │                              │
        └──────────┬───────────────────┘
                   │ 任务结束（离开 task 作用域）
                   └──────────► IDLE
```

**关键一点**：服务端**没有长轮询参数**，所以 `idle()` 的“阻塞”是 SDK 用短间隔轮询模拟的。对调用方来说语义就是阻塞：不返回 = 没新任务。

## 三个语言同一套语义

| 能力 | Python | TypeScript | Rust（CLI） |
|---|---|---|---|
| 托管心跳 | `Loop(c)` 构造即启动 | `new Loop(c)` | 进程内每次循环 |
| 进忙 | `with loop.task("构建")` | `await loop.task("构建", fn)` | 正常运行即忙 |
| 忙中检查 | `loop.check()` | `loop.check()` | `synapse-agent peek` |
| 回闲阻塞 | `loop.idle(timeout)` | `await loop.idle(ms)` | `synapse-agent wait`（超时退出码 3） |
| 主循环 | `loop.serve(handler)` | `await loop.serve(handler)` | shell 里 `while wait; do …; done` |

### Python

```python
from synapse import Client, Loop

c = Client.from_config()          # 安装时写入的 token / project / agent
hub = Loop(c, poll_s=3)

while True:
    task = hub.idle()             # ← 阻塞；没有任务就一直等
    with hub.task(task["payload"].get("title", "")):
        do_work()
        for msg in hub.check():   # ← 忙的时候顺手看一眼
            handle(msg)
```

### TypeScript

```ts
import { Client, Loop } from "@synapse/agent";

const hub = new Loop(new Client({ endpoint, project, token, agentId }), { pollMs: 3000 });

while (true) {
  const task = await hub.idle();                    // 阻塞
  await hub.task(task?.payload?.title ?? "task", async () => {
    await doWork();
    for (const m of hub.check()) handle(m);         // 忙中检查
  });
}
```

### Rust（命令行等价）

```bash
# 闲：阻塞等一条指令，收到后打印 JSON 并自动回执；超时退出码 3
YANSHI_WAIT=30 synapse-agent wait   # 读取 init 写入的配置；超时退出码 3

# 忙：正常跑你的活；想中途看一眼
synapse-agent peek   # 读取同一份配置
```

## 为什么不能只依赖“服务端推送”

- agent 在两次运行之间**没有稳定入站地址**，也没人保证替它守着连接；
- 常驻进程可以用 WebSocket 推送（见下文），但回合制 agent 可能几分钟到几小时才醒一次；
- 所以 WS 不是唯一通道：没有长连接时必须能“拉”，区别只在**谁在拉、拉的时候是否阻塞主流程**。

这也是 `idle()` 存在的理由：把“拉”包装成“等”，让主循环写起来像事件驱动。

## 对 LLM 型 agent（回合制）的适配

LLM agent 一轮对话就是一次“醒着的时间窗”，所以：

1. **任务开始时**：起一个异步收件（后台进程/异步工具调用），立刻返回，不占住回合；
2. **任务过程中**：每个回合开头 check 一次队列；
3. **任务结束时**：切到阻塞等（一次长调用），把下一轮唤醒时间点尽量靠近“任务完成”；
4. **回合结束前必须再挂一次**：否则下一次没人收——这是本平台实测过的硬约束。

对应到本仓库的 `docs/WAKE-LOOPS.md` §2。

## 实测

```
state before: idle
t+1s state=busy check→ [41]
t+4s 管理端发 #42「任务中插入」
出 with 后 state: idle
idle 唤醒 用时 1.0s → (42, '任务中插入') state= busy
```

Rust：

```
$ YANSHI_WAIT=10 synapse-agent wait …
{"seq":46,"topic":"task","payload":{"title":"rust wait 测试", ...}}
```

## 边界与注意

- **游标只在成功处理后前移**，否则断线会丢消息；SDK 里是“取到就存”，处理失败要靠业务幂等。
- **心跳与收件是两条独立通道**：心跳证明“我活着”，收件证明“我收到了”，管理端分别看。
- **忙时的消息不会打断任务**，只入队；要不要中断由业务自己决定（`check()` 返回后你说了算）。
- **别把轮询间隔调到 1 秒以下**，DO 是按项目分片的单实例，压太狠会排队。

## 传输层：长连接优先，轮询兜底

**只有 agent 运行环境不支持长连接时，SDK 才轮询。** 默认 `transport="auto"`：

1. 用 Bearer 换一张**一次性票据**（`GET /p/{p}/ws-ticket`，90 秒有效、用过即废）；
2. 用票连 `wss://…/p/{p}/ws?ticket=…`，握手 101；
3. 连上 → 走推送，不再轮询；
4. 连不上（无 WebSocket / 代理拦 / 握手失败）→ 自动退回轮询，行为与之前一致。

### 为什么用票据而不是 token

WebSocket 握手不能带自定义 header（浏览器尤其），token 只能塞 URL，会进日志、进代理记录。
一次性票据把泄漏面压到“90 秒内、且只能用一次”。

### 服务端形态

```
agent ──WS──► Worker（验票）──► DO
                               ├─ acceptWebSocket（hibernation：空闲不计费）
                               └─ 有新消息 → 遍历在线连接推送
```

推送发生在 `append()` 之后，所以 `publish / broadcast / send` 都会即时到达在线 agent；离线 agent 照旧靠游标补拉。

### 实测

```
探测 7.6s   → mode=ws
第1轮 唤醒 936ms → #1
第2轮 唤醒   0ms → #2（队列已有）
第3轮 唤醒 404ms → #3
```

（唤醒里含管理端发送本身的时间，纯推送一般在 100–300ms。）

### HTTP/3 不解决这个问题

Cloudflare 边缘已经给 h3（响应头 `alt-svc: h3=":443"`），但 h3 只是传输层优化，
**没有应用层推送**。用 h3 轮询还是轮询，所以推送只能靠 WebSocket。

### 边界

- DO 换命名空间后 seq 归零，客户端游标要能复位（`Loop` 已做：发现 `max(seq) < 游标` 就归零重拉）；
- Rust 版已支持长连接（`synapse-agent run` / `ws`），连不上会自动回退轮询；`wait`/`peek` 是纯轮询兜底；
- 长连接断了要退避重连，重连后必须补拉断线期间的消息，不能假设 WS 不丢。

### Rust 的内部队列

Rust 版不是库而是单二进制，所以“执行任务不阻塞收件”落成：**收件线程 + mpsc 队列 + 执行线程**。

```bash
synapse-agent ws --endpoint … --project … --token … --agent … \
  --exec 'sh -c "你的任务处理脚本"'
```

- 每条任务以**一行 JSON** 从 stdin 喂给 `--exec` 的进程；
- 执行期间收件线程继续跑，新任务进队列排队，不丢；
- 心跳里的 `work.state` / `work.phase` / `queue` 会显示“在忙什么、积了几条”；
- 队列里只放“点名给我的 + 广播”，别人的定向消息和自己发的 ack 不入队。

实测：3 条任务间隔 0.4 秒发出，每条执行耗时 2 秒，最终 3 条全部执行：

```
共执行 3 个任务
  13 队列任务1
  14 队列任务2
  15 队列任务3
```
