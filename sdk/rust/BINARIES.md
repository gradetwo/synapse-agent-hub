# 预编译二进制与多平台构建

当前 R2 发布 Linux x86_64 / Linux ARM64 静态 musl，以及 Windows x86_64 exe；
macOS 由维护者自行编译。客户端不会自动 pip / cargo。

另有动态 glibc（gnu）版 Linux 产物。为什么需要它：musl 静态二进制自带 DNS
解析器，在直发 UDP DNS 被限制的沙箱/受管 VM 里解析不了域名（实测 EAI_AGAIN）；
glibc 版走系统解析路径，在这类环境里可正常连接。`linux-x64-gnu` 已进
`deploy.sh release` 的默认目标集，`linux-arm64-gnu` 在 `all` 目标集里。

| 平台 | 目标三元组 | 状态 | 产物 |
|---|---|---|---|
| Linux x86_64（静态 musl） | `x86_64-unknown-linux-musl` | 已发布 | `synapse-agent-x86_64-linux-musl` |
| Linux aarch64（静态 musl） | `aarch64-unknown-linux-musl` | 已发布 | `synapse-agent-aarch64-linux-musl` |
| Linux x86_64（动态 glibc） | `x86_64-unknown-linux-gnu` | 新增，待首次发布 | `synapse-agent-x86_64-linux-gnu` |
| Linux aarch64（动态 glibc） | `aarch64-unknown-linux-gnu` | 新增，待首次发布 | `synapse-agent-aarch64-linux-gnu` |
| macOS x86_64 | `x86_64-apple-darwin` | 可编译，未发布 | `synapse-agent-x86_64-apple-darwin` |
| macOS arm64 | `aarch64-apple-darwin` | 可编译，未发布 | `synapse-agent-aarch64-apple-darwin` |
| Windows x86_64 | `x86_64-pc-windows-msvc` | 发布到 R2 | `synapse-agent-x86_64-windows-msvc.exe` |

当前校验值以 `/dl/<name>.sha256` 和 `/sdk/manifest` 为准，不再在文档里写死。
`sdk/manifest` 会从 R2 对象读取 sha256；Linux x64 / ARM64 对象存在时自动列出。

Windows 窗口桥（`win-list` / `win-send` / `win-read` / `bus-serve` / `bus-send` / `bridge`）
只在 Windows 上运行；交叉编译通过不代表已验收。

## 构建

```bash
cd sdk/rust

# 任意平台的本机构建
cargo build --release

# Linux 静态 musl（发布用）
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
  cargo build --release --target x86_64-unknown-linux-musl

# macOS 主机一次交叉编译 Linux x64 / ARM64、Linux x64 glibc 版、Windows x64
cd ../..
./scripts/build-cross.sh linux-x64 linux-arm64 linux-x64-gnu win-x64 --win-toolchain msvc
```

macOS / Windows 的交叉构建需要对应 SDK / MSVC，本仓库不附带工具链；只发布你实际验证过的目标。
Rust 资源采集目前主要面向 Linux；macOS / Windows 可编译运行，但 CPU / load / disk / mem 可能为空，
心跳会带 `degraded=true`。平台采集补丁见 `BUILD.md`。

## 发布到 R2

优先使用自动发布脚本：

```bash
./scripts/deploy.sh release --yes
```

默认会编译并上传 Linux x64、Linux ARM64、Linux x64 glibc 版、Windows x64 四套 binary 及 `.sha256`，
只有 Worker / HTML 变化时才 deploy Worker。

手工发布时：

```bash
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl \
  --remote --file=dist/synapse-agent-x86_64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-x86_64-linux-musl.sha256 --content-type=text/plain

npx wrangler r2 object put agent-artifacts/bin/synapse-agent-aarch64-linux-musl \
  --remote --file=dist/synapse-agent-aarch64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-aarch64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-aarch64-linux-musl.sha256 --content-type=text/plain

npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-windows-msvc.exe \
  --remote --file=dist/synapse-agent-x86_64-windows-msvc.exe
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-windows-msvc.exe.sha256 \
  --remote --file=dist/synapse-agent-x86_64-windows-msvc.exe.sha256 --content-type=text/plain

npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-gnu \
  --remote --file=dist/synapse-agent-x86_64-linux-gnu
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-gnu.sha256 \
  --remote --file=dist/synapse-agent-x86_64-linux-gnu.sha256 --content-type=text/plain
```

发布后校验：

```bash
curl -fsS https://synapse.wangda.today/sdk/manifest
curl -fsSL https://synapse.wangda.today/dl/synapse-agent-x86_64-linux-musl.sha256
curl -fsSL https://synapse.wangda.today/dl/synapse-agent-aarch64-linux-musl.sha256
curl -fsSL https://synapse.wangda.today/dl/synapse-agent-x86_64-windows-msvc.exe.sha256
curl -fsSL https://synapse.wangda.today/dl/synapse-agent-x86_64-linux-gnu.sha256
```

`install.sh` 支持 Linux x64 / ARM64；`install.ps1` 支持 Windows msvc / gnu。
gnu 版 Linux 产物用 `install.sh --libc gnu`（或环境变量 `SYNAPSE_LINUX_LIBC=gnu`）安装；`/sdk/manifest` 在 R2 里存在 gnu 对象时会自动列出。
