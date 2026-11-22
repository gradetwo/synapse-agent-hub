#!/usr/bin/env bash
# 统一升级 SDK 发版号（不是 BUILD_TAG）。
#
# 用法：
#   ./scripts/bump-sdk.sh 0.5.2
#   ./scripts/bump-sdk.sh 0.5.2 --dry-run
#
# 会同步：VERSION / Worker SDK_VERSION / Rust Cargo / Python / TS / OpenAPI /
# README / DESIGN / PACKAGE-MANIFEST / SDK 差异文档。
# BUILD_TAG 是部署批次标记，不随 SDK 版本变化；需要时另改 worker/src/worker.ts。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEW="${1:?用法: scripts/bump-sdk.sh <版本号> [--dry-run]}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

if ! printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$'; then
  echo "✗ 版本号不合法：$NEW（示例：0.5.2 / 1.0.0-rc.1）" >&2
  exit 2
fi

python3 - "$ROOT" "$NEW" "$DRY_RUN" <<'PY'
import datetime
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
new = sys.argv[2]
dry = sys.argv[3] == "1"
changed = []
missing = []
pending = {}

def edit(rel, pattern, repl, count=1, flags=0, required=True):
    path = root / rel
    if not path.exists():
        if required:
            missing.append(rel)
        return
    text = pending.get(str(path), path.read_text(encoding="utf-8"))
    out, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n == 0:
        if required:
            missing.append(rel)
        return
    if out != text:
        changed.append((rel, n))
        pending[str(path)] = out

# 结构化/运行时常量
edit("VERSION", r"(?m)^sdk_version=.*$", f"sdk_version={new}")
edit("worker/src/worker.ts", r'(const SDK_VERSION = ")[^"]+(";)', rf'\g<1>{new}\g<2>')
edit("sdk/rust/Cargo.toml", r'(?m)^version = "[^"]+"', f'version = "{new}"')
# Cargo.lock 可能被 .gitignore 排除（新克隆/归档里没有），有则更新，没有就跳过。
edit("sdk/rust/Cargo.lock",
     r'(name = "synapse-agent"\nversion = ")[^"]+(")',
     rf'\g<1>{new}\g<2>', required=False)
edit("sdk/python/pyproject.toml", r'(?m)^version = "[^"]+"', f'version = "{new}"')
edit("sdk/python/synapse/client.py", r'(?m)^__version__ = "[^"]+"', f'__version__ = "{new}"')
edit("sdk/ts/package.json", r'("version": ")[^"]+(")', rf'\g<1>{new}\g<2>')
# lock 顶层和 packages[""] 两处
edit("sdk/ts/package-lock.json", r'("version": ")[^"]+(")', rf'\g<1>{new}\g<2>', count=2)
edit("sdk/ts/src/client.ts", r'(const VERSION = ")[^"]+(";)', rf'\g<1>{new}\g<2>')

# 协议与发布快照
edit("spec/openapi.yaml", r'(?m)^  version: .*$', f'  version: {new}')
edit("README.md", r'\| SDK version \| `[^`]+` \|', f'| SDK version | `{new}` |')
edit("README.md", r'(spec/openapi\.yaml\s+协议定义（)[^）]+(）)', rf'\g<1>{new}\g<2>', required=False)
edit("PACKAGE-MANIFEST.txt", r'(?m)^sdk_version:\s+.*$', f'sdk_version:  {new}')
edit("PACKAGE-MANIFEST.txt", r'(spec/openapi\.yaml（)[^，]+(，)', rf'\g<1>{new}\g<2>', required=False)
edit("DESIGN.md", r'(> 版本 v)[^ ]+( ·)', rf'\g<1>{new}\g<2>', required=False)
edit("docs/SDK-接入与差异.md", r'(# Synapse 三语言 SDK 接入与差异（)[^）]+(）)', rf'\g<1>{new}\g<2>', required=False)
edit("docs/SDK-接入与差异.md", r'(- SDK 版本：`)[^`]+(`)', rf'\g<1>{new}\g<2>', required=False)

if missing:
    print("✗ 找不到版本字段：" + ", ".join(missing), file=sys.stderr)
    sys.exit(3)

# 全部字段都命中后才落盘，避免中途失败留下半升级状态。
if not dry:
    for path_str, out in pending.items():
        Path(path_str).write_text(out, encoding="utf-8")
    # 版本字段落盘后再盖章日期，避免被 pending 的旧快照覆盖。
    vp = root / "VERSION"
    if vp.exists():
        t = vp.read_text(encoding="utf-8")
        t2 = re.sub(r"(?m)^snapshot_date=.*$",
                    f"snapshot_date={datetime.date.today().isoformat()}", t, count=1)
        if t2 != t:
            vp.write_text(t2, encoding="utf-8")

if dry:
    print(f"dry-run：将把 {len(changed)} 个文件升级到 {new}")
else:
    print(f"✓ SDK 版本已升级到 {new}（{len(changed)} 个文件）")
for rel, n in changed:
    print(f"  - {rel} ({n} 处)")

print("注意：BUILD_TAG 独立于 SDK 版本；发版还需编译并上传对应平台 binary，再 deploy Worker。")
PY
