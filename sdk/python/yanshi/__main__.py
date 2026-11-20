"""兼容入口：`python -m yanshi` 转发到 `synapse` 的 CLI。"""
from synapse.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
