# Kova（扣瓦）

简体中文 | [English](README_EN.md)

跨平台桌面 AI 助手：Electron 桌面壳 + Next.js/assistant-ui 前端 + 本地 pi-agent
sidecar（经 stdio NDJSON 与宿主通信）。模型 API Key 由使用者自行配置，密钥与
会话数据全部落本地。

架构三层：**主进程**（Electron/Node——命令路由、窗口、终端、文件、通知、托盘
等系统能力）· **渲染层**（Next.js + assistant-ui 会话界面）· **sidecar**
（pi-agent——AI Agent 本体，bun 单文件二进制）。

**功能一览**

- **AI 会话**：流式对话、逐文件检查点回滚、记忆条目化、自定义智能体、目标（goal）模式
- **Agent 运行时**：内嵌 [pi](https://github.com/earendil-works/pi) sidecar——工具调用、
  审批边界、子智能体、MCP（Model Context Protocol）
- **插件**：canvas（无限白板）、office（Univer 文档/表格/演示）、ui-design（设计稿绘制）
- **IM 渠道**：钉钉 / 飞书 / 企业微信机器人双向接入（webhook 与 stream SDK 双形态）
- **远程访问**：Expo 移动端配对、cloudflared 隧道监管、SSH 远程项目
- **安全**：API Key 本地加密存储、密钥注入与脱敏、MCP secret 注入边界
  （见 [docs/secrets-storage-hardening.md](docs/secrets-storage-hardening.md)）

## 目录结构

```
apps/desktop/            前端（Next.js；desktop-bridge/ 是桌面桥——invoke/事件/
                         窗口/对话框/路径等能力的 Electron 实现）
apps/electron/           Electron 壳
  main/                  主进程：命令路由与系统能力（fs/sqlite/pty/通知/托盘等，约 8.8k 行）
  preload/               window.kovaHost + __KOVA_DESKTOP__ 桌面标记 + 拖拽区桥
apps/sidecar/pi-agent/   AI Agent 本体（bun 编译为单文件二进制）
apps/mobile/             Expo 移动端（配对桌面实例，远程会话）
packages/pi-protocol     前后端共享协议类型
packages/pi-runtime      会话运行时状态与回放
packages/pi-sandbox      沙箱执行边界
plugins/                 内置插件（canvas / office / ui-design）
docs/                    架构与功能文档（见下）
scripts/                 构建/打包/发版/改名校验脚本
```

## 快速开始

前置：[bun](https://bun.sh)（依赖与构建）、Node ≥ 20、macOS/Windows。

```bash
bun install                    # 首次；Electron 二进制缺失时补跑 apps/electron/node_modules/electron/install.js

# 开发模式（一条命令，三层各自热更）
bun run dev                    # 需要时自动起 next dev(:3000) 并拉起 Electron

# 生产构建（三条链，可分别执行）
bun run build:sidecar          # 侧车 → apps/electron/binaries/kova-worker
bun run build:renderer         # 前端静态导出 → renderer-out
bun run build:main             # 主进程/preload → apps/electron/dist
bun run build && bun run start # 全量构建并运行（无热更，等价装机版）
```

首次在设置里填入你自己的模型 API Key（OpenAI 兼容 / Anthropic 等格式均可）。

### 数据目录

| 渠道 | 目录 | 说明 |
|---|---|---|
| 正式（打包版） | `~/Library/Application Support/com.kova.assistant` | macOS；Windows 在 %APPDATA% |
| dev（`--dev`） | `…/com.kova.assistant.dev` | 独立，不污染正式库 |
| 覆盖 | `KOVA_DATA_DIR=/tmp/xxx` | e2e/多实例调试 |

app 有单实例锁（按数据目录）：同一渠道重复启动只会唤回已有窗口。

## 测试与端到端

```bash
bun run verify:goal            # 全量门禁：goal/桌面/协议/运行时测试 + 三包 typecheck
bun run test:desktop           # 桌面端单测
bun run test:protocol          # 协议单测
```

CDP 驱动的端到端冒烟（`apps/electron/scripts/`）：

```bash
./node_modules/.bin/electron . --remote-debugging-port=9222     # 或 dev 模式 922x
node apps/electron/scripts/e2e-smoke.mjs 9222                   # 渲染层：桥标记/invoke 往返/DOM/控制台错误
node apps/electron/scripts/e2e-chat.mjs 9223                    # 聊天端到端（沙箱数据目录）
node apps/electron/scripts/e2e-git.mjs 9224 /tmp/repo           # git 13 命令（含检查点 diff/还原）
node apps/electron/scripts/e2e-remote.mjs 9226 18787            # 远程网关（配对/id 往返/拒绝帧）
```

## 打包与发布

```bash
./scripts/build-release.sh                 # 预检 → sidecar → 前端 → 主进程 → dmg + SHA256SUMS
node scripts/release.mjs <版本号> --dry-run # 同步 root/desktop/electron 三处版本号
node scripts/release.mjs <版本号>           # 提交 + tag + 推送（CI 出 Draft Release）
```

CI：`.github/workflows/release.yml`（tag 触发，macos-14 构建 dmg）。macOS 签名
为 ad-hoc 深签（未公证首次打开需一次 GUI 引导）。

## 文档

| 主题 | 文档 |
|---|---|
| 密钥存储加固 | [docs/secrets-storage-hardening.md](docs/secrets-storage-hardening.md) |
| MCP secret 注入 | [docs/mcp-secret-injection.md](docs/mcp-secret-injection.md) |
| 远程访问与配对 | [docs/remote-access.md](docs/remote-access.md) |
| IM 渠道接入 | [docs/im-channels.md](docs/im-channels.md) |
| 插件开发 | [docs/plugin-development.md](docs/plugin-development.md) |
| 沙箱边界 | [docs/sandbox.md](docs/sandbox.md) |
| Goal 模式 | [docs/goal-mode-v2.md](docs/goal-mode-v2.md) |
| 会话组装 | [docs/turn-assembly.md](docs/turn-assembly.md) |

## 参考与致谢

- [pi](https://github.com/earendil-works/pi)（MIT）—— 内嵌的 agent 运行时（pi-agent sidecar / pi-ai / pi-agent-core）
- [assistant-ui](https://github.com/assistant-ui/assistant-ui)（MIT）—— 会话界面组件库
- [Univer](https://github.com/dream-num/univer)（Apache-2.0）—— office 插件的表格/文档引擎
- [Leafer](https://github.com/leaferjs/Leafer)（MIT）—— canvas 插件渲染引擎
- 桌面壳：[Electron](https://www.electronjs.org/)（MIT）
- 开发笔记：`PLAN.md`（设计取舍）· `PORTING-NOTES.md`（实现记录）

## 许可证

本项目以 [Apache-2.0](./LICENSE) 发布；主要第三方依赖及其许可见
[NOTICE](./NOTICE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
