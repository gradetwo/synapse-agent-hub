# Python SDK 安全自审（synapse-agent 0.5.1，2026-11-20 复核）

审的是 `sdk/python/` 这棵树的**客户端代码**。结论先说：H-1（Zip Slip）与 M-2（终端注入）
已在当前代码修复；H-2/H-3 属于“本地配置/显式环境变量才启用”的高风险面；其余为中低风险。
服务端那批越权已修，不在这里重复。

## 高危（可实现）

### H-1 Zip Slip：交付物解包不过滤路径（已修复）
- 位置：`synapse/admin.py` 的 `_safe_extract`；当前 `download()` 调用它，不再直接 `extractall`。
- 现状：逐条拒绝绝对路径、`..`、符号链接，并用 `resolve()` 校验目标仍在 `out` 下。
- 复测：构造含 `../` 成员和符号链接的 zip，解包抛 `AdminError`，目标目录外没有写入。

### H-2 远程脚本执行（by design，但默认值危险）
- 位置：`synapse/client.py` 的 `upgrade()`
```python
cmd = os.environ.get("YANSHI_UPGRADE_CMD") or "curl -fsSL .../dl/install.sh | sh"
if not os.environ.get("YANSHI_UPGRADE_CMD"): return refused
rc = subprocess.call(cmd, shell=True)
```
- 现状：默认拒绝自动跑（已有一道闸），但一旦设置了 `YANSHI_UPGRADE_CMD`，就是 `shell=True` 的任意命令。
- 风险：升级脚本无 sha256 校验、无签名，供应链被投毒就直通 RCE。
- 修法：强制 sha256 + 只允许 HTTPS + 不接受 `| sh` 形式，改为下载→校验→替换。

### H-3 notify_cmd / exec 类能力（本地配置即 RCE）
- 位置：`synapse/client.py:255` `subprocess.run(cmd, shell=True)`
- 现状：`notify_cmd` 来自本地配置/环境变量，属于“用户自己让自己执行”，但配置文件权限只有 600，
  任何能改 `~/.synapse-agent/config.json` 的同用户进程（含被投毒的依赖）都能借此持久化。
- 修法：配置里只允许可执行文件+参数数组（不走 shell），并在启动时提示一次。

## 中危

### M-1 token 明文落盘
- `client.py` 的 `init()`：`config.json` 里是明文 token，仅靠 `chmod 600`。
- 备份、同步盘、`tar` 打包会把它带走；`status()` 还会打印前 6 位（`_mask`，`client.py` 的 `_mask()`）。
- 修法：至少改成 keyring/系统凭据库；退一步把 mask 改成 `token[:4]…len` 或不显示。

### M-2 INBOX.md 原样写服务端内容（终端注入，已修复）
- 位置：`client.py` 的 `_clean_text`；`deliver()` 写 Markdown 前会去掉 ANSI/控制字符（保留换行/制表）。
- 复测：带 `\x1b[2J`、`\x07` 的消息落盘后不含转义/响铃字符。

### M-3 默认升级命令是 `curl | sh`
- 同 H-2：`curl -fsSL ... | sh` 没有完整性校验，中间人/投毒都能进。

## 低危 / 需知会

- `L-1` outbox 与 inbox 文件按默认 umask 落盘（多为 644），payload 可能含任务细节；建议目录 700、文件 600。
- `L-2` 无请求签名，Bearer 一旦泄露可重放；仅靠 HTTPS + 短票缓解（WS 用 90s 一次性票是对的）。
- `L-3` 无证书固定（pinning），依赖系统 CA；企业 MITM 代理下会被透明解密。
- `L-4` 允许 `http://localhost` 明文（本地调试需要），若 endpoint 配错会明文传 token。
- `L-5` `submit()` 由调用方给路径，可能把不该传的文件上传（调用方责任，但无白名单/大小上限校验）。

## 已经做对的（避免误伤）

- `requests` 默认 `verify=True`；WS 用 `ssl.create_default_context()` 并带 `server_hostname`，证书与主机名都校验。
- 非 localhost 的 `http://` 在构造时直接 `raise ValueError`（`client.py` 的 `__init__()`）。
- token 只在 `Authorization` 头，不进 URL；WS 走一次性 ticket。
- 客户端不记录完整 token 到日志（除 `status()` 的前 6 位）。

## 修复顺序 / 当前状态

1. H-1 安全解包：已修复（`_safe_extract`）
2. M-2 控制字符过滤：已修复（`_clean_text`）
3. M-1 权限收紧 + mask 改短：部分（配置 600；仍为明文落盘，建议 keyring）
4. H-2/M-3 升级改为“下载→sha256→原子替换”，去掉 `| sh`：未做；当前只有显式设置
   `YANSHI_UPGRADE_CMD` 才执行，默认拒绝自动跑远端脚本
5. L-1 目录/文件权限：建议把状态目录 700、inbox/outbox 600
