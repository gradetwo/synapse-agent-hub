"""管理面（/x/admin/*）门面：调度、广播、交付物、吊销。

用法：
    c = Client.init(endpoint, project, token, agent_id="orchestrator")
    adm = c.as_admin()              # token 必须是 role=admin
    adm.send(["a", "b"], title="汇报状态", body="进度/磁盘/CPU")
    adm.broadcast(title="全量重编", body="各自 pull")
    adm.submissions(state="uncollected")
    adm.download(sid, to="./incoming")

设计说明：管理面与 agent 面共用同一枚 token 与同一个 HTTP 会话，role 只在服务端生效；
SDK 不额外保存第二份凭据，避免"一把钥匙两种身份"。
"""
from __future__ import annotations

import os
import zipfile
from pathlib import Path
from typing import Any, Iterable


def _safe_extract(z: "zipfile.ZipFile", out: Path) -> None:
    """逐条校验后再解包：拒绝绝对路径、`..`、符号链接（防 Zip Slip）。"""
    root = out.resolve()
    for m in z.infolist():
        name = m.filename
        if name.startswith(("/", "\\")) or ".." in Path(name).parts:
            raise AdminError(f"交付物含非法路径：{name}")
        if (m.external_attr >> 16) & 0o170000 == 0o120000:   # S_IFLNK
            raise AdminError(f"交付物含符号链接：{name}")
        target = (root / name).resolve()
        if not str(target).startswith(str(root) + os.sep) and target != root:
            raise AdminError(f"交付物越界：{name}")
        if name.endswith("/"):
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(m) as src, open(target, "wb") as dst:
            dst.write(src.read())


class AdminError(RuntimeError):
    """管理接口错误；message 里带服务端原话，便于直接定位权限问题。"""


