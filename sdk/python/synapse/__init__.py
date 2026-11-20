"""synapse-agent：多项目 / 多平台的 agent 接入 SDK（Python 版）。

设计原则（与 TS / Rust 版保持一致）：
  1. 心跳由 SDK 托管（60s ± 15s 抖动），agent 只回答"我在忙什么"
  2. 游标原子落盘，处理成功才前移
  3. 离线队列（outbox）保证 publish / upload 不丢
  4. token 永不进日志，只显示前 6 位
"""
from .loop import Loop
from .admin import Admin, AdminError
from .client import Client, Work, TaskLease, __version__

__all__ = ["Client", "Work", "TaskLease", "Loop", "__version__"]
