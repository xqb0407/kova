# Pi Runtime 迁移计划（去 AI SDK → assistant-ui react-pi 自有 store）

> 目标：用 assistant-ui 官方 `@assistant-ui/react-pi`（v0.0.25）的浏览器半替换现有
> `ai` SDK + `useAISDKRuntime` 链路，消除双份状态、逐 token 全价消化、补丁层堆积。
> 本文档是唯一执行依据，按阶段推进，每阶段有验收标准与回滚点。

## 0. 背景与结论

### 现状痛点
1. **两份状态**：sidecar JSONL transcript（真源）+ AI SDK Chat UIMessage 状态，靠 chunk 流逐 token 同步，每 chunk 全价 JSON.parse + 框架状态拷贝。
2. **补丁层堆积**：seq guard、重放合并（compactReplayChunks）、holdOnFinish、队列 gate、normalizeMessageContent、thinking_seed 信封——全在绕 AI SDK 黑盒状态机。
3. **双落盘冗余**：sidecar JSONL + 前端消息 JSONL，历史加载要 withFormat 翻译。
4. **多会话后台全价消化**：后台线程每条 chunk 仍走完整消费链。

### react-pi 官方方案的对应解法（源码已核验）
| 痛点 | react-pi 解法 |
|---|---|
| 每 chunk 全价拷贝 | 纯 reducer + 结构共享；`message_update` 带完整 partial，`replaceAt` 原地换流式尾部，无 O(text) 重积累 |
| 流式渲染成本随文本增长 | `message_update`/`tool_execution_update` 走 rAF 合帧（每帧最多一次投影重算）；历史消息 deep-equal 后保留旧引用 |
| 黑盒状态机补丁 | 自有状态 + 三通道订阅（metadata/messages/all）；乐观消息/乐观队列含竞态回滚 |
| 逐 chunk 重放恢复 | **快照权威自愈**：断线/乱序一律 `getThread` 快照兜底 + seq 水位去重；Rust 重放缓冲可退役 |
| 队列 gate | 原生 followUp/steer 二态（per-item 操作官方 no-op，需扩展） |
| withFormat 适配 | 消息形状 = pi-ai 原生 Message 镜像，sidecar JSONL 直接就是快照来源 |
| 后台全价消化 | reducer patch 极小 + 无渲染订阅者，后台成本天然趋零 |

### 关键事实
- react-pi 浏览器半**零依赖 `ai` 包**；`pi-coding-agent` 是可选 peer（仅 node 半需要，我们不用 node 半）。
- Seam = `PiClient` 接口（listThreads/createThread/getThread/sendMessage/cancelRun/clearQueue/setModel/setThinkingLevel/rename/archive/delete/respondToHostUiRequest/subscribe）。
- 事件模型：`{ threadId, seq }` 信封 + 事件体（snapshot/agent_start/agent_end/turn_*/message_start/update/end/tool_execution_*/queue_update/compaction_*/auto_retry_*/context_usage/extension_ui_*/error），未知事件类型容忍（bump seq + 后台快照刷新）。
- 快照 `PiThreadSnapshot = { metadata, messages, hostUiRequests?, readiness?, seq?, lastError? }`，`messages: PiAgentMessage[]`（pi-ai Message 镜像：user/assistant/toolResult/bashExecution/custom/branchSummary/compactionSummary + unknown 容错）。
- 供应商源码位置：`/Users/herther/Downloads/assistant-ui-main/packages/react-pi`（v0.0.25）+ 示例 `examples/with-pi`。

### 决策：vendor 源码，不引 npm 包
理由：需要扩展契约外的特性（队列 per-item 操作、文档附件、崩溃恢复占位、subagent activity、thinking_seed、三队列语义）；npm 包 0.0.x 接口可能漂移；vendor 后保持修改自主权。每个 vendored 文件头部加 provenance 注释。

## 1. 版本前置（阶段 1 内完成）

