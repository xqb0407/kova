# PORTING-NOTES — Rust(旧桌面壳) → Node(Electron) 差异与遗留

> 本文件记录 Electron 版与旧版的**行为差异**与**尚未接线**的能力，供接续开发
> 与发布说明使用。实现进度事实以代码与构建产物为准；分阶段计划见 `PLAN.md`。

## 已完整移植（行为对齐，契约逐条对照 Rust 源码）

| 能力 | Rust 源 | Electron 实现 | 备注 |
|---|---|---|---|
| 命令路由/事件广播 | lib.rs + panic_guard | `main/ipc.ts` + `registry.ts` | 未知命令错误串同形：`command X not found` |
| KV 存储/建表/回填 | store.rs + data.rs | `store.ts` + `data.ts` + `db.ts` | SQLite 用 `node:sqlite`（Electron 38 内建 Node 22）；`better-sqlite3` 为回退驱动 |
| host_query 31 种 kind | data.rs | `data.ts` | sessions/credentials/secrets/custom_providers/models/usage/kv 全量 |
| 工具执行 | tool_exec.rs | `tool-exec.ts` | bash（进程组整树杀、16KB 截断、cancel/timeout 文案）、read/write/edit（stale 守卫、JSON 守门）、http、screenshot（macOS screencapture+sips 阶梯）、后台任务（owner 归属校验） |
| 密钥注入/脱敏 | secret_env.rs + secret.rs | `secret-env.ts` + `secret.ts` | 明文直通 + `enc:v1:` 判缺失；`[REDACTED:NAME]` + base64 变体 |
| pi-agent 桥 | pi_agent.rs | `pi-agent.ts` | NDJSON、host_cancel/host_query、id 配对、20ms/64 行合帧、stderr 脱敏、shutdown 6s 宽限 |
| 文件树/我的文件/附件 | fs.rs | `fs-cmds.ts` | 双可信根（workspace / task-workspace 子树）、`..`/符号链接逃逸防护、错误码字符串一致（`bad-path`、`too-large`…） |
| 通知/待打开会话 | notify.rs | `notify.ts` | pending 槽 30s TTL + focus 消费 |
| webhook 记录表 | webhook.rs | `webhook.ts` | 建表 + 4 命令 |
| 日志 | logging.rs | `logging.ts` | 按日目录、10MB 滚动、7 天保留、stderr 镜像、frontend_log/cleanup_logs |
| 关于页 | about.rs | `about.ts` | 外链白名单、日志目录、dev 模式（kv 持久化 + 启动恢复） |
| GPU 开关 | gpu.rs | `gpu.ts` | `disableHardwareAcceleration()`（时序同为建窗前） |
| 外观材质 | appearance.rs | `appearance.ts` | acrylic/mica → macOS vibrancy（sidebar/under-window）/ Windows backgroundMaterial |
| 窗口/托盘/菜单 | lib.rs/menu.rs/tray.rs | `window.ts`/`menu.ts`/`tray.ts` | 首帧显示 + 5s 兜底；macOS 菜单加「资源管理器」；Windows 关窗进托盘 |
| 终端 PTY | pty.rs | `pty.ts` | node-pty；Channel 推 number[]、空数组 = 退出标记、channel 死 → 杀壳 |
| Git 集成 | git.rs | `git.ts` | CLI 包装（`-C <cwd> --no-optional-locks`）、porcelain v2 / name-status -z 解析、影子 git-dir 检查点（fnv1a 目录名/FNV-1a 与 Rust 同算法、LRU 20、同树复用、反向 patch 存档 + apply -R 还原）、`git-changed` 事件；写命令按 cwd 异步串行 |
| 面板浏览器 | browser.rs + browser_scripts.rs | `browser.ts` | WebContentsView 子视图、物理像素→DIP bounds、fill/fixed 视口、agent 七工具（navigate/snapshot/click/type/scroll/back/resize；JS 原语与 browser_scripts.rs 同源逐字）、导航重建重试与 busy 闸门、`browser:navigated/viewport` 事件；差异：ARIA 快照（Playwright 注入运行时）未移植，快照统一走文本快照 |
| 页面像素照 | browser_shot.rs | `browser-shot.ts` | 隐藏 BrowserWindow + capturePage + 同一压缩阶梯（无独立无头 Chrome，无孤儿清扫问题） |
| 公网隧道 | tunnel.rs | `tunnel.ts` | 二进制解析（kv custom → PATH → 常见位置 → appData/bin）、`cloudflared tunnel --url … --no-autoupdate` 进程组监管、stderr/stdout 逐行抓 `.trycloudflare.com` 地址、stopped/starting/running/error 状态机 + 40×400 日志尾巴、世代号防旧线程回写、GitHub Releases 一键下载（sha256 digest 校验不过不落盘、tar 解包、chmod、--version 冒烟）、`tunnel:download` 进度事件 |
| 备份与恢复 | backup.rs | `backup.ts` | PIABK 信封（`PIABK1\n` + camelCase header + tar.gz/AES-256-GCM 负载）、PBKDF2-SHA256×600000/32B/12B nonce/16B salt（与 Rust 同参数同布局，tag 尾接）、payloadSha256 对最终字节、逐文件快照-哈希-入包、解包逐文件校验 + JSONL 残行修剪、WAL checkpoint + VACUUM INTO 快照、手写 S3 SigV4（PUT/GET/DELETE/ListObjectsV2、path-style、重定向不跟随）、WebDAV（MKCOL 逐级/405 提示/PROPFIND 207/幂等 DELETE）、本地写入、staging + 待恢复标记 + 启动期原子换入（credentials 清空）、`backup:progress` 全阶段 |
| 远程访问网关 | remote.rs | `remote.ts` | node:http + ws；静态 serve 渲染产物（候选顺序/目录穿越防护/CSP 头同口径）、pair/auth 状态机（6 位码内存态、5 次失败断开、未认证 10s 超时）、id 重写 `rem-{conn}-{orig}` 与路由表还原、`REMOTE_DENIED_TYPES` 请求级拒绝（带 REMOTE_DENIED code）、无 id 白名单广播、有界出站队列背压踢线、局域网地址枚举（RFC1918/CGNAT 过滤）；`pi_remote_*` 5 命令 |
| 资源管理器 | resource.rs | `resource.ts` | 采样（Electron 进程指标 + ps 后代链）、存储扫描、白名单清理、独立窗口 `/resource` |
| 升级检查 | update.rs | `update.ts` | 同清单协议/渠道/12h 节流/缓存；**install 差异见下** |

