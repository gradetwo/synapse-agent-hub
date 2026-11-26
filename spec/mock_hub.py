#!/usr/bin/env python3
"""mock_hub —— 内存版 Agent Hub，用于在本地跑一致性用例（不需要 CF 账号）。

刻意与 worker 语义保持一致：
  · seq 每项目单调递增；dedupe_key 幂等
  · 心跳覆盖写、alive/late/offline 判定、采样桶
  · 任务租约（mock 默认 3 秒，便于测试；生产默认 12 小时）
  · 交付三态 delivered/collected/archived
  · blob 内容寻址（sha256 即 key）

用法： python3 spec/mock_hub.py --port 18099 --lease 3
"""
import argparse
import hashlib
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LEASE_TTL = 3
HB_PERIOD = 60
LOCK = threading.RLock()
PROJECTS = {"yanshi": {"project": "yanshi", "display_name": "偃师", "status": "active",
                        "max_agents": 200, "max_storage_mb": 2048, "max_msgs_per_min": 60,
                        "retention_days": 30, "github_repo": None, "github_branch": None,
                        "created_at": int(time.time() * 1000),
                        "created_by": "admin", "updated_by": "admin",
                        "updated_at": int(time.time() * 1000)}}
PROJECT_AUDIT = []
POLICY = {"mode": "all", "projects": []}
REPO_ENV = {"repo": "gradetwo/synapse-agent-hub", "branch": "main"}
STATE = {}          # project -> dict(seq, msgs, dedupe, hb, tasks, acks, bc, superseded)
SUBS = {}           # (project, sid) -> dict
BLOBS = {}          # (project, sha) -> bytes


def st(project):
    with LOCK:
        if project not in STATE:
            STATE[project] = {"seq": 0, "msgs": {}, "dedupe": {}, "hb": {},
                              "tasks": {"T-1": {"id": "T-1", "state": "open", "owner": None, "lease_until": 0}},
                              "acks": {}, "bc": {}, "superseded": set()}
        return STATE[project]


