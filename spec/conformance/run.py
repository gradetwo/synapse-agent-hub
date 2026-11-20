#!/usr/bin/env python3
"""一致性测试执行器：对任意 hub（mock 或真 Worker）跑 6 个用例。

用法：
  python3 spec/conformance/run.py --endpoint http://127.0.0.1:18099 --project yanshi --lease 3

判定：全部 PASS 才算合格；任一 FAIL 退出码 1。
"""
import argparse
import hashlib
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))


class Hub:
    def __init__(self, endpoint, project, admin_token="ADMIN"):
        self.ep = endpoint.rstrip("/")
        self.p = project
        self.admin = admin_token

    def _req(self, method, path, body=None, token=None, raw=False):
        data = None
        headers = {"authorization": f"Bearer {token or self.admin}"}
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = body
                headers["content-type"] = "application/octet-stream"
            else:
                data = json.dumps(body).encode()
                headers["content-type"] = "application/json"
        r = urllib.request.Request(self.ep + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                payload = resp.read()
                if raw:
                    return payload
                return json.loads(payload or b"{}")
        except urllib.error.HTTPError as e:
            return {"__status": e.code, "body": e.read()[:300].decode()}

    def publish(self, tok, topic, kind, payload=None, dedupe=None):
        return self._req("POST", f"/p/{self.p}/publish",
                         {"topic": topic, "kind": kind, "payload": payload or {}, "dedupe_key": dedupe}, token=tok)

    def inbox(self, tok, since=0):
        return self._req("GET", f"/p/{self.p}/inbox?since={since}", token=tok)

    def heartbeat(self, tok, work=None, load=None):
        return self._req("POST", f"/p/{self.p}/heartbeat",
                         {"agent_id": tok, "work": work or {"state": "busy"},
                          "load": load or {"cpu_pct": 20, "disk": [{"mount": "/", "free_gb": 10, "used_pct": 40}]}},
                         token=tok)

    def agents(self):
        return self._req("GET", f"/admin/p/{self.p}/agents")

    def upload(self, tok, name, data):
        sha = hashlib.sha256(data).hexdigest()
        r = self._req("PUT", f"/p/{self.p}/artifact/{sha}", data, token=tok)
        return sha, r

    def submit(self, tok, sid, refs, base="abc1234"):
        return self._req("POST", f"/p/{self.p}/submissions",
                         {"submission_id": sid, "agent_id": tok, "kind": "patch", "title": "t",
                          "base_sha": base, "refs": refs}, token=tok)

    def submissions(self):
        return self._req("GET", f"/admin/p/{self.p}/submissions")

    def claim(self, tok, task_id="T-1"):
        return self._req("POST", f"/p/{self.p}/tasks/claim", {"task_id": task_id}, token=tok)

    def broadcast(self, bid, title="main 已更新", action=None):
        return self._req("POST", f"/admin/p/{self.p}/broadcast",
                         {"broadcast_id": bid, "severity": "action", "title": title,
                          "action_required": action or {"kind": "git_pull", "ack_required": True}})


RESULTS = []


def case(name):
    def deco(fn):
        def run(*a):
            try:
                fn(*a)
                RESULTS.append((name, "PASS", ""))
                print(f"PASS  {name}")
            except Exception as e:
                RESULTS.append((name, "FAIL", str(e)))
                print(f"FAIL  {name}\n      {e}")
                if os.environ.get("VERBOSE"):
                    traceback.print_exc()
        run.__name__ = fn.__name__
        return run
    return deco


@case("01 心跳往返 + 名册可见")
def t01(h: Hub, a):
    r = h.heartbeat("agent-a")
    assert r.get("ok") is True, r
    d = h.agents()
    assert len(d["agents"]) >= 1, d
    assert d["agents"][0]["alive"] in ("alive", "late"), d["agents"][0]


@case("02 游标续传不丢不重")
def t02(h: Hub, a):
    h.publish("agent-a", "status", "x", {"n": 1}, dedupe="c02:a")
    d = h.inbox("agent-a", 0)
    assert len(d["messages"]) == 1, d
    cur = d["next_cursor"]
    h.publish("agent-a", "status", "x", {"n": 2}, dedupe="c02:b")
    d2 = h.inbox("agent-a", cur)
    assert len(d2["messages"]) == 1, f"应只看到 1 条新消息，实际 {d2}"
    assert d2["messages"][0]["seq"] > cur


@case("03 幂等发布（同 dedupe_key 只落一条）")
def t03(h: Hub, a):
    r1 = h.publish("agent-a", "status", "x", {"k": 1}, dedupe="c03:same")
    r2 = h.publish("agent-a", "status", "x", {"k": 1}, dedupe="c03:same")
    assert r1["seq"] == r2["seq"], (r1, r2)
    assert r2.get("deduped") is True, r2


@case("04 上传 → 建交付 → 重复提交去重 → 下载 sha 一致")
def t04(h: Hub, a):
    data = b"diff --git a/x b/x\n+hello\n"
    sha, up = h.upload("agent-a", "0049.patch", data)
    assert up.get("stored") is True, up
    r = h.submit("agent-a", "sub-a-0049", [{"sha256": sha, "name": "0049.patch", "bytes": len(data)}])
    assert r.get("state") == "delivered", r
    r2 = h.submit("agent-a", "sub-a-0049", [{"sha256": sha, "name": "0049.patch", "bytes": len(data)}])
    assert r2.get("state") == "delivered", r2
    rows = [x for x in h.submissions() if x["submission_id"] == "sub-a-0049"]
    assert len(rows) == 1, f"应只有 1 条，实际 {len(rows)}"
    got = h._req("GET", f"/p/{h.p}/artifact/{sha}", raw=True)
    assert hashlib.sha256(got).hexdigest() == sha, "下载内容与 sha 不一致"


@case("05 离线 outbox：断网排队、恢复重放、不重复")
def t05(h: Hub, a):
    import requests
    import yanshi as yh

    class Boom(Exception):
        pass

    tmp = Path(a.tmpdir) / "a5"
    c = yh.Client(h.ep, h.p, "agent-a", "agent-a", state_dir=tmp)
    orig = requests.post

    def flaky(*args, **kw):
        raise requests.RequestException("simulated offline")

    requests.post = flaky
    try:
        r = c.publish("status", "x", {"n": 5}, dedupe_key="c05:one")
        assert r.get("queued") is True, r
        assert c._outbox_count() == 1, c.status()
    finally:
        requests.post = orig

    drained = c.drain_outbox()
    assert drained["delivered"] == 1, drained
    assert c._outbox_count() == 0, c.status()
    # 重放后再发同 dedupe_key，服务端应去重
    again = c.publish("status", "x", {"n": 5}, dedupe_key="c05:one")
    assert again.get("deduped") is True, again


@case("06 租约到期被他人认领")
def t06(h: Hub, a):
    r = h.claim("agent-a", "T-1")
    assert r.get("ok") is True, r
    time.sleep(a.lease + 0.8)
    r2 = h.claim("agent-b", "T-1")
    assert r2.get("ok") is True, f"租约到期后应可被抢占，实际 {r2}"


@case("07 广播 + ack + supersedes")
def t07(h: Hub, a):
    h.heartbeat("agent-a")
    s1 = h.broadcast("bc-1", "main 到 abc1234", {"kind": "git_pull", "ack_required": True})
    assert s1.get("seq"), s1
    r = h._req("POST", f"/p/{h.p}/ack",
               {"seq": s1["seq"], "status": "done", "detail": {"after": "abc1234"}}, token="agent-a")
    assert r.get("ok") is True, r
    s2 = h._req("POST", f"/admin/p/{h.p}/broadcast",
                {"broadcast_id": "bc-2", "severity": "action", "title": "已前进到 def5678",
                 "action_required": {"kind": "git_pull", "ack_required": True}, "supersedes": "bc-1"})
    assert s2.get("seq", 0) > s1["seq"], s2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://127.0.0.1:18099")
    ap.add_argument("--project", default="yanshi")
    ap.add_argument("--lease", type=int, default=3)
    ap.add_argument("--tmpdir", default="/tmp")
    a = ap.parse_args()

    h = Hub(a.endpoint, a.project)
    for fn in (t01, t02, t03, t04, t05, t06, t07):
        fn(h, a)

    bad = [r for r in RESULTS if r[1] == "FAIL"]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} PASS")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
