# PORTING-NOTES — Rust(旧桌面壳) → Node(Electron) 差异与遗留

> 本文件记录 Electron 版与旧版的**行为差异**与**尚未接线**的能力，供接续开发
> 与发布说明使用。实现进度事实以代码与构建产物为准；分阶段计划见 `PLAN.md`。

## 已完整移植（行为对齐，契约逐条对照 Rust 源码）

| 能力 | Rust 源 | Electron 实现 | 备注 |
|---|---|---|---|
| 命令路由/事件广播 | lib.rs + panic_guard | `main/ipc.ts` + `registry.ts` | 未知命令错误串同形：`command X not found` |
| KV 存储/建表/回填 | store.rs + data.rs | `store.ts` + `data.ts` + `db.ts` | SQLite 用 `node:sqlite`（Electron 44 内建 Node 24）；`better-sqlite3` 为回退驱动 |
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
| 外观材质 | appearance.rs | `appearance.ts` | acrylic/mica → macOS vibrancy（sidebar/under-window）/ Windows backgroundMaterial；Win 主窗口不走 `transparent:true`（分层窗会同时失去 DWM 圆角/投影、backdrop 材质与 ClearType），实体窗创建由 DWM 负责圆角+阴影，材质开启时仅把背景色切透明透出 backdrop（restore 亦同步翻转） |
| 窗口/托盘/菜单 | lib.rs/menu.rs/tray.rs | `window.ts`/`menu.ts`/`tray.ts` | 首帧显示 + 5s 兜底；macOS 菜单加「资源管理器」；Windows 关窗进托盘 |
| 终端 PTY | pty.rs | `pty.ts` | node-pty；Channel 推 number[]、空数组 = 退出标记、channel 死 → 杀壳 |
| Git 集成 | git.rs | `git.ts` | CLI 包装（`-C <cwd> --no-optional-locks`）、porcelain v2 / name-status -z 解析、影子 git-dir 检查点（fnv1a 目录名/FNV-1a 与 Rust 同算法、LRU 20、同树复用、反向 patch 存档 + apply -R 还原）、`git-changed` 事件；写命令按 cwd 异步串行 |
| 面板浏览器 | browser.rs + browser_scripts.rs | `browser.ts` | **`<webview>` guest 绑定（DOM 嵌入渲染，对齐  内置浏览器；替代原生 WebContentsView——层级/圆角/遮罩回归 DOM 合成，bounds 同步与浮层遮挡让位整链退役；guest 由渲染端 did-attach 上报 id、主进程校验 getType 后驱动）**、fill/fixed 视口（CSS 尺寸即视口）、agent 七工具（navigate/snapshot/click/type/scroll/back/resize；JS 原语与 browser_scripts.rs 同源逐字）、导航重试与 busy 闸门、`browser:viewport` 事件；差异：ARIA 快照（Playwright 注入运行时）未移植，快照统一走文本快照 |
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
4. **screenshot 工具**：两端均已移植。macOS = `screencapture -x` + `sips` 阶梯；
   Windows = PowerShell `-EncodedCommand`（脚本按 UTF-16LE + Base64 传入，绕开引号转义与
   ExecutionPolicy）+ System.Drawing：先 `SetProcessDPIAware()`（不设会按逻辑像素抓半分辨率图）
   → 抓整块 VirtualScreen → 按阶梯（最大边 + 质量三档 → 1600/1280/1024）`HighQualityBicubic`
   缩放 + JPEG `EncoderParameter` 编码，全内存不落盘，命中 1.8MB 内联预算即停，取最小者，
   末行 `ConvertTo-Json -Compress` 输出 `{base64,mimeType,bytes,width,height}`（与 macOS 同形状）；
   失败走 stderr + `exit 1`。返回前做形状校验（缺 base64 早失败）。纯 macOS 环境无法实跑
   PowerShell，已做脚本渲染自检（要素齐备、括号/引号配平、UTF-16LE 往返一致、63 行 7.6KB
   在 `-EncodedCommand` 限制内）——Windows 实机截图仍待一次真机验证。
   maxDim 夹取与 Rust 对齐为 640..3840（quality 30..100）。
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
10. **权限档的落库与草稿显示**（与旧版有意不同的两处修正）：旧版新建会话不写
    `mode`/`approval_level` 两列，首轮 run 按 kv「最近一次使用」装配，而两列留 NULL
    在重建（LRU 驱逐/重启恢复）时被 `decodeApprovalLevel` 解码回 `ask`——同一条
    对话会「驱逐后突然开始弹卡」；前端草稿期也没有真值可水合，一律显示写死的
    `agent/ask` 占位，于是用户看到「变更前确认」以为改文件前会问，首轮实际按
    最近使用档跑（AI 审查/完全访问这类档设计上就不弹卡），且「点已选项」是空操作
    ——连 `set_mode` 都没发出去。现在：建会话时把生效档位当场写进偏好行
    （`resolve.ts` 的新会话分支），前端草稿默认档改读 kv `pi.mode`
    （`loadGlobalModeDefault`，非桌面/远程或 kv 不可用时仍回落占位）。

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

