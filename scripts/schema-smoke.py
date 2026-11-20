#!/usr/bin/env python3
"""空库 schema 冒烟：只用标准库 sqlite3 执行包内 worker/schema.sql。

用途：新部署前确认 settings/archive/artifacts 三张“运行期表”真的在包里，
而不是只存在于某台线上手工建过表的 D1。
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

REQUIRED = {
    "settings": {"key", "value"},
    "archive": {"project", "room", "seq", "sender", "topic", "kind", "to_agent", "payload_json", "ts"},
    "artifacts": {"project", "sha", "bytes", "created_at"},
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default=str(Path(__file__).resolve().parent.parent / "worker/schema.sql"))
    args = ap.parse_args()
    schema = Path(args.schema).read_text(encoding="utf-8")

    db = sqlite3.connect(":memory:")
    db.executescript(schema)

    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = set(REQUIRED) - tables
    if missing:
        raise SystemExit(f"FAIL: 缺表 {sorted(missing)}；实际 {sorted(tables)}")
    for table, cols in REQUIRED.items():
        actual = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        lack = cols - actual
        if lack:
            raise SystemExit(f"FAIL: {table} 缺列 {sorted(lack)}；实际 {sorted(actual)}")

    db.execute("INSERT INTO settings(key,value,updated_at) VALUES('sess_epoch','1',1)")
    db.execute("INSERT INTO archive(project,room,seq,sender,topic,kind,payload_json,ts) "
               "VALUES('p','r',1,'a','report','ok','{}','2026-01-01T00:00:00Z')")
    db.execute("INSERT INTO artifacts(project,sha,bytes,created_at) VALUES('p',?,12,1)", ("a" * 64,))
    assert db.execute("SELECT value FROM settings WHERE key='sess_epoch'").fetchone() == ("1",)
    assert db.execute("SELECT COUNT(*) FROM archive").fetchone() == (1,)
    assert db.execute("SELECT SUM(bytes) FROM artifacts").fetchone() == (12,)

    print(f"OK: {len(tables)} tables; settings/archive/artifacts CRUD passed")
    print("tables:", " ".join(sorted(tables)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
