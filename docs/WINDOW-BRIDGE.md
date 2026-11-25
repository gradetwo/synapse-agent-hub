# Windows 窗口桥 + 本机消息总线（Rust 客户端）

> Linux/macOS 的 tmux/TUI 投递见 [`TMUX-BRIDGE.md`](./TMUX-BRIDGE.md)。

> 适用版本：synapse-agent 0.5.2+（本次在 0.5.1 基础上新增）。
> 目的：让本机的「配置程序 / 豆包等第三方窗口」与 Rust agent 之间能**双向传递文字消息**：
> - agent 读取新消息：配置程序写入 → agent 收到。
> - agent 发新消息给配置程序 / 窗口：agent 写入 → 配置程序收到 / 文字注入到窗口输入框。

新增能力全部在 `synapse-agent.exe` 单二进制内，零新增第三方依赖（仅调用 Windows 系统 DLL）。

---

## 1. 数据通路总览

```
 ┌──────────────────┐   命名管道(JSON Lines)    ┌────────────────────────┐
 │ 配置程序 / 你的UI │ ◀──────────────────────▶ │ synapse-agent (Rust)   │
 │  (读写管道)       │   \\.\pipe\synapse_agent_* │  bus-serve / bridge    │
 └──────────────────┘                            └───────┬────────────────┘
                                                         │  Win32 窗口操作
                                                         ▼  (枚举/激活/粘贴/读取)
                                                 ┌────────────────────────┐
                                                 │ 豆包 / 记事本 等窗口    │
                                                 └────────────────────────┘
                                                         │  可选 --hub 1
                                                         ▼
                                                 ┌────────────────────────┐
                                                 │ Synapse Hub (publish)  │
                                                 └────────────────────────┘
```

两条互补的通路：

| 通路 | 机制 | 用途 |
|---|---|---|
| **本机消息总线** | Windows 命名管道；Linux/macOS 回退 Unix socket | 进程间可靠收发结构化消息（推荐主通道） |
| **窗口直接操作** | Win32 FFI：枚举 / 激活 / 剪贴板粘贴 / WM_COPYDATA / 读文本 | 对接没有管道接口的第三方窗口（如豆包） |

---

## 2. 命令速查

```bash
# ★配置默认目标程序（写一次，之后所有窗口命令都免带 --app，定时任务尤其方便）
synapse-agent.exe win-config --app 豆包      # 设置默认目标为豆包
synapse-agent.exe win-config --show          # 查看当前默认目标
synapse-agent.exe win-config --clear         # 清除默认目标

# 发现窗口：按应用名自动找（推荐，无需手输标题）
synapse-agent.exe win-list --app 豆包          # 按进程名 Doubao 自动定位窗口
synapse-agent.exe win-list --match 豆包        # 或按标题子串

# 给窗口发文字（中文走剪贴板，默认自动回车；--enter 0 只填不发送）
# --app 会自动发现进程与窗口；默认点击输入框再粘贴，对豆包最稳
synapse-agent.exe win-send --app 豆包 --text "帮我总结这段日志" --enter 1
synapse-agent.exe win-send --app 豆包 --text "不错，继续"          # 等价于 --enter 1
synapse-agent.exe win-send --title 豆包 --text "hello" --method copy  # WM_COPYDATA

# ★发代码 / patch：正文走文件，绕开命令行长度与转义限制（推荐）
synapse-agent.exe win-send --app 豆包 --file .\p.patch              # 整段 UTF-8 文件
type p.patch | synapse-agent.exe win-send --app 豆包 --stdin        # 管道输入
synapse-agent.exe win-send --app 豆包 --file .\a.rs --enter 0       # 只填入输入框，不自动发送

# 读窗口文本 / 提取新消息（同样支持 --app）
synapse-agent.exe win-read --app 豆包
synapse-agent.exe win-read --app 豆包 --diff     # 只输出相对上次的新增行

# 本机消息总线：起服务 + 投递消息
synapse-agent.exe bus-serve --name '\\.\pipe\my_app'
synapse-agent.exe bus-send --name '\\.\pipe\my_app' --text "你好" --dir in --topic announce

# 一站式：窗口 ↔ 总线 ↔ Hub
synapse-agent.exe bridge --app 豆包 --hub 1 --poll 3
```

