# 共享段落正本（维护者同步用，不单独发送）

本文件是四段共享文字的**唯一正本**：网络口径、任务台账、`hub_reply` 函数、dedupe_key 纪律。

维护规则（硬约束）：

- 提示词必须**自包含**——客户端看不到仓库文件（03、06 文件头明示）。所以各提示词内必须保留
  共享段落的**全文**，不许改成「见 _shared-sections.md」式引用。本文件只是维护者的同步源。
- 改任一共享段落：先改本正本，再逐份同步到所有含该段的提示词，并在提交信息里注明同步范围。
- 同步时只允许按类别改三处：二进制变量名（03 用 `$BINARY`，06 用 `$BIN`，07 用
  `HOME="$STATE" "$BIN"` 前缀，08 用 PowerShell 的 `& $BIN`）、状态文件路径、该类的环境适配行。
  其余文字逐字一致；发现不一致即按漂移处理，以本正本为准。

---

## 一、网络口径（全节点统一，先直连后回退）

0. 来源口径：回退只用网络公开的镜像与代理（GitHub 用 gh-proxy.com 等公开代理，Rust 用 rsproxy、清华 tuna 等公开镜像），不用自有代理地址。（Wang 2026-11-23 裁决）
1. 默认直连。GitHub、crates.io、Rust 工具链分发，一律先直连，不预设代理，不预设镜像。
2. 回退触发条件（满足任一即触发）：连接超时；DNS 解析失败；连接被重置或拒绝；HTTP 403/407/429 持续出现；下载速率长期低于 10 KB/s。单次偶发失败先原路重试 1 次，重试仍失败再回退。
3. GitHub 回退：`git clone`/`git fetch`/`gh` 直连失败时，改走公开代理前缀 `https://gh-proxy.com/<原 GitHub URL>`（或同类公开镜像），或按环境已有配置使用 `HTTPS_PROXY`。只用公开来源，不填自有代理地址（Wang 2026-11-23 裁决）。中枢客户端同理：`synapse-agent run --proxy <代理地址>` 显式开启；`--proxy off` 表示强制直连；不带参数时客户端自动检测 `HTTPS_PROXY/ALL_PROXY` 环境变量。
4. cargo 回退：直连 crates.io 失败时，在 cargo 配置里启用镜像源。首选 rsproxy（`source.crates-io` 替换为 `registry = "sparse+https://rsproxy.cn/index/"`，并设 `[net] git-fetch-with-cli = true`）；rsproxy 不通再换清华 tuna 源（`sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/`）。只改当前项目的 `.cargo/config.toml` 或用户级配置，不改全局系统配置。
5. rustup 回退：直连失败时设 `RUSTUP_DIST_SERVER=https://rsproxy.cn` 与 `RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup` 后重试；仍失败再换 tuna 的 rustup 镜像。
6. 响亮报告（硬约束）：每一次回退都必须写进本轮汇报与任务回执——写明回退了哪条链路（GitHub / cargo / rustup / 中枢连接）、触发原因、换成了哪个代理或镜像。不许静默换源。不许把「换源后成功」写成「直连成功」。
7. 回退是临时措施，不是默认配置。网络恢复后应能回到直连。不要把镜像地址写死进仓库代码或提交物。

各类环境适配注记（同步时按类别保留对应一行，删去其余两行）：

- 类别① Linux 常驻：cargo 配置落点为 `~/.cargo/config.toml`；代理环境变量写进启动 `run` 的同一 shell 或 systemd 用户服务的 `Environment=`，避免出现「心跳走代理、构建走直连」的分裂状态。
- 类别② 回合制沙箱：沙箱每轮环境可能重置。网络配置必须在每轮开工时重验一遍：先直连探活 1 次，失败即按本节回退，并在本轮汇报里写明。探活与回退都要写进状态文件，供下轮读取，避免每轮重复摸索。
- 类别③ Windows PowerShell：代理用 `$env:HTTPS_PROXY = "<代理地址>"` 在当前会话设置；cargo 配置落点为 `%USERPROFILE%\.cargo\config.toml`；git 代理用 `git config --global http.proxy <代理地址>` 单独设置，与 cargo 分开验证。

