"""运行环境自检：判断跑在哪类 agent 宿主、本地还是云机，给出传输与节流默认值。

设计原则：默认最优（长连接 + 异步队列），条件不满足就逐级回退：
    长连接 → 长连接（探针 4s）失败 → 轮询（poll_s）
宿主机类型只影响“默认参数”，不改变协议。
"""
from __future__ import annotations

import os
import platform
from pathlib import Path


def _has(*needles: str) -> bool:
    keys = " ".join(os.environ.keys()).upper()
    return any(n.upper() in keys for n in needles)


def _in_container() -> bool:
    if Path("/.dockerenv").exists():
        return True
    try:
        cg = Path("/proc/1/cgroup").read_text()
        return any(x in cg for x in ("docker", "kubepods", "containerd"))
    except Exception:                                   # noqa: BLE001
        return False


def detect(agent_id: str | None = None) -> dict:
    """返回 profile 字典；纯本地判断，不联网、不读凭据。"""
    runtime = "generic"
    if _has("DOUBAO") or (agent_id or "").startswith("doubao"):
        runtime = "doubao"
    elif _has("WORKERBODY", "WORKER_BODY"):
        runtime = "workerbody"
    elif _has("GITHUB_ACTIONS") or os.environ.get("CI"):
        runtime = "ci"

    cloud_marker = _in_container() or _has("KUBERNETES", "CF_", "AWS_", "ALIYUN", "TENCENT",
                                           "VERCEL", "FLY_", "GOOGLE_CLOUD")
    forced = os.environ.get("YANSHI_HOST")
    host = forced if forced in ("cloud", "local") else ("cloud" if cloud_marker else "local")

    ws_blocked = os.environ.get("YANSHI_NO_WS") == "1"

    if ws_blocked or runtime == "ci":
        transport, heartbeat, poll, probe, queue = "poll", 120, 10, 0, 50
    elif runtime == "doubao" and host == "local":
        transport, heartbeat, poll, probe, queue = "ws", 30, 4, 4, 200
    elif runtime == "doubao":
        transport, heartbeat, poll, probe, queue = "ws", 30, 3, 4, 200
    elif runtime == "workerbody":
        transport, heartbeat, poll, probe, queue = "ws", 60, 5, 4, 500
    elif host == "cloud":
        transport, heartbeat, poll, probe, queue = "ws", 45, 4, 4, 300
    else:
        transport, heartbeat, poll, probe, queue = "ws", 60, 5, 4, 200

    reasons = {
        ("doubao", "cloud"): "豆包云会话：长连优先，心跳 30s",
        ("doubao", "local"): "豆包本地：长连优先，心跳 30s",
        ("workerbody", "cloud"): "WorkerBody：队列大、心跳 60s",
        ("workerbody", "local"): "WorkerBody：队列大、心跳 60s",
        ("ci", "cloud"): "CI 短生命周期：轮询 + 10s 间隔",
        ("ci", "local"): "CI 短生命周期：轮询 + 10s 间隔",
        ("generic", "cloud"): "通用云机：长连优先，失败回退轮询",
        ("generic", "local"): "通用本地：长连优先，失败回退轮询",
    }
    return {
        "runtime": runtime, "host": host, "ws_blocked": ws_blocked,
        "os": platform.platform(), "python": platform.python_version(),
        "transport": transport, "heartbeat_s": heartbeat, "poll_s": poll,
        "ws_probe_s": probe, "queue_max": queue,
        "reason": ("环境变量 YANSHI_NO_WS=1：强制轮询" if ws_blocked else reasons.get((runtime, host), "")),
    }