class Admin:
    def __init__(self, client):
        self.c = client
        self.project = client.project

    # ── 基础请求 ────────────────────────────────────────────
    def _p(self, suffix: str) -> str:
        return f"/x/admin/p/{self.project}{suffix}"

    def _get(self, suffix: str) -> dict:
        try:
            return self.c._get(self._p(suffix))
        except Exception as e:                      # noqa: BLE001
            raise AdminError(f"GET {suffix} 失败：{e}") from e

    def _post(self, suffix: str, body: dict) -> dict:
        try:
            return self.c._post(self._p(suffix), body)
        except Exception as e:                      # noqa: BLE001
            raise AdminError(f"POST {suffix} 失败：{e}") from e

    # ── 只读观测 ────────────────────────────────────────────
    def agents(self) -> list[dict]:
        return self._get("/agents").get("agents", [])

    def stats(self) -> dict:
        return self.c._get("/x/admin/stats")

    def messages(self, limit: int = 50, desc: bool = True) -> list[dict]:
        q = f"/messages?limit={limit}" + ("&desc=1" if desc else "")
        return self._get(q).get("messages", [])

    def wsstat(self) -> int:
        # 该接口在数据面（/p/…/wsstat），不在 /x/admin 下
        return self.c._get(f"/p/{self.project}/wsstat").get("sockets", 0)

    def agent(self, agent_id: str) -> dict:
        return self._get(f"/agent/{agent_id}")

    # ── 任务台账 ────────────────────────────────────────────
    def task_new(self, task_id: str, title: str, body: str = "",
                 to: str | None = None) -> dict:
        """创建任务；to 为空则进公共任务池，指定则只有该 agent 能 claim。"""
        return self._post("/tasks", {"task_id": task_id, "title": title,
                                     "body": body, "to": to or None})

    def tasks(self) -> list[dict]:
        return self._get("/tasks").get("tasks", [])

    def task_close(self, task_id: str, reason: str = "") -> dict:
        return self._post("/tasks/close", {"task_id": task_id, "reason": reason})

    def task_reclaim(self, task_id: str, reason: str = "") -> dict:
        return self._post("/tasks/reclaim", {"task_id": task_id, "reason": reason})

    # ── Issue 台账（管理侧）────────────────────────────────
    def issues(self, status: str = "") -> dict:
        q = f"/issues?status={status}" if status else "/issues"
        return self._get(q)

    def issue_close(self, issue_id: str, reason: str = "管理员关闭") -> dict:
        return self._post(f"/issues/{issue_id}/close", {"reason": reason})

    def issue_reopen(self, issue_id: str) -> dict:
        return self._post(f"/issues/{issue_id}/reopen", {})

    def issue_merge(self, issue_id: str, into: str) -> dict:
        return self._post(f"/issues/{issue_id}/merge", {"into": into})

    def issue_dispatch(self, issue_id: str, to: str | None = None,
                       task_id: str = "", body: str = "") -> dict:
        payload: dict[str, Any] = {"to": to or None, "task_id": task_id}
        if body:
            payload["body"] = body
        return self._post(f"/issues/{issue_id}/dispatch", payload)

    def task_reassign(self, task_id: str, to: str, reason: str = "") -> dict:
        return self._post("/tasks/reassign", {"task_id": task_id, "to": to, "reason": reason})

    # ── 下发 ────────────────────────────────────────────────
    def send(self, to: Iterable[str], title: str = "", body: str = "",
             ack: bool = True, kind: str = "task") -> dict:
        """定向下发；to 为空视为广播（与 broadcast 同义）。"""
        who = [x for x in (to or []) if x]
        if not who:
            return self.broadcast(title=title, body=body, ack=ack, kind=kind)
        return self._post("/send", {
            "to": who, "title": title or "(无标题)", "body": body, "kind": kind,
            "action_required": {"kind": kind, "ack_required": ack},
        })

    def broadcast(self, title: str, body: str = "", ack: bool = True,
                  kind: str = "task", broadcast_id: str | None = None) -> dict:
        return self._post("/broadcast", {
            "broadcast_id": broadcast_id or f"bc-{int(__import__('time').time() * 1000)}",
            "title": title or "(无标题)", "body": body, "kind": kind,
            "action_required": {"kind": kind, "ack_required": ack},
        })

    # ── 交付物 ──────────────────────────────────────────────
    def submissions(self, state: str | None = None) -> list[dict]:
        q = f"/submissions?state={state}" if state else "/submissions"
        r = self._get(q)
        # 服务端当前返回裸数组；兼容未来改成 {submissions:[...]} 的版本
        return r if isinstance(r, list) else r.get("submissions", [])

    def download(self, submission_id: str | dict, to: str | Path = ".",
                 unzip: bool = True) -> Path:
        """取交付物 zip（含 PROVENANCE.json）；默认顺手解到同名目录。
        submission_id 既可以是字符串，也可以直接传 submissions() 返回的 dict。"""
        if isinstance(submission_id, dict):
            submission_id = submission_id.get("submission_id", "")
        url = self.c.endpoint + self._p(f"/submissions/{submission_id}/bundle")
        r = self.c._sess.get(url, headers=self.c._headers(), timeout=90)
        if r.status_code == 404:
            raise AdminError(f"交付物不存在：{submission_id}")
        if r.status_code >= 400:
            raise AdminError(f"下载失败 HTTP {r.status_code}：{r.text[:120]}")
        dest = Path(to)
        # 约定：to 以 .zip 结尾才当文件名，否则当目录（不存在就创建）
        if dest.suffix.lower() != ".zip":
            dest = dest / f"{submission_id}.zip"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        if unzip:
            out = dest.with_suffix("")
            out.mkdir(parents=True, exist_ok=True)
            try:
                with zipfile.ZipFile(dest) as z:
                    _safe_extract(z, out)
            except zipfile.BadZipFile as e:
                raise AdminError(f"{submission_id} 不是合法 zip：{e}") from e
        return dest

    # ── 生命周期 ────────────────────────────────────────────
    def revoke(self, agent_id: str) -> dict:
        return self.c._delete("/x/admin/agents", {"project": self.project, "agent_id": agent_id})

    def issue(self, agent_id: str, role: str = "agent", scopes: list[str] | None = None,
              ttl_days: int = 30, rotate: bool = True) -> dict:
        """给（或重签）某个 agent 发 token；返回里含明文 token（只此一次）。"""
        body: dict[str, Any] = {"project": self.project, "agent_id": agent_id,
                                "role": role, "ttl_days": ttl_days, "rotate": rotate}
        if scopes:
            body["scopes"] = scopes
        return self.c._post("/x/admin/agents", body)

    def approve(self, enrollment_id: str, scopes: list[str] | None = None) -> dict:
        body = {"scopes": scopes} if scopes else {}
        return self.c._post(f"/admin/enrollments/{enrollment_id}/approve", body)

    def __repr__(self) -> str:
        return f"<Admin project={self.project} endpoint={self.c.endpoint}>"