#### 图标规范（macOS 应用图标，`scripts/icons.py`）

Dock/Finder/Launchpad 渲染一张图标时，是把 **1024 画布**铺满用户设定的槽位，图标在画布里的
占比直接决定看上去多大。Apple 自家图标（Finder / App Store / 终端 / 计算器 / 系统设置，五者实测
一致）是：**实体方 824/1024 = 0.803**，背后两层烘焙投影（紧边层 + 宽广层）把整体占位撑到
**854/1024 = 0.834**，圆角 0.226。规范就按这组数走，不按观感逐次微调：

- 母图 `apps/electron/icons/icon-master.png`（1024 PNG，任意留白）→ `bun run icons` 生成
  `icon.icns`（10 个成员齐全）+ `icon.png / 128x128.png / 128x128@2x.png / 64x64.png / 32x32.png`；
  `bun run icons:check` 按上面三项指标校验（容差 0.005 / 圆角 0.015），不合规退出非零。
- 早期两版踩过的坑记在这里，免得重犯：**只对齐实体方、不烘焙投影**（0.803 硬边）在 Dock 里会比
  邻居小一圈——邻居的视觉体量都含投影；反过来**满画布出血**（0.988）在 Launchpad 里比 Apple 图标
  大 23%。投影层必须铺在整块 1024 画布上再模糊，只模糊裁紧的瓦片图会让投影尾巴被源图边界切掉。
- 已知差异：本仓图案沿用原始品牌图，圆角实测 0.217（比模板紧 4%）；重绘时按 0.226 画。
- 改图标资产的三处同步点：`apps/electron/icons/`（源）→ 打包时由 electron-builder 装进 bundle；
  本地已构建的 `.app` 与 `/Applications/Kova.app` 需替换 `Contents/Resources/icon.icns`
  并 `codesign --force -s -`（identity: null，ad-hoc）后 `killall Dock` 刷新图标缓存。
- Windows `icon.ico` 与本管线无关（保持原样）；托盘 `tray.png` 也不经此管线。

### Chromium 专属渲染坑（已在迁移版修掉，旧桌面壳/WKWebView 不出现）

- **shimmer × 每秒变化的文本**：扫光统一走 `.shimmer`（`background-clip:text` +
  `background-position`， 的 animated-gradient-text 同款；不再用 tw-shimmer 的
  mask-clip / `::before` 路径，Windows 上不会丢次像素抗锯齿，短标签也看得见）。
  轮次耗时片仍只让不变的「工作中」扫光，逐秒变化的数字放外面：文字宽度每帧变化
  会让 300% 背景的扫光起点跟着跳，读秒显得闪烁（`components/agent-thread/turn-summary.tsx`）。
  其余 shimmer 用法（连接中/思考中/进行中/正在压缩上下文）都是静态文本。
  这样文字宽度稳定，扫光的 300% 背景不会跟着读秒一起变宽。

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

## mobile（apps/mobile）迁移

- `apps/mobile` 整体搬入新仓（Expo 客户端，无后端；经 WS 连桌面远程网关）。共享包
  `packages/pi-protocol` 已在仓内，移入后 `bun install` + `typecheck` + `vitest`（13 文件/67 测试）全绿。
- 依赖统一：mobile 精确锁的 `assistant-cloud@0.2.3` 与 `@assistant-ui/react-native` 要的
  `^0.2.6`（解析到 0.2.7）类型不兼容（私有字段 `cloud` 声明不同），已把 mobile 的 pin 提到
  0.2.7 收敛为单版本；桌面/web 侧不受影响（本就解析 0.2.7），`apps/desktop` typecheck 保持 0 错。
- 去旧壳痕迹（与桌面同标准，全仓旧壳字样零残留）：mobile 侧恒 false 的宿主判定函数
  `is…`旧名 → `isDesktopShell()`、`PiChannel.kind` 取值旧名 → `"desktop"`（与桌面端实现类
  `DesktopPiChannel` 同名约定）、README/注释中的壳指代与旧壳 remote 源路径改为
  `apps/electron/main/remote.ts`；引用文档 `docs/remote-access.md` 一并搬入并更新该行。

