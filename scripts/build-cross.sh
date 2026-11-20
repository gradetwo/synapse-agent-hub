#!/usr/bin/env bash
# Synapse Rust SDK 交叉编译脚本（macOS 主机）
#
# 支持目标：
#   linux-x64     -> x86_64-unknown-linux-musl
#   linux-arm64   -> aarch64-unknown-linux-musl
#   linux-x64-gnu   -> x86_64-unknown-linux-gnu（动态 glibc；musl 静态版的
#                      自带 DNS 解析在受限沙箱环境可能不可用，这类环境用 gnu 版）
#   linux-arm64-gnu -> aarch64-unknown-linux-gnu（同上）
#   win-x64       -> x86_64-pc-windows-msvc 或 x86_64-pc-windows-gnu
#   macos-arm64   -> aarch64-apple-darwin
#   macos-x64     -> x86_64-apple-darwin
#
# 用法：
#   ./scripts/build-cross.sh linux-x64 linux-arm64 win-x64
#   ./scripts/build-cross.sh --target linux-x64 --target win-x64
#   ./scripts/build-cross.sh --config scripts/build-targets.conf
#   ./scripts/build-cross.sh --config scripts/build-targets.conf --win-toolchain gnu
#   ./scripts/build-cross.sh --list
#
# 配置优先级：命令行 > 配置文件 > 内置默认值。
# 默认会自动补齐 rustup target、Homebrew 包和 cargo 子命令；--no-install 只检查不改环境。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/sdk/rust/Cargo.toml" ]; then
  ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../sdk/rust/Cargo.toml" ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "✗ 找不到 sdk/rust/Cargo.toml，请把脚本放在仓库根目录或 scripts/ 下" >&2
  exit 1
fi
RUST_DIR="$ROOT/sdk/rust"
TARGET_DIR="$RUST_DIR/target"

# ----------------------------- 参数默认值 -----------------------------
CONFIG=""
CONFIG_EXPLICIT=0
NO_CONFIG=0
TARGETS_CLI=""
TARGETS_CFG=""
WIN_TOOLCHAIN=""
LINUX_TOOLCHAIN=""
OUT_DIR=""
JOBS=""
STRIP="0"
STRIP_CLI=0
INSTALL_DEPS="1"
INSTALL_DEPS_CLI=0
DRY_RUN=0

info() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '！%s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

usage() {
  cat <<'USAGE'
Synapse Rust SDK 交叉编译脚本（macOS）

用法：
  ./scripts/build-cross.sh [目标...] [选项]

目标：
  linux-x64        Linux x86_64，静态 musl
  linux-arm64      Linux ARM64，静态 musl
  linux-x64-gnu    Linux x86_64，动态 glibc（受限网络环境用）
  linux-arm64-gnu  Linux ARM64，动态 glibc（受限网络环境用）
  win-x64          Windows x86_64，默认 MSVC，可用 --win-toolchain gnu
  macos-arm64      macOS Apple Silicon
  macos-x64        macOS Intel

选项：
  --config PATH          读取配置文件，默认 scripts/build-targets.conf（存在才读）
  --no-config            不读默认配置文件
  --target NAME          追加一个目标，可重复
  --targets A,B,C        一次追加多个目标
  --win-toolchain msvc|gnu
  --linux-toolchain zigbuild|cross
  --out DIR              产物目录，默认 dist（相对仓库根）
  --jobs N               cargo 并行 job 数
  --strip                构建后尝试 llvm-strip
  --install              缺少工具时自动安装（默认）
  --no-install           只检查，不安装任何依赖
  --dry-run              只打印计划，不安装、不编译
  --list                 列出所有目标
  -h, --help             显示帮助

示例：
  ./scripts/build-cross.sh linux-x64 linux-arm64 win-x64
  ./scripts/build-cross.sh --config scripts/build-targets.conf
  ./scripts/build-cross.sh win-x64 --win-toolchain gnu
  ./scripts/build-cross.sh --no-install --dry-run linux-arm64 win-x64
USAGE
}