出现位置：01、03、05-回合制、06、07、08 全文粘入；02、04、05-agent-messaging 只加一行指针。

---

## 二、任务台账（先领单，再干活）

管理端派活走任务台账，不靠普通消息口头约定。

- **台账是什么**：服务端按项目维护的任务表。每单有 `task_id`、标题、正文、指派对象（`to`）、状态（`open` → `claimed` → `released`/`done`/`blocked`）与租约。管理端建单时只往你的收件箱投一条消息：`topic=task`、`kind=task`，`payload` 只有 `{task_id, title, body}`。**收到这条消息不等于领单**——不主动领，任务在台账里一直是 `open`，管理端看得到你没领。
- **领单（开工前必须做）**：`"$BIN" task-claim --task <task_id>`，返回 `{"ok":true,"lease_until":<毫秒时间戳>}` 才算领到。
  - `409 locked`：已被别人领走（响应带 `owner` 与 `lease_until`）。不要重复干这单，report 说明后跳过。
  - `403 not_your_task`：这单没指派给你。不要领，report 管理端。
  - `404 not_found`：`task_id` 写错或任务已撤。report 管理端核对。
  - 旧版客户端没有 `task-claim` 命令时用 HTTP 直调（与 `/report` 同款）：`POST $ENDPOINT/p/$PROJECT/tasks/claim`，头 `Authorization: Bearer $TOKEN`，体 `{"task_id":"<task_id>"}`，响应形状相同。
  - **领单失败必须响亮报告**：report 写明 `task_id` 与原始错误。不许静默跳过，不许没领单就开工。
- **租约与续租**：claim 租约现行口径 600 秒（10 分钟）。实际到期时间以 claim 响应里的 `lease_until` 为准，不要自己估算。只要心跳在发，服务端自动给名下全部 `claimed` 任务续租。心跳停了，租约到期后任务被回收成 `open` 给别人。把名下已领的 `task_id` 与 `lease_until` 记进本地状态文件，跨回合可查。（类别②另加一句：休眠醒来先对已领单重跑一次 `task-claim` 对账。）
- **交付必须挂单**：`deliver`/`submit` 带 `--task <task_id>`，交付才挂到这单名下；不带 `--task` 的交付，管理端对不上单。
- **关单（release）**：交付完成、report 发出之后才关单：`"$BIN" task-release --task <task_id> --state done`。
  - 有交付还没被管理侧取走时，服务端返回 `state=released`（已交付待取）；最后一件被取走后自动转 `done`。这是正常状态，不是失败，不要重复 release。
  - 干不了或被阻塞：先 report 写明原因，再 `--state blocked`。
  - 中途放弃：`--state open` 把单放回池子，并 report 说明。
  - HTTP 直调同款：`POST $ENDPOINT/p/$PROJECT/tasks/release`，体 `{"task_id":"<task_id>","state":"done"}`。
- **你查不了台账**：任务列表只对管理端开放，agent 没有自查接口。你名下有哪些单，只能靠收件箱里的任务消息加你自己记的本地记录。处理完一条任务消息，把 `task_id` 与最终状态落盘，别凭记忆。

出现位置：03、05-回合制、06、07、08 各一节（05-回合制为纯文本块版，08 为 PowerShell 版，
命令语义与本正本一致）。

---

## 三、hub_reply 函数（bash 正本）

参数依次为：原消息 `seq`、正文、可选 `task_id`、可选 `dedupe_key`、可选 `state`。
配套的 `report_task`（失败重试）与 `parse_wait_json` 以 06/07 内的版本为准，一并同步。

