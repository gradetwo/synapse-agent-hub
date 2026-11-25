"""忙时异步、闲时阻塞的状态机（agent 侧接入 hub 的唯一入口）。

为什么需要它：agent 在“做任务”和“等任务”是两种完全不同的形态。
做任务时不能阻塞（阻塞就干不了活），等任务时必须阻塞（不阻塞就没人唤醒它）。
所以写成一个两态机器：

    IDLE（阻塞等）  --收到任务-->  BUSY（异步收，任务中定期 check）
    BUSY（异步收）  --任务结束-->  IDLE（阻塞等）

用法：

    hub = Loop(Client.from_config())

    while True:
        task = hub.idle(timeout=None)      # 阻塞在这里，直到有新任务/新广播
        with hub.task(task["payload"].get("title") or "task"):
            ...干活...
            for msg in hub.check():        # 任务中不阻塞地看一眼有没有新指令
                ...
        # 出 with 自动回到 IDLE，再阻塞

心跳与收件都不需要 agent 自己发起：心跳线程随 Loop 启动，
BUSY 期间的收件在后台线程里做，消息先落队列，agent 想什么时候取就什么时候取。
"""
from __future__ import annotations

import queue
import threading
import time
from contextlib import contextmanager

from .client import Client
from .ws import WSPump