list_targets() {
  cat <<'LIST'
支持的目标：
  linux-x64       -> x86_64-unknown-linux-musl
  linux-arm64     -> aarch64-unknown-linux-musl
  linux-x64-gnu   -> x86_64-unknown-linux-gnu
  linux-arm64-gnu -> aarch64-unknown-linux-gnu
  win-x64         -> x86_64-pc-windows-msvc 或 x86_64-pc-windows-gnu
  macos-arm64     -> aarch64-apple-darwin
  macos-x64       -> x86_64-apple-darwin

别名：
  linux-x86_64 / linux-amd64 -> linux-x64
  linux-aarch64              -> linux-arm64
  linux-x64-glibc            -> linux-x64-gnu
  linux-arm64-glibc          -> linux-arm64-gnu
  windows-x64 / win64        -> win-x64
  darwin-arm64               -> macos-arm64
  darwin-x64                 -> macos-x64
LIST
}

normalize_target() {
  local t
  t="$(lower "$1")"
  case "$t" in
    linux-x64|linux-x86_64|linux-amd64) printf '%s' 'linux-x64' ;;
    linux-arm64|linux-aarch64|linux-arm) printf '%s' 'linux-arm64' ;;
    linux-x64-gnu|linux-x86_64-gnu|linux-amd64-gnu|linux-x64-glibc) printf '%s' 'linux-x64-gnu' ;;
    linux-arm64-gnu|linux-aarch64-gnu|linux-arm64-glibc) printf '%s' 'linux-arm64-gnu' ;;
    win-x64|windows-x64|windows-x86_64|win64|windows-amd64) printf '%s' 'win-x64' ;;
    macos-arm64|darwin-arm64|mac-arm64) printf '%s' 'macos-arm64' ;;
    macos-x64|darwin-x64|mac-x64|macos-x86_64) printf '%s' 'macos-x64' ;;
    *) return 1 ;;
  esac
}

append_cli_target() {
  local norm
  norm="$(normalize_target "$1")" || die "未知目标：$1（用 --list 查看）"
  case " $TARGETS_CLI " in
    *" $norm "*) ;;
    *) TARGETS_CLI="${TARGETS_CLI}${TARGETS_CLI:+ }$norm" ;;
  esac
}

append_cfg_target() {
  local norm
  norm="$(normalize_target "$1")" || die "配置文件里有未知目标：$1"
  case " $TARGETS_CFG " in
    *" $norm "*) ;;
    *) TARGETS_CFG="${TARGETS_CFG}${TARGETS_CFG:+ }$norm" ;;
  esac
}

append_targets_value() {
  local kind="$1" value="$2" t
  value="${value//,/ }"
  for t in $value; do
    t="$(trim "$t")"
    [ -n "$t" ] || continue
    if [ "$kind" = "cli" ]; then append_cli_target "$t"; else append_cfg_target "$t"; fi
  done
}

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 需要一个值"
}

# ----------------------------- 解析命令行 -----------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage; exit 0 ;;
    --list)
      list_targets; exit 0 ;;
    --config)
      need_value "$@"; CONFIG="$2"; CONFIG_EXPLICIT=1; shift 2 ;;
    --config=*)
      CONFIG="${1#*=}"; CONFIG_EXPLICIT=1; shift ;;
    --no-config)
      NO_CONFIG=1; shift ;;
    --target)
      need_value "$@"; append_cli_target "$2"; shift 2 ;;
    --target=*)
      append_cli_target "${1#*=}"; shift ;;
    --targets)
      need_value "$@"; append_targets_value cli "$2"; shift 2 ;;
    --targets=*)
      append_targets_value cli "${1#*=}"; shift ;;
    --win-toolchain)
      need_value "$@"; WIN_TOOLCHAIN="$(lower "$2")"; shift 2 ;;
    --win-toolchain=*)
      WIN_TOOLCHAIN="$(lower "${1#*=}")"; shift ;;
    --linux-toolchain)
      need_value "$@"; LINUX_TOOLCHAIN="$(lower "$2")"; shift 2 ;;
    --linux-toolchain=*)
      LINUX_TOOLCHAIN="$(lower "${1#*=}")"; shift ;;
    --out)
      need_value "$@"; OUT_DIR="$2"; shift 2 ;;
    --out=*)
      OUT_DIR="${1#*=}"; shift ;;
    --jobs)
      need_value "$@"; JOBS="$2"; shift 2 ;;
    --jobs=*)
      JOBS="${1#*=}"; shift ;;
    --strip)
      STRIP=1; STRIP_CLI=1; shift ;;
    --no-strip)
      STRIP=0; STRIP_CLI=1; shift ;;
    --install)
      INSTALL_DEPS=1; INSTALL_DEPS_CLI=1; shift ;;
    --no-install)
      INSTALL_DEPS=0; INSTALL_DEPS_CLI=1; shift ;;
    --dry-run)
      DRY_RUN=1; INSTALL_DEPS=0; INSTALL_DEPS_CLI=1; shift ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do append_cli_target "$1"; shift; done ;;
    -*)
      die "未知选项：$1（用 --help 查看）" ;;
    *)
      append_cli_target "$1"; shift ;;
  esac
