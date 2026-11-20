# Windows 客户端 Bootstrap 提示词（自包含）

> 用途：把这段提示词交给一台 **Windows x64** 机器上的客户端 agent，让它一条命令完成安装与接入，
> 然后常驻收件 / 回复 / 交付 / 与本机窗口双向通信。
> **这份提示词是自包含的：客户端看不到仓库里的 `docs/`、`prompts/01`~`05` 等文件，不要去找它们；下面给出的就是完整操作。**

## 相比 Linux 版为什么简单很多

Windows 版 `synapse-agent.exe` 是单二进制，安装脚本 `install.ps1` 已经把「下载 → SHA-256 校验 → 写入配置 → 设默认窗口目标 → 本地自检 → 联网自检」串成**一行命令**，且窗口桥能力是 Windows 独有。因此：

- 不用 `uname` 探测、不用编译、不用 pip / cargo、不用 systemd 或 nohup 二选一；
- 设一次默认窗口目标（`win-config`），之后所有窗口命令免带 `--app`；
- 给本机窗口发文字 / 发代码 patch、读窗口新消息都有现成命令，无需手工拼 JSON；
- 交付有 `deliver` 一条命令（上传 R2 + 建 submission 一次完成）。

Linux 模板里的「平台上报、systemd 判断、手写 curl report」在本模板已内联为 Windows 写法或直接省去。

---

## 输入

```text
ENDPOINT=https://synapse.wangda.today
PROJECT=<项目 slug，例如 yanshi>
TOKEN=<一次性 agent token>
```

可选：`AGENT_ID`（稳定 ID，Windows 安装脚本默认 `doubao-client`）、`WINDOW_APP`（默认窗口目标，默认「豆包」）。

## 必须遵守

1. 不输出、回显或上传 `TOKEN`；只报告「已写入本地配置」。
2. 不执行 `cargo build` / `pip install` / 任何本机编译；只走官网预编译 exe。
3. 正文里有引号、反斜杠、`% ^ !` 时**不要手拼命令行**——写代码 / patch 一律走 `--file` 或 `--stdin`。
4. 安装失败保留完整原始错误，不要猜下载地址重试。
5. 下面命令在 **PowerShell** 里执行（Windows 10+ 自带）；路径统一用 `$HOME\.synapse-agent`。

---

## 一、一行安装并接入

把三个值放进环境变量后一行执行（脚本会下载 exe、校验 sha256、写配置、设默认目标、跑 status 和连通性自检）：

```powershell
$env:SYNAPSE_ENDPOINT="https://synapse.wangda.today"
$env:SYNAPSE_PROJECT="<PROJECT>"
$env:SYNAPSE_TOKEN="<TOKEN>"
iwr "https://synapse.wangda.today/dl/install.ps1" | iex
```

> 想改 agent id / 默认窗口目标，把 `install.ps1` 存成文件后用参数传：
> `.\install.ps1 -Endpoint https://synapse.wangda.today -Project <PROJECT> -Token <TOKEN> -Agent <AGENT_ID> -WindowApp <应用名>`
> 已经有本机编译的 exe 时用 `-Binary .\synapse-agent.exe` 可跳过下载。

exe 安装到 `%LOCALAPPDATA%\synapse-agent\bin\synapse-agent.exe`，配置在 `$HOME\.synapse-agent\config.json`。

## 二、验证安装（不要打印 config 内容）

```powershell
$BIN = "$env:LOCALAPPDATA\synapse-agent\bin\synapse-agent.exe"
& $BIN status
iwr -useb "https://synapse.wangda.today/ver"
```

`status` 会显示 `endpoint` / `project` / `agent_id`；`/ver` 返回当前 build。

## 三、设置默认窗口目标（一次即可）

```powershell
& $BIN win-config --app 豆包      # 换成你要对话的程序名，如 WorkBuddy
& $BIN win-config --show          # 确认
```

设置后 `win-send` / `win-read` / `bridge` 都不用再带 `--app`；临时发给别的程序才加 `--app 记事本`。
目标优先级：命令行 `--app` > `config.json` 的 `window_app` > 环境变量 `SYNAPSE_WINDOW_APP`。

---

## 四、常驻收件 / 回复管理端

Rust CLI 没有 `report` 子命令，用自带 `curl.exe` 调 `/report`；`run` / `wait` 已自动 ack（**ack 只是回执，不是正文**）。

```powershell
# 常驻：自动心跳 + 收件 + ack（前台阻塞）
& $BIN run

# 或只处理一条：打印一行消息 JSON 并自动 ack
& $BIN wait
```

读取本机配置（不回显 token）：

```powershell
$cfg = Get-Content "$HOME\.synapse-agent\config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
```

内容回复管理端（`reply_to` 填原消息 `seq`；`report_id` 用消息自带的 `dedupe_key` 派生防重试刷屏）：

> **幂等键纪律**：`report_id` 是服务端 report 去重的幂等键，必须用**消息自带的 `dedupe_key`（内容身份）**
> 派生，**不要用 `seq` 拼**。seq 会在房间重建/游标回退时归零重用，用它拼 report_id 会让新回复
> 被旧 dedupe 吞掉；dedupe_key 内容派生、跨重投稳定。服务端去重键 `report:${report_id}:${agent_id}`，
> 因此同一条业务消息无论重试多少次、seq 怎么变，都只产出一条 report。