`apps/desktop/package.json` 升级（全部小版本）：
- `@assistant-ui/react` ^0.15.18 → ^0.15.22+
- `@assistant-ui/core` 0.3.17 → ^0.3.21
- `@assistant-ui/store` 0.3.14 → ^0.3.15
- `assistant-stream` 0.3.41 → ^0.3.45
- `react`/`react-dom` ^19.2.8 → ^19.3（`useEffectEvent`，usePiRuntime 依赖）
- 保持不动：`ai`、`@assistant-ui/ai-sdk`（阶段 5 才删）

## 2. 分阶段执行

### 阶段 0：提交重放冻结修复（已完成的工作收尾）
- 工作区未提交：`apps/desktop/lib/pi/pi-channel.ts`（compactReplayChunks + 重放快速前进）+ `apps/desktop/lib/pi/pi-channel-attach.test.ts`
- 动作：跑 `cd apps/desktop && bunx tsc --noEmit` + `bun test apps/desktop/lib/pi/pi-channel-attach.test.ts`，绿则提交
- 提交信息主题：重放快速前进修复主线程冻结
- 验收：工作区干净、测试绿

### 阶段 1：vendor react-pi 浏览器半 + 版本升级
**1a. 版本升级**（见 §1）+ `bun install` + 全量测试 + tsc。

**1b. vendor 文件清单**（源 → 目标 `apps/desktop/lib/pi/pi-runtime/`）：
- `src/types.ts` → `types.ts`（PiClient 契约 + pi Message 镜像 + 事件模型）
- `src/eventTypes.ts` → `eventTypes.ts`
- `src/utils.ts` → `utils.ts`
- `src/queueIds.ts` → `queueIds.ts`
- `src/runtime/threadState.ts` → `thread-state.ts`（纯 reducer：快照权威、seq 去重、乐观队列）
- `src/runtime/ThreadController.ts` → `thread-controller.ts`（rAF 合帧、三通道订阅、乐观回滚）
- `src/runtime/messageProjection.ts` → `message-projection.ts`（pi 消息 → ThreadMessageLike：assistant+toolResult 按轮合并、toolResult 按 id 配对、isPreliminary、host-UI→approval、data part）
- `src/runtime/usePiRuntime.ts` → `use-pi-runtime.ts`（external store + remote thread list + controller 注册表）
- `src/runtime/hostUi.ts` → `host-ui.ts`
- `src/runtime/piExtras.ts` → `pi-extras.ts`
- `src/runtime/runtimeTypes.ts` → `runtime-types.ts`
- `src/runtime/disposeControllers.ts` → `dispose-controllers.ts`
- `src/runtime/hooks.ts` → `hooks.ts`
- 对应测试搬移：`threadState.test.ts`、`ThreadController.test.ts`、`messageProjection.test.ts`、`hostUi.test.ts`、`disposeControllers.test.ts`、`types.test.ts`（vitest → bun test 适配；`usePiRuntime.test.tsx` 视 bun test 对 testing-library 支持度决定搬或暂缓）
- **不搬**：`src/node/**`（node 半）、`src/client/**`（HTTP/SSE 实现，我们自写 Tauri 通道）、`sdkIdentity.ts`（无 cloud）、`index.ts`（自建桶文件只导出浏览器半）

**1c. 适配要点**：
- 导入路径：`@assistant-ui/react`/`@assistant-ui/core/internal`/`@assistant-ui/store/internal` 保持（升级后 API 在）；`../types` 等相对路径改平
- `useSyncExternalStore`/`useEffectEvent` React 19.3 语义核对
- 每文件头部加 provenance：`// vendored from assistant-ui react-pi@0.0.25 (<src path>), MIT`

**验收**：vendored 单测全绿 + 全仓 `bun test` 绿 + `bunx tsc --noEmit` 干净。此阶段不接线，零运行时影响。

### 阶段 2：TauriPiClient 快照路径 + 渲染链路切换（降级订阅）
**2a. sidecar：快照构建**
- 新命令 `thread_snapshot`：从 JSONL transcript 读出 → `PiThreadSnapshot`（pi-ai 原生消息直出，含 metadata.status/queuedMessages/contextUsage/lastError）
- 快照 seq：按 thread 维护单调递增事件序号（内存水位，重启归零可接受——reducer 快照权威语义自愈）

