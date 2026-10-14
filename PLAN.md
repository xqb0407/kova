# Kova → Electron 改造计划

> 状态：v1 定稿（2026-10-14，自主执行版）。
> 约束：**原项目 `~/Desktop/ai-teamplte` 只读，一行不改**。本目录
> `kova-electron` 是全新独立仓库；前端"直接搬"，Rust 宿主层用 Node 复刻，
> sidecar 保留（见 D3）。

## 0. 需求解读（用户原话 → 设计决定）

| 原话 | 解读 | 决定 |
|---|---|---|
| 改造成 electron | 桌面壳从 旧桌面壳 换成 Electron | 新壳 = Electron 主进程（Node/TS），渲染层不变 |
| 在桌面新增一个项目（文件夹） | 独立目录，不动原仓 | `~/Desktop/kova-electron`，自含 workspace |
| 前端可以直接搬 | UI 代码整体复制 | 原样复制 `apps/desktop`（除 `原 Rust 宿主/`），**零逐行改写**，靠兼容层衔接（D1） |
| 还要 Rust 部分 | 原 Rust 宿主 的 30 个 Rust 模块（17,159 行、85 个命令）承载的能力要保留 | 全部在 Electron 主进程用 Node 等价实现（D2），按 P0→P2 分期 |
| electron 可以直接用 node | 不用 Rust、不引 N-API 桥，宿主逻辑直接写 Node | 成立：fs/sqlite/child_process/fetch/ws/notification/tray/pty 全有 Node 对应 |
| sidebar（sidecar？）还要不要 | 按我的设计来 | **要**。"sidecar" 就是 `apps/sidecar/pi-agent`——AI Agent 本体（对话/工具/自动化调度），旧版也是靠它干活的，Electron 没有理由丢（D3）。UI 侧边栏随前端原样保留 |
| 计划先写，写完再开发 | 本文档即计划；批准后进入实施 | 实施顺序 = §5 里程碑 |

## 1. 调研结论（现状架构，全部有源码证据）

```
┌─ WebView（Next.js 16 静态导出 out/，output:"export"）─────────────┐
│  components/ hooks/ lib/ app/      40 个文件 import 桌面桥/* │
│  is旧桌面壳() = "__KOVA_DESKTOP__" in window   ← 桌面能力开关     │
└──────────────┬───────────────────────────────────────────────────┘
   invoke(85 命令) / listen(8 事件) / Channel(pty 字节流) / plugin-dialog
┌──────────────▼───────────────────────────────────────────────────┐
│  旧桌面壳 Rust 宿主 原 Rust 宿主/src（30 模块 17,159 行）                │
│  lib.rs：85 个 #[旧桌面壳::command] + 生命周期（单实例/托盘/退出收尸）│
│  store.rs：SQLite(state.db, WAL, kv 表)；data.rs：30 种 host_query │
│  tool_exec.rs：bash/read/write/edit/http（进程组杀、stale 守卫）   │
│  secret_env/secret：明文落库 + 名字→明文注入 + 输出脱敏            │
│  pi_agent.rs：spawn sidecar 二进制 + NDJSON stdio 协议 + chunk 合帧│
│  pty.rs / fs.rs / git.rs / browser.rs / remote.rs / tunnel.rs …    │
└──────────────┬───────────────────────────────────────────────────┘
        NDJSON stdin/stdout（协议与宿主语言无关）
┌──────────────▼───────────────────────────────────────────────────┐
│  pi-agent sidecar（apps/sidecar/pi-agent，TS 源码，bun --compile   │
│  单文件二进制；pi-agent-core + MCP + 调度器；env: PI_DB_PATH /      │
│  PI_SESSIONS_DIR / PI_TASK_CWD；host_query/tool、host_cancel 反向  │
│  调用宿主）                                                        │
└───────────────────────────────────────────────────────────────────┘
```

关键契约（移植必须逐条对齐）：

1. **前端→宿主**：`invoke(cmd, args)` 共 85 个命令（清单见 §3 表）。
2. **宿主→前端事件**（8 个）：`pi-chunk-batch`（string[]，每行 = sidecar 原始
   NDJSON）、`pi-exit`、`git-changed`、`browser:navigated`、`browser:viewport`、
   `backup:progress`、`tunnel:download`、`update:progress`（后三者形状相同：
   `{phase, done, total, message}`）。
