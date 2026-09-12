# 性能迭代计划（内存 / 卡顿）

> 回滚基线：git tag `perf-baseline`（6082623，性能优化前的完整功能快照）。
> 原则：**每次迭代只动一层、独立提交、合入前跑完回归清单**；任何一步失败
> 都可以单独 revert 而不影响其他步骤。顺序按"收益 / 风险比"从大到小排。

## 问题索引（详见性能分析）

| # | 问题 | 症状 | 位置 |
|---|------|------|------|
| P1 | `usePanelActivity` 每 token × 4 处全量扫描 + LCS diff | 流式输出越打越卡 | `lib/panel-activity.ts:245` |
| P2 | sidecar `running` Map 永不驱逐；`context_info` 也钉会话 | sidecar 内存单调增长 | `sessions.ts:31`, `protocol.ts:660` |
| P3 | token 级三连跳：stdout 行 → Rust 逐行 parse+emit → JS 逐事件再 parse；每事件一行 stderr 落盘 | IPC/日志开销、打字延迟 | `pi_agent.rs:72-131`, `pi-channel.ts:90`, `stream.ts:55` |
| P4 | `list_sessions` 每次全量读所有 JSONL 数行数；`get_history` 同文件读两遍 | 启动/切线程尖峰 | `protocol.ts:613,646`, `transcript.ts:36,60` |
| P5 | 消息 DOM 无虚拟化 + runtime 保留所有打开过的线程全量消息 | webview 内存常驻增长 | `thread.tsx:112`, assistant-ui remote-thread-state |
| P6 | 首屏 bundle 静态拉入未用到的模块图（SettingsPage→CodeMirror/language-data/cmdk 等；AgentPanel 启动即挂载） | 启动解析慢 + 常驻代码/数据偏大 | `base.tsx:19-20` |
| P7 | Rust 宿主：SQLite 无 WAL（每次索引写都 fsync）、日志逐行裸写、stdout 每行二次 parse、WS 出站无界队列、检查点每 turn ~6 个 git 子进程 | 磁盘 IO 尖峰 / 远程模式内存风险 / turn 延迟 | `store.rs:17`, `logging.rs:73`, `remote.rs:71,61`, `git.rs:909` |

## 迭代 0：度量基线（先于一切优化）

没有度量就无法证明"变快了"和"没改坏"。

- 脚本 `scripts/perf-sample.mjs`（或 bun）：每 2s 采样 pi-agent sidecar 与
  Tauri 主进程 RSS（`ps -o rss=`按进程名），写 CSV。
- webview 内存：应用内 debug 面板读 `performance.measureUserAgentSpecificMemory()`
  与 `document.getElementsByTagName('*').length`（DOM 节点数是 P5 的直接指标）。
- 录制固定回归场景（见附录），在 dev build 下用 DevTools Performance 记录
  流式输出 30s 的主线程长任务数量与最长任务时长。
- 产出：`docs/perf-baseline.md`，记录三组数字：
  ① 开 5 个大会话后切换一轮的 sidecar RSS；② 长会话流式输出时每 10s
  主线程忙碌占比；③ 冷启动到会话列表可见的耗时。

**验收**：脚本可一键复测；后续每个迭代都要重跑并对比。

## 迭代 1：前端流式渲染热路径（P1）——纯前端，风险最低

改动：
- `panel-activity.ts`：`usePanelActivity` 改为**模块级单例 store**——
  订阅 messages，仅在消息数组**引用变化时增量合并**（记住每条消息的
  已扫 part 数；只有最后一条 assistant 消息会被追加/变更，历史消息直接走缓存）。
  `diffLines` 结果按 `toolCallId` 缓存，工具进入终态（有 result）才算 diff，
  流式中间态只算 running 计数。header / tab-registry / activity-view
  四个消费方共享同一份派生结果。
- `thread-preview-rail.tsx`：`updateActiveItem` 的全量 `getBoundingClientRect`
  改为仅在滚动时执行（流式 characterData 变化只触发 syncItems 不触发 active 计算）；
  MutationObserver 回调内不再每帧全量 querySelectorAll（复用 anchors 缓存，
  childList 变化才重查）。

不改：任何渲染结构、UI 行为、数据形状（`PanelActivity` 类型保持不变）。

回归重点：右侧面板 terminal/files 内容与改造前逐条一致（含进行中/失败态、
±行数、活动角标 runningCount）。验收：流式 30s 长任务数显著下降，
`collect` 单次耗时 < 1ms；P1 消除即达标。

## 迭代 1b：组件按需加载 / 分块（P6）——纯前端，可与迭代 1 并行

