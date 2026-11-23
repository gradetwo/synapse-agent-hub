//! synapse-agent（Rust）：单二进制，无 Python 环境也能接入。
//! 用法： synapse-agent init --endpoint … --project … --token …
//!        synapse-agent run   --endpoint … --project … --token … [--heartbeat 60]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::sync::{Arc, Mutex};
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
mod profile;
mod winmsg;
mod tmux;
mod localbus;
use std::io::{Write, Read};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ureq::Agent;
use tungstenite::{connect, Message};
use tungstenite::client_tls_with_config;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use sha2::{Digest, Sha256};

/// WS 连续失败后进入轮询的窗口；到点必须重新尝试 WS，避免一次网络抖动永久降级。
const WS_RETRY_AFTER_POLL: u64 = 120;

struct Cfg {
    cmd: String,
    endpoint: String,
    project: String,
    token: String,
    agent_id: String,
    dir: PathBuf,
    heartbeat_s: u64,
    exec_cmd: Option<String>,
    /// 默认窗口目标（应用名，如「豆包」），由 win-config 写入 config.json。
    window_app: String,
    /// 目标会话标题（特殊标记，如「◆dou-win-133」）。非空时窗口投递前先确保
    /// 该会话是当前活动会话；否则从左侧会话列表点击切换，失败则不 ACK。
    window_conversation: String,
    /// `run --window 1` / config.json 的 window_forward：把收件消息真正注入窗口后才 ACK。
    window_forward: bool,
    /// 默认 tmux pane（如 `agent:0.0` / `%3`），由 tmux-config 写入 config.json。
    tmux_target: String,
    /// `run --tmux ...` / config.json 的 tmux_forward：把收件消息注入 tmux 后才 ACK。
    tmux_forward: bool,
    /// tmux 投递是否要求 pane 回显 `[Synapse #seq]` 标记才 ACK。
    /// alternate-screen TUI（CodeBuddy/Claude 等）不回显注入文字，须设为 false，
    /// 否则 deliver() 永远读不到标记、WAL 每 5 秒重投造成同一条消息被反复粘贴。
    /// 默认 true 保持旧行为；可用 `--tmux-verify 0` / `SYNAPSE_TMUX_VERIFY=0` / config.json 关闭。
    tmux_verify: bool,
}

fn cfg_truthy(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "on" | "yes")
}

fn cfg_falsey(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no")
}

/// 解析窗口命令的目标：命令行 --app/--title 优先，否则用 config.json 的默认值，再退环境变量。
fn resolve_target(app: &str, title: &str, default_app: &str) -> Result<winmsg::WindowInfo, String> {
    if !app.is_empty() || !title.is_empty() {
        return winmsg::resolve_window(app, title);
    }
    if !default_app.is_empty() {
        return winmsg::find_app_window(default_app);
    }
    let env_app = std::env::var("SYNAPSE_WINDOW_APP").unwrap_or_default();
    if !env_app.is_empty() {
        return winmsg::find_app_window(&env_app);
    }
    Err("未指定目标窗口：请用 --app <应用名>（如 豆包），或先运行 win-config --app 豆包 设置默认目标".into())
}

impl Cfg {
    /// 是否开启了任意外部投递面（Windows 窗口 / Linux-macOS tmux）。
    fn surface_forward(&self) -> bool {
        self.window_forward || self.tmux_forward
    }

    /// 复制一份给线程用（Cfg 没有 derive Clone，避免改动对外结构）
    fn clone_lite(&self) -> Cfg {
        Cfg {
            cmd: self.cmd.clone(), endpoint: self.endpoint.clone(), project: self.project.clone(),
            token: self.token.clone(), agent_id: self.agent_id.clone(), dir: self.dir.clone(),
            heartbeat_s: self.heartbeat_s, exec_cmd: self.exec_cmd.clone(),
            window_app: self.window_app.clone(), window_conversation: self.window_conversation.clone(),
            window_forward: self.window_forward,
            tmux_target: self.tmux_target.clone(), tmux_forward: self.tmux_forward,
            tmux_verify: self.tmux_verify,
        }
    }

