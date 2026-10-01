# react-pi 迁移核对笔记

> 阶段 2 建立的工具卡/消息形状核对清单。每条记录「react-pi 投影层产出的形状 →
> 现有 UI 消费的形状」，差异收敛在 projection/client 层，不改 UI 数据契约。

## 阶段 2（快照路径 + 降级轮询）

### 已接通
- **线程身份**：threadId = pi sessionId（metadata.id）。usePiRuntime controller、
  sidecar prompt/abort 的 running 键、ResumeRunningThread 回切目标全部同键。
- **发送**：`controller.sendMessage` → `TauriPiClient.sendMessage` → `pi_prompt`
  （threadId=sessionId、sessionId 定靶、cwd=工作区胶囊）。steer/followUp 二态：
  `streamingBehavior:"steer"` → `steer:true`；followUp → 普通 prompt（忙时 sidecar 自动排队）。
- **终态落定（降级）**：chunk-batch 收尾帧观察（finish/error/start 前缀预筛，
  只解析在飞 requestId 的行）+ 运行期 1.2s 快照轮询（指纹去重：seq|status|条数|末条 ts|审批数）。
  pending（发送后等起跑）有 90s 安全上限。
- **审批**：转录 pending_interaction(permission) 行 → thread_snapshot 里映射为
  confirm 型 hostUiRequest（id=approvalId，toolCallId 锚定）→ 投影层挂到工具卡。
  `respondToHostUiRequest` → `tool_confirm`。question 类不映射（阶段 4b）。
- **列表**：list_sessions + list_running 合并；status=running 直接来自 activeTurns。

### 已知差异 / 暂缺（阶段 3/4 处理）
| 项 | 现状 | 去向 |
|---|---|---|
| 流式渲染 | 无（轮询快照按消息行增量落定） | 阶段 3 delta 化事件流 |
| 文档附件 | `buildPiSendInput` 只透出 text+image，file part 被丢弃 | 阶段 4 扩展 vendored ThreadController |
| 队列栏 | state.queue 仅乐观镜像；快照不带 queuedMessages；clearQueue 为 no-op 占位 | 阶段 4a（queue_cancel/promote/steer 接线） |
| thinking_seed / subagent 旁路 | 未接（data-* 通道只在旧链路） | 阶段 4c |
| thinkingLevel 会话定靶 | `set_thinking` 全局广播（sidecar 无会话形参） | 阶段 4 |
| 压缩分隔线 | 投影 compactionSummary → 独立 DataMessagePart（与旧 data-compaction 渲染器名不同），分隔线样式可能回退为默认 | 阶段 4d 逐一核对 |
| 图片/检查点 data-* part | 快照路径不重建（旧路径 get_history 重建 data-image/data-compaction） | 阶段 3/4 |
| seq 水位 | thread_snapshot 用 peekEventSeq 现读；从未盖章过的会话不带 seq（冷读） | 阶段 3 事件盖章后自然对齐 |
| running 键混跑 | 旧链路发起的轮以本地 threadId 为键，新链路 abort/steer 找不到它（仅迁移期并存时出现） | 阶段 5 删旧链路后消失 |

### 形状核对（pi-agent-core 0.99.2 vs react-pi verified 0.78–0.80）
- 消息：转录 agent 行直出。pi-ai 0.99.2 Message 各 role 均带 `timestamp`（types.d.ts
  L365-497），与镜像一致；user/assistant/toolResult/bashExecution/custom 逐字段对上。
- compactionSummary：转录无此 role 的消息行——由 thread_snapshot 从 compaction
  检查点行重建（summary/tokensBefore/timestamp），语义与上游 branchSummary 家族对齐。
- 内容块：toolCall `{type,id,name,arguments}`、image `{type,data,mimeType}`、
  thinking `{type,thinking}`——0.99.2 与镜像同形（落盘前 normalizeBlock 已保证必备字段）。
- 未知 role/事件：镜像 union 开放 + reducer default 分支 bump seq 后台刷新，天然容忍。

## 阶段 3（delta 化原生事件流 + 快照自愈）

### 已接通
- **thread_event 帧（3a）**：sidecar `wireSessionEvents(run)` 订阅全部 AgentEvent
  翻译为 `{type:"thread_event", sessionId, eventSeq, event}` NDJSON 帧（不带 `id`，
  避免被 Rust stdout 泵误做请求-响应配对）；`is_flush_line` 对其返回 false，
  走 pi-chunk-batch 合帧批处理。remote.rs broadcast 白名单不含 thread_event
  （远程通道阶段 5c 再接）。