3. **pty 通道**：`pty_open({id,cwd,cols,rows,on_data: Channel<number[]>})`，
   空数组 = 退出标记。
4. **sidecar stdio 协议**：
   - 前端 `pi_prompt/pi_abort/pi_reset/pi_request`（id 由宿主注入 `pi-<n>`）
     → 写 stdin 一行 NDJSON；
   - stdout 行分四类：`host_cancel`（杀工具进程树）、`host_query`（SQLite/工具
     执行，回复 `host_result` 行写回 stdin）、带 id 响应（配对 pending）、
     无 id 帧（合帧 20ms/64 行批量 emit `pi-chunk-batch`；finish/error 立即冲刷）；
   - stderr：脱敏（sk-…/Bearer）后写 pi-agent.log；
   - 退出：清在飞工具、pending 全部报 error、emit `pi-exit`；
   - 优雅关闭：stdin 写 `{"type":"shutdown"}` 再等（宽限）。
5. **host_query kind 全集**（data.rs）：session_* ×9、secret_* ×3、
   credential_* ×4、custom_provider_* ×5 + custom_providers_list、models_* ×4、
   kv_get/kv_set、usage_* ×4，外加 `tool`（→ secret_env 解析 + tool_exec 执行）。
6. **数据目录**（macOS）：`~/Library/Application Support/com.kova.assistant`，
   内含 `state.db`、`sessions/`、`task-workspace/`、日志、checkpoints、
   browser-panel、attachments 等。旧桌面壳 命令里 `open_logs_dir`、备份范围、
   git 影子目录全部以此为根。

## 2. 目标架构

```
kova-electron/                     ← 本目录（bun workspace，结构镜像原仓）
├── PLAN.md
├── package.json                   workspaces: apps/desktop、apps/sidecar/*、packages/*、apps/electron
├── apps/desktop/                  前端原样复制（删 原 Rust 宿主/、out/、tmp-verify*）
│   ├── next.config.ts             + 仅改两处：加载形态（dev localhost / prod kova://）
│   └── src 兼容层在 桌面桥/* 别名指向的 renderer-bridge/
├── apps/electron/                 ★ 新写的 Electron 壳（TS，esbuild 打包）
│   ├── main/                      主进程：入口 + 30 个模块的 Node 移植
│   ├── preload.ts                 注入 __KOVA_DESKTOP__ 桥（invoke/event/Channel）
│   └── renderer-bridge/           桌面桥/* 的 API 兼容实现（core/event/window/app/path/dialog）
├── apps/sidecar/pi-agent/         sidecar 源码复制（不改）+ 新构建脚本
├── packages/pi-protocol/ shared/  复制（不改）
├── plugins/ scripts/              复制（面板 HTML 构建 + 内置插件 zip，sidecar 编译前置）
└── resources/                     图标、云壳二进制目录等
```

### 设计决定

- **D1 前端零改写**：不移植 40 个 import，而是用 tsconfig `paths` 把
  `桌面桥/api/*`、`桌面桥/plugin-dialog` 映射到 `renderer-bridge/`
  的同签名实现；preload 在 `window` 上挂 `__KOVA_DESKTOP__`/`__KOVA_DESKTOP__`
  标记使 `is旧桌面壳()` 为真。`getVersion()/join()`/dialog 全部走 `invoke` 通道，
  bridge 只实现薄封装。以后同步上游前端改动 = 直接覆盖复制。
- **D2 Rust → Node 全替换**：不用 napi-rs、不做 sidecar 化 Rust。主进程内一个
  命令路由器（`ipcMain.handle('invoke')`）按名分发到 ~30 个 TS 模块，命令名、
  参数名（camelCase 约定）、返回形状、错误字符串与 Rust 版逐一对齐；
  宿主→前端事件经 `webContents.send` 同名回放。
- **D3 sidecar 保留**：pi-agent 是 Agent 本体（模型调用、工具编排、自动化调度、
  记忆、MCP），与宿主语言解耦（stdio NDJSON）。Electron 主进程 spawn 同一
  bun 编译产物即可——这正是"electron 可以直接用 node"落地的地方。构建链复用
  `bun build --compile`（含内置插件 zip / 面板 HTML 前置产物），冒烟 ping/pong 同脚本。