    fn from_args() -> Cfg {
        let mut map: HashMap<String, String> = HashMap::new();
        let mut args = std::env::args().skip(1);
        let cmd = args.next().unwrap_or_else(|| "run".into());
        while let Some(k) = args.next() {
            if let Some(v) = args.next() {
                map.insert(k.trim_start_matches("--").to_string(), v);
            }
        }
        let dir = dirs_config();
        // 命令行优先，其次读 ~/.synapse-agent/config.json（install 写入），最后才是默认
        let saved: Value = fs::read_to_string(dir.join("config.json"))
            .ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        let endpoint = map.get("endpoint").cloned()
            .or_else(|| saved["endpoint"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("SYNAPSE_ENDPOINT").ok().filter(|s| !s.trim().is_empty()))
            .or_else(|| std::env::var("YANSHI_ENDPOINT").ok().filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let project = map.get("project").cloned()
            .or_else(|| saved["project"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("SYNAPSE_PROJECT").ok().filter(|s| !s.trim().is_empty()))
            .or_else(|| std::env::var("YANSHI_PROJECT").ok().filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| "yanshi".into());
        let token = map.get("token").cloned()
            .or_else(|| saved["token"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("SYNAPSE_TOKEN").ok().filter(|s| !s.trim().is_empty()))
            .or_else(|| std::env::var("YANSHI_TOKEN").ok().filter(|s| !s.trim().is_empty()))
            .unwrap_or_default();
        let agent_id = map.get("agent").cloned()
            .or_else(|| saved["agent_id"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "rust-agent".into());
        let heartbeat_s = map.get("heartbeat").and_then(|s| s.parse().ok())
            .or_else(|| saved["heartbeat_s"].as_u64()).unwrap_or(60);
        let window_app = map.get("app").cloned()
            .or_else(|| saved["window_app"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        // 目标会话标题（特殊标记）：命令行 --conversation / --window-conversation 优先，
        // 其次 config.json window_conversation，最后环境变量 SYNAPSE_WINDOW_CONVERSATION。
        let window_conversation = map.get("conversation").cloned()
            .or_else(|| map.get("window-conversation").cloned())
            .or_else(|| saved["window_conversation"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("SYNAPSE_WINDOW_CONVERSATION").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_default();
        // 窗口转发必须显式开启：避免普通 win-config 用户跑 run 时意外把消息打进窗口。
        // 命令行 --window 1 优先，其次 config.json，最后环境变量。
        let window_forward = map.get("window")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .or_else(|| saved["window_forward"].as_bool())
            .or_else(|| std::env::var("SYNAPSE_WINDOW_FORWARD").ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true")))
            .unwrap_or(false);

        // tmux 目标/开关：--tmux <target> 同时设置目标并开启；--tmux 1 使用已保存/环境变量目标；
        // --tmux 0 关闭。--tmux-target 等价于 --tmux <target>。
        let tmux_arg = map.get("tmux").cloned().or_else(|| map.get("tmux-target").cloned());
        let tmux_target = match tmux_arg.as_deref() {
            Some(v) if !v.is_empty() && !cfg_truthy(v) && !cfg_falsey(v) => v.to_string(),
            _ => std::env::var("SYNAPSE_TMUX_TARGET").ok().filter(|s| !s.is_empty())
                .or_else(|| saved["tmux_target"].as_str().map(|s| s.to_string()))
                .unwrap_or_default(),
        };
        let tmux_forward = match tmux_arg.as_deref() {
            Some(v) if cfg_truthy(v) => true,
            Some(v) if cfg_falsey(v) => false,
            Some(v) if !v.is_empty() => true,
            _ => std::env::var("SYNAPSE_TMUX_FORWARD").ok().filter(|s| !s.is_empty()).map(|v| cfg_truthy(&v))
                .or_else(|| saved["tmux_forward"].as_bool())
                .unwrap_or(false),
        };
        // tmux 标记验证：默认开启（旧行为）。alternate-screen TUI 不回显注入文字，
        // 关掉后改用 deliver_no_verify（注入即 ACK），避免 WAL 重投风暴。
        // 优先级：--tmux-verify > SYNAPSE_TMUX_VERIFY > config.json > 默认 true。
        let tmux_verify = map.get("tmux-verify")
            .map(|v| cfg_truthy(v))
            .or_else(|| std::env::var("SYNAPSE_TMUX_VERIFY").ok().filter(|s| !s.is_empty()).map(|v| cfg_truthy(&v)))
            .or_else(|| saved["tmux_verify"].as_bool())
            .unwrap_or(true);
        Cfg { cmd, endpoint, project, token, agent_id, exec_cmd: map.get("exec").cloned(), heartbeat_s, dir, window_app, window_conversation, window_forward, tmux_target, tmux_forward, tmux_verify }
    }
}

fn dirs_config() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    { let n = PathBuf::from(&home).join(".synapse-agent");
        if !n.exists() && PathBuf::from(&home).join(".yanshi-agent").exists() { PathBuf::from(&home).join(".yanshi-agent") } else { n } }
}

/// 从文件读取 UTF-8 文本（发代码 / patch 用：绕开 Windows 命令行长度上限与转义）。
/// 自动剥离 UTF-8 BOM；非 UTF-8 报明确错误。
fn read_text_file(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取文件 {path} 失败：{e}"))?;
    let mut s = String::from_utf8(bytes).map_err(|e| format!("文件 {path} 不是有效 UTF-8：{e}"))?;
    if s.starts_with('\u{feff}') { s = s.trim_start_matches('\u{feff}').to_string(); }
    Ok(s)
}

/// 从 stdin 读取全部文本（管道串接：`type patch.diff | synapse-agent win-send --stdin`）。
fn read_text_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("读 stdin 失败：{e}"))?;
    if s.starts_with('\u{feff}') { s = s.trim_start_matches('\u{feff}').to_string(); }
    Ok(s)
}

/// 统一解析发送正文：优先级 --text > --file > --stdin。都给时取第一个非空来源。
/// 这样 agent 把代码/patch 写到文件后 `win-send --file p.patch` 即可整段发送。
fn resolve_send_text(
    args: &HashMap<String, String>, flags: &std::collections::HashSet<String>,
) -> String {
    if let Some(t) = args.get("text") {
        if !t.is_empty() { return t.clone(); }
    }
    if let Some(p) = args.get("file") {
        match read_text_file(p) {
            Ok(s) => return s,
            Err(e) => { eprintln!("{e}"); std::process::exit(2); }
        }
    }
    if flags.contains("stdin") {
        match read_text_stdin() {
            Ok(s) => return s,
            Err(e) => { eprintln!("{e}"); std::process::exit(2); }
        }
    }
    String::new()
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn load1() -> Option<f64> {
    fs::read_to_string("/proc/loadavg").ok()?.split(' ').next()?.parse().ok()
}

fn mem_mb() -> Option<(u64, u64)> {
    let txt = fs::read_to_string("/proc/meminfo").ok()?;
    let total = txt.lines().find(|l| l.starts_with("MemTotal"))?.split_whitespace().nth(1)?.parse::<u64>().ok()? / 1024;
    let avail = txt.lines().find(|l| l.starts_with("MemAvailable"))?.split_whitespace().nth(1)?.parse::<u64>().ok()? / 1024;
    Some((total - avail, total))
}

fn disk() -> Value {
    // 简化：读 statfs 需要 libc，这里用 df 兜底
    let out = std::process::Command::new("df").args(["-BG", "--output=avail,pcent", "/"]).output();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
        if let Some(line) = s.lines().last() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 2 {
                return json!([{
                    "mount": "/",
                    "free_gb": f[0].trim_end_matches('G').parse::<i64>().unwrap_or(0),
                    "used_pct": f[1].trim_end_matches('%').parse::<i64>().unwrap_or(0)
                }]);
            }
        }
    }
    json!([])
}

fn git_head() -> Option<String> {
    let o = std::process::Command::new("git").args(["rev-parse", "--short", "HEAD"]).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn epoch_get(dir: &PathBuf) -> String {
    fs::read_to_string(dir.join("epoch.txt")).unwrap_or_default()
}

fn epoch_set(dir: &PathBuf, ep: &str) {
    let _ = fs::write(dir.join("epoch.tmp"), ep);
    let _ = fs::rename(dir.join("epoch.tmp"), dir.join("epoch.txt"));
}

fn cursor_get(dir: &PathBuf) -> u64 {
    fs::read_to_string(dir.join("cursor.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["seq"].as_u64())
        .unwrap_or(0)
}

fn cursor_set(dir: &PathBuf, seq: u64) {
    atomic_write(&dir.join("cursor.json"),
                 json!({"seq": seq, "at": now_ms()}).to_string().as_bytes());
}

/// 写临时文件 → fsync → rename：崩溃时要么是旧文件、要么是新文件，不会出现半截 JSON。
fn atomic_write(path: &std::path::Path, data: &[u8]) {
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, data).is_err() { return; }
    if let Ok(f) = fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    let _ = fs::rename(&tmp, path);
}

/// 写入可能含 token 的 config.json：临时文件 600 后再原子替换。
fn write_private_json(path: &std::path::Path, body: &Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(body).map_err(|e| format!("序列化配置失败：{e}"))?)
        .map_err(|e| format!("写临时配置失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| format!("落盘配置失败：{e}"))?;
    Ok(())
}

fn journal_path(dir: &PathBuf) -> PathBuf { dir.join("inflight.json") }

/// 已投递但尚未“处理完”的消息（收到即落盘，处理完才删）。
/// 这是崩溃恢复的 WAL：游标可以前移，但消息还在 inflight 里，重启后会重放。
fn journal_load(dir: &PathBuf) -> Vec<Value> {
    let mut items: Vec<Value> = fs::read_to_string(journal_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["items"].as_array().cloned())
        .unwrap_or_default();
    items.sort_by_key(|m| m["seq"].as_u64().unwrap_or(0));
    items
}

fn journal_save(dir: &PathBuf, items: &[Value]) {
    atomic_write(&journal_path(dir), json!({"items": items}).to_string().as_bytes());
}

fn seq_of(m: &Value) -> Option<u64> { m["seq"].as_u64() }

/// 消息身份：优先 dedupe_key（内容身份，seq 归零/重投都不变）；旧消息没有才退回 seq。
fn dedupe_key_of(m: &Value) -> Option<&str> {
    m["dedupe_key"].as_str().filter(|s| !s.is_empty())
}

fn same_message(a: &Value, b: &Value) -> bool {
    match (dedupe_key_of(a), dedupe_key_of(b)) {
        (Some(x), Some(y)) => x == y,
        _ => seq_of(a).is_some() && seq_of(a) == seq_of(b),
    }
}

/// 房间重建：游标归零、换 epoch、清空未处理 WAL。
fn reset_room_state(cfg: &Cfg, epoch: &str, journal: Option<&Arc<Mutex<Vec<Value>>>>) {
    cursor_set(&cfg.dir, 0);
    epoch_set(&cfg.dir, epoch);
    if let Some(j) = journal {
        let mut g = j.lock().unwrap();
        g.clear();
        journal_save(&cfg.dir, &g);
    }
}

/// 回声/噪音过滤：ack 事件、自己发出的消息（含广播）都不进队列。
/// `SYNAPSE_INCLUDE_SELF=1` 只给端到端自测用：用本 agent token 向自己 publish
/// 一条真实 Hub 消息，验证服务端 → WebSocket → 窗口这条链路；生产不要设置。
fn is_noise(cfg: &Cfg, m: &Value) -> bool {
    if m["topic"].as_str() == Some("ack") { return true; }
    if m["sender"].as_str() == Some(cfg.agent_id.as_str())
        && std::env::var("SYNAPSE_INCLUDE_SELF").ok().as_deref() != Some("1")
    {
        return true;
    }
    false
}

/// 只处理发给本 agent、或项目广播的消息；与 for_me 保持同一语义。
fn addressed_to_me(cfg: &Cfg, m: &Value) -> bool {
    for_me(cfg, m)
}

/// 任务板内部通知不进窗口；普通 task（管理员下发的正文）仍然要进。
fn is_task_notice(m: &Value) -> bool {
    matches!(m["kind"].as_str(), Some("task_notice")) ||
        matches!(m["topic"].as_str(), Some("task_notice")) ||
        // claimed/released/done/reclaimed 是任务板生命周期事件，无正文；
        // 只有 kind=task 的消息才是管理员下发的任务正文。
        (m["topic"].as_str() == Some("task") && m["kind"].as_str() != Some("task"))
}

/// 外部投递（窗口/tmux）只接“点名给本 agent 的消息”和“管理端广播”，不接项目事件流。
///
/// 服务端为了管理台能看到完整台账，会把其他 agent 的 artifact 建单、任务
/// claimed/released/done 以及部分 report 都写成 `to=null` 的项目广播；这些在
/// `for_me` 里会被当成“广播”放行。artifact 的 payload 带 title，format_hub_message
/// 会把它压成正文，于是别人的交付汇报就进了窗口。这里按发送者/话题再做一次窗口侧过滤：
/// - artifact：交付箱事件，属于管理台，不是聊天指令；
/// - task 生命周期：不是任务正文；
/// - 其他 agent 发出的无收件人广播（report/status/announce 等）：不是给本窗口的指令。
/// 定向消息（to 指向本 agent）仍然放行，管理员广播仍然放行。
fn is_surface_noise(cfg: &Cfg, m: &Value) -> bool {
    if is_noise(cfg, m) || is_task_notice(m) || !addressed_to_me(cfg, m) {
        return true;
    }
    if m["topic"].as_str() == Some("artifact") {
        return true;
    }
    if m["to"].is_null() && m["sender"].as_str() != Some("admin") {
        return true;
    }
    false
}

/// 从 `[Synapse #12] ...` 这类正文里取去重标记；没有标记返回 None。
fn message_marker(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("[Synapse #") {
        return None;
    }
    let end = trimmed.find(']')?;
    Some(&trimmed[..=end])
}

/// 把 Hub 消息压成适合粘贴进聊天框的正文：优先 payload.title/body，
/// 兼容 task.create 的 payload.task_id/title/body 和 report 的 detail.note。
fn format_hub_message(m: &Value) -> Option<String> {
    let p = &m["payload"];
    let task = &p["task"];
    let detail = &p["detail"];
    let title = p["title"].as_str()
        .or_else(|| task["title"].as_str())
        .unwrap_or("");
    let body = p["body"].as_str()
        .or_else(|| task["body"].as_str())
        .or_else(|| p["text"].as_str())
        .or_else(|| detail["note"].as_str())
        .unwrap_or("");
    if title.trim().is_empty() && body.trim().is_empty() {
        return None;
    }
    // 统一用方括号标签，send_text_click_paste_checked 会把它当作重试去重标记。
    let seq = seq_of(m).map(|s| format!("[Synapse #{s}] ")).unwrap_or_default();
    let mut text = String::new();
    if !title.trim().is_empty() {
        text.push_str(title.trim());
        if !body.trim().is_empty() { text.push('\n'); }
    }
    text.push_str(body.trim());
    Some(format!("{seq}{text}"))
}

/// tmux/TUI 默认压成单行：TUI 的输入框不一定支持 bracketed paste，
/// 多行正文里的换行可能被当成回车，提前把半条消息提交出去。
fn flatten_hub_message(text: &str) -> String {
    text.lines().map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `run --tmux ...` 的投递端：把消息注入配置好的 TUI pane，并回车提交。
/// 返回 false 表示 pane 不可用/没看到 `[Synapse #seq]` 标记；调用方保留 WAL、不 ACK。
fn forward_to_tmux_impl(cfg: &Cfg, m: &Value) -> bool {
    if surface_was_delivered(m) {
        return true;
    }
    if !cfg.tmux_forward || is_surface_noise(cfg, m) {
        return true;
    }
    let Some(raw) = format_hub_message(m) else { return true; };
    let text = flatten_hub_message(&raw);
    let seq = seq_of(m).unwrap_or(0);
    if cfg.tmux_target.trim().is_empty() {
        eprintln!("[tmux] seq={seq} 未配置 tmux_target，保留 WAL 且不 ACK");
        return false;
    }
    let marker = format!("[Synapse #{seq}]");
    // 标记验证对 alternate-screen TUI（CodeBuddy/Claude）无效：注入文字不回显到
    // capture-pane，deliver() 永远读不到标记 → WAL 每 5 秒重投、同一条消息被反复粘贴。
    // tmux_verify=false 时改用 deliver_no_verify：注入命令成功即 ACK，靠 WAL 防重。
    let delivered = if cfg.tmux_verify {
        tmux::deliver(&cfg.tmux_target, &text, &marker, true)
    } else {
        tmux::deliver_no_verify(&cfg.tmux_target, &text, true)
    };
    match delivered {
        Ok(true) => {
            let pane = tmux::resolve_pane(&cfg.tmux_target)
                .map(|p| format!("{} ({})", p.pane_id, p.command))
                .unwrap_or_else(|_| cfg.tmux_target.clone());
            let mode = if cfg.tmux_verify { "" } else { "（无标记验证）" };
            eprintln!("[tmux] seq={seq} 已注入 {pane} 并回车{mode}");
            true
        }
        Ok(false) => {
            eprintln!("[tmux] seq={seq} pane 中未读到标记，保留 WAL 且不 ACK");
            false
        }
        Err(e) => {
            eprintln!("[tmux] seq={seq} 投递失败，保留 WAL 且不 ACK：{e}");
            false
        }
    }
}

/// 按配置选择外部投递面：tmux 优先（Linux/macOS），否则 Windows 窗口。
fn forward_to_surface_impl(cfg: &Cfg, m: &Value) -> bool {
    if cfg.tmux_forward {
        forward_to_tmux_impl(cfg, m)
    } else {
        forward_to_window_impl(cfg, m)
    }
}

/// 外部投递串行化：Windows 窗口注入是全局鼠标/键盘操作；tmux 投递也共用此锁，
/// 避免同一 pane 被多个线程同时粘贴/回车。
static SURFACE_SEND_LOCK: Mutex<()> = Mutex::new(());

fn surface_was_delivered(m: &Value) -> bool {
    m["_window_delivered"].as_bool().unwrap_or(false)
}

/// 只有真正开了外部投递（窗口/tmux），ACK 备注才写“已投递”；普通 run 仍保持旧的 receipt 语义。
fn ack_note(cfg: &Cfg, delivered: &'static str, receipt: &'static str) -> &'static str {
    if cfg.surface_forward() { delivered } else { receipt }
}

/// 在 WAL 里给消息打“已投递到外部面”标记；进程崩溃后重放时不会重复往窗口/tmux 发。
fn mark_surface_delivered(dir: &PathBuf, journal: &Arc<Mutex<Vec<Value>>>, m: &Value) {
    let mut items = journal.lock().unwrap();
    for x in items.iter_mut() {
        if same_message(x, m) {
            x["_window_delivered"] = json!(true);
            break;
        }
    }
    journal_save(dir, &items);
}

fn window_targets(raw: &str) -> Vec<String> {
    let env = std::env::var("SYNAPSE_WINDOW_APP").unwrap_or_default();
    let source = if raw.trim().is_empty() { env } else { raw.to_string() };
    source.split(|c| c == ',' || c == ';' || c == '|')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// WorkBuddy 的 Chromium 没向 UIA 暴露编辑控件（只暴露 Chrome Legacy Window），
/// 只能按窗口布局点击。欢迎页 composer 在约 (0.75,0.65)；任务会话页在底部，
/// 用 (0.75,0.88) 兜底。每次点击后仍会用 Ctrl+A/C 读 composer 验证，点错不会 ACK。
fn fallback_clicks(app: &str) -> &'static [(f64, f64)] {
    if app.to_lowercase().contains("workbuddy") {
        &[(0.75, 0.65), (0.75, 0.88), (0.53, 0.83)]
    } else {
        &[(0.53, 0.83)]
    }
}

/// `run --window 1` 的投递端：定向消息注入窗口并自动回车。
/// 返回 false 表示窗口不可用/没有真正上屏；调用方必须保留 WAL、不得 ACK，
/// 否则服务端会认为已送达，用户窗口/tmux 却永远看不到。
fn forward_to_window_impl(cfg: &Cfg, m: &Value) -> bool {
    if surface_was_delivered(m) {
        return true;
    }
    if !cfg.window_forward || is_surface_noise(cfg, m) {
        return true;
    }
    let Some(text) = format_hub_message(m) else { return true; };
    let seq = seq_of(m).unwrap_or(0);
    let apps = window_targets(&cfg.window_app);
    if apps.is_empty() {
        eprintln!("[window] seq={seq} 未配置 window_app，保留 WAL 且不 ACK");
        return false;
    }
    let mut last_err = String::new();
    let mut resolved: Vec<(String, usize, String)> = Vec::new();
    for app in &apps {
        match resolve_target("", "", app) {
            Ok(w) => resolved.push((app.clone(), w.hwnd, w.title)),
            Err(e) => {
                last_err = format!("找不到目标窗口（window_app={app:?}）：{e}");
            }
        }
    }
    // 同一套 binary 同时支持豆包和 WorkBuddy，但一条消息只能投给一个应用：
    // 当前前台窗口在候选里就选它，否则选配置里的第一个。不能在前台/后台应用之间
    // 依次尝试，否则一次回读失败就会把同一条消息送进两个应用。
    let foreground = winmsg::foreground_hwnd();
    let foreground_pos = if foreground != 0 {
        resolved.iter().position(|(_, hwnd, _)| *hwnd == foreground)
    } else {
        None
    };
    if let Some(pos) = foreground_pos {
        eprintln!("[window] seq={seq} 前台窗口是 {}，投递到该应用", resolved[pos].2);
    }
    if resolved.is_empty() {
        eprintln!("[window] seq={seq} 没有可用窗口，保留 WAL 且不 ACK：{last_err}");
        return false;
    }
    // 只选一个目标应用，绝不在多个应用之间轮询重试。
    // 否则第一个应用其实已经上屏、只是回读失败时，第二个应用会再收到一遍，造成重复投送。
    let selected = if let Some(pos) = foreground_pos {
        resolved.remove(pos)
    } else {
        resolved.remove(0)
    };
    let (app, hwnd, title) = selected;
    // 目标会话：如果配置了特殊标题，先确保豆包/目标应用已经切到该会话。
    // 这一步失败就直接保留 WAL、不 ACK，避免消息落进默认主对话或别的会话。
    if !cfg.window_conversation.trim().is_empty() {
        match winmsg::ensure_conversation(hwnd, &cfg.window_conversation) {
            Ok(()) => eprintln!(
                "[window] seq={seq} 已确认目标会话 {:?}（{app}）",
                cfg.window_conversation
            ),
            Err(e) => {
                eprintln!(
                    "[window] seq={seq} 目标会话切换失败，保留 WAL 且不 ACK：{}：{e}",
                    cfg.window_conversation
                );
                return false;
            }
        }
    }
    let &(cx, cy) = fallback_clicks(&app).first().unwrap_or(&(0.53, 0.83));
    match winmsg::send_text_click_paste_checked(hwnd, &text, true, cx, cy) {
        Ok(verified) => {
            if verified {
                eprintln!("[window] seq={seq} 已注入 {title:?}（{app}）并自动回车（UIA 已验证）");
            } else {
                eprintln!("[window] seq={seq} 已粘贴 {title:?}（{app}）并自动回车（按 {cx}/{cy} 点击，Ctrl+A/C 已复核）");
            }
            true
        }
        Err(e) => {
            eprintln!("[window] seq={seq} 投递失败，保留 WAL 且不 ACK：{app}@{cx}/{cy}: {e}");
            false
        }
    }
}

fn forward_to_surface(cfg: &Cfg, m: &Value) -> bool {
    let _gate = SURFACE_SEND_LOCK.lock().unwrap();
    forward_to_surface_impl(cfg, m)
}

/// WS 收件线程投递失败后，消息留在 WAL 且没有 ACK。主线程空闲时每 5 秒重试一次，
/// 成功才 ACK + 执行 + 出队。这样窗口晚开、tmux pane 切走、composer/输入框暂时隐藏都能自动补发。
fn retry_pending_surfaces(cfg: &Cfg, agent: &Agent, base: &str,
                          journal: &Arc<Mutex<Vec<Value>>>, last_msg: &AtomicU64) -> usize {
    if !cfg.surface_forward() { return 0; }
    let pending: Vec<Value> = { journal.lock().unwrap().clone() };
    let mut sent = 0usize;
    for m in pending {
        if surface_was_delivered(&m) {
            continue;
        }
        // 旧 WAL 里可能残留被外部投递过滤的消息；不要只 continue，否则会永远卡住。
        // 这类消息不投窗口/tmux、不执行 exec，但要补 ACK 并出队。
        if is_surface_noise(cfg, &m) {
            let seq = seq_of(&m).unwrap_or(0);
            let _ = ack_message(cfg, agent, base, seq, "done",
                                &json!({"note": "run 外部投递过滤（非本窗口消息）"}), ack_required(&m));
            dequeue_message(&cfg.dir, journal, &m);
            continue;
        }
        let delivered = {
            let _gate = SURFACE_SEND_LOCK.lock().unwrap();
            // pending 是在拿锁前克隆的；deliver_ws 可能已经在这段时间里把这条消息
            // 投进窗口/tmux 并打上 _window_delivered。拿到锁后必须重新查当前 WAL，
            // 不能再信任旧快照，否则同一条消息会被重试线程再粘贴一遍。
            let already_marked = journal.lock().unwrap().iter()
                .any(|x| same_message(x, &m) && surface_was_delivered(x));
            if already_marked {
                false
            } else {
                let ok = forward_to_surface_impl(cfg, &m);
                if ok { mark_surface_delivered(&cfg.dir, journal, &m); }
                ok
            }
        };
        if !delivered { continue; }
        let seq = seq_of(&m).unwrap_or(0);
        let _ = ack_message(cfg, agent, base, seq, "done",
                            &json!({"note": "run 重试后已投递"}), ack_required(&m));
        let text = serde_json::to_string(&m).unwrap_or_default();
        if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &text); } else { println!("{text}"); }
        dequeue_message(&cfg.dir, journal, &m);
        last_msg.store(now_ms() as u64, Ordering::Relaxed);
        sent += 1;
    }
    sent
}

fn for_me(cfg: &Cfg, m: &Value) -> bool {
    match &m["to"] {
        Value::Null => true,
        Value::String(t) => t == &cfg.agent_id,
        // 服务端 to 允许数组（定向多人/广播名单），不能把它当广播放行
        Value::Array(a) => a.iter().any(|x| x.as_str() == Some(cfg.agent_id.as_str())),
        _ => false,
    }
}

/// 投递一条消息：先落 inflight（WAL），再推游标。返回 true 表示是新消息。
fn enqueue_message(cfg: &Cfg, journal: &Arc<Mutex<Vec<Value>>>, m: &Value) -> bool {
    let Some(seq) = seq_of(m) else { return false };
    if seq <= cursor_get(&cfg.dir) { return false; }
    let mut items = journal.lock().unwrap();
    if items.iter().any(|x| same_message(x, m)) {
        drop(items);
        // 崩溃点落在“已写 WAL、未推游标”之间：WAL 里已有，补推游标即可，不能重复投递。
        // 同一 dedupe_key 换了 seq 重投时也走这里，避免同一条业务消息被执行两次。
        if seq > cursor_get(&cfg.dir) { cursor_set(&cfg.dir, seq); }
        return false;
    }
    items.push(m.clone());
    items.sort_by_key(|x| seq_of(x).unwrap_or(0));
    journal_save(&cfg.dir, &items);
    drop(items);
    cursor_set(&cfg.dir, seq);
    true
}

/// 处理完成：从 WAL 移除（优先按 dedupe_key 身份匹配，旧消息按 seq）。
fn dequeue_message(dir: &PathBuf, journal: &Arc<Mutex<Vec<Value>>>, m: &Value) {
    let mut items = journal.lock().unwrap();
    items.retain(|x| !same_message(x, m));
    journal_save(dir, &items);
}

/// 回执（可重试）。409/2xx 视为已回执。返回是否成功。
fn ack_message(cfg: &Cfg, agent: &Agent, base: &str, seq: u64,
               status: &str, detail: &Value, required: bool) -> bool {
    if !required { return true; }
    let body = json!({
        "seq": seq, "agent_id": cfg.agent_id, "status": status, "detail": detail,
    });
    for attempt in 0..3u32 {
        match agent.post(&format!("{}/p/{}/ack", base, cfg.project))
            .set("authorization", &format!("Bearer {}", cfg.token))
            .set("connection", "close")
            .send_json(body.clone())
        {
            Ok(_) => return true,
            Err(ureq::Error::Status(409, _)) => return true,
            Err(e) => {
                eprintln!("[ack] seq={seq} status={status} 第 {} 次失败：{e}", attempt + 1);
                thread::sleep(Duration::from_millis(300u64 * (1 << attempt)));
            }
        }
    }
    false
}

fn ack_required(m: &Value) -> bool {
    m["payload"]["action_required"]["ack_required"].as_bool().unwrap_or(false)
}

/// run/ws 的单实例锁：同一 STATE_DIR 只允许一个常驻进程。
#[cfg(unix)]
fn acquire_run_lock(dir: &PathBuf) -> Option<fs::File> {
    use std::os::unix::io::AsRawFd;
    extern "C" { fn flock(fd: i32, op: i32) -> i32; }
    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    let f = fs::OpenOptions::new().create(true).write(true)
        .open(dir.join("run.lock")).ok()?;
    let rc = unsafe { flock(f.as_raw_fd(), LOCK_EX | LOCK_NB) };
    if rc == 0 { Some(f) } else { None }
}

#[cfg(windows)]
fn acquire_run_lock(dir: &PathBuf) -> Option<fs::File> {
    // Windows 用“不共享”打开：另一个 run 再开会直接失败，等价于 flock
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new().create(true).write(true).share_mode(0)
        .open(dir.join("run.lock")).ok()
}

#[cfg(all(not(unix), not(windows)))]
fn acquire_run_lock(dir: &PathBuf) -> Option<fs::File> {
    fs::OpenOptions::new().create(true).write(true)
        .open(dir.join("run.lock")).ok()
}

#[cfg(unix)]
fn pid_alive(pid: u64) -> bool {
    extern "C" { fn kill(pid: i32, sig: i32) -> i32; }
    if pid == 0 { return false; }
    unsafe { kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_alive(pid: u64) -> bool {
    // Windows 没有 /proc：用 tasklist 精确查 PID；查不到就按“进程已死”处理，避免假活
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

fn write_run_state(dir: &PathBuf, body: &Value) {
    atomic_write(&dir.join("run.state.json"), body.to_string().as_bytes());
}

/// 连接/断开时立即落状态，避免 status 要等下一次心跳（最长 60s）才看到真实 connected。
fn write_ws_state(dir: &PathBuf, connected: bool, queue: usize,
                  last_msg_ms: u64, unacked: usize, gate: &Mutex<()>) {
    // 与心跳线程共用一把写锁：谁最后写，谁的 connected 就是写锁内读到的原子值，
    // 避免“刚连上就被上一轮心跳写成 false”的竞态。
    let _g = gate.lock().unwrap();
    // 连/断事件只改连接相关字段，保留上一拍心跳结果；否则 status 会在断开瞬间
    // 把 last_hb_ok/last_hb_ms 写成 null，看起来像从未心跳成功。
    let old: Value = fs::read_to_string(dir.join("run.state.json")).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let old_last_msg = old["last_msg_ms"].as_u64().unwrap_or(0);
    let last_msg_ms = old_last_msg.max(last_msg_ms);
    write_run_state(dir, &json!({
        "connected": connected, "transport": "ws",
        "last_hb_ok": old["last_hb_ok"].clone(),
        "last_hb_ms": old["last_hb_ms"].clone(),
        "last_msg_ms": last_msg_ms, "queue": queue, "unacked": unacked,
        "pid": std::process::id(),
    }));
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == "--help" || a == "-h" || a == "help") {
        println!("synapse-agent {}\n\n基础用法:\n  synapse-agent init --endpoint <url> --project <p> --token <t> [--agent <id>]\n  synapse-agent run  [--exec \"cmd\"] [--window 1 | --tmux <target|1|0>] [--proxy <url>|off]\n        --window 1：Windows 收件后先切到 window_conversation 会话再注入 window_app 窗口，UIA/剪贴板验证成功才 ACK。\n        --conversation <标题>：临时指定目标会话标题（特殊标记）；默认用 config.json 的 window_conversation。\n        --tmux <target|1|0>：Linux/macOS 收件后注入 tmux pane（如 %3 或 agent:0.0），看到 [Synapse #seq] 才 ACK；\n                          --tmux 1 使用 tmux-config 保存的目标，--tmux 0 关闭本次投递。\n        代理：默认先探测直连，直连不可用才使用 HTTPS_PROXY/ALL_PROXY 环境代理；--proxy <url> 强制代理，--proxy off 强制直连；NO_PROXY 命中直连。\n  synapse-agent status\n  synapse-agent wait | peek | profile | subs | get\n  synapse-agent agents | send | broadcast                  # 需 admin token\n  synapse-agent issue --title <t> [--body <s>|--body-file <path>] [--priority low|normal|high|urgent] [--labels <s>] [--self]\n        --self：上报的同时转成 reporter 自己的任务；也可稍后用 issue-take --issue <id> 转换。\n  synapse-agent issue-take --issue <id>                      # reporter 把本人 open Issue 转成自己的任务\n  synapse-agent issues [--status open|closed|merged] [--limit N]  # 需 admin token
  synapse-agent upgrade [--apply 1] [--platform <tag>]   # 按当前平台选包；默认只检查\n\n交付（upload/submit 已补齐，deliver 为回合制 agent 一次调用完成）:\n  synapse-agent upload --file <path>                       # 直传 R2，输出 ref\n  synapse-agent submit --kind patch --title <t> --ref <sha>[:<name>] [--ref ...] \\\n                        [--base-sha <sha>] [--checks <json字符串>] [--notes <s>]\n  synapse-agent deliver --file <path> --kind patch --title <t> [--base-sha <sha>]\n\nLinux/macOS tmux 投递（TUI）:\n  synapse-agent tmux-config --target <session:window.pane>  ★设置默认 pane 并开启（如 %3 或 agent:0.0）\n        tmux-config [--show|--clear] 查看/清除；tmux-config --enable 0 只关开关。\n        tmux-config --verify 0 关闭标记验证：alternate-screen TUI（CodeBuddy/Claude）不回显注入文字，\n                           用 0 改为注入即 ACK，避免标记读不到导致 WAL 每 5 秒重投、同一条消息反复粘贴。\n        也可用环境变量 SYNAPSE_TMUX_TARGET / SYNAPSE_TMUX_FORWARD=1 / SYNAPSE_TMUX_VERIFY=0 临时覆盖。\n  synapse-agent tmux-list                                     # 列出所有 pane，找 TUI 目标\n  synapse-agent tmux-send --target <...> (--text <文字>|--file <文件>|--stdin) [--enter 1] [--verify 1]\n        向 pane 注入文字并回车；--verify 1 用正文里的 [Synapse #seq] 标记验证。\n  synapse-agent run --tmux <target|1|0>                       # 收件后注入配置的 TUI pane，成功才 ACK\n\n本地窗口桥（Windows）:\n  synapse-agent win-config --app <应用名> --conversation <特殊标题标记>\n        ★设置默认目标与会话，写入 config.json（如 win-config --app 豆包 --conversation “◆dou-win-133”）\n        win-config [--show|--clear] 查看/清除默认目标与会话。设置后 win-send/win-read/bridge/run --window 1 自动使用。\n        也可用环境变量 SYNAPSE_WINDOW_APP / SYNAPSE_WINDOW_CONVERSATION 临时覆盖。\n  synapse-agent win-list [--app <应用名>] [--match <标题子串>]\n  synapse-agent uia-dump [--app <应用名>]    # 输出 UIA 控件树，用于排查 composer/输入框定位\n        发现窗口。--app 豆包 会按进程名自动找到豆包窗口（推荐，无需手输标题）。\n  synapse-agent win-send (--app <应用名> | --title <子串>) (--text <文字> | --file <UTF-8文件> | --stdin) [--enter 1] [--verify 1] [--method click|paste|copy|both]\n        向目标窗口发送文字。--app 时自动发现进程与窗口；默认 click=点击输入框再粘贴（对 Electron 豆包最稳，支持中文）。\n        ★发代码 / patch 请用 --file <文件> 或 --stdin（type p.patch | ... --stdin）：整段读 UTF-8，绕开命令行 32767 字符上限与转义。\n        --text / --file / --stdin 三选一（同时给时按此优先级取非空）。\n  synapse-agent win-read (--app <应用名> | --title <子串>) [--diff] [--no-restore]\n        读取目标窗口文本；--diff 输出相对上次的新增行（用于提取“新消息”）。\n  synapse-agent win-bridge --title <子串> --mode in|out [--name <管道名>]\n        把窗口对接到本机消息总线：in=窗口新消息读入总线；out=总线消息写入窗口。\n\n本机消息总线:\n  synapse-agent bus-serve [--name <管道名>]\n        常驻监听命名管道，逐条打印收到的 JSON Lines 消息（供配置程序/agent 读取）。\n  synapse-agent bus-send (--text <文字> | --file <UTF-8文件> | --stdin) [--dir in|out] [--topic <t>] [--sender <s>] [--name <管道名>]\n        向本机消息总线投递一条消息。发长文本同样推荐 --file / --stdin。\n  synapse-agent bridge --title <子串> [--name <管道名>] [--poll 3] [--hub 1|0]\n        一站式桥接：窗口↔总线↔Hub（需已 init）。--hub 1 时窗口新消息会 publish 到 Hub。", env!("CARGO_PKG_VERSION"));
        return;
    }
    if argv.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let cfg = Cfg::from_args();
    if matches!(cfg.cmd.as_str(), "run" | "ws") {
        if cfg.window_forward && cfg.tmux_forward {
            eprintln!("window_forward 与 tmux_forward 不能同时开启；Linux/macOS 用 --tmux <target>，Windows 用 --window 1");
            std::process::exit(2);
        }
        if cfg.tmux_forward && cfg.tmux_target.trim().is_empty() {
            eprintln!("tmux_forward 已开启但未配置 tmux_target：请用 --tmux <target> 或先运行 tmux-config --target <session:window.pane>");
            std::process::exit(2);
        }
    }
    if cfg.endpoint.starts_with("http://")
        && !cfg.endpoint.contains("127.0.0.1") && !cfg.endpoint.contains("localhost") {
        eprintln!("refuse plaintext http; use https");
        std::process::exit(2);
    }
    fs::create_dir_all(&cfg.dir).ok();
    init_proxy(&cfg.endpoint);
    let mut agent_builder = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(40))
        .user_agent(concat!("synapse-agent/", env!("CARGO_PKG_VERSION"), " (rust)"));
    if let Some(p) = proxy_for(&host_of(&cfg.endpoint)) {
        match ureq::Proxy::new(&p.url) {
            Ok(up) => agent_builder = agent_builder.proxy(up),
            Err(e) => eprintln!("[proxy] ureq 代理配置失败（HTTP 改直连）：{e}"),
        }
    }
    let agent: Agent = agent_builder.build();
    let base = cfg.endpoint.trim_end_matches('/').to_string();
    // 顺序感知解析：--key value 成对；单独的 --flag（下一个是 --key 或到末尾）记为无值开关。
    // 这样 --flag 出现在任意位置都不会把下一个开关误当成它的值。
    let toks: Vec<String> = std::env::args().skip(2).collect();
    let mut args_map: HashMap<String, String> = HashMap::new();
    let mut flags: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut i = 0;
        while i < toks.len() {
            let t = &toks[i];
            if t.starts_with("--") {
                let key = t.trim_start_matches("--").to_string();
                if i + 1 < toks.len() && !toks[i + 1].starts_with("--") {
                    args_map.insert(key, toks[i + 1].clone());
                    i += 2;
                } else {
                    flags.insert(key);
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
    }

    // 单实例：同一 state dir 只允许一个 run/ws 常驻，避免两个进程抢游标、
    // 重复消费、服务端堆出多条死连接（flock 随进程退出自动释放）。
    // YANSHI_HB_ONLY 修复：wait 是一次性检查命令，不该和常驻 run 抢同一把锁。
    // 否则 run 常驻持锁时，任何 wait 都会 exit(3) 报"已有进程持锁"，导致对话回合永远检查不到消息。
    let _run_lock = if matches!(cfg.cmd.as_str(), "run" | "ws") {
        match acquire_run_lock(&cfg.dir) {
            Some(f) => Some(f),
            None => {
                eprintln!("✗ 已有另一个 synapse-agent 常驻/等待进程持有 {}/run.lock；本进程退出",
                          cfg.dir.display());
                std::process::exit(3);
            }
        }
    } else {
        None
    };

    // 两态机器（与 Python Loop / TS Loop 等价）：
    //   busy: 正常运行（本进程在干活），心跳照常
    //   idle: `wait` 阻塞等一条指令；`peek` 非阻塞看一眼
    match cfg.cmd.as_str() {
        "init" => {
            if cfg.token.is_empty() { eprintln!("init 需要 --token"); std::process::exit(2); }
            let prof = crate::profile::detect();
            let hb = args_map.get("heartbeat").and_then(|s| s.parse::<u64>().ok())
                .or_else(|| prof["heartbeat_s"].as_u64()).unwrap_or(cfg.heartbeat_s);
            let body = json!({
                "endpoint": cfg.endpoint, "project": cfg.project, "agent_id": cfg.agent_id,
                "token": cfg.token, "heartbeat_s": hb,
                "runtime": prof["runtime"], "host": prof["host"], "transport": prof["transport"],
            });
            let path = cfg.dir.join("config.json");
            let tmp = cfg.dir.join("config.json.tmp");
            if let Err(e) = fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap_or_default()) {
                eprintln!("写配置失败：{e}"); std::process::exit(1);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
            }
            if let Err(e) = fs::rename(&tmp, &path) {
                eprintln!("落盘配置失败：{e}"); std::process::exit(1);
            }
            println!("✓ 已初始化 project={} agent={}", cfg.project, cfg.agent_id);
            println!("  运行环境：{}/{}，默认传输 {}，心跳 {}s", prof["runtime"].as_str().unwrap_or("generic"),
                     prof["host"].as_str().unwrap_or("local"), prof["transport"].as_str().unwrap_or("ws"), hb);
            println!("  配置：{}（600）", path.display());
            return;
        }
        "status" => {
            let since = cursor_get(&cfg.dir);
            let st: Value = fs::read_to_string(cfg.dir.join("run.state.json")).ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}));
            let pid = st["pid"].as_u64();
            let alive = pid.map(pid_alive);
            println!("{}", json!({
                "endpoint": cfg.endpoint, "project": cfg.project, "agent_id": cfg.agent_id,
                "cursor": since,
                "unacked": journal_load(&cfg.dir).len(),
                "connected": st["connected"].clone(),
                "transport": st["transport"].clone(),
                "last_hb_ok": st["last_hb_ok"].clone(),
                "last_hb_ms": st["last_hb_ms"].clone(),
                "last_msg_ms": st["last_msg_ms"].clone(),
                "queue": st["queue"].clone(),
                "pid": pid,
                "alive": alive,
                "stale": alive.map(|a| !a),
                "window_forward": cfg.window_forward, "window_app": cfg.window_app,
                "window_conversation": cfg.window_conversation,
                "tmux_forward": cfg.tmux_forward, "tmux_target": cfg.tmux_target,
                "config": cfg.dir.join("config.json").display().to_string(),
            }));
            return;
        }
        // 长连接优先：连不上（环境不支持/代理拦/握手失败）再退回轮询；
        // 轮询只是临时降级，过一段时间必须再试 WS，不能一次失败就永久留在 poll。
        "run" | "ws" => {
            // YANSHI_HB_ONLY=1：纯心跳守护进程。只维持在线，绝不消费 inbox/推游标/ack。
            // 用于 WorkBuddy/CodeBuddy 等回合制 agent：消息必须留给对话回合里的 `wait`。
            // 否则后台 run 会先一步 fetch_inbox + ack + 推游标，把消息吞掉，
            // 对话回合的 wait 从新游标往后拉就是空的 → "后台收到了但对话收不到"。
            let hb_only = std::env::var("SYNAPSE_HB_ONLY").or_else(|_| std::env::var("YANSHI_HB_ONLY"))
                .map(|v| v == "1").unwrap_or(false);
            let force_poll = std::env::var("SYNAPSE_NO_WS").or_else(|_| std::env::var("YANSHI_NO_WS"))
                .map(|v| v == "1").unwrap_or(false) || hb_only;
            if hb_only { eprintln!("SYNAPSE_HB_ONLY=1：纯心跳模式，不消费 inbox（消息留给对话回合的 wait）"); }
            if force_poll {
                if cfg.cmd == "ws" { eprintln!("SYNAPSE_NO_WS=1 与 ws 冲突"); std::process::exit(2); }
                eprintln!("SYNAPSE_NO_WS=1：强制轮询");
                run_poll(&cfg, &agent, &base, None);
                return;
            }
            if cfg.cmd == "ws" {
                if run_ws(&cfg, &agent, &base) { return; }
                eprintln!("长连接建立失败；把子命令换成 run 可自动回退轮询并定时重试 WS");
                std::process::exit(2);
            }
            loop {
                if run_ws(&cfg, &agent, &base) { return; }
                eprintln!("[run] 长连接不可用，回退轮询 {}s 后重试 WS", WS_RETRY_AFTER_POLL);
                run_poll(&cfg, &agent, &base, Some(Duration::from_secs(WS_RETRY_AFTER_POLL)));
                eprintln!("[run] 轮询窗口结束，重试 WS");
            }
        }
        "wait" => {
            let timeout: u64 = std::env::var("SYNAPSE_WAIT").or_else(|_| std::env::var("YANSHI_WAIT"))
                .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            let started = SystemTime::now();
            loop {
                if let Some(m) = poll_once(&cfg, &agent, &base, true) {
                    println!("{}", serde_json::to_string(&m).unwrap_or_default());
                    if let Some(seq) = seq_of(&m) {
                        // 先回执成功再推游标：ack 失败就留在原地，下次 wait 还能再取到。
                        if ack_message(&cfg, &agent, &base, seq, "done",
                                       &json!({"note": "wait 已收到"}), ack_required(&m)) {
                            cursor_set(&cfg.dir, seq);
                        }
                    }
                    return;
                }
                if timeout > 0
                    && started.elapsed().unwrap_or_default().as_secs() >= timeout {
                    std::process::exit(3);           // 超时：调用方据此重新调度
                }
                thread::sleep(Duration::from_secs(2));
            }
        }
        // ── 管理面（token 需 role=admin） ───────────────────
        "upgrade" => {
            // 之前误读成 --check，导致 --apply 1 永远走 check-only（H2 的另一半）
            let apply = args_map.get("apply").map(|v| v == "1").unwrap_or(false);
            let check_only = !apply;
            let platform_override = args_map.get("platform").cloned().unwrap_or_default();
            let tags = upgrade_platform_tags(&platform_override);
            if tags.is_empty() {
                eprintln!("当前平台不支持客户端自升级（{} / {}）；请用安装脚本重装。",
                          std::env::consts::OS, std::env::consts::ARCH);
                std::process::exit(7);
            }
            let m = admin_get_public(&agent, &base, "/sdk/manifest");
            match m {
                Ok(man) => {
                    let latest = man["version"].as_str().unwrap_or("").to_string();
                    let mine = env!("CARGO_PKG_VERSION").to_string();
                    let upd = latest != mine;
                    if !upd {
                        println!("{}", json!({"current": mine, "latest": latest, "update": false,
                                              "platforms": tags}));
                        return;
                    }
                    // 旧实现直接取 binaries[0]，Windows/macOS/arm64 会拿到 Linux x64 包。
                    // 这里按当前 OS/ARCH（以及 Linux libc）选，找不到就不升级。
                    let chosen = find_manifest_binary(&man, &tags);
                    let chosen = match chosen {
                        Some(b) => b,
                        None => {
                            let avail: Vec<&str> = man["binaries"].as_array().map(|bs| {
                                bs.iter().filter_map(|b| b["platform"].as_str()).collect()
                            }).unwrap_or_default();
                            eprintln!("manifest 没有当前平台的 binary（需要 {}；可用：{}）；拒绝升级",
                                      tags.join(" / "), avail.join(", "));
                            std::process::exit(2);
                        }
                    };
                    let platform = chosen["platform"].as_str().unwrap_or("").to_string();
                    let url = chosen["url"].as_str().unwrap_or("").to_string();
                    // 只允许从本站 /dl/ 下载，避免 manifest 被篡改后变成任意 URL
                    if !url.starts_with("/dl/") {
                        eprintln!("manifest 的下载地址不是本站 /dl/：{url}；拒绝升级");
                        std::process::exit(2);
                    }
                    let sha = chosen["sha256"].as_str().unwrap_or("").to_string();
                    // H2 fail-closed：sha 缺失/长度不对/非 hex 一律不替换
                    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                        eprintln!("manifest 缺少有效 sha256（长度须 64 且为 hex）；拒绝升级");
                        std::process::exit(3);
                    }
                    if check_only {
                        println!("{}", json!({"current": mine, "latest": latest, "update": true,
                                              "platform": platform, "url": url, "sha256": sha,
                                              "hint": "加 --apply 1 才会真正替换二进制"}));
                        return;
                    }
                    let current = match std::env::current_exe() {
                        Ok(p) => p,
                        Err(e) => { eprintln!("取当前可执行文件路径失败：{e}"); std::process::exit(1); }
                    };
                    let tmp = format!("{}.new", current.display());
                    match admin_bytes_public(&agent, &base, &url) {
                        Ok(b) => {
                            if let Err(e) = fs::write(&tmp, &b) { eprintln!("写临时文件失败：{e}"); std::process::exit(1); }
                            // 不再依赖外部 sha256sum（Windows 默认没有）；直接用已依赖的 sha2。
                            let got = match sha256_file(&tmp) {
                                Ok((h, _)) => h,
                                Err(e) => {
                                    eprintln!("读临时文件失败：{e}");
                                    let _ = fs::remove_file(&tmp);
                                    std::process::exit(4);
                                }
                            };
                            if got.to_lowercase() != sha.to_lowercase() {
                                eprintln!("sha256 不匹配：期望 {sha}，实际 {got}；已放弃替换");
                                let _ = fs::remove_file(&tmp);
                                std::process::exit(4);
                            }
                            // Unix/macOS：同机 rename 覆盖正在运行的可执行文件是安全的（inode 保留）。
                            // Windows：运行中的 exe 被锁，保留 .new 让用户停进程后手动替换。
                            #[cfg(windows)]
                            {
                                eprintln!("Windows 不能覆盖运行中的 exe；新版本已下载到：{tmp}");
                                eprintln!("请先停止所有 synapse-agent 进程，再用 install.ps1 覆盖安装，或手动替换该文件。");
                                std::process::exit(6);
                            }
                            #[cfg(not(windows))]
                            {
                                // 先补权限位再 rename：临时文件默认 0644，直接覆盖会让
                                // 新二进制丢可执行位（ISS-MWSNUQQP-58ECCC）。
                                if let Err(e) = apply_upgrade_mode(&tmp, &current) {
                                    eprintln!("设置新二进制权限失败：{e}；已放弃替换（旧版本未动）");
                                    let _ = fs::remove_file(&tmp);
                                    std::process::exit(5);
                                }
                                match fs::rename(&tmp, &current) {
                                    Ok(_) => println!("{}", json!({"ok": true, "from": mine, "to": latest,
                                                                  "platform": platform, "bytes": b.len()})),
                                    Err(e) => { eprintln!("替换失败：{e}（可能需要写权限，或系统限制）"); std::process::exit(5); }
                                }
                            }
                        }
                        Err(e) => { eprintln!("下载失败：{e}"); std::process::exit(1); }
                    }
                }
                Err(e) => { eprintln!("取 manifest 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "profile" => {
            let p = crate::profile::detect();
            println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default());
            return;
        }
        "agents" => {
            match admin_get(&cfg, &agent, &base, &format!("/x/admin/p/{}/agents", cfg.project)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("agents 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "subs" => {
            let state = args_map.get("state").cloned().unwrap_or_default();
            let q = if state.is_empty() { String::from("") } else { format!("?state={state}") };
            // 交付只读走数据面：/x/admin 只认 admin token，普通 agent 永远 403
            // （ISS-MWSZPB49-B96120）；服务端已对项目 agent 开放 GET /p/<proj>/submissions。
            match admin_get(&cfg, &agent, &base, &format!("/p/{}/submissions{}", cfg.project, q)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("subs 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "issue" => {
            let title = args_map.get("title").cloned().unwrap_or_default().trim().to_string();
            if title.is_empty() { eprintln!("issue 需要 --title <标题>"); std::process::exit(2); }
            let body = if let Some(path) = args_map.get("body-file") {
                match read_text_file(path) { Ok(v) => v, Err(e) => { eprintln!("读 body-file 失败：{e}"); std::process::exit(2); } }
            } else {
                args_map.get("body").cloned().unwrap_or_default()
            };
            let priority = args_map.get("priority").cloned().unwrap_or_else(|| "normal".into());
            let labels = args_map.get("labels").cloned().unwrap_or_default();
            let self_assign = flags.contains("self");
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/issues", cfg.project),
                             json!({ "title": title, "body": body, "priority": priority, "labels": labels,
                                     "self_assign": self_assign })) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("issue 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "issue-take" => {
            let issue_id = args_map.get("issue").or_else(|| args_map.get("issue-id")).cloned()
                .unwrap_or_default().trim().to_string();
            if issue_id.is_empty() { eprintln!("issue-take 需要 --issue <id>"); std::process::exit(2); }
            match admin_post(&cfg, &agent, &base,
                             &format!("/p/{}/issues/{}/take", cfg.project, urlencode(&issue_id)), json!({})) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("issue-take 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "issues" => {
            let status = args_map.get("status").cloned().unwrap_or_default();
            let limit = args_map.get("limit").and_then(|s| s.parse::<u64>().ok()).unwrap_or(100);
            let q = format!("?status={}&limit={}", urlencode(&status), limit);
            match admin_get(&cfg, &agent, &base, &format!("/x/admin/p/{}/issues{}", cfg.project, q)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("issues 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "send" | "broadcast" => {
            let title = args_map.get("title").cloned().unwrap_or_default();
            let body = args_map.get("body").cloned().unwrap_or_default();
            let ack = args_map.get("ack").map(|v| v == "1" || v == "true").unwrap_or(true);
            let path = if cfg.cmd == "send" {
                let to = args_map.get("to").cloned().unwrap_or_default();
                if to.is_empty() { eprintln!("send 需要 --to a,b"); std::process::exit(2); }
                format!("/x/admin/p/{}/send", cfg.project)
            } else {
                format!("/x/admin/p/{}/broadcast", cfg.project)
            };
            let mut req = json!({"title": if title.is_empty() { "(无标题)".to_string() } else { title },
                                 "body": body, "kind": "task",
                                 "action_required": {"kind": "task", "ack_required": ack}});
            if cfg.cmd == "send" {
                let to = args_map.get("to").cloned().unwrap_or_default();
                req["to"] = json!(to.split(',').filter(|x| !x.trim().is_empty()).map(|x| x.trim().to_string()).collect::<Vec<_>>());
            } else {
                req["broadcast_id"] = json!(format!("bc-{}", now_ms()));
            }
            match admin_post(&cfg, &agent, &base, &path, req) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("{} 失败：{e}", cfg.cmd); std::process::exit(1); }
            }
            return;
        }
        "get" => {
            let sid = args_map.get("sid").cloned().or_else(|| std::env::args().nth(2)).unwrap_or_default();
            let out = args_map.get("out").cloned().unwrap_or_else(|| format!("{}.zip", sid));
            // bundle 下载同样走数据面只读路径，普通 agent token 可用（ISS-MWSZPB49-B96120）。
            match admin_bytes(&cfg, &agent, &base, &format!("/p/{}/submissions/{}/bundle", cfg.project, sid)) {
                Ok(b) => {
                    if let Err(e) = fs::write(&out, &b) { eprintln!("写文件失败：{e}"); std::process::exit(1); }
                    println!("{}", json!({"ok": true, "file": out, "bytes": b.len()}));
                }
                Err(e) => { eprintln!("get 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "peek" => {
            let n = poll_once(&cfg, &agent, &base, false).map(|_| 1).unwrap_or(0);
            println!("{{\"new\":{}}}", n);
            return;
        }

        // ── 交付：artifact 直传 + submission 建单（对齐 Python/TS，并补 Rust 缺口）──
        "upload" => {
            let file = args_map.get("file").cloned().unwrap_or_default();
            if file.is_empty() { eprintln!("upload 需要 --file <path>"); std::process::exit(2); }
            match artifact_upload(&cfg, &agent, &base, &file) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("upload 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "task-claim" => {
            let id = args_map.get("task").or_else(|| args_map.get("task-id")).cloned().unwrap_or_default();
            if id.trim().is_empty() { eprintln!("task-claim 需要 --task <id>"); std::process::exit(2); }
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/claim", cfg.project),
                             json!({ "task_id": id })) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("task-claim 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "task-release" => {
            let id = args_map.get("task").or_else(|| args_map.get("task-id")).cloned().unwrap_or_default();
            if id.trim().is_empty() { eprintln!("task-release 需要 --task <id>"); std::process::exit(2); }
            let state = args_map.get("state").cloned().unwrap_or_else(|| "done".into());
            if !["done", "open", "blocked"].contains(&state.as_str()) {
                eprintln!("task-release --state 只能是 done|open|blocked"); std::process::exit(2);
            }
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/release", cfg.project),
                             json!({ "task_id": id, "state": state })) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("task-release 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "submit" => {
            let kind = args_map.get("kind").cloned().unwrap_or_else(|| "patch".into());
            let title = args_map.get("title").cloned().unwrap_or_default();
            let base_sha = args_map.get("base-sha").cloned();
            let notes = args_map.get("notes").cloned().unwrap_or_default();
            let sid = args_map.get("sid").cloned();
            let task = args_map.get("task").or_else(|| args_map.get("task-id")).cloned();
            let checks: Value = args_map.get("checks")
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| json!({}));
            // 支持多个 --ref：--ref <sha256> 或 --ref <sha256>:<name>
            let refs: Vec<Value> = toks.windows(2)
                .filter(|w| w[0] == "--ref")
                .map(|w| {
                    let parts: Vec<&str> = w[1].splitn(2, ':').collect();
                    json!({"sha256": parts[0], "name": parts.get(1).copied().unwrap_or("artifact")})
                }).collect();
            match artifact_submit(&cfg, &agent, &base, &kind, &title, refs,
                                  base_sha.as_deref(), checks, &notes, sid.as_deref(), task.as_deref()) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("submit 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "deliver" => {
            // 一条龙：上传 → 建交付，专为回合制 agent 一次工具调用完成交付。
            // S3：支持重复 --file，代码类可一次带补丁 + 回执；旧的单 --file 仍兼容。
            let mut files: Vec<String> = toks.windows(2)
                .filter(|w| w[0] == "--file")
                .map(|w| w[1].clone())
                .filter(|s| !s.trim().is_empty())
                .collect();
            if files.is_empty() {
                let file = args_map.get("file").cloned().unwrap_or_default();
                if !file.is_empty() { files.push(file); }
            }
            if files.is_empty() { eprintln!("deliver 需要 --file <path>（可重复传多个）"); std::process::exit(2); }
            let kind = args_map.get("kind").cloned().unwrap_or_else(|| "patch".into());
            let title = args_map.get("title").cloned().unwrap_or_default();
            let base_sha = args_map.get("base-sha").cloned();
            let notes = args_map.get("notes").cloned().unwrap_or_default();
            let sid = args_map.get("sid").cloned();
            let task = args_map.get("task").or_else(|| args_map.get("task-id")).cloned();
            let checks: Value = args_map.get("checks")
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| json!({}));
            let mut refs = Vec::new();
            let mut uploaded = Vec::new();
            for file in files {
                let up = match artifact_upload(&cfg, &agent, &base, &file) {
                    Ok(v) => v,
                    Err(e) => { eprintln!("deliver/upload 失败（{file}）：{e}"); std::process::exit(1); }
                };
                refs.push(up["ref"].clone());
                uploaded.push(json!({
                    "file": file, "sha256": up["sha256"], "bytes": up["bytes"],
                    "name": up["ref"]["name"].clone()
                }));
            }
            let sub = match artifact_submit(&cfg, &agent, &base, &kind, &title, refs,
                                            base_sha.as_deref(), checks, &notes, sid.as_deref(), task.as_deref()) {
                Ok(v) => v,
                Err(e) => { eprintln!("deliver/submit 失败（文件已上传）：{e}"); std::process::exit(1); }
            };
            let first = uploaded.get(0).cloned().unwrap_or_else(|| json!({}));
            println!("{}", serde_json::to_string(&json!({
                "ok": true, "files": uploaded,
                "sha256": first["sha256"].clone(), "bytes": first["bytes"].clone(),
                "submission_id": sub["submission_id"], "task_id": sub["task_id"],
                "state": sub["state"], "seq": sub["seq"]
            })).unwrap_or_default());
            return;
        }

        // ── Linux/macOS tmux 投递（TUI） ───────────────────────
        "tmux-config" | "tui-config" => {
            let cfg_path = cfg.dir.join("config.json");
            let mut saved: Value = fs::read_to_string(&cfg_path)
                .ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
            let target = args_map.get("target").cloned()
                .or_else(|| args_map.get("tmux").cloned());
            let enable = args_map.get("enable").map(|v| cfg_truthy(v));
            let verify = args_map.get("verify").map(|v| cfg_truthy(v));
            if let Some(v) = verify {
                saved["tmux_verify"] = json!(v);
                if let Err(e) = write_private_json(&cfg_path, &saved) {
                    eprintln!("{e}"); std::process::exit(1);
                }
                println!("{}", json!({
                    "ok": true, "op": "tmux-config-verify", "tmux_verify": v,
                    "note": "alternate-screen TUI（CodeBuddy/Claude）用 0：注入即 ACK，避免标记读不到导致重投风暴",
                    "config": cfg_path.to_string_lossy()
                }));
                return;
            }
            if let Some(t) = target {
                if t.trim().is_empty() {
                    eprintln!("tmux-config 的 target 不能为空"); std::process::exit(2);
                }
                saved["tmux_target"] = json!(t);
                saved["tmux_forward"] = json!(enable.unwrap_or(true));
                if let Err(e) = write_private_json(&cfg_path, &saved) {
                    eprintln!("{e}"); std::process::exit(1);
                }
                println!("{}", json!({
                    "ok": true, "op": "tmux-config-set", "tmux_target": t,
                    "tmux_forward": saved["tmux_forward"], "config": cfg_path.to_string_lossy()
                }));
            } else if flags.contains("clear") {
                if let Some(o) = saved.as_object_mut() {
                    o.remove("tmux_target");
                    o.remove("tmux_forward");
                    o.remove("tmux_verify");
                }
                if let Err(e) = write_private_json(&cfg_path, &saved) {
                    eprintln!("{e}"); std::process::exit(1);
                }
                println!("{}", json!({"ok": true, "op": "tmux-config-clear"}));
            } else if let Some(en) = enable {
                saved["tmux_forward"] = json!(en);
                if let Err(e) = write_private_json(&cfg_path, &saved) {
                    eprintln!("{e}"); std::process::exit(1);
                }
                println!("{}", json!({
                    "ok": true, "op": "tmux-config-enable", "tmux_forward": en,
                    "tmux_target": saved["tmux_target"].clone(), "config": cfg_path.to_string_lossy()
                }));
            } else {
                println!("{}", json!({
                    "op": "tmux-config-show",
                    "tmux_target": saved["tmux_target"].as_str().unwrap_or(""),
                    "tmux_forward": saved["tmux_forward"].as_bool().unwrap_or(false),
                    "tmux_verify": saved["tmux_verify"].as_bool().unwrap_or(true),
                    "from_env_target": std::env::var("SYNAPSE_TMUX_TARGET").unwrap_or_default(),
                    "from_env_forward": std::env::var("SYNAPSE_TMUX_FORWARD").unwrap_or_default(),
                    "config": cfg_path.to_string_lossy()
                }));
            }
            return;
        }
        "tmux-list" => {
            match tmux::list_panes() {
                Ok(panes) => {
                    let arr: Vec<Value> = panes.iter().map(|p| json!({
                        "target": p.target, "pane_id": p.pane_id,
                        "command": p.command, "path": p.path
                    })).collect();
                    println!("{}", serde_json::to_string_pretty(&json!({
                        "count": arr.len(), "panes": arr
                    })).unwrap_or_default());
                }
                Err(e) => { eprintln!("tmux-list 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "tmux-send" => {
            let target = args_map.get("target").cloned()
                .or_else(|| args_map.get("tmux").cloned())
                .unwrap_or_else(|| cfg.tmux_target.clone());
            let text = resolve_send_text(&args_map, &flags);
            if text.is_empty() {
                eprintln!("tmux-send 需要正文：--text <文字> 或 --file <文件> 或 --stdin；目标用 --target <session:window.pane> 或 tmux-config 设置");
                std::process::exit(2);
            }
            let enter = args_map.get("enter").map(|v| cfg_truthy(v)).unwrap_or(true);
            let verify = args_map.get("verify").map(|v| cfg_truthy(v)).unwrap_or(false);
            let pane = match tmux::resolve_pane(&target) {
                Ok(p) => p, Err(e) => { eprintln!("tmux-send 目标无效：{e}"); std::process::exit(1); }
            };
            let result = if verify {
                let marker = message_marker(&text)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| text.lines().next().unwrap_or("").chars().take(80).collect());
                tmux::deliver(&target, &text, &marker, enter)
            } else {
                tmux::send_text(&target, &text, enter).map(|_| true)
            };
            match result {
                Ok(verified) => {
                    println!("{}", serde_json::to_string_pretty(&json!({
                        "ok": verified, "target": target, "pane_id": pane.pane_id,
                        "command": pane.command, "verified": verified
                    })).unwrap_or_default());
                    if !verified { std::process::exit(1); }
                }
                Err(e) => { eprintln!("tmux-send 失败：{e}"); std::process::exit(1); }
            }
            return;
        }

        // ── 本地窗口桥（Windows） ───────────────────────────────
        "win-config" => {
            // 配置默认窗口目标与会话标题，写入 ~/.synapse-agent/config.json。
            // 用法：win-config --app 豆包
            //       win-config --conversation "◆dou-win-133"
            //       win-config --show
            //       win-config --clear
            let cfg_path = cfg.dir.join("config.json");
            let mut saved: Value = fs::read_to_string(&cfg_path)
                .ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
            let show = flags.contains("show");
            let clear = flags.contains("clear");
            let app_arg = args_map.get("app").cloned();
            let conversation_arg = args_map.get("conversation").cloned()
                .or_else(|| args_map.get("window-conversation").cloned());
            let mut changed = false;
            if let Some(app) = app_arg {
                saved["window_app"] = json!(app);
                changed = true;
            }
            if let Some(conversation) = conversation_arg {
                saved["window_conversation"] = json!(conversation);
                changed = true;
            }
            if changed {
                if fs::write(&cfg_path, serde_json::to_string_pretty(&saved).unwrap_or_default()).is_err() {
                    eprintln!("写入配置失败：{cfg_path:?}"); std::process::exit(1);
                }
                println!("{}", json!({
                    "ok": true, "op": "win-config-set",
                    "window_app": saved["window_app"].as_str().unwrap_or(""),
                    "window_conversation": saved["window_conversation"].as_str().unwrap_or(""),
                    "config": cfg_path.to_string_lossy()
                }));
            } else if clear {
                if let Some(o) = saved.as_object_mut() {
                    o.remove("window_app");
                    o.remove("window_conversation");
                }
                let _ = fs::write(&cfg_path, serde_json::to_string_pretty(&saved).unwrap_or_default());
                println!("{}", json!({"ok": true, "op": "win-config-clear"}));
            } else {
                println!("{}", json!({
                    "op": "win-config-show",
                    "window_app": saved["window_app"].as_str().unwrap_or(""),
                    "window_conversation": saved["window_conversation"].as_str().unwrap_or(""),
                    "config": cfg_path.to_string_lossy(),
                    "from_env": std::env::var("SYNAPSE_WINDOW_APP").unwrap_or_default(),
                    "from_env_app": std::env::var("SYNAPSE_WINDOW_APP").unwrap_or_default(),
                    "from_env_conversation": std::env::var("SYNAPSE_WINDOW_CONVERSATION").unwrap_or_default()
                }));
                let _ = show; // 无参数时默认也是 show
            }
            return;
        }
        "win-list" => {
            let pat = args_map.get("match").cloned().unwrap_or_default();
            // --app 豆包：按进程名发现窗口（无需手输标题）
            if let Some(app) = args_map.get("app") {
                match winmsg::find_app_window(app) {
                    Ok(w) => println!("{}", serde_json::to_string_pretty(&json!({
                        "count": 1, "windows": [{"hwnd": w.hwnd, "title": w.title, "visible": w.visible}]
                    })).unwrap_or_default()),
                    Err(e) => { eprintln!("win-list --app 失败：{e}"); std::process::exit(1); }
                }
                return;
            }
            match winmsg::list_windows(&pat) {
                Ok(ws) => {
                    let arr: Vec<Value> = ws.iter().map(|w| json!({
                        "hwnd": w.hwnd, "title": w.title, "visible": w.visible
                    })).collect();
                    println!("{}", serde_json::to_string_pretty(&json!({
                        "count": arr.len(), "windows": arr
                    })).unwrap_or_default());
                }
                Err(e) => { eprintln!("win-list 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "uia-dump" => {
            let app = args_map.get("app").cloned().unwrap_or_default();
            let title = args_map.get("title").cloned().unwrap_or_default();
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            println!("{}", serde_json::to_string_pretty(&json!({
                "hwnd": w.hwnd, "title": w.title,
                "elements": winmsg::dump_uia(w.hwnd)
            })).unwrap_or_default());
            return;
        }
        "uia-text" => {
            // 诊断：确认 UIA TextPattern 能否读到聊天正文，以及 composer 当前内容。
            let app = args_map.get("app").cloned().unwrap_or_default();
            let title = args_map.get("title").cloned().unwrap_or_default();
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            let doc = winmsg::document_text(w.hwnd).unwrap_or_default();
            let comp = winmsg::composer_text(w.hwnd).unwrap_or_default();
            let needle = args_map.get("needle").cloned().unwrap_or_default();
            println!("{}", serde_json::to_string_pretty(&json!({
                "hwnd": w.hwnd, "title": w.title,
                "document_len": doc.chars().count(),
                "composer_len": comp.chars().count(),
                "needle": needle,
                "needle_in_document": if needle.is_empty() { 0 } else { doc.matches(&needle).count() },
                "needle_in_composer": if needle.is_empty() { 0 } else { comp.matches(&needle).count() },
                "document_head": doc.chars().take(200).collect::<String>(),
                "document_tail": doc.chars().rev().take(200).collect::<String>().chars().rev().collect::<String>(),
            })).unwrap_or_default());
            return;
        }
        "win-send" => {
            let app = args_map.get("app").cloned().unwrap_or_default();
            let title = args_map.get("title").cloned().unwrap_or_default();
            // 正文来源优先级：--text <文字> > --file <UTF-8 文件> > --stdin（整段读）。
            // 发代码 / patch 用 --file 或 --stdin，绕开命令行长度与转义限制。
            let text = resolve_send_text(&args_map, &flags);
            if text.is_empty() {
                eprintln!("win-send 需要正文：--text <文字> 或 --file <文件> 或 --stdin（管道输入）；目标用 --app <应用名> 指定，或先 win-config --app 豆包 设默认");
                std::process::exit(2);
            }
            let enter = args_map.get("enter").map(|v| v == "1" || v == "true").unwrap_or(true);
            let method = args_map.get("method").cloned().unwrap_or_else(|| "click".into());
            let verify = args_map.get("verify").map(|v| v == "1" || v == "true").unwrap_or(false);
            let click_x = args_map.get("click-x").and_then(|s| s.parse().ok()).unwrap_or(0.53);
            let click_y = args_map.get("click-y").and_then(|s| s.parse().ok()).unwrap_or(0.83);
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            // 只有目标仍然是默认应用（或显式指定了同一个 app）时才套用配置的会话；
            // win-send --title 指向别的应用时，不应该拿豆包的会话标记去点对方窗口。
            let use_configured_conversation = (app.is_empty() && title.is_empty())
                || (!cfg.window_app.is_empty() && app == cfg.window_app);
            if use_configured_conversation && !cfg.window_conversation.trim().is_empty() {
                if let Err(e) = winmsg::ensure_conversation(w.hwnd, &cfg.window_conversation) {
                    eprintln!("win-send 目标会话切换失败：{}：{e}", cfg.window_conversation);
                    std::process::exit(1);
                }
            }
            let mut results = json!({});
            let mut any_ok = false;
            if verify {
                match winmsg::send_text_click_paste_checked(w.hwnd, &text, enter, click_x, click_y) {
                    Ok(v) => { results["checked"] = json!({"ok": true, "verified": v}); any_ok = true; }
                    Err(e) => results["checked"] = json!({"ok": false, "error": e}),
                }
            } else if method == "click" || method.is_empty() || method == "both" {
                match winmsg::send_text_click_paste(w.hwnd, &text, enter, click_x, click_y) {
                    Ok(_) => { results["click-paste"] = json!({"ok": true}); any_ok = true; }
                    Err(e) => results["click-paste"] = json!({"ok": false, "error": e}),
                }
            }
            if method == "paste" || method == "both" {
                match winmsg::send_text_paste(w.hwnd, &text, enter) {
                    Ok(_) => { results["paste"] = json!({"ok": true}); any_ok = true; }
                    Err(e) => results["paste"] = json!({"ok": false, "error": e}),
                }
            }
            if method == "copy" || method == "both" {
                match winmsg::send_text_copydata(w.hwnd, &text, 2000) {
                    Ok(r) => { results["copydata"] = json!({"ok": true, "result": r}); any_ok = true; }
                    Err(e) => results["copydata"] = json!({"ok": false, "error": e}),
                }
            }
            println!("{}", json!({
                "module": "winmsg", "op": "send", "title": w.title,
                "hwnd": w.hwnd, "method": method, "results": results,
                "window_conversation": cfg.window_conversation,
                "ok": any_ok
            }));
            if !any_ok {
                std::process::exit(1);
            }
            return;
        }
        "win-read" => {
            let app = args_map.get("app").cloned().unwrap_or_default();
            let title = args_map.get("title").cloned().unwrap_or_default();
            let diff = flags.contains("diff")
                || args_map.get("diff").map(|v| v == "1" || v == "true").unwrap_or(false);
            let restore = !(flags.contains("no-restore")
                || args_map.get("no-restore").map(|v| v == "1" || v == "true").unwrap_or(false));
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            let text = match winmsg::read_window_text(w.hwnd, restore) {
                Ok(t) => t, Err(e) => { eprintln!("win-read 失败：{e}"); std::process::exit(1); }
            };
            if diff {
                let state_path = cfg.dir.join(format!("window_{}.txt", w.hwnd));
                let old = fs::read_to_string(&state_path).unwrap_or_default();
                let fresh = winmsg::diff_new_lines(&old, &text, true);
                let _ = fs::write(&state_path, &text);
                println!("{}", json!({
                    "module": "winmsg", "op": "read-diff", "title": w.title,
                    "new_count": fresh.len(), "new_lines": fresh
                }));
            } else {
                println!("{}", json!({
                    "module": "winmsg", "op": "read", "title": w.title, "text": text
                }));
            }
            return;
        }

        // ── 本机消息总线 ────────────────────────────────────────
        "bus-serve" => {
            let name = args_map.get("name").cloned()
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.agent_id));
            if let Err(e) = localbus::serve(&name, |v| {
                // 收到一条消息就原样打印（供上游 agent / 配置程序读取），并回执 ok
                println!("{}", serde_json::to_string(&v).unwrap_or_default());
                Some(json!({"ok": true, "echo": v["id"].clone()}).to_string())
            }) {
                eprintln!("bus-serve 失败：{e}"); std::process::exit(1);
            }
            return;
        }
        "bus-send" => {
            let text = resolve_send_text(&args_map, &flags);
            if text.is_empty() { eprintln!("bus-send 需要正文：--text <文字> 或 --file <文件> 或 --stdin"); std::process::exit(2); }
            let dir = args_map.get("dir").cloned().unwrap_or_else(|| "out".into());
            let topic = args_map.get("topic").cloned().unwrap_or_else(|| "announce".into());
            let sender = args_map.get("sender").cloned().unwrap_or_else(|| cfg.agent_id.clone());
            let name = args_map.get("name").cloned()
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.agent_id));
            let msg = localbus::make_msg(&dir, &sender, &topic, &text, json!({}));
            match localbus::send_one(&name, &msg, true) {
                Ok(reply) => println!("{}", json!({
                    "module": "localbus", "op": "send", "endpoint": name,
                    "ok": true, "reply": reply
                })),
                Err(e) => { eprintln!("bus-send 失败：{e}"); std::process::exit(1); }
            }
            return;
        }

        // ── 一站式桥接：窗口 ↔ 总线 ↔ Hub ────────────────────────
        "bridge" => {
            let app = args_map.get("app").cloned().unwrap_or_default();
            let title = args_map.get("title").cloned().unwrap_or_default();
            let name = args_map.get("name").cloned()
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.agent_id));
            let poll_ms: u64 = args_map.get("poll").and_then(|s| s.parse().ok()).unwrap_or(3);
            let to_hub = args_map.get("hub").map(|v| v == "1" || v == "true").unwrap_or(true);
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            println!("{}", json!({
                "module": "bridge", "status": "starting", "title": w.title,
                "hwnd": w.hwnd, "endpoint": name, "to_hub": to_hub
            }));

            // 总线监听线程：配置程序写入的消息 → 打印 + 写入窗口；可选上报 Hub。
            // 如果目标窗口就是配置的默认应用，out 方向也必须先切到目标会话，
            // 否则 bridge 会把消息写进豆包重启后默认停留的“主对话”。
            let conv2 = if app.is_empty() || app == cfg.window_app {
                cfg.window_conversation.clone()
            } else {
                String::new()
            };
            {
                let (name2, w2, cfg2, agent2, base2, to_hub2) = (
                    name.clone(), w.hwnd, cfg.clone_lite(), agent.clone(), base.clone(), to_hub,
                );
                thread::spawn(move || {
                    let _ = localbus::serve(&name2, move |v| {
                        let text = v["text"].as_str().unwrap_or("").to_string();
                        let dir = v["dir"].as_str().unwrap_or("in").to_string();
                        println!("{}", json!({
                            "module": "bridge", "from": "bus", "dir": dir,
                            "sender": v["sender"], "text": text
                        }));
                        if dir == "out" {
                            if !conv2.trim().is_empty() {
                                if let Err(e) = winmsg::ensure_conversation(w2, &conv2) {
                                    eprintln!("[bridge] 目标会话切换失败，拒绝写入窗口：{e}");
                                    return Some(json!({"ok": false, "error": e}).to_string());
                                }
                            }
                            // agent → 窗口：点击输入框注入文字，不自动回车（避免误发）
                            if let Err(e) = winmsg::send_text_click_paste(w2, &text, false, 0.53, 0.83) {
                                eprintln!("[bridge] 写入窗口失败：{e}");
                            }
                        }
                        if to_hub2 && dir == "in" {
                            if let Err(e) = publish_to_hub(
                                &cfg2, &agent2, &base2,
                                v["topic"].as_str().unwrap_or("announce"), &text, json!({}),
                            ) {
                                eprintln!("[bridge] 上报 Hub 失败：{e}");
                            }
                        }
                        Some(json!({"ok": true}).to_string())
                    });
                });
            }

            // 主线程：轮询窗口新消息 → 打印 + 投递到总线（dir=in）
            let state_path = cfg.dir.join(format!("window_{}.txt", w.hwnd));
            let mut prev = fs::read_to_string(&state_path).unwrap_or_default();
            loop {
                thread::sleep(Duration::from_secs(poll_ms));
                match winmsg::read_window_text(w.hwnd, true) {
                    Ok(cur) => {
                        let fresh = winmsg::diff_new_lines(&prev, &cur, true);
                        if !fresh.is_empty() {
                            let _ = fs::write(&state_path, &cur);
                            for line in &fresh {
                                let msg = localbus::make_msg("in", &w.title, "announce", line, json!({}));
                                println!("{}", json!({
                                    "module": "bridge", "from": "window", "text": line
                                }));
                                let _ = localbus::send_one(&name, &msg, false);
                            }
                            if to_hub {
                                // 一个轮询窗口只上报一条，避免窗口逐行输出把管理台消息流刷成 29 条。
                                let batch = fresh.join("\n");
                                if let Err(e) = publish_to_hub(&cfg, &agent, &base, "announce", &batch,
                                                              json!({"lines": fresh.len()})) {
                                    eprintln!("[bridge] 上报 Hub 失败：{e}");
                                }
                            }
                        }
                        prev = cur;
                    }
                    Err(e) => eprintln!("[bridge] 读取窗口失败：{e}"),
                }
            }
        }

        _ => {}
    }

    // ── 兜底：未知子命令仍按旧行为进入轮询常驻 ─────────────────
    run_poll(&cfg, &agent, &base, None);
}

/// 取一条新消息（游标推进）；没有就返回 None
fn admin_get_public(agent: &Agent, base: &str, path: &str) -> Result<Value, String> {
    agent.get(&format!("{}{}", base, path)).call()
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.into_json::<Value>().map_err(|e| format!("{e}")))
}

fn admin_bytes_public(agent: &Agent, base: &str, path: &str) -> Result<Vec<u8>, String> {
    let r = agent.get(&format!("{}{}", base, path)).call().map_err(|e| format!("{e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    r.into_reader().read_to_end(&mut buf).map_err(|e| format!("{e}"))?;
    Ok(buf)
}

fn admin_get(cfg: &Cfg, agent: &Agent, base: &str, path: &str) -> Result<Value, String> {
    let url = format!("{}{}", base, path);
    agent.get(&url)
        .set("authorization", &format!("Bearer {}", cfg.token))
        .call()
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.into_json::<Value>().map_err(|e| format!("{e}")))
        .map_err(|e| if cfg.token.is_empty() { "缺少 --token".to_string() } else { e })
}

fn admin_post(cfg: &Cfg, agent: &Agent, base: &str, path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}{}", base, path);
    agent.post(&url)
        .set("authorization", &format!("Bearer {}", cfg.token))
        .set("content-type", "application/json")
        .send_json(body)
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.into_json::<Value>().map_err(|e| format!("{e}")))
}

/// 当前平台在 /sdk/manifest 里的 platform 候选。
/// Linux 优先匹配同 libc 的包；gnu 包缺失时退回静态 musl（musl 包可在 glibc 上运行）。
fn upgrade_platform_tags(override_tag: &str) -> Vec<String> {
    if !override_tag.is_empty() {
        return vec![override_tag.to_string()];
    }
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let pair: (&str, &str) = match (os, arch) {
        ("linux", "x86_64") => {
            if cfg!(target_env = "gnu") { ("linux-x86_64-gnu", "linux-x86_64") }
            else { ("linux-x86_64", "linux-x86_64-gnu") }
        }
        ("linux", "aarch64") => {
            if cfg!(target_env = "gnu") { ("linux-aarch64-gnu", "linux-aarch64") }
            else { ("linux-aarch64", "linux-aarch64-gnu") }
        }
        ("macos", "x86_64") => ("darwin-x86_64", ""),
        ("macos", "aarch64") => ("darwin-aarch64", ""),
        ("windows", "x86_64") => ("windows-x86_64", ""),
        _ => ("", ""),
    };
    let mut v = Vec::new();
    if !pair.0.is_empty() { v.push(pair.0.to_string()); }
    if !pair.1.is_empty() { v.push(pair.1.to_string()); }
    v
}

/// 按 platform 候选从 manifest 里选 binary；绝不回退到 binaries[0]。
fn find_manifest_binary<'a>(man: &'a Value, tags: &[String]) -> Option<&'a Value> {
    man["binaries"].as_array()?.iter().find(|b| {
        let p = b["platform"].as_str().unwrap_or("");
        tags.iter().any(|t| t == p)
    })
}

/// 计算文件的 SHA256（hex），与 Python 的 hashlib.sha256(...).hexdigest() 对齐。
fn sha256_file(path: &str) -> Result<(String, Vec<u8>), String> {
    let data = fs::read(path).map_err(|e| format!("读取文件失败 {path}: {e}"))?;
    let mut h = Sha256::new();
    h.update(&data);
    let digest = h.finalize();
    let sha = digest.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    Ok((sha, data))
}

/// 把 ureq 的响应统一转成 (status, body_text, json)，便于对 4xx 给出可读错误。
fn resp_parts(r: ureq::Response) -> (u16, String, Option<Value>) {
    let status = r.status();
    let mut buf = Vec::new();
    let _ = r.into_reader().read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    let json = serde_json::from_slice::<Value>(&buf).ok();
    (status, text, json)
}

/// 交付第一步：二进制直传 R2（PUT /p/{project}/artifact/{sha256}）。
/// 内容寻址：路径里的 sha 必须与文件字节一致，否则服务端回 422 hash_mismatch。
fn artifact_upload(cfg: &Cfg, agent: &Agent, base: &str, path: &str) -> Result<Value, String> {
    if cfg.token.is_empty() { return Err("缺少 --token（upload 需要 artifact.write scope）".into()); }
    let (sha, data) = sha256_file(path)?;
    let name = std::path::Path::new(path).file_name()
        .map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "artifact".into());
    let url = format!("{}/p/{}/artifact/{}", base, cfg.project, sha);
    let resp = agent.put(&url)
        .set("authorization", &format!("Bearer {}", cfg.token))
        .set("content-type", "application/octet-stream")
        .send_bytes(&data);
    match resp {
        Ok(r) => {
            let (status, text, j) = resp_parts(r);
            if status >= 400 { return Err(format!("upload HTTP {status}: {}", text.chars().take(200).collect::<String>())); }
            Ok(json!({
                "sha256": sha, "name": name, "bytes": data.len(),
                "ref": {"sha256": sha, "name": name},
                "stored": j.and_then(|v| v["stored"].as_bool()).unwrap_or(true)
            }))
        }
        Err(ureq::Error::Status(code, r)) => {
            let (_, text, _) = resp_parts(r);
            Err(format!("upload HTTP {code}: {}", text.chars().take(200).collect::<String>()))
        }
        Err(e) => Err(format!("upload 失败: {e}")),
    }
}

/// 由 refs 列表生成 submission_id：sub-{agent}-{ms hex}，符合 ^[a-zA-Z0-9._:-]{1,128}$。
fn new_submission_id(agent_id: &str) -> String {
    let clean: String = agent_id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':' { c } else { '-' })
        .collect();
    format!("sub-{}-{:x}", clean, now_ms())
}

/// 交付第二步：建交付（POST /p/{project}/submissions）。
/// refs 形态与 Python 一致：[{"sha256": "...", "name": "..."}]。
fn artifact_submit(
    cfg: &Cfg, agent: &Agent, base: &str,
    kind: &str, title: &str, refs: Vec<Value>,
    base_sha: Option<&str>, checks: Value, notes: &str, sid: Option<&str>, task_id: Option<&str>,
) -> Result<Value, String> {
    if cfg.token.is_empty() { return Err("缺少 --token（submit 需要 submissions.create scope）".into()); }
    let sha = match base_sha {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => git_head().unwrap_or_default(),
    };
    if !sha.test_hex() {
        return Err(format!("base_sha 缺失或非法（需 7-64 位 hex，实际: {:?}）；用 --base-sha 指定或确保处于 git 仓库", sha));
    }
    if refs.is_empty() { return Err("refs 为空：先 upload 拿到 ref，再用 --ref 传入".into()); }
    let mut body = json!({
        "submission_id": sid.map(|s| s.to_string()).unwrap_or_else(|| new_submission_id(&cfg.agent_id)),
        "agent_id": cfg.agent_id,
        "kind": if kind.is_empty() { "patch" } else { kind },
        "title": title,
        "refs": refs,
        "base_sha": sha,
        "checks": checks,
        "notes": notes,
    });
    if let Some(t) = task_id.filter(|s| !s.trim().is_empty()) {
        body["task_id"] = json!(t.trim());
    }
    let url = format!("{}/p/{}/submissions", base, cfg.project);
    match agent.post(&url)
        .set("authorization", &format!("Bearer {}", cfg.token))
        .set("content-type", "application/json")
        .send_json(body.clone())
    {
        Ok(r) => {
            let (status, text, j) = resp_parts(r);
            if status >= 400 { return Err(format!("submit HTTP {status}: {}", text.chars().take(200).collect::<String>())); }
            Ok(j.unwrap_or(body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let (_, text, _) = resp_parts(r);
            Err(format!("submit HTTP {code}: {}", text.chars().take(200).collect::<String>()))
        }
        Err(e) => Err(format!("submit 失败: {e}")),
    }
}

/// 极简正则替代：判断是否为 7-64 位小写 hex（避免引入 regex 依赖）。
trait HexCheck { fn test_hex(&self) -> bool; }
impl HexCheck for str {
    fn test_hex(&self) -> bool {
        let n = self.len();
        n >= 7 && n <= 64 && self.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

/// 普通 agent token 发布消息到 Hub（与 Python/TS 的 publish 对齐）。
fn publish_to_hub(cfg: &Cfg, agent: &Agent, base: &str, topic: &str, text: &str, meta: Value) -> Result<Value, String> {
    let body = json!({
        "topic": topic,
        "kind": "text",
        // 窗口逐行输出是给管理端看的，不是项目广播；否则每个 agent 的 inbox 都会被刷屏。
        "to": "admin",
        "dedupe_key": format!("winbridge-{}-{}", cfg.agent_id, now_ms()),
        "payload": {"text": text, "source": "win_bridge", "meta": meta},
    });
    agent.post(&format!("{}/p/{}/publish", base, cfg.project))
        .set("authorization", &format!("Bearer {}", cfg.token))
        .set("content-type", "application/json")
        .send_json(body)
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.into_json::<Value>().map_err(|e| format!("{e}")))
}

fn admin_bytes(cfg: &Cfg, agent: &Agent, base: &str, path: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}{}", base, path);
    let r = agent.get(&url)
        .set("authorization", &format!("Bearer {}", cfg.token))
        .call()
        .map_err(|e| format!("{e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    r.into_reader().read_to_end(&mut buf).map_err(|e| format!("{e}"))?;
    Ok(buf)
}

/// 拉一批消息（最多 max_pages 页 / 每页 20）。只做读取与过滤，不动游标。
/// 房间重建（epoch 变化）时把游标清零并从头重拉一次，避免游标卡在高位收不到新消息。
fn fetch_inbox(cfg: &Cfg, agent: &Agent, base: &str, mut since: u64, max_pages: usize,
               journal: Option<&Arc<Mutex<Vec<Value>>>>, advance_nonactionable: bool) -> Option<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut page = 0usize;
    let mut reset_done = false;
    let mut last_seen = since;
    loop {
        let url = format!("{}/p/{}/inbox?since={}&limit=20&agent={}", base, cfg.project, since,
                          urlencode(&cfg.agent_id));
        let r = agent.get(&url)
            .set("authorization", &format!("Bearer {}", cfg.token))
            .set("connection", "close")
            .call().ok()?;
        let v: Value = r.into_json().ok()?;
        let ep = v["epoch"].as_str().unwrap_or("").to_string();
        if page == 0 && !ep.is_empty() && epoch_get(&cfg.dir) != ep {
            if !reset_done {
                // 房间重建：旧游标、旧积压全部作废（seq 会从头再来，不清理会和旧任务撞号）
                reset_room_state(cfg, &ep, journal);
                since = 0;
                last_seen = 0;
                out.clear();
                reset_done = true;
                continue;
            }
        }
        if page == 0 && !ep.is_empty() { epoch_set(&cfg.dir, &ep); }
        let arr: Vec<Value> = v["messages"].as_array().cloned().unwrap_or_default();
        let next_cursor = v["next_cursor"].as_u64().unwrap_or(since);
        if arr.is_empty() {
            // 整页都是被服务端过滤掉的项目事件（announce/artifact/task 生命周期），
            // next_cursor 已经越过它们；不推进的话 wait 会每轮重拉同一段噪音。
            last_seen = next_cursor;
            break;
        }
        let last = arr.last().and_then(seq_of)?;
        last_seen = last.max(next_cursor);
        out.extend(arr);
        since = last_seen;
        page += 1;
        if !v["has_more"].as_bool().unwrap_or(false) || page >= max_pages { break; }
    }
    out.retain(|m| !is_noise(cfg, m) && for_me(cfg, m));
    out.sort_by_key(|m| seq_of(m).unwrap_or(0));
    out.dedup_by_key(|m| seq_of(m));
    // 同一批里可能包含同一 dedupe_key 的不同 seq（重投/房间重建）。先按 seq 排序，
    // 再按内容身份保留最早的一条，避免 wait 逐条取时把同一业务消息打印两次。
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    out.retain(|m| match dedupe_key_of(m) {
        Some(k) => seen_keys.insert(k.to_string()),
        None => true,
    });
    // 全是 ack 回声/发给别人的消息时，也要把游标越过它们，否则每轮都从头重拉
    if out.is_empty() && advance_nonactionable && last_seen > cursor_get(&cfg.dir) {
        cursor_set(&cfg.dir, last_seen);
    }
    Some(out)
}

/// 取一条（游标推进由调用方显式做：wait 在 ack 成功后推进，peek 完全不动）。
fn poll_once(cfg: &Cfg, agent: &Agent, base: &str, advance_nonactionable: bool) -> Option<Value> {
    fetch_inbox(cfg, agent, base, cursor_get(&cfg.dir), 5, None, advance_nonactionable)?
        .into_iter().next()
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}


 fn jitter(base: u64) -> u64 {
    // +0~50% 抖动（上限再封顶），避免所有客户端在同一秒重连打爆边缘
    let span = (base / 2).max(1);
    base + (now_ms() as u64 % span)
}

// ---------- 代理支持：默认先直连，直连不可用才回退到环境代理 ----------
// 背景：部分运行环境没有直连出口，只有 HTTP egress 代理（例如受管 VM）。
// 启用方式：① 默认先探测目标 /ver；直连可达就直连，探测失败才使用
//             HTTPS_PROXY/https_proxy/ALL_PROXY/all_proxy 里的代理；
//          ② 任意子命令带 --proxy <url> 可强制使用代理，--proxy off 强制直连；
//          NO_PROXY 命中的主机始终直连。HTTP 走 ureq 的 proxy 配置；WS 手工建
//          CONNECT 隧道后在隧道上做 TLS 握手。启用与异常都在启动时响亮打印
//          （只打印 host:port，永不打印凭据）。
// 已知取舍：ureq 的 proxy 对该 Agent 的全部请求生效（hub API 与产物上传同走此 Agent）。

#[derive(Clone)]
struct ProxyCfg {
    url: String,          // 原始代理 URL（给 ureq 用，含凭据，不打印）
    host: String,
    port: u16,
    auth: Option<String>, // Basic 凭据的 base64（给手工 CONNECT 用）
    display: String,      // host:port（日志用，不含凭据）
}

static PROXY_CFG: OnceLock<Option<ProxyCfg>> = OnceLock::new();

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 解析代理 URL：http://[user[:pass]@]host[:port]（只支持 http 代理）。
fn parse_proxy_url(raw: &str) -> Result<ProxyCfg, String> {
    let rest = raw.trim().strip_prefix("http://")
        .ok_or_else(|| "代理只支持 http:// 形式".to_string())?;
    let (userinfo, hostport) = match rest.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, rest),
    };
    let hostport = hostport.trim_end_matches('/');
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| format!("代理端口无效：{p}"))?),
        None => (hostport.to_string(), 8080u16),
    };
    if host.is_empty() { return Err("代理主机为空".to_string()); }
    Ok(ProxyCfg {
        url: raw.trim().to_string(),
        display: format!("{host}:{port}"),
        host,
        port,
        auth: userinfo.map(|u| b64_encode(u.as_bytes())),
    })
}

/// 单次直连探测的超时：3 秒在抖动网络下频繁误判（wb-win-189 实测一分钟内
/// 直连→代理→直连翻转，ISS-MWSP9ART-9C0134），放宽到 8 秒。
const DIRECT_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// 首次失败后重试一次；两次都失败才判直连不可用，避免单次抖动就整场走代理。
const DIRECT_PROBE_ATTEMPTS: u32 = 2;

/// 一次直连探测：只看 TCP/TLS/HTTP 是否通。任何 HTTP 状态码（含 4xx/5xx）
/// 都说明“直连能到达 Hub”，不应该因为业务错误就误切代理。通了返回本次耗时。
fn probe_direct_once(endpoint: &str) -> Option<Duration> {
    let url = format!("{}/ver", endpoint.trim_end_matches('/'));
    let started = std::time::Instant::now();
    let probe = ureq::AgentBuilder::new()
        .timeout(DIRECT_PROBE_TIMEOUT)
        .user_agent(concat!("synapse-agent/", env!("CARGO_PKG_VERSION"), " (rust)"))
        .build();
    match probe.get(&url).call() {
        Ok(_) => Some(started.elapsed()),
        Err(ureq::Error::Status(_, _)) => Some(started.elapsed()),
        Err(_) => None,
    }
}

/// 升级替换前把旧二进制的权限位复制到临时文件：fs::write 新建的文件是 0644，
/// rename 覆盖后新二进制没有可执行位，进程下次启动直接 Permission denied
/// （ISS-MWSNUQQP-58ECCC）。读不到旧权限时兜底 0755，并强制带上执行位。
#[cfg(not(windows))]
fn apply_upgrade_mode(tmp: &str, current: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(current).map(|m| m.permissions().mode()).unwrap_or(0o755);
    fs::set_permissions(tmp, fs::Permissions::from_mode(mode | 0o111))
}

/// 直连可达性探测：最多试 DIRECT_PROBE_ATTEMPTS 次；通了返回成功那次的耗时，
/// 供启动日志记录，免得再出现“探针误判、原因不明”。
fn probe_direct(endpoint: &str) -> Option<Duration> {
    for _ in 0..DIRECT_PROBE_ATTEMPTS {
        if let Some(elapsed) = probe_direct_once(endpoint) {
            return Some(elapsed);
        }
    }
    None
}

fn direct_reachable(endpoint: &str) -> bool {
    probe_direct(endpoint).is_some()
}

/// 启动时解析一次：显式 --proxy 优先；未显式指定时先试直连，失败才用环境代理。
fn init_proxy(endpoint: &str) {
    let argv: Vec<String> = std::env::args().collect();
    let mut raw: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--proxy" && i + 1 < argv.len() {
            raw = Some(argv[i + 1].clone());
            i += 1;
        }
        i += 1;
    }
    let explicit = raw.is_some();
    let from_env = !explicit;
    if from_env {
        raw = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
            .iter().find_map(|k| std::env::var(k).ok())
            .filter(|v| !v.trim().is_empty());
    }
    let cfg = match raw {
        None => None,
        Some(r) if matches!(r.trim().to_ascii_lowercase().as_str(), "off" | "none" | "direct") => {
            eprintln!("[proxy] 已按 --proxy off 关闭代理（直连）");
            None
        }
        Some(r) => match parse_proxy_url(&r) {
            Ok(p) => {
                if explicit {
                    eprintln!("[proxy] 已启用代理 {}（--proxy 参数）", p.display);
                    Some(p)
                } else if let Some(elapsed) = probe_direct(endpoint) {
                    // 默认直连优先：环境里虽然有代理变量，但 Hub 直连可达时不要绕代理。
                    eprintln!("[proxy] 直连可用（探测耗时 {}ms），跳过代理 {}（环境变量自动检测）", elapsed.as_millis(), p.display);
                    None
                } else {
                    eprintln!("[proxy] 直连不可用（探测 {} 次均失败，单次超时 {}s），改用代理 {}（环境变量自动检测）",
                              DIRECT_PROBE_ATTEMPTS, DIRECT_PROBE_TIMEOUT.as_secs(), p.display);
                    Some(p)
                }
            }
            Err(e) => {
                eprintln!("[proxy] 代理配置无效（改直连）：{e}");
                None
            }
        },
    };
    let _ = PROXY_CFG.set(cfg);
}

/// 目标主机应走的代理；未启用或命中 NO_PROXY 时返回 None（直连）。
fn proxy_for(target_host: &str) -> Option<&'static ProxyCfg> {
    let p = PROXY_CFG.get()?.as_ref()?;
    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
    for pat in no_proxy.split(',') {
        let pat = pat.trim().trim_start_matches('.');
        if !pat.is_empty() && (target_host == pat || target_host.ends_with(&format!(".{pat}"))) {
            return None;
        }
    }
    Some(p)
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url)
        .split(['/', ':', '?']).next().unwrap_or("").to_string()
}

/// 经代理 CONNECT 打通到目标的 TCP 隧道。
fn proxy_tunnel(proxy: &ProxyCfg, target_host: &str, target_port: u16) -> Result<TcpStream, String> {
    let addr = format!("{}:{}", proxy.host, proxy.port)
        .to_socket_addrs().map_err(|e| format!("代理解析失败 {}：{e}", proxy.display))?
        .next().ok_or_else(|| format!("代理解析无结果 {}", proxy.display))?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(15))
        .map_err(|e| format!("连接代理 {} 失败：{e}", proxy.display))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(20)));
    let mut req = format!("CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n");
    if let Some(a) = &proxy.auth {
        req += &format!("Proxy-Authorization: Basic {a}\r\n");
    }
    req += "\r\n";
    s.write_all(req.as_bytes()).map_err(|e| format!("代理 CONNECT 发送失败：{e}"))?;
    // 逐字节读到响应头结束，避免多读吞掉隧道里的 TLS 字节。
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
        match s.read(&mut byte) {
            Ok(0) => return Err("代理 CONNECT 连接被关闭".to_string()),
            Ok(_) => head.push(byte[0]),
            Err(e) => return Err(format!("代理 CONNECT 读取失败：{e}")),
        }
    }
    let text = String::from_utf8_lossy(&head);
    if text.split_whitespace().nth(1) != Some("200") {
        return Err(format!("代理 CONNECT 被拒：{}", text.lines().next().unwrap_or("无响应行")));
    }
    let _ = s.set_read_timeout(None);
    Ok(s)
}

