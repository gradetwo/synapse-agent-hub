#!/usr/bin/env bash
# Synapse 部署脚本
#
# 两种模式，互不混用：
#   bootstrap  空 Cloudflare 账号初始化：建 D1/R2、建表、设 secret、首次 deploy
#   release    线上增量更新：只重建/上传变化的 binary，按需 deploy Worker
#
# 默认发布四套二进制：
#   linux-x64 / linux-arm64 / linux-x64-gnu / win-x64
#
# 用法：
#   ./scripts/deploy.sh bootstrap --fresh --yes
#   ./scripts/deploy.sh release --yes
#   ./scripts/deploy.sh release --since HEAD~1 --dry-run
#   ./scripts/deploy.sh release --targets linux-x64,linux-arm64,linux-x64-gnu,win-x64 --yes
#
# 说明：
# - release 不会创建 D1/R2，不会重跑 schema.sql，不会轮换 SESSION_SECRET。
# - admin/index.html 是内联进 Worker 的，改 HTML 必须 deploy Worker，不能只传 R2。
# - binary 和 install 脚本走 R2 的 bin/；Worker 的 /dl/* 负责对外提供。
# - schema.sql 变更必须显式给 --migration <sql>，不会自动全量执行 schema.sql。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="$ROOT/wrangler.toml"
STATE_FILE="$ROOT/.deploy-state"
DIST="$ROOT/dist"
RUST_DIR="$ROOT/sdk/rust"
WORKER_SRC="$ROOT/worker/src/worker.ts"
WRANGLER=(npx -y wrangler@4)

MODE="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

DRY_RUN=0
YES=0
FRESH=0
SINCE=""
ALL=0
ALL_TARGETS=0
TARGETS="linux-x64 linux-arm64 linux-x64-gnu win-x64"
WIN_TOOLCHAIN="msvc"
SKIP_BUILD=0
SKIP_WORKER=0
SKIP_UPLOAD=0
SKIP_VERIFY=0
SKIP_ARTIFACTS=0
FORCE_WORKER=0
FORCE_BINARIES=0
FORCE_INSTALL=0
MIGRATION=""
REUSE_D1=0
REUSE_R2=0
DATABASE_ID=""
ENDPOINT="${SYNAPSE_ENDPOINT:-https://synapse.wangda.today}"
BUCKET=""
D1=""
NO_ADMIN=0
R2_RETRIES="${R2_RETRIES:-4}"

info() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '！%s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Synapse 部署脚本

用法：
  ./scripts/deploy.sh bootstrap --fresh --yes [选项]
  ./scripts/deploy.sh release [--yes] [选项]

模式：
  bootstrap   空账号初始化。会创建 D1/R2、建表、写 SESSION_SECRET、首次 deploy。
              必须显式 --fresh，避免在已有线上账号上误跑。
  release     线上增量更新。默认从上次 release 的 commit 到当前 HEAD 检测变化；
              不建资源、不重跑 schema、不轮换 secret。

release 选项：
  --since REF          指定对比基线，例如 HEAD~1、origin/main 或某个 commit
  --all                强制认为 Worker/Rust/安装脚本都变了
  --targets LIST       编译/上传目标，逗号或空格分隔
                       默认 linux-x64 linux-arm64 linux-x64-gnu win-x64
                       all = linux-x64 linux-arm64 linux-x64-gnu linux-arm64-gnu win-x64 macos-arm64 macos-x64
  --win-toolchain msvc|gnu   Windows 工具链，默认 msvc
  --skip-build         跳过编译，直接用 dist/ 现有产物
  --skip-worker        不 deploy Worker
  --skip-upload        不写 R2
  --r2-retries N       R2 上传失败重试次数，默认 4（也可用环境变量 R2_RETRIES）
  --skip-verify        不跑线上校验
  --migration FILE     schema.sql 变更时，显式指定迁移 SQL
  --force-worker       即使没检测到 Worker/HTML 变更也 deploy
  --force-binaries     即使没检测到 Rust 变更也重建/上传 binary
  --force-install      即使没检测到安装脚本变更也上传 install.sh/install.ps1
  --dry-run            只打印命令，不执行
  --yes                非交互确认