## 行为差异（已知且有意）

1. **应用内升级**：旧桌面壳 走 minisign 包原地替换；Electron 版 `update_install` 改为
   打开当前平台下载直链（清单 `downloads[platform]`，缺省 pageUrl），不再自替换。
   前端错误分支（"去网页下载"）语义不变。
2. **单实例锁**：Electron 的 `requestSingleInstanceLock` 按 userData 目录；旧版按
   应用 id。行为等价（第二次启动唤回主窗），但 `KOVA_DATA_DIR` 沙箱实例可与真实实例并存
   （这是 e2e 需要的能力，也意味着"同目录双开"仍由用户自行避免）。
3. **数据目录共享**：默认仍指向 `com.kova.assistant`（与旧版共享 state.db/会话/密钥）。
   两壳同时运行会双写同一库（WAL + busy_timeout=5s 保不损坏，但双 sidecar 会互抢任务）——
   与旧版并存时请只开一个。
4. **screenshot 工具**：Windows 分支未接线（macOS 已完整移植）；Windows 上调用会得到
   明确错误而非错误结果。
5. **CSP**：沿用 旧桌面壳.conf 的 CSP 字符串（去掉 `ipc.localhost` 项），由 `kova://` 协议
   处理器逐响应注入；dev（localhost:3000）不注入。
6. **命令参数大小写**：保持 旧桌面壳 v2 约定（JS 侧 camelCase 对应 Rust snake_case 参数名），
   Node 处理器直接读取与前端调用点一致的名字（逐命令核对过调用点）。
7. **窗口拖拽区（JS 实现，非 CSS）**：前端以 `data-drag-region="true|deep|false"`
   标记拖拽区（旧桌面壳 专有机制）。**首版用 CSS `-webkit-app-region: drag` 是错的**——它把整块
   区域变成 Chromium"标题栏"捕捉区：整窗任意处可拖（连子元素），且吞掉滚轮（用户实测
   "滚动用不了 + 随便哪里都能拖"）。现改为 preload 内 JS 精确实现 旧桌面壳 `drag.js` 语义：
   `false` 截停 / `deep` 子树（交互元素除外）可拖 / `true` 仅元素自身；拖拽本体取窗口位置后按
   屏幕坐标增量 `setPosition`（rAF 节流），双击拖拽区切换最大化。回归验证（`e2e-drag.mjs`）：
   顶栏 DRAG、标题/按钮 NO_DRAG、正文不误拖、拖拽位移与派发一致；滚轮双向可用（0→300→150）。
