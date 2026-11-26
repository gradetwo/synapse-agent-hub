//! synapse-agent（Rust）：单二进制，无 Python 环境也能接入。
//! 用法： synapse-agent init --endpoint … --project … --token …
//!        synapse-agent run   --endpoint … --project … --token … [--heartbeat 60]

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::sync::{Arc, Mutex};
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, AtomicUsize, Ordering};
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
    /// 本地投递面的身份（agent/admin）。服务端仍按 token 的 role 判定；
    /// 这里只决定普通 agent 是否允许无收件人的广播进 TUI。默认 agent。
    role: String,
    dir: PathBuf,
    heartbeat_s: u64,
    exec_cmd: Option<String>,
    /// 实时事件回调命令（可选）。每条 task.* / submission.* 事件作为一行 JSON
    /// 从 stdin 传入；不配置时只落 events.jsonl，不影响原有任务投递。
    event_cmd: Option<String>,
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
    /// 每个生效字段的来源（cli/env/config/default），用于管理台解释“为什么是关闭”。
    sources: HashMap<String, String>,
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

// 服务端下发的运行参数。只用原子变量，心跳线程写、投递线程读，不加锁。
// -1=inherit（跟随本地 config/CLI），0=强制关，1=强制开。
static REMOTE_AUTO: AtomicI8 = AtomicI8::new(-1);
static REMOTE_DEBUG: AtomicBool = AtomicBool::new(false);
static REMOTE_HB_S: AtomicU64 = AtomicU64::new(0);       // 0=跟随本地
static REMOTE_REV: AtomicU64 = AtomicU64::new(0);
static REMOTE_APPLIED_MS: AtomicU64 = AtomicU64::new(0);

static DELIVERY_LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);
static DELIVERY_LAST_OK_MS: AtomicU64 = AtomicU64::new(0);
static DELIVERY_FAILS: AtomicU64 = AtomicU64::new(0);
static DELIVERY_LAST_ERROR: OnceLock<Mutex<String>> = OnceLock::new();

fn delivery_attempt() {
    DELIVERY_LAST_ATTEMPT_MS.store(now_ms() as u64, Ordering::Relaxed);
}

fn delivery_result(ok: bool, error: Option<String>) {
    if ok {
        DELIVERY_LAST_OK_MS.store(now_ms() as u64, Ordering::Relaxed);
        DELIVERY_FAILS.store(0, Ordering::Relaxed);
        if let Ok(mut g) = DELIVERY_LAST_ERROR.get_or_init(|| Mutex::new(String::new())).lock() {
            g.clear();
        }
    } else {
        DELIVERY_FAILS.fetch_add(1, Ordering::Relaxed);
        if let Some(e) = error {
            if let Ok(mut g) = DELIVERY_LAST_ERROR.get_or_init(|| Mutex::new(String::new())).lock() {
                *g = e.chars().take(300).collect();
            }
            record_client_error("delivery", "surface delivery failed", Some(e));
        }
    }
}

fn delivery_health_payload() -> Value {
    let last_attempt = DELIVERY_LAST_ATTEMPT_MS.load(Ordering::Relaxed);
    let last_ok = DELIVERY_LAST_OK_MS.load(Ordering::Relaxed);
    let fails = DELIVERY_FAILS.load(Ordering::Relaxed);
    let last_error = DELIVERY_LAST_ERROR.get_or_init(|| Mutex::new(String::new()))
        .lock().map(|g| g.clone()).unwrap_or_default();
    json!({
        "last_attempt_ms": last_attempt,
        "last_ok_ms": last_ok,
        "last_error": last_error,
        "consecutive_failures": fails,
    })
}

fn remote_auto_state() -> &'static str {
    match REMOTE_AUTO.load(Ordering::Relaxed) {
        1 => "on",
        0 => "off",
        _ => "inherit",
    }
}

fn remote_debug_enabled() -> bool {
    REMOTE_DEBUG.load(Ordering::Relaxed)
}

fn runtime_heartbeat_s(cfg: &Cfg) -> u64 {
    let remote = REMOTE_HB_S.load(Ordering::Relaxed);
    if (15..=300).contains(&remote) { remote } else { cfg.heartbeat_s.max(1) }
}

/// 本地命令行/config 的投递面，不含远程覆盖。
fn local_surfaces(cfg: &Cfg) -> (bool, bool) {
    (cfg.window_forward, cfg.tmux_forward)
}

/// 远程覆盖后的实际投递面。开启自动投送但没有目标时返回 (false,false)，由调用方保留 WAL。
fn effective_surfaces(cfg: &Cfg) -> (bool, bool) {
    match REMOTE_AUTO.load(Ordering::Relaxed) {
        1 => {
            let window = cfg.window_forward || !cfg.window_app.trim().is_empty();
            let tmux = !window && (cfg.tmux_forward || !cfg.tmux_target.trim().is_empty());
            (window, tmux)
        }
        0 => (false, false),
        _ => local_surfaces(cfg),
    }
}

fn effective_surface_forward(cfg: &Cfg) -> bool {
    let (w, t) = effective_surfaces(cfg);
    w || t
}

fn apply_remote_control(control: &Value) {
    let prev_rev = REMOTE_REV.load(Ordering::Relaxed);
    let prev_state = remote_auto_state().to_string();
    let prev_debug = remote_debug_enabled();
    if control.is_null() || !control.is_object() {
        let had_control = prev_rev > 0 || prev_state != "inherit" || prev_debug;
        REMOTE_AUTO.store(-1, Ordering::Relaxed);
        REMOTE_DEBUG.store(false, Ordering::Relaxed);
        REMOTE_HB_S.store(0, Ordering::Relaxed);
        REMOTE_REV.store(0, Ordering::Relaxed);
        if had_control {
            REMOTE_APPLIED_MS.store(now_ms() as u64, Ordering::Relaxed);
            diag_log("info", "remote control cleared; follow local config");
        }
        return;
    }
    let rev = control["rev"].as_u64().unwrap_or(0);
    if rev > 0 && rev < prev_rev {
        // 乱序/旧响应不能把新控制回滚。
        return;
    }
    let auto = match control["auto_forward"].as_str().unwrap_or("inherit") {
        "on" => 1, "off" => 0, _ => -1,
    };
    let debug = control["debug"].as_bool().unwrap_or(false);
    let hb = control["heartbeat_s"].as_u64().unwrap_or(0);
    REMOTE_AUTO.store(auto, Ordering::Relaxed);
    REMOTE_DEBUG.store(debug, Ordering::Relaxed);
    REMOTE_HB_S.store(if (15..=300).contains(&hb) { hb } else { 0 }, Ordering::Relaxed);
    REMOTE_REV.store(rev, Ordering::Relaxed);
    let next_state = remote_auto_state();
    if prev_state != next_state || prev_debug != debug || rev != prev_rev {
        REMOTE_APPLIED_MS.store(now_ms() as u64, Ordering::Relaxed);
        diag_log("info", format!("remote control applied rev={rev} auto={next_state} debug={debug}"));
    }
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
    /// 是否开启了任意外部投递面（含服务端远程覆盖）。
    fn surface_forward(&self) -> bool {
        effective_surface_forward(self)
    }

    /// 管理身份才允许项目广播进 TUI；服务端 token 的 role 才是权威判定，
    /// 这里只做本地投递面的兜底，避免普通窗口收到旧服务端的无收件人广播。
    fn is_admin_surface(&self) -> bool {
        self.role.eq_ignore_ascii_case("admin")
    }

    /// 复制一份给线程用（Cfg 没有 derive Clone，避免改动对外结构）
    fn clone_lite(&self) -> Cfg {
        Cfg {
            cmd: self.cmd.clone(), endpoint: self.endpoint.clone(), project: self.project.clone(),
            token: self.token.clone(), agent_id: self.agent_id.clone(), role: self.role.clone(),
            dir: self.dir.clone(),
            heartbeat_s: self.heartbeat_s, exec_cmd: self.exec_cmd.clone(),
            event_cmd: self.event_cmd.clone(),
            window_app: self.window_app.clone(), window_conversation: self.window_conversation.clone(),
            window_forward: self.window_forward,
            tmux_target: self.tmux_target.clone(), tmux_forward: self.tmux_forward,
            tmux_verify: self.tmux_verify, sources: self.sources.clone(),
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
        let dir = dirs_config(map.get("config-dir").map(|s| s.as_str()));
        // 命令行优先，其次读 <状态目录>/config.json（install 写入），最后才是默认
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
        let role = map.get("role").cloned()
            .or_else(|| saved["role"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("SYNAPSE_AGENT_ROLE").ok())
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| matches!(s.as_str(), "agent" | "admin" | "observer"))
            .unwrap_or_else(|| "agent".into());
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
        let mut sources: HashMap<String, String> = HashMap::new();
        let mut src = |key: &str, cli: bool, config: bool, env: bool| {
            let v = if cli { "cli" } else if env { "env" } else if config { "config" } else { "default" };
            sources.insert(key.to_string(), v.to_string());
        };
        src("cmd", true, false, false);
        src("config_dir", map.contains_key("config-dir"), false,
            std::env::var("SYNAPSE_AGENT_DIR").ok().filter(|s| !s.trim().is_empty()).is_some());
        src("endpoint", map.contains_key("endpoint"), saved.get("endpoint").is_some(),
            std::env::var("SYNAPSE_ENDPOINT").ok().or_else(|| std::env::var("YANSHI_ENDPOINT").ok()).is_some());
        src("project", map.contains_key("project"), saved.get("project").is_some(),
            std::env::var("SYNAPSE_PROJECT").ok().or_else(|| std::env::var("YANSHI_PROJECT").ok()).is_some());
        src("token", map.contains_key("token"), saved.get("token").is_some(),
            std::env::var("SYNAPSE_TOKEN").ok().or_else(|| std::env::var("YANSHI_TOKEN").ok()).is_some());
        src("agent_id", map.contains_key("agent"), saved.get("agent_id").is_some(), false);
        src("role", map.contains_key("role"), saved.get("role").is_some(),
            std::env::var("SYNAPSE_AGENT_ROLE").ok().is_some());
        src("heartbeat_s", map.contains_key("heartbeat"), saved.get("heartbeat_s").is_some(), false);
        src("window_app", map.contains_key("app"), saved.get("window_app").is_some(), false);
        src("window_conversation",
            map.contains_key("conversation") || map.contains_key("window-conversation"),
            saved.get("window_conversation").is_some(),
            std::env::var("SYNAPSE_WINDOW_CONVERSATION").ok().is_some());
        src("window_forward", map.contains_key("window"), saved.get("window_forward").is_some(),
            std::env::var("SYNAPSE_WINDOW_FORWARD").ok().is_some());
        src("tmux_target", tmux_arg.as_deref().map(|v| !cfg_truthy(v) && !cfg_falsey(v)).unwrap_or(false),
            saved.get("tmux_target").is_some(),
            std::env::var("SYNAPSE_TMUX_TARGET").ok().filter(|s| !s.is_empty()).is_some());
        src("tmux_forward", tmux_arg.is_some(), saved.get("tmux_forward").is_some(),
            std::env::var("SYNAPSE_TMUX_FORWARD").ok().filter(|s| !s.is_empty()).is_some());
        src("tmux_verify", map.contains_key("tmux-verify"), saved.get("tmux_verify").is_some(),
            std::env::var("SYNAPSE_TMUX_VERIFY").ok().filter(|s| !s.is_empty()).is_some());
        src("exec", map.contains_key("exec"), false, false);
        src("event_cmd", map.contains_key("event-cmd"), saved.get("event_cmd").is_some(),
            std::env::var("SYNAPSE_EVENT_CMD").ok().filter(|s| !s.trim().is_empty()).is_some()
              || std::env::var("YANSHI_EVENT_CMD").ok().filter(|s| !s.trim().is_empty()).is_some());
        Cfg { cmd, endpoint, project, token, agent_id, role, exec_cmd: map.get("exec").cloned(),
              event_cmd: map.get("event-cmd").cloned().filter(|s| !s.trim().is_empty())
                .or_else(|| saved["event_cmd"].as_str().map(|s| s.to_string())
                  .filter(|s| !s.trim().is_empty()))
                .or_else(|| std::env::var("SYNAPSE_EVENT_CMD").ok()
                  .filter(|s| !s.trim().is_empty()))
                .or_else(|| std::env::var("YANSHI_EVENT_CMD").ok()
                  .filter(|s| !s.trim().is_empty())),
              heartbeat_s, dir, window_app, window_conversation, window_forward, tmux_target, tmux_forward, tmux_verify,
              sources }
    }
}

/// 解析状态目录（config.json / cursor.json / run.lock / run.state.json / 套接字都在此目录下）。
/// 优先级：--config-dir 命令行 > SYNAPSE_AGENT_DIR 环境变量 > 缺省 ~/.synapse-agent。
/// 显式覆盖时原样使用该目录（不再走 .yanshi-agent 兼容回退）；不传覆盖时与旧行为逐字一致。
/// 纯函数版便于单测：home 与两个覆盖值都由调用方传入。
fn resolve_state_dir(cli_dir: Option<&str>, env_dir: Option<&str>, home: &str) -> PathBuf {
    if let Some(d) = cli_dir.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(d);
    }
    if let Some(d) = env_dir.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(d);
    }
    let n = PathBuf::from(home).join(".synapse-agent");
    if !n.exists() && PathBuf::from(home).join(".yanshi-agent").exists() { PathBuf::from(home).join(".yanshi-agent") } else { n }
}

