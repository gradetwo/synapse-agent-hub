"""极简 WebSocket 客户端（RFC6455，纯标准库，无第三方依赖）。

只做 hub 需要的那一点点：文本帧、ping/pong、close。
故意不引 websockets 包——agent 环境经常装不上依赖，SDK 要能裸跑。
"""
from __future__ import annotations

import base64
import json
import os
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSError(Exception):
    pass


def _proxy_for(scheme_host: str) -> str | None:
    """按环境变量挑代理；NO_PROXY 命中则直连。"""
    import fnmatch
    no = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    if no.strip() == "*":
        return None
    for pat in [x.strip() for x in no.split(",") if x.strip()]:
        if fnmatch.fnmatch(scheme_host, pat) or fnmatch.fnmatch(scheme_host, pat.lstrip(".")):
            return None
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        v = os.environ.get(k)
        if v:
            return v
    return None


def _ipv4(host, port, timeout):
    """双栈环境里 IPv6 常常黑洞：优先 IPv4，失败再退回默认解析。"""
    orig = socket.getaddrinfo
    try:
        socket.getaddrinfo = lambda h, p, *a, **k: [x for x in orig(h, p, *a, **k) if x[0] == socket.AF_INET]
        return socket.create_connection((host, port), timeout=timeout)
    except OSError:
        socket.getaddrinfo = orig
        return socket.create_connection((host, port), timeout=timeout)
    finally:
        socket.getaddrinfo = orig