8. **dev / 生产双渠道**：
   - 正式包 `Kova.app`（`release/mac-arm64/`）：`com.kova.assistant`，与旧版发布包共享数据；
   - dev 包 `Kova Dev.app`（`release-dev/mac-arm64/`，`bun --filter kova-electron-main dist:dev`）：
     `com.kova.assistant.dev` + extraMetadata `kovaChannel: dev`，运行时自动使用
     `com.kova.assistant.dev` 数据目录 —— 与 `旧桌面壳的 dev 配置` 的 identifier 完全对齐；
   - 未打包运行（`electron .`）与 `--dev` 同样归入 dev 渠道。`KOVA_DATA_DIR` 仍可显式覆盖。
9. **资源管理器窗口路由**：静态导出产物是 `out/resource.html`，子窗口须加载
   `kova://app/resource`（协议处理器按 精确→`path.html`→`path/index.html` 命中）；
   首版误写 `resource/index.html` 落到 404 页（表现为"资源管理器没加进来"）。已修，
   并补窗口 closed / render-process-gone / did-fail-load 日志便于日后定位。

## 尚未接线（Phase C/D，注册了命令但返回可诊断错误）

| 模块 | 状态 | 说明 |
|---|---|---|
| （无占位模块） | — | 全部命令已接线；剩余差异见下表「行为差异」与小节末的未验证项 |

### 桌面打包与品牌（logo/图标）

- 图标资产：原 `原 Rust 宿主/icons/*`（icon.icns / icon.ico / icon.png / 各尺寸 + tray.png）已复制到
  `apps/electron/icons/`；窗口图标（Windows/Linux）、macOS dev 的 Dock 图标、托盘图标均接线。
- 应用名：`app.setName("Kova")`（显示名与 productName 一致）；userData 仍显式钉在
  `com.kova.assistant`，数据继续与旧版共享。
- electron-builder（`apps/electron/electron-builder.yml`）：appId com.kova.assistant、
  productName Kova、files=dist/renderer-out/icons、extraResources 带 sidecar 二进制（asar 外）、
  mac icon.icns、`identity: null`（不签名，与旧版 ad-hoc 口径一致）、win NSIS / linux 配置就绪。
- 已验证：`electron-builder --mac --dir` 产出 `release/mac-arm64/Kova.app`（520MB，含 Electron 运行时
  + 87MB sidecar）；启动冒烟全绿（store/sidecar/页面），CFBundleName=Kova、
  CFBundleIdentifier=com.kova.assistant、CFBundleIconFile=icon.icns，Dock 显示扣瓦 logo。
- 打包注意：bun 不执行 postinstall——electron 二进制与 node-pty 需手动补装（`electron/install.js`、
  `npx node-gyp rebuild`；node-pty 走 N-API，Node/Electron ABI 通用）。
- 未做：dmg/nsis 安装包产物（配置就绪未构建）、代码签名/公证（与旧版同样未签）。

### Chromium 专属渲染坑（已在迁移版修掉，旧桌面壳/WKWebView 不出现）

- **shimmer × 每秒变化的文本 = 旧字形重影**：轮次耗时片（「工作中 N 秒」）用 `shimmer`
  （tw-shimmer：`background-clip:text` + `background-position` 扫光，动画提升合成层），
  在 Chromium 下文本每秒更新时合成层不完整失效，数字会留下重影/半截字形，看着"数字卡住
  不变"（第一秒无数字所以正常，任务结束去掉 shimmer 后也正常——与用户描述完全一致）。
  最终修法（`components/agent-thread/turn-summary.tsx`）：**闪光只罩不变的字**——
  与「连接中…」「正在思考中…」等同款原则：`工作中` 走 `shimmer shimmer-speed-200`
  （静态文本，扫光正常），逐秒变化的数字放在遮罩之外单独渲染。
  试过并否决的替代：「整行闪光 + 每秒 `key` 重挂载」字形也对，但扫光每秒重新起步、
  视觉跳动明显（用户实测否掉）。
  像素级复核：逐秒截元素，"工作中 2/3/4/5/6 秒" 字形清晰、逐秒变化；
  `::before` 的 `tw-shimmer-translate`（2.05s 循环）持续运行在"工作中"上。
  其余 shimmer 用法（连接中/思考中/进行中/正在压缩上下文）都是静态文本，无此问题。

### 有意放宽的一处守卫（比 Rust 版更宽容，前端契约要求）