管道名默认是 `\\.\pipe\synapse_agent_<agent_id>`（agent_id 中的非法字符会被替换为 `_`）。

> **窗口定位说明**：`--app <应用名>` 会先按进程名发现 PID（如「豆包」/`Doubao`/`doubao.exe` 都命中），
> 再枚举属于这些 PID 的可见窗口。窗口标题随版本变化，用 `--app` 可免去手输标题的麻烦。
> 若 `--app` 与 `--title` 都不给，则报错提示。

## 2.1 配置默认目标程序（发给谁）

不用每次敲 `--app`，用 `win-config` 设置一次即可，配置持久化在 `~/.synapse-agent/config.json`
的 `window_app` 字段：

```bash
synapse-agent.exe win-config --app 豆包        # 设置：发给豆包
synapse-agent.exe win-config --show            # 查看当前默认值
synapse-agent.exe win-config --clear           # 清除
```

设置后，以下命令**无需再带 `--app`**，自动使用默认目标：

```bash
synapse-agent.exe win-send --text "不错，继续"        # 默认发给豆包
synapse-agent.exe win-read --diff                      # 默认读豆包
synapse-agent.exe bridge --hub 1 --poll 3              # 默认桥接豆包
```

目标选择优先级（从高到低）：
1. 命令行 `--app` / `--title`（临时覆盖）
2. `config.json` 的 `window_app`（`win-config --app` 写入）
3. 环境变量 `SYNAPSE_WINDOW_APP`（适合定时任务/CI 临时指定，不改配置文件）

把定时任务写死成下面这样即可，无需关心窗口标题：

```bat
@echo off
"C:\path\to\synapse-agent.exe" win-send --text "现在是早会时间，帮我准备今日待办"
```

> 想临时发给别的程序又不想改配置：`win-send --app 记事本 --text "..."`，
> 或在任务里设 `SYNAPSE_WINDOW_APP=记事本`。

## 2.2 `run` 自动投递到窗口

`run` 默认只把消息打印/交给 `--exec`；要让它把定向消息直接注入当前聊天窗口，必须显式开启：

```powershell
# 先设目标（可写多个，前台窗口优先）
synapse-agent.exe win-config --app "豆包,WorkBuddy"
# --window 1 = 先投窗口，UIA/剪贴板验证成功才 ACK
synapse-agent.exe run --window 1
```

也可以不写命令行，在 `config.json` 里设 `"window_forward": true`。窗口投递失败时消息会留在本地 WAL、不会 ACK；窗口晚开、切走或暂时找不到输入框时，主线程会每 5 秒重试，成功后再 ACK + 执行。`win-send --verify 1` 可单独验证一次 UIA/剪贴板投递；`uia-dump --app 豆包` 输出 UIA 控件树，用来排查输入框定位。

普通 agent 的窗口只接受 `to` 明确指向本 agent 的消息和管理端 `announce` 广播；其他普通 agent 发出的 `issue/announce/report/status` 无收件人广播只进管理台。`role=admin` 的本地投递面可收全部管理广播。其他 agent 的 `artifact` 交付单、任务板 `claimed/released/done` 生命周期事件也会被过滤，不再注入窗口，避免把别人的任务汇报或 Issue 刷屏当成指令。


---

## 3. 消息协议（JSON Lines）

每行一条 UTF-8 JSON，以 `\n` 结尾。字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 消息唯一 id，形如 `m-<毫秒时间戳>` |
| `dir` | `in` / `out` | `in`=配置程序→agent；`out`=agent→配置程序/窗口 |
| `sender` | string | 发送方标识 |
| `topic` | string | 主题，默认 `announce`；与 Hub topic 对齐 |
| `text` | string | 文本正文（必填） |
| `ts` | number | 毫秒时间戳 |
| `meta` | object | 附加元数据 |

示例：

```json
{"id":"m-1795133920803","dir":"in","sender":"config-ui","topic":"task","text":"帮我查今天的日程","ts":1795133920803,"meta":{}}
```

- `bus-serve` 会把收到的每条消息打印到 stdout（JSON Lines），并回写 `{"ok":true,"echo":"<id>"}` 作为送达确认。
- `bus-send` 会等待并打印这个回执。

