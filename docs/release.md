# 打包发布指南

当前方案（零成本）：**GitHub Actions 矩阵构建 → Draft Release 手动发布 → 用户从 GitHub Releases 下载**。

- 主开发仓在 **Gitee**；发布需要一个 **GitHub 镜像仓**（可 private），承担 CI 构建与 Release 分发。
- 无签名：mac 安装包为 ad-hoc 签名，用户首次打开需一次引导操作；Win 有 SmartScreen 提示（见下文「用户安装指引」）。
- 未集成应用内自动更新；升级 = 重新下载安装包覆盖安装。

## 产物

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS Apple Silicon | `Xulux Assistant_<ver>_aarch64.dmg` | 10.13+，2020 年后机型均可 |
| Windows x64 | `Xulux Assistant_<ver>_x64-setup.exe` | NSIS，按用户级安装，自动装 WebView2 |
| 通用 | `SHA256SUMS.txt` | 校验和 |

sidecar（pi-agent）由 `bun build --compile` 在对应平台 runner 上原生编译，经 Tauri `externalBin` 一并打入安装包，无需用户装任何运行时。安装包约 100–150MB 属正常（bun 自包含二进制较大）。

## 一次性准备（维护者）

1. 创建 GitHub 镜像仓（如 `https://github.com/<user>/pi-desktop`，private 亦可）：
   ```bash
   git remote add release https://github.com/<user>/pi-desktop.git
   git push release --all
   ```
2. 确认 GitHub 仓库 Actions 权限：Settings → Actions → General → Workflow permissions = Read and write（创建 Draft Release 需要）。
3. 注意额度：private 仓 macOS runner 按 10 倍计费（免费额度 2000 分钟/月 ≈ 200 个 mac 构建分钟，配 Rust 缓存后单次约 10–15 分钟）；public 仓不限。额度紧张可把镜像仓设为 public。

## 发版流程

```bash
# 0. 确保工作区干净、待发布代码已提交并推送
# 1. bump 三处版本号 + commit + tag + 推送双远端（--dry-run 可先预演）
bun run release 0.1.1 --dry-run
bun run release 0.1.1
# 2. 等 GitHub Actions 跑完（test → build ×2 → release）
# 3. 到 GitHub 仓库 Releases 页，检查 Draft，点 Publish 正式发布
```

发布脚本会同步 `tauri.conf.json` / `apps/desktop/package.json` / `src-tauri/Cargo.toml` 三处版本号（tauri.conf.json 为打包权威来源），只提交这三个文件，不会夹带其他改动。

升级本地 bun 版本时，同步修改 `.github/workflows/release.yml` 中的 `bun-version`。

## 用户安装指引（可直接贴到 Release 说明里）

### macOS（Apple Silicon）

1. 下载 `Xulux Assistant_<ver>_aarch64.dmg`，打开后把 App 拖入「应用程序」。
2. 首次打开：**右键点击 App → 打开 → 打开**（只第一次需要）。
3. 若提示「已损坏，无法打开」，在终端执行一次后正常打开：
   ```bash
   xattr -cr "/Applications/Xulux Assistant.app"
   ```
   （应用未做苹果付费签名公证，macOS Gatekeeper 会拦截未公证应用；上述命令仅移除隔离标记，不影响使用。）

### Windows 10/11（64 位）

1. 下载 `Xulux Assistant_<ver>_x64-setup.exe` 双击安装（按当前用户安装，无需管理员）。
2. 若 SmartScreen 弹「已保护你的电脑」：点 **更多信息 → 仍要运行**（仅首次）。
3. 安装器会自动下载安装 WebView2 运行时（Win11 通常已内置）。

## 常见问题

- **CI 挂在 sidecar 构建**：检查 runner 上 rustc 是否可用（工作流已装 Rust 工具链）；本地可复现验证 `bun run build:sidecar`。
- **想改覆盖的芯片/架构**：macOS Intel 需在 matrix 增加 `macos-13` runner；两者合一的 universal 包需把两个架构的 sidecar 用 `lipo` 合成 `pi-agent-universal-apple-darwin`（后续需要再加）。
- **后续要加签名/公证或应用内更新**：macOS 走 `APPLE_*` 环境变量 + Developer ID（$99/年）；更新走 Tauri `plugin-updater` + `tauri signer`，密钥和端点届时再设计。
