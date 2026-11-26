"""synapse Python SDK：心跳托管 + 游标续传 + 离线队列 + 交付上传。"""
from __future__ import annotations

import json
import hashlib
import os
import platform
import random
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import quote

import requests

__version__ = "0.5.12"

class SynapseAPIError(RuntimeError):
    """服务端 4xx/5xx：保留 code/hint/use，agent 可以直接照着下一步调用。"""
    def __init__(self, status: int, payload: Any):
        self.status = int(status)
        self.payload = payload if isinstance(payload, dict) else {"error": str(payload)[:500]}
        self.code = str(self.payload.get("error") or self.payload.get("code") or status)
        self.hint = self.payload.get("hint")
        self.use = self.payload.get("use")
        msg = f"HTTP {self.status} {self.code}"
        if self.hint: msg += f"｜{self.hint}"
        if self.use: msg += f"｜next={json.dumps(self.use, ensure_ascii=False)}"
        super().__init__(msg)

def _state_dir() -> Path:
    new = os.environ.get("SYNAPSE_STATE_DIR") or os.environ.get("YANSHI_STATE_DIR")
    if new: return Path(new)
    base = Path.home() / ".synapse-agent"
    legacy = Path.home() / ".yanshi-agent"
    if not base.exists() and legacy.exists(): return legacy
    return base

CONFIG_DIR = _state_dir()

_LAUNCH_SECRET_FLAGS = {"--token", "--admin-token", "--api-key", "--secret", "--password", "--proxy"}


def _redacted_argv(argv: list[str], limit: int = 64) -> list[str]:
    """管理台只展示启动现场；token/代理密码等敏感参数在客户端先脱敏。"""
    out: list[str] = []
    hide_next = False
    for raw in argv[:limit]:
        s = str(raw)[:512]
        if hide_next:
            out.append("***")
            hide_next = False
            continue
        lower = s.lower()
        if lower in _LAUNCH_SECRET_FLAGS:
            out.append(s)
            hide_next = True
        elif any(lower.startswith(k + "=") for k in
                 ("--token", "--admin-token", "--api-key", "--secret", "--password", "--proxy")):
            out.append(s.split("=", 1)[0] + "=***")
        else:
            out.append(s)
    return out


@dataclass
class Work:
    state: str = "idle"          # busy | idle | blocked
    task_id: str | None = None
    phase: str | None = None
    progress_pct: int | None = None


class TaskLease:
    """with c.task('UI-0049'): …  —— 进入即认领，心跳自动续租，退出即交还。"""

    def __init__(self, client: "Client", task_id: str):
        self.c, self.task_id = client, task_id
        self._stop = threading.Event()
        self._renew: threading.Thread | None = None

    def _renew_loop(self) -> None:
        # 默认 12h 租约，每 4 分钟重认领一次（同 owner 幂等，只续 lease_until）。
        while not self._stop.wait(240):
            try:
                self.c._post(f"/p/{self.c.project}/tasks/claim", {"task_id": self.task_id})
            except Exception:                      # noqa: BLE001
                pass                               # 网络抖动下一轮再续

    def __enter__(self):
        # 直接 new Client(...) 而不是 from_config 时也需要心跳续租，否则长任务
        # 租约到期会被别的节点抢走。
        self.c.start_heartbeat()
        r = self.c._post(f"/p/{self.c.project}/tasks/claim", {"task_id": self.task_id})
        if not r.get("ok"):
            raise RuntimeError(f"claim failed: {r}")
        self.c._active_task_set(self.task_id)
        self.c.work(Work(state="busy", task_id=self.task_id))
        self._renew = threading.Thread(target=self._renew_loop, daemon=True, name="synapse-task-lease")
        self._renew.start()
        return self

    def __exit__(self, exc_type, *_):
        self._stop.set()
        if self._renew and self._renew.is_alive():
            self._renew.join(timeout=1)
        state = "done" if exc_type is None else "blocked"
        try:
            self.c._post(f"/p/{self.c.project}/tasks/release", {"task_id": self.task_id, "state": state})
        finally:
            self.c._active_task_clear(self.task_id)
            self.c.work(Work(state="idle"))


