# 构建、发布与自检

本文件说明如何从源码构建 Worker、三端 SDK 和 Linux 发布物。最终用户只看
`README.md` 的安装命令；不要要求客户端 pip / cargo。

## 0. 依赖

| 组件 | 版本 / 命令 |
|---|---|
| Node.js | 18+，`npx wrangler@4` |
| Rust | 1.75+，`rustup`、`cargo` |
| Python | 3.9+，`pip` |
| 平台 | Linux x64 / arm64 可构建静态 musl；其它平台需要对应 SDK / 交叉工具链 |

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

## 4. Rust / 多平台发布物

```bash
cd sdk/rust
cargo build --release

# 静态 musl（Linux x64 发布通道）
rustup target add x86_64-unknown-linux-musl
RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
  cargo build --release --target x86_64-unknown-linux-musl
```

macOS 主机可以用交叉编译脚本一次生成 Linux x64、Linux ARM64（musl + glibc）、Windows x64 和 macOS：

```bash
./scripts/build-cross.sh linux-x64 linux-arm64 linux-x64-gnu linux-arm64-gnu win-x64 macos-arm64 macos-x64 \
  --win-toolchain msvc
```

产物路径：

```text
dist/synapse-agent-x86_64-linux-musl
dist/synapse-agent-aarch64-linux-musl
dist/synapse-agent-x86_64-linux-gnu
dist/synapse-agent-aarch64-linux-gnu
dist/synapse-agent-x86_64-windows-msvc.exe
dist/synapse-agent-aarch64-apple-darwin
dist/synapse-agent-x86_64-apple-darwin
```

发布前确认：

```bash
file dist/synapse-agent-x86_64-linux-musl
sha256sum dist/synapse-agent-x86_64-linux-musl
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
# Linux x64 + ARM64 二进制和 sha 边车（build-cross 已生成 sha256）
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl \
  --remote --file=dist/synapse-agent-x86_64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-x86_64-linux-musl.sha256 --content-type=text/plain

npx wrangler r2 object put agent-artifacts/bin/synapse-agent-aarch64-linux-musl \
  --remote --file=dist/synapse-agent-aarch64-linux-musl
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-aarch64-linux-musl.sha256 \
  --remote --file=dist/synapse-agent-aarch64-linux-musl.sha256 --content-type=text/plain

# Windows x64 exe + sha 边车
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-windows-msvc.exe \
  --remote --file=dist/synapse-agent-x86_64-windows-msvc.exe
npx wrangler r2 object put agent-artifacts/bin/synapse-agent-x86_64-windows-msvc.exe.sha256 \
  --remote --file=dist/synapse-agent-x86_64-windows-msvc.exe.sha256 --content-type=text/plain

# 安装脚本
npx wrangler r2 object put agent-artifacts/bin/install.sh \
  --remote --file=scripts/install.sh --content-type=text/plain
npx wrangler r2 object put agent-artifacts/bin/install.ps1 \
  --remote --file=scripts/install.ps1 --content-type=text/plain

# 发布标记
printf 'build=%s\nupdated_at=%s\n' "<BUILD_TAG>" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > dist/BUILD.txt
npx wrangler r2 object put agent-artifacts/bin/BUILD.txt \
  --remote --file=dist/BUILD.txt --content-type=text/plain
```

发布后：

```bash
curl -fsS https://synapse.wangda.today/ver
curl -fsS https://synapse.wangda.today/sdk/manifest
curl -fsSL https://synapse.wangda.today/dl/install.sh | head -5
curl -fsSL https://synapse.wangda.today/dl/BUILD.txt
```

`/dl` 应该出现：`install.sh`、`install.ps1`、Linux x64/ARM64 二进制及 `.sha256`、Windows exe 及 `.sha256`、图标、`BUILD.txt`。
不要再上传 `yanshi-agent-*` 或旧 `/install*` wrapper。

## 6. 版本号位置

`BUILD_TAG` 是部署批次标记，`SDK_VERSION` 是客户端发版号，两者独立升级。
SDK 版本不要手改单点，统一用脚本：

```bash
./scripts/bump-sdk.sh 0.5.2 --dry-run   # 先看会改哪些文件
./scripts/bump-sdk.sh 0.5.2             # 同步所有 SDK 版本字段
```

脚本会同步：