/// WS 连接：启用代理时走 CONNECT 隧道后 TLS 握手，否则保持原直连。
fn ws_connect(url: &str)
    -> Result<(tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
               tungstenite::handshake::client::Response), tungstenite::Error>
{
    match proxy_for(&host_of(url)) {
        None => connect(url),
        Some(p) => {
            let port = if url.starts_with("wss://") { 443 } else { 80 };
            let stream = proxy_tunnel(p, &host_of(url), port).map_err(|e| {
                tungstenite::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;
            client_tls_with_config(url, stream, None, None).map_err(|e| match e {
                tungstenite::handshake::HandshakeError::Failure(f) => f,
                tungstenite::handshake::HandshakeError::Interrupted(_) => {
                    tungstenite::Error::Io(std::io::Error::new(
                        std::io::ErrorKind::Other, "ws 握手被中断"))
                }
            })
        }
    }
}

fn ws_ticket(cfg: &Cfg, agent: &Agent, base: &str) -> Result<String, String> {
    let r = agent
        .get(&format!("{}/p/{}/ws-ticket", base, cfg.project))
        .set("authorization", &format!("Bearer {}", cfg.token))
        .set("connection", "close")
        .call().map_err(|e| format!("{e}"))?;
    let v: Value = r.into_json().map_err(|e| format!("{e}"))?;
    v["ticket"].as_str().map(|s| s.to_string())
        .ok_or_else(|| "ws-ticket 响应里没有 ticket".to_string())
}

fn heartbeat_payload(cfg: &Cfg, hb: u64, queue: usize, journal: &Arc<Mutex<Vec<Value>>>) -> Value {
    let mut load = json!({});
    if let Some(l) = load1() { load["load1"] = json!(l); }
    if let Some((u, t)) = mem_mb() { load["mem_used_mb"] = json!(u); load["mem_total_mb"] = json!(t); }
    load["disk"] = disk();
    json!({"hb": hb, "agent_id": cfg.agent_id, "work": {"state": "idle"},
           "load": load, "env": {"git_head": git_head()}, "sdk_version": env!("CARGO_PKG_VERSION"),
           "queue": queue, "unacked": journal.lock().unwrap().len()})
}

fn exec_task(cmd: &str, task: &str) {
    match std::process::Command::new("sh")
        .arg("-c").arg(cmd)
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(format!("{task}\n").as_bytes());
            }
            let _ = child.wait();
        }
        Err(e) => eprintln!("[exec] 启动失败：{e}"),
    }
}

