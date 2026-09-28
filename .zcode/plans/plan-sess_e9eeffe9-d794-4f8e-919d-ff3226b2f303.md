# 修复：作答/审批后刷新，挂起卡被重放复活

## 根因（已定位）
结算（`settleInteraction`）只落转录行 + 命令应答，**chunk 流里没有"已结算"事件**；刷新时对活跃 run 的 `pi_attach` 整轮重放 `data-question` / `data-toolApproval`，前端 `applyQuestionChunk` 无幂等结算概念，把已答卡重新加回，直到本轮 finish 才被兜底清空。`get_history.pending`/`list_pending`（扫描配对）语义均正确，无需动。

## 方案：结算时补发通用 resolved chunk（单一收口，四类挂起卡全治）

### 1. sidecar `src/sessions/pending-interactions.ts`
- `LedgerEntry` 增记 `threadId`（`beginInteraction` 入参现成；`restoreUnsettled` 已有 threadId 形参）。
- `settleInteraction()` 命中台账、落行之后：`sendEventChunk(threadId, { type: "data-interactionResolved", data: { interactionId, resolution } }, entry.sessionId)`。无活跃请求时 sendEventChunk 本就静默丢弃（重启后点陈旧卡等场景零影响）；落行在前、发 chunk 在后（崩溃窗口偏向可恢复一侧）。
- import `../protocol/stream`（无环：stream 不依赖本模块）。
- 文档同步：`protocol/protocol.ts` chunk 说明处加一行 `data-interactionResolved`；本文件头注"四件事"补第⑤（结算广播）。

### 2. 前端 `lib/pi/pi-interactions.ts`
- 新增 `removeResolvedInteraction(threadId, interactionId)`：从 approvals（按 approvalId）与 questions（按 questionId）两本台账移除 + notify；id 不存在时 no-op。不发事件、不动 settlingLocally（这是权威已结算事实，快照替换路径本就扫不到已结算项）。
- 测试缝注释更新。

### 3. 前端 `lib/pi/pi-transport.ts`
- transform 管线加分支（与 `data-toolApproval` 并列）：`chunk.type === "data-interactionResolved"` → `removeResolvedInteraction(chatId, data.interactionId)` 后 `return`（吞掉，不进消息 parts）。重挂复用同一管线（`pi-transport.ts:303` 注释），直播/重放天然同治。
- 薄再导出层 `pi-question`/`pi-tool-approval` 补 re-export（保持既有导入风格）。

### 4. 测试
- sidecar `test/sessions/pending-interactions.test.ts`：活跃请求下 begin+settle → 捕获 stdout 出现 `data-interactionResolved` 行（含 interactionId/resolution）；无活跃请求 settle 不抛。
- sidecar `test/protocol/protocol.test.ts`：question 全流程用例补断言——question_answer 后 chunk 流出现 resolved 帧。
- 前端 `lib/pi/pi-interactions.test.ts`：applyQuestionChunk → removeResolvedInteraction 移除；审批同款；未知 id no-op；重放序列（begin→resolved）收敛为空。
- 回归跑：sidecar tsc+`bun test`、desktop tsc+`bun test`。

### 5. 手测链
提问→作答→（agent 长跑中）刷新：卡不再弹；审批→批准→刷新：卡不再弹；未答时刷新：卡照常恢复（原设计不动）。

## 边界与不做的
- 已错弹的历史无数据修复需求（行为只在刷新瞬间）。
- 不动 Rust 重放缓冲与 scan 配对（它们是对的）。
- 不在前端按 `tool-Question` output part 推断关闭——只治 question 一类，且重放里 tool 输出行的呈现形状易变，chunk 收口更稳。