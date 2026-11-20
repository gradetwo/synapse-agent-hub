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
mod profile;
mod winmsg;
mod localbus;
use std::io::{Write, Read};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::Agent;
use tungstenite::{connect, Message};
use sha2::{Digest, Sha256};

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
    /// 复制一份给线程用（Cfg 没有 derive Clone，避免改动对外结构）
    fn clone_lite(&self) -> Cfg {
        Cfg {
            cmd: self.cmd.clone(), endpoint: self.endpoint.clone(), project: self.project.clone(),
            token: self.token.clone(), agent_id: self.agent_id.clone(), dir: self.dir.clone(),
            heartbeat_s: self.heartbeat_s, exec_cmd: self.exec_cmd.clone(),
            window_app: self.window_app.clone(),
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
            .unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let project = map.get("project").cloned()
            .or_else(|| saved["project"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "yanshi".into());
        let token = map.get("token").cloned()
            .or_else(|| saved["token"].as_str().map(|s| s.to_string()))
            .or_else(|| std::env::var("YANSHI_TOKEN").ok()).unwrap_or_default();
        let agent_id = map.get("agent").cloned()
            .or_else(|| saved["agent_id"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "rust-agent".into());
        let heartbeat_s = map.get("heartbeat").and_then(|s| s.parse().ok())
            .or_else(|| saved["heartbeat_s"].as_u64()).unwrap_or(60);
        let window_app = map.get("app").cloned()
            .or_else(|| saved["window_app"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        Cfg { cmd, endpoint, project, token, agent_id, exec_cmd: map.get("exec").cloned(), heartbeat_s, dir, window_app }
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
    let tmp = dir.join("cursor.tmp");
    let dst = dir.join("cursor.json");
    let _ = fs::write(&tmp, json!({"seq": seq, "at": now_ms()}).to_string());
    let _ = fs::rename(&tmp, &dst);
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == "--help" || a == "-h" || a == "help") {
        println!("synapse-agent 0.5.1\n\n基础用法:\n  synapse-agent init --endpoint <url> --project <p> --token <t> [--agent <id>]\n  synapse-agent run  [--exec \"cmd\"]\n  synapse-agent status\n  synapse-agent wait | peek | profile | agents | subs | send | broadcast | get | upgrade\n\n交付（upload/submit 已补齐，deliver 为回合制 agent 一次调用完成）:\n  synapse-agent upload --file <path>                       # 直传 R2，输出 ref\n  synapse-agent submit --kind patch --title <t> --ref <sha>[:<name>] [--ref ...] \\\n                        [--base-sha <sha>] [--checks <json字符串>] [--notes <s>]\n  synapse-agent deliver --file <path> --kind patch --title <t> [--base-sha <sha>]\n\n本地窗口桥（Windows）:\n  synapse-agent win-config --app <应用名>     ★设置默认目标，写入 config.json（如 win-config --app 豆包）\n        win-config [--show|--clear] 查看/清除默认目标。设置后 win-send/win-read/bridge 无需再带 --app。\n        也可用环境变量 SYNAPSE_WINDOW_APP 临时覆盖。\n  synapse-agent win-list [--app <应用名>] [--match <标题子串>]\n        发现窗口。--app 豆包 会按进程名自动找到豆包窗口（推荐，无需手输标题）。\n  synapse-agent win-send (--app <应用名> | --title <子串>) (--text <文字> | --file <UTF-8文件> | --stdin) [--enter 1] [--method click|paste|copy|both]\n        向目标窗口发送文字。--app 时自动发现进程与窗口；默认 click=点击输入框再粘贴（对 Electron 豆包最稳，支持中文）。\n        ★发代码 / patch 请用 --file <文件> 或 --stdin（type p.patch | ... --stdin）：整段读 UTF-8，绕开命令行 32767 字符上限与转义。\n        --text / --file / --stdin 三选一（同时给时按此优先级取非空）。\n  synapse-agent win-read (--app <应用名> | --title <子串>) [--diff] [--no-restore]\n        读取目标窗口文本；--diff 输出相对上次的新增行（用于提取“新消息”）。\n  synapse-agent win-bridge --title <子串> --mode in|out [--name <管道名>]\n        把窗口对接到本机消息总线：in=窗口新消息读入总线；out=总线消息写入窗口。\n\n本机消息总线:\n  synapse-agent bus-serve [--name <管道名>]\n        常驻监听命名管道，逐条打印收到的 JSON Lines 消息（供配置程序/agent 读取）。\n  synapse-agent bus-send (--text <文字> | --file <UTF-8文件> | --stdin) [--dir in|out] [--topic <t>] [--sender <s>] [--name <管道名>]\n        向本机消息总线投递一条消息。发长文本同样推荐 --file / --stdin。\n  synapse-agent bridge --title <子串> [--name <管道名>] [--poll 3] [--hub 1|0]\n        一站式桥接：窗口↔总线↔Hub（需已 init）。--hub 1 时窗口新消息会 publish 到 Hub。");
        return;
    }
    if argv.iter().any(|a| a == "--version" || a == "-V") {
        println!("0.5.1");
        return;
    }
    let cfg = Cfg::from_args();
    if cfg.endpoint.starts_with("http://")
        && !cfg.endpoint.contains("127.0.0.1") && !cfg.endpoint.contains("localhost") {
        eprintln!("refuse plaintext http; use https");
        std::process::exit(2);
    }
    fs::create_dir_all(&cfg.dir).ok();
    let agent: Agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(40))
        .user_agent("synapse-agent/0.5.1 (rust)")
        .build();
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
            println!("{}", json!({
                "endpoint": cfg.endpoint, "project": cfg.project, "agent_id": cfg.agent_id,
                "cursor": since, "config": cfg.dir.join("config.json").display().to_string(),
            }));
            return;
        }
        // 长连接优先：连不上（环境不支持/代理拦/握手失败）再退回轮询
        "run" | "ws" => {
            let force_poll = std::env::var("YANSHI_NO_WS").map(|v| v == "1").unwrap_or(false);
            if force_poll {
                if cfg.cmd == "ws" { eprintln!("YANSHI_NO_WS=1 与 ws 冲突"); std::process::exit(2); }
                eprintln!("YANSHI_NO_WS=1：强制轮询");
            } else if run_ws(&cfg, &agent, &base) {
                return;
            } else if cfg.cmd == "ws" {
                eprintln!("长连接建立失败；把子命令换成 run 可自动回退轮询");
                std::process::exit(2);
            } else {
                eprintln!("长连接不可用，回退轮询");
            }
        }
        "wait" => {
            let timeout: u64 = std::env::var("YANSHI_WAIT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            let started = SystemTime::now();
            loop {
                if let Some(m) = poll_once(&cfg, &agent, &base) {
                    println!("{}", serde_json::to_string(&m).unwrap_or_default());
                    send_ack(&cfg, &agent, &base, &m);
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
            let m = admin_get_public(&agent, &base, "/sdk/manifest");
            match m {
                Ok(man) => {
                    let latest = man["version"].as_str().unwrap_or("").to_string();
                    let mine = env!("CARGO_PKG_VERSION").to_string();
                    let upd = latest != mine;
                    if !upd {
                        println!("{}", json!({"current": mine, "latest": latest, "update": false}));
                        return;
                    }
                    if check_only {
                        println!("{}", json!({"current": mine, "latest": latest, "update": true,
                                              "hint": "加 --apply 1 才会真正替换二进制"}));
                        return;
                    }
                    let url = man["binaries"][0]["url"].as_str().unwrap_or("/dl/synapse-agent-x86_64-linux-musl");
                    // 只允许从本站 /dl/ 下载，避免 manifest 被篡改后变成任意 URL
                    if !url.starts_with("/dl/") {
                        eprintln!("manifest 的下载地址不是本站 /dl/：{url}；拒绝升级");
                        std::process::exit(2);
                    }
                    let sha = man["binaries"][0]["sha256"].as_str().unwrap_or("").to_string();
                    // H2 fail-closed：sha 缺失/长度不对/非 hex 一律不替换
                    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                        eprintln!("manifest 缺少有效 sha256（长度须 64 且为 hex）；拒绝升级");
                        std::process::exit(3);
                    }
                    let tmp = format!("{}.new", std::env::current_exe().unwrap().display());
                    match admin_bytes_public(&agent, &base, url) {
                        Ok(b) => {
                            if let Err(e) = fs::write(&tmp, &b) { eprintln!("写临时文件失败：{e}"); std::process::exit(1); }
                            let out = std::process::Command::new("sha256sum").arg(&tmp).output();
                            let got = out.ok().map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap_or("").to_string()).unwrap_or_default();
                            if got.to_lowercase() != sha.to_lowercase() {
                                eprintln!("sha256 不匹配：期望 {sha}，实际 {got}；已放弃替换");
                                let _ = fs::remove_file(&tmp);
                                std::process::exit(4);
                            }
                            // 同机 rename 覆盖正在运行的可执行文件是安全的（inode 保留）
                            match fs::rename(&tmp, std::env::current_exe().unwrap()) {
                                Ok(_) => println!("{}", json!({"ok": true, "from": mine, "to": latest, "bytes": b.len()})),
                                Err(e) => { eprintln!("替换失败：{e}（可能需要写权限，或系统限制）"); std::process::exit(5); }
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
            match admin_get(&cfg, &agent, &base, &format!("/x/admin/p/{}/submissions{}", cfg.project, q)) {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => { eprintln!("subs 失败：{e}"); std::process::exit(1); }
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
            match admin_bytes(&cfg, &agent, &base, &format!("/x/admin/p/{}/submissions/{}/bundle", cfg.project, sid)) {
                Ok(b) => {
                    if let Err(e) = fs::write(&out, &b) { eprintln!("写文件失败：{e}"); std::process::exit(1); }
                    println!("{}", json!({"ok": true, "file": out, "bytes": b.len()}));
                }
                Err(e) => { eprintln!("get 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "peek" => {
            let n = poll_once(&cfg, &agent, &base).map(|_| 1).unwrap_or(0);
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
        "submit" => {
            let kind = args_map.get("kind").cloned().unwrap_or_else(|| "patch".into());
            let title = args_map.get("title").cloned().unwrap_or_default();
            let base_sha = args_map.get("base-sha").cloned();
            let notes = args_map.get("notes").cloned().unwrap_or_default();
            let sid = args_map.get("sid").cloned();
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
                                  base_sha.as_deref(), checks, &notes, sid.as_deref()) {
                Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_default()),
                Err(e) => { eprintln!("submit 失败：{e}"); std::process::exit(1); }
            }
            return;
        }
        "deliver" => {
            // 一条龙：上传 → 建交付，专为回合制 agent 一次工具调用完成交付。
            let file = args_map.get("file").cloned().unwrap_or_default();
            if file.is_empty() { eprintln!("deliver 需要 --file <path>"); std::process::exit(2); }
            let kind = args_map.get("kind").cloned().unwrap_or_else(|| "patch".into());
            let title = args_map.get("title").cloned().unwrap_or_default();
            let base_sha = args_map.get("base-sha").cloned();
            let notes = args_map.get("notes").cloned().unwrap_or_default();
            let sid = args_map.get("sid").cloned();
            let checks: Value = args_map.get("checks")
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| json!({}));
            let up = match artifact_upload(&cfg, &agent, &base, &file) {
                Ok(v) => v,
                Err(e) => { eprintln!("deliver/upload 失败：{e}"); std::process::exit(1); }
            };
            let refs = vec![up["ref"].clone()];
            let sub = match artifact_submit(&cfg, &agent, &base, &kind, &title, refs,
                                            base_sha.as_deref(), checks, &notes, sid.as_deref()) {
                Ok(v) => v,
                Err(e) => { eprintln!("deliver/submit 失败（文件已上传，ref={}）：{e}", up["sha256"]); std::process::exit(1); }
            };
            println!("{}", serde_json::to_string(&json!({
                "ok": true, "sha256": up["sha256"], "bytes": up["bytes"],
                "submission_id": sub["submission_id"], "state": sub["state"], "seq": sub["seq"]
            })).unwrap_or_default());
            return;
        }

        // ── 本地窗口桥（Windows） ───────────────────────────────
        "win-config" => {
            // 配置默认窗口目标，写入 ~/.synapse-agent/config.json 的 window_app 字段。
            // 用法：win-config --app 豆包   （设置）
            //       win-config --show         （查看当前）
            //       win-config --clear        （清除）
            let cfg_path = cfg.dir.join("config.json");
            let mut saved: Value = fs::read_to_string(&cfg_path)
                .ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
            let show = flags.contains("show");
            let clear = flags.contains("clear");
            if let Some(app) = args_map.get("app").cloned() {
                saved["window_app"] = json!(app);
                if fs::write(&cfg_path, serde_json::to_string_pretty(&saved).unwrap_or_default()).is_err() {
                    eprintln!("写入配置失败：{cfg_path:?}"); std::process::exit(1);
                }
                println!("{}", json!({
                    "ok": true, "op": "win-config-set", "window_app": app,
                    "config": cfg_path.to_string_lossy()
                }));
            } else if clear {
                saved.as_object_mut().map(|o| o.remove("window_app"));
                let _ = fs::write(&cfg_path, serde_json::to_string_pretty(&saved).unwrap_or_default());
                println!("{}", json!({"ok": true, "op": "win-config-clear"}));
            } else {
                let cur = saved["window_app"].as_str().unwrap_or("");
                println!("{}", json!({
                    "op": "win-config-show", "window_app": cur,
                    "config": cfg_path.to_string_lossy(),
                    "from_env": std::env::var("SYNAPSE_WINDOW_APP").unwrap_or_default()
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
            let click_x = args_map.get("click-x").and_then(|s| s.parse().ok()).unwrap_or(0.53);
            let click_y = args_map.get("click-y").and_then(|s| s.parse().ok()).unwrap_or(0.83);
            let w = match resolve_target(&app, &title, &cfg.window_app) {
                Ok(w) => w, Err(e) => { eprintln!("{e}"); std::process::exit(1); }
            };
            let mut results = json!({});
            if method == "click" || method.is_empty() || method == "both" {
                match winmsg::send_text_click_paste(w.hwnd, &text, enter, click_x, click_y) {
                    Ok(_) => results["click-paste"] = json!({"ok": true}),
                    Err(e) => results["click-paste"] = json!({"ok": false, "error": e}),
                }
            }
            if method == "paste" || method == "both" {
                match winmsg::send_text_paste(w.hwnd, &text, enter) {
                    Ok(_) => results["paste"] = json!({"ok": true}),
                    Err(e) => results["paste"] = json!({"ok": false, "error": e}),
                }
            }
            if method == "copy" || method == "both" {
                match winmsg::send_text_copydata(w.hwnd, &text, 2000) {
                    Ok(r) => results["copydata"] = json!({"ok": true, "result": r}),
                    Err(e) => results["copydata"] = json!({"ok": false, "error": e}),
                }
            }
            println!("{}", json!({
                "module": "winmsg", "op": "send", "title": w.title,
                "hwnd": w.hwnd, "method": method, "results": results
            }));
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

            // 总线监听线程：配置程序写入的消息 → 打印 + 写入窗口；可选上报 Hub
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
                            for line in fresh {
                                let msg = localbus::make_msg("in", &w.title, "announce", &line, json!({}));
                                println!("{}", json!({
                                    "module": "bridge", "from": "window", "text": line
                                }));
                                let _ = localbus::send_one(&name, &msg, false);
                                if to_hub {
                                    if let Err(e) = publish_to_hub(&cfg, &agent, &base, "announce", &line, json!({})) {
                                        eprintln!("[bridge] 上报 Hub 失败：{e}");
                                    }
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

    let mut hb: u64 = 0;
    let cpu_prev: Option<(u64, u64)> = None;

    loop {
        hb += 1;
        let mut load = json!({});
        if let Some(l) = load1() { load["load1"] = json!(l); }
        if let Some((u, t)) = mem_mb() { load["mem_used_mb"] = json!(u); load["mem_total_mb"] = json!(t); }
        load["disk"] = disk();
        let _ = cpu_prev; // 占位：CPU 差值实现留待 P1 完善

        let body = json!({
            "hb": hb, "agent_id": cfg.agent_id, "work": {"state": "idle"},
            "load": load, "env": {"git_head": git_head()}, "sdk_version": env!("CARGO_PKG_VERSION"),
        });
        let hb_res = agent
            .post(&format!("{}/p/{}/heartbeat", base, cfg.project))
            .set("authorization", &format!("Bearer {}", cfg.token))
            .set("x-sdk-version", env!("CARGO_PKG_VERSION"))
            .send_json(body);
        println!("heartbeat hb={} -> {}", hb, hb_res.is_ok());

        // 拉取消息
        let since = cursor_get(&cfg.dir);
        let url = format!("{}/p/{}/inbox?since={}", base, cfg.project, since);
        if let Ok(r) = agent.get(&url).set("authorization", &format!("Bearer {}", cfg.token)).call() {
            if let Ok(v) = r.into_json::<Value>() {
                if let Some(msgs) = v["messages"].as_array() {
                    for m in msgs {
                        if let Some(seq) = m["seq"].as_u64() { cursor_set(&cfg.dir, seq); }
                        let noisy = m["topic"].as_str() == Some("ack")
                            || (m["sender"].as_str() == Some(cfg.agent_id.as_str()) && m["to"].is_null());
                        if noisy { continue; }
                        println!("msg seq={} topic={}", m["seq"], m["topic"]);
                        let msg: Value = m.clone();
                        send_ack(&cfg, &agent, &base, &msg);
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(cfg.heartbeat_s));
    }
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
    base_sha: Option<&str>, checks: Value, notes: &str, sid: Option<&str>,
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
    let body = json!({
        "submission_id": sid.map(|s| s.to_string()).unwrap_or_else(|| new_submission_id(&cfg.agent_id)),
        "agent_id": cfg.agent_id,
        "kind": if kind.is_empty() { "patch" } else { kind },
        "title": title,
        "refs": refs,
        "base_sha": sha,
        "checks": checks,
        "notes": notes,
    });
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

fn poll_once(cfg: &Cfg, agent: &Agent, base: &str) -> Option<Value> {
    let since = cursor_get(&cfg.dir);
    let url = format!("{}/p/{}/inbox?since={}&limit=10&agent={}", base, cfg.project, since,
                      urlencode(&cfg.agent_id));
    let r = agent.get(&url).set("authorization", &format!("Bearer {}", cfg.token)).call().ok()?;
    let mut v: Value = r.into_json().ok()?;
    let ep = v["epoch"].as_str().unwrap_or("").to_string();
    if !ep.is_empty() && epoch_get(&cfg.dir) != ep {
        cursor_set(&cfg.dir, 0);          // 房间重建：游标归零重来
    }
    if !ep.is_empty() { epoch_set(&cfg.dir, &ep); }
    let mut msgs: Vec<Value> = v["messages"].as_array()?.clone();
    // 自己的 ack / 自己发的广播不进队列，否则会自问自答形成回声
    msgs.retain(|m| {
        let noisy = m["topic"].as_str() == Some("ack")
            || (m["sender"].as_str() == Some(cfg.agent_id.as_str()) && m["to"].is_null());
        !noisy
    });
    if msgs.is_empty() { return None; }
    let mut pages = 1;
    // 积压超过一页就续拉（否则旧消息会把新指令压在后面）
    while v["has_more"].as_bool().unwrap_or(false) && pages < 5 {
        let last = msgs.last()?["seq"].as_u64()?;
        let next = format!("{}/p/{}/inbox?since={}&limit=10&agent={}", base, cfg.project, last,
                           urlencode(&cfg.agent_id));
        match agent.get(&next).set("authorization", &format!("Bearer {}", cfg.token)).call() {
            Ok(r2) => {
                v = r2.into_json().ok()?;
                let more: Vec<Value> = v["messages"].as_array()?.clone().into_iter().filter(|m| {
                    let noisy = m["topic"].as_str() == Some("ack")
                        || (m["sender"].as_str() == Some(cfg.agent_id.as_str()) && m["to"].is_null());
                    !noisy
                }).collect();
                if more.is_empty() { break; }
                msgs.extend(more);
                pages += 1;
            }
            Err(_) => break,
        }
    }
    let first = msgs.first()?.clone();
    if msgs.len() > 1 { eprintln!("还有 {} 条积压，下轮继续", msgs.len() - 1); }
    if let Some(seq) = first["seq"].as_u64() { cursor_set(&cfg.dir, seq); }
    Some(first)
}

/// 需要回执时回执，失败不影响主流程
fn send_ack(cfg: &Cfg, agent: &Agent, base: &str, m: &Value) {
    let required = m["payload"]["action_required"]["ack_required"].as_bool().unwrap_or(false);
    if !required { return; }
    let body = json!({"seq": m["seq"], "agent_id": cfg.agent_id, "status": "done",
                      "detail": {"note": "rust sdk 已自动回执"}});
    let _ = agent
        .post(&format!("{}/p/{}/ack", base, cfg.project))
        .set("authorization", &format!("Bearer {}", cfg.token))
        .send_json(body);
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}


 /// 取一次性 WS 票据
fn ws_ticket(cfg: &Cfg, agent: &Agent, base: &str) -> Option<String> {
    let r = agent
        .get(&format!("{}/p/{}/ws-ticket", base, cfg.project))
        .set("authorization", &format!("Bearer {}", cfg.token))
        .call().ok()?;
    let v: Value = r.into_json().ok()?;
    v["ticket"].as_str().map(|s| s.to_string())
}

fn heartbeat_payload(cfg: &Cfg, hb: u64) -> Value {
    let mut load = json!({});
    if let Some(l) = load1() { load["load1"] = json!(l); }
    if let Some((u, t)) = mem_mb() { load["mem_used_mb"] = json!(u); load["mem_total_mb"] = json!(t); }
    load["disk"] = disk();
    json!({"hb": hb, "agent_id": cfg.agent_id, "work": {"state": "idle"},
           "load": load, "env": {"git_head": git_head()}, "sdk_version": env!("CARGO_PKG_VERSION")})
}

/// WebSocket 长连接：收到消息立即打印并回执；心跳在独立线程里。
/// 返回 false 表示一次都没连上（调用方据此回退轮询）。
fn run_ws(cfg: &Cfg, agent: &Agent, base: &str) -> bool {
    let ws_base = base.replace("https://", "wss://").replace("http://", "ws://");
    let (tx, rx) = mpsc::channel::<String>();
    let state = Arc::new(Mutex::new(("idle".to_string(), String::new(), 0usize)));
    let connected = Arc::new(Mutex::new(false));

    // 收件线程：连接、收、断线重连；任务执行期间照常入队
    {
        let (cfg2, agent2, base2) = (cfg.clone_lite(), agent.clone(), base.to_string());
        let tx2 = tx.clone();
        let connected2 = connected.clone();
        thread::spawn(move || {
            let mut backoff = 1u64;
            loop {
                let Some(ticket) = ws_ticket(&cfg2, &agent2, &base2) else {
                    thread::sleep(Duration::from_secs(backoff));
                    backoff = (backoff * 2).min(30);
                    continue;
                };
                let url = format!("{}/p/{}/ws?ticket={}", ws_base, cfg2.project, ticket);
                match connect(&url) {
                    Ok((mut sock, _r)) => {
                        *connected2.lock().unwrap() = true;
                        backoff = 1;
                        println!("ws connected {}", url.split("/ws?").next().unwrap_or(""));
                        loop {
                            match sock.read() {
                                Ok(Message::Text(t)) => {
                                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                                        if v["type"] == "msg" {
                                            // 只把"给我的"和"广播"入队；别人的定向消息与 ack 噪音不收
                                            let mine = v["to"].is_null()
                                                || v["to"].as_str() == Some(cfg2.agent_id.as_str());
                                            let noisy = v["topic"].as_str() == Some("ack")
                                                || v["sender"].as_str() == Some(cfg2.agent_id.as_str());
                                            if !mine || noisy { continue; }
                                            if let Some(seq) = v["seq"].as_u64() {
                                                cursor_set(&cfg2.dir, seq);
                                            }
                                            send_ack(&cfg2, &agent2, &base2, &v);
                                            let _ = tx2.send(t);
                                        }
                                    }
                                }
                                Ok(Message::Ping(p)) => { let _ = sock.send(Message::Pong(p)); }
                                Ok(Message::Close(_)) | Err(_) => break,
                                Ok(_) => {}
                            }
                        }
                        *connected2.lock().unwrap() = false;
                    }
                    Err(e) => {
                        if !*connected2.lock().unwrap() && backoff >= 4 {
                            eprintln!("ws connect failed: {e}");
                            return;              // 一次都没连上 → 让上层回退轮询
                        }
                        eprintln!("ws 断开: {e}");
                    }
                }
                thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(30);
            }
        });
    }

    // 心跳线程：状态取自共享变量，能看到"在忙什么 + 队列积压"
    {
        let (agent2, base2, proj, tok, aid, period) =
            (agent.clone(), base.to_string(), cfg.project.clone(), cfg.token.clone(),
             cfg.agent_id.clone(), cfg.heartbeat_s);
        let st = state.clone();
        thread::spawn(move || {
            let mut hb = 0u64;
            loop {
                hb += 1;
                let (ws, ph, q) = { let g = st.lock().unwrap(); (g.0.clone(), g.1.clone(), g.2) };
                let body = json!({"hb": hb, "agent_id": aid, "work": {"state": ws, "phase": ph},
                                  "load": {"disk": disk()}, "sdk_version": env!("CARGO_PKG_VERSION"), "queue": q});
                let _ = agent2.post(&format!("{}/p/{}/heartbeat", base2, proj))
                    .set("authorization", &format!("Bearer {}", tok))
                    .send_json(body);
                thread::sleep(Duration::from_secs(period));
            }
        });
    }

    // 主线程：取任务 → 执行；执行期间收件线程继续入队
    let mut seen_any = false;
    loop {
        let Ok(task) = rx.recv() else { break };
        seen_any = true;
        let title = serde_json::from_str::<Value>(&task).ok()
            .and_then(|v| v["payload"]["title"].as_str().map(|x| x.to_string()))
            .unwrap_or_default();
        { let mut g = state.lock().unwrap(); g.0 = "busy".into(); g.1 = title.clone(); }
        if let Some(cmd) = &cfg.exec_cmd {
            let mut child = std::process::Command::new("sh")
                .arg("-c").arg(cmd)
                .stdin(std::process::Stdio::piped())
                .spawn().expect("exec 启动失败");
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(format!("{task}\n").as_bytes());
            }
            let _ = child.wait();
        } else {
            println!("{task}");
        }
        { let mut g = state.lock().unwrap(); g.0 = "idle".into(); g.1 = "等指令".into(); }
    }
    seen_any
}