/// 把一条消息投递出去：先 WAL（inflight）落盘，再回执“已收到”，最后入队给主线程。
fn deliver_ws(cfg: &Cfg, agent: &Agent, base: &str,
              journal: &Arc<Mutex<Vec<Value>>>, m: &Value,
              tx: &mpsc::Sender<(String, bool)>, queue: &AtomicUsize, last_msg: &AtomicU64) {
    if is_noise(cfg, m) || !for_me(cfg, m) { return; }
    if !enqueue_message(cfg, journal, m) { return; }
    // 关键顺序：先真的把消息送进目标窗口/tmux，再 ACK。以前这里先 ACK，投递失败时
    // 服务端仍显示已送达，用户只看到 ACK、看不到消息。
    let delivered = {
        let _gate = SURFACE_SEND_LOCK.lock().unwrap();
        let ok = forward_to_surface_impl(cfg, m);
        if ok && cfg.surface_forward() && addressed_to_me(cfg, m) {
            mark_surface_delivered(&cfg.dir, journal, m);
        }
        ok
    };
    if !delivered {
        eprintln!("[ws] seq={} 外部投递未确认，保留 WAL、不 ACK；等待重投/重连重放",
                  seq_of(m).unwrap_or(0));
        return;
    }
    let seq = seq_of(m).unwrap_or(0);
    let _ = ack_message(cfg, agent, base, seq, "done",
                        &json!({"note": ack_note(cfg, "run 收到（已投递）", "run 收到（receipt）")}), ack_required(m));
    let text = serde_json::to_string(m).unwrap_or_default();
    // 先加计数再入队：主线程可能在 send 返回前就取走并减计数，顺序反了会把 queue 卡在虚高值
    queue.fetch_add(1, Ordering::Relaxed);
    if tx.send((text, false)).is_err() {
        let _ = queue.try_update(Ordering::Relaxed, Ordering::Relaxed,
                                 |x| Some(x.saturating_sub(1)));
    }
    last_msg.store(now_ms() as u64, Ordering::Relaxed);
}