定位先说清楚：应用是**单路由**（只有 `app/page.tsx`），Next 的路由级自动
分割在这里没有收益，全靠组件级 `next/dynamic`。分块解决的是**启动耗时和
常驻代码基**（首帧 parse/evaluate 的 JS、未打开就不该存在的编辑器实例），
对流式卡顿（P1/P3）无直接作用——别指望它治"打字卡"。three / recharts /
@pierre/diffs 已是动态导入，无需再动。

改动（按收益排序）：
- `base.tsx:20` 的 `SettingsPage` 改 `next/dynamic`（ssr:false）：挂载本就是
  `view === "settings"` 条件渲染，只需把静态 import 换掉，即可把 CodeMirror
  + `@codemirror/language-data`（语言文法包）、cmdk、input-otp、qrcode.react
  整个模块图挪出首屏 chunk。行为零改动，风险最低的一条。
- `base.tsx` 宽屏列里的 `AgentPanel` 改"首次展开才挂载、之后保持挂载"
  （collapsedSize=0 时当前也在渲染整棵面板树，含 material-file-icons、
  git 视图、terminal 列表）；注意与迭代 1 的 panel-activity 单例 store
  配合——store 在面板外，卸载面板不丢数据。
- 核查项（不一定改）：`@streamdown/code`/`mermaid` 的 Shiki 文法与 mermaid
  本体是否只在首个代码块/图出现时才加载——用 `next build` 产物 + 开发面板
  Network 验证；若已懒加载则关闭此项。
  **核查结论（迭代1b）**：❌ 非懒加载。`@streamdown/code` 静态
  `import {bundledLanguages, createHighlighter} from 'shiki'`（全量语言文法），
  `@streamdown/mermaid` 静态 `import mermaid from 'mermaid'`；两者经
  `markdown-text.tsx → assistant-message → thread` 挂在 entry chunk。
  拆法需要动态 import 插件构造 + 处理代码块高亮就绪前的闪烁，属组件内部
  数据流改动，超出本迭代"不改组件内部逻辑"边界 → 立为**迭代 1c 专项**。
- 顺手项：`SPLASH_MIN_MS = 3000`（`app-runtime-provider.tsx:19`）是硬性
  最短启动屏，分块收益会被它完全掩盖——迭代完成后降到 800ms 左右重新
  评估观感。

不改：组件内部逻辑与数据流。

回归重点：设置页/右面板**首次**打开的过渡态（dynamic 加载期间的占位，
不应白屏或闪烁）；重开设置不丢滚动位置以外的既有行为不变；窄屏浮层
模式的面板开合动画正常。
验收：首屏 entry chunk 的 gzip 体积与 evaluate 耗时对比迭代 0 基线下降；
未进设置页时 performance 面板里无 codemirror chunk 加载记录。

## 迭代 2：sidecar 会话驻留治理（P2）——sidecar 内部，恢复路径已存在

改动：
- `sessions.ts`：`running` 改为 LRU + 上限（如 8 个）：每次访问 touch；
  超过上限时从最旧开始驱逐，**正在跑 prompt 或有未 settle 委派（delegations
  里有 running）的会话跳过**。驱逐 = `running.delete` + 释放 agent；
  重新点开时走现有 `resolveSession` 恢复路径（JSONL 是事实源，行为不变）。
- `protocol.ts` `context_info`：不再 `resolveSession`，改为只读路径——
  已 running 的会话现算；未加载的会话直接从 `readTranscript`+`readCompaction`
  投影计算（不建 Agent、不写 running）。
- 驱逐时顺手清 `todo`/`question`/`approval` 等 sidecar 侧 per-session 状态中
  可重建的部分（保留纯 UI 通知类的不动）。

不改：协议、前端、持久化格式。

回归重点：切走再切回会话 → 历史完整、能继续对话、seq 连续（JSONL 行号
不能错乱，恢复路径有现成测试面）；归档/压缩/检查点行为不变；连续点开
10 个会话的 context 面板后 sidecar RSS 不再阶梯上涨。
验收：开 N 个大会话往返切换，RSS 稳定在上限会话数 × 单会话大小 + 基线。

## 迭代 3：IPC 批帧与日志降级（P3）——跨进程协议加一层，行为等价

改动：
- `pi_agent.rs`：Stdout 行不再逐行 `emit("pi-chunk", line)`；改为 16–32ms
  合帧窗口，攒够批量 `emit("pi-chunk-batch", Vec<String>)`（窗口内高吞吐时
  立即 flush，保证 `finish`/`error` 行零延迟透传）。Rust 侧的类型检查
  parse 改为字符串前缀嗅探（`{"id"` 定位 msg_type 只在必要时 parse），
  host_query/host_result 路径不变。
