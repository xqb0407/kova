# Prompt 排队队列设计

> 目标：消除 "Agent is already processing a prompt. Use steer() or followUp()..." 报错，
> 让上一轮未结束时到达的新 prompt 有确定、可见的行为（排队），而不是抛内部错误。
> 排队的消息对用户可见、可管理：可修改、可删除、可插队立即执行。

## 1. 背景

报错来自 `@earendil-works/pi-agent-core/dist/agent.js` 的 `Agent.prompt()`：
`activeRun` 存在期间（流式输出中，直到 `agent_end` 监听器结算完、`finishRun()` 清态为止）
任何第二次 `prompt()` 调用都会直接抛错。

现状链路上没有任何一层挡住这个场景：

- **AI SDK 7（前端）**：`Chat.makeRequest` 无忙碌守卫，流式期间再次 `sendMessage`
  会并发调用 `transport.sendMessages`（`lib/pi-transport.ts`）。
- **sidecar（`protocol.ts` dispatchPrompt）**：prompt 长任务有意不占 mgmtQueue（并发分发），
  没有 busy 检查；`isPromptActive()` 只用于 `compact` 命令。
- 于是第二条 prompt 一路走到 `run.agent.prompt(text)` 抛错，以 error chunk 显示在对话里。

## 2. 关键约束

1. **单活跃流**：sidecar 事件路由依赖全局 `currentReqId`（`stream.ts`），
   Agent 事件只发给"当前活跃请求"。本质是全局一次只能跑一个 prompt turn。
2. **每条 prompt 拥有自己的流生命周期**：前端每次 send 是独立 transport 请求（reqId），
   期待自己的 `start / start-step / finish` 序列。流若永远不 finish，前端 Chat 会永远卡在 streaming。
3. **不能用 `agent.steer()`**：steer 把消息注入活跃轮的内部队列，由**活跃请求的流**输出；
   排队请求自己的流将收不到任何 chunk、永不 finish。且用户消息会"混入"上一轮的消息流，
   UI 归属混乱。报错文案里的 steer/followUp 是 pi-agent-core 库层面的建议，不适合我们的协议。
4. **prompt 长任务不占 mgmtQueue**（现状设计）：排队机制不能把会话准备类管理命令堵死。

## 3. 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| A. sidecar 全局 FIFO 串行链 | 排队 prompt 保留自己的 reqId 流，等前一 turn 完全结束后依次执行 | **采用** |
| B. `agent.steer()` / `followUp()` | 消息注入活跃轮，排队请求流无法终结 | 否决（见约束 3） |
| C. 前端禁用发送按钮 | 只治 UI 路径，regenerate/重试路径仍会穿透 | 作为体验补充，不做兜底 |

## 4. 核心机制（方案 A）

### 4.1 数据结构

```ts
// protocol.ts
type QueuedTurn = {
  reqId: string;
  threadId: string;
  msg: Record<string, unknown>;
  aborted: boolean;       // abort/删除时置位；轮到它时不执行，直接收尾
};

let promptChain: Promise<void> = Promise.resolve(); // 全局串行链（FIFO）
const promptQueue: QueuedTurn[] = [];               // 等待中的 turn（不含活跃项）
```

### 4.2 流程

`dispatchPrompt` 重构为「入队 + 出队执行」两段：

1. **入队（立即）**：
   - 若当前无活跃 turn（`!isPromptActive()`）→ 直接沿链执行，不发排队 chunk；
   - 否则创建 `QueuedTurn`，在自己 reqId 的流上发
     `{ type: "data-queue", id: `queue-${reqId}`, data: { phase: "queued", position: n } }`
     （同 id 原地更新，参照 `data-compaction` 的生命周期模式），然后沿链挂起等待。
2. **执行（轮到时）**：
   - 先检查 `entry.aborted`：置位则发 `{ type: "abort" }` + `{ type: "finish" }` 直接收尾；
   - 发 `{ type: "data-queue", id, data: { phase: "active" } }`（若有排队 chunk）；
   - 执行现有 dispatchPrompt 主体（会话准备 → runStepWithRecovery → 委派收敛循环）；
   - finally 里 `finish` chunk + `setCurrentReqId(null)`（现状不变），链才放行下一节。

链的每一节是**可互换的工人槽**：轮到某节时取当前队首项执行（而非绑定派发顺序），
这样 `queue_promote` 重排队列后顺序依然正确；被取消的项已在取消时收尾流，
轮到时静默让位。每个 turn 完整跑完（含委派收敛循环与 finally finish）才放行下一节。
串行性由 promise chain 保证，等价于把「prompt 长任务」从并发分发改成全局串行，
mgmtQueue 管理命令不受影响。

### 4.3 报错兜底（纵深防御）