- **D4 数据延续**：Electron 复用 `com.kova.assistant` 目录
  （`app.setPath('userData', …)`），历史会话/密钥/设置**开箱即得**。
  风险：与旧版同时运行会双写同一库（WAL+busy_timeout 5s 可保不损坏，
  但双 sidecar 会互抢任务）→ 本壳用单实例锁，并约定不同时开两壳。
- **D5 加载形态**：prod 用特权自定义协议 `kova://app/`（映射 `out/`，
  标准 CSP、可被 service worker 接受），dev `http://localhost:3000`。
  `is旧桌面壳Dev()` 逻辑不变。
- **D6 窗口参数对齐 旧桌面壳.conf**：1600×800/min 800×600、transparent、
  macOS `titleBarStyle: hiddenInset` + 红绿灯偏移 (20,30)（trafficLightPosition
  近似等价）、Windows/Linux 无边框 + 前端自绘控制（WindowControls 已有，走
  bridge 的 window API）、初始不可见 → DOMContentLoaded/5s 兜底 show、
  Windows 关窗进托盘、macOS 保留系统行为 + 托盘菜单。
- **D7 SQLite**：优先 Electron 内建 `node:sqlite`（同步 API，最贴近 rusqlite
  用法），探测不可用则回退 better-sqlite3；统一经 `store/db.ts` 适配层，上层
  （data.ts/host_query）不感知驱动差异。
- **D8 PTY**：node-pty（Unix forkpty 等价实现），输出用 MessagePort/IPC 流
  模拟 `Channel`；上限 12 会话、同 id 顶替、channel 死 → 杀壳，与 pty.rs 对齐。
- **D9 浏览器面板**：`WebContentsView` 挂在主 BrowserWindow 上
  （attach/detach/sync_bounds/viewport），替代 旧桌面壳 子 webview；
  `browser:navigated/viewport` 事件、独立分区（persist:browser-panel）、
  agent 驱动（tool_exec 的 browser_* 子命令）经 `executeJavaScript` 实现。
- **D10 升级/备份/隧道/远程**：按原协议移植，不另造轮子——升级读 R2
  `latest.json`（渠道判断、12h 节流、结果进 kv；install 动作在 Electron 下
  改为"打开下载页"，autoUpdater 后续再上）；备份保持 PIABK 信封格式
  （tar.gz + AES-256-GCM/pbkdf2 + S3 SigV4 + WebDAV），恢复"staging+待换入"
  启动流程；隧道 spawn cloudflared 同参数同状态机；远程网关 Node http+ws
  重写，协议（pair/auth/透传/REMOT DENIED 名单）不变，静态 serve `out/`。
- **D11 安全**：`contextIsolation: true`，preload 只暴露 `__KOVA_DESKTOP__`
  一个通道；所有文件系统命令在主进程执行，路径校验策略照抄 Rust 版
  （fs.rs/app_file_* 的白名单根）；不开放任意 Node。

## 3. 模块映射表（Rust 30 → Node）