**2b. TauriPiClient（`apps/desktop/lib/pi/pi-runtime/tauri-pi-client.ts`）**
- 复用 `pi-channel.ts` 的 request 通道（管理类 invoke）映射全部非订阅方法
- `subscribe`：阶段 2 先降级——登记 listener，不做实时事件；`getThread` 结果手动 dispatch；收尾时依赖调用方 refresh
- `includeSnapshot` 选项语义照契约实现

**2c. 渲染链路切换**
- `app-runtime-provider.tsx`：`useAISDKRuntime` 路径替换为 `usePiRuntime({ client: tauriPiClient })`（workspacePath = 当前工作区 cwd）
- 线程列表：现有 sessions（SQLite）清单桥接进 remote thread list adapter（list/rename/archive/delete/initialize）
- 历史加载改走快照；旧 withFormat 路径保留但仅服务回滚分支
- 发送/停止/队列 UI 暂按 react-pi 原生语义（followUp/steer），三语义扩展在阶段 4

**验收**：桌面端开线程、发消息、收终态（流式暂缺——收尾快照刷新落定）、历史显示正确、工具卡基本渲染（args/result 完整形状核对记录到 `docs/pi-runtime-migration-notes.md`）。回滚点：切换为独立 commit，revert 即回旧链路。

### 阶段 3：实时事件流（delta 化原生事件通道）
**3a. sidecar：原生事件转发**
- pi-agent-core `AgentSessionEvent`（message_start/update/end、tool_execution_*、turn_start/end、agent_start/end、queue_update、compaction_*、context_usage…）透传为新的 `pi-thread-event` 通道
- **delta 化**：`message_update` 只发 `{ type, contentIndex, delta }`（不发完整 partial，避免 O(n²) wire）；客户端在 PiClient.subscribe 内重建 partial 再 dispatch
- tool_execution_update 同理（partialResult 增量或整段节流，按体积分档）
- 事件信封 `{ threadId, seq }`；Rust 合帧通道复用 `pi-chunk-batch` 或新增 `pi-event-batch`（沿用 ChunkWireLine `{i, l}` 结构）

**3b. TauriPiClient.subscribe 完整实现**
- 全局 listen → 按 threadId 分流到各 controller 的 listener
- delta → partial 重建（text/thinking/toolcall 累积，参考现有 compactReplayChunks 的合并思路但语义为重建而非压缩）
- `includeSnapshot` 快照先行 + seq 对齐

**3c. 快照含流式中 partial**
- `thread_snapshot` 把 in-flight assistant 消息（AgentSession 内存 partial）并入 messages
- 崩溃恢复简化：刷新 = getThread 快照（自愈）+ 续直播；`attachStream`/`compactReplayChunks`/Rust 重放缓冲标记退役（阶段 5 物理删除）

**验收**：流式渲染正常；流式中途刷新恢复正确（含错误占位卡片约束：崩溃后空 assistant 消息显示「本回合因错误中断」占位）；多会话并发流畅度对比实测（perf-watch 前后对比记录到 migration-notes）。

### 阶段 4：特性补齐（队列三语义 / 审批 / 旁路 / UI 接线）
**4a. 队列三语义**（扩展 PiClient + threadState.queue；硬性约束逐条对照）：
1. 引导式对话 = Alt+点击 / Shift+⌘+Enter（并入当前轮，不停止 agent）→ steer
2. 默认队列 = 前一轮结束后自动开始新轮 → followUp
3. 立即发送 = ⚡按钮（停止前一轮并进入新轮）→ cancel + send
- 扩展 per-item 操作：合并到当前响应 / 立即发送 / 编辑（检索到输入框）/ 删除（官方契约 no-op，我们实现真操作）
- 队列栏 UI（「N 条排队」卡片列表 + 暂停/恢复开关）从 state.queue 读取
- 队列消息调度前不得作为气泡显示（queue 与 transcript 分离，react-pi 原生满足）
- 刷新后队列自动恢复：快照 queuedMessages 对齐、残留清理、盲轮重挂
- 队列条目 id = 真实 reqId（沿用 queue-v2 修复）