done

# ----------------------------- 读取配置文件 -----------------------------
load_config() {
  local raw line key value
  [ -f "$CONFIG" ] || {
    [ "$CONFIG_EXPLICIT" = 1 ] && die "配置文件不存在：$CONFIG"
    return 0
  }
  info "读取配置：$CONFIG"

  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    line="$(trim "$line")"
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) warn "跳过无法识别的配置行：$line"; continue ;;
    esac

    key="$(trim "${line%%=*}")"
    key="$(lower "$key")"
    value="$(trim "${line#*=}")"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac

    case "$key" in
      target|targets)
        append_targets_value cfg "$value" ;;
      win_toolchain)
        [ -n "$WIN_TOOLCHAIN" ] || WIN_TOOLCHAIN="$(lower "$value")" ;;
      linux_toolchain)
        [ -n "$LINUX_TOOLCHAIN" ] || LINUX_TOOLCHAIN="$(lower "$value")" ;;
      out_dir)
        [ -n "$OUT_DIR" ] || OUT_DIR="$value" ;;
      jobs)
        [ -n "$JOBS" ] || JOBS="$value" ;;
      strip)
        [ "$STRIP_CLI" = 1 ] || STRIP="$value" ;;
      install_deps)
        [ "$INSTALL_DEPS_CLI" = 1 ] || INSTALL_DEPS="$value" ;;
      *)
        warn "未知配置项：$key" ;;
    esac
  done < "$CONFIG"
}

if [ "$NO_CONFIG" = 0 ]; then
  if [ -z "$CONFIG" ]; then CONFIG="$SCRIPT_DIR/build-targets.conf"; fi
  load_config
fi

# ----------------------------- 合并与校验 -----------------------------
if [ -n "$TARGETS_CLI" ]; then
  TARGETS="$TARGETS_CLI"
else
  TARGETS="$TARGETS_CFG"
fi

if [ -z "$TARGETS" ]; then
  usage >&2
  die "没有指定目标（命令行或配置文件的 targets）"
fi

[ -n "$WIN_TOOLCHAIN" ] || WIN_TOOLCHAIN="msvc"
[ -n "$LINUX_TOOLCHAIN" ] || LINUX_TOOLCHAIN="zigbuild"
[ -n "$OUT_DIR" ] || OUT_DIR="dist"

case "$WIN_TOOLCHAIN" in
  msvc|gnu) ;;
  *) die "win_toolchain 只能是 msvc 或 gnu，当前：$WIN_TOOLCHAIN" ;;
esac
case "$LINUX_TOOLCHAIN" in
  zigbuild|cross) ;;
  *) die "linux_toolchain 只能是 zigbuild 或 cross，当前：$LINUX_TOOLCHAIN" ;;
esac
case "$INSTALL_DEPS" in
  1|true|TRUE|yes|YES|on|ON) INSTALL_DEPS=1 ;;
  0|false|FALSE|no|NO|off|OFF|'') INSTALL_DEPS=0 ;;
  *) die "install_deps 只能是 true/false，当前：$INSTALL_DEPS" ;;