- **文件树面板的会话级产物目录**：面板根走 `usePanelCwd` 三级解析，无工作区时落到
  `<task-workspace>/<sessionId>`（与 sidecar 的 taskSessionCwd 同源）。该目录在
  "首次写文件之前"并不存在，而 Rust 的 `resolve_root` 用 `canonicalize(cwd)` 判定，
  路径不存在即 `cwd-not-allowed`（前端注释却明确期望"任务工作区任意深度子路径读写都合法"）
  → 表现为面板里新建文件报「当前目录不受信任，操作被拒绝」。
- Electron 版修正：路径不存在时退到**最近的已存在祖先**做可信根校验（`fs-cmds.ts`
  `realpathNearestExisting`），校验通过后**返回 cwd 本身**（不是祖先，避免相对路径拼错位）。
  实测：`<task-workspace>/<不存在的 sid>` 上 touch/list/mkdir/rename/delete 全部成功；
  `/tmp`、`/etc`、`~/Desktop` 等不受信任根仍被拒（cwd-not-allowed）——安全性未被放宽。

### 中断语义（停止按钮能停到什么）

实测链路（dev 包，带日志）：界面 abort → sidecar 中止 run → 对在飞工具的 RPC 触发 signal
→ 向宿主发 `host_cancel` → 宿主 `killpg` 杀整棵进程树（时间戳同秒：abort 12:41:30.853 →
host_cancel 12:41:30.853 → tool_execution_end 12:41:30.858 → `sleep 300` 进程树清零）。
另外本版加固：`pi_abort` 时宿主**同时**按线程取消在飞的前台工具（工具信封里带 owner=线程 id，
`cancelToolsByOwner`）；`runInBackground` 的后台任务在独立表里，按设计跨回合存活、不受影响。
工具自身超时（模型可传 timeout，默认 120s）同样杀进程树（实测 timeout:6000 六秒清空）；
终端（pty）是真终端：Ctrl-C 生效（实测 `^C` 回提示符）、关闭标签 = 杀壳。

### 桌面桥 痕迹清理（用户要求"去干净"）

前端 58 个文件的 `桌面桥/*` import 已全部改指本仓自有桥，并进一步改名去品牌：

| 原 | 现 | 说明 |
|---|---|---|
| `桌面桥/{api,plugin}/x` import | `@/desktop-bridge/x` | 桥目录 `旧桌面壳-bridge/` → `desktop-bridge/`；tsconfig 别名已删除（漏网 import 会硬报错） |
| `桌面桥/api` npm 依赖 | 已删除 | 早先已不被打进包（被 paths 覆盖），现从依赖与 lock 里一并清掉 |
| `lib/旧桌面壳.ts` / `旧桌面壳-pi-client.ts` | `lib/desktop-env.ts` / `desktop-pi-client.ts` | 文件与类名（`旧桌面壳PiClient`→`DesktopPiClient`） |
| `is旧桌面壳` / `isDesktopDev` 等 | `isDesktop` / `isDesktopDev` / `safeDesktopCall` | **机制保留**（同一份静态产物也会被远程网关当网页 serve，需要区分"桌面壳 vs 网页访客"），仅改口径 |
| 环境标记 `__KOVA_DESKTOP__`/`__KOVA_DESKTOP__` | `__KOVA_DESKTOP__` | preload 注入、前端检测、桥全局类型三处同步 |
| 通道 kind `"旧桌面壳"` | `"desktop"` | pi-channel 及测试 |
| `get旧桌面壳Version()`（假兼容串） | `getRuntimeVersion()` → **真实 Electron 版本** | 关于页新增「Electron 版本」行（原来取值为死字段，从不渲染） |
| 注释/文案里的 旧桌面壳 指称 | 桌面壳 / 桌面桥 / 旧桌面壳（历史对照） | 三轮短语清理；用户可见文案（"请在 旧桌面壳 应用中打开设置"）已改为桌面应用 |

唯一保留的 `旧桌面壳` 字样是**拖拽契约属性名 `data-drag-region`**（7 个前端文件 + preload 拖拽桥）：
它是前端 markup 的既定接口，改它需要同步改前端标记；如要彻底改名，可加 `data-desktop-drag-region`
支持后逐个文件替换。

### 未验证项（诚实清单）

- `pi_tunnel_download` 的真实下载链路未跑（需拉取 GitHub Releases ~40MB）：解析/sha256 校验/
  解包/冒烟的代码路径已就位，但未实机验证。
- S3/WebDAV 真实远端连通未测（无测试端点）；SigV4 规范串与 XML 扫描按 Rust 版逐行移植，
  本地备份/恢复（信封格式）已全链路验证。