| Rust 模块 | 命令/职责 | Node 实现 | 依赖 | 期 |
|---|---|---|---|---|
| lib.rs | 启动装配/单实例/关窗策略/退出收尸 | main.ts + lifecycle.ts | electron | P0 |
| store.rs | state.db、kv ×3、WAL | store/db.ts + kv.ts | node:sqlite/better-sqlite3 | P0 |
| data.rs | host_query ×31 + 建表 + 回填 | host/query.ts | 同上 | P0 |
| tool_exec.rs | host `tool`：bash/read/write/edit/http + 进程组杀 + stale 守卫 + 脱敏 | host/tool.ts | child_process(closed group)/crypto | P0 |
| secret_env.rs / secret.rs | 名字→明文注入、输出脱敏、enc:v1 识别 | host/secret*.ts | — | P0 |
| pi_agent.rs | spawn/NDJSON/配对/合帧/pi_* ×4/shutdown | host/pi.ts | child_process | P0 |
| fs.rs | fs_* ×9 + app_file_* ×4 + attachment ×2 + 定时清理 | host/fs.ts | fs/path/shell | P0 |
| http.rs | http_post（CORS 绕行） | host/http.ts | fetch | P0 |
| notify.rs | notify_show / consume_pending | host/notify.ts | electron Notification | P0 |
| webhook.rs | webhook_delivery_* ×4 + 建表 | host/webhook.ts | store | P0 |
| logging.rs | frontend_log/cleanup + 按日目录 + 脱敏 | host/log.ts | fs | P0 |
| about.rs | open_logs_dir/open_external/set_dev_mode | host/about.ts | shell | P0 |
| gpu.rs | 硬件加速开关（先读后建窗） | host/gpu.ts | electron commandLine | P0 |
| appearance.rs | 窗口透明/材质 | host/appearance.ts | vibrancy/backgroundMaterial | P1 |
| menu.rs | macOS 应用菜单 | menu.ts | electron Menu | P1 |
| tray.rs | Windows 托盘 + 关窗隐藏 | tray.ts | electron Tray | P1 |
| window 控制/路径（bridge 内） | 最小化/最大化/关闭/isMaximized/onResized、join | 主进程 BrowserWindow | — | P0 |
| pty.rs | pty_* ×4 + Channel 字节流 | host/pty.ts | node-pty | P1 |
| git.rs | git_* ×13（CLI 包装、影子检查点） | host/git.ts | child_process + 系统 git | P1 |
| browser.rs | browser_* ×6 + 导航/viewport 事件 + 子视图 | host/browser.ts | WebContentsView | P1 |
| browser_shot.rs / browser_scripts.rs / playwright_script.rs | 无头截图/注入脚本 | host/shot.ts | playwright-core（仓内已有） | P2 |
| resource.rs | 资源采样/存储扫描清理/reveal/独立窗口 | host/resource.ts | app.getAppMetrics()+fs | P1 |
| remote.rs | 网关 ×5（HTTP+WS、配对、静态站） | host/remote.ts | http/ws | P2 |
| tunnel.rs | 隧道 ×5（cloudflared 监管+下载校验） | host/tunnel.ts | child_process+crypto | P2 |
| backup.rs | 备份 ×10（PIABK/S3/WebDAV/换入） | host/backup.ts | tar+crypto+fetch | P2 |
| update.rs | 升级 ×4（R2 latest.json） | host/update.ts | fetch | P2 |
| panic_guard.rs | invoke 兜底 | 路由层 try/catch | — | P0 |
| browser 内嵌 devtools/dev_mode | open_devtools | webContents.openDevTools | — | P1 |

bridge（渲染层兼容模块，签名对齐 桌面桥/api v2）：
`core`（invoke/Channel）、`event`（listen/emit/unlisten）、`window`
（getCurrentWindow：minimize/toggleMaximize/close/isMaximized/onResized/
onCloseRequested?）、`app`（getVersion）、`path`（join）、`plugin-dialog`
（open/save/message）。

## 4. 复制与构建管线

- **复制清单**：`apps/desktop`（除 原 Rust 宿主/out/node_modules/tmp-*）、
  `apps/sidecar/pi-agent`、`packages/pi-protocol`、`packages/shared`、
  `plugins/`、`scripts/build-plugins.mjs`（sidecar 编译前置依赖相对路径，保持
  目录层级一致）。原仓 `node_modules`（3GB）不复制，新仓独立 `bun install`
  （依赖表原样继承，含 patches 与 overrides）。
- **构建链**：`scripts/build-plugins.mjs` → sidecar `bun build --compile`
  （产物进 `apps/electron/binaries/`）+ 内置插件 zip（沿用 ensure 脚本）→
  `next build`（静态导出，base 走 kova:// 可加载路径）→ electron 主进程
  esbuild → `electron .`。打包发行（dmg/nsis）用 electron-builder，列为收尾项。
- **开发模式**：`bun run dev` = next dev (3000) + electron 指向 localhost +
  主进程 ts watch。

## 5. 里程碑（先计划后开发 → 实施顺序）

- **M0 骨架**：目录脚手架 + 复制 + 新 workspace 可 `bun install`；
  Electron 起空窗能显示静态页。验收：截图可见 UI、`is旧桌面壳()` 为真。
- **M1 P0 全链路（"能聊"）**：store/data/tool_exec/secret_env/pi_agent/http/
  fs/notify/webhook/logging/about/gpu + bridge(core/event/window/app/dialog)。
  验收：发一条消息收到流式回复（pi-chunk-batch 合帧）；bash/read/write/edit
  工具跑通并带 stale 守卫；退出收尸；ping/pong sidecar 冒烟。