fn dirs_config(cli_dir: Option<&str>) -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    resolve_state_dir(
        cli_dir,
        std::env::var("SYNAPSE_AGENT_DIR").ok().as_deref(),
        &home,
    )
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

// ── 客户端实时事件：task.* / submission.* / announce 等 ──────
fn event_cursor_get(dir: &PathBuf) -> u64 {
    fs::read_to_string(dir.join("event_cursor.txt")).ok()
        .and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}
fn event_cursor_set(dir: &PathBuf, seq: u64) {
    let _ = fs::write(dir.join("event_cursor.tmp"), seq.to_string());
    let _ = fs::rename(dir.join("event_cursor.tmp"), dir.join("event_cursor.txt"));
}
fn event_epoch_get(dir: &PathBuf) -> String {
    fs::read_to_string(dir.join("event_epoch.txt")).unwrap_or_default()
}
fn event_epoch_set(dir: &PathBuf, ep: &str) {
    let _ = fs::write(dir.join("event_epoch.tmp"), ep);
    let _ = fs::rename(dir.join("event_epoch.tmp"), dir.join("event_epoch.txt"));
}

/// 事件只落本地日志/执行通知回调，绝不进入任务 WAL，也不会被 exec/窗口消费。
fn deliver_client_event(cfg: &Cfg, event: &Value) {
    if event.is_null() { return; }
    // 事件先于/独立于原始消息到达：task.done 等终态事件要立刻释放 active 锁，
    // 下一次 pump 才能把已排队的任务放进来，而不是等哪条 raw 消息补到才解锁。
    event_closes_active(cfg, event);
    let seq = event["seq"].as_u64().unwrap_or(0);
    if seq > 0 && seq > event_cursor_get(&cfg.dir) { event_cursor_set(&cfg.dir, seq); }
    let line = serde_json::to_string(event).unwrap_or_default();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true)
        .open(cfg.dir.join("events.jsonl")) {
        let _ = writeln!(f, "{line}");
    }
    if let Some(cmd) = &cfg.event_cmd {
        exec_task(cmd, &line);
    } else {
        println!("{line}");
    }
}

/// 降级轮询：与消息 /inbox 分开拉事件；事件游标独立，不消费任务消息。
fn fetch_events(cfg: &Cfg, agent: &Agent, base: &str) -> Option<Vec<Value>> {
    let mut since = event_cursor_get(&cfg.dir);
    let mut tries = 0;
    // S6：GET 幂等；chunked 中断/连接重置/5xx 时退避重试，避免一次抖动漏拉事件。
    for attempt in 0..4 {
        let url = format!("{}/p/{}/events?since={}&limit=100", base, cfg.project, since);
        let r = match agent.get(&url)
            .set("authorization", &format!("Bearer {}", cfg.token))
            .set("connection", "close")
            .call() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[events] fetch failed (attempt {}): {e}", attempt + 1);
                if attempt < 3 { thread::sleep(Duration::from_millis(600 * (attempt + 1))); }
                continue;
            }
        };
        let v: Value = match r.into_json() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[events] decode failed (attempt {}): {e}", attempt + 1);
                if attempt < 3 { thread::sleep(Duration::from_millis(600 * (attempt + 1))); }
                continue;
            }
        };
        let ep = v["epoch"].as_str().unwrap_or("").to_string();
        if tries == 0 && !ep.is_empty() && event_epoch_get(&cfg.dir) != ep {
            event_cursor_set(&cfg.dir, 0);
            event_epoch_set(&cfg.dir, &ep);
            since = 0;
            tries = 1;
            continue;
        }
        if !ep.is_empty() { event_epoch_set(&cfg.dir, &ep); }
        let events = v["events"].as_array().cloned().unwrap_or_default();
        let next = v["next_cursor"].as_u64().unwrap_or(since);
        if let Some(last) = events.last().and_then(|e| e["seq"].as_u64()) {
            event_cursor_set(&cfg.dir, last.max(next));
        } else if next > since {
            event_cursor_set(&cfg.dir, next);
        }
        return Some(events);
    }
    None
}

fn publish_events(cfg: &Cfg, agent: &Agent, base: &str) {
    if let Some(events) = fetch_events(cfg, agent, base) {
        for e in events { deliver_client_event(cfg, &e); }
    }
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

/// init 时拒绝明显的文档模板身份；返回命中的字段名。
fn init_template_field(endpoint: &str, project: &str, agent: &str, token: &str) -> Option<&'static str> {
    let ep = endpoint.trim().to_ascii_lowercase();
    if ep.contains("example.com") || ep.contains("example.org") || ep.contains("<endpoint>") {
        return Some("endpoint");
    }
    if matches!(project.trim(), "p" | "<project>" | "project" | "your-project") {
        return Some("project");
    }
    if matches!(agent.trim(), "a" | "<agent>" | "agent" | "your-agent") {
        return Some("agent");
    }
    if matches!(token.trim(), "t" | "<t>" | "<token>" | "token" | "your-token" | "...") {
        return Some("token");
    }
    None
}

/// 覆盖 config.json 前做一份同目录、600 的备份；返回备份路径。
fn backup_private_config(path: &std::path::Path) -> Result<PathBuf, String> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let base = format!("{}.bak-{}", path.display(), stamp);
    let mut backup = PathBuf::from(base);
    let mut n = 1;
    while backup.exists() {
        backup = PathBuf::from(format!("{}.bak-{}-{}", path.display(), stamp, n));
        n += 1;
    }
    fs::copy(path, &backup).map_err(|e| format!("{}: {e}", backup.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&backup, fs::Permissions::from_mode(0o600));
    }
    Ok(backup)
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

/// 任务/提醒分流：窗口客户端只对“任务”做单飞，提醒类消息可以在任务执行中插入。
/// 兼容旧管理端的 `topic=task, kind=task` 私信：没有 task_id 的不算任务。
fn task_id_of(m: &Value) -> Option<&str> {
    m["payload"]["task_id"].as_str()
        .or_else(|| m["payload"]["task"]["task_id"].as_str())
        .filter(|s| !s.is_empty())
}

fn is_work_item(m: &Value) -> bool {
    let topic = m["topic"].as_str().unwrap_or("");
    let kind = m["kind"].as_str().unwrap_or("");
    if topic != "task" || !matches!(kind, "task" | "reassigned") { return false; }
    if m["payload"]["notice"].as_bool() == Some(true) { return false; }
    m["payload"]["work_item"].as_bool() == Some(true) || task_id_of(m).is_some()
}

/// 任务正文必须点名到本 agent；旧版任务广播（to=null）不能进窗口，否则
/// 升级后旧收件箱里的历史任务会被 dispatcher 当成“当前任务”永久占住。
fn directed_to_me(cfg: &Cfg, m: &Value) -> bool {
    match &m["to"] {
        Value::String(t) => t == &cfg.agent_id,
        Value::Array(a) => a.iter().any(|x| x.as_str() == Some(cfg.agent_id.as_str())),
        _ => false,
    }
}

fn is_notice(m: &Value) -> bool {
    if m["payload"]["notice"].as_bool() == Some(true) { return true; }
    if matches!(m["kind"].as_str(), Some("notice") | Some("idle_reminder")) { return true; }
    if matches!(m["topic"].as_str(), Some("system") | Some("announce") | Some("admin")) { return true; }
    // 旧管理端把私信写成 topic=task/kind=task，但没有 task_id：它只是聊天/提醒。
    m["topic"].as_str() == Some("task") && m["kind"].as_str() == Some("task") && task_id_of(m).is_none()
}

fn is_task_lifecycle(m: &Value) -> bool {
    if m["topic"].as_str() != Some("task") { return false; }
    !matches!(m["kind"].as_str(), Some("task") | Some("reassigned")) || m["payload"]["work_item"].as_bool() == Some(false)
}

fn active_task_path(dir: &PathBuf) -> PathBuf { dir.join("active_task.json") }

fn active_task_load(dir: &PathBuf) -> Option<Value> {
    let v: Value = fs::read_to_string(active_task_path(dir)).ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    let id = v["task_id"].as_str().filter(|s| !s.is_empty())?;
    Some(json!({
        "task_id": id,
        "seq": v["seq"].as_u64().unwrap_or(0),
        "title": v["title"].as_str().unwrap_or(""),
        "since": v["since"].as_u64().unwrap_or(0),
    }))
}

fn active_task_set_id(cfg: &Cfg, id: &str, seq: u64, title: &str) {
    if id.trim().is_empty() { return; }
    let body = json!({
        "task_id": id,
        "seq": seq,
        "title": title,
        "since": now_ms(),
        "agent_id": cfg.agent_id,
    });
    atomic_write(&active_task_path(&cfg.dir), body.to_string().as_bytes());
}

fn active_task_set(cfg: &Cfg, m: &Value) {
    let Some(id) = task_id_of(m) else { return; };
    active_task_set_id(cfg, id, seq_of(m).unwrap_or(0),
                       m["payload"]["title"].as_str().unwrap_or(""));
}

fn active_task_clear(cfg: &Cfg, only: Option<&str>) {
    if let Some(id) = only {
        if let Some(cur) = active_task_load(&cfg.dir) {
            if cur["task_id"].as_str() != Some(id) { return; }
        }
    }
    let _ = fs::remove_file(active_task_path(&cfg.dir));
}

fn active_task_id(cfg: &Cfg) -> Option<String> {
    active_task_load(&cfg.dir).and_then(|v| v["task_id"].as_str().map(|s| s.to_string()))
}

fn lifecycle_task_id(m: &Value) -> Option<&str> {
    task_id_of(m).or_else(|| m["payload"]["task"]["task_id"].as_str())
}

fn event_task_id(event: &Value) -> Option<&str> {
    event["task_id"].as_str()
        .or_else(|| event["data"]["task_id"].as_str())
        .filter(|s| !s.is_empty())
}

/// 任务已结束/被收回/失败/转派时，事件帧也要释放本地 active 锁。
/// 原始 done/released 消息在 WS 抖动或 ACL 过滤时可能没进 SurfacePump；
/// 服务端“完成后才发下一条”的语义不能依赖那条消息一定到达，否则 active 会卡死。
fn event_closes_active(cfg: &Cfg, event: &Value) -> bool {
    let Some(kind) = event["type"].as_str() else { return false; };
    if !matches!(kind,
        "task.done" | "task.released" | "task.blocked" | "task.failed"
        | "task.dead_lettered" | "task.retry_scheduled" | "task.reopened"
        | "task.reclaimed" | "task.reassigned" | "task.requeued")
    {
        return false;
    }
    let Some(id) = event_task_id(event) else { return false; };
    if active_task_id(cfg).as_deref() != Some(id) { return false; }
    active_task_clear(cfg, Some(id));
    true
}

#[derive(Default, Clone)]
struct SurfaceStatus {
    active_task: Option<String>,
    active_seq: u64,
    queue_len: usize,
    state: String,
}

/// 外部投递面的单飞调度器。WS 收件线程只把消息放进这里；真正粘贴/回车由
/// run/ws 主线程或 poll 主循环做，保证同一目标同时只有一条任务在途。
struct SurfacePump {
    cfg: Cfg,
    journal: Arc<Mutex<Vec<Value>>>,
    status: Arc<Mutex<SurfaceStatus>>,
    pending: Vec<Value>,
}

impl SurfacePump {
    fn new(cfg: &Cfg, journal: Arc<Mutex<Vec<Value>>>, status: Arc<Mutex<SurfaceStatus>>) -> Self {
        let mut st = status.lock().unwrap();
        if let Some(active) = active_task_load(&cfg.dir) {
            st.active_task = active["task_id"].as_str().map(|s| s.to_string());
            st.active_seq = active["seq"].as_u64().unwrap_or(0);
            st.state = "busy".into();
        } else {
            st.state = "idle".into();
        }
        drop(st);
        SurfacePump { cfg: cfg.clone_lite(), journal, status, pending: Vec::new() }
    }

    fn push(&mut self, m: Value) {
        if self.pending.iter().any(|x| same_message(x, &m)) { return; }
        self.pending.push(m);
        self.pending.sort_by_key(|x| seq_of(x).unwrap_or(0));
        self.set_queue();
    }

    fn pending_len(&self) -> usize { self.pending.len() }

    fn set_queue(&self) {
        let mut st = self.status.lock().unwrap();
        st.queue_len = self.pending.len();
        if st.active_task.is_none() { st.state = "idle".into(); }
        else { st.state = "busy".into(); }
    }