- 备份与 Rust 版的**交叉解开**未实测（本机没有 Rust 版产出的 .piabk 样本）；格式按源码逐字段对齐。

## 已验证（证据）

- `bun run build:sidecar`：sidecar 编译 + ping/pong 冒烟通过（`sidecar smoke check ok`）。
- `bun run build:renderer`：Next 静态导出 16 条路由成功。
- `bun run build:main` + `tsc --noEmit`：Electron 主进程 0 错误。
- 启动冒烟（CDP，`apps/electron/scripts/e2e-smoke.mjs`）：`kova://app/index.html` 加载、
  `__KOVA_DESKTOP__` 标记为真、invoke 往返（kv_set/kv_get）、未知命令错误串同形、
  控制台零错误、真实数据目录下侧栏/会话列表/设置渲染完整。
- 隧道监管（`apps/electron/scripts/e2e-tunnel.mjs`）：默认态 → 无网关 start 报错 →
  set_binary 非法路径报错 → 假二进制（/bin/ls）启动后立即退出 → 状态机落 error 且
  error 带 stderr 最后一行（日志尾巴 4 行）→ stop 回 stopped → 清空自定义路径回退 app-data。
- 备份/恢复（`apps/electron/scripts/e2e-backup.mjs` + 重启断言）：明文与口令加密两种本地备份
  （5 文件，17.4KB/17.6KB）→ peek_header（encrypted/device/fileCount）→ restore 落 staging
  （残行 JSONL 修剪为完整行、task-workspace 产物在内）→ 错口令 GCM 失败且 staging 清理 →
  重启后启动期换入：`pre-restore-<ts>/` 收纳旧 state.db/sessions/task-workspace + 标记转
  `.done`、staging 删除、credentials 清空、被替换库中的探针 kv 消失、换入日志先于 store 初始化。
- 远程网关（`apps/electron/scripts/e2e-remote.mjs`）：pi_remote_start 起服（6 位码）、
  HTTP 静态页 200 + CSP 头、错误配对码限次提示（attemptsLeft）、正确码配对拿 token、
  authed 透传 `list_sessions` 并**原样拿回真实会话清单**（id 往返还原生效）、
  `list_credentials` 被请求级 REMOTE_DENIED 拒绝（带原 id 与 code）、停止收尾。
- 浏览器面板生命周期（`apps/electron/scripts/e2e-browser.mjs`）：attach 建视图并加载 file:// 页，
  `browser:navigated` 依次 started→finished→title（title 阶段证明面板内 JS eval 通道可用，
  即 agent 工具的同一通路）、bounds 同步、viewport fill/fixed 往返 + 事件、同址 attach 幂等、
  detach(destroy) 收尾。agent 七工具的调用链未做端到端（需模型回合触发，沙箱账户额度为零）。
- Git 端到端（`apps/electron/scripts/e2e-git.mjs`，临时仓库）：probe/status/log/graph/branches/
  checkpoint_create 全绿；"检查点之后再改动"场景下 checkpoint diff 正确列出 M/A 文件与 patch，
  restore 后新文件被移除、改动文件回退、diff 归零。
- 聊天端到端（`apps/electron/scripts/e2e-chat.mjs`，沙箱 `KOVA_DATA_DIR`）：
  prompt → 24 批 50 行 `pi-chunk-batch`（start/thread_event/error/finish 全生命周期）→
  会话落库（侧栏出现新会话）。回复错误为用户模型账户额度不足（提供商侧），
  错误原样穿透并在 UI 呈现，链路本身无缺陷。

## 接续开发建议顺序

1. `browser.ts`：旧桌面壳 子 webview → Electron `WebContentsView`（attach/detach/syncBounds 直译），
   agent 驱动经 `executeJavaScript`；`browser:navigated/viewport` 事件名不变。
3. `remote.ts`：axum HTTP+WS → `node:http` + `ws`，静态 serve `out/`，pair/auth/REMOT E_DENIED
   协议原样；`try_route`（rem-* id 前缀）与 `broadcast_notification` 挂点已在 pi-agent.ts 预留。
4. `tunnel.ts`：cloudflared spawn + stderr 抓 URL，逻辑最直白。
5. `backup.ts`：PIABK 信封（tar.gz + AES-256-GCM/PBKDF2 + SigV4/WebDAV）——纯 Node crypto 可实现，
   注意与 Rust 版**字节级兼容**（口令派生参数、信封头字段）。