队列在协议层已消除该报错的触发条件，但仍做两层兜底：

1. **sidecar**：`run.agent.prompt(text)` 外层 catch。命中
   `"Agent is already processing"` 时（理论上只剩极窄的竞态窗口，如 abort 收尾中），
   `await run.agent.waitForIdle()` 后**原地重试一次**；再失败才发 error chunk。
   不把内部错误原文抛给用户。
2. **前端**：`lib/pi-transport.ts` 对 error chunk 做错误分类（复用 sidecar
   `agent-errors.ts` 的思路）：匹配该文案时显示友好提示
   （"上一条消息还在处理中，已自动排队"），并保留「重试」出口，绝不展示原始错误堆栈。

## 5. 排队消息管理（对话框上方）

### 5.1 UI：排队条

composer 上方渲染排队条（活跃时显示）：每条排队消息一行/一枚 chip：

```
┌────────────────────────────────────────────────┐
│ ⏳ 排队中 · 第 1 位                              │
│ ┌──────────────────────────────────────────┐   │
│ │ 帮我把 README 翻译成英文     [立即发送] [编辑] [✕] │
│ └──────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
```

- 文本截断显示，点击可展开完整内容；
- 正在执行的 turn 不进排队条（它在消息流里自然可见）。

### 5.2 操作与协议命令

新增三条 stdin 命令（走现有 `dispatch` 管理通道，key 是入队时的 reqId）：

| 命令 | 行为 | 守卫 |
|---|---|---|
| `queue_update { requestId, text }` | 修改排队项内容 | 仅 `phase=queued` 可改；已开跑返回 error |
| `queue_cancel { requestId }` | 删除单个排队项 | 置 `aborted`，其流立即 `abort`+`finish` 收尾 |
| `queue_promote { requestId }` | **立即发送**：中止当前 turn，该项提到队首 | 当前 turn 按 abort 结算（见 5.3），但队列其余项保留 |

对应前端行为：

- **编辑**：进入编辑态（就地编辑 chip 内容或跳转输入框回填）→ 确认后同时
  更新线程里的 user message（AI SDK `setMessages`）和 sidecar（`queue_update`）。
  两条写都失败则回滚并提示。
- **立即发送**：`queue_promote` → 当前 turn 被中止、排队条中该项消失、直接开跑。
  其余排队项**保持排队**（在它后面），不丢。
- **删除（✕）**：`queue_cancel`，线程里对应的 user message 也一并移除（`setMessages`）。

### 5.3 停止（Stop）语义

Stop 按钮（手动暂停）作用于「一切未完成项」（与现有 abort 命令的全局性一致）：

- 中止当前活跃 turn（现状不变）；
- **同时取消全部排队项**（跨线程）：各自的流立即 `abort` + `finish` 收尾，不执行。

决策理由：用户点 Stop 的意图是"停下一切"，排队项静默续跑会违背直觉；
abort 命令本就是全局中止所有 run，排队项保持同一语义。想保留排队项的用户
应使用单项 ✕ 删除或让它自然执行。

### 5.4 data-queue chunk 生命周期

`{ type: "data-queue", id: `queue-${reqId}`, data }`，同 id 原地更新：

- `phase: "queued", position: n` — 入队时；
- `phase: "queued", position: n-1…` — 前方项被删/执行后**位置变化时重发**（排队条序号要跟着变）；
- `phase: "active"` — turn 开跑时；
- 项被删除/中止 → 直接发 `abort` + `finish`（数据 part 随消息流终态清理）。

## 6. 语义变化

1. **挂起审批/提问的隐式关闭**：`closeProposalOnNewPrompt / clearPendingToolApprovals /
   cancelPendingQuestions` 从"prompt 到达时"移到"turn 实际开始时"。
   排队中的消息不隐式关闭上一轮挂起的卡片；审批/提问本身阻塞 turn 结束，队列自然等它结算。
2. **git 检查点时机迁移**：`lib/pi-transport.ts` 目前在 `sendMessages` 时立即
   `gitCheckpointCreate`。排队 turn 的快照会落在**上一轮编辑之前**——回滚会误伤上一轮改动。
   迁移为前端收到该请求的 `start` chunk（turn 真正开始）时创建。
   `start` 到首个模型请求之间有网络延迟，本地 git 快照足够快，竞态窗口可接受。
   `settleCheckpoint` 的 finish/error 双保险逻辑不变。

## 7. 前端配合（`lib/pi-transport.ts` + UI）

1. **拦截 `data-queue`** → per-thread store（参照 `data-todo` / `data-planningState`
   的旁路模式，不进消息流），驱动 composer 上方排队条（见 §5）。
