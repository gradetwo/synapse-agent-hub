"""synapse Python SDK：心跳托管 + 游标续传 + 离线队列 + 交付上传。"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import quote

import requests

__version__ = "0.5.7"
def _state_dir() -> Path:
    new = os.environ.get("SYNAPSE_STATE_DIR") or os.environ.get("YANSHI_STATE_DIR")
    if new: return Path(new)
    base = Path.home() / ".synapse-agent"
    legacy = Path.home() / ".yanshi-agent"
    if not base.exists() and legacy.exists(): return legacy
    return base

CONFIG_DIR = _state_dir()


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
        self._work = Work()
        self._hb_seq = 0
        self._cpu_prev = self._read_stat()
        self._stop = threading.Event()
        self._hb_thread: threading.Thread | None = None
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
    def init(cls, endpoint: str, project: str, token: str, agent_id: str | None = None) -> "Client":
        """安装时调用一次：写入配置（chmod 600）+ 发首拍心跳验证。"""
        agent_id = agent_id or f"agent-{uuid.uuid4().hex[:6]}"
        d = CONFIG_DIR
        d.mkdir(parents=True, exist_ok=True)
        from .profile import detect
        prof = detect(agent_id)
        cfg = {"endpoint": endpoint.rstrip("/"), "project": project, "agent_id": agent_id,
               "token": token, "heartbeat_s": int(prof["heartbeat_s"]), "state_dir": str(d)}
        cfg_path = d / "config.json"
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
        }

    # ── 心跳 ─────────────────────────────────────────────────
    def heartbeat_once(self) -> dict:
        self._hb_seq += 1
        payload = {"hb": self._hb_seq, "agent_id": self.agent_id, "work": asdict(self._work),
                   "surface": {"kind": "none"},
                   "max_parallel_tasks": 2,
                   "load": self._collect_load(), "env": self._collect_env(), "sdk_version": __version__}
        try:
            return self._post(f"/p/{self.project}/heartbeat", payload)
        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}

    def start_heartbeat(self) -> None:
        if self._hb_thread and self._hb_thread.is_alive():
            return

        def loop():
            while not self._stop.is_set():
                self.heartbeat_once()
                self._stop.wait(self.heartbeat_s + random.uniform(0, 15))

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

    def deliver(self, msgs: list[dict]) -> int:
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
        if cmd:
            try:
                subprocess.run(cmd, shell=True, timeout=10,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
        return delivered

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
    def upload(self, path: str | Path) -> dict:
        import hashlib
        p = Path(path)
        data = p.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        url = f"{self.endpoint}/p/{self.project}/artifact/{sha}"
        r = self._sess.put(url, data=data, headers=self._headers(), timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"upload failed {r.status_code}: {r.text[:200]}")
        return {"sha256": sha, "name": p.name, "bytes": len(data), "ref": {"sha256": sha, "name": p.name}}

    def submit(self, kind: str, title: str, refs: list[dict], base_sha: str | None = None,
               checks: dict | None = None, notes: str = "", task_id: str | None = None) -> dict:
        sid = f"sub-{self.agent_id}-{uuid.uuid4().hex[:8]}"
        body = {
            "submission_id": sid, "agent_id": self.agent_id, "kind": kind, "title": title,
            "refs": refs, "base_sha": base_sha or self._git_head(), "checks": checks or {}, "notes": notes,
        }
        task_id = task_id or self._active_task_id()
        if task_id:
            body["task_id"] = task_id
        return self._post(f"/p/{self.project}/submissions", body)

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

    # ── 内部：HTTP ───────────────────────────────────────────
    def _headers(self) -> dict:
        return {"authorization": f"Bearer {self._token}", "x-sdk-version": __version__,
                "user-agent": f"synapse-agent/{__version__} (python)",
                "connection": "close", "content-type": "application/json"}

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
        if r.status_code == 401: raise RuntimeError("token revoked or unknown; re-issue token")
        if r.status_code == 403: raise RuntimeError("scope/project mismatch")
        if r.status_code == 426: raise RuntimeError("sdk too old; pip install -U synapse-agent")
        r.raise_for_status()
        return r.json()

    def _get(self, path: str) -> dict:
        # GET 幂等：网络瞬断（IPv6 黑洞/TLS EOF）重试 2 次
        last = None
        for i in range(4):
            try:
                r = self._sess.get(f"{self.endpoint}{path}", headers=self._headers(), timeout=40)
                r.raise_for_status()
                return r.json()
            except (requests.ConnectionError, requests.Timeout, requests.exceptions.SSLError) as e:
                last = e
                if i < 3:
                    time.sleep(0.6 * (i + 1))
        raise last

    # ── 内部：本地状态 ───────────────────────────────────────
    def _cursor_path(self) -> Path:
        return self.state_dir / "cursor.json"

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