    /// 本地 active_task.json 是跨进程的完成信号：CLI task-release / 管理侧
    /// 生命周期事件删掉它之后，dispatcher 才能放行下一条任务。
    fn refresh_active(&self) {
        let file = active_task_load(&self.cfg.dir);
        let mut st = self.status.lock().unwrap();
        match file {
            Some(v) => {
                let id = v["task_id"].as_str().unwrap_or("").to_string();
                if st.active_task.as_deref() != Some(id.as_str()) {
                    st.active_task = Some(id);
                    st.active_seq = v["seq"].as_u64().unwrap_or(0);
                }
                st.state = "busy".into();
            }
            None => {
                if st.active_task.is_some() {
                    st.active_task = None;
                    st.active_seq = 0;
                }
                st.state = "idle".into();
            }
        }
    }

    fn deliver(&mut self, m: &Value, notice_prefix: bool,
               agent: &Agent, base: &str, last_msg: &AtomicU64) -> bool {
        let mut mm = m.clone();
        if notice_prefix { mm["_surface_notice"] = json!(true); }
        let delivered = {
            let _gate = SURFACE_SEND_LOCK.lock().unwrap();
            forward_to_surface_impl(&self.cfg, &mm)
        };
        if !delivered { return false; }
        if addressed_to_me(&self.cfg, m) {
            mark_surface_delivered(&self.cfg.dir, &self.journal, m);
        }
        if let Some(seq) = seq_of(m) {
            let _ = ack_message(&self.cfg, agent, base, seq, "done",
                                &json!({"note": ack_note(&self.cfg, "run 收到（已投递）", "run 收到（receipt）")}), ack_required(m));
        }
        last_msg.store(now_ms() as u64, Ordering::Relaxed);
        true
    }

    /// 处理队列里所有现在能处理的消息；返回本轮处理条数。
    fn pump(&mut self, agent: &Agent, base: &str, last_msg: &AtomicU64) -> usize {
        let mut handled = 0usize;
        loop {
            self.refresh_active();
            let mut active = self.status.lock().unwrap().active_task.clone();
            let mut progressed = false;
            let mut idx = 0usize;
            while idx < self.pending.len() {
                let m = self.pending[idx].clone();
                let seq = seq_of(&m).unwrap_or(0);
                // 任务生命周期必须先处理：它负责清 active、删同任务的待投递项。
                if is_task_lifecycle(&m) {
                    let tid = lifecycle_task_id(&m).map(|s| s.to_string());
                    let closes = matches!(m["kind"].as_str(),
                        Some("done" | "released" | "blocked" | "open" | "reclaimed"
                             | "reassigned_away" | "reclaimed_away" | "closed"));
                    if let Some(id) = &tid {
                        if active.as_deref() == Some(id.as_str()) {
                            active_task_clear(&self.cfg, Some(id));
                            active = None;
                            let mut st = self.status.lock().unwrap();
                            st.active_task = None; st.active_seq = 0; st.state = "idle".into();
                        }
                        if closes {
                            // 已经结束/被收回的任务不能因为 WAL 里还排着就再次注进窗口。
                            self.pending.retain(|p| {
                                if same_message(p, &m) { return false; }
                                !(is_work_item(p) && task_id_of(p) == Some(id.as_str())
                                  && seq_of(p).map(|s| s <= seq).unwrap_or(true))
                            });
                            dequeue_task_messages(&self.cfg.dir, &self.journal, id, seq);
                        }
                    }
                    dequeue_message(&self.cfg.dir, &self.journal, &m);
                    // retain 可能已把当前项删掉；从头继续扫，避免下标错位。
                    progressed = true;
                    idx = 0;
                    continue;
                }

                if is_work_item(&m) {
                    if !directed_to_me(&self.cfg, &m) {
                        // 旧版广播任务没有收件人，不能当作当前任务注入。
                        dequeue_message(&self.cfg.dir, &self.journal, &m);
                        self.pending.remove(idx);
                        progressed = true;
                        continue;
                    }
                    if active.is_some() {
                        idx += 1;
                        continue;
                    }
                    if surface_was_delivered(&m) {
                        // 崩溃后恢复：消息已经上屏，不要再贴一遍；只恢复本地 active。
                        if let Some(id) = task_id_of(&m) {
                            active_task_set(&self.cfg, &m);
                            let mut st = self.status.lock().unwrap();
                            st.active_task = Some(id.to_string());
                            st.active_seq = seq;
                            st.state = "busy".into();
                            active = Some(id.to_string());
                        }
                        self.pending.remove(idx);
                        progressed = true;
                        continue;
                    }
                    if !self.deliver(&m, false, agent, base, last_msg) {
                        eprintln!("[surface] seq={seq} 任务投递失败，保留 WAL、不 ACK");
                        idx += 1;
                        continue;
                    }
                    if let Some(id) = task_id_of(&m) {
                        active_task_set(&self.cfg, &m);
                        let mut st = self.status.lock().unwrap();
                        st.active_task = Some(id.to_string());
                        st.active_seq = seq;
                        st.state = "busy".into();
                        active = Some(id.to_string());
                    }
                    // 保留 WAL 里的任务项，等生命周期事件确认完成后再删。
                    self.pending.remove(idx);
                    handled += 1;
                    progressed = true;
                    // 任务一次只能投一条；继续扫后面的提醒，但不再投任务。
                    continue;
                }

                // 非任务消息走独立 lane：只有提醒/系统通知可在任务执行中插入；
                // 普通聊天、issue/广播等一律等当前任务结束，避免任务做到一半被灌满。
                let notice = is_notice(&m);
                let mut already = surface_was_delivered(&m);
                if is_surface_noise(&self.cfg, &m) { already = true; }
                if !already && active.is_some() && !notice {
                    idx += 1;
                    continue;
                }
                if !already {
                    if !self.deliver(&m, notice && active.is_some(), agent, base, last_msg) {
                        eprintln!("[surface] seq={seq} 提醒投递失败，保留 WAL、不 ACK");
                        idx += 1;
                        continue;
                    }
                } else if let Some(s) = seq_of(&m) {
                    let _ = ack_message(&self.cfg, agent, base, s, "done",
                                        &json!({"note": "run 外部投递过滤（非本窗口消息）"}), ack_required(&m));
                }
                dequeue_message(&self.cfg.dir, &self.journal, &m);
                self.pending.remove(idx);
                handled += 1;
                progressed = true;
            }
            self.set_queue();
            if !progressed { break; }
        }
        handled
    }
}

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
    // 事件通知（task.queued/task.created）和交付记录不是任务正文，不能交给 exec/窗口。
    if m["payload"]["work_item"].as_bool() == Some(false) { return true; }
    if matches!(m["topic"].as_str(), Some("submission") | Some("artifact")) { return true; }
    if m["sender"].as_str() == Some(cfg.agent_id.as_str())
        && std::env::var("SYNAPSE_INCLUDE_SELF").ok().as_deref() != Some("1")
    {
        // release/claim 等任务生命周期事件由 agent 自己落库，sender 就是自己。
        // 不能被“过滤自发消息”挡掉，否则窗口永远不知道自己已完成，active 锁死。
        if is_task_lifecycle(m) && task_id_of(m).is_some() { return false; }
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
        // kind=task 是管理员下发的任务正文，kind=reassigned 是带完整正文的
        // 管理员转派事件（payload 里同样有 task_id/title/body），两者都必须进窗口。
        // 其余 task 生命周期事件才过滤。
        (m["topic"].as_str() == Some("task")
            && m["kind"].as_str() != Some("task")
            && m["kind"].as_str() != Some("reassigned"))
}

/// 外部投递（窗口/tmux）只接“点名给本 agent 的消息”和管理端 announce 广播；
/// 管理身份额外接全部项目广播。
///
/// 服务端为了管理台能看到完整台账，会把其他 agent 的 artifact 建单、任务
/// claimed/released/done、issue 生命周期和部分 report 都写成 `to=null` 的项目广播。
/// 普通 agent 的 `for_me` 已拒绝这些无收件人消息（管理端 announce 除外）；这里再做
/// 窗口侧兜底，避免旧服务端或 WAL 里遗留的项目广播进入 TUI：
/// - artifact：交付箱事件，属于管理台，不是聊天指令；
/// - task 生命周期：不是任务正文；
/// - 普通 agent 发出的无收件人广播：不进其他普通 agent 的 TUI；
/// - 管理端 announce：按原协议广播给全员；管理面可收全部。
fn is_admin_announce(m: &Value) -> bool {
    m["sender"].as_str() == Some("admin") && m["topic"].as_str() == Some("announce")
}