bootstrap 选项：
  --fresh              必填；确认这是空账号初始化
  --reuse-d1           复用已有 D1，不执行 d1 create
  --reuse-r2           复用已有 R2，不执行 r2 bucket create
  --database-id ID     跳过 d1 create 的 ID 解析，直接使用该 ID
  --skip-artifacts     初始化后不自动编译/上传 binary
  --no-admin           不创建 bootstrap admin token
  --skip-worker        不执行首次 wrangler deploy（一般不要用）

通用选项：
  --endpoint URL       默认 https://synapse.wangda.today
  --bucket NAME        R2 bucket，默认读 wrangler.toml
  --d1 NAME            D1 database，默认读 wrangler.toml
  -h, --help

示例：
  # 日常线上更新：自动检测变化，编译/上传三套 binary，必要时 deploy Worker
  ./scripts/deploy.sh release --yes

  # 只发 Windows 窗口桥
  ./scripts/deploy.sh release --targets win-x64 --yes

  # 只更新 Linux ARM64 + 安装脚本 + Worker manifest
  ./scripts/deploy.sh release --targets linux-arm64 --force-install --yes

  # 空账号初始化
  ./scripts/deploy.sh bootstrap --fresh --yes
USAGE
}

need_arg() {
  [ "$#" -ge 2 ] || die "$1 需要一个值"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --since) need_arg "$@"; SINCE="$2"; shift 2 ;;
    --since=*) SINCE="${1#*=}"; shift ;;
    --all) ALL=1; shift ;;
    --targets) need_arg "$@"; TARGETS="$2"; shift 2 ;;
    --targets=*) TARGETS="${1#*=}"; shift ;;
    --all-targets) ALL_TARGETS=1; shift ;;
    --win-toolchain) need_arg "$@"; WIN_TOOLCHAIN="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --win-toolchain=*) WIN_TOOLCHAIN="$(printf '%s' "${1#*=}" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-worker) SKIP_WORKER=1; shift ;;
    --skip-upload) SKIP_UPLOAD=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --r2-retries) need_arg "$@"; R2_RETRIES="$2"; shift 2 ;;
    --r2-retries=*) R2_RETRIES="${1#*=}"; shift ;;
    --skip-artifacts) SKIP_ARTIFACTS=1; shift ;;
    --force-worker) FORCE_WORKER=1; shift ;;
    --force-binaries) FORCE_BINARIES=1; shift ;;
    --force-install) FORCE_INSTALL=1; shift ;;
    --migration) need_arg "$@"; MIGRATION="$2"; shift 2 ;;
    --migration=*) MIGRATION="${1#*=}"; shift ;;
    --reuse-d1) REUSE_D1=1; shift ;;
    --reuse-r2) REUSE_R2=1; shift ;;
    --database-id) need_arg "$@"; DATABASE_ID="$2"; shift 2 ;;
    --database-id=*) DATABASE_ID="${1#*=}"; shift ;;
    --no-admin) NO_ADMIN=1; shift ;;
    --endpoint) need_arg "$@"; ENDPOINT="${2%/}"; shift 2 ;;
    --endpoint=*) ENDPOINT="${1#*=}"; ENDPOINT="${ENDPOINT%/}"; shift ;;
    --bucket) need_arg "$@"; BUCKET="$2"; shift 2 ;;
    --bucket=*) BUCKET="${1#*=}"; shift ;;
    --d1) need_arg "$@"; D1="$2"; shift 2 ;;
    --d1=*) D1="${1#*=}"; shift ;;
    *) die "未知选项：$1（用 --help 查看）" ;;
  esac
done

case "$MODE" in
  -h|--help) usage; exit 0 ;;
  bootstrap|release) ;;
  ""|*) usage >&2; die "需要模式：bootstrap 或 release" ;;
esac

case "$WIN_TOOLCHAIN" in
  msvc|gnu) ;;
  *) die "--win-toolchain 只能是 msvc 或 gnu" ;;
esac

case "$R2_RETRIES" in
  ''|*[!0-9]*) die "--r2-retries 必须是正整数" ;;
esac
[ "$R2_RETRIES" -ge 1 ] || die "--r2-retries 必须至少为 1"