```bash
hub_reply() {
  seq="$1"; body="$2"; task_id="${3:-}"; dedupe_key="${4:-}"; state="${5:-done}"
  # 优先用 dedupe_key 做身份；没有时才回退到 seq（兼容极少数不带 dedupe_key 的旧消息）
  if [ -n "$dedupe_key" ]; then
    id_key="dk-$(printf '%s' "$dedupe_key" | sha256sum | cut -c1-16)"
  else
    id_key="seq-$seq"
  fi
  report_id="reply-${id_key}-$AGENT_ID"
  tmp="$(mktemp)"
  python3 - "$report_id" "$seq" "$body" "$task_id" "$state" > "$tmp" <<'PY'
import json, sys
report_id, seq, body, task_id, state = sys.argv[1:6]
task = {"reply_to": int(seq), "state": state, "body": body}
if task_id: task["task_id"] = task_id
print(json.dumps({"report_id": report_id, "task": task, "resources": {}}, ensure_ascii=False))
PY
  rc=0
  curl -fsS -X POST "$ENDPOINT/p/$PROJECT/report" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$tmp" || rc=$?
  rm -f "$tmp"
  return "$rc"
}
```

出现位置：06、07（bash 版）；08 为 PowerShell 等价实现，语义（reply_to、dedupe 派生 report_id、
resources 空对象）与本正本一致；03 不带函数、直接给 curl 模板，report_id 派生规则与本正本一致。

---

## 四、dedupe_key 纪律

> **幂等键纪律（务必遵守）**：`report_id` 是服务端 report 去重的幂等键，必须用**消息自带的
> `dedupe_key`（内容身份）**派生，而**不要用 `seq` 拼**。seq 会在房间重建/游标回退时归零重用，
> 用它拼 report_id 会导致新回复被旧 dedupe 吞掉；dedupe_key 是内容派生的稳定身份，重投、
> 归零都不变。服务端去重键为 `report:${report_id}:${agent_id}`——只要 dedupe_key 稳定，
> 同一条业务消息无论重试多少次、seq 怎么变，都只会产出一条 report。

出现位置：03（要点列表内）、05-agent-messaging（纪律第 4 条）、06、07、08（hub_reply 前的引用块）。

---

## 五、问题上报（Issue 台账）


干活时发现的问题，不要只写进回执里等它被埋掉，也不要默默绕过去：走中枢的 issue 台账上报，管理侧会分诊、派单、跟踪到关闭。

**什么该报**（满足一条即报）：
- 不是你当前任务范围内的缺陷、缺口、隐患（代码、文档、环境、数据都算）。
- 挡住你当前任务、但根因不在你任务范围内的事（写清它挡住了哪个任务、挡在哪一步）。
- 你当前任务的前提不成立（基线代码与任务描述对不上）——先按任务纪律响亮说明，同时立一条 issue 留痕。

**什么不该报**：
- 你当前任务范围内的事：那是你的活，直接在任务里修，不要立 issue 推走。
- 进度、请示、闲聊：走消息/回执，不走 issue。
- 已知自己刚报过的同一问题：不要重复报（拿不准是不是别人报过，照报，管理侧会合并重复件）。

**怎么报**：
```
synapse-agent issue --title "<一句话说清问题>" --body "<证据：文件:行号、复现步骤、影响范围>" --priority <low|normal|high|urgent> [--self]
```
- 标题一句话，只说问题本身，不写修法。
- 正文必须带证据：定位（文件与行号）、怎么复现、影响什么。没有证据的 issue 会被退回重报。
- 优先级口径：urgent = 正在造成数据损坏/安全问题/全线停工；high = 功能缺陷，影响交付；normal = 一般缺口与隐患；low = 小瑕疵与改进建议。
- 正文太长用 --body-file <path>。
- 如果这条问题你准备自己解决，就在上报时加 `--self`，Issue 会立即转成你的任务；已经先报了的，可在管理员处理前用 `synapse-agent issue-take --issue <id>` 转成自己的任务。只有原 reporter 本人能转，且 Issue 必须仍是 open、尚未派发。

**报完之后**：普通上报不用你跟踪，管理侧分诊后会把 issue 派成任务（可能派给你，也可能派给别人）；如果上报时用了 `--self` 或之后用了 `issue-take`，任务已经派给你本人，按正常任务认领和执行即可。对应任务完成时 issue 自动关闭，任务被打回时自动重开。

