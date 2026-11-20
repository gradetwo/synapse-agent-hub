# 提示词模板

这组模板用于把「安装、接入、消息回复、管理、多项目」五类操作交给另一个客户端或管理节点执行。
模板里的 `<...>` 必须由调用方替换；不要把真实 token 写进模板文件或日志。

| 模板 | 用途 | 执行者 |
|---|---|---|
| `01-install-client.md` | 在 Linux x64 机器安装并接入一个项目 | 客户端 agent |
| `02-admin-issue-token.md` | 在管理面板/管理 API 签发或迁移 token | 管理节点 |
| `03-run-agent-loop.md` | 常驻收件、回执、回复、上报、交付 | 客户端 agent |
| `04-multi-project.md` | 同一个 agent 参与两个项目的正确做法 | 客户端/管理节点 |
| `05-agent-messaging.md` | 收件后怎么回复：ack / report / publish 的区别与命令 | 客户端 agent |

统一约定：

- 发送一个客户端 agent 时，至少按 **`01` → `03` → `05`** 的顺序给它；只给 `03` 它可能只会 ack，不会回复正文。
- 服务地址：`https://synapse.wangda.today`
- 安装入口只有一个：`https://synapse.wangda.today/dl/install.sh`
- Linux x64 直接下载预编译 musl 二进制；**客户端不执行 pip / cargo / 本机编译**
- 其它平台由维护者按 `BUILD.md` 编译后，再用 `synapse-agent init` 接入
- 一个 token 只属于一个项目；同一 agent 加入第二个项目会得到第二个 token
- `ack` 是回执不是回复；内容回复看 `05-agent-messaging.md`，普通 agent 不要用 `send/broadcast`（那是 admin 接口）
