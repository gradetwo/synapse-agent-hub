"""synapse CLI：init / daemon / once / status

设计要点：装完一次 `synapse init` 后，心跳由 SDK 自己在后台线程维持，
agent 不需要在每次任务里手动调用 heartbeat。
"""
import argparse
import json
import os
import signal
import sys
import time

from .client import Client


def cmd_init(a):
    c = Client.init(a.endpoint, a.project, a.token, a.agent)
    print(f"✓ 已初始化 project={c.project} agent={c.agent_id}")
    print(f"  配置：{c.state_dir / 'config.json'}（600）")
    return 0


def cmd_once(a):
    c = Client.from_config()
    print(c.heartbeat_once())
    return 0


def cmd_status(a):
    c = Client.from_config()
    print(c.status())
    return 0


def cmd_profile(a):
    from .profile import detect
    print(json.dumps(detect(), ensure_ascii=False, indent=2))
    return 0


def cmd_update(a):
    c = Client.from_config(auto=False)
    print(json.dumps(c.check_update(), ensure_ascii=False, indent=2))
    return 0


def cmd_daemon(a):
    """常驻：长连接优先，连不上自动回退轮询；消息落到 inbox/ 与 INBOX.md。"""
    c = Client.from_config(auto=False)
    from .loop import Loop
    transport = "poll" if os.environ.get("YANSHI_NO_WS") == "1" else "auto"
    loop = Loop(c, transport=transport)
    print(f"→ daemon 已启动 project={c.project} agent={c.agent_id} "
          f"transport={loop.mode} 每 {c.heartbeat_s}s 一拍", flush=True)

    def handler(m, _loop):
        c.deliver([m])
        print(f"  ← 新指令 #{m.get('seq')} {m.get('topic')}", flush=True)

    try:
        loop.serve(handler)
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()
    print("→ daemon 退出")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="synapse")
    sub = p.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("init")
    i.add_argument("--endpoint", required=True)
    i.add_argument("--project", required=True)
    i.add_argument("--token", required=True)
    i.add_argument("--agent", default=None)
    i.set_defaults(fn=cmd_init)

    d = sub.add_parser("daemon"); d.set_defaults(fn=cmd_daemon)
    o = sub.add_parser("once"); o.set_defaults(fn=cmd_once)
    s = sub.add_parser("status"); s.set_defaults(fn=cmd_status)
    pr = sub.add_parser("profile"); pr.set_defaults(fn=cmd_profile)
    up = sub.add_parser("update-check"); up.set_defaults(fn=cmd_update)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