## 侧车二进制的 macOS 签名坑（开发态）

**症状**：`bun run start` / `bun run dev`（未打包）启动后界面一片空白——侧栏会话列表、
资源管理器全空，渲染层报 `pi-agent request timed out`；侧车进程停在 `UE` 状态（内核态等待
+ 正在退出）、零输出、`kill -9` 无效，且每启动一次就多留一个。打包版（Kova.app /
Kova Dev.app）一切正常，数据完好（本仓只读过它，未写入）。

**根因**：`bun build --compile` 产物带的是 `flags=adhoc,linker-signed` 的签名，
`codesign --verify` 报 "code or signature have been modified"；该状态的二进制被
`cp -f` 成稳定别名（当时叫 `binaries/pi-agent`，现名 `kova-worker`）后，Apple Silicon 上内核 `exec` 会**既不运行也不报错
地卡死**（不是 SIGKILL，是挂住）。宿主于是永远等不到 `host_result`；侧车初始化闸门里几十步
`host_query` 每步各等 15s，界面自然"半天拉不出来"。

**判定证据**：同一份字节（md5 相同、大小相同）——`pi-agent-aarch64-apple-darwin` 能跑，
旧名那份卡死；把它 `cp` 成新名字能跑；`codesign --force --sign -` 后 verify 通过、稳定能跑。
打包版一直正常，是因为 `afterPack` 的深度 ad-hoc 签名把 bundle 里的二进制重签了一遍。

**修复**：`apps/sidecar/pi-agent/scripts/build-sidecar.ts` 在产出三元组文件与稳定别名后，
每次都在 darwin 上 `codesign --force --sign -` 重签（两处都签），失败即构建失败。
另：宿主侧的 `host_query` 分支加了显式日志（`KOVA_LOG_HOST_QUERY=1` 打点）与异常兜底回帧——
异常时回 `host_result{ok:false}` 而不是静默，避免侧车白等满 15s 超时。

**清理**：坏签名 exec 卡死留下的侧车进程无法 kill（`STAT=UE`，`kill -9` 只是挂起不生效——
内核态的退出/校验等待，用户态无手段），**重启机器才会清**。它们无害：每个 RSS ~32KB、
只挂着 cwd 与三个已断开的管道，不持有 DB/锁/端口，也不影响新实例启动。

**修复后的验证（2026-10-15 凌晨，macOS 24.6）**：
- 31 个尸体全部产生于修复前（23:33–23:57），修复后（约 00:20 起）几十次启停 + 强杀 **零新增**；
- 对修复后的实例：`kill -9 <Electron 主进程>` 或 `kill -TERM`，侧车都会**自行退出**（stdin EOF → 优雅关闭），
  两种方式都不留尸体。即"尸体"是坏签名专有现象，不是强杀 app 的副作用。
- 识别办法：`ps -ax -o pid,ppid,stat,command | grep binaries/kova-worker`——`UE` + `ppid=1` 是尸体；
  `SN`/`S+` 且 ppid 指向 app 主进程是活着的侧车（别杀）。

## 侧车进程改名（2026-10-15）

可执行文件与进程显示名从 `pi-agent` 改为 **`kova-worker`**（活动监视器/任务管理器里看到的就是它）：
- 构建产出 `kova-worker-<triple>` + 稳定别名 `kova-worker(.exe)`（`build-sidecar.ts`），
  构建时顺带清掉同目录旧名 `pi-agent*` 产物，避免新旧并存；
- 宿主解析名与 `PI_AGENT_BIN` → `KOVA_WORKER_BIN`（`main/pi-agent.ts`）；dev 源码模式直接把
  当前 Bun 本体作为 `KOVA_WORKER_BIN`，用 `KOVA_WORKER_ARGS`/`KOVA_WORKER_CWD` 跑
  `--watch src/index.ts`（不再生成临时 bash 包装，Windows 也能直接 spawn）；
- 侧车入口设 `process.title = "Kova Worker"` 作为显示名兜底；
- 侧车日志文件 `pi-agent.log` → `kova-worker.log`；宿主日志标签 `[pi_agent]` → `[worker]`。

**范围刻意限定在"进程/可执行名"**：`pi-agent` 作为项目名、包名（`pi-agent-sidecar`）与
`PI_*` 协议环境变量（`PI_DB_PATH`/`PI_SESSIONS_DIR`/…）、`pi_request` 等线协议消息名一律不动——
那些牵涉持久化键与前后端契约，改了会让既有数据/两端不匹配，与"显示名好看"无关。
