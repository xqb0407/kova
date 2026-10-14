# kova-electron

Kova（扣瓦）AI 助手的 **Electron 版**：前端与 sidecar 直接沿用原 Tauri 工程，
原 Rust 宿主（src-tauri，30 模块 / 17k 行 / 85 命令）在 Electron 主进程用 Node/TS 复刻。

> 改造计划：`PLAN.md`；与 Tauri 版的行为差异与遗留：`PORTING-NOTES.md`。

## 目录结构

```
apps/desktop/            前端（复制自原 Tauri 版；desktop-bridge/ 为桌面桥实现，
                        import 已直接指向它——@tauri-apps 依赖与别名均已移除）
apps/electron/           Electron 壳
  main/                  主进程：命令路由 + 30 个 Rust 模块的 Node 移植
  preload/               window.kovaHost + __TAURI_INTERNALS__ 标记
  renderer-out/          next build 静态导出产物（构建时由脚本同步）
  binaries/              pi-agent sidecar 二进制（bun --compile 产物）
apps/sidecar/pi-agent/   Agent 本体（原样复制；stdio NDJSON，与宿主语言解耦）
packages/pi-protocol     前后端共享协议类型
plugins/                 内置插件（面板 HTML 已在库内，build-plugins 幂等跳过）
```

## 构建与运行

```bash
bun install                    # Electron 二进制若缺失：手动跑 apps/electron/node_modules/electron/install.js
bun run build:sidecar          # 编译 pi-agent（含 ping/pong 冒烟）
bun run build:renderer         # next build → apps/desktop/out
bun run build:main             # 主进程/preload → apps/electron/dist
cd apps/electron && cp -R ../desktop/out renderer-out && ./node_modules/.bin/electron .
```

一条命令版：`bun run build && bun run start`（start 前需确保 renderer-out 已同步，
见 `scripts/dev.mjs` / 下方说明）。

### 开发模式

```bash
cd apps/desktop && bun run dev      # Next dev @3000
cd apps/electron && bun run dev     # 主进程构建后以 --dev 启动（加载 localhost:3000）
```

### 打包桌面应用

```bash
# 正式包（com.kova.assistant，与 Tauri 发布版共享数据）
cd apps/electron && bun run dist -- --mac --dir          # → release/mac-arm64/Kova.app

# dev 包（com.kova.assistant.dev，独立 dev 数据目录，与 tauri dev 对齐）
cd apps/electron && bun run dist:dev -- --mac --dir      # → release-dev/mac-arm64/Kova Dev.app

# 出安装包：--mac dmg / --win nsis（Windows 侧需在 Windows 或带 wine 的环境构建）
```

### 隔离数据目录

`KOVA_DATA_DIR=/tmp/xxx` 可让实例使用独立数据目录（e2e/多实例调试用）；
缺省仍指向 `~/Library/Application Support/com.kova.assistant`（与 Tauri 版共享历史数据）。

## 冒烟/端到端

```bash
# ① 启动（带 CDP）
cd apps/electron && ./node_modules/.bin/electron . --remote-debugging-port=9222
# ② 渲染层冒烟（桥标记/invoke 往返/DOM/控制台错误 + 截图）
node apps/electron/scripts/e2e-smoke.mjs 9222
# ③ 聊天端到端（沙箱实例上驱动输入→流式回复）
KOVA_DATA_DIR=/tmp/kova-e2e ./node_modules/.bin/electron . --remote-debugging-port=9223
node apps/electron/scripts/e2e-chat.mjs 9223
```