class Loop:
    def __init__(self, client: Client, poll_s: float | None = None, ack_status: str = "done",
                 transport: str = "auto", ws_probe_s: float = 4.0):
        """transport: auto（默认，先试长连接，连不上才轮询）/ ws / poll"""
        self.c: Client = client
        self.transport = transport
        self.ws_probe_s = ws_probe_s
        self._ws: WSPump | None = None
        self._mode = "poll"
        self._need_catchup = False
        self.poll_s = poll_s
        self.ack_status = ack_status
        # 未显式给间隔时用环境自检的默认（云机 3s / 本地 4–5s / CI 10s）
        from .profile import detect
        self.profile = detect(getattr(client, "agent_id", None))
        if poll_s is None:
            poll_s = float(self.profile["poll_s"])
        self.poll_s = poll_s
        self._q: "queue.Queue[dict]" = queue.Queue()
        self._busy = False
        self._stop = threading.Event()
        self._catchup_lock = threading.Lock()
        self._poller: threading.Thread | None = None
        self.c.start_heartbeat()          # 心跳从此不用管
        if transport in ("auto", "ws"):
            self._probe_ws()

    # ── 传输选择：长连接优先，环境不支持才轮询 ───────────────
    def _probe_ws(self) -> None:
        try:
            self._ws = WSPump(self.c.endpoint, self.c.project, self.c.ws_ticket,
                              on_msg=self._on_ws_msg, on_state=self._on_ws_state,
                              on_event=self._on_ws_event)
            self._ws.start()
            if self._ws.connected_once.wait(timeout=self.ws_probe_s):
                self._mode = "ws"
                # 补拉在 _on_ws_state("ws:connected") 里统一做；重连也走同一条路径。
        except Exception:                 # noqa: BLE001
            self._ws = None
        if self.transport == "ws" and self._mode != "ws":
            raise RuntimeError("transport=ws 但长连接建立失败（换 auto 可自动回退轮询）")

    def _on_ws_state(self, st: str) -> None:
        if st == "ws:connected":
            self._need_catchup = True
            # 探测窗口内没连上，但后台线程后来连上了：就地升级为 ws，不必等下一轮
            if self._mode != "ws":
                self._mode = "ws"
            # 重连后必须补拉断线期间的消息；不补就会永久停在旧游标。
            self._catch_up()

    def _on_ws_event(self, event: dict) -> None:
        # 事件只做通知，不进任务队列，不 ACK，不触发 exec/窗口注入。
        self.c._dispatch_event(event)

    def _poll_events(self) -> None:
        try:
            for e in self.c.poll_events():
                self.c._dispatch_event(e)
        except Exception:                 # noqa: BLE001
            pass                          # 通知失败不能影响任务主循环

    def _on_ws_msg(self, m: dict) -> None:
        if not self.c.is_for_me(m):
            return                        # 自己发的广播，不回收
        seq = int(m.get("seq") or 0)
        if seq and seq <= self.c._cursor_load():
            return                        # 重复帧（重连补拉的重叠）
        if seq:
            self.c._cursor_save(seq)      # 先推进游标，重连补拉不会重复投递
        self._q.put(m)
        self._maybe_ack(m)

    def _catch_up(self) -> None:
        with self._catchup_lock:
            try:
                msgs = self.c.poll_inbox()
                if not msgs:
                    # 游标可能来自另一个 DO 实例（换命名空间后 seq 归零）→ 复位重拉
                    full = self.c._get(f"/p/{self.c.project}/inbox?since=0&limit=200&agent={self.c.agent_id}")
                    top = max((m["seq"] for m in full.get("messages", [])), default=0)
                    if top and top < self.c._cursor_load():
                        self.c._cursor_save(0)
                        msgs = self.c.poll_inbox()
                for m in msgs:
                    self._q.put(m)
                    self._maybe_ack(m)
                self._need_catchup = False
                self._poll_events()          # 断线期间漏掉的事件也必须补通知
            except Exception:                 # noqa: BLE001
                # 网络失败不阻塞 WSPump 收包；下次连接/空闲再补
                pass

    @property
    def mode(self) -> str:
        return self._mode

    # ── 状态 ────────────────────────────────────────────────
    @property
    def state(self) -> str:
        return "busy" if self._busy else "idle"

    def _enter_busy(self, label: str = "") -> None:
        if self._busy:
            return
        self._busy = True
        self.c.work(state="busy", phase=label[:80])   # 上报“在忙什么”，管理端可见
        self.c.heartbeat_once()                        # 立刻让管理端看到状态变化
        if self._mode == "ws":
            return                        # 长连接推送，不需要额外轮询线程
        self._stop.clear()
        self._poller = threading.Thread(target=self._collect, daemon=True, name="yanshi-inbox")
        self._poller.start()

    def _leave_busy(self) -> None:
        self._busy = False
        self._stop.set()
        if self._poller and self._poller.is_alive():
            self._poller.join(timeout=2)
        self.c.work(state="idle", phase="等指令")
        self.c.heartbeat_once()

    def _collect(self) -> None:
        """BUSY 期间后台收件：只入队，不打扰干活。"""
        while not self._stop.is_set():
            try:
                for m in self.c.poll_inbox():
                    self._q.put(m)
                    self._maybe_ack(m)
            except Exception:                          # noqa: BLE001
                pass                                   # 网络抖动不该杀掉任务
            self._poll_events()
            self._stop.wait(self.poll_s)

    def _maybe_ack(self, m: dict) -> None:
        if ((m.get("payload") or {}).get("action_required") or {}).get("ack_required"):
            try:
                self.c.ack(m["seq"], self.ack_status, {"note": "SDK 已自动回执"})
            except Exception:                          # noqa: BLE001
                pass

    # ── 任务中：异步看一眼 ───────────────────────────────────
    def check(self) -> list[dict]:
        """非阻塞取走攒下的消息；没有就返回空列表。"""
        out = []
        while True:
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                return out

    # ── 任务切换 ────────────────────────────────────────────
    @contextmanager
    def task(self, label: str = ""):
        self._enter_busy(label)
        try:
            yield self
        finally:
            self._leave_busy()

    # ── 闲时：阻塞等 ────────────────────────────────────────
    def idle(self, timeout: float | None = None) -> dict | None:
        """阻塞直到收到下一条消息（任务/广播），收到后自动进入 BUSY。

        服务端没有长轮询参数，所以是“短间隔轮询”，但对外语义就是阻塞。
        """
        deadline = None if timeout is None else time.time() + timeout
        leftover = self.check()
        if leftover:
            self._enter_busy("接任务")
            return leftover[0]
        if self._mode == "ws":
            while deadline is None or time.time() < deadline:
                if self._need_catchup:
                    self._catch_up()              # 重连补拉失败时下一轮再试
                try:
                    m = self._q.get(timeout=1.0)
                except queue.Empty:
                    continue
                self._enter_busy("接任务")
                return m
            return None
        while deadline is None or time.time() < deadline:
            try:
                msgs = self.c.poll_inbox()
            except Exception:                          # noqa: BLE001
                msgs = []
            self._poll_events()
            if msgs:
                self._enter_busy("接任务")
                for m in msgs[1:]:
                    self._q.put(m)
                    self._maybe_ack(m)
                self._maybe_ack(msgs[0])
                return msgs[0]
            time.sleep(min(self.poll_s, 2.0))
        return None

    def serve(self, handler, timeout: float | None = None) -> None:
        """最小主循环：闲着 -> 拿任务 -> 干活 -> 回闲。"""
        while True:
            t = self.idle(timeout=timeout)
            if t is None:
                return
            with self.task(t.get("payload", {}).get("title", "")):
                try:
                    handler(t, self)
                except Exception as e:                 # noqa: BLE001
                    self.c.publish("report", "report",
                                   {"title": "任务失败", "body": f"{type(e).__name__}: {e}"})

    def close(self) -> None:
        self._leave_busy()
        if self._ws:
            self._ws.stop()
        self.c.close()