2. **发送按钮在 streaming 状态保持可用**（排队 UX 的前提）；sidecar 兜底后双发不再出错。
3. **检查点创建迁移**（见 §6.2）。
4. **错误文案分类**（见 §4.3）。
5. regenerate（`trigger: "regenerate-message"`）同样走 transport，自然进队列，无需特判。

## 8. 场景时序

| 场景 | 行为 |
|---|---|
| 空闲时发送 | 与现状一致，直接执行 |
| 流式中发送（同线程） | 前者继续输出；后者流发 `data-queue(queued, n)`，前者 finish 后自动开跑 |
| 连发多条 | FIFO 依次执行，每条各自的完整流生命周期 |
| 编辑排队消息 | chip 进入编辑态 → `queue_update` + 线程消息同步更新；已开跑则拒绝 |
| 删除排队消息 | ✕ → `queue_cancel`，流收尾，线程消息移除 |
| 立即发送（插队） | `queue_promote` → 当前 turn 中止结算，该项队首开跑，其余排队项保留 |
| Stop（有排队项） | 该线程活跃 turn 中止；该线程排队项取消收尾（abort 带 threadId = 线程级；缺省才全局兜底） |
| Stop 后收尾窗口内发送 | 不排队：活跃 turn 已 stopRequested、正在收尾时到达的 prompt 直接沿串行链等收尾后执行（不渲染排队条，也不会被下一次 Stop 连带取消） |
| 排队超上限 | 第 6 条起拒绝：`error` + `finish` |
| 不同线程并发发送 | 各线程独立串行链并行执行，互不排队（2026-09 起，见 §11） |
| 排队中会话被 new_session 重置 | turn 开始时走现有 `resolveSession` 逻辑，行为与现状一致 |
| 报错兜底路径 | `prompt()` 仍抛 already-processing 时：sidecar waitForIdle 重试一次；前端友好文案 |

## 9. 测试要点（sidecar bun test）

1. 并发两条 prompt：断言 `start/.../finish` 序列按序、第二条含 queued→active 生命周期；
2. `queue_update` / `queue_cancel` / `queue_promote`：各自的成功路径 + 已开跑拒绝路径；
3. Stop 丢弃本线程排队项、保留其他线程排队项：断言各自流的 `abort`+`finish` 终结；
4. `queue_promote` 中止活跃 turn 后队列其余项按新顺序执行；
5. 队列上限拒绝路径；
6. 空闲首条 prompt 不产生 data-queue chunk；
7. 管理命令（set_credential 等）在长 turn 期间不被队列阻塞；
8. already-processing 竞态兜底：waitForIdle 重试成功路径。

## 10. 开放问题

- **排队提示的持久性**：前端刷新后排队状态丢失（流还在）。可接受（队列生命周期短），
  如需严谨可在状态查询命令里附带队列快照。
- **编辑态交互形态**：chip 就地编辑 vs 回填输入框（回填更贴近 ChatGPT 习惯，但要把
  "确认后从输入框移除"的交互做干净），实现时二选一。

## 11. 按线程隔离（2026-09 实现）

原设计的全局 FIFO 在多会话下语义错误：A 会话忙时 B 会话的新消息也显示「排队中」
（用户在 B 里看不到任何在回答的东西），且 Stop 是全局广播，一键停掉所有会话。
已按线程隔离：

- **事件路由**（stream.ts）：全局 `currentReqId` 改为 `activeReqByThread` 注册表
  （threadId → 活跃 reqId）；`Running` 增加 `threadId` 字段，Agent 事件、
  `sendEventChunk`（审批/提问/待办/重试卡片）都按线程路由。
  per-thread 的 runSeq/contentIds 也随之一并隔离（并行 turn 不再互相重置内容 id）。
- **队列**（prompt-queue.ts）：`threadId -> FIFO`，`turnBusy` 变为 busy 线程集合；
  位置重发、上限（每线程 5 条）、取消/插队都只作用于所属线程。
- **串行链**（protocol.ts）：全局 `promptChain` 改为 `threadId -> Promise` 的
  per-thread 链，不同线程的 turn 并行执行；链尾且队列空时摘除链条目防泄漏。
- **Stop**：`abort` 协议消息带 `threadId` 时只中止该线程（活跃 turn + 排队项）；
  缺省仍是全局兜底。前端 `PiChannel.abort(threadId)` / Rust `pi_abort(thread_id)`
  由 Chat 的 abortSignal（含本线程 chatId）传入。`queue_promote` 只中止该排队项
  所属线程的活跃 turn。
- **compact**：忙碌检查从全局改为按线程（只拒绝正在回答的那个会话）。
- **LRU 驱逐**（sessions.ts）：`noteActiveTurn` 改为线程集合，多线程并行期间
  所有在跑会话都不可驱逐。