- **delta 化（O(n²) wire 治理）**：message_update 剥离 `partial` 重负字段只发
  assistantMessageEvent；toolcall_start 附加抽取的 `{id,name}`；done/error 为
  每流一帧终态带完整 message；tool_execution_update 整段限频
  （250ms/toolCallId + 256KB 硬丢弃，end 恒发）。
- **客户端重建（3b）**：TauriPiClient per-thread StreamAcc（message + toolcall
  参数 JSON 缓冲），按 contentIndex 就地补丁重建 partial 再 dispatch
  （reducer 只消费完整 message；vendored 层不读 assistantMessageEvent）。
- **快照权威自愈（3c）**：thread_snapshot 并入在飞 partial（peekPartial 台账，
  message_start 置/message_update 更/message_end 与 agent_end 清）；dispatch
  快照时 running 且末条 assistant → 以快照 partial 为重建基底（线程中途打开），
  陈旧快照（seq 落后）不回退基底。
- **轮询退役**：阶段 2 的 1.2s 快照轮询删除；保留收尾帧观察（inflight
  requestId→sessionId，finish/error 即时 refreshNow）兜底 prompt 起跑前失败；
  新增 pi-exit 监听清重建台账 + 逐订阅线程拉快照（空闲态自愈）。
- **旁路事件接入**：compaction_start/end（context.ts 五出口）、queue_update
  （prompt-queue，steering[]+followUp id 列表）、context_usage（prompt-pipeline，
  tokens/window/percent）、session_info_changed（改名）。

### 设计权衡记录
- seq 共用 per-session 号段（event-seq.ts，与 context_changed/queue_state 同段），
  缺口合法、**不做缺口检测**——快照权威兜底已覆盖丢失场景。
- tool_update 整段节流而非增量：节流窗内只保留最新整段，end 帧权威收口。
- 不合成 dangling-user 占位：优雅退出（kill_on_exit）已把 partial 落盘转录，
  重开线程由快照自愈；「本回合因错误中断」占位由投影层 assistant-message.tsx
  对 stopReason=error 的消息原生处理。
- message_start 仅 assistant 消息触发（agent.js 核验），accumulator 生命周期
  不会误伤 user/toolResult 行。

### 已知差异 / 暂缺（阶段 4/5 处理）
| 项 | 现状 | 去向 |
|---|---|---|
| 文档附件 | `buildPiSendInput` 只透出 text+image，file part 被丢弃 | 阶段 4 扩展 vendored ThreadController |
| 队列栏 | queue_update 事件已发但客户端未消费；clearQueue 仍为 no-op 占位 | 阶段 4a（queue_cancel/promote/steer 接线） |
| thinking_seed / subagent 旁路 | thread_event 通道未承载（data-* 通道只在旧链路） | 阶段 4c |
| thinkingLevel 会话定靶 | `set_thinking` 全局广播（sidecar 无会话形参） | 阶段 4 |
| 压缩分隔线 | compaction_end 事件已发，投影层未消费 | 阶段 4d 逐一核对 |
| 图片/检查点 data-* part | 快照路径不重建（旧路径 get_history 重建 data-image/data-compaction） | 阶段 4 |
| running 键混跑 | 旧链路发起的轮以本地 threadId 为键，新链路 abort/steer 找不到它（仅迁移期并存时出现） | 阶段 5 删旧链路后消失 |

## 阶段 4a（队列三语义 + 逐项操作 + 刷新恢复）

### 已接通
- **队列条目化**：queue_update 载荷与快照 queuedMessages 升级为
  `PiQueueEntry { id, content }`（id = 真实 reqId），sidecar 与 vendored 层同形状；
  快照指纹加排队维度（条数 + 首条 id），刷新恢复采纳的队列能触发派发。
- **sidecar**：`queue_clear` 命令（整队清空，返回被清文本供 composer 回填）；
  thread_snapshot 带 queuedMessages（重启/刷新后 reducer 重建 state.queue）。
- **vendored 契约**：PiClient 可选 `queueCancel/queuePromote/queueSteer/queuePop`；
  controller（客户端不支持时抛错）→ extras → `usePiQueue()` 透出。队列适配器：
  move 无锚点进 steer 车道 = 立即发送（映射 queue_promote）、edit = 删旧项重发、
  remove = queue_cancel。
