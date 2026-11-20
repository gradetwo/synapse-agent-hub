# 提示词模板

这组模板用于把「安装、接入、消息回复、管理、多项目」五类操作交给另一个客户端或管理节点执行。
模板里的 `<...>` 必须由调用方替换；不要把真实 token 写进模板文件或日志。

| 模板 | 用途 | 执行者 |
|---|---|---|
| `01-install-client.md` | 在 Linux x64 机器安装并接入一个项目 | 客户端 agent |
| `02-admin-issue-token.md` | 在管理面板/管理 API 签发或迁移 token | 管理节点 |
| `03-run-agent-loop.md` | 常驻收件、回执、回复、上报、交付（**自包含**） | 客户端 agent |
| `04-multi-project.md` | 同一个 agent 参与两个项目的正确做法 | 客户端/管理节点 |
| `05-agent-messaging.md` | 扩展说明：ack / report / publish 的更多细节；`03` 已内联最小命令 | 维护者参考 |

统一约定：

- 发送一个客户端 agent 时，按 **`01` → `03`** 给；`03` 已经自包含回复命令。`05` 只是维护者参考，客户端看不到仓库文件也没关系。
- 服务地址：`https://synapse.wangda.today`
- 安装入口只有一个：`https://synapse.wangda.today/dl/install.sh`
- Linux x64 直接下载预编译 musl 二进制；**客户端不执行 pip / cargo / 本机编译**
- 其它平台由维护者按 `BUILD.md` 编译后，再用 `synapse-agent init` 接入
- 一个 token 只属于一个项目；同一 agent 加入第二个项目会得到第二个 token
- `ack` 是回执不是回复；`03` 里有内容回复命令，普通 agent 不要用 `send/broadcast`（那是 admin 接口）