---

### 3.1 发代码 / patch 的正确姿势（重要）

代码和 patch 含换行、缩进、`% ^ ! " \` 等字符，**不要塞进 `--text "..."`**：Windows 命令行有
32767 字符上限，cmd 还会解释 `% ^ !` 导致内容被吞或变形。用下面两种方式之一，正文整段从
UTF-8 文件/管道读入，不经过命令行转义，多长都行：

```bash
# 方式一：agent 把代码/patch 写成 UTF-8 文件，SDK 读文件全文粘贴（推荐）
synapse-agent.exe win-send --app 豆包 --file .\patch.diff

# 方式二：管道串接（PowerShell / cmd 均可）
type patch.diff | synapse-agent.exe win-send --app 豆包 --stdin

# 只填进输入框、由人确认后再回车发送，避免误发：加 --enter 0
synapse-agent.exe win-send --app 豆包 --file .\patch.diff --enter 0
```

- 正文来源优先级：`--text` > `--file` > `--stdin`（同时给时取第一个非空）。
- `--file` 按 UTF-8 读取，自动剥 BOM；非 UTF-8 会明确报错，不会静默乱码。
- 底层用 Unicode 剪贴板粘贴，**换行和缩进原样保留**；代码块会被目标窗口当成一段文本。
- 走消息总线同理：`bus-send --file <文件>` / `--stdin`，agent 可把大段代码通过管道发给配置程序。
- ⚠️ 总线单条消息管道缓冲为 64KB；超过约 60KB 的超大 patch 请把内容分片，或改用 `win-send --file`
  直发窗口（剪贴板无此限制）。
- 粘贴会覆盖系统剪贴板（与 `--text` 相同）。

## 4. 配置程序如何接入（三种姿势）

### A. 只要收发消息 —— 用命名管道

1. 先起服务：`synapse-agent.exe bus-serve`
2. 你的配置程序连接 `\\.\pipe\synapse_agent_<agent_id>`。
3. 写入一行 `dir=in` 的消息 → agent 的 `bus-serve` 会打印出来（agent 读到新消息）。
4. 读取管道可得 agent 回写的内容；agent 侧调用 `bus-send --dir out` 即可把消息推给你。

Python 示例（客户端）：

```python
import json, pywin32  # 或用 win32file
import win32file, win32pipe

PIPE = r"\\.\pipe\synapse_agent_rust-agent"