- **UI 数据源**：队列栏与发送按钮换 `state.queue`（queue_update 事件驱动）；
  「已并入当前回复」徽标改前端本地记账（pi-steer-intent：steer 成功登记文本、
  isRunning 下降沿清空；队列栏并入与 composer Alt+点击 / Shift+⌘+Enter 运行中
  steer 发送三条路径都记账；快照/重启丢失可接受）。
- **steer 意图桥接**：composer 只有模块级标记（runConfig 不透传）→
  TauriPiClient.sendMessage 消费 pi-steer-intent 标记升级为 steer（显式
  streamingBehavior 优先）。
- **订阅保活**：队列非空时保持 connect——空闲断开后串行链自派发的下一轮
  agent_start 对前端不可见，保活让链节派发原生可见。
- **接力泵收敛**：只兜 sidecar 重启后无链节的孤儿队列（挂载/队列变化/运行
  下降沿探测，queue_pop 由 sidecar isTurnBusy + hasPromptChain 双保险守卫，
  链节在时绝不误弹）；旧 remove/reveal 消息数组信号同步退役（排队消息不进
  消息列表，react-pi 原生满足「调度前不显示气泡」）。
- **停止语义**：abort = abortRun + cancelAllEntries（停止即整线程停止，连队列
  一起清）；上游 onCancel 不再前置 clearQueue。
- **乐观条目**：发送瞬间 id 未知（reqId 在 client 内生成）→ `pending-{ts}-{seq}`
  占位，下一条 queue_update 自愈替换；逐项操作不做乐观改写（并入时活跃轮恰好
  收尾等失败需要条目原位保留）。

### 设计权衡记录
- queue_update 只广播给活跃 sid（emitQueueState 带 sid）；空快照在最后一项
  派发/取消时同样广播，前端队列条自然清空。
- 泵重发走 composer 正常发送路径（setText + send），线程空闲即刻派发；
  pop 与重发之间的窗口由 sidecar 守卫兜住（忙/有链节返回 null）。

## 阶段 4c（旁路改接：运行指示 / 占用环 / 委派绑定）

### 已接通
- **运行指示**：pi-running 起止增量源换 thread_event（agent_start/agent_end），
  替代 pi-channel 的 turn_changed 订阅（subscribeRunningDeltas 退役）。自持
  pi-chunk-batch 监听 + 双前缀预筛，listRunning（管理通道）种子水合保留，
  pi-exit 清空重播种；`resyncPiRunning`/`hydrateRunningRegistrations` 等既有
  兜底路径不动。
- **委派绑定**：TauriPiClient 事件预筛放行 `data-subagentDelegation`，解析后
  直接喂 `applyDelegationChunk`（subagent-runs 绑定 toolCallId→delegationId），
  不经 thread_event reducer（Task 工具结果文本兜底 parseDelegationIdFromResult
  保留）。
- **占用环双轨**（同点双源，sidecar pushContextChanged 无改动）：
  - context_changed 帧（含 threshold/cacheHitRatio）继续驱动 §7 推送镜像；
    pi-context `threadForSession` 加直通兜底——react-pi 新链路
    threadId = sessionId，registry 未绑定时直用 sessionId 作镜像键（此前
    未绑定的帧整帧丢弃，新链路会丢所有推送）。
  - context_usage thread_event → vendored reducer `state.contextUsage`；
    context-button 环数据源加第三层兜底（§7 镜像 → 拉取读数 → liveUsage）。
- **thinking_seed 确认无需迁移**：本仓库只有 lookup_thinking_seed（模型设置
  RPC，管理通道），与 vendored 的 thinking_seed 事件旁路无关。

### 设计权衡记录
- 运行态监听不能挂 TauriPiClient.ensureEventWatcher：它按「有订阅/在飞请求」
  早退，空闲期侧边栏的起止增量会断流 → pi-running 自持 listen（与 pi-channel
  的旁路监听同款模式，Rust 端无条件 emit 不受 JS 侧生命周期影响）。
- 双前缀预筛（thread_event + agent_start/agent_end）不会被正文误匹配：JSON
  字符串里的同名词带转义引号（`\"agent_start\"`），精确子串不命中。
- agent_start/end 是 agent 真跑口径（turn_changed 是 prompt 接受口径）；链节
  派发间隙毫秒级，spinner 闪断可接受。
- 4c 无 sidecar 改动：pushContextChanged 双发与 sendEventChunk 委派帧均为
  既有行为，本阶段只是前端接上。

## 阶段 4b（审批/交互卡）