- `pi-channel.ts`（Tauri 通道）：监听 batch 事件，逐条分发到现有
  per-requestId 过滤逻辑；`WsPiChannel`（远程模式）不动，两条通道对
  transport 层的形状保持一致。
- `stream.ts`：`message_update` 级事件日志删除或收敛为每 run 一条摘要；
  `logErr` 增加 `PI_LOG_LEVEL` 环境变量开关（默认生产只看非 delta 事件）。

不改：sidecar NDJSON 协议本身（合帧只发生在 Rust→webview 这一段）。

回归重点：流式输出无乱序、无丢帧（批内顺序保证）；停止/abort 即时响应；
远程 WS 模式不受影响；断线重连行为不变。
验收：webview 每秒事件数从 token 级降到 ≤ 60/s；pi-agent.log 行数减少 ≥ 90%。

## 迭代 3b：Tauri Rust 宿主（P7）——与迭代 3 同期做，同一批文件

改动（按收益排序）：
- **SQLite WAL（`store.rs:17`，收益最大的一条）**：`Connection::open` 后加
  `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000;`。当前
  src-tauri 全库零 PRAGMA，生产连接跑在默认回滚日志 + 每条写 fsync 上——
  持久化路径每条消息都要 `sessionTouch` 写 updated_at，等于流式期间持续
  fsync 尖峰。sidecar 的 local 测试模式（hostdb.ts）早就开了 WAL，唯独
  生产 Rust 连接没开，属于遗漏而非设计。
- **日志落盘缓冲（`logging.rs:73`）**：`SourceFile` 的 `File` 套 `BufWriter`
  （256KB 窗口 + 定期/退出时 flush），消灭逐行 write syscall。迭代 3 的
  sidecar 日志降级后行会变少，但 web.log 转发路径仍需要这里兜底。
- **stdout 热路径去二次 parse（`remote.rs:71` + `pi_agent.rs:72`）**：
  pi_agent 循环对每行 `serde_json::from_str` 看 type 后，`try_route` 命中判断
  又对同一行完整 parse 第二遍。改为解析结果沿调用链传递；且远程网关未运行时
  （常态）用原子 bool 短路，整段 parse 直接跳过。与迭代 3 的合帧改造同文件，
  一次做完。
- **WS 出站有界队列（`remote.rs:61`）**：`mpsc::UnboundedSender` 改为有界
  （如 2048 条 / 4MB 字节上限），队列满时断开该客户端（远程端重连即可恢复）——
  否则远端弱网 + 桌面端长流式输出 = 出站缓冲无限增长，是远程模式专属的内存炸弹。
- **检查点快照减负（`git.rs:909 snapshot_impl`）**：每 turn `add -A` +
  `write-tree` + `for-each-ref`(parent) + `commit-tree` + `update-ref` +
  `for-each-ref`(prune) ≈ 6 次 git 子进程。优化：① 合并两次 for-each-ref 为
  一次遍历；② `write-tree` 结果与 parent tree 相同（本轮无文件改动，日常
  对话占大头）时跳过 commit 链直接复用上一 hash；③ 首次快照大仓的
  `add -A` 全量 stat 属固有成本，用 SHADOW_EXCLUDES 覆盖常见垃圾目录即可，
  不再深挖 fsmonitor。
- 确认项（不一定改）：`kv_get`/`kv_set` 等同步 command 的执行线程是否会卡
  事件循环（Tauri v2 同步命令不在 async worker 上）；若观测到设置页保存
  掉帧再转 async。git 工具执行已是 spawn_blocking、bash 输出已有
  MAX_TOOL_OUTPUT 上限（16KB），这两处不动。

不改：对外 command 签名与 NDJSON 协议（3b 全部是宿主内部行为）。

回归重点：断电/杀进程后 state.db 完好（WAL 模式换文件后缀检查）；
检查点 keep/revert 在无改动 turn 上复用旧 hash 后 UI 展示正常；远程模式
弱网模拟（限速 200ms RTT + 大输出 turn）下断连→重连→会话继续可用；
日志文件轮转与跨天切换不受缓冲影响。
验收：流式 turn 期间 fsync 次数（fs_usage 抽样）从每消息级降到批级；
远程模式 RSS 在弱网长输出下有界；检查点无改动 turn 的 git 子进程数 ≤ 3。

## 迭代 4：数据层全量扫描消除（P4）

改动：
- `sessions` 表加 `message_count` 列：`persist`（transcript.ts）追加消息行时
  顺手经 host RPC `+1`；`delete/压缩` 不需要精确（计数只做列表展示）；
  迁移时一次性回填（启动后台任务，扫旧会话补列）。`list_sessions` 不再读文件。