# ── 目标名归一化 ─────────────────────────────────────────────
normalize_targets() {
  local raw out="" t
  raw="${1//,/ }"
  if [ "$raw" = "all" ] || [ "$ALL_TARGETS" = 1 ]; then
    raw="linux-x64 linux-arm64 linux-x64-gnu linux-arm64-gnu win-x64 macos-arm64 macos-x64"
  fi
  for t in $raw; do
    case "$t" in
      linux-x86_64|linux-amd64) t="linux-x64" ;;
      linux-aarch64|linux-arm) t="linux-arm64" ;;
      linux-x64-glibc) t="linux-x64-gnu" ;;
      linux-arm64-glibc) t="linux-arm64-gnu" ;;
      windows-x64|windows-x86_64|win64|windows-amd64) t="win-x64" ;;
      darwin-arm64|mac-arm64) t="macos-arm64" ;;
      darwin-x64|mac-x64|macos-x86_64) t="macos-x64" ;;
    esac
    case "$t" in
      linux-x64|linux-arm64|linux-x64-gnu|linux-arm64-gnu|win-x64|macos-arm64|macos-x64) ;;
      *) die "未知目标：${t}（可选 linux-x64 linux-arm64 linux-x64-gnu linux-arm64-gnu win-x64 macos-arm64 macos-x64）" ;;
    esac
    case " $out " in
      *" $t "*) ;;
      *) out="${out}${out:+ }$t" ;;
    esac
  done
  printf '%s' "$out"
}

TARGETS="$(normalize_targets "$TARGETS")"
[ -n "$TARGETS" ] || die "没有编译目标"

# ── 基础工具 ─────────────────────────────────────────────────
toml_value() {
  python3 - "$CONFIG" "$1" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
m = re.search(rf'(?m)^\s*{re.escape(key)}\s*=\s*"([^"]*)"', text)
print(m.group(1) if m else "")
PY
}

set_database_id() {
  python3 - "$CONFIG" "$1" <<'PY'
import re, sys
path, value = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
pattern = r'(?m)^(\s*database_id\s*=\s*)"[^"]*"'
new, n = re.subn(pattern, rf'\g<1>"{value}"', text, count=1)
if n == 0:
    raise SystemExit("wrangler.toml 里找不到 database_id")
open(path, "w", encoding="utf-8").write(new)
PY
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "找不到 sha256sum/shasum"
  fi
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else
    die "找不到 sha256sum/shasum"
  fi
}

run_cmd() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  +'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_wrangler() {
  run_cmd "${WRANGLER[@]}" "$@"
}

run_in_rust() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  + (cd %q &&' "$RUST_DIR"
    printf ' %q' "$@"
    printf ')\n'
    return 0
  fi
  ( cd "$RUST_DIR" && "$@" )
}

check_tools() {
  local c
  for c in git node npx curl python3; do
    command -v "$c" >/dev/null 2>&1 || die "缺少命令：$c"
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || die "缺少 sha256sum/shasum"
  if [ "$MODE" = "bootstrap" ]; then
    command -v openssl >/dev/null 2>&1 || die "bootstrap 需要 openssl"
  fi
}

