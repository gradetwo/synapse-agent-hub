# Windows 目标会话路由（0.5.3）

## 问题

`window_app` 只负责选中豆包进程的顶层窗口，不能保证当前活动会话就是 agent 的执行会话。

豆包重启/重新打开后，窗口通常停在“主对话”；`run --window 1` 若只按应用名找窗口并点击输入框，消息就会被注入主对话，当前执行会话收不到。日志里看起来“投递成功”，实际用户看错会话，容易误判成任务丢失。

## 设计

新增持久配置 `window_conversation`（目标会话标题中的唯一特殊标记）：

```json
{
  "window_app": "豆包",
  "window_conversation": "◆dou-win-133"
}
```

投递顺序：

1. 解析 `window_app`，找到豆包窗口并激活；
2. `ensure_conversation` 读取当前活动会话标题（豆包 UIA Document 名称形如 `◆dou-win-133 - 豆包`）；
3. 若标题已包含 `window_conversation`，直接进入 composer 注入；
4. 否则在 UIA 控件树中查找：
   - `ControlType=Hyperlink`
   - `Name` 包含目标标记
   - `ClassName` 包含 `conversation-item`
   - 不在 offscreen、尺寸有效
   然后点击 `GetClickablePoint()` 返回的位置；
5. 点击后最多等 2 秒，重新读活动会话标题；仍未匹配则返回错误；
6. 调用方保留 WAL、不 ACK，等待下一次重试；**绝不把消息投进错误会话**。

`win-send` 复用同一套 `ensure_conversation`，所以手工注入也不会落进错误会话。

## 配置

先给执行会话设置唯一标记（例如在豆包顶部会话菜单重命名为 `◆dou-win-133`），再写配置：

```powershell
& $BIN win-config --app 豆包 --conversation "◆dou-win-133"
& $BIN win-config --show
```

配置优先级：

1. 命令行 `--conversation` / `--window-conversation`
2. `config.json` 的 `window_conversation`
3. 环境变量 `SYNAPSE_WINDOW_CONVERSATION`

`init` 会重写 `config.json`；`install.ps1` 会在 init 后自动恢复安装前的 `window_conversation`，也支持用 `-WindowConversation "◆dou-win-133"` 显式指定。直接执行 `init` 或换会话后，仍须重新执行上面的 `win-config --conversation`。

## 验证记录

测试时当前活动会话为 `dou-dev-005`，配置目标为 `◆dou-win-133`；新 binary 输出：

```text
[conversation] 当前会话="dou-dev-005"，目标="◆dou-win-133"，准备从会话列表切换
[conversation] 点击会话 "◆dou-win-133 归档对话 更多" @(140,403)
[conversation] 已切换到目标会话："◆dou-win-133"
[winmsg] UIA 输入框 rect=(296,607,1276,707)
{"ok":true,"method":"click"}
```

测试中的 `DOC` 从 `dou-dev-005 - 豆包` 变为 `◆dou-win-133 - 豆包`；探针文字只填入 composer，未回车，随后清空。

## 限制

- 目标标记必须唯一；普通标题可能匹配多个会话。
- 会话项必须在当前左侧列表可见；若被折叠/滚出视区，切换会失败并保留 WAL，不会误投。
- UIA 标题读取依赖豆包暴露 Document 名称；未来 UI 改版需重新校准，失败时保持 fail-closed。
- Windows 专用；非 Windows 返回“不支持”。