### 已接通
- **决策**：保留现有工具卡审批（计划倾向项）——审批/提问 UI 数据源与结算出口
  仍是 pi-interactions（tool_confirm/question_answer 原线形），host-UI 契约
  （快照 hostUiRequests/respondToHostUiRequest）按需桥接、暂不启用。
- **TauriPiClient 拦截**：事件预筛放行 `data-toolApproval` / `data-question` /
  `data-interactionResolved`，按线上 sessionId 喂 pi-interactions 台账
  （applyToolApprovalChunk / applyQuestionChunk / removeResolvedInteraction），
  与卡片组件的 mainThreadId（新链路 = sessionId）同一键空间。
- **agent_end 兜底清空**：turn 收尾清该线程残留审批/提问卡（abort/异常出口；
  正常结算由 resolved 帧先行移除，此处通常空操作）。
- **刷新恢复**：subscribe 初帧后 `list_pending` 权威拉取（applyHistoryPending
  幂等并入）。**必须带 sessionId 定址**——新链路 threadId 即 sessionId，而
  sidecar threadSessions 的键是建会话时的随机 threadId，按 threadId 反查落空；
  用并入而非整表替换，防拉空时清掉直播流刚送的卡。
- **结算寻址核对**：tool_confirm 走 resolveSession(threadId=sessionId)（running
  键本就是 sessionId + findRunBySession 反查兜底）；question_answer/MCP 审批按
  id 全局定址，threadId 无关。

## 验证记录
- `bunx tsc --noEmit`（apps/desktop 与 sidecar）干净
- vendored 85 测试 + 全仓 929 测试绿
- 待用户实测：开线程 / 发消息收终态 / 历史显示 / 工具卡基本渲染 / 停止按钮 / 审批卡

### 阶段 3 验证（2026-10-01，commit 88790c0）
- `bunx tsc --noEmit` 两端干净；`cargo check` 通过（pi_agent.rs 合帧改动）
- pi-runtime 90 项测试绿（新增 tauri-pi-client.test.ts 5 项：快照基底+delta 续接 /
  message_start 起基+text/thinking 累积 / toolcall 参数缓冲+权威替换 / done 终态
  替换 / 未知会话静默+收尾帧兜底）
- 全仓 929 项测试绿
- 待用户实测（perf 对比）：多会话并发流式流畅度（阶段 2 轮询 vs 阶段 3 事件流，
  后台线程不再全价消化 chunk）；流式中途刷新恢复；崩溃后重开线程自愈

### 阶段 4a 验证（2026-10-01）
- `bunx tsc --noEmit` 两端干净；pi-runtime 90 项测试绿（threadState.test.ts
  queue_update 用例升级为条目形状）；全仓 929 项测试绿
- 待用户实测：忙时发送自动排队 / 并入（队列栏 Merge 与 Alt+点击、Shift+⌘+Enter）/
  立即发送（Zap）/ 删除 / 删除最近排队（发送按钮 ■）/ 刷新后队列恢复与孤儿队列
  接力 / 停止生成连队列一起清

### 阶段 4c 验证（2026-10-01）
- `bunx tsc --noEmit` 两端干净；pi-runtime 90 项测试绿；全仓 929 项测试绿
- 待用户实测：多会话并发时侧边栏运行 spinner 起止及时（空闲期也不断流）/
  占用环轮收尾直更 + 切线程后仍有读数（liveUsage 兜底）/ subagent 委派卡片
  正常展开（Task 工具卡活动链路）

### 阶段 4b 验证（2026-10-01）
- `bunx tsc --noEmit` 两端干净；pi-runtime 92 项测试绿（tauri-pi-client.test.ts
  新增 2 项：审批/提问 chunk 进卡且不进消息流 / resolved 关单卡 + agent_end 清空
  残留）；全仓 931 项测试绿
- 待用户实测：变更前确认审批卡放行/拦截 / plan 模式执行确认 / Question 提问卡
  作答、跳过、关闭并停止 / 审批或提问挂起时刷新，卡片恢复 / sidecar 重启后
  陈旧卡结算（按取消/拒绝落行解禁）
- **4d 待办补记**：其余旁路 chunk 已于 4d-1 改接（见阶段 4d 章节）。

## 阶段 4d（其余旁路 chunk + 工具卡形状核对）

