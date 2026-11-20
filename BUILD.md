# 构建、发布与自检

本文件说明如何从源码构建 Worker、三端 SDK 和 Linux 发布物。最终用户只看
`README.md` 的安装命令；不要要求客户端 pip / cargo。

## 0. 依赖

| 组件 | 版本 / 命令 |
|---|---|
| Node.js | 18+，`npx wrangler@4` |
| Rust | 1.75+，`rustup`、`cargo` |
| Python | 3.9+，`pip` |
| 平台 | Linux x64 可构建静态 musl；其它平台需要对应 SDK / 交叉工具链 |

## 1. Worker

```bash
# 依赖按需安装（仓库不提交 node_modules）
npm install --no-save wrangler@4

# 本地类型/打包检查
npx wrangler deploy --dry-run --outdir /tmp/synapse-worker-dry

# 远端部署
npx wrangler deploy
```

`wrangler.toml` 中的 `main = worker/src/worker.ts`，`admin/index.html` 通过 import 内联进 Worker。
修改 `admin/index.html` 后必须重新 `wrangler deploy`，没有独立的前端构建步骤。

必需 secret：

```bash
npx wrangler secret put SESSION_SECRET
```

`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` 在 `wrangler.toml` 的 vars 中；按你的 Access 应用替换。

## 2. Python SDK

```bash
cd sdk/python
python3 -m pip install -e .
python3 -m py_compile synapse/*.py yanshi/*.py
python3 -m synapse --help
```

打包 wheel（如需要）：

```bash
python3 -m pip install build
python3 -m build
```

## 3. TypeScript SDK

```bash
cd sdk/ts
npm ci
npm run build       # tsc -> dist/*.js + *.d.ts
```

`package.json` 的包名是 `@synapse/agent`，版本 `0.5.1`；`package-lock.json` 必须与它一致。
`dist/` 是构建产物，发布源码包时保留，方便不装 TypeScript 的客户端直接使用。

## 4. Rust / Linux 发布物

```bash
cd sdk/rust
cargo build --release

# 静态 musl（当前线上 Linux x64 通道）
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
  cargo build --release --target x86_64-unknown-linux-musl
```

产物路径：

```text
sdk/rust/target/x86_64-unknown-linux-musl/release/synapse-agent
```

发布前确认：

```bash
sha256sum target/x86_64-unknown-linux-musl/release/synapse-agent
target/x86_64-unknown-linux-musl/release/synapse-agent --version
```

### 其它平台

| 目标 | 构建 |
|---|---|
| macOS Intel | `rustup target add x86_64-apple-darwin`，在 macOS 上 `cargo build --release --target x86_64-apple-darwin` |
| macOS Apple Silicon | `rustup target add aarch64-apple-darwin`，在 macOS 上构建 |
| Linux arm64 | `rustup target add aarch64-unknown-linux-musl`，准备 aarch64 交叉工具链后构建 |
| Windows x64 | 安装 MSVC Build Tools + Rust target `x86_64-pc-windows-msvc`，在 Windows 上构建 |

Rust 的 CPU / load / disk / mem 采集当前主要使用 `/proc` 和 GNU `df`；macOS / Windows 编译可过，
但指标会降级为空。若要把它们作为正式发布平台，需要在 `sdk/rust/src/main.rs` 补平台采集实现，
并在 `sdk/rust/BINARIES.md` 标注状态。

## 5. 发布到 R2 / 安装入口

```bash
# Linux 二进制 + sha 边车
sha256sum dist/synapse-agent-x86_64-linux-musl > dist/synapse-agent-x86_64-linux-musl.sha256
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl \
  --remote --file=dist/synapse-agent-x86_64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-x86_64-linux-musl.sha256

# 唯一安装脚本
npx wrangler r2 object put agent-artifacts/bin/install.sh \
  --remote --file=scripts/install.sh --content-type=text/plain
```

发布后：

```bash
curl -fsS https://synapse.wangda.today/ver
curl -fsS https://synapse.wangda.today/sdk/manifest
curl -fsSL https://synapse.wangda.today/dl/install.sh | head -5
```

`/dl` 只应该出现：`install.sh`、`synapse-agent-x86_64-linux-musl`、对应 `.sha256`、图标、`BUILD.txt`。
不要再上传 `yanshi-agent-*` 或旧 `/install*` wrapper。

## 6. 版本号位置

一次发版需要同步：

| 位置 | 字段 |
|---|---|
| `worker/src/worker.ts` | `BUILD_TAG`、`SDK_VERSION` |
| `sdk/python/pyproject.toml` | `version` |
| `sdk/ts/package.json` / `package-lock.json` | `version`、包名 |
| `sdk/rust/Cargo.toml` / `Cargo.lock` | `version` |
| `sdk/rust/src/main.rs` | `--help` / `--version` 输出、UA 字符串 |
| `README.md` / `docs/SDK-接入与差异.md` | 发布快照 |

## 7. 自检清单

```bash
sh -n scripts/install.sh
python3 -m py_compile sdk/python/synapse/*.py sdk/python/yanshi/*.py
cd sdk/ts && npm run build
cd sdk/rust && cargo build --release
cd ../.. && npx wrangler deploy --dry-run --outdir /tmp/synapse-worker-dry
```

- [ ] `/ver` 的 build 与文档一致
- [ ] `/sdk/manifest` 的 sha 与 R2 对象一致
- [ ] `/dl/install.sh` 的 sha 与 `scripts/install.sh` 一致
- [ ] 旧 `/install*`、`yanshi-agent-*` 均 404 / 不存在
- [ ] 真实迁移：源 token 401、目标 token 200
- [ ] 加入项目：源、目标 token 都 200