confirm() {
  local expected="$1" answer=""
  if [ "$DRY_RUN" = 1 ] || [ "$YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then die "非交互环境，必须显式加 --yes"; fi
  printf '即将执行 %s，输入 %s 继续：' "$MODE" "$expected"
  read -r answer
  [ "$answer" = "$expected" ] || die "已取消"
}

init_config() {
  [ -f "$CONFIG" ] || die "找不到 $CONFIG"
  if [ -z "$BUCKET" ]; then BUCKET="$(toml_value bucket_name)"; fi
  if [ -z "$D1" ]; then D1="$(toml_value database_name)"; fi
  [ -n "$BUCKET" ] || die "无法从 wrangler.toml 读取 bucket_name，用 --bucket 指定"
  [ -n "$D1" ] || die "无法从 wrangler.toml 读取 database_name，用 --d1 指定"
}

read_versions() {
  BUILD_TAG="$(sed -n 's/^const BUILD_TAG = "\(.*\)";/\1/p' "$WORKER_SRC" | head -1)"
  SDK_VERSION="$(sed -n 's/^const SDK_VERSION = "\(.*\)";/\1/p' "$WORKER_SRC" | head -1)"
  CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$RUST_DIR/Cargo.toml" | head -1)"
  [ -n "$BUILD_TAG" ] || BUILD_TAG="unknown"
  [ -n "$SDK_VERSION" ] || SDK_VERSION="unknown"
}

check_versions() {
  read_versions
  if [ "$CARGO_VERSION" != "$SDK_VERSION" ]; then
    warn "版本不一致：Cargo=$CARGO_VERSION Worker SDK_VERSION=${SDK_VERSION}（发版前建议统一）"
  fi
  info "build=$BUILD_TAG sdk=$SDK_VERSION cargo=$CARGO_VERSION"
}

# ── 变更检测 ─────────────────────────────────────────────────
determine_base() {
  if [ -n "$SINCE" ]; then
    BASE="$SINCE"
  elif [ -f "$STATE_FILE" ]; then
    BASE="$(tr -d '[:space:]' < "$STATE_FILE")"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE="HEAD~1"
    info "没有 .deploy-state，首次按 HEAD~1 对比；如需覆盖更多提交，请用 --since 或 --all"
  else
    BASE="HEAD"
    info "没有 .deploy-state 且没有 HEAD~1，按当前 HEAD 对比未提交改动"
  fi
  git rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1 \
    || die "无效的对比基线：$BASE"
}

collect_changes() {
  WORKER_CHANGED=0
  RUST_CHANGED=0
  INSTALL_CHANGED=0
  SCHEMA_CHANGED=0
  SDK_CHANGED=0

  if [ "$ALL" = 1 ]; then
    WORKER_CHANGED=1
    RUST_CHANGED=1
    INSTALL_CHANGED=1
    CHANGED=""
    info "模式：--all，Worker / Rust / install 全部视为变更"
    return 0
  fi

  CHANGED="$(
    git diff --name-only "$BASE" -- . 2>/dev/null || true
    git diff --name-only HEAD -- . 2>/dev/null || true
    git ls-files --others --exclude-standard
  )"
  CHANGED="$(printf '%s\n' "$CHANGED" | sed '/^$/d' | sort -u)"

  if [ -z "$CHANGED" ]; then
    info "自 $BASE 以来没有代码变更"
    return 0
  fi

  info "变更文件（相对 ${BASE}）："
  printf '%s\n' "$CHANGED" | sed 's/^/  ~ /'

  local f
  for f in $CHANGED; do
    case "$f" in
      worker/src/*|admin/*|wrangler.toml) WORKER_CHANGED=1 ;;
      sdk/rust/*) RUST_CHANGED=1 ;;
      scripts/install.sh|scripts/install.ps1) INSTALL_CHANGED=1 ;;
      worker/schema.sql) SCHEMA_CHANGED=1 ;;
      sdk/python/*|sdk/ts/*) SDK_CHANGED=1 ;;
    esac
  done
}

# ── 编译 ─────────────────────────────────────────────────────
artifact_for() {
  case "$1" in
    linux-x64)   printf '%s' "synapse-agent-x86_64-linux-musl" ;;
    linux-arm64) printf '%s' "synapse-agent-aarch64-linux-musl" ;;
    linux-x64-gnu)   printf '%s' "synapse-agent-x86_64-linux-gnu" ;;
    linux-arm64-gnu) printf '%s' "synapse-agent-aarch64-linux-gnu" ;;
    win-x64)     printf '%s' "synapse-agent-x86_64-windows-${WIN_TOOLCHAIN}.exe" ;;
    macos-arm64) printf '%s' "synapse-agent-aarch64-apple-darwin" ;;
    macos-x64)   printf '%s' "synapse-agent-x86_64-apple-darwin" ;;
  esac
}

triple_for() {
  case "$1" in
    linux-x64)   printf '%s' "x86_64-unknown-linux-musl" ;;
    linux-arm64) printf '%s' "aarch64-unknown-linux-musl" ;;
    linux-x64-gnu)   printf '%s' "x86_64-unknown-linux-gnu" ;;
    linux-arm64-gnu) printf '%s' "aarch64-unknown-linux-gnu" ;;
    win-x64)
      case "$WIN_TOOLCHAIN" in
        msvc) printf '%s' "x86_64-pc-windows-msvc" ;;
        gnu)  printf '%s' "x86_64-pc-windows-gnu" ;;
      esac ;;
    macos-arm64) printf '%s' "aarch64-apple-darwin" ;;
    macos-x64)   printf '%s' "x86_64-apple-darwin" ;;
  esac
}

write_sha() {
  local file="$1" hash="$2" name
  name="$(basename "$file")"
  hash="$(sha256_file "$file")"
  printf '%s  %s\n' "$hash" "$name" > "$file.sha256"
  ok "sha256 $name=$hash"
}

build_native_linux() {
  local target="$1" triple name src ext=""
  triple="$(triple_for "$target")"
  name="$(artifact_for "$target")"
  [ "$target" = "win-x64" ] && ext=".exe"

  if [ "$target" = "linux-x64" ]; then
    run_in_rust rustup target add "$triple"
    run_in_rust env RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
      cargo build --release --target "$triple"
  elif [ "$target" = "linux-arm64" ] || [ "$target" = "linux-arm64-gnu" ]; then
    [ "$DRY_RUN" = 1 ] || command -v cross >/dev/null 2>&1 || die "Linux arm64 需要 cargo install cross"
    run_in_rust rustup target add "$triple"
    run_in_rust cross build --release --target "$triple"
  elif [ "$target" = "linux-x64-gnu" ]; then
    # gnu 版是动态 glibc，不能带 musl 分支的 crt-static RUSTFLAGS
    run_in_rust rustup target add "$triple"
    run_in_rust cargo build --release --target "$triple"
  elif [ "$target" = "win-x64" ] && [ "$WIN_TOOLCHAIN" = "msvc" ]; then
    [ "$DRY_RUN" = 1 ] || command -v cargo-xwin >/dev/null 2>&1 || die "Windows MSVC 需要 cargo install cargo-xwin"
    run_in_rust rustup target add "$triple"
    run_in_rust cargo xwin build --release --target "$triple"
  else
    die "当前主机不支持目标：$target"
  fi

  src="$RUST_DIR/target/$triple/release/synapse-agent$ext"
  if [ "$DRY_RUN" = 1 ]; then
    info "计划复制：$src -> $DIST/$name"
    return 0
  fi
  [ -f "$src" ] || die "构建结束但没有产物：$src"
  mkdir -p "$DIST"
  cp -f "$src" "$DIST/$name"
  chmod 755 "$DIST/$name"
  write_sha "$DIST/$name"
}

build_binaries() {
  if [ "$SKIP_BUILD" = 1 ]; then
    info "跳过编译（--skip-build）"
    return 0
  fi
  if [ "$RUST_CHANGED" = 0 ] && [ "$FORCE_BINARIES" = 0 ] && [ "$ALL" = 0 ]; then
    info "Rust 未变化，跳过编译"
    return 0
  fi

  info "编译目标：${TARGETS}（win=${WIN_TOOLCHAIN}）"
  local host target targs=()
  host="$(uname -s)"
  if [ "$host" = "Darwin" ]; then
    for target in $TARGETS; do targs+=("$target"); done
    run_cmd bash "$ROOT/scripts/build-cross.sh" "${targs[@]}" --win-toolchain "$WIN_TOOLCHAIN"
  elif [ "$host" = "Linux" ]; then
    for target in $TARGETS; do
      case "$target" in
        linux-x64|linux-arm64|linux-x64-gnu|linux-arm64-gnu|win-x64) build_native_linux "$target" ;;
        *) die "Linux 主机不能编译 ${target}；请用 macOS 主机或 --skip-build" ;;
      esac
    done
  else
    die "当前主机 $host 不支持自动交叉编译；请用 macOS，或 --skip-build 提供 dist 产物"
  fi
}

# ── R2 上传 ──────────────────────────────────────────────────
r2_put() {
  local key="$1" file="$2" type="${3:-}"
  local attempt=1 size
  [ -f "$file" ] || die "要上传的文件不存在：$file"
  size="$(du -h "$file" | awk '{print $1}')"

  if [ "$DRY_RUN" = 1 ]; then
    if [ -n "$type" ]; then
      run_wrangler r2 object put "$BUCKET/bin/$key" --remote --file="$file" --content-type="$type"
    else
      run_wrangler r2 object put "$BUCKET/bin/$key" --remote --file="$file"
    fi
    return 0
  fi

  while [ "$attempt" -le "$R2_RETRIES" ]; do
    if [ "$attempt" -gt 1 ]; then
      warn "重试 R2 上传（${attempt}/${R2_RETRIES}）：$key（${size}）"
      sleep $((attempt * 3))
    fi
    if [ -n "$type" ]; then
      if run_wrangler r2 object put "$BUCKET/bin/$key" --remote --file="$file" --content-type="$type"; then
        return 0
      fi
    else
      if run_wrangler r2 object put "$BUCKET/bin/$key" --remote --file="$file"; then
        return 0
      fi
    fi
    warn "R2 上传失败（${attempt}/${R2_RETRIES}）：$key（${size}）"
    attempt=$((attempt + 1))
  done

  die "R2 上传最终失败：$key（${size}）。
  先检查网络/代理；可执行：
    env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      npx -y wrangler@4 r2 object put \"$BUCKET/bin/$key\" --remote --file=\"$file\"
  或加 --skip-upload 跳过上传，稍后手动补传。"
}

upload_binaries() {
  if [ "$SKIP_UPLOAD" = 1 ]; then
    info "跳过 R2 上传（--skip-upload）"
    return 0
  fi
  if [ "$RUST_CHANGED" = 0 ] && [ "$FORCE_BINARIES" = 0 ] && [ "$ALL" = 0 ]; then
    info "Rust 未变化，跳过 binary 上传"
    return 0
  fi

  local target name file want got
  for target in $TARGETS; do
    name="$(artifact_for "$target")"
    file="$DIST/$name"
    if [ "$DRY_RUN" = 1 ]; then
      info "计划上传 binary：$name"
      continue
    fi
    [ -f "$file" ] || die "缺少产物：${file}（先编译，或用 --skip-build 提供）"
    [ -f "$file.sha256" ] || write_sha "$file" "$(sha256_file "$file")"
    want="$(awk '{print $1}' "$file.sha256" | head -1)"
    got="$(sha256_file "$file")"
    [ "$want" = "$got" ] || die "本地 sha 不一致：$file"
    r2_put "$name" "$file"
    r2_put "$name.sha256" "$file.sha256" "text/plain"
    ok "已上传 binary：$name"
  done

  if [ -f "$DIST/SHA256SUMS" ]; then
    r2_put "SHA256SUMS" "$DIST/SHA256SUMS" "text/plain"
  fi
}

upload_installers() {
  if [ "$SKIP_UPLOAD" = 1 ]; then return 0; fi
  if [ "$INSTALL_CHANGED" = 0 ] && [ "$FORCE_INSTALL" = 0 ] && [ "$ALL" = 0 ]; then
    info "安装脚本未变化，跳过上传"
    return 0
  fi
  r2_put "install.sh" "$ROOT/scripts/install.sh" "text/plain"
  r2_put "install.ps1" "$ROOT/scripts/install.ps1" "text/plain"
  if [ "$DRY_RUN" = 1 ]; then
    info "计划上传 install.sh / install.ps1"
  else
    ok "已上传 install.sh / install.ps1"
  fi
}

upload_build_info() {
  if [ "$SKIP_UPLOAD" = 1 ]; then return 0; fi
  local commit dirty now content
  commit="$(git rev-parse --short HEAD)"
  if [ -n "$(git status --porcelain)" ]; then dirty="+dirty"; else dirty=""; fi
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  content="$(cat <<EOF
build=$BUILD_TAG
commit=$commit$dirty
sdk_version=$SDK_VERSION
updated_at=$now
EOF
)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "$content"
    info "计划上传 BUILD.txt"
    return 0
  fi
  mkdir -p "$DIST"
  printf '%s\n' "$content" > "$DIST/BUILD.txt"
  r2_put "BUILD.txt" "$DIST/BUILD.txt" "text/plain"
  ok "已上传 BUILD.txt"
}

# ── 迁移 / Worker ────────────────────────────────────────────
apply_migration() {
  if [ -z "$MIGRATION" ]; then
    if [ "$SCHEMA_CHANGED" = 1 ]; then
      die "检测到 worker/schema.sql 变更；请用 --migration <sql> 指定明确迁移，不会自动重跑 schema.sql"
    fi
    return 0
  fi
  [ -f "$MIGRATION" ] || die "迁移文件不存在：$MIGRATION"
  info "执行 D1 迁移：$MIGRATION"
  run_wrangler d1 execute "$D1" --file="$MIGRATION" --remote
}

deploy_worker() {
  if [ "$SKIP_WORKER" = 1 ]; then
    info "跳过 Worker deploy（--skip-worker）"
    return 0
  fi
  if [ "$WORKER_CHANGED" = 0 ] && [ "$FORCE_WORKER" = 0 ] && [ "$ALL" = 0 ]; then
    info "Worker/HTML 未变化，跳过 deploy"
    return 0
  fi
  local dry
  dry="$(mktemp -d "${TMPDIR:-/tmp}/synapse-worker-dry.XXXXXX")"
  info "Worker dry-run：$dry"
  run_wrangler deploy --dry-run --outdir "$dry"
  info "Worker deploy"
  run_wrangler deploy
}

# ── 线上校验 ─────────────────────────────────────────────────
verify_release() {
  if [ "$SKIP_VERIFY" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    info "跳过线上校验"
    return 0
  fi
  info "校验 $ENDPOINT"
  local ver manifest remote_build remote_commit target name file remote_sha local_sha
  ver="$(curl -fsS --max-time 15 "$ENDPOINT/ver")"
  remote_build="$(printf '%s' "$ver" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build",""))' 2>/dev/null || true)"
  [ -n "$remote_build" ] || die "无法解析 /ver：$ver"
  [ "$remote_build" = "$BUILD_TAG" ] || warn "/ver build=${remote_build}，本地 BUILD_TAG=$BUILD_TAG"

  curl -fsSL --max-time 15 "$ENDPOINT/dl/BUILD.txt" >/tmp/synapse-remote-build.$$ || die "无法读取 /dl/BUILD.txt"
  remote_commit="$(sed -n 's/^commit=//p' /tmp/synapse-remote-build.$$ | head -1)"
  rm -f /tmp/synapse-remote-build.$$
  if [ -n "$remote_commit" ]; then
    info "远端 BUILD.txt commit=$remote_commit"
  else
    warn "远端 BUILD.txt 没有 commit 字段（旧版本）"
  fi

  manifest="$(curl -fsS --max-time 15 "$ENDPOINT/sdk/manifest")"
  printf '%s\n' "$manifest" | python3 -m json.tool >/dev/null || die "无法解析 /sdk/manifest"

  for target in $TARGETS; do
    name="$(artifact_for "$target")"
    file="$DIST/$name"
    [ -f "$file" ] || continue
    local_sha="$(sha256_file "$file")"
    remote_sha="$(curl -fsSL --max-time 15 "$ENDPOINT/dl/$name.sha256" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    if [ -z "$remote_sha" ]; then
      warn "远端缺少 $name.sha256"
    elif [ "$remote_sha" != "$local_sha" ]; then
      die "远端 sha 不一致：$name 本地=$local_sha 远端=$remote_sha"
    else
      ok "远端校验通过：$name"
    fi
  done

  curl -fsSL --max-time 15 "$ENDPOINT/dl/install.sh" | head -1 >/dev/null || warn "install.sh 不可读"
  ok "线上校验完成"
}

write_state() {
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  git rev-parse HEAD > "$STATE_FILE"
}

# ── release ─────────────────────────────────────────────────
release_flow() {
  check_tools
  init_config
  check_versions
  determine_base
  collect_changes

  if [ "$SKIP_UPLOAD" = 0 ] && [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}${ALL_PROXY:-}${all_proxy:-}" ]; then
    warn "检测到代理环境变量；R2 上传出现 fetch failed 时，可先尝试去掉代理重跑"
  fi

  if [ "$WORKER_CHANGED" = 0 ] && [ "$RUST_CHANGED" = 0 ] \
     && [ "$INSTALL_CHANGED" = 0 ] && [ "$SCHEMA_CHANGED" = 0 ] \
     && [ "$ALL" = 0 ] && [ "$FORCE_WORKER" = 0 ] \
     && [ "$FORCE_BINARIES" = 0 ] && [ "$FORCE_INSTALL" = 0 ]; then
    ok "没有需要发布的变更"
    return 0
  fi

  if [ "$DRY_RUN" != 1 ]; then
    run_wrangler whoami >/dev/null
  fi
  confirm release

  apply_migration
  build_binaries
  upload_binaries
  upload_installers
  upload_build_info
  deploy_worker
  verify_release
  write_state
  ok "release 完成"
}

# ── bootstrap ───────────────────────────────────────────────
bootstrap_flow() {
  [ "$FRESH" = 1 ] || die "bootstrap 只用于空账号；确认空账号后加 --fresh"
  check_tools
  init_config
  check_versions
  confirm bootstrap

  local out d1_id secret token sha now sql
  info "bootstrap endpoint=$ENDPOINT d1=$D1 bucket=$BUCKET"

  if [ -n "$DATABASE_ID" ]; then
    info "使用指定 database_id=$DATABASE_ID"
    if [ "$DRY_RUN" != 1 ]; then set_database_id "$DATABASE_ID"; fi
  elif [ "$REUSE_D1" = 1 ]; then
    d1_id="$(toml_value database_id)"
    [ -n "$d1_id" ] || die "wrangler.toml 没有 database_id，不能用 --reuse-d1"
    info "复用 D1 database_id=$d1_id"
  else
    if [ "$DRY_RUN" = 1 ]; then
      info "计划执行：wrangler d1 create $D1"
    else
      out="$("${WRANGLER[@]}" d1 create "$D1" 2>&1)" || { printf '%s\n' "$out"; die "d1 create 失败"; }
      printf '%s\n' "$out"
      d1_id="$(printf '%s\n' "$out" | grep -Eo '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)"
      [ -n "$d1_id" ] || die "无法从 d1 create 输出解析 database_id；请用 --database-id 指定"
      set_database_id "$d1_id"
      ok "wrangler.toml database_id=$d1_id"
    fi
  fi

  if [ "$REUSE_R2" = 1 ]; then
    info "复用 R2 bucket=$BUCKET"
  else
    run_wrangler r2 bucket create "$BUCKET"
  fi

  secret="${SESSION_SECRET:-}"
  if [ -z "$secret" ]; then
    secret="$(openssl rand -hex 32)"
    info "已生成新的 SESSION_SECRET（不打印）"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "计划设置 SESSION_SECRET"
  else
    printf '%s' "$secret" | "${WRANGLER[@]}" secret put SESSION_SECRET
    ok "SESSION_SECRET 已设置"
  fi

  info "初始化 D1 schema"
  run_wrangler d1 execute "$D1" --file="$ROOT/worker/schema.sql" --remote

  if [ "$SKIP_WORKER" = 1 ]; then
    info "跳过首次 Worker deploy（--skip-worker）"
  else
    info "首次 Worker deploy"
    run_wrangler deploy
  fi

  if [ "$NO_ADMIN" = 0 ]; then
    token="$(openssl rand -hex 16)"
    sha="$(sha256_text "$token")"
    now="$(( $(date +%s) * 1000 ))"
    sql="INSERT INTO agents (project,agent_id,role,scopes,token_sha,created_at) VALUES ('bootstrap','bootstrap-admin','admin','admin,poll,ack,report,heartbeat,publish,artifact.write,submissions.create,artifact.read','$sha',$now);"
    info "创建 bootstrap admin token"
    run_wrangler d1 execute "$D1" --remote --command "$sql"
    if [ "$DRY_RUN" = 1 ]; then
      info "dry-run：不生成真实 admin token"
    else
      printf '\nadmin token（只显示一次）：%s\n' "$token"
      printf '登录 %s/console 使用该 token。\n\n' "$ENDPOINT"
    fi
  fi

  if [ "$SKIP_ARTIFACTS" = 1 ]; then
    info "跳过 binary 编译/上传（--skip-artifacts）"
  else
    info "开始编译/上传首批 binary"
    local args=(--all --yes --skip-worker --targets "$TARGETS" --win-toolchain "$WIN_TOOLCHAIN" --endpoint "$ENDPOINT" --bucket "$BUCKET" --d1 "$D1" --r2-retries "$R2_RETRIES")
    [ "$DRY_RUN" = 1 ] && args+=(--dry-run)
    [ "$SKIP_VERIFY" = 1 ] && args+=(--skip-verify)
    bash "$0" release "${args[@]}"
  fi

  ok "bootstrap 完成"
}

case "$MODE" in
  release) release_flow ;;
  bootstrap) bootstrap_flow ;;
esac
