# 预编译二进制与多平台构建

当前 R2 **只发布 Linux x86_64 静态 musl**；其它平台由维护者自行编译，客户端不会自动 pip / cargo。

| 平台 | 目标三元组 | 状态 | 产物 |
|---|---|---|---|
| Linux x86_64（静态 musl） | `x86_64-unknown-linux-musl` | 已发布 | `synapse-agent-x86_64-linux-musl` |
| Linux aarch64 | `aarch64-unknown-linux-musl` | 可编译，未发布 | 需交叉工具链 |
| macOS x86_64 | `x86_64-apple-darwin` | 可编译，未发布 | 需 macOS SDK |
| macOS arm64 | `aarch64-apple-darwin` | 可编译，未发布 | 需 macOS SDK |
| Windows x86_64 | `x86_64-pc-windows-msvc` | 已构建（含窗口桥），未上 R2 | `dist/synapse-agent-x86_64-windows-msvc.exe` |

当前 Linux 发布物校验（以 `/dl/...sha256` 和 `/sdk/manifest` 为准）：

```text
name: synapse-agent-x86_64-linux-musl
sha256: ac9fa1fe3ac4fa3a596054b0db35d3b95ac81702fc3fb743c6b54a70d9f55998
bytes: 4915456
```

本地已构建的 Windows 窗口桥版本（未上 R2，随源码快照分发）：

```text
name: synapse-agent-x86_64-windows-msvc.exe
sha256: 702d763bb843a51ebbfdcebb3171e875abe028cc14da3c7c5b21635920b223d2
bytes: 3741696
extra: win-list / win-send / win-read / bus-serve / bus-send / bridge
```

## 构建

```bash
cd sdk/rust

# 任意平台的本机构建
cargo build --release

# Linux 静态 musl（发布用）
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
  cargo build --release --target x86_64-unknown-linux-musl
```

macOS / Windows 的交叉构建需要对应 SDK / MSVC，本仓库不附带工具链；只发布你实际验证过的目标。
Rust 资源采集目前主要面向 Linux；macOS / Windows 可编译运行，但 CPU / load / disk / mem 可能为空，
心跳会带 `degraded=true`。平台采集补丁见 `BUILD.md`。

## 发布到 R2

```bash
# 先上传 sha256 边车；Worker 也会对缺失元数据的对象自愈计算
sha256sum dist/synapse-agent-x86_64-linux-musl > dist/synapse-agent-x86_64-linux-musl.sha256

npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl \
  --remote --file=dist/synapse-agent-x86_64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-x86_64-linux-musl.sha256
```

发布后校验：

```bash
curl -fsS https://synapse.wangda.today/sdk/manifest
curl -fsSL https://synapse.wangda.today/dl/synapse-agent-x86_64-linux-musl.sha256
```

新增平台时，需同时更新 `/sdk/manifest` 的 `binaries` 列表和安装脚本的平台判断；当前安装脚本故意只接受 Linux x64。
