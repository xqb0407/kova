# kova-electron

Kova（扣瓦）AI 助手的 **Electron 版**：UI 沿用原项目前端，原 Rust 宿主（30 个模块 /
约 17k 行 / 85 个命令）在 Electron 主进程用 Node + TypeScript 完整复刻；
AI Agent 本体（pi-agent sidecar）原样保留，经 stdio NDJSON 与宿主通信。

> 迁移计划与设计决定：`PLAN.md`　·　与旧桌面壳的行为差异、遗留与验证记录：`PORTING-NOTES.md`

## 目录结构

```
apps/desktop/            前端（复制自原项目；desktop-bridge/ 是桌面桥——
                         invoke/事件/窗口/对话框/路径等能力的 Electron 实现，
                         业务代码 import 直接指向它，无任何旧壳依赖）
apps/electron/           Electron 壳
  main/                  主进程：命令路由 + 30 个模块的 Node 移植（约 8.8k 行）
  preload/               window.kovaHost + __KOVA_DESKTOP__ 桌面标记 + 拖拽区桥
  renderer-out/          next build 静态导出产物（构建时自动同步，勿手改）
  binaries/              kova-worker（侧车）二进制：bun --compile 产物
  icons/                 应用/托盘图标（构建时随包）
apps/sidecar/pi-agent/   AI Agent 本体（原样复制；bun 编译为单文件二进制）
packages/pi-protocol     前后端共享协议类型
plugins/                 内置插件（面板 HTML 已入库，build-plugins 幂等跳过）
scripts/                 构建/打包/发版/改名校验脚本
```

## 构建与运行

```bash
bun install                    # 首次；Electron 二进制缺失时补跑 apps/electron/node_modules/electron/install.js

# 三条构建链（可分别执行）
bun run build:sidecar          # 侧车 → apps/electron/binaries/kova-worker（含 ping/pong 冒烟）
bun run build:renderer         # next build 静态导出 → apps/desktop/out，并自动同步到 renderer-out
bun run build:main             # 主进程/preload → apps/electron/dist

# 跑构建产物（等价装机版行为；**没有热更新**，改代码要重新 build）
bun run build && bun run start
```

### 开发模式（一条命令，三层各自热更）

```bash
bun run dev                        # 需要时自动起 next dev(:3000) 并拉起 Electron
bun run dev -- --remote-debugging-port=9222   # 额外参数透传给 Electron
```

| 改哪里 | 生效方式 | 耗时 |
|---|---|---|
| 前端 `apps/desktop/**` | Next dev **HMR**：界面直接变，不重启 | 立即 |
| 主进程/preload `apps/electron/main·preload/**` | esbuild 重建 → **自动重启 Electron** | ~2s |
| 侧车 `apps/sidecar/pi-agent/**` | `bun --watch` **原地重启侧车**（app 不动） | <1s |

几点说明：
- 侧车在开发态**直接跑 `src/index.ts`**（dev.mjs 生成临时包装脚本，经 `PI_AGENT_BIN` 交给宿主）：
  不必每次编 87MB 单文件、也不牵扯 macOS 产物签名问题；`KOVA_DEV_BINARY=1` 可切回编译产物。
- `--dev` 同时把数据目录切到 dev 渠道（见下），与打包的 `Kova Dev.app` 一致。
- 想换数据目录/避免与常开实例抢单实例锁：`KOVA_DATA_DIR=/tmp/kova-dev bun run dev`。
- 老的"两个终端"手动流程仍可用：`cd apps/desktop && bun run dev` 起前端，另开一个终端
  `cd apps/electron && bun run dev`（= 构建 main/preload 后 `electron . --dev`）；
  该路径下改主进程/侧车需要自己重跑，没有自动重启。

### 打包桌面应用

```bash
# 一键（推荐）：预检 → sidecar → 前端 → 主进程 → --dir 打包（ad-hoc 深签）→ hdiutil 出 dmg → SHA256SUMS
./scripts/build-release.sh                 # 正式渠道 → apps/electron/release/
./scripts/build-release.sh --dev-channel   # dev 渠道 → apps/electron/release-dev/
./scripts/build-release.sh --check         # 只做环境预检

# 分步等价命令
cd apps/electron && bun run dist:dev -- --mac --dir     # → release-dev/mac-arm64/Kova Dev.app
```

