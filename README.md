# Kova · 扣瓦

Kova（中文名「扣瓦」）是一个**桌面端 AI 助手**：Tauri v2 打包的 macOS / Windows 原生应用，内嵌 Next.js + [assistant-ui](https://assistant-ui.com) 构建的会话界面，由独立的本地 agent 运行时（`pi-agent` sidecar）驱动模型对话、工具执行与会话持久化。

## 功能概览

- **对话工作区**：多线程管理、附件与 @提及、斜杠命令、模型选择器、语音输入、提示词排队（prompt queue）、检查点回溯、AI 会话标题总结
- **Agent 引擎**（sidecar）：内置编码/浏览器/HTTP/截图等工具、上下文压缩（compaction）、长期记忆、子代理（Task/TaskWait/TaskList/TaskStop，三层发现）
- **MCP 接入**：多服务器连接池、配置双层合并、输出防护、OAuth、审批与审计
- **技能与插件**：skills 装载与管理；插件面板系统（本仓库自带 `office`、`canvas`、`ui-design` 插件与本地插件市场）
- **系统集成**：Keychain/凭据管理、Webhook 通知、定时任务（automations）、远程访问、外观主题

## 仓库结构

```
apps/
  desktop/            # 桌面前端：Next.js + assistant-ui（components/agent-thread 会话流、
                      # settings、marketplace 等），src-tauri/ 为 Rust 宿主（窗口、凭据、
                      # sidecar 拉起、host RPC 存储）
  sidecar/pi-agent/   # agent 运行时（Bun/TS）：stdin/stdout NDJSON 协议，
                      # sessions/MCP/skills/subagent/tools/model/secrets 按域分目录
packages/
  pi-protocol/        # 前后端共享的跨端契约定义
plugins/
  office/             # 办公套件：幻灯片（逐页编辑/放映/导出 .pptx）+ 表格（Univer）
  canvas/             # 无限画布：Excalidraw 式白板（*.canvas.json，导出 SVG）
  marketplace.json    # 本仓库插件市场清单
scripts/              # release.mjs 发布脚本、rename.sh/rename.bat 一键改名、build-release.sh/.bat 一键打包
docs/                 # 设计与迭代文档（MCP、插件系统、密钥、性能基线、发布流程等）
```

## 环境要求

- [Bun](https://bun.sh) ≥ 1.x（依赖安装与工作区脚本）
- Rust 工具链（Tauri v2，见 [官方指南](https://tauri.app/start/prerequisites/)）
- Node.js（`next dev` 经 node_modules 调用）

## 开发

```bash
bun install                 # 安装依赖（workspace: apps/*, apps/sidecar/*, packages/*, plugins/*）
bun run tauri:dev           # Tauri 桌面开发（Next 热更新 + Rust 增量编译 + sidecar）
bun run dev                 # 仅浏览器内开发 Next 前端
bun run test                # sidecar 单元测试（bun test）
bun run build:sidecar       # 单独构建 agent sidecar
```

Sidecar 冒烟：`cd apps/sidecar/pi-agent && bun run smoke`（无 Rust 宿主时自动回退本地 SQLite 存储）。

## 构建与发布

```bash
./scripts/build-release.sh  # 一键打包: 依赖安装 → sidecar → 前端 → 安装包(Windows 用 scripts\build-release.bat)
                            # 可选: --skip-install / --debug / --allow-dev / --check(仅环境预检)
bun run build               # 仅前端产物构建
bun run tauri:build         # 仅桌面安装包(beforeBuildCommand 会自动先跑 build:sidecar + build)
bun run release             # 发布流程（node scripts/release.mjs，见 docs/release.md）
```

安装包产物在 `apps/desktop/src-tauri/target/release/bundle/`（macOS `.dmg`/`.app`，Windows `.msi`/setup `.exe`）。打包 ≠ 发版：`release.mjs` 只做版本号同步、打 tag 与推送远端。

## 插件系统

插件位于 `plugins/`，以 `.kova-plugin/plugin.json` 为清单（`skills/`、`panels.json` 可选），通过 `plugins/marketplace.json` 聚合为本地市场，应用内「插件市场」安装。UI 面板为单文件 HTML 构建产物（`bun run build` 于插件目录内执行 vite 构建）。设计文档见 `docs/plugin-system-design.md`。

## 数据与配置

- 全局数据层：`~/.kova/`（会话、记忆、MCP、子代理定义等）；工作区层：`<cwd>/.kova/`
- sidecar 二进制由 Rust 宿主以子进程拉起，业务表经 stdout host RPC 读写；`PI_*` 环境变量用于本地直跑（如 `PI_TASK_CWD`、`PI_SESSIONS_DIR`）
- macOS API Key 存于系统钥匙串（服务名 `com.kova.assistant`）
- **dev / 正式版数据隔离**：`bun run tauri:dev` 叠加 `apps/desktop/src-tauri/tauri.dev.conf.json`（identifier `com.kova.assistant.dev`，显示名「扣瓦 Dev」），应用数据目录随之变为 `~/Library/Application Support/com.kova.assistant.dev`——安装、卸载正式版不会碰到 dev 数据，反之亦然。dev 构建的主密钥放数据目录内 `master.dev.key`（规避重编译后钥匙串 ACL 拒读误轮换），正式版走系统钥匙串；两者密文互不可读，跨环境首次使用需重输凭据。注意：绕过 CLI 的裸 `cargo run` 不注入 dev 配置，会落回正式版 identifier。`~/.kova/` 全局层有意共用（机器级配置层，不受安装器管辖）。

## 主要依赖

本项目站在这些优秀的开源肩膀上（完整清单见各包 `package.json` 与 `Cargo.toml`）：

| 层 | 库 |
| --- | --- |
| 运行时与打包 | [Bun](https://bun.sh) · [Tauri v2](https://tauri.app) · [Next.js](https://nextjs.org) · [React](https://react.dev) |
| 对话界面 | [assistant-ui](https://assistant-ui.com) · [Vercel AI SDK](https://ai-sdk.dev) · [Streamdown](https://streamdown.ai)（流式 Markdown，含 CJK/数学/Mermaid 插件）· [Radix UI](https://radix-ui.com) / [shadcn/ui](https://ui.shadcn.com) · [lucide-react](https://lucide.dev) · [framer-motion](https://motion.dev) · [cmdk](https://cmdk.paco.me) |
| Agent 运行时 | [pi-agent-core / pi-ai](https://www.npmjs.com/package/@earendil-works/pi-agent-core)（Earendil Works）· [Model Context Protocol SDK](https://github.com/modelcontextprotocol) · [croner](https://github.com/Hexagon/croner) |
| 编辑器与终端 | [CodeMirror 6](https://codemirror.net) · [xterm.js](https://xtermjs.org) |
| 办公插件 | [Univer](https://univer.ai)（表格引擎）· [LeaferJS](https://www.leaferjs.com)（画布引擎）· [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) · [exceljs](https://exceljs.dev) · [jszip](https://stuk.github.io/jszip/) |
| 数据与状态 | [zustand](https://zustand.docs.pmnd.rs) · [zod](https://zod.dev) · [Recharts](https://recharts.org) · [rusqlite](https://github.com/rusqlite/rusqlite)（bundled SQLite）· [keyring](https://github.com/hwchen/keyring-rs) · [axum](https://github.com/tokio-rs/axum) |
| 3D 与视觉效果 | [Three.js](https://threejs.org) / [@react-three/fiber](https://r3f.docs.pmnd.rs) |
| 中文字体 | [霞鹜文楷](https://github.com/lxgw/LxgwWenKai) · [Noto Sans/Serif SC](https://fonts.google.com/noto) · [Geist](https://vercel.com/geist) · [Inter](https://rsms.me/inter/) · [JetBrains Mono](https://www.jetbrains.com/mono/) |

## 致谢

Kova·扣瓦 从架构到细节大量借鉴与依赖社区成果，特别感谢：

- **[assistant-ui](https://assistant-ui.com)** 与 **Tauri** 社区——分别撑起了对话式 UI 与跨平台桌面运行时，两者的 issue 区与文档是本仓库许多疑难的第一答案来源；
- **Earendil Works 的 pi 项目**——`pi-agent` sidecar 的会话转录、上下文压缩、子代理等核心设计移植/参考自其 agent-runtime（代码注释中大量 `PI-Desktop 同设计` 标注即出处所在）；
- **[Model Context Protocol](https://modelcontextprotocol.io)** 规范及其 TypeScript SDK——让工具生态的接入有章可循；
- **[Univer](https://univer.ai)**（DreamNum）与 **[LeaferJS](https://www.leaferjs.com)** 团队——表格与画布引擎的质量直接决定了办公插件的上限；
- **[霞鹜文楷](https://github.com/lxgw/LxgwWenKai)** 作者 lxgw 及所有字体、图标、组件的创作者；
- 每一个认真写 issue、提 PR、在讨论区回答问题的开源参与者。软件因分享而完整。

若你基于本模板继续开发，也欢迎把这份谢意传递下去。

## 路线图

> 活文档：随迭代更新，欢迎以 issue 讨论优先级。

### ✅ 已落地

桌面主应用（多轮对话 / 附件 / 检查点 / 提示词排队）、pi-agent sidecar 运行时（MCP、skills、子代理、记忆、上下文压缩）、插件系统与办公套件（office、canvas）、Keychain 凭据管理、定时任务与 Webhook 通知、**局域网远程访问**（桌面网关 + 配对码 + 浏览器网页端，见 [docs/remote-access.md](docs/remote-access.md)）。

### 🚧 下一步：移动 App

当前手机经浏览器访问桌面网关已可用，下一步是把它做成正经的移动应用：

- iOS / Android 原生壳（候选：Tauri v2 mobile），复用现有网页端对话 UI 与 WS 协议
- 推送通知：任务完成、等待审批、定时任务结果到达手机
- 扫码配对流程的原生化（Keychain / Keystore 保存 token、生物识别解锁）
- 移动端适配：触控手势、离线草稿、会话列表的窄屏重排

### 🚧 下一步：远程能力增强

从"同一 Wi-Fi 能用"走向"出门在外也敢用"：

- 端到端加密：配对后协商密钥，WS 流量桌面端加密、云端（隧道/中继）零明文
- 稳定公网接入：摆脱临时隧道地址，支持固定域名与自动重连
- 断线与恢复：WS 断线期间的消息补拉、重连后的会话状态对齐
- 多设备并发：桌面 + 多个远端同时在线的输入仲裁与视图同步
- 远程审批：危险操作确认推送到已配对设备，手机上放行

### 📋 Backlog

- 发布矩阵：macOS / Windows 双平台签名与自动更新（[docs/release.md](docs/release.md)）
- 性能迭代：冷启动与长会话内存（[docs/perf-iteration-plan.md](docs/perf-iteration-plan.md)）
- 插件生态：更多官方示例插件与第三方市场接入
- 会话跨端迁移与备份恢复的用户侧入口

## 二次开发（模板改名）

本仓库是可直接二次开发的模板。换品牌一键完成：

```bash
./scripts/rename.sh <new-slug> [--app-name "显示名"] [--dry-run]   # macOS / Linux
scripts\rename.bat <new-slug> [--app-name "Name"] [--dry-run]      # Windows
```

覆盖品牌三形态（slug/Pascal/UPPER）、`pi-desktop` 内部 id、Tauri 显示名与 bundle id、`.kova-plugin` 目录名等，改动前自动备份。详见脚本头部注释。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/mcp-design.md](docs/mcp-design.md) | MCP 接入架构 |
| [docs/plugin-system-design.md](docs/plugin-system-design.md) | 插件与面板系统 |
| [docs/secrets-env-design.md](docs/secrets-env-design.md) | 密钥与环境变量 |
| [docs/prompt-queue-design.md](docs/prompt-queue-design.md) | 提示词排队 |
| [docs/perf-baseline.md](docs/perf-baseline.md) | 性能基线 |
| [docs/release.md](docs/release.md) | 构建与发布 |
| [docs/remote-access.md](docs/remote-access.md) | 远程访问 |
| [docs/SELF_HOSTED_RUNTIME.md](docs/SELF_HOSTED_RUNTIME.md) | 自托管运行时 |