esac
case "$STRIP" in
  1|true|TRUE|yes|YES|on|ON) STRIP=1 ;;
  0|false|FALSE|no|NO|off|OFF|'') STRIP=0 ;;
  *) die "strip 只能是 true/false，当前：$STRIP" ;;
esac
if [ -n "$JOBS" ]; then
  case "$JOBS" in
    *[!0-9]*) die "jobs 必须是正整数，当前：$JOBS" ;;
  esac
fi

case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$ROOT/$OUT_DIR" ;;
esac

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export CARGO_TARGET_DIR="$TARGET_DIR"
if [ -n "$JOBS" ]; then export CARGO_BUILD_JOBS="$JOBS"; fi

# ----------------------------- 环境检查与准备 -----------------------------
check_host() {
  if [ "$(uname -s)" != "Darwin" ] && [ "${SYNAPSE_ALLOW_NON_MACOS:-0}" != "1" ]; then
    die "这个脚本面向 macOS 交叉编译；当前 host=$(uname -s)。Linux 主机请用仓库原有构建命令。"
  fi
}

check_rust() {
  command -v rustup >/dev/null 2>&1 || die "未找到 rustup。先执行：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  command -v cargo  >/dev/null 2>&1 || die "未找到 cargo。请重新安装 rustup：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  command -v rustc  >/dev/null 2>&1 || die "未找到 rustc。请重新安装 rustup：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
}

check_xcode() {
  if [ "${SYNAPSE_ALLOW_NON_MACOS:-0}" = "1" ]; then return 0; fi
  command -v xcode-select >/dev/null 2>&1 || die "未找到 xcode-select；请先安装 Xcode Command Line Tools"
  xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools 未安装。先执行：xcode-select --install"
}

ensure_brew() {
  command -v brew >/dev/null 2>&1 || die "未找到 Homebrew。先安装：https://brew.sh"
}

# 用法：ensure_formula <formula> <检测命令>
ensure_formula() {
  local formula="$1" cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then return 0; fi
  if [ "$INSTALL_DEPS" = 0 ]; then
    die "缺少 ${formula}（命令 ${cmd}）。手动安装：brew install $formula"
  fi
  ensure_brew
  info "安装 Homebrew 包：$formula"
  brew install "$formula" || die "brew install $formula 失败"
  export PATH="$(brew --prefix)/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  command -v "$cmd" >/dev/null 2>&1 || die "$formula 安装后仍找不到 $cmd"
}

ensure_zig() {
  ensure_formula zig zig
}

ensure_mingw() {
  ensure_formula mingw-w64 x86_64-w64-mingw32-gcc
}

ensure_llvm() {
  local prefix
  prefix="$(brew --prefix llvm 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -d "$prefix/bin" ]; then
    export PATH="$prefix/bin:$PATH"
  fi
  if command -v clang-cl >/dev/null 2>&1 && command -v lld-link >/dev/null 2>&1; then
    return 0
  fi
  if [ "$INSTALL_DEPS" = 0 ]; then
    die "缺少 llvm（clang-cl/lld-link）。手动安装：brew install llvm"
  fi
  ensure_brew
  info "安装 Homebrew 包：llvm"
  brew install llvm || die "brew install llvm 失败"
  prefix="$(brew --prefix llvm)"
  export PATH="$prefix/bin:$PATH"
  command -v clang-cl >/dev/null 2>&1 || die "找不到 clang-cl"
  command -v lld-link  >/dev/null 2>&1 || die "找不到 lld-link"
}

# 用法：ensure_cargo_tool <命令> <crate>
ensure_cargo_tool() {
  local tool="$1" crate="$2"
  if command -v "$tool" >/dev/null 2>&1; then return 0; fi
  if [ "$INSTALL_DEPS" = 0 ]; then
    die "缺少 ${tool}。手动安装：cargo install $crate"
  fi
  info "安装 cargo 工具：$crate"
  cargo install "$crate" || die "cargo install $crate 失败"
  command -v "$tool" >/dev/null 2>&1 || die "$crate 安装后仍找不到 $tool"
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "cross 需要 Docker Desktop。先安装：brew install --cask docker"
  docker info >/dev/null 2>&1 || die "Docker 命令存在但 daemon 未运行，请启动 Docker Desktop"
}

