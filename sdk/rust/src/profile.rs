//! 运行环境自检：判断跑在哪类 agent / 哪类机器，给出传输与节流默认值。
use serde_json::{json, Value};
use std::env;

pub fn detect() -> Value {
    let envs: Vec<String> = env::vars().map(|(k, _)| k).collect();
    let has = |needle: &str| envs.iter().any(|k| k.to_uppercase().contains(needle));

    // 1) 哪类 agent 宿主
    let runtime = if has("DOUBAO") || has("DOUBAOSESSION") {
        "doubao"
    } else if has("WORKERBODY") || has("WORKER_BODY") {
        "workerbody"
    } else if has("GITHUB_ACTIONS") || has("CI") {
        "ci"
    } else {
        "generic"
    };

    // 2) 本地还是云机：容器/云厂商标记 + 明确的 YANSHI_HOST
    let cloud_marker = has("KUBERNETES") || has("CF_") || has("AWS_") || has("ALIYUN")
        || has("TENCENT") || has("VERCEL") || has("FLY_") || std::path::Path::new("/.dockerenv").exists();
    let host = match env::var("YANSHI_HOST").ok().as_deref() {
        Some("cloud") => "cloud",
        Some("local") => "local",
        _ if cloud_marker => "cloud",
        _ => "local",
    };

    // 3) 网络能力：能否出站长连接（保守默认，靠 Loop 的探针最终裁决）
    let ws_blocked = env::var("YANSHI_NO_WS").map(|v| v == "1").unwrap_or(false);

    let (transport, heartbeat, poll, probe, queue) =
        if ws_blocked || runtime == "ci" {
            ("poll", 120u64, 10u64, 0u64, 50usize)          // 禁长连 / CI 短生命周期
        } else if runtime == "doubao" && host == "local" {
            ("ws", 30, 4, 4, 200)
        } else if runtime == "doubao" {
            ("ws", 30, 3, 4, 200)
        } else if runtime == "workerbody" {
            ("ws", 60, 5, 4, 500)
        } else if host == "cloud" {
            ("ws", 45, 4, 4, 300)
        } else {
            ("ws", 60, 5, 4, 200)                            // 通用本地：ws 优先，失败回退
        };

    json!({
        "runtime": runtime, "host": host, "ws_blocked": ws_blocked,
        "transport": transport, "heartbeat_s": heartbeat, "poll_s": poll,
        "ws_probe_s": probe, "queue_max": queue,
        "reason": match (runtime, host) {
            ("doubao","cloud") => "豆包云会话：长连优先，心跳 30s",
            ("doubao","local") => "豆包本地：长连优先，心跳 30s",
            ("workerbody", _) => "WorkerBody：队列大、心跳 60s",
            ("ci", _) => "CI 短生命周期：轮询 + 10s 间隔",
            ("generic","cloud") => "通用云机：长连优先",
            _ => "通用本地：长连优先，失败回退轮询",
        }
    })
}
