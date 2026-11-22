//! Linux/macOS tmux 投递：把 Hub 消息注入配置好的 pane（通常是 agent 的 TUI）。
//!
//! 设计要点：
//!   - 不经过 shell 拼接，所有 tmux 参数都走 `Command::args`，正文不会被当成命令执行；
//!   - 单行消息用 `send-keys -l`；多行消息用 `load-buffer + paste-buffer -p`，
//!     尽量让 TUI 以 bracketed paste 整体接收，避免换行被逐行当成回车；
//!   - 投递前先看 pane 里有没有 `[Synapse #seq]` 标记，有就认为已经投过；
//!     粘贴后最多等约 1 秒轮询标记，看不到就不按回车，交给调用方保留 WAL 重试；
//!   - 回车发出后不再因为回读失败而重投，避免同一条消息重复提交。

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct PaneInfo {
    pub target: String,
    pub pane_id: String,
    pub command: String,
    pub path: String,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

/// macOS 的 launchd/cron PATH 常常不含 Homebrew 目录；显式探测一下，
/// 也允许用 SYNAPSE_TMUX_BIN 指向自定义 tmux。
fn tmux_bin() -> String {
    if let Ok(p) = std::env::var("SYNAPSE_TMUX_BIN") {
        if !p.trim().is_empty() { return p; }
    }
    for p in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"] {
        if Path::new(p).exists() { return p.to_string(); }
    }
    "tmux".into()
}

fn command() -> Command {
    Command::new(tmux_bin())
}

fn run(args: &[&str]) -> Result<String, String> {
    let out = command().args(args).output()
        .map_err(|e| format!("无法执行 tmux：{e}（Linux/macOS 请先安装 tmux；macOS 可设 SYNAPSE_TMUX_BIN）"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("tmux {} 失败（exit={}）", args.join(" "), out.status)
        } else {
            format!("tmux {} 失败：{stderr}", args.join(" "))
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn run_with_stdin(args: &[&str], text: &str) -> Result<(), String> {
    let mut child = command()
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法执行 tmux：{e}（Linux/macOS 请先安装 tmux；macOS 可设 SYNAPSE_TMUX_BIN）"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("写入 tmux buffer 失败：{e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("等待 tmux 失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("tmux {} 失败（exit={}）", args.join(" "), out.status)
        } else {
            format!("tmux {} 失败：{stderr}", args.join(" "))
        });
    }
    Ok(())
}

/// 校验 target 并返回 pane 信息；target 可以是 `session:window.pane`、`%3` 等 tmux 目标。
pub fn resolve_pane(target: &str) -> Result<PaneInfo, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("tmux target 为空：请配置 tmux_target（如 agent:0.0 或 %3）".into());
    }
    let out = run(&["display-message", "-p", "-t", target,
                    "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}"])?;
    let line = out.trim_end_matches(['\r', '\n']);
    let mut parts = line.splitn(3, '\t');
    let pane_id = parts.next().unwrap_or("").trim().to_string();
    if pane_id.is_empty() {
        return Err(format!("tmux target {target:?} 不是有效 pane"));
    }
    Ok(PaneInfo {
        target: target.to_string(),
        pane_id,
        command: parts.next().unwrap_or("").trim().to_string(),
        path: parts.next().unwrap_or("").trim().to_string(),
    })
}

/// 列出当前 tmux server 的所有 pane，供 `tmux-list` 选中 TUI 目标。
pub fn list_panes() -> Result<Vec<PaneInfo>, String> {
    let out = run(&[
        "list-panes", "-a", "-F",
        "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}",
    ])?;
    let mut panes = Vec::new();
    for line in out.lines() {
        let mut parts = line.splitn(4, '\t');
        let target = parts.next().unwrap_or("").trim().to_string();
        let pane_id = parts.next().unwrap_or("").trim().to_string();
        if target.is_empty() || pane_id.is_empty() { continue; }
        panes.push(PaneInfo {
            target,
            pane_id,
            command: parts.next().unwrap_or("").trim().to_string(),
            path: parts.next().unwrap_or("").trim().to_string(),
        });
    }
    Ok(panes)
}

/// 读取 pane 最近 N 行（包含历史），默认用 `-J` 合并自动换行的长行，便于匹配标记。
pub fn capture(target: &str, lines: usize) -> Result<String, String> {
    let start = format!("-{}", lines.max(1));
    run(&["capture-pane", "-p", "-J", "-t", target, "-S", &start])
}