签名口径：打包时对 `.app` 做 **ad-hoc 深签**（`apps/electron/scripts/after-pack.cjs`，
不加 hardened runtime——Electron 自带 Framework 在 ad-hoc 下会因缺 Team ID 被 dyld 拒载）；
`codesign --verify --deep --strict` 通过即"封印自洽"，未公证首次打开需一次 GUI 引导。

### 数据目录

| 渠道 | 目录 | 说明 |
|---|---|---|
| 正式（打包版） | `~/Library/Application Support/com.kova.assistant` | 与旧版共享历史数据 |
| dev（`--dev` / dev 包） | `…/com.kova.assistant.dev` | 独立，不污染正式库 |
| 覆盖 | `KOVA_DATA_DIR=/tmp/xxx` | e2e/多实例调试 |

app 有单实例锁（按数据目录）：同一渠道重复启动只会唤回已有窗口。

## 冒烟与端到端（CDP 驱动，均在 `apps/electron/scripts/`）

```bash
./node_modules/.bin/electron . --remote-debugging-port=9222     # 或 dev 模式 922x
node apps/electron/scripts/e2e-smoke.mjs 9222                   # 渲染层：桥标记/invoke 往返/DOM/控制台错误
node apps/electron/scripts/e2e-drag.mjs 9222                    # 拖拽区语义 + 滚轮（回归护栏）
node apps/electron/scripts/e2e-chat.mjs 9223                    # 聊天端到端（沙箱数据目录）
node apps/electron/scripts/e2e-git.mjs 9224 /tmp/repo           # git 13 命令（含检查点 diff/还原）
node apps/electron/scripts/e2e-browser.mjs 9225                 # 浏览器面板生命周期
node apps/electron/scripts/e2e-remote.mjs 9226 18787            # 远程网关（配对/id 往返/拒绝帧）
node apps/electron/scripts/e2e-tunnel.mjs 9228                  # cloudflared 监管状态机
KOVA_DATA_DIR=/tmp/kova-e2e-bk KOVA_BACKUP_HOME_DIR=/tmp/kova-e2e-home/.kova \
  node apps/electron/scripts/e2e-backup.mjs 9229 /tmp/out        # 备份/恢复阶段 1（另起实例再跑 --phase=after）
```

备份 e2e 分两阶段：阶段 1 在运行中的实例上做备份/恢复并断言 staging 内容；
阶段 2 在重启后运行（`--phase=after`）断言换入结果。`KOVA_BACKUP_HOME_DIR` 把
个人配置（`~/.kova` 的备份视角）钉到沙箱——只影响备份/恢复，不影响 sidecar
运行时；未设置时跳过 personal 分区断言、绝不写真实家目录。

## 发布

```bash
node scripts/release.mjs <版本号> --dry-run   # 预演：同步 root/desktop/electron 三处版本号
node scripts/release.mjs <版本号>             # 提交 + tag + 推送（CI 出 Draft Release）
node scripts/publish-update.mjs --version <版本号> --electron-dmg Kova_<版本>_arm64.dmg --dry-run
                                              # 写 dl.openkova.site 的 preview/stable 清单
```
CI：`.github/workflows/release.yml`（tag 触发，macos-14 构建 dmg + SHA256SUMS → Draft Release）。
Windows 安装包（NSIS 配置已就绪）建议在 CI/Windows 机器上构建。

## 参考与致谢

- **Kova 桌面版**（Tauri，Apache-2.0）—— 本 Electron 版的移植前身
- [MonoCode](https://github.com/hardbeat920/monocode)（MIT）—— 检查点逐文件回滚、记忆条目化、自定义智能体的设计参考
- [pi](https://github.com/earendil-works/pi)（MIT）—— 内嵌的 agent 运行时（pi-agent sidecar / pi-ai / pi-agent-core）
- [assistant-ui](https://github.com/assistant-ui/assistant-ui)（MIT）—— 会话界面组件库
- [Univer](https://github.com/dream-num/univer)（Apache-2.0）—— office 插件的表格/文档引擎
- [Leafer](https://github.com/leaferjs/Leafer)（MIT）—— canvas 插件渲染引擎（白板交互设计参考 [Excalidraw](https://github.com/excalidraw/excalidraw)，MIT）
- 桌面壳：[Tauri](https://tauri.app/)（前身所用）/ [Electron](https://www.electronjs.org/)（本项目，MIT）

## 许可证

本项目以 [Apache-2.0](./LICENSE) 发布；主要第三方依赖及其许可见 [NOTICE](./NOTICE)。
