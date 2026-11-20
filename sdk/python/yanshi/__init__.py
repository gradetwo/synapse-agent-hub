"""兼容旧名：`import yanshi` 仍可用，实现已迁到 `synapse`（这里只是转发，不放实现）。"""
import sys as _sys

import synapse as _s
from synapse import Client, Loop, Work, TaskLease, __version__  # noqa: F401
from synapse.admin import Admin, AdminError  # noqa: F401
from synapse.profile import detect  # noqa: F401

for _n in ("client", "loop", "ws", "admin", "profile"):
    _sys.modules[f"yanshi.{_n}"] = __import__(f"synapse.{_n}", fromlist=["*"])