/// 只匹配到 `[Synapse #N` 的前缀时，要求后面是 `]` 或空白，
/// 避免 `[Synapse #1` 误命中 `[Synapse #10]`。
fn contains_marker_prefix(hay: &str, prefix: &str) -> bool {
    if prefix.is_empty() { return false; }
    let mut offset = 0;
    while let Some(pos) = hay[offset..].find(prefix) {
        let end = offset + pos + prefix.len();
        match hay[end..].chars().next() {
            None => return true,
            Some(']') => return true,
            Some(c) if c.is_whitespace() => return true,
            _ => {}
        }
        offset = end;
    }
    false
}

fn send_literal(target: &str, text: &str) -> Result<(), String> {
    run(&["send-keys", "-t", target, "-l", "--", text]).map(|_| ())
}

fn paste_multiline(target: &str, text: &str) -> Result<(), String> {
    let buffer = format!("synapse-{}-{}", std::process::id(), now_ms());
    run_with_stdin(&["load-buffer", "-b", &buffer, "-"], text)?;
    let pasted = run(&["paste-buffer", "-p", "-b", &buffer, "-t", target]);
    let _ = run(&["delete-buffer", "-b", &buffer]);
    pasted.map(|_| ())
}

/// 只注入文字，不负责验证。`enter` 为 true 时末尾发送一次回车。
/// 有换行的正文走 bracketed paste，避免 tmux 把每个换行直接当成回车。
pub fn send_text(target: &str, text: &str, enter: bool) -> Result<(), String> {
    resolve_pane(target)?;
    if text.is_empty() {
        return Err("发送正文为空".into());
    }
    if text.contains('\n') {
        paste_multiline(target, text)?;
    } else {
        send_literal(target, text)?;
    }
    if enter {
        run(&["send-keys", "-t", target, "Enter"]).map(|_| ())?;
    }
    Ok(())
}

/// 带标记验证的投递：用于 `run --tmux` 和 `tmux-send --verify 1`。
///
/// 返回 Ok(true) 表示 pane 里已经看到标记（已投递/本次已上屏）；
/// 返回 Ok(false) 表示文字没有在 pane 中读到，调用方应保留 WAL 并稍后重试。
pub fn deliver(target: &str, text: &str, marker: &str, enter: bool) -> Result<bool, String> {
    let _pane = resolve_pane(target)?;
    let before = capture(target, 2000)?;
    let partial = if marker.starts_with("[Synapse #") { marker.trim_end_matches(']') } else { "" };
    if !marker.is_empty() && before.contains(marker) {
        // 标记已在 pane 里：不再粘贴；enter=1 时补一次回车，兼容“上次只粘贴、
        // 还没提交就失败退出”的 WAL 重试。目标 TUI 的空输入回车通常无副作用。
        if enter {
            run(&["send-keys", "-t", target, "Enter"])?;
            std::thread::sleep(Duration::from_millis(120));
        }
        return Ok(true);
    }
    // 上次可能已经把文字送进 composer，但 TUI 还没渲染出完整标记；此时只补回车，
    // 不再重复粘贴，避免慢 TUI 上同一条消息叠两份。
    if !partial.is_empty() && contains_marker_prefix(&before, partial) {
        if enter {
            run(&["send-keys", "-t", target, "Enter"])?;
            std::thread::sleep(Duration::from_millis(120));
        }
        return Ok(true);
    }
    if text.contains('\n') {
        paste_multiline(target, text)?;
    } else {
        send_literal(target, text)?;
    }
    let mut pasted = String::new();
    for _ in 0..5 {
        std::thread::sleep(Duration::from_millis(200));
        pasted = capture(target, 2000)?;
        if marker.is_empty() || pasted.contains(marker) {
            break;
        }
    }
    if !marker.is_empty() && !pasted.contains(marker) {
        // 慢 TUI 的局部标记：文字已在输入区，补回车提交，不再粘贴第二遍。
        if !partial.is_empty() && contains_marker_prefix(&pasted, partial) {
            if enter {
                run(&["send-keys", "-t", target, "Enter"])?;
                std::thread::sleep(Duration::from_millis(120));
            }
            return Ok(true);
        }
        // 看不到标记就不按回车，消息留在 WAL，等待目标 TUI 恢复。
        return Ok(false);
    }
    if enter {
        run(&["send-keys", "-t", target, "Enter"])?;
        // 回车后不再做回读硬判：部分 TUI 提交后会清空输入区，回读失败仍重投会重复。
        std::thread::sleep(Duration::from_millis(120));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::contains_marker_prefix;

    #[test]
    fn marker_prefix_has_boundary() {
        assert!(contains_marker_prefix("[Synapse #1] hi", "[Synapse #1"));
        assert!(contains_marker_prefix("[Synapse #1\nhi", "[Synapse #1"));
        assert!(!contains_marker_prefix("[Synapse #10] hi", "[Synapse #1"));
        assert!(!contains_marker_prefix("nothing", "[Synapse #1"));
    }
}