/// 轮询模式（也是 WS 失败后的降级通道）。max_duration=None 表示常驻轮询；
/// Some(d) 表示只跑 d 这么久，然后返回让调用方重试 WS。
fn run_poll(cfg: &Cfg, agent: &Agent, base: &str, max_duration: Option<Duration>) {
    let poll_s = crate::profile::detect()["poll_s"].as_u64().unwrap_or(4).max(1);
    let journal: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(journal_load(&cfg.dir)));
    let last_msg = Arc::new(AtomicU64::new(0));
    let poll_stop = Arc::new(AtomicBool::new(false));

    // 心跳独立于收件/执行：长任务不能把 heartbeat 压住。
    let hb_handle = {
        let (cfg2, agent2, base2, journal2, last2, stop2) =
            (cfg.clone_lite(), agent.clone(), base.to_string(), journal.clone(),
             last_msg.clone(), poll_stop.clone());
        thread::spawn(move || {
            let mut hb: u64 = 0;
            loop {
                if stop2.load(Ordering::Relaxed) { break; }
                hb += 1;
                let queue_len = journal2.lock().unwrap().len();
                let body = heartbeat_payload(&cfg2, hb, queue_len, &journal2);
                let ok = agent2
                    .post(&format!("{}/p/{}/heartbeat", base2, cfg2.project))
                    .set("authorization", &format!("Bearer {}", cfg2.token))
                    .set("x-sdk-version", env!("CARGO_PKG_VERSION"))
                    .set("connection", "close")
                    .send_json(body).is_ok();
                if !ok { eprintln!("[poll] heartbeat 失败 hb={hb}"); }
                write_run_state(&cfg2.dir, &json!({
                    "connected": ok, "transport": "poll", "last_hb_ok": ok,
                    "last_hb_ms": now_ms() as u64,
                    "last_msg_ms": last2.load(Ordering::Relaxed),
                    "queue": queue_len, "unacked": queue_len, "pid": std::process::id(),
                }));
                // 分片睡眠，让 run_poll 到点返回时最多等 1s，不必等满一个心跳周期。
                let wait_until = Instant::now() + Duration::from_secs(cfg2.heartbeat_s.max(1));
                while !stop2.load(Ordering::Relaxed) && Instant::now() < wait_until {
                    thread::sleep(Duration::from_secs(1));
                }
            }
        })
    };

    // YANSHI_HB_ONLY=1：纯心跳模式下不重放 WAL，不执行任何消息，inbox 全部留给 wait。
    let hb_only_poll = std::env::var("SYNAPSE_HB_ONLY").or_else(|_| std::env::var("YANSHI_HB_ONLY"))
        .map(|v| v == "1").unwrap_or(false);
    // 先启动心跳，再重放 WAL：重放里的 exec 任务再慢，也不会让心跳停摆。
    let replay: Vec<Value> = if hb_only_poll { Vec::new() } else { journal.lock().unwrap().clone() };
    for m in replay {
        // 外部投递成功之前绝不 ACK；失败就继续留在 WAL，下一轮重试。
        if !forward_to_surface(cfg, &m) {
            eprintln!("[poll] seq={} 重放投递失败，保留 WAL、不 ACK",
                      seq_of(&m).unwrap_or(0));
            continue;
        }
        if cfg.surface_forward() && addressed_to_me(cfg, &m) {
            mark_surface_delivered(&cfg.dir, &journal, &m);
        }
        if let Some(seq) = seq_of(&m) {
            let _ = ack_message(cfg, agent, base, seq, "done",
                                &json!({"note": ack_note(cfg, "poll 启动重放（已投递）", "poll 启动重放（receipt）")}), ack_required(&m));
        }
        let text = serde_json::to_string(&m).unwrap_or_default();
        if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &text); } else { println!("{text}"); }
        dequeue_message(&cfg.dir, &journal, &m);
        last_msg.store(now_ms() as u64, Ordering::Relaxed);
    }

    // YANSHI_HB_ONLY=1：心跳线程已在上面启动并保持在线，主线程只阻塞休眠，绝不消费 inbox。
    // 这样对话回合的 `wait` 能从游标位置取到全部消息。
    if hb_only_poll {
        loop { thread::sleep(Duration::from_secs(3600)); }
    }

    let started = Instant::now();
    loop {
        if let Some(limit) = max_duration {
            if started.elapsed() >= limit { break; }
        }
        let retried = retry_pending_surfaces(cfg, agent, base, &journal, &last_msg);
        if retried > 0 { eprintln!("[poll] 重试补发 {retried} 条外部投递消息"); }
        if let Some(msgs) = fetch_inbox(&cfg, &agent, &base, cursor_get(&cfg.dir), 5, Some(&journal), true) {
            for m in msgs {
                if is_noise(&cfg, &m) || !for_me(&cfg, &m) { continue; }
                if !enqueue_message(&cfg, &journal, &m) { continue; }
                let seq = seq_of(&m).unwrap_or(0);
                if !forward_to_surface(cfg, &m) {
                    eprintln!("[poll] seq={seq} 外部投递失败，保留 WAL、不 ACK");
                    continue;
                }
                if cfg.surface_forward() && addressed_to_me(cfg, &m) {
                    mark_surface_delivered(&cfg.dir, &journal, &m);
                }
                let _ = ack_message(&cfg, &agent, &base, seq, "done",
                                    &json!({"note": ack_note(cfg, "poll 收到（已投递）", "poll 收到（receipt）")}), ack_required(&m));
                let text = serde_json::to_string(&m).unwrap_or_default();
                if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &text); } else { println!("{text}"); }
                dequeue_message(&cfg.dir, &journal, &m);
                last_msg.store(now_ms() as u64, Ordering::Relaxed);
            }
        }
        thread::sleep(Duration::from_secs(poll_s));
    }

    poll_stop.store(true, Ordering::Relaxed);
    let _ = hb_handle.join();
    // 交给 WS 重试前先把状态改成“轮询已停”，避免旧状态继续显示 connected=true。
    let mut st: Value = fs::read_to_string(cfg.dir.join("run.state.json")).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    st["connected"] = json!(false);
    st["transport"] = json!("poll");
    st["pid"] = json!(std::process::id());
    write_run_state(&cfg.dir, &st);
}

