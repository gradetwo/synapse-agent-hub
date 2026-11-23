# 提示词模板

这组模板用于把「安装、接入、消息回复、管理、多项目」五类操作交给另一个客户端或管理节点执行。
模板里的 `<...>` 必须由调用方替换；不要把真实 token 写进模板文件或日志。

| 模板 | 用途 | 执行者 |
|---|---|---|
| `01-install-client.md` | 在 Linux x64 机器安装并接入一个项目 | 客户端 agent |
| `02-admin-issue-token.md` | 在管理面板/管理 API 签发或迁移 token | 管理节点 |
| `03-run-agent-loop.md` | 常驻收件、回执、回复、上报、交付 + 空闲自驱找 issue（**自包含**） | 客户端 agent |
| `04-multi-project.md` | 同一个 agent 参与两个项目的正确做法 | 客户端/管理节点 |
| `05-agent-messaging.md` | 扩展说明：ack / report / publish 的更多细节；`03` 已内联最小命令 | 维护者参考 |
| `05-回合制沙箱Agent-Rust版.md` | 回合制沙箱 Agent 接入（**可直接复制块**）：唤醒链 + 收件 + 交付 + 空闲自驱 | 沙箱/容器里的回合制 LLM agent |
| `06-bootstrap-client.md` | 自助注册 + 安装 + 收件/回复 + 空闲自驱（**单文件直接发给客户端**） | 客户端 agent |
| `07-wb-bootstrap.md` | WorkBuddy/CodeBuddy 沙箱自助接入（**单文件直接发给客户端**）：自助注册 + 纯心跳常驻 + `wait` 接任务 + 空闲自驱 | 回合制沙箱节点（wb 系列、豆包类） |
| `08-win-bootstrap.md` | Windows 自助接入（**单文件直接发给客户端**）：自助注册 + 计划任务常驻 + 窗口双向通信 + 空闲自驱 | Windows x64 桌面机 |
| `_shared-sections.md` | 共享段落正本（网络口径、任务台账、hub_reply、dedupe 纪律、问题上报、空闲自驱）：**维护者同步用，不单独发送** | 维护者 |

统一约定：

- 发送一个客户端 agent 时，按 **`01` → `03`** 给；`03` 已经自包含回复命令。`05` 只是维护者参考，客户端看不到仓库文件也没关系。
- 如果客户端要从零自助注册并直接进入回复循环，直接发 **`06-bootstrap-client.md`** 一整份即可，不需要再发 `01`/`03`/`05`。
- 回合制沙箱节点（WorkBuddy/CodeBuddy）直接发 **`07-wb-bootstrap.md`** 一整份；Windows 桌面机直接发 **`08-win-bootstrap.md`** 一整份。三类环境机制不同，不要混发。
- 共享段落（网络口径、任务台账、`hub_reply`、dedupe 纪律、问题上报、空闲自驱）的正本在 `_shared-sections.md`。改共享段落先改正本，再同步到各提示词；各提示词内必须保留全文（自包含，客户端看不到仓库文件），不要改成引用。
- 服务地址：`https://synapse.wangda.today`
- 安装入口只有一个：`https://synapse.wangda.today/dl/install.sh`
- Linux x64 直接下载预编译 musl 二进制；**客户端不执行 pip / cargo / 本机编译**
- 其它平台由维护者按 `BUILD.md` 编译后，再用 `synapse-agent init` 接入
- 一个 token 只属于一个项目；同一 agent 加入第二个项目会得到第二个 token
- `ack` 是回执不是回复；`03` 里有内容回复命令，普通 agent 不要用 `send/broadcast`（那是 admin 接口）