ensure_rust_target() {
  local triple="$1" installed
  installed="$(rustup target list --installed 2>/dev/null || true)"
  case " $installed " in
    *" $triple "*) return 0 ;;
  esac
  if [ "$INSTALL_DEPS" = 0 ]; then
    die "缺少 Rust target：${triple}。手动安装：rustup target add $triple"
  fi
  info "安装 Rust target：$triple"
  rustup target add "$triple" || die "rustup target add $triple 失败"
}

prepare_for_target() {
  local t="$1"
  case "$t" in
    linux-x64|linux-arm64|linux-x64-gnu|linux-arm64-gnu)
      if [ "$LINUX_TOOLCHAIN" = "zigbuild" ]; then
        ensure_zig
        ensure_cargo_tool cargo-zigbuild cargo-zigbuild
      else
        ensure_docker
        ensure_cargo_tool cross cross
      fi
      ;;
    win-x64)
      if [ "$WIN_TOOLCHAIN" = "msvc" ]; then
        ensure_llvm
        ensure_cargo_tool cargo-xwin cargo-xwin
      else
        ensure_mingw
      fi
      ;;
    macos-arm64|macos-x64)
      ;;
    *)
      die "内部错误：未处理目标 $t" ;;
  esac
}

print_plan() {
  info "host=$(uname -s) $(uname -m)"
  info "targets=$TARGETS"
  info "linux_toolchain=$LINUX_TOOLCHAIN"
  info "win_toolchain=$WIN_TOOLCHAIN"
  info "out_dir=$OUT_DIR"
  if [ -n "$JOBS" ]; then info "jobs=$JOBS"; fi
  info "install_deps=$INSTALL_DEPS strip=$STRIP dry_run=$DRY_RUN"
}

check_host
print_plan

if [ "$DRY_RUN" = 1 ]; then
  info "dry-run：跳过依赖检查和安装"
else
  check_rust
  check_xcode
  for t in $TARGETS; do
    prepare_for_target "$t"
    case "$t" in
      linux-x64)      ensure_rust_target x86_64-unknown-linux-musl ;;
      linux-arm64)    ensure_rust_target aarch64-unknown-linux-musl ;;
      linux-x64-gnu)  ensure_rust_target x86_64-unknown-linux-gnu ;;
      linux-arm64-gnu) ensure_rust_target aarch64-unknown-linux-gnu ;;
      win-x64)
        case "$WIN_TOOLCHAIN" in
          msvc) ensure_rust_target x86_64-pc-windows-msvc ;;
          gnu)  ensure_rust_target x86_64-pc-windows-gnu ;;
        esac ;;
      macos-arm64)    ensure_rust_target aarch64-apple-darwin ;;
      macos-x64)      ensure_rust_target x86_64-apple-darwin ;;
    esac
  done
fi

# ----------------------------- 构建 -----------------------------
run_cmd() {
  info "执行：$*"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@"
}

build_linux() {
  local triple="$1"
  if [ "$LINUX_TOOLCHAIN" = "zigbuild" ]; then
    run_cmd cargo zigbuild --release --target "$triple"
  else
    run_cmd cross build --release --target "$triple"
  fi
}

build_windows_gnu() {
  local triple="$1"
  local linker="x86_64-w64-mingw32-gcc"
  local ar="x86_64-w64-mingw32-ar"
  info "执行：cargo build --release --target ${triple}（MinGW）"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$linker" \
  CC_x86_64_pc_windows_gnu="$linker" \
  AR_x86_64_pc_windows_gnu="$ar" \
    cargo build --release --target "$triple"
}

build_windows_msvc() {
  run_cmd cargo xwin build --release --target x86_64-pc-windows-msvc
}

build_macos() {
  run_cmd cargo build --release --target "$1"
}