**4b. 审批/交互卡**
- sidecar 审批流映射为 `extension_ui_request`（confirm/select/input/editor）或保留现有工具卡审批（二选一，倾向后者：host-UI 契约按需桥接）
- tool-call 的 approval 投影已有现成支持（approvalForRequest）

**4c. 旁路改接**
- subagent activity：subscribeSubagentActivity 保留（独立通知通道），UI 数据源改 piExtras
- thinking_seed：并入 reducer 扩展字段或 data part
- 运行指示：`metadata.status` + agent_start/end 替代 subscribeTurns（侧边栏 spinner 语义不变）
- 占用环：`context_usage` 事件 + `context_changed` 双轨（桌面占用环镜像直更保留）
- agent-events / automation / plugin-op / design-theme 等管理类订阅不动（与聊天状态无关）

**4d. 工具卡逐一核对**
- 每个 UI 工具组件核对 args（pi toolCall.arguments）与 result（toolResult content/details）形状；差异在 projection 层适配，不改 UI 数据契约
- 终端命令卡约束全套保留：非交互式状态指示器（spinner/红点）、线程运行态 + 结果存在性判定、刷新后状态持久化、缓存指纹

**验收**：队列全部操作可用且三语义不变；审批流可用；侧边栏/占用环/子代理面板正常；全量测试 + tsc 绿。

### 阶段 5：清理退役 + 远程通道
**5a. 依赖删除**：`ai`、`@assistant-ui/ai-sdk`、`assistant-stream`（如仅剩 legacy 引用）、`@assistant-ui/react-o11y`（如仅 AI SDK 路由用）
**5b. 代码删除**：
- `pi-transport.ts` postTransform / createPiThreadListAdapter（AI SDK transport）
- `pi-seq-guard.ts`、`normalizeMessageContent`、holdOnFinish、`pi-thread-adapter.ts` withFormat 历史适配
- `pi-channel.ts` 的 promptStream/attachStream/compactReplayChunks（保留管理类 request 通道）
- Rust `buffer_run_line` RUNS 重放缓冲、`pi_attach` 命令
- `pi-steer-intent.ts`、`pi-queue.ts` 旧实现（已被 state.queue 替代部分）
**5c. WS 通道**：远程网关按 PiClient 契约实现（事件流转发走 remote.rs 白名单 + 快照命令），`pi-ws-channel.ts` 重写为 WsPiClient
**5d. 文档**：更新 AGENTS.md 相关约束、project_memory 硬性约束条目清理（重放缓冲相关条目标记退役）

**验收**：全仓测试绿、tsc 干净、`next build` + tauri 打包实测（重点回归：CSP style-src 修复不被回退、多会话并发、崩溃恢复、远程连接）。

## 3. 风险登记

| 风险 | 缓解 |
|---|---|
| react-pi 事件形状 verified against pi 0.78–0.80，我们是 pi-agent-core 0.99.2 | 阶段 2 逐一核对 AgentSessionEvent/Message 形状；差异在 vendor 层适配；types.test 迁移保障 |
| react 19.3 / useEffectEvent 兼容 | 阶段 1 先升 react 单独验证 |
| 投影每帧全量重算（O(历史) deepEqual） | rAF 合帧 + 结构共享已可接受；超长会话实测后再做增量投影优化（只重投影尾部，可 upstream） |
| 队列/恢复语义回归（几十条踩坑约束） | 阶段 4 逐条对照本计划与 project_memory 硬性约束；2070 项测试为安全网 |
| vendor 源码与 npm 上游漂移 | provenance 头注释记录版本；后续按需 cherry-pick 上游修复 |
| 工具卡数据形状差异 | 阶段 2 建立核对清单（migration-notes），差异收敛在 projection 层 |
| 阶段 2 降级期（无实时流式）体验差 | 阶段 2 与 3 连续执行，不发布中间版本 |

## 4. 执行顺序与提交策略
每阶段 ≥1 个独立 commit（阶段 1a/1b 可分开），全程保持可构建可测试；阶段 2 切换点单独 commit 便于 revert。每个阶段完成后提醒用户实测对应场景。