### 4d-1 已接通（其余旁路 chunk 改接事件拦截）
- **预筛扩展**：`looksInteraction` 重命名为 `looksBypass`，新增 5 个精确枚举：
  `data-planningState` / `data-askNeedsWork` / `data-todo` / `data-panelOpen` /
  `data-pluginOpen`。沿用「正文转义引号不命中精确子串」的预筛安全性（每条
  token 级行仍 JSON.parse 一次，但 `\"data-todo\"` 类正文不含 `"data-` 裸前缀）。
- **store 类拦截**（有 sessionId，按会话隔离）：applyPlanningChunk（模式选择器
  快照）/ applyAskNeedsWorkChunk（切档提议 chip）/ applyTodoChunk（任务清单），
  与 pi-transport tap 同款形状校验。
- **面板唤起类**（线程无关）：data-panelOpen → browser/file 分流
  focusPanelTab（file 带 cwd/path，focus 不透传）+ `agent-panel:open`；
  data-pluginOpen → focusPluginPanel + `plugin-panel:refresh` + `agent-panel:open`。
- **agent_end 收尾**：追加 refreshFileTree（对齐旧链路 finish 副作用）。
- **测试**：store 类 chunk 写用例（planningState 进 store 不进消息流）；
  panelOpen/pluginOpen 因 handler 含 window.dispatchEvent 无 window 环境，不写
  bun 测试（与 pi-transport 旧链路同待遇）。

### 4d-2 已核对（工具卡 args/result 形状逐一核对）
- **四张 AGENT_TOOL_UI 卡 + ToolFallback 数据契约全满足**：BashToolUI /
  TaskToolUI / SkillToolUI / GenerateImageToolUI 与 ToolFallback 的数据需求
  全部是 `toolCallId / args / result / status / isError`，vendored 投影层
  （messageProjection.ts）已按此供给。
- **resultText / strArg 是 function 声明**（tool-row.aui.tsx），非独立数据源。
- **details 无人消费**：buildToolResultMap 收集 details 但 part 构造丢弃，
  现网无任何工具卡读取 details → 丢弃无害，不补。
- **status 走 AUI 自动推导**：AUI part 类型无显式 status 字段，
  toMessagePartStatus 按 `result === undefined || isPreliminary ||
  hasPendingToolAction` 推导（继承 message.status 或 COMPLETE），与旧链路
  观感一致。
- **TaskToolUI running 取自 subagent store**（非 status 字段），4c 已接。

### 4d 已知缺口（记录不阻塞，后续迭代）
1. ~~**新链路缺图**~~ **已修复（方案 A，2026-10-01）**：vendored 投影层
   （messageProjection.ts）复制 sidecar 闸门语义（image-parts.ts：2MiB 内联
   上限、mime 白名单 + image/jpg 归一、id=`img-${toolCallId}-${index}`、
   alt=文本块首行≤120 字符、超限/白名单外/空数据降级占位行），把 toolResult
   image 块投为 data part（name "image"）紧跟 tool-call part——快照与流式
   （partialResult）同构，UI 图廊 group-images 按 toolCallId 认亲渲染，刷新
   恢复后图片不再丢。附带把结果文本拼装对齐 sidecar（非文本块贡献空段按
   "\n" join + 占位行追加，与旧链路工具行文案逐字一致）；modelContent file
   parts 路径移除（无消费者）。data 一律按裸 base64 拼 src（sidecar 同款，
   测试钉住同构防止单侧特判 data URL）。
2. **检查点卡未接**：createCheckpoint/settleCheckpoint 链路在 thread_event
   通道无对应事件，检查点指示条不更新（数据仍走 checkpoint API，功能可用）。
3. **agent.turn.completed 完成提醒未接**：旧链路的完成通知 side effect 在
   新链路无人触发。
4. **压缩分隔线 data part 名不匹配**：投影产 `"pi-compaction-summary"`，
   UI 注册名是 `"compaction"`（compaction-banner.tsx CompactionDataUI）→
   分隔线回退默认样式。改名即可对齐。

### 附：迁移暴露的「刷新回切乱窜」修复（2026-10-01，7e153ac）
react-pi 新链路发送不写 piResumableStorage 登记（旧 transport 专属机制），
上一 webview 生命周期的存量条目（localStorage 影子镜像跨重启存活）无人清理，
ResumeRunningThread 的 inFlightTarget 被劫持到无关会话——在 A 会话发消息，
刷新后落到 B。修复：hydrateRunningRegistrations 开头清空全部存量登记，再按
sidecar 运行态真相（listRunningTurns）重建；三级回切的 running/in-flight 层
从此只认运行态事实，last-thread 层兜住其余场景。
