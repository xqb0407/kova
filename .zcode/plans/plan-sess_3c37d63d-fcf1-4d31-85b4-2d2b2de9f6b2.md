## Sidecar 上下文维护(compaction)接入方案

### 探索结论(影响方案选型的三个事实)

1. **core 0.85.1 自带全部压缩原语**:`estimateContextTokens / shouldCompact / generateSummary / compact / DEFAULT_COMPACTION_SETTINGS / COMPACTION_SUMMARY_PREFIX+SUFFIX` 都从包根导出,`generateSummary` 直接吃 `AgentMessage[]`,不需要构造 pi 的 `Entry[]` 树。
2. **裸 `Agent` 的默认 `convertToLlm` 会把 `compactionSummary` 角色过滤丢弃**(agent.js:3-5)。PI-Desktop 用该角色是因为它同时覆盖了 convertToLlm;我们照搬必须多一个覆盖点,不如直接用 **user 角色 + 官方前缀模板** 承载摘要,语义与 core 投射完全一致且零坑。
3. 我们的 JSONL 是扁平 `seq` 消息流,而 PI-Desktop 的压缩发生在**回合边界、不保留尾部**(其 codex-shaped `completed_turn` 模式)——两者天然契合,压缩后只需「摘要消息」一条即可续跑。

因此方案是:**参考 PI-Desktop 的阈值公式、checkpoint 数据模型(generation 藏 details、轻量 Mark)和 fresh_window 兜底,落地为适配我们扁平 transcript 的精简管线**,不移植 Entry 投射和 session-context.ts。

### 改动明细

**新文件 `sidecar/pi-agent/src/context.ts`**(核心,~180 行)
- `contextBudget(messages, model)`:移植 PI-Desktop runtime.ts:4228-4263 公式 — `hardLimit = contextWindow − requestHeadroom`,headroom = `min(window−1, max(16384, model输出预算, ceil(window*0.05)))`,`modelOutputBudget = min(maxTokens, 25% window)`;窗口/输出兜底常量同抄。
- `needsCompaction(run, pendingText?)`:`estimateContextTokens(state.messages + 待发用户消息).tokens >= hardLimit` 且消息数 > 1。
- `runCompaction(run, reason: "threshold" | "overflow" | "manual", opts?)`:
  1. `generateSummary(state.messages, models, model, reserve, undefined, undefined, undefined, undefined, undefined, BACKGROUND_CONTEXT)`(摘要生成做成可注入 seam,测试用假实现);
  2. 成功 → 新 `agent.state.messages = [summaryUserMessage]`(role user、内容 = `COMPACTION_SUMMARY_PREFIX + summary + SUFFIX`);
  3. 失败且 reason=overflow → **fresh_window 兜底**:固定 rollover marker 文本顶替(对应 PI-Desktop `strategy:"fresh_window"`、`checkpointSummarized=false`),保证会话能继续;
  4. 写 checkpoint 行(generation 计数器存 `details.generation`,与 PI-Desktop `context-compaction.ts` 同设计),更新 `run` 计数与 generation。

**`transcript.ts`**
- 新增 `{"type":"compaction","seq":n,"summary","tokensBefore","throughSeq","createdAt","details"}` 行;`readTranscript` 一并返回(撕裂尾行容忍逻辑不变)。
- 新增 `appendCompactionRow()`。
- `persist()` 修正 seq 体系:消息行 seq 改用单调 `run.jsonlSeq`(现在用 state 下标 `i`,压缩后 state 变短会**撞 seq 导致 readTranscript 按 seq 去重吃掉旧行** — sessions.ts 恢复与历史重建都会错乱);压缩后 `run.persistedSeq` 重置为 1(跳过合成摘要头行,摘要本身已由 compaction 行持久化)。
- 消息行全量保留,`historyToUiMessages` 不动(历史 UI 完整)。

**`sessions.ts`**
- 恢复改为:找最后一条 compaction 行 → `restoredMessages = [摘要 user 消息, ...throughSeq 之后的消息行]`;无 checkpoint 走原路径。`persistedSeq / jsonlSeq / generation` 相应初始化。

**`types.ts`**:`Running` 增加 `jsonlSeq: number`、`compactionGeneration: number`。

**`protocol.ts`**
- `runStep()` 里 `agent.prompt(text)` **之前**做 threshold 检查,命中则先 `runCompaction`(对应 PI-Desktop 的 pre-request guard;delegation resume 循环同样覆盖)。
- **溢出恢复**:`agent.prompt` 结束后若最后一条 assistant 消息 `stopReason==="error"` 且 `isContextOverflow(errorMessage)`(pi-ai 导出)→ 强制压缩 → 用同一文本重跑一次(每段至多重跑一次,防循环)。
- 新命令 `compact`(手动触发,带 threadId,返回 `{ok, tokensBefore, generation}`),对齐现有 set_mode 的会话查找模式。

### 测试

- `context.test.ts`:阈值公式各窗口档、假摘要注入下压缩后 state 只剩摘要头、fresh_window 兜底、generation 递增。
- `transcript.test.ts` 扩展:compaction 行读写、压缩后 persist 的 jsonlSeq 单调与 seq 去重不互吃、撕裂行兼容。
- `protocol.test.ts` / 恢复路径:带 checkpoint 的 JSONL 恢复出的模型上下文 = 摘要 + 边界后消息。

### 本次不做(明确边界)

- 前端「已压缩上下文」分隔条(需 assistant-ui 自定义 data part,后续单独提);压缩发生时用户只感知为该轮略慢。
- 模型侧 `compact` 工具(PI-Desktop 的 buildContextCompactionTool)、设置 UI 开关、subagent 上下文压缩、provider-retry。

### 风险与缓解

- `generateSummary` 十参签名较脆:集中在 context.ts 一处调用并包 Result 判断,失败一律走 fresh_window 兜底,不会让会话卡死。
- 旧会话(无 compaction 行)完全走原逻辑,无迁移成本;新格式行未知类型读端本来就跳过,向前兼容 Rust 宿主(data.rs 不解析 JSONL 内容)。