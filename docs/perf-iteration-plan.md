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