artifact_name() {
  case "$1" in
    linux-x64)    printf '%s' "synapse-agent-x86_64-linux-musl" ;;
    linux-arm64)  printf '%s' "synapse-agent-aarch64-linux-musl" ;;
    linux-x64-gnu)   printf '%s' "synapse-agent-x86_64-linux-gnu" ;;
    linux-arm64-gnu) printf '%s' "synapse-agent-aarch64-linux-gnu" ;;
    win-x64)      printf '%s' "synapse-agent-x86_64-windows-${WIN_TOOLCHAIN}.exe" ;;
    macos-arm64)  printf '%s' "synapse-agent-aarch64-apple-darwin" ;;
    macos-x64)    printf '%s' "synapse-agent-x86_64-apple-darwin" ;;
  esac
}

target_triple() {
  case "$1" in
    linux-x64)    printf '%s' "x86_64-unknown-linux-musl" ;;
    linux-arm64)  printf '%s' "aarch64-unknown-linux-musl" ;;
    linux-x64-gnu)   printf '%s' "x86_64-unknown-linux-gnu" ;;
    linux-arm64-gnu) printf '%s' "aarch64-unknown-linux-gnu" ;;
    win-x64)
      case "$WIN_TOOLCHAIN" in
        msvc) printf '%s' "x86_64-pc-windows-msvc" ;;
        gnu)  printf '%s' "x86_64-pc-windows-gnu" ;;
      esac ;;
    macos-arm64)  printf '%s' "aarch64-apple-darwin" ;;
    macos-x64)    printf '%s' "x86_64-apple-darwin" ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "找不到 sha256sum/shasum，无法计算校验值"
  fi
}

[ "$DRY_RUN" = 1 ] || mkdir -p "$OUT_DIR"
SUMS=""

cd "$RUST_DIR"

for t in $TARGETS; do
  triple="$(target_triple "$t")"
  name="$(artifact_name "$t")"
  ext=""
  [ "$t" = "win-x64" ] && ext=".exe"

  info "构建 $t ($triple)"
  case "$t" in
    linux-x64|linux-arm64|linux-x64-gnu|linux-arm64-gnu) build_linux "$triple" ;;
    win-x64)
      if [ "$WIN_TOOLCHAIN" = "msvc" ]; then build_windows_msvc; else build_windows_gnu "$triple"; fi ;;
    macos-arm64|macos-x64) build_macos "$triple" ;;
  esac

  src="$TARGET_DIR/$triple/release/synapse-agent$ext"
  dst="$OUT_DIR/$name"

  if [ "$DRY_RUN" = 1 ]; then
    info "计划复制：$src -> $dst"
    continue
  fi

  [ -f "$src" ] || die "构建结束但没有产物：$src"
  if [ "$STRIP" = 1 ]; then
    if command -v llvm-strip >/dev/null 2>&1; then
      llvm-strip "$src" || warn "llvm-strip 失败，保留未 strip 产物"
    else
      warn "找不到 llvm-strip，跳过 strip（可 brew install llvm）"
    fi
  fi

  cp -f "$src" "$dst"
  chmod 755 "$dst"
  hash="$(sha256_file "$dst")"
  printf '%s  %s\n' "$hash" "$name" > "$dst.sha256"
  SUMS="${SUMS}${hash}  ${name}"$'\n'

  ok "$dst"
  command -v file >/dev/null 2>&1 && file "$dst"
  info "sha256=$hash"
done

if [ "$DRY_RUN" = 0 ]; then
  printf '%s' "$SUMS" > "$OUT_DIR/SHA256SUMS"
  ok "校验清单：$OUT_DIR/SHA256SUMS"
fi

printf '\n'
ok "构建流程结束。targets=$TARGETS"

if [ "$DRY_RUN" = 0 ]; then
  case " $TARGETS " in
    *" linux-arm64 "*)
      warn "Linux ARM64 二进制已生成；/dl/install.sh 已支持 linux-arm64，/sdk/manifest 会按 R2 中是否存在该对象自动列出。"
      ;;
  esac
  case " $TARGETS " in
    *" win-x64 "*)
      warn "Windows 产物不走 /dl/install.sh；用 scripts/install.ps1 从 /dl 自动下载对应 exe（msvc/gnu）安装，并自行注册常驻服务。"
      ;;
  esac
fi
#（注：内容由AI生成）