- `transcript.ts`：`readTranscript` 与 `readAllCompactions` 合并为单次
  `readLines` 扫描（一次读文件，按 type 分流）。
- `get_history` 响应行体积大：先保持一行协议不变（迭代 3 的合帧已覆盖
  主要开销）；若测量后仍是切线程尖峰，再考虑分页协议（新迭代，不在本期）。

回归重点：老会话升级后列表 messageCount 正确；`hostdb.test.ts`/
`protocol.test.ts` 增加计数迁移用例；列表过滤（messageCount>0 的可见性
逻辑）不因迁移窗口出错。
验收：100 个会话目录冷启动 `list_sessions` < 100ms；切线程只读一次文件。

## 迭代 5：长会话渲染窗口化（P5）——大改造，最后做，可开关

改动（两阶段）：
- 5a 低成本：消息渲染窗口——视口外 assistant 消息把重型 part（markdown
  正文、工具输出 `<pre>`）替换为等高占位块（IntersectionObserver 进出
  换回）。不动 runtime 数据，只动渲染。
- 5b 可选：历史分页协议（`get_history` 带 `tail/limit`），只加载最近
  K 轮 + 上滚加载更多；assistant-ui 侧用 history adapter 的分段加载能力。
- 前端线程缓存上限：RemoteThreadList 已加载线程超过 N 个时 dispose 最旧
  非活动线程（若框架不暴露 dispose，则记录为框架限制，5b 的分页已兜底
  内存大头）。

回归重点：滚动位置/锚点跳转（preview rail）、turnAnchor、复制/导出、
编辑重发、压缩分隔线位置在窗口化后仍正确。
验收：2000 条消息会话 DOM 节点数恒定（±窗口大小），滚动帧率 ≥ 50fps。

### 5a 尝试记录：已实现后回滚（0ce9ab0 + 02ff1bb → revert 4fd7c96/4e6d1df）

MessageWindow（IO 带 ±2500px 进出换挂载、等高占位、还原滚动补偿）合入后
实测与该应用的滚动机制冲突，回归三连：
1. 流式滚动抖动：占位高 ≠ 回挂载高（思考块 defaultOpen={running} 重挂翻转
   历史收起态；RO 异步缓存值在流式收尾/收起动画未沉淀时过期）。
2. 发送后顶部大空白：turnAnchor 平滑滚动动画途中消息跨带卸载/回挂载，
   布局与动画目标错位。
3. 「回到底部」失效：补偿对 scrollTop 的同步赋值会打断容器的
   scroll-smooth 动画，多消息补偿互相级联，视图停在非底部位置，
   差值≈占位/实际高度差之和。
结论：**JS 卸载式窗口化与该应用的 turnAnchor + scroll-smooth + 贴底跟随
不兼容**，勿再走同路线。P5 剩余可行方向：
- 5b 历史分页（数据层少加载，根本不产生占位/高度游戏）——首选；
- 或 CSS `content-visibility: auto` + `contain-intrinsic-size`（浏览器原生
  离屏跳过渲染、自动记忆尺寸，DOM 不卸载 ⇒ 无状态翻转/无补偿；省渲染
  不省 DOM 内存）。
线程缓存上限维持原结论：框架无公开 per-thread dispose（仅
__internal_dispose 整核），记为框架限制。

## 附录 A：每迭代必跑的回归清单

自动：`cd sidecar/pi-agent && bun test`；`bun run build`（Next 构建过类型）；
`cargo test`（src-tauri）。手动场景清单（dev 客户端）：

1. 新会话发长 prompt → 流式输出中途点停止 → 再发一条（排队 + 检查点）
2. 触发多工具 turn（bash + edit）→ 右侧面板 terminal/files 与消息内工具卡一致
3. 切到另一历史会话再切回 → 历史完整、可续聊
4. 打开上下文面板 → 触发一次手动压缩 → 分隔线与摘要展示
5. Question 卡片 + 工具审批各走一遍
6. 检查点条的 keep / revert 各走一遍
7. 归档 → 归档列表 → 取消归档
8. 设置页：个性化 / 用量统计（2D/3D）/ 快捷键
9. 重启应用 → 所有会话可恢复
10.（迭代 3 额外）远程 WS 模式连一次

## 附录 B：度量脚本约定

- 所有采样输出写 `perf-samples/<date>-<iteration>.csv`，不进 git。
- 每个迭代完成时在迭代 commit message 里附三行对比数字（RSS / 长任务 / 启动）。