| 位置 | 字段 |
|---|---|
| `VERSION` | `sdk_version`、`snapshot_date` |
| `worker/src/worker.ts` | `SDK_VERSION`（`BUILD_TAG` 不动） |
| `sdk/rust/Cargo.toml` / `Cargo.lock` | `version` |
| `sdk/python/pyproject.toml` / `synapse/client.py` | `version` / `__version__` |
| `sdk/ts/package.json` / `package-lock.json` / `src/client.ts` | `version` / `VERSION` |
| `spec/openapi.yaml` | `info.version` |
| `README.md` / `DESIGN.md` / `PACKAGE-MANIFEST.txt` / `docs/SDK-接入与差异.md` | 发布快照 |

Rust 的 `--help`、`--version`、User-Agent 已改为读 `CARGO_PKG_VERSION`，不再单独维护。

客户端自升级是**手动**命令，不会在 `run` 里自动检查：

```bash
synapse-agent upgrade                    # 只检查，打印当前平台/目标包/sha
synapse-agent upgrade --apply 1          # Linux/macOS 原地替换
synapse-agent upgrade --platform linux-x86_64-gnu   # 指定 manifest platform
```

`upgrade` 按 manifest 的 `platform` 选包，不再默认取第一个 Linux 包；SHA-256 在客户端内计算。
Windows 运行中的 exe 被系统锁定，`--apply 1` 会保留 `.new` 并提示用 `install.ps1` 覆盖，不能原地替换。

## 7. 自检清单

```bash
bash -n scripts/deploy.sh
bash -n scripts/build-cross.sh
sh -n scripts/install.sh
python3 -m py_compile sdk/python/synapse/*.py sdk/python/yanshi/*.py
cd sdk/ts && npm run build
cd sdk/rust && cargo build --release
cd ../.. && npx wrangler deploy --dry-run --outdir /tmp/synapse-worker-dry
```

- [ ] `/ver` 的 build 与文档一致
- [ ] `/ver.skill_sha256` 与 `/skill` 响应头 `x-skill-sha256` 一致
- [ ] `/capabilities` 返回合法 JSON，能力 ID 覆盖本次新增 API
- [ ] `/sdk/manifest` 的 sha 与 R2 对象一致
- [ ] `/sdk/manifest` 同时列出 Linux x86_64 和 linux-aarch64（两者都已上传时）
- [ ] `/dl/install.sh` 内容与 `scripts/install.sh` 一致
- [ ] 旧 `/install*`、`yanshi-agent-*` 均 404 / 不存在
- [ ] 真实迁移：源 token 401、目标 token 200
- [ ] 加入项目：源、目标 token 都 200

## 8. 自动化发布脚本

`scripts/deploy.sh` 把两种流程分开，避免在线上重复建资源：

### 从 0 部署

```bash
./scripts/deploy.sh bootstrap --fresh --yes
```

它会：

- 创建 D1 / R2（或 `--reuse-d1` / `--reuse-r2`）
- 写入 `database_id` 到 `wrangler.toml`
- 设置 `SESSION_SECRET`
- 执行 `worker/schema.sql`
- 首次 `wrangler deploy`
- 生成 bootstrap admin token
- 默认继续编译并上传 Linux x64 / ARM64（musl + glibc）/ Windows x64 五套 binary

### 线上增量更新

```bash
./scripts/deploy.sh release --yes
```

默认行为：

- 从 `.deploy-state` 记录的上次发布 commit 到当前 HEAD 检测变化
- 默认编译并上传 `linux-x64`、`linux-arm64`、`linux-x64-gnu`、`linux-arm64-gnu`、`win-x64`
- 只有 `worker/src/*`、`admin/*` 或 `wrangler.toml` 变化时才 `wrangler deploy`
- 只有 `scripts/install.sh` / `scripts/install.ps1` 变化时才重传安装脚本
- 更新 `BUILD.txt`，写入 build / commit / sdk_version
- 跑 `/ver`、`/sdk/manifest`、`/dl` 校验

常用参数：

```bash
# 只发某个平台
./scripts/deploy.sh release --targets win-x64 --yes
./scripts/deploy.sh release --targets linux-arm64 --yes

# 自定义对比基线
./scripts/deploy.sh release --since HEAD~1 --yes

# 只预览
./scripts/deploy.sh release --dry-run --yes

# schema.sql 有变更时，必须显式给迁移
./scripts/deploy.sh release --migration migrations/2026xxxx.sql --yes
```

`release` 不会执行 `d1 create`、`r2 bucket create`、`schema.sql` 全量初始化，也不会轮换
`SESSION_SECRET`。这些只属于 `bootstrap`。