def send_in(text):
    h = win32file.CreateFile(PIPE, win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                             0, None, win32file.OPEN_EXISTING, 0, None)
    msg = {"dir": "in", "sender": "config-ui", "topic": "announce", "text": text}
    win32file.WriteFile(h, (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
    data = win32file.ReadFile(h, 65536)[1]
    print("ack:", data.decode("utf-8", "ignore").strip())
    h.Close()
```

### B. 对接豆包等无管道接口的窗口 —— 用窗口桥

豆包这类 Electron 窗口没有消息接口，只能模拟人操作：

1. `win-list --app 豆包` 自动发现进程与窗口（无需手输标题）。
2. **发文字**：`win-send --app 豆包 --text "..." --enter 1`
   - `click`（默认）：激活窗口 → 点击输入框 → 写剪贴板 + Ctrl+V → 回车。对 Electron/豆包最稳。
   - `paste`：不点击、直接 Ctrl+V（若焦点已在输入框可用）；`copy`：WM_COPYDATA，不动剪贴板。
   - `--enter 1` 表示粘贴后回车发送；`--enter 0` 只填入输入框。
   - 点击位置默认 `click-x=0.53 / click-y=0.83`（窗口宽高比例，豆包输入框中心）。
     **若点到「创建项目」等弹窗入口会弹出模态框导致发送失败**——此时用 `--click-y 0.83` 校准，
     或用 `--click-x/--click-y` 传绝对值比例。中文走剪贴板，**会覆盖剪贴板**。
3. **读新消息**：`win-read --app 豆包 --diff`
   - 激活窗口 → Ctrl+A/Ctrl+C 抓全文 → 与上次快照 diff → 输出新增行（默认会还原剪贴板）。
   - 首次调用建立基线，之后每次只吐新增内容，非常适合定时任务轮询。
   - ⚠️ Electron 自绘输入框不暴露 UIA Edit 控件；若窗口被模态弹窗遮挡，Ctrl+A/Ctrl+C 会抓不到对话、
     读到的是剪贴板残留。确保无弹窗遮挡再读。

### C. 全自动 bridging

```bash
synapse-agent.exe bridge --app 豆包 --hub 1 --poll 3
```

- 总线收到 `dir=out` 的消息 → 粘贴进豆包窗口（不自动回车，防误发）。
- 豆包窗口出现新文本 → 打印 + 投递到总线（`dir=in`）+ 可选 publish 到 Hub。
- `--hub 0` 可只在本地回环，不上报远端。
- `--hub 1` 的窗口输出按一个轮询窗口聚合成一条，并定向到 `admin`；不会作为项目广播刷其他 agent 的收件箱。

---

## 5. 与定时任务结合（对应最初的诉求）

Windows 任务计划程序里建一个任务，周期性执行：

```bat
@echo off
synapse-agent.exe win-send --title 豆包 --text "现在是早会时间，帮我准备今日待办" --enter 1
```

或用 `bridge` 常驻 + 系统开机自启，实现「豆包来新消息→agent 处理→回复」。

---

## 6. 平台与权限说明

- **窗口操作仅 Windows 有效**；非 Windows 平台相关命令返回明确错误，但其余子命令不受影响，仍可编译运行。
- **权限一致性**：自动化进程应与豆包以同一完整性级别运行（都普通用户，或都管理员），否则 UIPI 会拦截输入。
- **SetForegroundWindow 限制**：已附加前台线程，并用短暂置顶作为回退；发送前会用 `GetForegroundWindow` 校验目标确实成为前台。
  若校验失败，`win-send` 会返回错误并退出，不再把点击/按键送进前台终端。目标被其它窗口遮挡时，`WindowFromPoint` 也会中止点击。
- **窗口标题随版本变化**：一律用子串匹配，不要写死完整标题。
- **中文输入**：务必用 `paste` 方式（剪贴板），逐字符模拟会被输入法状态打乱。

---

## 7. 实现文件

| 文件 | 内容 |
|---|---|
| `sdk/rust/src/winmsg.rs` | 窗口枚举 / 按进程名自动发现（`--app`）/ 激活 / 点击输入框+剪贴板注入 / WM_COPYDATA / 文本读取 + diff |
| `sdk/rust/src/localbus.rs` | 命名管道（Windows）/ Unix socket（类 Unix）双向消息总线 |
| `sdk/rust/src/main.rs` | `win-list/win-send/win-read/win-config/bus-serve/bus-send/bridge` 子命令、`publish_to_hub`、默认目标解析 |
| `sdk/rust/Cargo.toml` | 无新增依赖 |

## 8. 已验证项（实测）

- ✅ `cargo build --release` 通过（Windows MSVC）
- ✅ `win-list --app 豆包` / `--app Doubao` 自动发现进程与窗口成功
- ✅ `win-send --app 豆包 --text "不错，继续"` 真实发进豆包对话，肉眼与 UIA TextPattern 双重确认，豆包正常回复
- ✅ `win-config --app 豆包` 设置默认目标后，`win-send --text "..."` 不带 --app 自动发给豆包（UIA 验证标记入对话）
- ✅ `win-read` 读回内容，`--diff` 首次=1 条、再次=0 条
- ✅ `bus-serve` + `bus-send` 双向通信，服务端逐条打印、客户端收到回执
- ✅ 无值 flag（`--diff`）与任意顺序参数解析

> **踩坑记录**：Electron/Chromium 走 RawInput，`keybd_event` 的 bScan=0 会被忽略——已改为
> `MapVirtualKeyW` 取真实扫描码。豆包聊天输入框是自绘的（UIA 无 Edit 控件），必须点击坐标定位；
> 默认点击比例 (0.53, 0.83) 对应输入框中心，**点到 y>0.88 会弹出「创建项目」模态框导致发送失败**。
> 验证发送是否真成功时，不能只看 `win-read`（模态遮挡时会读到剪贴板残留），应以肉眼或
> UIA `TextPattern.GetVisibleRanges()` 读对话区为准。
