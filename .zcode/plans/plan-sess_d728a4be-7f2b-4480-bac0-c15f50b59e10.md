## 空摘要行不消失：根因与修法

### 现象
一轮纯聊天（无思考、无工具）结束后，用户气泡下面留下一行「已工作 4 秒 ⌄」。这行本身是折叠开关，点开是空的（只有 `TurnProcess` 的空容器）。它应该在本轮结束的瞬间消失，现在要刷新页面才消失。

### 根因
`apps/desktop/components/agent-thread/turn-summary.tsx:244` 的渲染守卫：

```ts
if (!running && durationMs === undefined && !summary.hasProcess) return null;
```

条件是「三个条件同时成立才隐藏」，而耗时（`durationMs`）恰恰是这一轮**一定**有的——`TurnTimingRecorder`（同文件 286行）在轮次出现时记开始、轮次不再进行时补记结束，纯聊天轮也照记不误。于是 `hasProcess` 明明是 false（有耗时兜底），守卫仍然放行，摘要行留下一个空开关。

数据层其实已经把契约写对了：`apps/desktop/lib/panels/message-turns.ts:249` 的 `hasProcess` 注释是「没有过程时摘要行是空开关，**不占位**」，`message-turns.test.ts:281` 也已经断言「纯聊天轮 hasProcess=false，行不占位」。只是渲染层的守卫没遵守它。

纯聊天轮为什么 `hasProcess=false`：投影层（`messageProjection.ts`）把一轮压成「一条 user + 一条 assistant」，assistant 的 parts 只有 text part；`packTurnSummary` 的 `endHasProcess` 只把非 text、非 compaction 的 part 算过程，`turn.end - turn.start > 2` 也不成立（恒为 2）。

### 改动（单点，一行）
`apps/desktop/components/agent-thread/turn-summary.tsx:244`：

```diff
- if (!running && durationMs === undefined && !summary.hasProcess) return null;
+ // 运行中一律显示；已结束的轮只在「真有过程可展开」时占位——
+ // 纯聊天轮（无思考/无工具）没有可收起的内容，耗时再准也不该留一个空开关。
+ if (!running && !summary.hasProcess) return null;
```

同步把该行上方 243 行的注释改掉（现在写的是「有耗时或真有过程可收才占位」，与新条件不符）。

### 明确不动的东西
- **耗时计算全部保留**：`turn-collapse.ts` 的台账（`noteTurnStart/noteTurnEnd/restartTurnTiming`）、`computeTurnDurationMs`、`TurnTimingRecorder` 一行不改。有思考/工具的轮次照旧显示「已工作 X 分 X 秒」，刷新后也照旧（历史轮的耗时由 `pi-client-base.ts:253` 的 `seedHistoryTurnTimings` 从转录行时间戳播种，转录里的 agent 行确实带毫秒 `timestamp`，我查过 `~/Library/Application Support/com.kova.assistant/sessions/*.jsonl` 实测存在）。
- label 的兜底分支（`summary.collapsedCount > 0 ? "N 条较早消息" : "本轮过程"`）保留：亚秒级轮次（耗时被 `MIN_MEANINGFUL_DURATION_MS` 挡掉）仍走这里显示计数。
- 不动 `message-turns.ts` 的 `hasProcess` 口径，不动 `assistant-message.tsx` 的过程面/回答面拆分。

### 改完的行为
| 轮次 | 结束前 | 结束后 | 刷新后 |
|---|---|---|---|
| 纯聊天（无思考无工具） | 「工作中 X 秒」 | **整行消失**（不用刷新） | 不出现 |
| 有思考 / 有工具调用 | 「工作中 X 秒」 | 「已工作 X 秒 ⌄」，展开有内容 | 「已工作 X 秒 ⌄」仍在 |
| 被手动中断且无过程 | — | 整行消失 | 不出现 |

### 验证
1. `bun test apps/desktop/lib/panels`（message-turns / turn-collapse 单测应全绿，本次不改这两个模块的行为，纯粹确认没碰坏）。
2. 手动跑 `bun run tauri:dev`：发一条纯聊天（就复现截图里那句「啊啊啊啊」），确认本轮结束后那一行立刻消失、不用刷新；再发一条会触发思考或工具调用的请求，确认「已工作 X 秒」保留、展开能看到思考/工具行，刷新页面后这一行仍在。

### 已知相邻问题（本次不做，供你决定要不要跟）
同一类空行还有两个边角，触发条件更窄：只出图（`data-image`）和崩溃轮（`data-errorAttribution`）的 `hasProcess` 会被算成 true，但这些 part 在 `assistant-message.tsx:360` 里归「回答面」，过程面照样是空的。要一并修就得把 `message-turns.ts` 的 `endHasProcess` 与 `assistant-message.tsx` 的 answer/process 分面规则对齐（抽一个共用的 `isAnswerSidePart`），涉及两个文件和现有单测口径。要跟的话我再单独出方案。