class Client:
    def __init__(self, endpoint: str, project: str, token: str, agent_id: str,
                 state_dir: Path | None = None, heartbeat_s: int = 60):
        self.endpoint = endpoint.rstrip("/")
        self.project = project
        self._token = token
        self.agent_id = agent_id
        self.state_dir = Path(state_dir or CONFIG_DIR)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.heartbeat_s = heartbeat_s
        self._started_at_ms = int(time.time() * 1000)
        self._work = Work()
        self._hb_seq = 0
        self._cpu_prev = self._read_stat()
        self._stop = threading.Event()
        self._hb_thread: threading.Thread | None = None
        # 事件订阅与消息订阅分离：事件只通知，不进入任务队列，不会误触 exec/窗口注入。
        self._event_handlers: list = []
        self._event_lock = threading.Lock()
        # 服务端远程控制：只保存期望状态，真正生效在心跳响应解析后。
        self._remote_control: dict | None = None
        self._remote_rev = 0
        self._remote_applied_ms = 0
        self._need_launch = True
        self._debug_logs: list[dict] = []
        self._client_errors: list[dict] = []
        self._delivery_health = {
            "last_attempt_ms": 0, "last_ok_ms": 0, "last_error": "", "consecutive_failures": 0,
        }
        self._load_error_outbox()
        self._install_exception_hooks()
        # 默认直连（NO_PROXY=* 这类环境里 requests 仍可能把 localhost 代理配置套上去）；
        # 需要走公司代理时显式设置 SYNAPSE_TRUST_ENV=1。
        self._sess = requests.Session()
        self._sess.trust_env = os.environ.get("SYNAPSE_TRUST_ENV", "0") == "1"

        # 安全：禁止明文 http（本地调试除外）
        if self.endpoint.startswith("http://") and "127.0.0.1" not in self.endpoint and "localhost" not in self.endpoint:
            raise ValueError("refuse plaintext http; use https")

    # ── 构造与初始化 ─────────────────────────────────────────
    @classmethod
    def from_config(cls, path: Path | None = None, auto: bool = True) -> "Client":
        """auto=True（默认）：构造即启动后台心跳线程，调用方无需再手动 heartbeat。"""
        cfg_path = Path(path or CONFIG_DIR / "config.json")
        if not cfg_path.exists():
            legacy = Path.home() / ".yanshi-agent" / "config.json"
            if legacy.exists(): cfg_path = legacy
        cfg = json.loads(cfg_path.read_text())
        token = os.environ.get("SYNAPSE_TOKEN") or os.environ.get("YANSHI_TOKEN") or cfg["token"]
        c = cls(cfg["endpoint"], cfg["project"], token, cfg["agent_id"],
                state_dir=cfg.get("state_dir"), heartbeat_s=int(cfg.get("heartbeat_s", 60)))
        if auto:
            c.start_heartbeat()
        return c

    @classmethod
    def init(cls, endpoint: str, project: str, token: str, agent_id: str | None = None,
             force: bool = False) -> "Client":
        """安装时调用一次：写入配置（chmod 600）+ 发首拍心跳验证。

        已有 config.json 先备份；文档模板身份直接拒绝；换 token 需 force=True，
        避免示例命令静默覆盖唯一明文 token（服务端只存 token_sha，无法找回）。
        """
        ep = endpoint.rstrip("/")
        if "example.com" in ep.lower() or "example.org" in ep.lower() or "<endpoint>" in ep.lower():
            raise ValueError("refuse init template endpoint")
        if project.strip() in {"p", "<project>", "project", "your-project"}:
            raise ValueError("refuse init template project")
        if (agent_id or "").strip() in {"a", "<agent>", "agent", "your-agent"}:
            raise ValueError("refuse init template agent")
        if token.strip() in {"t", "<t>", "<token>", "token", "your-token", "..."}:
            raise ValueError("refuse init template token")
        agent_id = agent_id or f"agent-{uuid.uuid4().hex[:6]}"
        d = CONFIG_DIR
        d.mkdir(parents=True, exist_ok=True)
        from .profile import detect
        prof = detect(agent_id)
        cfg_path = d / "config.json"
        old: dict[str, Any] = {}
        if cfg_path.exists():
            try:
                old = json.loads(cfg_path.read_text())
            except Exception:
                old = {}
            old_token = str(old.get("token") or "")
            if old_token and old_token != token and not force:
                raise ValueError("config.json exists with a different token; pass force=True to rotate (backup is kept)")
            backup = cfg_path.with_name(f"{cfg_path.name}.bak-{int(time.time())}")
            n = 1
            while backup.exists():
                backup = cfg_path.with_name(f"{cfg_path.name}.bak-{int(time.time())}-{n}")
                n += 1
            backup.write_bytes(cfg_path.read_bytes())
            os.chmod(backup, 0o600)
        # 保留 notify_cmd/tmux/window 等已有键，只覆盖身份字段。
        cfg = {**old, "endpoint": ep, "project": project, "agent_id": agent_id,
               "token": token, "heartbeat_s": int(prof["heartbeat_s"]), "state_dir": str(d)}
        # 先以 600 建文件再写：避免默认 umask 下的明文窗口
        cfg_tmp = cfg_path.with_suffix(".tmp")
        old_umask = os.umask(0o077)
        try:
            cfg_tmp.write_text(json.dumps(cfg, indent=2))
        finally:
            os.umask(old_umask)
        os.chmod(cfg_tmp, 0o600)
        os.replace(cfg_tmp, cfg_path)
        c = cls(endpoint, project, token, agent_id, state_dir=d)
        r = c.heartbeat_once()
        if not r.get("ok"):
            raise RuntimeError(f"heartbeat rejected: {r}")
        return c

    # ── 状态呈现 ─────────────────────────────────────────────
    def work(self, w: Work | None = None, **kw) -> Work:
        if w is not None:
            self._work = w
        elif kw:
            self._work = Work(**{**asdict(self._work), **kw})
        return self._work

    def status(self) -> dict:
        return {
            "endpoint": self.endpoint, "project": self.project, "agent_id": self.agent_id,
            "token": self._mask(self._token), "cursor": self._cursor_load(), "outbox": self._outbox_count(),
            "delivery_health": dict(self._delivery_health),
            "remote_control": dict(self._remote_control) if self._remote_control else None,
            "debug": self._debug_enabled(),
        }

    # ── 客户端诊断与远程控制 ─────────────────────────────────
    def _error_outbox_path(self) -> Path:
        return self.state_dir / "error-outbox.json"

    def _load_error_outbox(self) -> None:
        try:
            items = json.loads(self._error_outbox_path().read_text())
            if isinstance(items, list):
                self._client_errors = items[:20]
        except Exception:
            self._client_errors = []

    def _save_error_outbox(self) -> None:
        try:
            self._error_outbox_path().write_text(
                json.dumps(self._client_errors[-20:], ensure_ascii=False))
        except Exception:
            pass

    def _record_error(self, kind: str, message: str, detail: str | None = None) -> None:
        now = int(time.time() * 1000)
        self._client_errors.append({
            "id": f"{now}-{uuid.uuid4().hex[:6]}",
            "ts": now, "kind": kind,
            "message": str(message)[:500],
            "detail": (str(detail)[:1200] if detail else None),
        })
        self._client_errors = self._client_errors[-20:]
        self._save_error_outbox()
        self._debug_log("error", str(message))

    def _debug_log(self, level: str, msg: str) -> None:
        self._debug_logs.append({
            "ts": int(time.time() * 1000), "level": level, "msg": str(msg)[:600],
        })
        self._debug_logs = self._debug_logs[-60:]

    def _install_exception_hooks(self) -> None:
        old_sys = sys.excepthook
        def sys_hook(exc_type, exc, tb):
            try:
                self._record_error("exception", f"{exc_type.__name__}: {exc}",
                                   "".join(traceback.format_exception(exc_type, exc, tb)))
            finally:
                old_sys(exc_type, exc, tb)
        sys.excepthook = sys_hook

        old_thread = threading.excepthook
        def thread_hook(args):
            try:
                self._record_error("exception",
                                   f"{args.exc_type.__name__}: {args.exc_value}",
                                   "".join(traceback.format_exception(
                                       args.exc_type, args.exc_value, args.exc_traceback)))
            finally:
                old_thread(args)
        threading.excepthook = thread_hook

    def _apply_remote_control(self, control: Any) -> None:
        prev = self._remote_rev
        prev_control = self._remote_control
        if not isinstance(control, dict):
            had_control = bool(prev or prev_control)
            self._remote_control = None
            self._remote_rev = 0
            if had_control:
                self._remote_applied_ms = int(time.time() * 1000)
                self._need_launch = True
                self._debug_log("info", "remote control cleared; follow local config")
            return
        try:
            rev = int(control.get("rev") or 0)
        except Exception:
            rev = 0
        if rev and rev < prev:
            return
        try:
            hb_s = int(control.get("heartbeat_s") or 0)
        except Exception:
            hb_s = 0
        next_control = {
            "rev": rev,
            "auto_forward": control.get("auto_forward") if control.get("auto_forward") in ("inherit", "on", "off") else "inherit",
            "debug": bool(control.get("debug")),
            "heartbeat_s": hb_s if 15 <= hb_s <= 300 else 0,
        }
        changed = next_control != prev_control
        self._remote_control = next_control
        self._remote_rev = rev
        if changed:
            self._remote_applied_ms = int(time.time() * 1000)
            self._need_launch = True
            self._debug_log("info", f"remote control applied rev={rev}")

    def _auto_mode(self) -> str:
        return (self._remote_control or {}).get("auto_forward", "inherit")

    def _auto_enabled(self, notify: str | None = None) -> bool:
        notify = self._notify_cmd() if notify is None else notify
        if not notify:
            return False
        return self._auto_mode() != "off"

    def _debug_enabled(self) -> bool:
        return bool((self._remote_control or {}).get("debug"))

    def _heartbeat_s(self) -> int:
        remote = int((self._remote_control or {}).get("heartbeat_s") or 0)
        return remote if 15 <= remote <= 300 else self.heartbeat_s

    def _debug_payload(self) -> dict:
        if not self._debug_enabled():
            return {"enabled": False}
        return {"enabled": True, "logs": self._debug_logs[-60:]}

    def _launch_hash(self, launch: dict) -> str:
        import hashlib
        raw = json.dumps(launch, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    # ── 心跳 ─────────────────────────────────────────────────
    def _launch_snapshot(self) -> dict:
        """SDK 进程的启动现场；Python SDK 没有窗口/tmux 注入，notify_cmd 是关键外部投递配置。"""
        notify = self._notify_cmd()
        try:
            cwd = os.getcwd()
        except Exception:
            cwd = ""
        mode = self._auto_mode()
        enabled = self._auto_enabled(notify)
        control = {
            "rev": self._remote_rev,
            "auto_forward": mode,
            "debug": self._debug_enabled(),
            "heartbeat_s": self._heartbeat_s(),
            "applied_at": self._remote_applied_ms,
        }
        sources = {
            "notify_cmd": "config" if notify else "default",
            "auto_forward": "remote" if mode != "inherit" else ("config" if notify else "default"),
            "debug": "remote" if self._remote_rev else "default",
            "heartbeat_s": "remote" if (self._remote_control or {}).get("heartbeat_s") else "config",
        }
        return {
            "schema": "synapse.launch.v1",
            "kind": "python",
            "version": __version__,
            "started_at": self._started_at_ms,
            "argv": _redacted_argv(sys.argv),
            "cwd": cwd,
            "config_dir": str(self.state_dir),
            "platform": platform.system().lower(),
            "arch": platform.machine(),
            "pid": os.getpid(),
            "sources": sources,
            "control": control,
            "delivery": {
                "auto": enabled,
                "kind": "notify_cmd" if enabled else "none",
                "target": "",
                "window_forward": False,
                "tmux_forward": False,
                "tmux_verify": True,
            },
            "effective": {
                "cmd": "sdk",
                "role": "agent",
                "agent_id": self.agent_id,
                "project": self.project,
                "heartbeat_s": self._heartbeat_s(),
                "config_dir": str(self.state_dir),
                "notify_cmd": "configured" if notify else None,
                "auto_forward": mode,
                "debug": self._debug_enabled(),
            },
        }

    def heartbeat_once(self) -> dict:
        self._hb_seq += 1
        launch = self._launch_snapshot()
        enabled = bool(launch["delivery"]["auto"])
        include_launch = self._need_launch
        payload = {"hb": self._hb_seq, "agent_id": self.agent_id, "work": asdict(self._work),
                   "surface": {"kind": launch["delivery"]["kind"], "forward": enabled},
                   "max_parallel_tasks": 2,
                   "load": self._collect_load(), "env": self._collect_env(),
                   "sdk_version": __version__,
                   "launch_hash": self._launch_hash(launch),
                   "delivery_health": dict(self._delivery_health),
                   "debug": self._debug_payload(),
                   "errors": self._client_errors[-20:]}
        if include_launch:
            payload["launch"] = launch
        try:
            res = self._post(f"/p/{self.project}/heartbeat", payload)
        except Exception as e:
            self._record_error("heartbeat", "heartbeat request failed", str(e))
            self._need_launch = True
            return {"ok": False, "error": str(e)}
        prev_rev = self._remote_rev
        self._apply_remote_control(res.get("control"))
        self._need_launch = bool(res.get("launch_required")) or self._remote_rev != prev_rev
        self._debug_log("debug", f"heartbeat ok control_rev={self._remote_rev}")
        return res

    def start_heartbeat(self) -> None:
        if self._hb_thread and self._hb_thread.is_alive():
            return

        def loop():
            while not self._stop.is_set():
                try:
                    self.heartbeat_once()
                except Exception as e:
                    self._record_error("heartbeat", "heartbeat loop crashed",
                                       traceback.format_exc())
                    self._debug_log("error", f"heartbeat loop: {e}")
                self._stop.wait(self._heartbeat_s() + random.uniform(0, 15))

        self._hb_thread = threading.Thread(target=loop, daemon=True, name="yanshi-hb")
        self._hb_thread.start()

    def close(self) -> None:
        self._stop.set()

    # ── 消息接收（游标只在成功后前移）────────────────────────
    def events(self, topics: str | None = None, timeout: int = 25) -> Iterator[dict]:
        self.start_heartbeat()
        while not self._stop.is_set():
            since = self._cursor_load()
            q = f"/p/{self.project}/inbox?since={since}&timeout={timeout}"
            if topics:
                q += f"&topics={quote(str(topics), safe='')}"
            r = self._get(q)
            next_cursor = int(r.get("next_cursor") or since)
            for msg in r.get("messages", []):
                yield msg
                self._cursor_save(msg["seq"])
            if not r.get("messages"):
                # 整页都是当前 agent 不可见的项目事件时 messages 为空，但
                # next_cursor 已经前进；不保存会在旧游标上永久打转。
                if next_cursor > since:
                    self._cursor_save(next_cursor)
                time.sleep(1)
            elif next_cursor > since:
                self._cursor_save(max(next_cursor, self._cursor_load()))

    def event_stream(self, topics: str | None = None, timeout: int = 25) -> Iterator[dict]:
        """客户端事件流（降级轮询也用这个）：只产出稳定事件，不产出任务正文消息。

        有 WS 长连接时由 Loop 的 on_event 实时回调；没有 WS 时用本方法拉 /events。
        事件游标独立于消息游标，避免通知和任务消费互相推进。
        """
        self.start_heartbeat()
        while not self._stop.is_set():
            events = self.poll_events(topics=topics)
            for ev in events:
                yield ev
            if not events:
                time.sleep(1)

    def poll_events(self, topics: str | None = None, limit: int = 100,
                    drain: bool = False) -> list[dict]:
        """从独立事件游标拉一批事件；不阻塞、不 ACK。

        大页经出口代理时可能被截断成 ChunkedEncodingError。服务端单页上限 200，
        客户端遇到截断/解码/连接重置时自动降页（100→50→20→10），epoch 分支的
        重取也在同一保护内；到最小页仍失败则带退避重试，drain 已取到的部分不丢。
        """
        import http.client
        since = self._event_cursor_load()
        page_limit = max(1, min(200, int(limit)))
        out: list[dict] = []
        pages = 0
        floor_retries = 0

        def build_q() -> str:
            q = f"/p/{self.project}/events?since={since}&limit={page_limit}"
            if topics:
                q += f"&topics={quote(str(topics), safe='')}"
            return q

        while True:
            try:
                r = self._get(build_q())
                ep = r.get("epoch")
                if ep and ep != self._event_epoch_load():
                    # 房间重建：seq 归零，旧事件游标不能继续用。
                    # 重取必须在 try 内，否则这里的截断会绕过降页保护。
                    self._event_cursor_save(0, ep)
                    since = 0
                    r = self._get(build_q())
            except (requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.ContentDecodingError,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout,
                    http.client.IncompleteRead,
                    ConnectionResetError,
                    json.JSONDecodeError) as e:
                # 先降页；到 10 条后仍失败则做有上限的退避重试。
                if page_limit > 10:
                    page_limit = max(10, page_limit // 2)
                    floor_retries = 0
                    continue
                if floor_retries < 8:
                    floor_retries += 1
                    time.sleep(min(4.0, 0.3 * floor_retries))
                    continue
                # 连续在最小页失败：返回已取到的部分，游标停在最后成功页；
                # 下一轮 drain 会从该游标继续，不让一次坏窗口把整个循环打死。
                if out:
                    print(f"[events] drain paused after {len(out)} events: {e}", file=sys.stderr)
                    break
                raise
            floor_retries = 0
            events = list(r.get("events") or [])
            next_cursor = int(r.get("next_event_cursor") or r.get("next_cursor") or since)
            if events:
                self._event_cursor_save(max(next_cursor, int(events[-1].get("seq") or 0)))
            elif next_cursor > since:
                self._event_cursor_save(next_cursor)
            out.extend(events)
            pages += 1
            if not drain or next_cursor <= since or pages >= 20:
                break
            since = next_cursor
        return out

    def on_event(self, handler):
        """注册实时事件回调；返回 handler 本身，可直接当装饰器使用。
        回调在 WS 收包线程执行，不能阻塞太久；异常只记录，不打断连接。
        """
        with self._event_lock:
            self._event_handlers.append(handler)
        return handler

    def _dispatch_event(self, event: dict) -> None:
        if not event:
            return
        seq = int(event.get("seq") or 0)
        if seq > 0 and seq > self._event_cursor_load():
            self._event_cursor_save(seq)
        with self._event_lock:
            handlers = list(self._event_handlers)
        for h in handlers:
            try:
                h(event)
            except Exception:
                pass

    def publish(self, topic: str, kind: str, payload: Any, dedupe_key: str | None = None) -> dict:
        """发布消息。网络失败时落盘到 outbox，恢复后 drain() 重放（同 dedupe_key 幂等）。"""
        key = dedupe_key or f"{self.agent_id}:{uuid.uuid4().hex}"
        body = {"topic": topic, "kind": kind, "payload": payload, "dedupe_key": key}
        try:
            return self._post(f"/p/{self.project}/publish", body)
        except requests.RequestException:
            box = self.state_dir / "outbox"
            box.mkdir(parents=True, exist_ok=True)
            (box / f"{key.replace(':', '_')}.json").write_text(json.dumps(body))
            return {"queued": True, "dedupe_key": key}

    def report_issue(self, title: str, body: str = "", priority: str = "normal",
                     labels: str = "", self_assign: bool = False) -> dict:
        """上报 issue；所有 agent 默认可上报（服务端不要求 issues.report scope）。
        self_assign=True 时服务端会在同一个请求里把 Issue 转成 reporter 自己的任务。"""
        return self._post(f"/p/{self.project}/issues",
                          {"title": title, "body": body,
                           "priority": priority, "labels": labels,
                           "self_assign": bool(self_assign)}, retry=False)

    def take_issue(self, issue_id: str) -> dict:
        """上报者把一条仍 open、未派发的 Issue 转成自己的任务；只有 reporter 本人可用。"""
        return self._post(f"/p/{self.project}/issues/{quote(str(issue_id), safe='')}/take", {},
                          retry=False)

    def drain_outbox(self) -> dict:
        box = self.state_dir / "outbox"
        if not box.exists():
            return {"delivered": 0, "queued": 0}
        delivered = 0
        for f in sorted(box.glob("*.json")):
            body = json.loads(f.read_text())
            try:
                self._post(f"/p/{self.project}/publish", body)
                f.unlink()
                delivered += 1
            except requests.RequestException:
                break
        return {"delivered": delivered, "queued": self._outbox_count()}


    # ── 指令投递（不依赖 agent 主动读）────────────────────────
    def is_for_me(self, m: dict) -> bool:
        """自己发出的广播不回收，否则会自己回复自己，形成回声风暴。"""
        if (m.get("payload") or {}).get("work_item") is False:
            # 事件通知（task.queued/task.created 等）不是任务正文，不能进入执行队列。
            return False
        if m.get("topic") in ("submission", "artifact"):
            # 交付到达/裁决是通知事件；任务正文通过 task.* 事件和 msg 通道分开处理。
            return False
        if m.get("topic") == "task" and m.get("kind") not in ("task", "reassigned"):
            # claimed/released/done/queued 等生命周期通知不进入执行队列；
            # 真正的任务正文 kind=task 或带正文的 reassigned 才交给 handler。
            return False
        if m.get("sender") == self.agent_id and not m.get("to"):
            return False
        return True

    def poll_inbox(self, topics: str | None = None, limit: int = 50) -> list[dict]:
        """从游标处拉新消息；不做投递动作，只取数据。"""
        since = self._cursor_load()
        out: list[dict] = []
        pages = 0
        while True:
            r = self._get(f"/p/{self.project}/inbox?since={since}&limit={limit}"
                          + (f"&topics={quote(str(topics), safe='')}" if topics else "")
                          + f"&agent={self.agent_id}")
            ep = r.get("epoch")
            stored_ep = self._epoch_load()
            if ep and ep != stored_ep:
                # 房间重建过（换命名空间），seq 从头开始：游标归零后立即重取
                self._cursor_save(0); self._epoch_save(ep)
                since = 0
                if pages == 0:
                    pages += 1
                    continue
                break
            raw = r.get("messages", [])
            next_cursor = int(r.get("next_cursor") or since)
            if not raw:
                # 服务端可能把整页都过滤成项目事件（announce/artifact/task 生命周期）；
                # 此时 messages 为空但 next_cursor 已越过这些噪音，不能停在旧 since。
                if next_cursor > since:
                    self._cursor_save(next_cursor)
                break
            out.extend(raw)
            # next_cursor 可能大于本页最后一条（本页尾部全是不可见项目事件）。
            since = max(since, next_cursor, int(raw[-1].get("seq") or 0))
            self._cursor_save(since)
            pages += 1
            if not r.get("has_more") or pages >= 5:
                break
        return [m for m in out if self.is_for_me(m)]

    def ws_ticket(self) -> str:
        """换一次性 WS 票据（90 秒有效、用过即废），避免 token 进 URL/日志。"""
        return self._get(f"/p/{self.project}/ws-ticket")["ticket"]

    @staticmethod
    def _clean_text(s: str) -> str:
        """落盘前去掉 ANSI/控制字符，避免 `cat INBOX.md` 时被终端转义序列劫持。"""
        import re as _re
        return _re.sub(r"[\x00-\x08\x0b-\x1f\x7f\x9b]", "", s)

    def _deliver_messages(self, msgs: list[dict]) -> int:
        """把新消息落到本地，让 agent 下一轮对话就能看见，无需轮询感知。

        三级投递：
          1) 每条消息写 ~/.synapse-agent/inbox/<seq>-<topic>.json（机器可读）
          2) 追加到 INBOX.md（人可读，可直接粘进对话）
          3) 若配置了 notify_cmd，则执行它（如 tmux send-keys 注入运行中的会话）
        """
        if not msgs:
            return 0
        inbox = self.state_dir / "inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        md = self.state_dir / "INBOX.md"
        delivered = 0
        with md.open("a", encoding="utf-8") as f:
            for m in msgs:
                topic = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(m.get("topic", "msg")))[:40]
                path = inbox / f"{m['seq']:06d}-{topic}.json"
                path.write_text(json.dumps(m, ensure_ascii=False, indent=2))
                line = (f"- **[{m['seq']}] {m.get('topic')}/{m.get('kind','-')}** "
                        f"{m.get('ts','')}\n  {json.dumps(m.get('payload'), ensure_ascii=False)}\n")
                f.write(self._clean_text(line))
                delivered += 1

                # 广播要求确认 ⇒ 自动 ack（避免"收到了但没人回"）
                act = (m.get("payload") or {}).get("action_required") or {}
                # 服务端广播的 topic 实际是 announce（历史代码只认 broadcast，自动回执从未生效）
                if m.get("topic") in ("broadcast", "announce") and act.get("ack_required"):
                    try:
                        self.ack(m["seq"], "done", {"auto": True, "via": "sdk-deliver"})
                    except Exception:
                        pass

        cmd = self._notify_cmd()
        if cmd and self._auto_enabled(cmd):
            self._delivery_health["last_attempt_ms"] = int(time.time() * 1000)
            try:
                subprocess.run(cmd, shell=True, timeout=10,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                self._delivery_health.update(
                    last_ok_ms=int(time.time() * 1000), last_error="",
                    consecutive_failures=0)
            except Exception as e:
                fails = int(self._delivery_health.get("consecutive_failures") or 0) + 1
                self._delivery_health.update(last_error=str(e)[:300], consecutive_failures=fails)
                self._debug_log("warn", f"notify_cmd failed: {e}")
        return delivered

    def deliver(self, msgs: list[dict] | None = None, *,
                files: Iterable[str | Path] | None = None, kind: str = "patch",
                title: str = "", base_sha: str | None = None,
                checks: dict | None = None, notes: str = "", task_id: str | None = None,
                submission_id: str | None = None, revision_of: str | None = None) -> Any:
        """一条龙交付：deliver(files=[patch, RECEIPT.md]) 上传 + 建交付。

        兼容旧用法 deliver(msgs)：不传 files 时仍是消息落盘。
        """
        if files is None:
            return self._deliver_messages(msgs or [])
        uploaded: list[dict] = []
        refs: list[dict] = []
        for f in files:
            up = self.upload(f)
            uploaded.append(up)
            refs.append(up["ref"])
        try:
            sub = self.submit(kind, title, refs, base_sha=base_sha, checks=checks,
                              notes=notes, task_id=task_id, submission_id=submission_id,
                              revision_of=revision_of)
        except SynapseAPIError as e:
            # 文件已上传但交付被拒：错误体带上已传文件，agent 不用重新上传。
            e.payload["uploaded"] = uploaded
            raise
        return {**sub, "files": uploaded}

    def _notify_cmd(self) -> str | None:
        try:
            cfg = json.loads((self.state_dir / "config.json").read_text())
            return os.environ.get("YANSHI_NOTIFY_CMD") or cfg.get("notify_cmd")
        except Exception:
            return os.environ.get("YANSHI_NOTIFY_CMD")

    def ack(self, seq: int, status: str, detail: dict | None = None) -> dict:
        return self._post(f"/p/{self.project}/ack", {"seq": seq, "status": status, "detail": detail or {}})

    def report(self, report_id: str, task: dict, resources: dict | None = None) -> dict:
        return self._post(f"/p/{self.project}/report",
                          {"report_id": report_id, "task": task,
                           "resources": resources or self._collect_load(),
                           "env": self._collect_env()})

    # ── 交付 ─────────────────────────────────────────────────
    def _submission_id(self, kind: str, title: str, refs: list[dict],
                       base_sha: str, task_id: str | None,
                       revision_of: str | None = None) -> str:
        """内容稳定 ID：超时重试会命中同一条交付，而不是生成重复 submission。"""
        seed = json.dumps({
            "agent": self.agent_id, "task": task_id or "", "kind": kind,
            "title": title, "base": base_sha, "revision_of": revision_of or "",
            "refs": sorted([str(r.get("sha256", "")) for r in refs]),
        }, sort_keys=True, separators=(",", ":"))
        clean = re.sub(r"[^a-zA-Z0-9._:-]", "-", self.agent_id)[:40]
        return f"sub-{clean}-{hashlib.sha256(seed.encode()).hexdigest()[:16]}"

    def upload(self, path: str | Path) -> dict:
        p = Path(path)
        data = p.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        url = f"{self.endpoint}/p/{self.project}/artifact/{sha}"
        r = self._sess.put(url, data=data, headers=self._headers(), timeout=120)
        if r.status_code >= 400:
            body: Any
            try: body = r.json()
            except Exception: body = {"error": f"upload_http_{r.status_code}", "text": r.text[:200]}
            raise SynapseAPIError(r.status_code, body)
        return {"sha256": sha, "name": p.name, "bytes": len(data), "ref": {"sha256": sha, "name": p.name}}

    def submit(self, kind: str, title: str, refs: list[dict], base_sha: str | None = None,
               checks: dict | None = None, notes: str = "", task_id: str | None = None,
               submission_id: str | None = None, revision_of: str | None = None) -> dict:
        base = base_sha or self._git_head()
        if not base:
            raise SynapseAPIError(422, {"error": "base_sha_required",
                "hint": "传 base_sha，或在 git 仓库内运行；base 必须是 7-64 位十六进制。"})
        task_id = task_id or self._active_task_id()
        sid = submission_id or self._submission_id(kind, title, refs, base, task_id, revision_of)
        body = {
            "submission_id": sid, "agent_id": self.agent_id, "kind": kind, "title": title,
            "refs": refs, "base_sha": base, "checks": checks or {}, "notes": notes,
        }
        if task_id:
            body["task_id"] = task_id
        if revision_of:
            body["revision_of"] = revision_of
        return self._post(f"/p/{self.project}/submissions", body)

    def applies(self, submission_id: str, target_sha: str | None = None) -> dict:
        """查旧交付在当前 main 是否还能应用；返回 failed_files/failed_lines。"""
        q = f"?target_sha={quote(target_sha)}" if target_sha else ""
        return self._get(f"/p/{self.project}/submissions/{quote(submission_id)}/applies{q}")

    def report_apply_check(self, submission_id: str, target_sha: str, applies: bool, *,
                           failed_files: list[str] | None = None,
                           failed_lines: list[str] | None = None,
                           failures: list[dict] | None = None,
                           engine: str = "git-apply", summary: str = "") -> dict:
        """节点本地 git apply --check 后回传权威结果；服务端统一落字段并发事件。"""
        return self._post(f"/p/{self.project}/submissions/{quote(submission_id)}/apply-check", {
            "target_sha": target_sha, "applies": bool(applies),
            "failed_files": failed_files or [], "failed_lines": failed_lines or [],
            "failures": failures or [], "engine": engine, "summary": summary,
        })

    # ── active task：CLI/SDK 共享同一份“当前任务”上下文 ─────────
    def _active_task_path(self) -> Path:
        return self.state_dir / "active_task.json"

    def _active_task_id(self) -> str | None:
        try:
            body = json.loads(self._active_task_path().read_text())
            tid = str(body.get("task_id") or "").strip()
            return tid or None
        except Exception:
            return None

    def _active_task_set(self, task_id: str, seq: int = 0, title: str = "") -> None:
        body = {"task_id": task_id, "seq": int(seq), "title": title,
                "since": int(time.time() * 1000), "agent_id": self.agent_id}
        tmp = self._active_task_path().with_suffix(".json.tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False))
        os.replace(tmp, self._active_task_path())

    def _active_task_clear(self, task_id: str | None = None) -> None:
        path = self._active_task_path()
        if task_id and self._active_task_id() != task_id:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    def task(self, task_id: str) -> TaskLease:
        return TaskLease(self, task_id)

    def claim_next(self) -> dict:
        """原子领取下一个可执行任务（定向优先、再公共池）；省掉“列任务→挑→claim”三步。"""
        r = self._post(f"/p/{self.project}/tasks/claim-next", {})
        if r.get("ok") and r.get("task_id"):
            self._active_task_set(str(r["task_id"]), int(r.get("seq") or 0),
                                  str((r.get("task") or {}).get("title") or ""))
        return r

    def bootstrap(self) -> dict:
        """一次拿身份/配额/名下任务/下一步；启动时替代 whoami + tasks + inbox 三次探测。"""
        return self._get(f"/p/{self.project}/bootstrap")

    def fail_task(self, task_id: str, error: str, retryable: bool = True) -> dict:
        """上报执行失败：服务端按 max_attempts 决定退避重试或进死信；成功后清本地 active task。"""
        r = self._post(f"/p/{self.project}/tasks/fail",
                       {"task_id": task_id, "error": str(error)[:500], "retryable": bool(retryable)})
        if r.get("ok"):
            self._active_task_clear(task_id)
            self.work(Work(state="idle"))
        return r

    # ── 内部：HTTP ───────────────────────────────────────────
    def _headers(self) -> dict:
        return {"authorization": f"Bearer {self._token}", "x-sdk-version": __version__,
                "user-agent": f"synapse-agent/{__version__} (python)",
                "connection": "close", "content-type": "application/json",
                # 大页 JSON 经出口代理时，压缩/分块解码失败会表现为
                # ChunkedEncodingError；请求 identity，避免代理重压后再截断。
                "accept-encoding": "identity"}

    def check_update(self) -> dict:
        """问服务端 SDK 发版信息，判断是否需要升级（不下载、不改动本地）。"""
        from . import __version__
        m = self._get("/sdk/manifest")
        mine, latest = __version__, str(m.get("version") or "")
        return {"current": mine, "latest": latest, "update": latest != mine,
                "install_url": m.get("install_url"), "binaries": m.get("binaries", []),
                "notes": m.get("notes", [])}

    def upgrade(self, run: bool = False) -> dict:
        """默认只给命令；run=True 且设置了 YANSHI_UPGRADE_CMD 才真正执行。"""
        info = self.check_update()
        if not info["update"]:
            return {**info, "action": "already-latest"}
        cmd = os.environ.get("YANSHI_UPGRADE_CMD") or \
              "curl -fsSL https://synapse.wangda.today/dl/install.sh | sh"
        if not run:
            return {**info, "action": "manual", "cmd": cmd}
        if not os.environ.get("YANSHI_UPGRADE_CMD"):
            return {**info, "action": "refused",
                    "why": "未设置 YANSHI_UPGRADE_CMD，拒绝自动执行远程脚本"}
        rc = subprocess.call(cmd, shell=True)            # noqa: S602
        return {**info, "action": "ran", "rc": rc, "cmd": cmd}

    def as_admin(self):
        """拿到管理面门面；token 必须含 admin 权限，否则调用时服务端 403。"""
        from .admin import Admin
        return Admin(self)

    def _delete(self, path: str, payload: dict) -> dict:
        r = self._sess.delete(f"{self.endpoint}{path}", json=payload,
                             headers=self._headers(), timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"DELETE {path} -> {r.status_code}: {r.text[:120]}")
        return r.json()

    def _post(self, path: str, payload: dict, retry: bool = True) -> dict:
        # 心跳/回执/发布都有幂等键；TLS EOF 或连接重置时重试 2 次。
        # Issue 上报没有服务端幂等键，重试可能生成重复 Issue，所以 report_issue 走 retry=False。
        last = None
        attempts = 4 if retry else 1
        for i in range(attempts):
            try:
                r = self._sess.post(f"{self.endpoint}{path}", json=payload,
                                  headers=self._headers(), timeout=30)
                break
            except (requests.ConnectionError, requests.exceptions.SSLError) as e:
                last = e
                if i >= attempts - 1:
                    # 保持 requests.RequestException 类型：heartbeat/publish/drain_outbox
                    # 都靠这个类型决定“返回离线/落 outbox”，不能抛 RuntimeError 绕过。
                    raise requests.ConnectionError(
                        f"POST {path} 网络失败（已尝试 {attempts} 次）：{e}") from e
                time.sleep(1.5 * (i + 1))
        else:
            raise requests.ConnectionError(f"POST {path} 网络失败：{last}")
        if r.status_code >= 400:
            try: body = r.json()
            except Exception: body = {"error": f"http_{r.status_code}", "text": r.text[:300]}
            raise SynapseAPIError(r.status_code, body)
        return r.json()

    def _get(self, path: str) -> dict:
        # GET 幂等：网络瞬断（IPv6 黑洞/TLS EOF）重试 2 次
        last = None
        for i in range(4):
            try:
                r = self._sess.get(f"{self.endpoint}{path}", headers=self._headers(), timeout=40)
                if r.status_code >= 400:
                    try: body = r.json()
                    except Exception: body = {"error": f"http_{r.status_code}", "text": r.text[:300]}
                    raise SynapseAPIError(r.status_code, body)
                return r.json()
            except (requests.ConnectionError, requests.Timeout, requests.exceptions.SSLError,
                    requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.ContentDecodingError) as e:
                # S6：服务端重启/连接中途断开时，chunked 传输会抛 ChunkedEncodingError；
                # GET 幂等，按退避重试，避免管理侧首拉直接失败。
                last = e
                if i < 3:
                    time.sleep(0.6 * (i + 1))
        raise last

    # ── 内部：本地状态 ───────────────────────────────────────
    def _cursor_path(self) -> Path:
        return self.state_dir / "cursor.json"

    def _event_cursor_path(self) -> Path:
        return self.state_dir / "event_cursor.json"

    def _event_cursor_load(self) -> int:
        try:
            return int(json.loads(self._event_cursor_path().read_text())["seq"])
        except Exception:
            return 0

    def _event_epoch_load(self) -> str | None:
        try:
            return json.loads(self._event_cursor_path().read_text()).get("epoch")
        except Exception:
            return None

    def _event_cursor_save(self, seq: int, epoch: str | None = None) -> None:
        tmp = self._event_cursor_path().with_suffix(".tmp")
        ep = epoch if epoch is not None else self._event_epoch_load()
        tmp.write_text(json.dumps({"seq": seq, "at": time.time(), **({"epoch": ep} if ep else {})}))
        os.replace(tmp, self._event_cursor_path())

    def _cursor_load(self) -> int:
        try:
            return int(json.loads(self._cursor_path().read_text())["seq"])
        except Exception:
            return 0

    def _epoch_load(self) -> str | None:
        try:
            return json.loads(self._cursor_path().read_text()).get("epoch")
        except Exception:
            return None

    def _epoch_save(self, ep: str) -> None:
        try:
            d = json.loads(self._cursor_path().read_text())
        except Exception:
            d = {"seq": 0}
        d["epoch"] = ep
        tmp = self._cursor_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(d))
        os.replace(tmp, self._cursor_path())

    def _cursor_save(self, seq: int) -> None:
        tmp = self._cursor_path().with_suffix(".tmp")
        ep = self._epoch_load()
        tmp.write_text(json.dumps({"seq": seq, "at": time.time(), **({"epoch": ep} if ep else {})}))
        os.replace(tmp, self._cursor_path())     # 原子替换（Windows 上 os.replace 同样可用）

    def _outbox_count(self) -> int:
        box = self.state_dir / "outbox"
        return len(list(box.glob("*.json"))) if box.exists() else 0

    # ── 内部：采集（跨平台，失败不崩）─────────────────────────
    def _read_stat(self):
        try:
            line = open("/proc/stat").readline().split()[1:]
            nums = [int(x) for x in line]
            return (sum(nums), nums[3])
        except Exception:
            return None

    def _collect_load(self) -> dict:
        load: dict[str, Any] = {}
        try:
            cur = self._read_stat()
            if cur and self._cpu_prev:
                dt, di = cur[0] - self._cpu_prev[0], cur[1] - self._cpu_prev[1]
                if dt > 0:
                    load["cpu_pct"] = round(100 * (1 - di / dt))
            self._cpu_prev = cur
            load["load1"] = round(float(open("/proc/loadavg").read().split()[0]), 2)
        except Exception:
            pass
        try:
            mem = dict(re.findall(r"(\w+):\s+(\d+)", open("/proc/meminfo").read()))
            cap_mb = int(open("/sys/fs/cgroup/memory.max").read()) // 1048576 if os.path.exists("/sys/fs/cgroup/memory.max") else int(mem["MemTotal"]) // 1024
            used_mb = int(open("/sys/fs/cgroup/memory.current").read()) // 1048576 if os.path.exists("/sys/fs/cgroup/memory.current") else int(mem["MemAvailable"]) // 1024
            load.update(mem_total_mb=cap_mb, mem_used_mb=min(used_mb, cap_mb))
        except Exception:
            pass
        try:
            out = subprocess.check_output(["df", "-BG", "--output=avail,pcent", "/"], text=True, stderr=subprocess.DEVNULL).strip().splitlines()[-1].split()
            load["disk"] = [{"mount": "/", "free_gb": int(out[0].rstrip("G")), "used_pct": int(out[1].rstrip("%"))}]
        except Exception:
            load["degraded"] = True
        return load

    def _collect_env(self) -> dict:
        head = self._git_head()
        try:
            dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], text=True, stderr=subprocess.DEVNULL).strip())
        except Exception:
            dirty = None
        return {"git_head": head, "dirty": dirty}

    def _git_head(self) -> str | None:
        try:
            import subprocess as sp
            return sp.check_output(["git", "rev-parse", "--short", "HEAD"], text=True, stderr=sp.DEVNULL).strip()
        except Exception:
            return None

    @staticmethod
    def _mask(t: str) -> str:
        return (t[:6] + "…") if t else "none"