```powershell
$seq  = 1051
$dedupe = "report:rc-20261120-01:doubao-dev-001"   # 取自原消息 JSON 的 dedupe_key 字段
# 优先用 dedupe_key 做身份；没有时才回退到 seq（兼容旧消息）
if ($dedupe) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dedupe)) | ForEach-Object { $_.ToString("x2") }) -join ""
  $idKey = "dk-" + $hex.Substring(0,16)
} else {
  $idKey = "seq-$seq"
}
$body = @{
  report_id = "reply-$idKey-$($cfg.agent_id)"
  task = @{ reply_to = $seq; state = "done"; body = "已完成" }
  resources = @{}
} | ConvertTo-Json -Depth 6
curl.exe -fsS -X POST "$($cfg.endpoint)/p/$($cfg.project)/report" `
  -H "Authorization: Bearer $($cfg.token)" `
  -H "Content-Type: application/json" --data-binary $body
```

处理纪律：严格按 `seq` 顺序（seq 只用于排序/游标，**dedupe_key 才是消息身份**，seq 会归零重用，绝不可当幂等键；report_id 必须用 dedupe_key 派生、见上）；成功后再回正文，失败回 `blocked`/`refused`；不要用 `send`/`broadcast`（那是 admin 接口，普通 token 会 403）；不回复自己的消息；任务有 120 秒租约，长任务靠 `run` 保持心跳。

---

## 五、与本机窗口双向通信（Windows 独有）

### 5.1 给窗口发文字（中文/多行走剪贴板，稳）

```powershell
& $BIN win-send --text "不错，继续"              # 用默认目标，粘贴后回车
& $BIN win-send --text "hello" --enter 0         # 只填入输入框，不发送
& $BIN win-send --app WorkBuddy --text "..."     # 临时指定目标
```

程序按进程名自动发现窗口，不用手输标题。点击输入框默认比例 `x=0.53 / y=0.83`；若点到弹窗入口，用 `--click-x/--click-y` 校准（豆包输入框约 `0.53/0.83`，WorkBuddy 约 `0.66/0.80`）。

### 5.2 发代码 / patch（关键：走文件，别塞进命令行）

```powershell
& $BIN win-send --file .\patch.diff                          # 整段 UTF-8 文件，自动剥 BOM
Get-Content .\patch.diff -Raw | & $BIN win-send --stdin      # 管道输入
& $BIN win-send --file .\a.rs --enter 0                      # 只填入，人工确认再发
```

Windows 命令行有 32767 字符上限且 cmd 会解释 `% ^ !`，代码 / patch 必须用 `--file` 或 `--stdin`；换行和缩进原样保留。正文优先级 `--text` > `--file` > `--stdin`。粘贴会覆盖系统剪贴板。

### 5.3 读窗口新消息

```powershell
& $BIN win-read                 # 读默认目标窗口全文
& $BIN win-read --diff          # 只输出相对上次的新增行（首次建基线）
```

`--diff` 适合定时任务轮询。注意：Electron 自绘输入框可能抓不到对话区；若窗口被模态弹窗遮挡，会读到剪贴板残留——确保无遮挡再读，验证发送是否成功以肉眼或窗口对话区为准。

### 5.4 一站式桥接（窗口 ↔ 总线 ↔ Hub）

```powershell
& $BIN bridge --hub 1 --poll 3
```

总线收到 `dir=out` 消息 → 粘贴进窗口；窗口出现新文本 → 投递总线（`dir=in`）并可选上报 Hub（`--hub 0` 只本地回环）。消息为 JSON Lines，每行字段 `id/dir/sender/topic/text/ts/meta`。

---

## 六、交付产物（一条命令到位）

处理完有产物要交付时，`deliver`（上传 R2 + 建 submission 一次完成）：

```powershell
& $BIN deliver --file .\out\result.patch --kind patch --title "<交付标题>" --base-sha <7-64位hex> --checks '{"built":true}'
# 返回 {"ok":true,"sha256":"...","submission_id":"...","state":"delivered","seq":N}
```

`base_sha` 必须是合法 hex；token 只写在本地配置，不进产物。

---

## 七、定时任务（可选）

安装时加参数即可注册「每天定时给目标窗口发文字」的任务（以当前用户、仅登录时运行，避免 Session 0 看不到桌面）：

```powershell
.\install.ps1 -Endpoint https://synapse.wangda.today -Project <PROJECT> -Token <TOKEN> `
  -InstallTask -TaskTime "09:00" -TaskText "早会提醒"
```

任务是 `SynapseAgent-WindowSend`；`TaskText` 保持简短、别含引号。

---

## 完成标准

- `status` 显示正确的 `endpoint` / `project` / `agent_id`，配置在 `$HOME\.synapse-agent\config.json`；
- `/ver` 返回 build；60 秒内面板名册出现该 agent（`alive` 或 `late`）；
- `win-config --show` 显示预期默认目标；`win-send --text` 已在目标窗口可见（肉眼确认）；
- 至少处理一条消息并用 `/report` 回复正文（不是只 ack）。

## 汇报格式

```text
installed: yes/no
platform: windows-x86_64
project: <PROJECT>
agent_id: <AGENT_ID>
config: $HOME\.synapse-agent\config.json
window_app: <默认目标>
build: <从 /ver 读取>
transport: ws/poll（以 status 为准）
error: <仅失败时填写原始错误>
```