def append(project, msg):
    s = st(project)
    s["seq"] += 1
    msg["seq"] = s["seq"]
    msg["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    s["msgs"][s["seq"]] = msg
    if msg.get("dedupe_key"):
        s["dedupe"][msg["dedupe_key"]] = s["seq"]
    return s["seq"]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # ── 工具 ────────────────────────────────────────────
    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.headers.get("content-type", "").startswith("application/json"):
            return json.loads(raw or b"{}")
        return raw

    def _out(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        tok = (self.headers.get("authorization") or "").replace("Bearer ", "").strip()
        if tok == "ADMIN":
            return {"ok": True, "agent_id": "admin", "role": "admin"}
        if tok:
            return {"ok": True, "agent_id": tok, "role": "agent"}
        return {"ok": False}

    def _parts(self):
        u = urlparse(self.path)
        return [p for p in u.path.split("/") if p], parse_qs(u.query)

    # ── 路由 ────────────────────────────────────────────
    def do_GET(self):
        if self.path == "/":
            return self._out({"ok": True, "mock": True})
        seg, q = self._parts()
        if not self._auth()["ok"]:
            return self._out({"error": "missing_token"}, 401)

        if seg[:1] == ["p"] and len(seg) >= 3:
            project, action = seg[1], "/".join(seg[2:])
            if action == "inbox":
                since = int(q.get("since", ["0"])[0])
                s = st(project)
                msgs = [m for k, m in sorted(s["msgs"].items()) if k > since]
                nxt = msgs[-1]["seq"] if msgs else since
                return self._out({"messages": msgs[:100], "next_cursor": nxt, "has_more": len(msgs) > 100})
            if action.startswith("artifact/"):
                sha = action.split("/", 1)[1]
                data = BLOBS.get((project, sha))
                if not data:
                    return self._out({"error": "blob_not_found"}, 404)
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

        if seg[:1] == ["admin"]:
            if seg == ["admin", "projects"]:
                rows = [p for p in PROJECTS.values()
                        if POLICY["mode"] == "all" or p["project"] in POLICY["projects"]]
                q = parse_qs(urlparse(self.path).query)
                payload = {"policy": POLICY, "projects": rows,
                           "hidden": len(PROJECTS) - len(rows)}
                if q.get("include_hidden", ["0"])[0] == "1":
                    payload["all_projects"] = list(PROJECTS.values())
                return self._out(payload)
            if seg == ["admin", "visibility"]:
                return self._out(POLICY)
            if len(seg) == 4 and seg[1] == "projects" and seg[3] == "audit":
                project = seg[2]
                entries = [a for a in PROJECT_AUDIT if a["project"] == project][-20:]
                return self._out({"ok": True, "project": project, "entries": entries})
            if len(seg) == 4 and seg[1] == "p" and seg[3] == "error-stats":
                return self._out({"ok": True, "days": 7, "total": 3,
                                  "counts": {"insufficient_scope": 2, "bad_request": 1},
                                  "last": {"code": "insufficient_scope", "at": int(time.time() * 1000),
                                           "path": "/p/demo", "status": 403}})
            if len(seg) == 4 and seg[1] == "p" and seg[3] == "snapshot":
                s = st(seg[2])
                return self._out({"seq": s["seq"], "agents": [], "tasks": []})
            if len(seg) == 5 and seg[1] == "p" and seg[3] == "repo" and seg[4] == "status":
                p = PROJECTS.get(seg[2], {})
                repo = p.get("github_repo") or REPO_ENV["repo"]
                branch = p.get("github_branch") or REPO_ENV["branch"]
                return self._out({"repo": repo, "branch": branch,
                                  "repo_source": "project" if p.get("github_repo") else "env",
                                  "branch_source": "project" if p.get("github_branch") else "default",
                                  "token_configured": False,
                                  "target_sha": "abcdef1234567890", "error": None,
                                  "last_project_check": "abcdef1234567890",
                                  "last_project_check_at": int(time.time() * 1000)})
            if len(seg) == 4 and seg[1] == "p" and seg[3] == "agents":
                project = seg[2]
                s = st(project)
                now = int(time.time() * 1000)
                rows = []
                for aid, h in s["hb"].items():
                    age = now - h["last_hb_ms"]
                    alive = "alive" if age <= 2 * HB_PERIOD * 1000 else \
                            "late" if age <= 5 * HB_PERIOD * 1000 else "offline"
                    rows.append({**h, "agent_id": aid, "alive": alive, "age_s": age // 1000})
                return self._out({"agents": rows})
            if len(seg) == 4 and seg[1] == "p" and seg[3] == "submissions":
                project = seg[2]
                rows = [v for k, v in SUBS.items() if k[0] == project]
                return self._out(rows)
        return self._out({"error": "not_found", "path": self.path}, 404)

    def do_PUT(self):
        seg, _ = self._parts()
        if not self._auth()["ok"]:
            return self._out({"error": "missing_token"}, 401)
        if len(seg) >= 4 and seg[0] == "p" and seg[2] == "artifact":
            project, sha = seg[1], seg[3]
            data = self._body()
            if hashlib.sha256(data).hexdigest() != sha:
                return self._out({"error": "sha_mismatch"}, 422)
            BLOBS[(project, sha)] = data
            return self._out({"stored": True, "sha256": sha})
        return self._out({"error": "not_found"}, 404)

    def do_PATCH(self):
        seg, _ = self._parts()
        auth = self._auth()
        if not auth["ok"]:
            return self._out({"error": "missing_token"}, 401)
        b = self._body()
        if len(seg) == 3 and seg[1] == "projects":
            project = seg[2]
            p = PROJECTS.get(project)
            if not p:
                return self._out({"error": "project_not_found"}, 404)
            before = dict(p)
            p["display_name"] = b.get("display_name", p.get("display_name", project)) or project
            status = str(b.get("status", p.get("status", "active"))).lower()
            if status not in ("active", "paused", "archived"):
                return self._out({"error": "bad_project_status"}, 422)
            p["status"] = status
            if "github_repo" in b:
                repo = str(b.get("github_repo") or "").strip()
                if repo and not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo):
                    return self._out({"error": "bad_github_repo"}, 422)
                p["github_repo"] = repo or None
            if "github_branch" in b:
                branch = str(b.get("github_branch") or "").strip()
                if branch and (not re.match(r"^[A-Za-z0-9._/-]{1,100}$", branch) or ".." in branch):
                    return self._out({"error": "bad_github_branch"}, 422)
                p["github_branch"] = branch or None
            for k, lo, hi in (("max_agents", 1, 1000), ("max_storage_mb", 1, 10240),
                              ("max_msgs_per_min", 1, 1000), ("retention_days", 1, 3650)):
                if k in b:
                    n = int(b[k])
                    if n < lo or n > hi:
                        return self._out({"error": "bad_project_quota", "field": k}, 422)
                    p[k] = n
            p["updated_by"] = "admin"
            p["updated_at"] = int(time.time() * 1000)
            PROJECT_AUDIT.append({"id": len(PROJECT_AUDIT) + 1, "project": project,
                                  "action": "update", "actor": "admin",
                                  "at": p["updated_at"], "before": before,
                                  "after": dict(p)})
            return self._out({"ok": True, "changed": True, "project": project,
                              "before": before, "after": dict(p),
                              "updated_by": "admin", "updated_at": p["updated_at"]})
        return self._out({"error": "not_found"}, 404)

    def do_POST(self):
        seg, _ = self._parts()
        auth = self._auth()
        if not auth["ok"]:
            return self._out({"error": "missing_token"}, 401)
        b = self._body()
        project = seg[1] if seg[:1] == ["p"] and len(seg) > 2 else None
        action = "/".join(seg[2:]) if project else None

        if project:
            b.setdefault("agent_id", auth["agent_id"])
            b.setdefault("project", project)
            s = st(project)

            if action == "publish":
                if not b.get("dedupe_key"):
                    return self._out({"error": "dedupe_key_required"}, 422)
                if b["dedupe_key"] in s["dedupe"]:
                    return self._out({"seq": s["dedupe"][b["dedupe_key"]], "deduped": True})
                return self._out({"seq": append(project, b)})

            if action == "heartbeat":
                s["hb"][b["agent_id"]] = {
                    "work": b.get("work", {"state": "idle"}), "load": b.get("load", {}),
                    "env": b.get("env", {}), "last_hb_ms": int(time.time() * 1000),
                    "hb_count": s["hb"].get(b["agent_id"], {}).get("hb_count", 0) + 1,
                }
                for t in s["tasks"].values():
                    if t["owner"] == b["agent_id"] and t["state"] == "claimed":
                        t["lease_until"] = int(time.time() * 1000) + LEASE_TTL * 1000
                return self._out({"ok": True, "next_in_s": HB_PERIOD, "server_ms": int(time.time() * 1000)})

            if action == "ack":
                box = s["acks"].get(b["seq"])
                if not box:
                    return self._out({"ok": False, "reason": "no_such_broadcast"}, 404)
                box["pending"] = [a for a in box["pending"] if a != b["agent_id"]]
                box["done"][b["agent_id"]] = {"status": b["status"], "detail": b.get("detail", {})}
                append(project, {"sender": b["agent_id"], "topic": "ack", "kind": b["status"],
                                 "payload": {"seq": b["seq"]}, "dedupe_key": f"ack:{b['seq']}:{b['agent_id']}"})
                return self._out({"ok": True})

            if action == "report":
                return self._out({"ok": True, "seq": append(project, {
                    "sender": b["agent_id"], "topic": "report", "kind": b.get("report_id", "report"),
                    "payload": b, "dedupe_key": f"report:{b.get('report_id')}:{b['agent_id']}"})})

            if action == "tasks/claim":
                t = s["tasks"].get(b["task_id"])
                if not t:
                    return self._out({"error": "not_found"}, 404)
                now = int(time.time() * 1000)
                if t["state"] != "open" and not (t["state"] == "claimed" and t["lease_until"] < now):
                    return self._out({"error": "locked", "owner": t["owner"]}, 409)
                t.update(state="claimed", owner=b["agent_id"], lease_until=now + LEASE_TTL * 1000)
                return self._out({"ok": True, "lease_until": t["lease_until"]})

            if action == "tasks/release":
                t = s["tasks"].get(b["task_id"])
                if not t:
                    return self._out({"error": "not_found"}, 404)
                if t["owner"] != b["agent_id"]:
                    return self._out({"error": "not_owner"}, 403)
                t.update(state=b.get("state", "done"), owner=None, lease_until=0)
                return self._out({"ok": True})

            if action == "submissions":
                if not b.get("base_sha"):
                    return self._out({"error": "base_sha_required"}, 422)
                for r in b.get("refs", []):
                    if (project, r["sha256"]) not in BLOBS:
                        return self._out({"error": f"blob_missing:{r['sha256']}"}, 422)
                key = (project, b["submission_id"])
                if key in SUBS:
                    SUBS[key]["updated_at"] = int(time.time() * 1000)
                    return self._out({"submission_id": b["submission_id"], "state": SUBS[key]["state"], "deduped": True})
                rec = {**b, "state": "delivered", "result": None,
                       "refs_json": json.dumps(b.get("refs", [])), "checks_json": json.dumps(b.get("checks", {})),
                       "created_at": int(time.time() * 1000), "updated_at": int(time.time() * 1000)}
                SUBS[key] = rec
                append(project, {"sender": b["agent_id"], "topic": "artifact", "kind": b["kind"],
                                 "payload": {"submission_id": b["submission_id"]},
                                 "dedupe_key": f"sub:{b['submission_id']}:{b['agent_id']}"})
                return self._out({"submission_id": b["submission_id"], "state": "delivered"})

        if seg[:1] == ["admin"]:
            if seg == ["admin", "projects"]:
                project = b["project"]
                if project in PROJECTS:
                    return self._out({"ok": True, "created": False, "existing": True, "project": project})
                now = int(time.time() * 1000)
                PROJECTS[project] = {
                    "project": project,
                    "display_name": b.get("display_name", project),
                    "status": "active",
                    "max_agents": b.get("max_agents", 200),
                    "max_storage_mb": b.get("max_storage_mb", 2048),
                    "max_msgs_per_min": b.get("max_msgs_per_min", 60),
                    "retention_days": b.get("retention_days", 30),
                    "github_repo": b.get("github_repo") or None,
                    "github_branch": b.get("github_branch") or None,
                    "created_at": now, "created_by": "admin", "updated_by": "admin",
                    "updated_at": now,
                }
                PROJECT_AUDIT.append({"id": len(PROJECT_AUDIT) + 1, "project": project,
                                      "action": "create", "actor": "admin", "at": now,
                                      "before": {}, "after": dict(PROJECTS[project])})
                return self._out({"ok": True, "created": True, "project": project})
            if len(seg) == 3 and seg[1] == "projects":
                project = seg[2]
                p = PROJECTS.get(project)
                if not p:
                    return self._out({"error": "project_not_found"}, 404)
                before = dict(p)
                p["display_name"] = b.get("display_name", p.get("display_name", project)) or project
                status = str(b.get("status", p.get("status", "active"))).lower()
                if status not in ("active", "paused", "archived"):
                    return self._out({"error": "bad_project_status"}, 422)
                p["status"] = status
                if "github_repo" in b:
                    repo = str(b.get("github_repo") or "").strip()
                    if repo and not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo):
                        return self._out({"error": "bad_github_repo"}, 422)
                    p["github_repo"] = repo or None
                if "github_branch" in b:
                    branch = str(b.get("github_branch") or "").strip()
                    if branch and (not re.match(r"^[A-Za-z0-9._/-]{1,100}$", branch) or ".." in branch):
                        return self._out({"error": "bad_github_branch"}, 422)
                    p["github_branch"] = branch or None
                for k, lo, hi in (("max_agents", 1, 1000), ("max_storage_mb", 1, 10240),
                                  ("max_msgs_per_min", 1, 1000), ("retention_days", 1, 3650)):
                    if k in b:
                        n = int(b[k])
                        if n < lo or n > hi:
                            return self._out({"error": "bad_project_quota", "field": k}, 422)
                        p[k] = n
                p["updated_by"] = "admin"
                p["updated_at"] = int(time.time() * 1000)
                PROJECT_AUDIT.append({"id": len(PROJECT_AUDIT) + 1, "project": project,
                                      "action": "update", "actor": "admin",
                                      "at": p["updated_at"], "before": before,
                                      "after": dict(p)})
                return self._out({"ok": True, "changed": True, "project": project,
                                  "before": before, "after": dict(p),
                                  "updated_by": "admin", "updated_at": p["updated_at"]})
            if len(seg) == 5 and seg[1] == "p" and seg[3] == "repo" and seg[4] == "applicability":
                return self._out({"ok": True, "target_sha": "abcdef1234567890",
                                  "checked": 2, "conflicts": 1, "errors": 0, "skipped": 0})
            if seg == ["admin", "visibility"]:
                POLICY.update(mode=b.get("mode", "all"), projects=b.get("projects", []))
                return self._out({"ok": True})
            if seg == ["admin", "agents"]:
                return self._out({"token": b.get("agent_id", "agent"), "scopes": ["poll", "publish"]})
            if len(seg) == 4 and seg[1] == "p" and seg[3] == "broadcast":
                project = seg[2]
                s = st(project)
                if b["broadcast_id"] in s["bc"]:
                    return self._out({"seq": s["bc"][b["broadcast_id"]], "deduped": True})
                seq = append(project, {"sender": "admin", "topic": "announce", "kind": "broadcast",
                                       "payload": b, "dedupe_key": f"bc:{b['broadcast_id']}"})
                s["bc"][b["broadcast_id"]] = seq
                s["acks"][seq] = {"pending": list(s["hb"].keys()), "done": {},
                                  "required": b.get("action_required", {}).get("ack_required", False)}
                if b.get("supersedes"):
                    old = s["bc"].get(b["supersedes"])
                    if old:
                        s["superseded"].add(old)
                return self._out({"seq": seq})
            m = [x for x in seg]
            if len(seg) == 5 and seg[1] == "p" and seg[3] == "submissions" and seg[4] in ("collect", "archive"):
                pass
            if len(seg) == 6 and seg[1] == "p" and seg[3] == "submissions":
                project, sid, op = seg[2], seg[4], seg[5]
                rec = SUBS.get((project, sid))
                if not rec:
                    return self._out({"error": "not_found"}, 404)
                if op == "collect":
                    rec["state"] = "collected"
                elif op == "archive":
                    rec["state"] = "archived"
                elif op == "result":
                    rec["result"] = b.get("result")
                rec["updated_at"] = int(time.time() * 1000)
                return self._out({"ok": True})
        return self._out({"error": "not_found", "path": self.path}, 404)


def main():
    global LEASE_TTL
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18099)
    ap.add_argument("--lease", type=int, default=3)
    a = ap.parse_args()
    LEASE_TTL = a.lease
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"mock hub on http://127.0.0.1:{a.port} lease={LEASE_TTL}s", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