/// WebSocket 长连接：收件线程（重连/探活/补拉）+ 心跳线程 + 主线程执行。
/// 返回 true = 被同一 agent 的新连接取代（调用方退出）；false = 连续失败（回退轮询）。
fn run_ws(cfg: &Cfg, agent: &Agent, base: &str) -> bool {
    let ws_base = base.replace("https://", "wss://").replace("http://", "ws://");
    let journal: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(journal_load(&cfg.dir)));
    // 启动时的 inflight 不在这里同步执行：先把它们排到主线程队列，再建立连接/心跳。
    // 否则一条卡住的重放任务会让 WS 永远连不上，status 也看不到 reconnect。
    let pending: Vec<Value> = { let g = journal.lock().unwrap(); g.clone() };
    // 无界队列：收件线程绝不因主线程在跑长任务而阻塞。磁盘 WAL 仍是上限，
    // queue 只保存消息 JSON，积压几百条也不会把 WS 读取/心跳卡死。
    let (tx, rx) = mpsc::channel::<(String, bool)>();
    let state = Arc::new(Mutex::new(("idle".to_string(), String::new(), 0usize)));
    let connected = Arc::new(AtomicBool::new(false));
    let queue = Arc::new(AtomicUsize::new(0));
    let last_msg = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let superseded = Arc::new(AtomicBool::new(false));
    let state_gate = Arc::new(Mutex::new(()));

    // 重放先入队（此时收件线程还没启动，保证 replay 排在新消息前面）。
    for m in pending {
        let text = serde_json::to_string(&m).unwrap_or_default();
        if tx.send((text, true)).is_ok() {
            queue.fetch_add(1, Ordering::Relaxed);
        }
    }

    // 收件线程：连接、收、断线重连；任务执行期间照常入队
    {
        let (cfg2, agent2, base2) = (cfg.clone_lite(), agent.clone(), base.to_string());
        let tx2 = tx.clone();
        let connected2 = connected.clone();
        let queue2 = queue.clone();
        let last2 = last_msg.clone();
        let journal2 = journal.clone();
        let ws_base2 = ws_base.clone();
        let stop2 = stop.clone();
        let superseded2 = superseded.clone();
        let gate2 = state_gate.clone();
        thread::spawn(move || {
            let mut backoff = 1u64;
            let mut fails = 0u32;
            let connected_at: std::cell::Cell<Option<Instant>> = std::cell::Cell::new(None);
            loop {
                if stop2.load(Ordering::Relaxed) { break; }
                let ticket = match ws_ticket(&cfg2, &agent2, &base2) {
                    Ok(t) => t,
                    Err(e) => {
                        fails += 1;
                        eprintln!("[ws] 取票据失败({fails}/6)：{e}");
                        if fails >= 6 { eprintln!("[ws] 连续失败，回退轮询"); break; }
                        thread::sleep(Duration::from_secs(jitter(backoff)));
                        backoff = (backoff * 2).min(30);
                        continue;
                    }
                };
                let url = format!("{}/p/{}/ws?ticket={}", ws_base2, cfg2.project, ticket);
                match ws_connect(&url) {
                    Ok((mut sock, _r)) => {
                        connected_at.set(Some(Instant::now()));
                        // 握手成功就清空“连续连接失败”计数；不能等到第一条消息，
                        // 否则一条安静但健康的连接会被上一次失败计数拖进轮询。
                        fails = 0;
                        connected2.store(true, Ordering::Relaxed);
                        println!("ws connected {}", url.split("/ws?").next().unwrap_or(""));
                        let unacked = journal2.lock().unwrap().len();
                        write_ws_state(&cfg2.dir, true, queue2.load(Ordering::Relaxed),
                                       last2.load(Ordering::Relaxed), unacked, &gate2);
                        // 读超时：黑洞连接不能永远卡在 read()
                        {
                            use tungstenite::stream::MaybeTlsStream;
                            match sock.get_ref() {
                                MaybeTlsStream::Plain(s) => { let _ = s.set_read_timeout(Some(Duration::from_secs(45))); }
                                MaybeTlsStream::Rustls(s) => { let _ = s.sock.set_read_timeout(Some(Duration::from_secs(45))); }
                                _ => {}
                            }
                        }
                        let _ = sock.send(Message::Ping(Vec::new()));
                        // 重连期间可能漏掉的积压：按游标连续补拉，避免只补 100 条就切到 WS 而留下空洞
                        for _ in 0..10 {
                            match fetch_inbox(&cfg2, &agent2, &base2, cursor_get(&cfg2.dir), 5,
                                              Some(&journal2), true) {
                                Some(msgs) if !msgs.is_empty() => {
                                    for m in &msgs {
                                        deliver_ws(&cfg2, &agent2, &base2, &journal2, m,
                                                   &tx2, &queue2, &last2);
                                    }
                                }
                                _ => break,
                            }
                        }
                        let mut timeouts = 0u32;
                        loop {
                            match sock.read() {
                                Ok(Message::Text(t)) => {
                                    timeouts = 0;
                                    fails = 0;
                                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                                        if v["type"] == "msg" {
                                            deliver_ws(&cfg2, &agent2, &base2, &journal2, &v,
                                                       &tx2, &queue2, &last2);
                                        }
                                    }
                                }
                                Ok(Message::Ping(p)) => {
                                    // Ping 也是活连接证据：同时清掉读超时计数，否则
                                    // “超时一次 → Ping → 再超时一次”会被误判为连续两次超时。
                                    timeouts = 0;
                                    fails = 0;
                                    let _ = sock.send(Message::Pong(p));
                                }
                                Ok(Message::Pong(_)) => { timeouts = 0; fails = 0; }
                                Ok(Message::Close(frame)) => {
                                    // 4001 = 服务端“同 agent 已有更新连接”，本进程应退出而不是抢回来
                                    if frame.as_ref().map(|f| u16::from(f.code) == 4001).unwrap_or(false) {
                                        eprintln!("[ws] 已被同一 agent 的新连接取代，本进程退出");
                                        superseded2.store(true, Ordering::Relaxed);
                                    } else {
                                        eprintln!("[ws] 服务端关闭连接");
                                    }
                                    break;
                                }
                                Ok(_) => {}
                                Err(tungstenite::Error::Io(ref e))
                                    if matches!(e.kind(),
                                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
                                {
                                    timeouts += 1;
                                    let _ = sock.send(Message::Ping(Vec::new()));
                                    if timeouts >= 2 { eprintln!("[ws] 读两次超时，判定断线"); break; }
                                }
                                Err(e) => { eprintln!("[ws] 读失败：{e}"); break; }
                            }
                        }
                        connected2.store(false, Ordering::Relaxed);
                        let unacked = journal2.lock().unwrap().len();
                        write_ws_state(&cfg2.dir, false, queue2.load(Ordering::Relaxed),
                                       last2.load(Ordering::Relaxed), unacked, &gate2);
                        // 只有稳定连接超过 10s 才把退避重置为 1；否则“刚连上就被踢”
                        // 会以 1s 间隔无限重连，形成重连风暴。
                        if connected_at.get().map(|t| t.elapsed() >= Duration::from_secs(10)).unwrap_or(true) {
                            backoff = 1;
                        }
                        if superseded2.load(Ordering::Relaxed) { break; }
                        fails += 1;
                        eprintln!("[ws] 连接断开({fails}/6)，{}s 后重连", jitter(backoff));
                        if fails >= 6 { eprintln!("[ws] 连续断线，回退轮询"); break; }
                    }
                    Err(e) => {
                        fails += 1;
                        eprintln!("[ws] 连接失败({fails}/6)：{e}");
                        if fails >= 6 { eprintln!("[ws] 连续失败，回退轮询"); break; }
                    }
                }
                thread::sleep(Duration::from_secs(jitter(backoff)));
                backoff = (backoff * 2).min(30);
            }
        });
    }
    drop(tx);  // 收件线程退出后 rx 才能感知到“没有生产者了”，从而回退轮询

    // 心跳线程：状态取自共享变量，能看到"在忙什么 + 队列积压"，并写 run.state.json 供 status 读。
    {
        let (agent2, base2, proj, tok, aid, period, dir2) =
            (agent.clone(), base.to_string(), cfg.project.clone(), cfg.token.clone(),
             cfg.agent_id.clone(), cfg.heartbeat_s, cfg.dir.clone());
        let st = state.clone();
        let conn3 = connected.clone();
        let q3 = queue.clone();
        let last3 = last_msg.clone();
        let journal3 = journal.clone();
        let stop3 = stop.clone();
        let gate3 = state_gate.clone();
        thread::spawn(move || {
            let mut hb = 0u64;
            loop {
                if stop3.load(Ordering::Relaxed) { break; }
                hb += 1;
                let (ws, ph, _q) = { let g = st.lock().unwrap(); (g.0.clone(), g.1.clone(), g.2) };
                let queue_now = q3.load(Ordering::Relaxed);
                let unacked = journal3.lock().unwrap().len();
                let body = json!({"hb": hb, "agent_id": aid, "work": {"state": ws, "phase": ph},
                                  "load": {"disk": disk()}, "sdk_version": env!("CARGO_PKG_VERSION"),
                                  "queue": queue_now, "unacked": unacked});
                let ok = agent2.post(&format!("{}/p/{}/heartbeat", base2, proj))
                    .set("authorization", &format!("Bearer {}", tok))
                    .set("connection", "close")
                    .send_json(body).is_ok();
                let _g = gate3.lock().unwrap();
                let connected_now = conn3.load(Ordering::Relaxed);
                write_run_state(&dir2, &json!({
                    "connected": connected_now,
                    "transport": "ws",
                    "last_hb_ok": ok,
                    "last_hb_ms": now_ms() as u64,
                    "last_msg_ms": last3.load(Ordering::Relaxed),
                    "queue": queue_now,
                    "unacked": unacked,
                    "pid": std::process::id(),
                }));
                thread::sleep(Duration::from_secs(period));
            }
        });
    }

    // 主线程：取任务 → 执行（inflight 已在启动时先入队，保留 seq 顺序）
    loop {
        let (task, replay) = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(x) => x,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let n = retry_pending_surfaces(cfg, agent, base, &journal, &last_msg);
                if n > 0 { eprintln!("[ws] 空闲重试补发 {n} 条外部投递消息"); }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let parsed = serde_json::from_str::<Value>(&task).ok();
        let title = parsed.as_ref()
            .and_then(|v| v["payload"]["title"].as_str().map(|x| x.to_string()))
            .unwrap_or_default();
        { let mut g = state.lock().unwrap(); g.0 = "busy".into(); g.1 = title.clone(); }
        let mut delivered = true;
        if replay {
            // 重放消息尚未经过 deliver_ws 的外部投递；先投窗口/tmux，再补 ACK。
            if let Some(v) = &parsed {
                if !forward_to_surface(cfg, v) { delivered = false; }
                else if cfg.surface_forward() && addressed_to_me(cfg, v) {
                    mark_surface_delivered(&cfg.dir, &journal, v);
                }
            }
            if delivered {
                if let Some(v) = &parsed {
                    if let Some(seq) = seq_of(v) {
                        let _ = ack_message(cfg, agent, base, seq, "done",
                                            &json!({"note": ack_note(cfg, "run 启动重放（已投递）", "run 启动重放（receipt）")}), ack_required(v));
                    }
                }
            }
        }
        if delivered {
            if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &task); } else { println!("{task}"); }
            if let Some(v) = &parsed { dequeue_message(&cfg.dir, &journal, v); }
        } else if let Some(v) = &parsed {
            eprintln!("[ws] seq={} 重放投递失败，保留 WAL、不 ACK",
                      seq_of(v).unwrap_or(0));
        }
        let _ = queue.try_update(Ordering::Relaxed, Ordering::Relaxed,
                                 |x| Some(x.saturating_sub(1)));
        { let mut g = state.lock().unwrap(); g.0 = "idle".into(); g.1 = "等指令".into(); }
    }
    stop.store(true, Ordering::Relaxed);
    connected.store(false, Ordering::Relaxed);
    // true = 被新连接取代，调用方应直接退出；false = 长连接不可用，回退轮询
    superseded.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synapse-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_cfg(dir: PathBuf) -> Cfg {
        Cfg {
            cmd: "run".into(),
            endpoint: "https://example.invalid".into(),
            project: "p".into(),
            token: "t".into(),
            agent_id: "a1".into(),
            dir,
            heartbeat_s: 30,
            exec_cmd: None,
            window_app: String::new(),
            window_conversation: String::new(),
            window_forward: false,
            tmux_target: String::new(),
            tmux_forward: false,
            tmux_verify: true,
        }
    }

    #[test]
    fn upgrade_mode_preserves_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("upgrade-mode");
        let current = dir.join("synapse-agent");
        let tmp = dir.join("synapse-agent.new");
        fs::write(&current, b"old").unwrap();
        fs::set_permissions(&current, fs::Permissions::from_mode(0o751)).unwrap();
        fs::write(&tmp, b"new").unwrap(); // fs::write 新建文件是 0644，没有可执行位
        let before = fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(before & 0o111, 0, "fixture tmp file must start without exec bits");
        apply_upgrade_mode(tmp.to_str().unwrap(), &current).unwrap();
        let mode = fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o751, "tmp must inherit the old binary's mode before rename");
    }

    #[test]
    fn direct_probe_reaches_local_listener() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
            }
        });
        let endpoint = format!("http://127.0.0.1:{port}");
        assert!(probe_direct(&endpoint).is_some(), "live local listener must probe reachable");
        let _ = server.join();
    }

    #[test]
    fn direct_probe_dead_port_is_unreachable() {
        // 绑一个端口再立刻释放：几乎必然无人监听，连接会被拒绝。
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap()
            .local_addr().unwrap().port();
        assert!(probe_direct(&format!("http://127.0.0.1:{port}")).is_none(),
                "refused port must probe unreachable after retries");
    }

    #[test]
    fn cursor_is_atomic_and_readable() {
        let dir = scratch("cursor");
        cursor_set(&dir, 7);
        assert_eq!(cursor_get(&dir), 7);
        cursor_set(&dir, 9);
        assert_eq!(cursor_get(&dir), 9);
        let raw = fs::read_to_string(dir.join("cursor.json")).unwrap();
        assert!(serde_json::from_str::<Value>(&raw).is_ok(), "cursor must stay valid JSON");
    }

    #[test]
    fn enqueue_persists_wal_and_advances_cursor() {
        let dir = scratch("enqueue");
        let cfg = test_cfg(dir.clone());
        let journal = Arc::new(Mutex::new(Vec::new()));
        let msg = json!({"seq": 5, "topic": "task", "payload": {"title": "x"}});

        assert!(enqueue_message(&cfg, &journal, &msg));
        assert_eq!(cursor_get(&dir), 5);
        assert_eq!(journal_load(&dir).len(), 1, "WAL must survive in memory->disk");
        assert!(!enqueue_message(&cfg, &journal, &msg), "same seq must not duplicate");
        assert_eq!(journal_load(&dir).len(), 1);

        dequeue_message(&dir, &journal, &msg);
        assert_eq!(journal_load(&dir).len(), 0);
        assert_eq!(cursor_get(&dir), 5, "ack/processing must not rewind cursor");

        // 模拟“已写 WAL、未推游标”就崩溃：再次入队不能重复投递，但要把游标补齐
        let msg6 = json!({"seq": 6, "topic": "task", "payload": {"title": "y"}});
        journal.lock().unwrap().push(msg6.clone());
        journal_save(&dir, &journal.lock().unwrap());
        cursor_set(&dir, 5);
        assert!(!enqueue_message(&cfg, &journal, &msg6));
        assert_eq!(cursor_get(&dir), 6, "duplicate in WAL must still advance cursor");
        assert_eq!(journal_load(&dir).len(), 1);

        // dedupe_key 是内容身份：换了 seq 重投也不能再执行一次
        let m7 = json!({"seq": 7, "topic": "task", "dedupe_key": "task:d1", "payload": {"title": "z"}});
        let m9 = json!({"seq": 9, "topic": "task", "dedupe_key": "task:d1", "payload": {"title": "z"}});
        assert!(enqueue_message(&cfg, &journal, &m7));
        assert!(!enqueue_message(&cfg, &journal, &m9), "same dedupe_key must be idempotent");
        assert_eq!(cursor_get(&dir), 9);
        assert_eq!(journal_load(&dir).len(), 2);
        dequeue_message(&dir, &journal, &m9);   // 用新 seq 也要删掉旧 WAL 项
        assert_eq!(journal_load(&dir).len(), 1);
    }

    #[test]
    fn epoch_reset_drops_old_cursor_and_wal() {
        let dir = scratch("epoch");
        let cfg = test_cfg(dir.clone());
        let journal = Arc::new(Mutex::new(vec![json!({"seq": 42, "topic": "task"})]));
        cursor_set(&dir, 42);
        epoch_set(&dir, "old");
        reset_room_state(&cfg, "new", Some(&journal));
        assert_eq!(cursor_get(&dir), 0);
        assert_eq!(epoch_get(&dir), "new");
        assert!(journal_load(&dir).is_empty());
        assert!(journal.lock().unwrap().is_empty());
    }

    #[test]
    fn noise_and_target_filter() {
        let dir = scratch("filter");
        let cfg = test_cfg(dir);
        assert!(is_noise(&cfg, &json!({"topic": "ack", "payload": {}})));
        assert!(is_noise(&cfg, &json!({"topic": "announce", "sender": "a1", "to": null})));
        assert!(!is_noise(&cfg, &json!({"topic": "task", "sender": "admin"})));
        assert!(for_me(&cfg, &json!({"topic": "announce", "to": null})));
        assert!(for_me(&cfg, &json!({"topic": "task", "to": "a1"})));
        assert!(!for_me(&cfg, &json!({"topic": "task", "to": "b2"})));
        assert!(for_me(&cfg, &json!({"topic": "task", "to": ["b2", "a1"]})));
        assert!(!for_me(&cfg, &json!({"topic": "task", "to": ["b2", "c3"]})));
    }

    #[test]
    fn tmux_verify_flag_parses_truthy_values() {
        // --tmux-verify 0 必须解析为 false（alternate-screen TUI 关标记验证）
        assert!(cfg_truthy("1"));
        assert!(cfg_truthy("true"));
        assert!(!cfg_truthy("0"));
        assert!(!cfg_truthy("false"));
        assert!(!cfg_truthy("off"));
    }

    #[test]
    fn window_filter_skips_project_events() {
        let dir = scratch("window-filter");
        let cfg = test_cfg(dir);

        // 其他 agent 的交付单：payload 有 title，但属于交付箱事件，不进窗口
        let artifact = json!({
            "seq": 99, "sender": "b2", "to": null, "topic": "artifact",
            "kind": "report", "payload": {"title": "T-FIX done"}
        });
        assert!(is_surface_noise(&cfg, &artifact));

        // 其他 agent 的任务板生命周期事件，不是任务正文
        let released = json!({
            "seq": 100, "sender": "b2", "to": null, "topic": "task",
            "kind": "released", "payload": {"task_id": "T-1"}
        });
        assert!(is_surface_noise(&cfg, &released));

        // 其他 agent 发出的项目广播（报告/状态），不是给本窗口的指令
        let report = json!({
            "sender": "b2", "to": null, "topic": "report",
            "kind": "report", "payload": {"text": "done"}
        });
        assert!(is_surface_noise(&cfg, &report));

        // 管理端广播、管理端定向任务、其他 agent 点名的消息仍然放行
        let admin_bc = json!({
            "sender": "admin", "to": null, "topic": "announce",
            "kind": "broadcast", "payload": {"title": "git pull"}
        });
        assert!(!is_surface_noise(&cfg, &admin_bc));
        let admin_dm = json!({
            "sender": "admin", "to": "a1", "topic": "task",
            "kind": "task", "payload": {"title": "do it"}
        });
        assert!(!is_surface_noise(&cfg, &admin_dm));
        let agent_dm = json!({
            "sender": "b2", "to": "a1", "topic": "task",
            "kind": "task", "payload": {"title": "review"}
        });
        assert!(!is_surface_noise(&cfg, &agent_dm));
    }

    #[test]
    fn tmux_message_flat_and_marker() {
        let raw = "[Synapse #12] 定向\ngit pull\n第二段";
        assert_eq!(flatten_hub_message(raw), "[Synapse #12] 定向 git pull 第二段");
        assert_eq!(message_marker(raw), Some("[Synapse #12]"));
        assert_eq!(message_marker("plain text"), None);
    }

    #[test]
    fn hub_message_formats_for_composer() {
        let m = json!({"seq": 12, "payload": {"title": "定向", "body": "git pull"}});
        assert_eq!(format_hub_message(&m).as_deref(), Some("[Synapse #12] 定向\ngit pull"));
        let task = json!({"seq": 3, "payload": {"task": {"title": "t", "body": "b"}}});
        assert_eq!(format_hub_message(&task).as_deref(), Some("[Synapse #3] t\nb"));
        assert_eq!(format_hub_message(&json!({"payload": {}})), None);
        assert!(is_task_notice(&json!({"kind": "task_notice"})));
        assert!(is_task_notice(&json!({"topic": "task", "kind": "released"})));
        assert!(!is_task_notice(&json!({"kind": "task", "payload": {"title": "x"}})));
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;

    #[test]
    fn selects_by_platform_not_first_entry() {
        let man = json!({"binaries": [
            {"platform": "linux-x86_64", "url": "/dl/linux"},
            {"platform": "windows-x86_64", "url": "/dl/win"}
        ]});
        let tags = vec!["windows-x86_64".to_string()];
        let b = find_manifest_binary(&man, &tags).unwrap();
        assert_eq!(b["url"].as_str(), Some("/dl/win"));
    }

    #[test]
    fn missing_platform_is_none() {
        let man = json!({"binaries": [{"platform": "linux-x86_64"}]});
        let tags = vec!["darwin-arm64".to_string()];
        assert!(find_manifest_binary(&man, &tags).is_none());
    }

    #[test]
    fn explicit_override_is_single_tag() {
        let tags = upgrade_platform_tags("linux-x86_64-gnu");
        assert_eq!(tags, vec!["linux-x86_64-gnu".to_string()]);
    }
}