def _open_socket(host: str, port: int, timeout: float) -> socket.socket:
    """有代理就 CONNECT 打洞，没有就直连。代理环境里 DNS 常只有代理侧能解。"""
    proxy = _proxy_for(host)
    if not proxy:
        return _ipv4(host, port, timeout)
    u = urlparse(proxy if "://" in proxy else "http://" + proxy)
    phost, pport = u.hostname or "127.0.0.1", u.port or 8080
    s = socket.create_connection((phost, pport), timeout=timeout)
    target = f"{host}:{port}"
    req = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
    if u.username:
        cred = base64.b64encode(f"{u.username}:{u.password or ''}".encode()).decode()
        req += f"Proxy-Authorization: Basic {cred}\r\n"
    s.sendall((req + "\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            raise WSError("代理 CONNECT 被关闭")
        resp += chunk
    status_line = resp.split(b"\r\n", 1)[0]
    if b" 200 " not in status_line:
        raise WSError(f"代理拒绝 CONNECT：{status_line[:80]!r}")
    return s


class WSClient:
    def __init__(self, url: str, headers: dict | None = None, timeout: float = 10.0):
        self.url = url
        self.headers = headers or {}
        self.timeout = timeout
        self.sock: socket.socket | None = None
        self._buf = b""
        self._frag: bytes | None = None
        self.closed = False

    # ── 建连 ────────────────────────────────────────────────
    def connect(self) -> "WSClient":
        u = urlparse(self.url)
        host = u.hostname or ""
        port = u.port or (443 if u.scheme in ("wss", "https") else 80)
        path = u.path + (f"?{u.query}" if u.query else "")
        raw = _open_socket(host, port, self.timeout)
        if u.scheme in ("wss", "https"):
            ctx = ssl.create_default_context()
            # 显式拒绝 TLS 1.0/1.1；create_default_context 的默认下限依赖发行版/OpenSSL 配置。
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            raw = ctx.wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n")
        for k, v in self.headers.items():
            req += f"{k}: {v}\r\n"
        raw.sendall((req + "\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = raw.recv(4096)
            if not chunk:
                raise WSError("握手失败：连接被关闭")
            resp += chunk
        head, _, rest = resp.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n", 1)[0]
        if b"101" not in status_line:
            raise WSError(f"握手失败：{status_line.decode(errors='replace')}")
        expect = base64.b64encode(
            __import__("hashlib").sha1((key + GUID).encode()).digest()).decode()
        if expect.encode() not in head:
            raise WSError("握手失败：Sec-WebSocket-Accept 不匹配")
        self.sock = raw
        self._buf = rest
        return self

    # ── 收发 ────────────────────────────────────────────────
    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WSError("连接已关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, data: bytes, opcode: int = 1) -> None:
        mask = os.urandom(4)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + payload)

    def send_json(self, obj: dict) -> None:
        self._send_frame(json.dumps(obj).encode())

    def recv_json(self) -> dict | None:
        """返回一条 JSON 消息；收到 close/pong 时继续读，直到有文本帧。"""
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            fin = bool(b1 & 0x80)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(ln) if ln else b""
            if opcode == 8:                      # close
                self.closed = True
                return None
            if opcode == 9:                      # ping → 回 pong
                self._send_frame(payload, opcode=10)
                continue
            if opcode == 10:                     # pong
                continue
            if opcode in (1, 2):
                if fin:
                    try:
                        return json.loads(payload.decode())
                    except json.JSONDecodeError:
                        continue
                # 分片消息：先缓存，等 continuation 帧
                self._frag = payload
                continue
            if opcode == 0 and getattr(self, "_frag", None) is not None:
                self._frag += payload
                if fin:
                    try:
                        obj = json.loads(self._frag.decode())
                    except json.JSONDecodeError:
                        self._frag = None
                        continue
                    self._frag = None
                    return obj
                continue

    def close(self) -> None:
        self.closed = True
        try:
            self._send_frame(b"", opcode=8)
        except Exception:                        # noqa: BLE001
            pass
        try:
            self.sock.close()
        except Exception:                        # noqa: BLE001
            pass


class WSPump(threading.Thread):
    """后台线程：维持连接、收消息、断线重连，把消息交给回调。"""

    def __init__(self, base: str, project: str, ticket_fn, on_msg, on_state=None,
                 on_event=None, ping_s: float = 25.0):
        super().__init__(daemon=True, name="yanshi-ws")
        self.base = base.rstrip("/").replace("https://", "wss://").replace("http://", "ws://")
        self.project = project
        self.ticket_fn = ticket_fn
        self.on_msg = on_msg
        self.on_event = on_event or (lambda e: None)
        self.on_state = on_state or (lambda s: None)
        self.ping_s = ping_s
        self.ws: WSClient | None = None
        self._stop = threading.Event()
        self.connected_once = threading.Event()

    def run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                ticket = self.ticket_fn()
                self.ws = WSClient(f"{self.base}/p/{self.project}/ws?ticket={ticket}").connect()
                # 空闲读不能再用 10s 握手超时：否则每 10s 触发一次 socket.timeout，
                # 会被外层当成断线。这里改成 ping 周期，读到超时就发应用层 ping。
                try:
                    self.ws.sock.settimeout(self.ping_s)
                except Exception:                 # noqa: BLE001
                    pass
                self.connected_once.set()      # 先发信号，避免回调里的网络调用拖住探测
                self.on_state("ws:connected")
                backoff = 1.0
                last_ping = time.time()
                while not self._stop.is_set():
                    try:
                        msg = self.ws.recv_json()
                    except (socket.timeout, TimeoutError):
                        # 空闲心跳：服务端回 pong 会继续走 recv_json；连续无响应由
                        # 上层最终超时/关闭触发重连，不在每次 timeout 都重连。
                        try:
                            self.ws.send_json({"type": "ping"})
                        except Exception:         # noqa: BLE001
                            break
                        last_ping = time.time()
                        continue
                    if msg is None:
                        break
                    if msg.get("type") == "msg":
                        try:
                            self.on_msg(msg)
                        except Exception as e:     # noqa: BLE001
                            # 单条坏消息不能把整条连接打断
                            self.on_state(f"ws:on_msg_error:{type(e).__name__}")
                    elif msg.get("type") == "event":
                        try:
                            event = msg.get("event") or {}
                            if event:
                                self.on_event(event)
                        except Exception as e:     # noqa: BLE001
                            self.on_state(f"ws:on_event_error:{type(e).__name__}")
                    if time.time() - last_ping > self.ping_s:
                        self.ws.send_json({"type": "ping"})
                        last_ping = time.time()
            except Exception as e:               # noqa: BLE001
                self.on_state(f"ws:error:{type(e).__name__}")
            finally:
                if self.ws:
                    self.ws.close()
                    self.ws = None
            self.on_state("ws:disconnected")
            if not self._stop.wait(backoff):
                backoff = min(backoff * 2, 30)

    def stop(self) -> None:
        self._stop.set()
        if self.ws:
            self.ws.close()
