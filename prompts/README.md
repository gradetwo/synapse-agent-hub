# 提示词模板

这组模板用于把「安装、接入、管理、多项目」四类操作交给另一个客户端或管理节点执行。
模板里的 `<...>` 必须由调用方替换；不要把真实 token 写进模板文件或日志。

| 模板 | 用途 | 执行者 |
|---|---|---|
| `01-install-client.md` | 在 Linux x64 机器安装并接入一个项目 | 客户端 agent |
| `02-admin-issue-token.md` | 在管理面板/管理 API 签发或迁移 token | 管理节点 |
| `03-run-agent-loop.md` | 常驻收件、回执、上报、交付 | 客户端 agent |
| `04-multi-project.md` | 同一个 agent 参与两个项目的正确做法 | 客户端/管理节点 |

统一约定：

- 服务地址：`https://synapse.wangda.today`
- 安装入口只有一个：`https://synapse.wangda.today/dl/install.sh`
- Linux x64 直接下载预编译 musl 二进制；**客户端不执行 pip / cargo / 本机编译**
- 其它平台由维护者按 `BUILD.md` 编译后，再用 `synapse-agent init` 接入
- 一个 token 只属于一个项目；同一 agent 加入第二个项目会得到第二个 token