fn is_surface_noise(cfg: &Cfg, m: &Value) -> bool {
    if is_noise(cfg, m) || is_task_notice(m) || !addressed_to_me(cfg, m) {
        return true;
    }
    if m["topic"].as_str() == Some("artifact") {
        return true;
    }
    // 普通 agent 自己发出的无收件人广播（issue/report/status…）不进窗口；
    // 管理端 announce 仍按原协议向全员下发。管理面则可收全部广播。
    if m["to"].is_null() && !cfg.is_admin_surface() && !is_admin_announce(m) {
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
    // 任务消息额外带 [task:<id>]，既让 agent 能直接 --task 提交，也让窗口里
    // 一眼能区分“任务”和“执行中的提醒”。
    let mut tags = String::new();
    if let Some(s) = seq_of(m) { tags.push_str(&format!("[Synapse #{s}] ")); }
    if is_work_item(m) {
        if let Some(id) = task_id_of(m) { tags.push_str(&format!("[task:{id}] ")); }
    }
    if m["_surface_notice"].as_bool() == Some(true) {
        tags.push_str("[提醒，不是新任务] ");
    }
    let mut text = String::new();
    if !title.trim().is_empty() {
        text.push_str(title.trim());
        if !body.trim().is_empty() { text.push('\n'); }
    }
    text.push_str(body.trim());
    Some(format!("{tags}{text}"))
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
    if !effective_surfaces(cfg).1 || is_surface_noise(cfg, m) {
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
    let (window, tmux) = effective_surfaces(cfg);
    if !window && !tmux {
        return true;
    }
    delivery_attempt();
    let ok = if tmux {
        forward_to_tmux_impl(cfg, m)
    } else {
        forward_to_window_impl(cfg, m)
    };
    if !ok {
        delivery_result(false, Some(format!("{} 投递失败 seq={}", surface_kind(cfg),
                                            seq_of(m).unwrap_or(0))));
    } else {
        delivery_result(true, None);
        diag_log("debug", format!("delivered seq={}", seq_of(m).unwrap_or(0)));
    }
    ok
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
    if !effective_surfaces(cfg).0 || is_surface_noise(cfg, m) {
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
        // 无收件人的项目广播：普通 agent 只接管理端 announce；普通 agent 自己发的
        // issue/report/status 广播不进其他普通 agent 的 TUI，避免绕过任务单飞刷屏。
        Value::Null => cfg.is_admin_surface() || is_admin_announce(m),
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

/// 任务完成/收回时删掉 WAL 里该任务已投递的项；未投递的排队消息由 server
/// 队列管理，不在客户端重复保留。
fn dequeue_task_messages(dir: &PathBuf, journal: &Arc<Mutex<Vec<Value>>>,
                          task_id: &str, max_seq: u64) {
    let mut items = journal.lock().unwrap();
    // 只删生命周期事件之前的旧派单：任务被拒收重开时，服务端会先发 open
    // 再发新的 task-dispatch；新消息 seq 更大，不能被旧 open/done 一起删掉。
    items.retain(|x| !(task_id_of(x) == Some(task_id)
        && seq_of(x).map(|s| s <= max_seq).unwrap_or(true)));
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
        println!("synapse-agent {}\n\n基础用法:\n  synapse-agent init --endpoint <url> --project <p> --token <t> [--agent <id>] [--force 1]\n  synapse-agent run  [--exec \"cmd\"] [--event-cmd \"cmd\"] [--window 1 | --tmux <target|1|0>] [--proxy <url>|off]\n        --window 1：Windows 收件后先切到 window_conversation 会话再注入 window_app 窗口，UIA/剪贴板验证成功才 ACK。\n        --conversation <标题>：临时指定目标会话标题（特殊标记）；默认用 config.json 的 window_conversation。\n        --tmux <target|1|0>：Linux/macOS 收件后注入 tmux pane（如 %3 或 agent:0.0），看到 [Synapse #seq] 才 ACK；\n                          --tmux 1 使用 tmux-config 保存的目标，--tmux 0 关闭本次投递。\n        代理：默认先探测直连，直连不可用才使用 HTTPS_PROXY/ALL_PROXY 环境代理；--proxy <url> 强制代理，--proxy off 强制直连；NO_PROXY 命中直连。\n  synapse-agent status | whoami | restore [--backup <file>]\n  synapse-agent wait | peek | profile | subs [--mine] | sub-withdraw --submission <id> | get\n  synapse-agent agents | send | broadcast                  # 需 admin token\n  synapse-agent issue --title <t> [--body <s>|--body-file <path>] [--priority low|normal|high|urgent] [--labels <s>] [--self]\n        --self：上报的同时转成 reporter 自己的任务；也可稍后用 issue-take --issue <id> 转换。\n  synapse-agent issue-take --issue <id>                      # reporter 把本人 open Issue 转成自己的任务\n  synapse-agent issues [--status open|closed|merged] [--limit N]  # 需 admin token
  synapse-agent upgrade [--apply 1] [--platform <tag>]   # 按当前平台选包；默认只检查；升级后首次 run 自动刷新 /ver → /capabilities → /skill\n  init 覆盖已有 config.json 时先写 config.json.bak-<时间>（600）；文档模板值直接拒绝；换 token 需 --force 1。\n\n单机多身份（同一用户同时跑两个 synapse-agent 身份）:\n  所有子命令都可用 --config-dir <路径> 指定状态目录（config.json / cursor.json / run.lock /\n  run.state.json / 本机总线套接字都在该目录下）；也可用环境变量 SYNAPSE_AGENT_DIR 指定。\n  优先级：--config-dir > SYNAPSE_AGENT_DIR > 缺省 ~/.synapse-agent。\n  例：synapse-agent init --config-dir ~/.synapse-agent-2 --endpoint <url> --project <p> --token <t> --agent <id2>\n      synapse-agent run  --config-dir ~/.synapse-agent-2\n  不传覆盖时行为与旧版完全一致；不同目录的实例互不影响，同目录仍只允许一个 run 常驻。\n\n交付（upload/submit 已补齐，deliver 为回合制 agent 一次调用完成）:\n  synapse-agent upload --file <path>                       # 直传 R2，输出 ref\n  synapse-agent submit --kind patch --title <t> --ref <sha>[:<name>] [--ref ...] \\\n                        [--base-sha <sha>] [--checks <json字符串>] [--notes <s>]\n  synapse-agent deliver --file <path> --kind patch --title <t> [--base-sha <sha>]\n\nLinux/macOS tmux 投递（TUI）:\n  synapse-agent tmux-config --target <session:window.pane>  ★设置默认 pane 并开启（如 %3 或 agent:0.0）\n        tmux-config [--show|--clear] 查看/清除；tmux-config --enable 0 只关开关。\n        tmux-config --verify 0 关闭标记验证：alternate-screen TUI（CodeBuddy/Claude）不回显注入文字，\n                           用 0 改为注入即 ACK，避免标记读不到导致 WAL 每 5 秒重投、同一条消息反复粘贴。\n        也可用环境变量 SYNAPSE_TMUX_TARGET / SYNAPSE_TMUX_FORWARD=1 / SYNAPSE_TMUX_VERIFY=0 临时覆盖。\n  synapse-agent tmux-list                                     # 列出所有 pane，找 TUI 目标\n  synapse-agent tmux-send --target <...> (--text <文字>|--file <文件>|--stdin) [--enter 1] [--verify 1]\n        向 pane 注入文字并回车；--verify 1 用正文里的 [Synapse #seq] 标记验证。\n  synapse-agent run --tmux <target|1|0>                       # 收件后注入配置的 TUI pane，成功才 ACK\n\n本地窗口桥（Windows）:\n  synapse-agent win-config --app <应用名> --conversation <特殊标题标记>\n        ★设置默认目标与会话，写入 config.json（如 win-config --app 豆包 --conversation “◆dou-win-133”）\n        win-config [--show|--clear] 查看/清除默认目标与会话。设置后 win-send/win-read/bridge/run --window 1 自动使用。\n        也可用环境变量 SYNAPSE_WINDOW_APP / SYNAPSE_WINDOW_CONVERSATION 临时覆盖。\n  synapse-agent win-list [--app <应用名>] [--match <标题子串>]\n  synapse-agent uia-dump [--app <应用名>]    # 输出 UIA 控件树，用于排查 composer/输入框定位\n        发现窗口。--app 豆包 会按进程名自动找到豆包窗口（推荐，无需手输标题）。\n  synapse-agent win-send (--app <应用名> | --title <子串>) (--text <文字> | --file <UTF-8文件> | --stdin) [--enter 1] [--verify 1] [--method click|paste|copy|both]\n        向目标窗口发送文字。--app 时自动发现进程与窗口；默认 click=点击输入框再粘贴（对 Electron 豆包最稳，支持中文）。\n        ★发代码 / patch 请用 --file <文件> 或 --stdin（type p.patch | ... --stdin）：整段读 UTF-8，绕开命令行 32767 字符上限与转义。\n        --text / --file / --stdin 三选一（同时给时按此优先级取非空）。\n  synapse-agent win-read (--app <应用名> | --title <子串>) [--diff] [--no-restore]\n        读取目标窗口文本；--diff 输出相对上次的新增行（用于提取“新消息”）。\n  synapse-agent win-bridge --title <子串> --mode in|out [--name <管道名>]\n        把窗口对接到本机消息总线：in=窗口新消息读入总线；out=总线消息写入窗口。\n\n本机消息总线:\n  synapse-agent bus-serve [--name <管道名>]\n        常驻监听命名管道，逐条打印收到的 JSON Lines 消息（供配置程序/agent 读取）。\n  synapse-agent bus-send (--text <文字> | --file <UTF-8文件> | --stdin) [--dir in|out] [--topic <t>] [--sender <s>] [--name <管道名>]\n        向本机消息总线投递一条消息。发长文本同样推荐 --file / --stdin。\n  synapse-agent bridge --title <子串> [--name <管道名>] [--poll 3] [--hub 1|0]\n        一站式桥接：窗口↔总线↔Hub（需已 init）。--hub 1 时窗口新消息会 publish 到 Hub。", env!("CARGO_PKG_VERSION"));
        return;
    }
    if argv.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let cfg = Cfg::from_args();
    load_error_outbox(&cfg.dir);
    {
        std::panic::set_hook(Box::new(|info| {
            record_client_error("panic", info.to_string(), Some("rust panic hook".into()));
        }));
    }
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

    // 能力发现先于收件：升级后的新二进制先读 /ver，按 hash 拉 /capabilities + /skill，
    // 并把结果落到状态目录。失败只提示，不阻塞 run/wait。
    refresh_discovery_on_start(&cfg, &agent, &base);

    // 两态机器（与 Python Loop / TS Loop 等价）：
    //   busy: 正常运行（本进程在干活），心跳照常
    //   idle: `wait` 阻塞等一条指令；`peek` 非阻塞看一眼
    match cfg.cmd.as_str() {
        "init" => {
            if cfg.token.is_empty() { eprintln!("init 需要 --token"); std::process::exit(2); }
            let path = cfg.dir.join("config.json");
            let force = args_map.get("force").map(|v| cfg_truthy(v)).unwrap_or(false)
                || flags.contains("force");
            // 模板值一旦落盘就是不可逆的身份丢失：服务端只存 token_sha，本地没有明文。
            // 因此 example.com / p / a / t 这组文档示例直接拒绝，--force 也不放行。
            if let Some(field) = init_template_field(&cfg.endpoint, &cfg.project, &cfg.agent_id, &cfg.token) {
                eprintln!("✗ 检测到 init 模板值（{field}）；拒绝覆盖配置。请填入真实 endpoint/project/agent/token。");
                std::process::exit(2);
            }
            let old: Value = fs::read_to_string(&path).ok()
                .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
            let old_token = old["token"].as_str().unwrap_or("").trim().to_string();
            if !old_token.is_empty() && old_token != cfg.token && !force {
                eprintln!("✗ 已存在 {} 的配置（token 与本次不同）；为避免误覆盖，需显式加 --force 1。", cfg.agent_id);
                eprintln!("  旧配置不会被改写；确认要轮换请重跑并加 --force 1（会先自动备份）。");
                std::process::exit(2);
            }
            let backup = if path.exists() {
                match backup_private_config(&path) {
                    Ok(p) => Some(p),
                    Err(e) => { eprintln!("✗ 覆盖前备份失败，已中止：{e}"); std::process::exit(1); }
                }
            } else { None };
            let prof = crate::profile::detect();
            let hb = args_map.get("heartbeat").and_then(|s| s.parse::<u64>().ok())
                .or_else(|| prof["heartbeat_s"].as_u64()).unwrap_or(cfg.heartbeat_s);
            // 保留 notify_cmd/tmux/window 等本地配置，不能因为一次 init 把投递面清空。
            let mut body = old.as_object().cloned().unwrap_or_default();
            body.insert("endpoint".into(), json!(cfg.endpoint));
            body.insert("project".into(), json!(cfg.project));
            body.insert("agent_id".into(), json!(cfg.agent_id));
            body.insert("token".into(), json!(cfg.token));
            body.insert("role".into(), json!(cfg.role));
            body.insert("heartbeat_s".into(), json!(hb));
            body.insert("runtime".into(), prof["runtime"].clone());
            body.insert("host".into(), prof["host"].clone());
            body.insert("transport".into(), prof["transport"].clone());
            let body = Value::Object(body);
            if let Err(e) = write_private_json(&path, &body) {
                eprintln!("落盘配置失败：{e}"); std::process::exit(1);
            }
            println!("✓ 已初始化 project={} agent={}", cfg.project, cfg.agent_id);
            println!("  运行环境：{}/{}，默认传输 {}，心跳 {}s", prof["runtime"].as_str().unwrap_or("generic"),
                     prof["host"].as_str().unwrap_or("local"), prof["transport"].as_str().unwrap_or("ws"), hb);
            if let Some(p) = backup {
                println!("  覆盖前备份：{}（600）", p.display());
            }
            println!("  配置：{}（600）", path.display());
            return;
        }
        "restore" | "restore-config" => {
            let file = args_map.get("backup").cloned().map(PathBuf::from).or_else(|| {
                fs::read_dir(&cfg.dir).ok().into_iter().flatten().flatten()
                    .filter_map(|e| {
                        let p = e.path();
                        let name = p.file_name()?.to_string_lossy().to_string();
                        name.starts_with("config.json.bak-").then_some(p)
                    })
                    .max_by(|a, b| a.file_name().cmp(&b.file_name()))
            });
            let Some(src) = file else { eprintln!("没有可恢复的 config.json.bak-* 备份"); std::process::exit(2); };
            let body: Value = fs::read_to_string(&src).ok().and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}));
            if body["token"].as_str().unwrap_or("").trim().is_empty() {
                eprintln!("✗ 备份没有 token：{}", src.display()); std::process::exit(2);
            }
            let path = cfg.dir.join("config.json");
            if path.exists() {
                match backup_private_config(&path) {
                    Ok(p) => println!("  当前配置已备份：{}", p.display()),
                    Err(e) => { eprintln!("✗ 恢复前备份失败，已中止：{e}"); std::process::exit(1); }
                }
            }
            if let Err(e) = write_private_json(&path, &body) {
                eprintln!("✗ 恢复失败：{e}"); std::process::exit(1);
            }
            println!("✓ 已恢复 {} -> {}", src.display(), path.display());
            println!("  project={} agent={}", body["project"].as_str().unwrap_or("?"),
                     body["agent_id"].as_str().unwrap_or("?"));
            println!("  下一步：synapse-agent whoami  # 核 token 真身");
            return;
        }
        "whoami" => {
            match admin_get(&cfg, &agent, &base, &format!("/p/{}/whoami", cfg.project)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("whoami 失败：{e}"); std::process::exit(1); }
            }
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
                "event_cursor": event_cursor_get(&cfg.dir),
                "event_cmd": cfg.event_cmd,
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
                                mark_upgrade_pending(&cfg, &mine, &latest, &platform);
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
                                    Ok(_) => {
                                        // 二次兜底：某些文件系统/umask 可能在 rename 后落成 0644，
                                        // 这里再按当前文件自身权限补执行位，避免下次启动 Permission denied。
                                        if let Err(e) = ensure_executable(&current) {
                                            eprintln!("替换后补可执行位失败：{e}；新二进制已写入但可能无法启动");
                                            std::process::exit(5);
                                        }
                                        // 新进程首次 run/init 读到该标记后，会重拉
                                        // /ver → /capabilities → /skill，而不是只看 --help。
                                        mark_upgrade_pending(&cfg, &mine, &latest, &platform);
                                        println!("{}", json!({"ok": true, "from": mine, "to": latest,
                                                                  "platform": platform, "bytes": b.len()}))
                                    }
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
            let mine = flags.contains("mine") || args_map.get("mine").map(|v| cfg_truthy(v)).unwrap_or(false);
            let mut qs: Vec<String> = Vec::new();
            if !state.is_empty() { qs.push(format!("state={state}")); }
            if mine { qs.push("mine=1".into()); }
            let q = if qs.is_empty() { String::new() } else { format!("?{}", qs.join("&")) };
            // 交付只读走数据面：/x/admin 只认 admin token，普通 agent 永远 403
            // （ISS-MWSZPB49-B96120）；服务端已对项目 agent 开放 GET /p/<proj>/submissions。
            match admin_get(&cfg, &agent, &base, &format!("/p/{}/submissions{}", cfg.project, q)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("subs 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "sub-withdraw" | "submission-withdraw" => {
            let sid = args_map.get("submission").or_else(|| args_map.get("sid"))
                .cloned().unwrap_or_default().trim().to_string();
            if sid.is_empty() { eprintln!("sub-withdraw 需要 --submission <id>"); std::process::exit(2); }
            match admin_post(&cfg, &agent, &base,
                             &format!("/p/{}/submissions/{}/withdraw", cfg.project, urlencode(&sid)), json!({})) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("sub-withdraw 失败：{e}"); std::process::exit(1); }
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
        "claim-next" | "task-claim-next" => {
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/claim-next", cfg.project), json!({})) {
                Ok(v) => {
                    if let Some(id) = v["task_id"].as_str() {
                        let seq = v["task"]["seq"].as_u64().or_else(|| v["seq"].as_u64()).unwrap_or(0);
                        let title = v["task"]["title"].as_str().unwrap_or("");
                        active_task_set_id(&cfg, id, seq, title);
                    }
                    println!("{}", serde_json::to_string(&v).unwrap_or_default());
                }
                Err(e) => { eprintln!("claim-next 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "task-claim" => {
            let id = args_map.get("task").or_else(|| args_map.get("task-id")).cloned().unwrap_or_default();
            if id.trim().is_empty() { eprintln!("task-claim 需要 --task <id>"); std::process::exit(2); }
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/claim", cfg.project),
                             json!({ "task_id": id })) {
                Ok(v) => {
                    let claimed = v["task"]["task_id"].as_str()
                        .or_else(|| v["task_id"].as_str()).unwrap_or(&id);
                    let seq = v["task"]["seq"].as_u64().or_else(|| v["seq"].as_u64()).unwrap_or(0);
                    let title = v["task"]["payload"]["title"].as_str()
                        .or_else(|| v["task"]["title"].as_str()).unwrap_or("");
                    active_task_set_id(&cfg, claimed, seq, title);
                    println!("{}", serde_json::to_string(&v).unwrap_or_default());
                }
                Err(e) => { eprintln!("task-claim 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "task-release" => {
            let id = args_map.get("task").or_else(|| args_map.get("task-id"))
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .or_else(|| active_task_id(&cfg)).unwrap_or_default();
            if id.trim().is_empty() { eprintln!("task-release 需要 --task <id>，或先 claim 写入 active_task.json"); std::process::exit(2); }
            let state = args_map.get("state").cloned().unwrap_or_else(|| "done".into());
            if !["done", "open", "blocked"].contains(&state.as_str()) {
                eprintln!("task-release --state 只能是 done|open|blocked"); std::process::exit(2);
            }
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/release", cfg.project),
                             json!({ "task_id": id, "state": state })) {
                Ok(v) => {
                    active_task_clear(&cfg, Some(&id));
                    println!("{}", serde_json::to_string(&v).unwrap_or_default());
                }
                Err(e) => { eprintln!("task-release 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "task-fail" => {
            let id = args_map.get("task").or_else(|| args_map.get("task-id"))
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .or_else(|| active_task_id(&cfg)).unwrap_or_default();
            if id.trim().is_empty() { eprintln!("task-fail 需要 --task <id>，或先 claim 写入 active_task.json"); std::process::exit(2); }
            let error = args_map.get("error").or_else(|| args_map.get("reason"))
                .cloned().unwrap_or_else(|| "task_failed".into());
            let retryable = args_map.get("retryable").map(|s| s != "false" && s != "0").unwrap_or(true);
            match admin_post(&cfg, &agent, &base, &format!("/p/{}/tasks/fail", cfg.project),
                             json!({ "task_id": id, "error": error, "retryable": retryable })) {
                Ok(v) => {
                    active_task_clear(&cfg, Some(&id));
                    println!("{}", serde_json::to_string(&v).unwrap_or_default());
                }
                Err(e) => { eprintln!("task-fail 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "submit" => {
            let kind = args_map.get("kind").cloned().unwrap_or_else(|| "patch".into());
            let title = args_map.get("title").cloned().unwrap_or_default();
            let base_sha = args_map.get("base-sha").cloned();
            let notes = args_map.get("notes").cloned().unwrap_or_default();
            let sid = args_map.get("sid").cloned();
            let task = args_map.get("task").or_else(|| args_map.get("task-id"))
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .or_else(|| active_task_id(&cfg));
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
            let task = args_map.get("task").or_else(|| args_map.get("task-id"))
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                .or_else(|| active_task_id(&cfg));
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
                "state": sub["state"], "seq": sub["seq"], "next": sub["next"]
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
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.dir, &cfg.agent_id));
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
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.dir, &cfg.agent_id));
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
                .unwrap_or_else(|| localbus::endpoint_name(&cfg.dir, &cfg.agent_id));
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

// ── 客户端能力发现：/ver → /capabilities → /skill ───────────────
// 升级二进制本身不会让 agent 知道服务端新增了什么。这里在 run/init 首次启动
// 时做一次带超时的公开 discovery，按 hash 缓存，避免每次重启重发整份 skill。

#[derive(Clone, Debug)]
struct SkillNotice {
    key: String,
    text: String,
}

fn discovery_path(cfg: &Cfg) -> PathBuf { cfg.dir.join("discovery.json") }
fn upgrade_pending_path(cfg: &Cfg) -> PathBuf { cfg.dir.join("upgrade-pending.json") }
fn skill_cache_path(cfg: &Cfg) -> PathBuf { cfg.dir.join("SKILL.md") }
fn caps_cache_path(cfg: &Cfg) -> PathBuf { cfg.dir.join("capabilities.json") }
fn whats_new_path(cfg: &Cfg) -> PathBuf { cfg.dir.join("WHATS-NEW.md") }

fn read_json_file(path: &PathBuf) -> Value {
    fs::read_to_string(path).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn capability_ids(v: &Value) -> Vec<String> {
    v["capabilities"].as_array().map(|a| {
        a.iter().filter_map(|c| {
            c["id"].as_str().or_else(|| c.as_str()).map(|s| s.to_string())
        }).collect()
    }).unwrap_or_default()
}

fn discovery_due(cfg: &Cfg) -> bool {
    if upgrade_pending_path(cfg).exists() || !discovery_path(cfg).exists() {
        return true;
    }
    let d = read_json_file(&discovery_path(cfg));
    let fetched = d["fetched_at"].as_u64().unwrap_or(0);
    let now = now_ms() as u64;
    fetched == 0 || now.saturating_sub(fetched) > 6 * 60 * 60 * 1000
}

fn discovery_get(agent: &Agent, base: &str, path: &str) -> Result<Value, String> {
    agent.get(&format!("{}{}", base, path))
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.into_json::<Value>().map_err(|e| format!("{e}")))
}

fn discovery_bytes(agent: &Agent, base: &str, path: &str) -> Result<Vec<u8>, String> {
    let r = agent.get(&format!("{}{}", base, path))
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("{e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    r.into_reader().read_to_end(&mut buf).map_err(|e| format!("{e}"))?;
    Ok(buf)
}

fn refresh_discovery(cfg: &Cfg, agent: &Agent, base: &str) -> Result<Option<SkillNotice>, String> {
    let ver = discovery_get(agent, base, "/ver")?;
    let build = ver["build"].as_str().unwrap_or("").to_string();
    let sdk = ver["sdk"].as_str().unwrap_or("").to_string();
    let skill_sha = ver["skill_sha256"].as_str().unwrap_or("").to_string();
    let caps_sha = ver["capabilities_sha256"].as_str().unwrap_or("").to_string();
    let ver_ids = capability_ids(&ver);
    let old = read_json_file(&discovery_path(cfg));
    let old_ids = old["capability_ids"].as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_default();
    let old_skill_sha = old["skill_sha256"].as_str().unwrap_or("").to_string();
    let old_caps_sha = old["capabilities_sha256"].as_str().unwrap_or("").to_string();
    let caps_changed = if !caps_sha.is_empty() {
        old_caps_sha != caps_sha
    } else {
        old_ids != ver_ids
    };
    let skill_changed = if !skill_sha.is_empty() {
        old_skill_sha != skill_sha
    } else {
        !skill_cache_path(cfg).exists()
    };
    if !caps_changed && !skill_changed {
        return Ok(None);
    }

    // /capabilities 是程序判定面；旧服务端没有该端点时仍保留 /ver 的 ID 列表。
    let caps = discovery_get(agent, base, "/capabilities")
        .unwrap_or_else(|_| json!({"sdk": sdk, "build": build, "capabilities": ver_ids.clone()}));
    let skill = discovery_bytes(agent, base, "/skill")?;
    let new_ids = capability_ids(&caps);
    let added: Vec<String> = new_ids.iter()
        .filter(|id| !old_ids.contains(id)).cloned().collect();
    let removed: Vec<String> = old_ids.iter()
        .filter(|id| !new_ids.contains(id)).cloned().collect();
    let effective_skill_sha = if skill_sha.is_empty() { sha256_hex(&skill) } else { skill_sha };
    let effective_caps_sha = if caps_sha.is_empty() {
        sha256_hex(serde_json::to_string(&caps).unwrap_or_default().as_bytes())
    } else { caps_sha };
    let key = format!("{build}:{effective_caps_sha}:{effective_skill_sha}");
    let changed = match (added.is_empty(), removed.is_empty()) {
        (false, false) => format!("新增 {}；移除 {}", added.join(", "), removed.join(", ")),
        (false, true) => format!("新增 {}", added.join(", ")),
        (true, false) => format!("移除 {}", removed.join(", ")),
        (true, true) => "能力表内容有更新（status/summary 可能变化）".to_string(),
    };
    let notice_text = format!(
        "[Synapse 能力更新] build={build} sdk={sdk}；{changed}。完整说明已缓存到 {}；请按 /capabilities 的能力 ID 核对，不要只看 --help。",
        skill_cache_path(cfg).display()
    );

    atomic_write(&skill_cache_path(cfg), &skill);
    atomic_write(&caps_cache_path(cfg),
                 serde_json::to_vec_pretty(&caps).unwrap_or_default().as_slice());
    let discovery = json!({
        "endpoint": cfg.endpoint, "build": build, "sdk": sdk,
        "capability_ids": new_ids, "capabilities_sha256": effective_caps_sha,
        "skill_sha256": effective_skill_sha, "fetched_at": now_ms(),
        "notice_key": key, "notice_text": notice_text,
        "noticed_key": old["noticed_key"].clone(),
    });
    atomic_write(&discovery_path(cfg),
                 serde_json::to_vec_pretty(&discovery).unwrap_or_default().as_slice());

    let mut whats_new = vec![
        "# Synapse 能力更新".to_string(),
        String::new(),
        format!("- build: {build}"),
        format!("- sdk: {sdk}"),
    ];
    if !added.is_empty() { whats_new.push(format!("- 新增: {}", added.join(", "))); }
    if !removed.is_empty() { whats_new.push(format!("- 移除: {}", removed.join(", "))); }
    whats_new.push(String::new());
    whats_new.push("完整说明见同目录 SKILL.md；程序判定见 capabilities.json。".to_string());
    atomic_write(&whats_new_path(cfg), whats_new.join("\n").as_bytes());

    Ok(Some(SkillNotice { key, text: notice_text }))
}

fn announce_discovery(cfg: &Cfg, notice: SkillNotice) -> bool {
    let mut d = read_json_file(&discovery_path(cfg));
    if d["noticed_key"].as_str() == Some(notice.key.as_str()) {
        return true;
    }
    if cfg.surface_forward() {
        // 这不是任务：to=本 agent、kind=notice、work_item=true；只投递一次，不 ack/claim。
        let m = json!({
            "topic": "system", "kind": "notice", "sender": "admin", "to": cfg.agent_id,
            "payload": {"title": "Synapse 能力更新", "body": notice.text, "work_item": true}
        });
        if !forward_to_surface(cfg, &m) {
            eprintln!("[discovery] 能力更新通知投递失败，保留到下次 run 重试");
            return false;
        }
    } else {
        eprintln!("{}", notice.text);
    }
    d["noticed_key"] = json!(notice.key);
    d["noticed_at"] = json!(now_ms());
    atomic_write(&discovery_path(cfg),
                 serde_json::to_vec_pretty(&d).unwrap_or_default().as_slice());
    true
}

fn mark_upgrade_pending(cfg: &Cfg, from: &str, to: &str, platform: &str) {
    atomic_write(&upgrade_pending_path(cfg),
                 serde_json::to_vec_pretty(&json!({
                     "from": from, "to": to, "platform": platform, "at": now_ms()
                 })).unwrap_or_default().as_slice());
}

fn refresh_discovery_on_start(cfg: &Cfg, agent: &Agent, base: &str) {
    let _ = fs::create_dir_all(&cfg.dir);
    let due = matches!(cfg.cmd.as_str(), "run" | "ws" | "init")
        || (matches!(cfg.cmd.as_str(), "wait" | "peek") && discovery_due(cfg));
    if !due { return; }
    match refresh_discovery(cfg, agent, base) {
        Ok(Some(n)) => {
            if announce_discovery(cfg, n) {
                let _ = fs::remove_file(upgrade_pending_path(cfg));
            }
        }
        Ok(None) => {
            // 上次通知投递失败时，refresh 不会再返回 Some（hash 未变），
            // 但 discovery.json 里还留着未送达的 notice_key/notice_text。
            let d = read_json_file(&discovery_path(cfg));
            let pending_key = d["notice_key"].as_str().unwrap_or("");
            let noticed_key = d["noticed_key"].as_str().unwrap_or("");
            let pending_text = d["notice_text"].as_str().unwrap_or("");
            if !pending_key.is_empty() && pending_key != noticed_key && !pending_text.is_empty() {
                let announced = announce_discovery(cfg, SkillNotice {
                    key: pending_key.to_string(), text: pending_text.to_string(),
                });
                if !announced { return; }
            }
            let _ = fs::remove_file(upgrade_pending_path(cfg));
        }
        Err(e) => eprintln!("[discovery] 能力发现失败，继续用本地缓存：{e}"),
    }
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
            if status >= 400 { return Err(format!("upload HTTP {status}: {}", text.chars().take(1200).collect::<String>())); }
            Ok(json!({
                "sha256": sha, "name": name, "bytes": data.len(),
                "ref": {"sha256": sha, "name": name},
                "stored": j.and_then(|v| v["stored"].as_bool()).unwrap_or(true)
            }))
        }
        Err(ureq::Error::Status(code, r)) => {
            let (_, text, _) = resp_parts(r);
            Err(format!("upload HTTP {code}: {}", text.chars().take(1200).collect::<String>()))
        }
        Err(e) => Err(format!("upload 失败: {e}")),
    }
}

/// 由内容生成稳定 submission_id：超时重试命中同一条交付，不会生成重复提交。
fn new_submission_id(agent_id: &str, kind: &str, title: &str, base: &str, refs: &[Value], task_id: Option<&str>) -> String {
    let clean: String = agent_id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':' { c } else { '-' })
        .collect();
    let seed = json!({
        "agent": agent_id, "kind": kind, "title": title, "base": base, "task": task_id.unwrap_or(""),
        "refs": refs.iter().map(|r| r["sha256"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>()
    });
    let hash = Sha256::digest(seed.to_string().as_bytes());
    format!("sub-{}-{}", clean, hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string())
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
        "submission_id": sid.map(|s| s.to_string()).unwrap_or_else(|| new_submission_id(
            &cfg.agent_id,
            if kind.is_empty() { "patch" } else { kind },
            title, &sha, &refs, task_id)),
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
            if status >= 400 { return Err(format!("submit HTTP {status}: {}", text.chars().take(1200).collect::<String>())); }
            Ok(j.unwrap_or(body))
        }
        Err(ureq::Error::Status(code, r)) => {
            let (_, text, _) = resp_parts(r);
            Err(format!("submit HTTP {code}: {}", text.chars().take(1200).collect::<String>()))
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
    // 只继承普通权限位，不把旧二进制的 setuid/setgid/sticky 位复制到刚下载的新文件。
    let mode = fs::metadata(current).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o755);
    fs::set_permissions(tmp, fs::Permissions::from_mode(mode | 0o111))
}

/// 按文件自身权限补执行位；用于 rename 后的二次兜底。
#[cfg(not(windows))]
fn ensure_executable(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o755);
    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o111))
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

fn surface_kind(cfg: &Cfg) -> &'static str {
    let (window, tmux) = effective_surfaces(cfg);
    if window { "window" } else if tmux { "tmux" } else { "none" }
}

fn surface_target(cfg: &Cfg) -> String {
    let (window, tmux) = effective_surfaces(cfg);
    if window { cfg.window_app.clone() }
    else if tmux { cfg.tmux_target.clone() }
    else { String::new() }
}

/// 启动现场只采集一次：参数不会在进程生命周期里变化，重复取 argv 没有意义。
fn startup_argv() -> &'static [String] {
    static ARGV: OnceLock<Vec<String>> = OnceLock::new();
    ARGV.get_or_init(|| std::env::args().collect()).as_slice()
}

fn startup_started_ms() -> u64 {
    static STARTED: OnceLock<u64> = OnceLock::new();
    *STARTED.get_or_init(|| now_ms() as u64)
}

/// 管理台展示的是启动参数，不是密钥仓库：--token 等敏感值必须脱敏。
fn redacted_argv(argv: &[String]) -> Vec<String> {
    const MAX_ARGS: usize = 64;
    const MAX_ARG_CHARS: usize = 512;
    fn secret_flag(s: &str) -> bool {
        matches!(s.to_ascii_lowercase().as_str(),
            "--token" | "--admin-token" | "--api-key" | "--secret" | "--password" | "--proxy")
    }
    let mut out = Vec::new();
    let mut hide_next = false;
    for raw in argv.iter().take(MAX_ARGS) {
        let arg: String = raw.chars().take(MAX_ARG_CHARS).collect();
        if hide_next {
            out.push("***".to_string());
            hide_next = false;
            continue;
        }
        if secret_flag(&arg) {
            out.push(arg);
            hide_next = true;
        } else if arg.to_ascii_lowercase().starts_with("--token=")
            || arg.to_ascii_lowercase().starts_with("--admin-token=")
            || arg.to_ascii_lowercase().starts_with("--api-key=")
            || arg.to_ascii_lowercase().starts_with("--secret=")
            || arg.to_ascii_lowercase().starts_with("--password=")
            || arg.to_ascii_lowercase().starts_with("--proxy=")
        {
            out.push(arg.split('=').next().unwrap_or("--token").to_string() + "=***");
        } else {
            out.push(arg);
        }
    }
    out
}

/// 心跳里带一份“最后一次启动现场”：原始命令行 + 解析后的生效开关。
/// 其中 delivery.auto=false 表示没有开启窗口/tmux 外部投送，管理台直接可见。
/// 客户端诊断环形缓冲：debug 只在服务端打开时随心跳上传；异常始终保留最近 N 条。
static DIAG_LOGS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static CLIENT_ERRORS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static ERROR_SEQ: AtomicU64 = AtomicU64::new(1);
static ERROR_DIR: OnceLock<PathBuf> = OnceLock::new();

fn error_outbox_path() -> Option<&'static PathBuf> {
    ERROR_DIR.get()
}

fn save_error_outbox() {
    let dir = match error_outbox_path() { Some(d) => d, None => return };
    let body = CLIENT_ERRORS.get_or_init(|| Mutex::new(VecDeque::new()))
        .lock().map(|g| json!(g.iter().cloned().collect::<Vec<_>>())).unwrap_or_else(|_| json!([]));
    let _ = fs::write(dir.join("error-outbox.json"), body.to_string());
}

fn load_error_outbox(dir: &std::path::Path) {
    let _ = ERROR_DIR.set(dir.to_path_buf());
    let path = dir.join("error-outbox.json");
    let parsed: Value = fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!([]));
    if let Some(items) = parsed.as_array() {
        let ring = CLIENT_ERRORS.get_or_init(|| Mutex::new(VecDeque::new()));
        if let Ok(mut g) = ring.lock() {
            for item in items.iter().take(20) { g.push_back(item.clone()); }
            while g.len() > 20 { g.pop_front(); }
        }
    }
}

fn diag_log(level: &str, msg: impl Into<String>) {
    let entry = json!({
        "ts": now_ms() as u64,
        "level": level,
        "msg": msg.into().chars().take(600).collect::<String>(),
    });
    let ring = DIAG_LOGS.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(mut g) = ring.lock() {
        g.push_back(entry);
        while g.len() > 60 { g.pop_front(); }
    }
}

fn record_client_error(kind: &str, message: impl Into<String>, detail: Option<String>) {
    let id = format!("{}-{}", now_ms(), ERROR_SEQ.fetch_add(1, Ordering::Relaxed));
    let entry = json!({
        "id": id,
        "ts": now_ms() as u64,
        "kind": kind,
        "message": message.into().chars().take(500).collect::<String>(),
        "detail": detail.map(|s| s.chars().take(1200).collect::<String>()),
    });
    let ring = CLIENT_ERRORS.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(mut g) = ring.lock() {
        g.push_back(entry);
        while g.len() > 20 { g.pop_front(); }
    }
    save_error_outbox();
}

fn debug_payload() -> Value {
    if !remote_debug_enabled() { return json!({"enabled": false}); }
    let logs: Vec<Value> = DIAG_LOGS.get_or_init(|| Mutex::new(VecDeque::new()))
        .lock().map(|g| g.iter().cloned().collect()).unwrap_or_default();
    json!({"enabled": true, "logs": logs})
}

fn errors_payload() -> Value {
    let errors: Vec<Value> = CLIENT_ERRORS.get_or_init(|| Mutex::new(VecDeque::new()))
        .lock().map(|g| g.iter().cloned().collect()).unwrap_or_default();
    json!(errors)
}

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.into_iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(),
                                 canonical_json(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn launch_digest(launch: &Value) -> String {
    use sha2::{Digest, Sha256};
    let text = canonical_json(launch);
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

fn launch_snapshot(cfg: &Cfg) -> Value {
    let argv = redacted_argv(startup_argv());
    // 代理地址可能带 user:pass，命令行里已脱敏；这里只保留可判断的模式。
    let mut proxy = "auto".to_string();
    let raw_argv = startup_argv();
    if let Some(i) = raw_argv.iter().position(|a| a == "--proxy") {
        if let Some(v) = raw_argv.get(i + 1) {
            proxy = if cfg_falsey(v) { "off".to_string() } else { "custom".to_string() };
        }
    } else if let Some(v) = raw_argv.iter().find_map(|a| a.strip_prefix("--proxy=")) {
        proxy = if cfg_falsey(v) { "off".to_string() } else { "custom".to_string() };
    }
    let (window_forward, tmux_forward) = effective_surfaces(cfg);
    let mut sources = cfg.sources.clone();
    if remote_auto_state() != "inherit" {
        sources.insert("window_forward".into(), "remote".into());
        sources.insert("tmux_forward".into(), "remote".into());
        sources.insert("auto_forward".into(), "remote".into());
    } else {
        sources.insert("auto_forward".into(),
            if window_forward || tmux_forward { "config".into() } else { "default".into() });
    }
    if REMOTE_HB_S.load(Ordering::Relaxed) > 0 { sources.insert("heartbeat_s".into(), "remote".into()); }
    if REMOTE_REV.load(Ordering::Relaxed) > 0 { sources.insert("debug".into(), "remote".into()); }
    let control = json!({
        "rev": REMOTE_REV.load(Ordering::Relaxed),
        "auto_forward": remote_auto_state(),
        "debug": remote_debug_enabled(),
        "heartbeat_s": runtime_heartbeat_s(cfg),
        "applied_at": REMOTE_APPLIED_MS.load(Ordering::Relaxed),
    });
    json!({
        "schema": "synapse.launch.v1",
        "kind": "rust",
        "version": env!("CARGO_PKG_VERSION"),
        "started_at": startup_started_ms(),
        "argv": argv,
        "cwd": std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()),
        "config_dir": cfg.dir.to_string_lossy(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
        "sources": sources,
        "control": control,
        "delivery": {
            "auto": window_forward || tmux_forward,
            "kind": surface_kind(cfg),
            "target": surface_target(cfg),
            "window_forward": window_forward,
            "window_app": cfg.window_app,
            "window_conversation": cfg.window_conversation,
            "tmux_forward": tmux_forward,
            "tmux_target": cfg.tmux_target,
            "tmux_verify": cfg.tmux_verify,
        },
        "effective": {
            "cmd": cfg.cmd,
            "role": cfg.role,
            "agent_id": cfg.agent_id,
            "project": cfg.project,
            "heartbeat_s": runtime_heartbeat_s(cfg),
            "config_dir": cfg.dir.to_string_lossy(),
            "exec": cfg.exec_cmd,
            "event_cmd": cfg.event_cmd,
            "window_forward": window_forward,
            "window_app": cfg.window_app,
            "window_conversation": cfg.window_conversation,
            "tmux_forward": tmux_forward,
            "tmux_target": cfg.tmux_target,
            "tmux_verify": cfg.tmux_verify,
            "proxy": proxy,
            "auto_forward": remote_auto_state(),
            "debug": remote_debug_enabled(),
        },
    })
}

fn handle_heartbeat_result(
    res: std::result::Result<ureq::Response, ureq::Error>,
    need_launch: &mut bool,
) -> bool {
    match res {
        Ok(r) => {
            let v: Value = r.into_json().unwrap_or_else(|_| json!({}));
            let prev_rev = REMOTE_REV.load(Ordering::Relaxed);
            apply_remote_control(&v["control"]);
            let control_changed = REMOTE_REV.load(Ordering::Relaxed) != prev_rev;
            *need_launch = v["launch_required"].as_bool() == Some(true) || control_changed;
            diag_log("debug", format!("heartbeat ok control_rev={}", REMOTE_REV.load(Ordering::Relaxed)));
            true
        }
        Err(e) => {
            record_client_error("heartbeat", "heartbeat request failed", Some(format!("{e}")));
            diag_log("warn", format!("heartbeat failed: {e}"));
            *need_launch = true;
            false
        }
    }
}

fn heartbeat_payload(cfg: &Cfg, hb: u64, queue: usize, journal: &Arc<Mutex<Vec<Value>>>,
                     surface: &Arc<Mutex<SurfaceStatus>>, include_launch: bool) -> Value {
    let mut load = json!({});
    if let Some(l) = load1() { load["load1"] = json!(l); }
    if let Some((u, t)) = mem_mb() { load["mem_used_mb"] = json!(u); load["mem_total_mb"] = json!(t); }
    load["disk"] = disk();
    let st = surface.lock().unwrap().clone();
    let active = st.active_task.clone();
    let launch = launch_snapshot(cfg);
    let launch_hash = launch_digest(&launch);
    let mut body = json!({"hb": hb, "agent_id": cfg.agent_id,
           "work": {"state": if active.is_some() { "busy" } else { "idle" },
                     "phase": if active.is_some() { "task" } else { "idle" },
                     "task_id": active},
           "surface": {"kind": surface_kind(cfg), "target": surface_target(cfg),
                        "forward": cfg.surface_forward(),
                        "state": st.state, "active_task_id": st.active_task,
                        "queue": st.queue_len},
           "max_parallel_tasks": if surface_kind(cfg) == "none" { 2 } else { 1 },
           "load": load, "env": {"git_head": git_head()}, "sdk_version": env!("CARGO_PKG_VERSION"),
           "launch_hash": launch_hash,
           "debug": debug_payload(), "errors": errors_payload(),
           "delivery_health": delivery_health_payload(),
           "queue": queue, "unacked": journal.lock().unwrap().len()});
    if include_launch { body["launch"] = launch; }
    body
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

enum InboxEvent {
    Raw(String, bool),
    Surface(Value),
}

/// 把一条消息投递出去：先 WAL（inflight）落盘，再回执“已收到”，最后入队给主线程。
/// 外部投递面不在这里直接注入：任务/提醒统一交给 SurfacePump，否则收件线程
/// 会在第一条长任务还没结束时把后续 N 条全部粘进同一个窗口/tmux。
fn deliver_ws(cfg: &Cfg, agent: &Agent, base: &str,
              journal: &Arc<Mutex<Vec<Value>>>, m: &Value,
              tx: &mpsc::Sender<InboxEvent>, queue: &AtomicUsize, last_msg: &AtomicU64) {
    if is_noise(cfg, m) || !for_me(cfg, m) { return; }
    if !enqueue_message(cfg, journal, m) { return; }
    if cfg.surface_forward() {
        // 收件线程只负责落 WAL 和唤醒 dispatcher；真正注入/ACK 在主线程做。
        queue.fetch_add(1, Ordering::Relaxed);
        if tx.send(InboxEvent::Surface(m.clone())).is_err() {
            let _ = queue.try_update(Ordering::Relaxed, Ordering::Relaxed,
                                     |x| Some(x.saturating_sub(1)));
        } else {
            last_msg.store(now_ms() as u64, Ordering::Relaxed);
        }
        return;
    }
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
    if tx.send(InboxEvent::Raw(text, false)).is_err() {
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
    let surface_status = Arc::new(Mutex::new(SurfaceStatus::default()));
    let mut surface_pump = if cfg.surface_forward() {
        Some(SurfacePump::new(cfg, journal.clone(), surface_status.clone()))
    } else { None };

    // 心跳独立于收件/执行：长任务不能把 heartbeat 压住。
    let hb_handle = {
        let (cfg2, agent2, base2, journal2, last2, stop2, surface2) =
            (cfg.clone_lite(), agent.clone(), base.to_string(), journal.clone(),
             last_msg.clone(), poll_stop.clone(), surface_status.clone());
        thread::spawn(move || {
            let mut hb: u64 = 0;
            let mut need_launch = true;
            loop {
                if stop2.load(Ordering::Relaxed) { break; }
                hb += 1;
                let st = surface2.lock().unwrap().clone();
                let queue_len = if cfg2.surface_forward() { st.queue_len } else { journal2.lock().unwrap().len() };
                let sent_full = need_launch;
                let body = heartbeat_payload(&cfg2, hb, queue_len, &journal2, &surface2, sent_full);
                let res = agent2
                    .post(&format!("{}/p/{}/heartbeat", base2, cfg2.project))
                    .set("authorization", &format!("Bearer {}", cfg2.token))
                    .set("x-sdk-version", env!("CARGO_PKG_VERSION"))
                    .set("connection", "close")
                    .send_json(body);
                let ok = handle_heartbeat_result(res, &mut need_launch);
                if !ok { eprintln!("[poll] heartbeat 失败 hb={hb}"); }
                write_run_state(&cfg2.dir, &json!({
                    "connected": ok, "transport": "poll", "last_hb_ok": ok,
                    "last_hb_ms": now_ms() as u64,
                    "last_msg_ms": last2.load(Ordering::Relaxed),
                    "queue": queue_len, "unacked": journal2.lock().unwrap().len(),
                    "surface": {"kind": surface_kind(&cfg2), "state": st.state,
                                 "active_task_id": st.active_task, "queue": st.queue_len},
                    "pid": std::process::id(),
                }));
                // 分片睡眠，让 run_poll 到点返回时最多等 1s，不必等满一个心跳周期。
                let wait_until = Instant::now() + Duration::from_secs(runtime_heartbeat_s(&cfg2).max(1));
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
    if let Some(pump) = surface_pump.as_mut() {
        if !hb_only_poll {
            for m in replay { pump.push(m); }
            pump.pump(agent, base, &last_msg);
        }
    } else {
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
            if is_work_item(&m) { active_task_set(cfg, &m); }
            if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &text); } else { println!("{text}"); }
            dequeue_message(&cfg.dir, &journal, &m);
            if is_work_item(&m) { active_task_clear(cfg, task_id_of(&m)); }
            last_msg.store(now_ms() as u64, Ordering::Relaxed);
        }
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
        if let Some(pump) = surface_pump.as_mut() {
            pump.pump(agent, base, &last_msg);
        } else {
            let retried = retry_pending_surfaces(cfg, agent, base, &journal, &last_msg);
            if retried > 0 { eprintln!("[poll] 重试补发 {retried} 条外部投递消息"); }
        }
        // 事件与消息是两条独立流：即使当前没有任务消息，也要把 task/submission 通知推给回调。
        publish_events(cfg, agent, base);
        if let Some(msgs) = fetch_inbox(&cfg, &agent, &base, cursor_get(&cfg.dir), 5, Some(&journal), true) {
            for m in msgs {
                if is_noise(&cfg, &m) || !for_me(&cfg, &m) { continue; }
                if !enqueue_message(&cfg, &journal, &m) { continue; }
                if let Some(pump) = surface_pump.as_mut() {
                    pump.push(m);
                    continue;
                }
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
                if is_work_item(&m) { active_task_set(cfg, &m); }
                if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &text); } else { println!("{text}"); }
                dequeue_message(&cfg.dir, &journal, &m);
                if is_work_item(&m) { active_task_clear(cfg, task_id_of(&m)); }
                last_msg.store(now_ms() as u64, Ordering::Relaxed);
            }
        }
        if let Some(pump) = surface_pump.as_mut() {
            pump.pump(agent, base, &last_msg);
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
    let (tx, rx) = mpsc::channel::<InboxEvent>();
    let state = Arc::new(Mutex::new(("idle".to_string(), String::new(), 0usize)));
    let surface_status = Arc::new(Mutex::new(SurfaceStatus::default()));
    let mut surface_pump = if cfg.surface_forward() {
        Some(SurfacePump::new(cfg, journal.clone(), surface_status.clone()))
    } else { None };
    let connected = Arc::new(AtomicBool::new(false));
    let queue = Arc::new(AtomicUsize::new(0));
    let last_msg = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let superseded = Arc::new(AtomicBool::new(false));
    let state_gate = Arc::new(Mutex::new(()));

    // 重放先入队（此时收件线程还没启动，保证 replay 排在新消息前面）。
    for m in pending {
        if let Some(p) = surface_pump.as_mut() {
            p.push(m);
        } else {
            let text = serde_json::to_string(&m).unwrap_or_default();
            if tx.send(InboxEvent::Raw(text, true)).is_ok() {
                queue.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    if let Some(p) = surface_pump.as_ref() { queue.store(p.pending_len(), Ordering::Relaxed); }

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
                        // 断线期间漏掉的事件也补一遍；事件游标独立，不受消息 cursor 影响。
                        publish_events(&cfg2, &agent2, &base2);
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
                                        } else if v["type"] == "event" {
                                            // 事件帧只做通知：落 events.jsonl / 执行 event-cmd，
                                            // 不进入任务队列，不会被窗口 dispatcher 当成任务。
                                            deliver_client_event(&cfg2, &v["event"]);
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
        let (agent2, base2, proj, tok, aid, dir2) =
            (agent.clone(), base.to_string(), cfg.project.clone(), cfg.token.clone(),
             cfg.agent_id.clone(), cfg.dir.clone());
        let st = state.clone();
        let conn3 = connected.clone();
        let q3 = queue.clone();
        let last3 = last_msg.clone();
        let journal3 = journal.clone();
        let stop3 = stop.clone();
        let gate3 = state_gate.clone();
        let surface4 = surface_status.clone();
        let cfg4 = cfg.clone_lite();
        thread::spawn(move || {
            let mut hb = 0u64;
            let mut need_launch = true;
            loop {
                if stop3.load(Ordering::Relaxed) { break; }
                hb += 1;
                let (ws, ph, _q) = { let g = st.lock().unwrap(); (g.0.clone(), g.1.clone(), g.2) };
                let queue_now = q3.load(Ordering::Relaxed);
                let unacked = journal3.lock().unwrap().len();
                let surf = surface4.lock().unwrap().clone();
                let launch = launch_snapshot(&cfg4);
                let launch_hash = launch_digest(&launch);
                let mut body = json!({"hb": hb, "agent_id": aid,
                                  "work": {"state": ws, "phase": ph, "task_id": surf.active_task.clone()},
                                  "surface": {"kind": surface_kind(&cfg4), "target": surface_target(&cfg4),
                                               "forward": cfg4.surface_forward(),
                                               "state": surf.state, "active_task_id": surf.active_task.clone(),
                                               "queue": surf.queue_len},
                                  "max_parallel_tasks": if surface_kind(&cfg4) == "none" { 2 } else { 1 },
                                  "load": {"disk": disk()}, "sdk_version": env!("CARGO_PKG_VERSION"),
                                  "launch_hash": launch_hash,
                                  "debug": debug_payload(), "errors": errors_payload(),
                                  "delivery_health": delivery_health_payload(),
                                  "queue": queue_now, "unacked": unacked});
                if need_launch { body["launch"] = launch; }
                let res = agent2.post(&format!("{}/p/{}/heartbeat", base2, proj))
                    .set("authorization", &format!("Bearer {}", tok))
                    .set("connection", "close")
                    .send_json(body);
                let ok = handle_heartbeat_result(res, &mut need_launch);
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
                    "surface": {"kind": surface_kind(&cfg4), "state": surf.state,
                                 "active_task_id": surf.active_task.clone(), "queue": surf.queue_len},
                    "pid": std::process::id(),
                }));
                drop(_g);
                thread::sleep(Duration::from_secs(runtime_heartbeat_s(&cfg4).max(1)));
            }
        });
    }

    // 主线程：非外部面走原来的逐条执行；窗口/tmux 走 SurfacePump 单飞。
    loop {
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(InboxEvent::Surface(v)) => {
                if surface_pump.is_none() && cfg.surface_forward() {
                    surface_pump = Some(SurfacePump::new(cfg, journal.clone(), surface_status.clone()));
                }
                if let Some(pump) = surface_pump.as_mut() {
                    pump.push(v);
                    pump.pump(agent, base, &last_msg);
                    queue.store(pump.pending_len(), Ordering::Relaxed);
                    let st = surface_status.lock().unwrap().clone();
                    let mut g = state.lock().unwrap();
                    g.0 = if st.active_task.is_some() { "busy".into() } else { "idle".into() };
                    g.1 = st.active_task.clone().unwrap_or_else(|| "等指令".into());
                    g.2 = pump.pending_len();
                }
            }
            Ok(InboxEvent::Raw(task, replay)) => {
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
                    if let Some(v) = &parsed {
                        if is_work_item(v) { active_task_set(cfg, v); }
                    }
                    if let Some(cmd) = &cfg.exec_cmd { exec_task(cmd, &task); } else { println!("{task}"); }
                    if let Some(v) = &parsed {
                        dequeue_message(&cfg.dir, &journal, v);
                        if is_work_item(v) { active_task_clear(cfg, task_id_of(v)); }
                    }
                } else if let Some(v) = &parsed {
                    eprintln!("[ws] seq={} 重放投递失败，保留 WAL、不 ACK",
                              seq_of(v).unwrap_or(0));
                }
                let _ = queue.try_update(Ordering::Relaxed, Ordering::Relaxed,
                                         |x| Some(x.saturating_sub(1)));
                { let mut g = state.lock().unwrap(); g.0 = "idle".into(); g.1 = "等指令".into(); }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(pump) = surface_pump.as_mut() {
                    pump.pump(agent, base, &last_msg);
                    queue.store(pump.pending_len(), Ordering::Relaxed);
                    let st = surface_status.lock().unwrap().clone();
                    let mut g = state.lock().unwrap();
                    g.0 = if st.active_task.is_some() { "busy".into() } else { "idle".into() };
                    g.1 = st.active_task.clone().unwrap_or_else(|| "等指令".into());
                    g.2 = pump.pending_len();
                } else {
                    let n = retry_pending_surfaces(cfg, agent, base, &journal, &last_msg);
                    if n > 0 { eprintln!("[ws] 空闲重试补发 {n} 条外部投递消息"); }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    stop.store(true, Ordering::Relaxed);
    connected.store(false, Ordering::Relaxed);
    // true = 被新连接取代，调用方应直接退出；false = 长连接不可用，回退轮询
    superseded.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_argv_redacts_token_and_proxy_values() {
        let argv = vec![
            "synapse-agent".to_string(), "run".to_string(),
            "--token".to_string(), "secret-token".to_string(),
            "--proxy".to_string(), "http://user:pass@proxy".to_string(),
            "--token=abc".to_string(), "--window".to_string(), "0".to_string(),
            "--admin-token=xyz".to_string(), "--secret".to_string(), "s".to_string(),
        ];
        let got = redacted_argv(&argv);
        assert_eq!(got, vec![
            "synapse-agent".to_string(), "run".to_string(),
            "--token".to_string(), "***".to_string(),
            "--proxy".to_string(), "***".to_string(),
            "--token=***".to_string(), "--window".to_string(), "0".to_string(),
            "--admin-token=***".to_string(), "--secret".to_string(), "***".to_string(),
        ]);
    }

    #[test]
    fn launch_snapshot_reports_delivery_switches() {
        let dir = scratch("launch-snapshot");
        let mut cfg = test_cfg(dir);
        let off = launch_snapshot(&cfg);
        assert_eq!(off["kind"], "rust");
        assert_eq!(off["delivery"]["auto"], false);
        assert_eq!(off["delivery"]["kind"], "none");
        cfg.window_forward = true;
        cfg.window_app = "豆包".into();
        let on = launch_snapshot(&cfg);
        assert_eq!(on["delivery"]["auto"], true);
        assert_eq!(on["delivery"]["kind"], "window");
        assert_eq!(on["delivery"]["target"], "豆包");
    }

    #[test]
    fn launch_digest_is_stable_and_changes_with_target() {
        let dir = scratch("launch-digest");
        let mut cfg = test_cfg(dir);
        cfg.window_forward = true;
        cfg.window_app = "豆包".into();
        let a = launch_snapshot(&cfg);
        let b = launch_snapshot(&cfg);
        assert_eq!(launch_digest(&a), launch_digest(&b));
        cfg.window_app = "另一个窗口".into();
        let c = launch_snapshot(&cfg);
        assert_ne!(launch_digest(&a), launch_digest(&c));
    }

    #[test]
    fn canonical_json_ignores_object_key_order() {
        let a: Value = serde_json::from_str(r#"{"z":1,"a":{"y":2,"b":3}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"b":3,"y":2},"z":1}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
    }


    #[test]
    fn state_dir_cli_override_wins_over_env_and_default() {
        let got = resolve_state_dir(Some("/tmp/cli-dir"), Some("/tmp/env-dir"), "/tmp/home-x");
        assert_eq!(got, PathBuf::from("/tmp/cli-dir"));
    }

    #[test]
    fn state_dir_env_override_wins_over_default() {
        let got = resolve_state_dir(None, Some("/tmp/env-dir"), "/tmp/home-x");
        assert_eq!(got, PathBuf::from("/tmp/env-dir"));
    }

    #[test]
    fn state_dir_blank_overrides_fall_through_to_default() {
        // 空/纯空白的覆盖不算数，落回缺省 ~/.synapse-agent（该 home 下两目录都不存在）。
        let home = scratch("statedir-home");
        let got = resolve_state_dir(Some("  "), Some(""), home.to_str().unwrap());
        assert_eq!(got, home.join(".synapse-agent"));
    }

    #[test]
    fn state_dir_default_keeps_legacy_yanshi_fallback() {
        // 缺省路径保留旧兼容：~/.synapse-agent 不存在而 ~/.yanshi-agent 存在时用后者。
        let home = scratch("statedir-legacy");
        fs::create_dir_all(home.join(".yanshi-agent")).unwrap();
        let got = resolve_state_dir(None, None, home.to_str().unwrap());
        assert_eq!(got, home.join(".yanshi-agent"));
        // 显式覆盖时不走兼容回退，原样使用。
        let got2 = resolve_state_dir(Some("/tmp/cli-dir"), None, home.to_str().unwrap());
        assert_eq!(got2, PathBuf::from("/tmp/cli-dir"));
    }

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
            role: "agent".into(),
            dir,
            heartbeat_s: 30,
            exec_cmd: None,
            event_cmd: None,
            window_app: String::new(),
            window_conversation: String::new(),
            window_forward: false,
            tmux_target: String::new(),
            tmux_forward: false,
            tmux_verify: true,
            sources: HashMap::new(),
        }
    }

    fn test_cfg_admin(dir: PathBuf) -> Cfg {
        let mut cfg = test_cfg(dir);
        cfg.role = "admin".into();
        cfg
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn upgrade_mode_restores_exec_bit_when_current_is_0644() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("upgrade-mode-0644");
        let current = dir.join("synapse-agent");
        let tmp = dir.join("synapse-agent.new");
        fs::write(&current, b"old").unwrap();
        fs::set_permissions(&current, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&tmp, b"new").unwrap();
        apply_upgrade_mode(tmp.to_str().unwrap(), &current).unwrap();
        let mode = fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "upgrade must add exec bits when the old binary is 0644");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_executable_repairs_0644_after_rename() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("ensure-executable");
        let bin = dir.join("synapse-agent");
        fs::write(&bin, b"new").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o644)).unwrap();
        ensure_executable(&bin).unwrap();
        assert_eq!(fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn upgrade_mode_strips_special_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("upgrade-mode-special");
        let current = dir.join("synapse-agent");
        let tmp = dir.join("synapse-agent.new");
        fs::write(&current, b"old").unwrap();
        fs::set_permissions(&current, fs::Permissions::from_mode(0o4751)).unwrap();
        fs::write(&tmp, b"new").unwrap();
        apply_upgrade_mode(tmp.to_str().unwrap(), &current).unwrap();
        let mode = fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o751, "special bits must not be copied to the downloaded binary");
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
    fn event_cursor_is_independent_from_task_cursor() {
        let dir = scratch("event-cursor");
        cursor_set(&dir, 41);
        event_cursor_set(&dir, 7);
        assert_eq!(cursor_get(&dir), 41, "消费消息不能推进事件游标");
        assert_eq!(event_cursor_get(&dir), 7, "事件游标独立落盘");
        event_epoch_set(&dir, "ep-a");
        assert_eq!(event_epoch_get(&dir), "ep-a");
    }

    #[test]
    fn client_event_is_logged_not_persisted_as_task() {
        let dir = scratch("event-log");
        let cfg = test_cfg(dir.clone());
        let event = json!({"id": "evt-p-9", "type": "submission.created", "seq": 9,
                           "task_id": "t1", "submission_id": "s1"});
        deliver_client_event(&cfg, &event);
        assert_eq!(event_cursor_get(&dir), 9);
        let log = fs::read_to_string(dir.join("events.jsonl")).unwrap();
        let last: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
        assert_eq!(last["type"], "submission.created");
        assert!(journal_load(&dir).is_empty(), "事件绝不能进入任务 WAL");
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
        let cfg = test_cfg(dir.clone());
        let admin_cfg = test_cfg_admin(dir);
        assert!(is_noise(&cfg, &json!({"topic": "ack", "payload": {}})));
        assert!(is_noise(&cfg, &json!({"topic": "announce", "sender": "a1", "to": null})));
        assert!(!is_noise(&cfg, &json!({"topic": "task", "sender": "admin"})));
        // 管理端 announce 仍广播；普通 agent 自己发的无收件人广播只进管理台。
        assert!(for_me(&cfg, &json!({"topic": "announce", "sender": "admin", "to": null})));
        assert!(for_me(&admin_cfg, &json!({"topic": "announce", "sender": "admin", "to": null})));
        assert!(!for_me(&cfg, &json!({"topic": "announce", "sender": "b2", "to": null})));
        assert!(for_me(&admin_cfg, &json!({"topic": "announce", "sender": "b2", "to": null})));
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
        let cfg = test_cfg(dir.clone());
        let admin_cfg = test_cfg_admin(dir);

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

        // 管理端 announce 仍按原协议广播给全员；只有 role=admin 的本地投递面也收其它广播
        let admin_bc = json!({
            "sender": "admin", "to": null, "topic": "announce",
            "kind": "broadcast", "payload": {"title": "git pull"}
        });
        assert!(!is_surface_noise(&cfg, &admin_bc));
        assert!(!is_surface_noise(&admin_cfg, &admin_bc));

        // 普通 agent 自己发的无收件人广播不能污染其他普通 agent
        let agent_bc = json!({
            "sender": "b2", "to": null, "topic": "announce",
            "kind": "broadcast", "payload": {"title": "我这里完成了"}
        });
        assert!(is_surface_noise(&cfg, &agent_bc));
        assert!(!is_surface_noise(&admin_cfg, &agent_bc));

        // issue 生命周期是项目广播，普通 agent 不进窗口；管理面仍可看到
        let issue = json!({
            "sender": "admin", "to": null, "topic": "issue",
            "kind": "closed", "payload": {"issue_id": "ISS-1", "title": "已修"}
        });
        assert!(is_surface_noise(&cfg, &issue));
        assert!(!is_surface_noise(&admin_cfg, &issue));

        // 旧公共池任务广播（to=null）也不能当成当前任务进窗口
        let legacy_task = json!({
            "sender": "admin", "to": null, "topic": "task",
            "kind": "task", "payload": {"task_id": "T-OLD", "title": "旧任务", "work_item": true}
        });
        assert!(is_surface_noise(&cfg, &legacy_task));

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

        // 管理员转派事件也带完整正文（payload.task_id/title/body），不能按
        // “无正文的 task 生命周期事件”过滤掉；这是 T-FIX-212 没进窗口的根因。
        let admin_reassigned = json!({
            "seq": 101, "sender": "admin", "to": "a1", "topic": "task",
            "kind": "reassigned",
            "payload": {"task_id": "T-2", "title": "转派", "body": "do it"}
        });
        assert!(!is_task_notice(&admin_reassigned));
        assert!(!is_surface_noise(&cfg, &admin_reassigned));
    }

    #[test]
    fn terminal_event_releases_active_lock() {
        let dir = scratch("event-active-release");
        let cfg = test_cfg(dir);
        active_task_set_id(&cfg, "T-1", 42, "do it");
        assert!(active_task_load(&cfg.dir).is_some());

        // 仍在跑/排队的事件不能误放行
        assert!(!event_closes_active(&cfg, &json!({"type": "task.queued", "task_id": "T-1"})));
        assert!(active_task_load(&cfg.dir).is_some());

        // 服务端 done 事件即使 raw 消息没到，也必须释放 active
        assert!(event_closes_active(&cfg, &json!({"type": "task.done", "data": {"task_id": "T-1"}})));
        assert!(active_task_load(&cfg.dir).is_none());
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

        let work = json!({"seq": 9, "topic": "task", "kind": "task",
                          "payload": {"task_id": "T-1", "title": "do", "body": "it",
                                      "work_item": true}});
        assert!(is_work_item(&work));
        assert_eq!(format_hub_message(&work).as_deref(),
                   Some("[Synapse #9] [task:T-1] do\nit"));

        let mut notice = json!({"seq": 10, "topic": "admin", "kind": "notice",
                                "payload": {"title": "提醒", "body": "继续", "notice": true}});
        assert!(is_notice(&notice));
        notice["_surface_notice"] = json!(true);
        assert_eq!(format_hub_message(&notice).as_deref(),
                   Some("[Synapse #10] [提醒，不是新任务] 提醒\n继续"));
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

#[cfg(test)]
mod discovery_tests {
    use super::*;

    #[test]
    fn capability_ids_accepts_objects_and_strings() {
        let v = json!({"capabilities": [
            {"id": "a"}, {"id": "b"}
        ]});
        assert_eq!(capability_ids(&v), vec!["a".to_string(), "b".to_string()]);
        let v = json!({"capabilities": ["c", "d"]});
        assert_eq!(capability_ids(&v), vec!["c".to_string(), "d".to_string()]);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(sha256_hex(b"abc"),
                   "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn init_rejects_doc_template_identity() {
        assert_eq!(init_template_field("https://example.com", "p", "a", "t"), Some("endpoint"));
        assert_eq!(init_template_field("https://synapse.wangda.today", "p", "a", "t"), Some("project"));
        assert_eq!(init_template_field("https://synapse.wangda.today", "yeban", "a", "t"), Some("agent"));
        assert_eq!(init_template_field("https://synapse.wangda.today", "yeban", "doubao-dev-003", "..."), Some("token"));
        assert_eq!(init_template_field("https://synapse.wangda.today", "yeban", "doubao-dev-003", "real"), None);
    }
}