- **M2 P1**：pty 终端、git 面板 13 命令、浏览器面板（attach/驱动/事件）、
  资源管理器窗口、tray/menu/appearance。验收：开终端敲命令、diff 视图、
  面板打开网页导航事件回传。
- **M3 P2**：remote 网关（手机可连）、cloudflared 隧道、备份信封+S3/WebDAV、
  升级检查。验收：配对码 + 另一浏览器 8787 聊天；备份列表/恢复标记。
- **M4 收尾**：electron-builder 打包（本机至少出 `--dir`）、README、
  与原仓差异清单、遗留项诚实记录。

每个里程碑完成即截图/日志验证再进下一个；任何与 Rust 版行为分歧写进
`docs/PORTING-NOTES.md`。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `bun install`/electron 下载失败（网络） | npmmirror 源已在本机缓存中（bun 缓存里有 registry.npmmirror.com 痕迹）→ 配置镜像重试；electron 可手动下 zip 解压 |
| node:sqlite 在 Electron 内不可用 | db 适配层切 better-sqlite3（预编译包）；再不行退 bun spawn 的 sqlite helper 进程（最后手段） |
| node-pty 编译失败 | 降级：pty 面板显示"启动失败"卡片（前端已有该路径），不阻塞其他能力；重试 electron-rebuild |
| 与旧版双开数据竞争 | 文档声明互斥 + 启动检测（pidfile） |
| Channel/on_data 序列化差异 | bridge 层用回调 id 注册表模拟（与旧版JS 版同款机制） |
| 命令参数 camelCase 映射错 | 用原前端调用点逐个比对参数名；router 对未知命令返回明确错误名，开发期全量点一遍 |
| WebContentsView bounds 与 CSS 像素差 | devicePixelRatio 换算（sync_bounds 传物理像素，同 browser.rs 口径） |

## 6.5 实施进度（本次夜间执行结果，均有验证证据）

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 骨架 | ✅ | workspace 复制+安装；`kova://app/index.html` 渲染完整 UI（截图 `/tmp/kova-final-render.png`） |
| M1 P0 全链路 | ✅ | 聊天 E2E：prompt→24 批 50 行 chunk（start/thread_event/error/finish）→ 会话落库；错误为用户模型额度不足（提供商侧）原样穿透；`e2e-smoke.mjs` 零控制台错误 |
| M2 P1 | ✅ | git E2E（13 命令关键路径 + 检查点 diff/restore 语义）；浏览器面板 E2E（attach/导航事件/first eval/viewport/detach）；pty 已实现（node-pty，未实测）；resource/tray/menu/appearance 已接入 |
| M3 P2 | ✅ | remote 网关（配对/限次/id 往返还原真实数据/REMOTE_DENIED/静态页 CSP）、tunnel 监管（状态机/假二进制 error/日志尾巴）、backup（明密文备份→peek→staging→重启换入全链路，含残行修剪/错口令清理/credentials 清空）三项 E2E 全绿 |
| M4 收尾 | 部分 | 全量 `bun run build` 三阶段绿 + `tsc --noEmit` 0 错误；electron-builder 打包未跑（devDependencies 已备） |

已知差异与遗留以 `PORTING-NOTES.md` 为准（ARIA 快照未移植、update_install 改打开下载页；
Windows screenshot 分支已按 Rust 版移植，纯 macOS 环境无法实跑 PowerShell，仅完成脚本级自检；
未验证项：cloudflared 真实下载、S3/WebDAV 真实远端连通、与 Rust 版备份包的交叉解开）。

## 7. 成功判据（完成审计）

1. `~/Desktop/kova-electron` 独立可构建运行；原仓 `git status` 保持 clean。
2. PLAN.md 存在且本文件即其内容（计划先行的证据）。
3. Electron 窗口渲染完整 Kova UI（截图），历史会话可见（数据延续）。
4. 聊天端到端可用：prompt → 流式 chunk → sidecar 工具执行（bash 实测）→ 回复落库。
5. §3 表中 P0 全部命令有实现且经冒烟；P1/P2 按里程碑推进，未完成项列清单。
```
