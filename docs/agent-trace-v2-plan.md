# Agent 链路追踪 v2 —— 专业化演进方案（评审稿）

> 本文是 [agent-trace-plan.md](./agent-trace-plan.md)（v1，已落地）的**演进方案**，
> 不修改 v1 的实现约束（零 IO 采集、本地 JSONL 事实源、手写 OTLP、不引 OTel SDK）。
> 目标：把现有「调用元数据记录器」升级为**可跨系统对齐的分布式调用链**。
>
> 注意：本文的 **P0/P1/P2 是优先级档位**，与 v1 文档里的 P1/P2/P3（实施阶段）
> 不是同一套编号，阅读时勿混。
>
> 状态：**评审稿，尚未实施**。确认后再排期。

---

## 0. 结论与范围

### 0.1 现状定性

采集纪律是专业的（同步零 IO、`settle()` 单点落盘、撕裂行容错、5MB 护栏、
OTLP 失败不反压）。但**缺链路追踪的内核**：

- 没有稳定的 span 身份 → 本地视图与导出记录无法按 span 对齐；
- 没有跨 run 因果边 → 子代理 run 是孤儿；
- span 语义贫瘠 → 工具错误不可见、无 TTFT、GenAI 约定缺项；
- 状态语义三处漂移 → `aborted` 被当成 `error` 上报。

### 0.2 v2 目标

1. **可对齐**：任取一个 span，本地 JSONL、面板、OTLP 后端里是同一个 id。
2. **可关联**：父 run 与子代理 run 之间有明确的父子边。
3. **可诊断**：一次失败的调用，能从 trace 里读出失败原因与阶段耗时。
4. **合规**：OTel GenAI 语义约定 + span 生命周期（exception / status）到位。

### 0.3 明确不做（等价于 v1「不要顺手做的事」延续）

- 不引 OpenTelemetry SDK / protobuf 运行时；OTLP 继续手写。
- 不改 transcript JSONL 行格式与 seq 语义。
- 不在 token 级路径落盘或发包（v2 对 `message_update` 只做 O(1) 首次时间戳捕获，
  见 §3.2）。
- 不改采集/导出的失败策略（继续丢弃 + 节流日志，绝不反压）。

---

## 1. 问题清单（按严重度）

| # | 问题 | 证据 | 影响 | 档位 |
|---|---|---|---|---|
| 1 | span 无稳定 id，三处各造：落盘无 id、面板 DFS 序号、OTLP `sha256(path)` | [trace.ts#L28-44](../apps/sidecar/pi-agent/src/protocol/trace.ts#L28-L44)、[trace-adapter.ts#L68](../apps/desktop/lib/pi/trace-adapter.ts#L68)、[otlp-exporter.ts#L193-195](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L193-L195) | 面板点中的 span 在 Langfuse 对不上 | **P0** |
| 2 | OTLP span id 由字符串路径哈希派生，`#index` 依赖遍历顺序 | [flattenSpans#L106-121](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L106-L121) | 重导出可能漂移；用拼串当身份 | **P0** |
| 3 | `TraceRunRecord` 无 `parentRunId`，子代理 run 与父 run 无因果边 | [trace.ts#L47-59](../apps/sidecar/pi-agent/src/protocol/trace.ts#L47-L59)、[subagent/run.ts#L85](../apps/sidecar/pi-agent/src/subagent/run.ts#L85) | trace 图变成漂浮森林 | **P0** |
| 4 | `traceId` 是 `sha256(runId)` 再哈希，非直接身份 | [otlp-exporter.ts#L193](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L193) | 多余且易误导 | **P0** |
| 5 | 工具 span 只落 status，无 errorMessage / 结果 / 类别 | [trace.ts#L374-380](../apps/sidecar/pi-agent/src/protocol/trace.ts#L374-L380) | 工具失败在 trace 里是黑洞 | P1 |
| 6 | 无 TTFT / 无流式阶段；`message_update` 被丢弃 | [trace.ts#L394-396](../apps/sidecar/pi-agent/src/protocol/trace.ts#L394-L396) | 缺 LLM 头号时延指标 | P1 |
| 7 | 时钟混用：llm_call 用 provider `message.timestamp`，其余 `Date.now()` | [trace.ts#L288](../apps/sidecar/pi-agent/src/protocol/trace.ts#L288) | 负耗时 / 虚高 | P1 |
| 8 | `aborted` 语义三漂移：强制收尾记 `error`、面板 `skipped`、OTLP `ERROR` | [stream.ts#L128](../apps/sidecar/pi-agent/src/protocol/stream.ts#L128)、[trace-adapter.ts#L14](../apps/desktop/lib/pi/trace-adapter.ts#L14)、[otlp-exporter.ts#L186](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L186) | 用户取消污染错误率 | P1 |
| 9 | GenAI 约定缺 `gen_ai.operation.name` / 请求参数 / `gen_ai.response.id` | [spanToOtlp#L140-168](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L140-L168) | Langfuse generation 面板空 | P1 |
| 10 | 错误只用字符串 attr，无 OTel `exception` span event | [spanToOtlp#L161-162](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L161-L162) | 栈/类型丢失 | P1 |
| 11 | resource 仅 `service.name` | [otlp-exporter.ts#L270-272](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L270-L272) | 无版本/环境/会话维度 | P1 |
| 12 | desktop `PiTrace*` 手抄 sidecar 形状，未进 `pi-protocol` | [pi-bridge.ts#L214-241](../apps/desktop/lib/pi/pi-bridge.ts#L214-L241) | 类型漂移 | P2 |
| 13 | 5MB 护栏直接截到末尾 1MB，无轮转归档 | [trimTraceFile#L455-463](../apps/sidecar/pi-agent/src/protocol/trace.ts#L455-L463) | 长会话早期 run 永久丢失 | P2 |
| 14 | 导出内存队列，退出即丢，无重试 / 本地 spool | [otlp-exporter.ts#L1-9](../apps/sidecar/pi-agent/src/observability/otlp-exporter.ts#L1-L9) | 网络抖动即丢批 | P2 |
| 15 | 无 live run，面板看不到在飞链 | [trace.ts#L433-448](../apps/sidecar/pi-agent/src/protocol/trace.ts#L433-L448) | 长任务盲区，崩溃丢在飞 | P2 |
| 16 | 本地 JSONL 始终存全文 prompt/response；`redactContent` 只管 OTLP | [trace.ts#L38-43](../apps/sidecar/pi-agent/src/protocol/trace.ts#L38-L43)、[trace.ts#L65-69](../apps/sidecar/pi-agent/src/protocol/trace.ts#L65-L69) | 「脱敏」开关误导 | P2 |

---

## 2. v2 数据契约

### 2.1 Span / Run 类型（sidecar 单源）

```ts
type TraceStatus = "ok" | "error" | "aborted";

type TraceSpan = {
  /** 新增：创建时生成的 16hex spanId，落盘持久。所有下游（面板/OTLP）从它取 id */
  spanId: string;
  /** 新增：父 spanId（根 span = traceId 或 null）；用于本地上游对齐 */
  parentSpanId?: string;
  kind: "turn" | "llm_call" | "tool_call" | "retry";
  name?: string;
  /** 新增：统一时钟——一律 Date.now()，provider 时间戳降级为 attrs.pi.provider_ts */
  startMs: number;
  endMs: number;
  status: TraceStatus;
  /** 新增（llm_call）：首个 token 到达相对 startMs 的毫秒数 */
  ttftMs?: number;
  /** 新增（tool_call）：工具类别，供筛选/分组 */
  toolCategory?: "builtin" | "mcp" | "subagent" | "image";
  attrs?: Record<string, string | number | boolean>;
  children?: TraceSpan[];
  detail?: { request?: string; response?: string };
};

type TraceRunRecord = {
  /** 新增：真·根 span 身份。traceId 直接用它（不再二次哈希）。32hex */
  traceId: string;
  /** 保留兼容：等于 traceId（v1 字段名） */
  runId: string;
  /** 新增：父 run 的 traceId（subagent 委派时回填父 run） */
  parentRunId?: string;
  /** 新增：触发本 run 的父 span（父 run 里那次 Task tool_call 的 spanId） */
  parentSpanId?: string;
  sessionId: string;
  source: "ui" | "automation" | "subagent";
  startMs: number;
  endMs: number;
  status: TraceStatus;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  spans: TraceSpan[];
};
```

要点：

- **`spanId` 持久化**是 v2 的地基。面板与 OTLP 都从 `span.spanId` 读，删除
  `trace-adapter.ts` 的 DFS 序号与 `otlp-exporter.ts` 的 path 哈希两套派生逻辑。
- `spanId` / `traceId` 用 `crypto.randomBytes`（8B / 16B → hex）生成，
  符合 OTel「SHOULD be random」。放弃 v1 的 `sha256(sessionId:counter:Date.now())`
  派生——它可预测且非规范。可复现性由 `runId`+`sessionId`+`startMs` 组合仍能追溯到。
- `parentSpanId` 在 span 级冗余存一份（不靠树形隐式表达），使**扁平消费方**
  （OTLP、任何第三方读 JSONL 的工具）无需重建树即可拿到因果。
- `runId` 保留为 `traceId` 别名，保证 v1 读取端/导出文件不破。

### 2.2 状态语义统一表（消除问题 #8）

| 场景 | 触发点 | v1 | v2 |
|---|---|---|---|
| 正常完成 | `agent_end` | ok | ok |
| 模型返回错误 | `stopReason==="error"` | error | error |
| 用户 Stop 打断 | 强制收尾 | **error** | **aborted**（按停止请求意图判定） |
| 新 run 顶替残留 | `agent_start` 前置 | error | aborted（若期间收到 stop 请求，否则 error） |

落地口径：

- `settle(forcedStatus)` 的调用方（[stream.ts](../apps/sidecar/pi-agent/src/protocol/stream.ts)/[subagent/run.ts](../apps/sidecar/pi-agent/src/subagent/run.ts)）**改为传入真实意图**，
  而不是一律 `"error"`。停止请求路径传 `"aborted"`。
- OTLP 端 `aborted` 不映射 ERROR；映射为 status OK + attr `pi.aborted=true`
  （OTel 无 aborted 概念，用属性表达，避免污染错误率）。
- 面板继续 `aborted → skipped`（该映射本来就是对的，保留）。

---

## 3. 分档实施

### 3.1 P0：身份模型（地基，必做先行）

**改点：**

1. `trace.ts`
   - `OpenRun` 增 `traceId`（`randomBytes(16)`），`runId` 赋值同值。
   - 每个 span 创建点（turn / llm_call / tool_call / retry）生成
     `spanId = randomBytes(8).toString("hex")`；`childrenOf` 补隐式 turn 时也生成。
   - `TraceRunRecord` 落 `traceId` + `parentRunId` + `parentSpanId`（后两者由
     recorder 构造参数注入，见 3 项）。
   - `createTraceRunRecorder(sessionId, source, parent?)` 增第三参
     `{ parentRunId?: string; parentSpanId?: string }`。
2. 子代理接线 **（已核实，无需注册表）**
   - 三条链路恰好咬合：`Running`（[types.ts#L165](../apps/sidecar/pi-agent/src/types.ts#L165)）
     已带 `trace?: TraceRunRecorder`；`buildSubagentTools(run, ...)`
     （[resolve.ts#L91](../apps/sidecar/pi-agent/src/sessions/resolve.ts#L91)）拿到的
     就是同一个 `run`；Task 的 `execute(toolCallId, params)`
     （[tools.ts#L136](../apps/sidecar/pi-agent/src/subagent/tools.ts#L136)）
     同时握有 `run` 与父 `toolCallId`。
   - 时序也成立：`tool_execution_start` 在工具 `execute()` 之前就 emit 且被 await
     （[agent-loop.js#L415](../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L415)），
     所以父 recorder 里该 `toolCallId` 的 `tool_call` span 已建好、`spanId` 可查。
   - 落法：父 recorder 增一个 `toolCallId → spanId` 映射（`openTools` 已有该 map，
     只需暴露查询），新增 `spanIdForToolCall(id): string | undefined` 与只读
     `traceId`；Task 工具处 `new SubagentRun({ ..., parentTrace: { runId:
     run.trace?.traceId, spanId: run.trace?.spanIdForToolCall(toolCallId) } })`。
3. `trace-adapter.ts`：`walk` 改用 `span.spanId` 作为 `SpanData.id`、
   `span.parentSpanId ?? rootId` 作为 `parentSpanId`；删除 `seq`。
   根 span id 用 `run.traceId`。
4. `otlp-exporter.ts`：`TraceSpan` 扁平化不再拼 path；`spanToOtlp` 用
   `span.spanId` / `span.parentSpanId`；`traceId = record.traceId`。
   `flattenSpans` 仅负责遍历，路径字段删除。

**兼容：**

- 新字段全部**可选读**。读取端遇到 v1 旧记录（无 `spanId`）回退到旧派生逻辑
  （面板 DFS、OTLP path 哈希）——封装成一个 `resolveSpanId(span, fallback)`，
  使旧文件仍可渲染/导出。
- 写入端一律 v2 形状。`runId` 保留，旧消费方零改动。

**验收：**

- 新增单测：同一 run 的 `buildOtlpSpans(record)` 产出的 `spanId` 集合与
  `traceRunToSpanData(run)` 的 `SpanData.id` 集合**一致**（这是 v2 的核心断言）。
- 子代理委派场景：断言子 run 记录的 `parentRunId/parentSpanId` 指向父 run 里
  那条 Task `tool_call` 的 spanId。
- 回归：v1 旧 JSONL 样本仍能渲染（走 fallback 路径）。

### 3.2 P1：语义补齐

1. **工具 span 信息补齐**（问题 #5）
   - `tool_execution_end` 增记 `errorMessage`（`event` 上的错误字段，按实际
     `AgentEvent` 形状取）+ 结果摘要（截断 200，复用 `clip`）。
   - `toolCategory`：按工具名/来源判定（内置 / MCP / 子代理委派 / 图像生成）。
     判定表集中一处，勿散落。
2. **TTFT**（问题 #6）
   - `OpenRun` 给 `openLlm` 加 `firstTokenMs`。在 `message_update`（role=assistant）
     分支加**首帧短路**：`if (r.openLlm && r.openLlm.ttftMs === undefined)`
     记 `ttftMs = Date.now() - r.openLlm.startMs`。此后该分支仍忽略（O(1)，不逐 token）。
   - 这**放宽了 v1「不碰 message_update」的约束**，但只在首帧写一个数字，
     不落盘、不发事件；评审时请确认可接受。
3. **时钟统一**（问题 #7）
   - `llm_call.startMs` 改 `Date.now()`；provider 时间戳移入
     `attrs["pi.provider_ts"]`。`noteRequest` 与 `message_start` 的相对时序不变。
4. **GenAI 约定补齐**（问题 #9）+ **exception 事件**（问题 #10）
   - llm_call 增 `gen_ai.operation.name="chat"`；请求参数
     `gen_ai.request.temperature/max_tokens/top_p`（从 `noteRequest` 的 context
     里取，取不到则省略）。
   - error span 增 OTLP `events: [{ name:"exception", attributes:{exception.type,
     exception.message} }]`；`error.type` 保留。
   - `gen_ai.response.id`：若 `AgentEvent` 的 message 带 response id 则透传。
5. **resource 属性**（问题 #11）
   - `service.name` 保留，增 `service.version`（sidecar 版本）、
     `deployment.environment`（dev/prod）、`session.id`（run 的 sessionId）。

### 3.3 P2：工程卫生

1. **类型单源**（问题 #12）：`PiTrace*` 迁入 `packages/pi-protocol`，
   sidecar 与 desktop 共用；`args` 截断阈值提为共享常量。
2. **护栏轮转**（问题 #13）：`trimTraceFile` 改为——超阈值时把文件改名归档为
   `traces/<sessionId>.1.jsonl`（保留 N 份）而非直接截断；读取端按文件序合并。
3. **导出韧性**（问题 #14）：flush 失败进本地 spool（`traces/.otlp-spool.jsonl`），
   下次启动重放；指数退避（上限如 30s）。
4. **live run**（问题 #15）：可选——run 进行中把 `spans` 增量写一个
   `<sessionId>.live.jsonl`（或内存快照经新协议 `trace_live` 推送），面板轮询。
   仅作展示，崩溃即弃，不参与事实源。
5. **隐私收敛**（问题 #16）：本地 `detail` 捕获也受一个本地开关门控
   （默认仍开，但让用户可关）；文档明确「redactContent 只管导出」。
   或最低成本做法：把开关改名 `uploadContent`，并在设置页注明本地轨迹始终含正文。

---

## 4. 兼容与迁移策略

- **只增不改删**：v1 字段（`runId`、`attrs` 原键）全部保留；新增字段可选。
- **读侧 fallback**：`resolveSpanId` / 缺 `traceId` 时回退 `runId`。
- **不迁移历史文件**：旧 JSONL 不重写，靠读侧兼容；新写入即 v2 形状。
- **OTLP 双轨**：若担心旧后端兼容，可加 `pi.schema=2` 属性做灰度开关，
  但默认直接切 v2（OTLP 消费方只认 traceId/spanId 语义，形状变化是透明的）。

---

## 5. 测试与验收

单测（bun test，对齐现有 `trace.test.ts` / `otlp-exporter.test.ts` 风格）：

1. **id 对齐**（P0 核心）：面板 adapter 与 OTLP exporter 对同一 record 产出
   完全一致的 span id 集合与父子关系。
2. **因果边**：合成父 run + 子代理 run，断言 `parentRunId/parentSpanId` 正确。
3. **状态语义**：Stop 打断 → run.status=`aborted`；OTLP 里不出现 ERROR 且带
   `pi.aborted=true`。
4. **TTFT**：合成 `message_start` + 若干 `message_update` + `message_end`，
   断言 `ttftMs` 等于首个 update 的时间差。
5. **工具错误**：`tool_execution_end` `isError=true` 时 span 带 errorMessage。
6. **兼容**：喂一份 v1 旧 JSONL 样本，渲染与导出不抛、走 fallback。

手动验收：

1. 面板选中某 tool span → 与导出的 OTLP JSON 里同名 span 的 spanId 一致。
2. 触发一次 Task 委派 → Lanfuse 里子 trace 挂在父 trace 下（若后端支持
   parent-trace 关联；即便不支持，`pi.parent_run_id` 属性可人工关联）。
3. 限流重试 → retry span 保留；Stop → 不再记 error。

---

## 6. 提交切分与落地清单

### commit A — P0 身份模型（地基，先做）

按顺序改，每步都能单独 `bun test` 回归：

1. **`protocol/trace.ts` 生成并落 id**
   - 新增 `newSpanId()`（`randomBytes(8)` → 16hex）、`newTraceId()`（`randomBytes(16)` → 32hex）。
   - `OpenRun` 增 `traceId`；`openRun()` 里 `traceId = newTraceId()`，`runId = traceId`。
   - 四处 span 创建点（turn / llm_call / tool_call / retry）+ `childrenOf` 的隐式 turn，
     统一赋 `spanId = newSpanId()`、`parentSpanId = 所属 turn 的 spanId`（根 span 留空）。
   - `TraceRunRecord` 增 `traceId` / `parentRunId?` / `parentSpanId?`；
     `createTraceRunRecorder(sessionId, source, parent?)` 增第三参；`finalize()` 写入。
   - recorder 接口暴露只读 `traceId` 与 `spanIdForToolCall(toolCallId)`
     （`openTools` 已是 `toolCallId → span` 映射，取 `.spanId` 即可）。
   - 验证：`trace.test.ts` 断言每个 span 有唯一 16hex `spanId`、`parentSpanId` 指向 turn。
2. **子代理父身份注入**
   - `subagent/run.ts`：`SubagentRunOptions` 增 `parentTrace?`，
     构造处 `createTraceRunRecorder(opts.traceSessionId, "subagent", opts.parentTrace)`。
   - `subagent/tools.ts`：Task `execute` 里 `new SubagentRun({ ..., parentTrace: {
     runId: run.trace?.traceId, spanId: run.trace?.spanIdForToolCall(toolCallId) } })`。
   - 验证：委派场景断言子 run 的 `parentRunId/parentSpanId` == 父 run 里该 Task
     `tool_call` 的 `spanId`。
3. **展示层改取 id** —— `trace-adapter.ts`：`walk` 用 `span.spanId` 作 `SpanData.id`、
   `span.parentSpanId` 作父；根 id 用 `run.traceId`；删 `seq`。v1 旧记录（无 `spanId`）
   走 `resolveSpanId` 回退到 DFS 序号。
4. **导出层改取 id** —— `otlp-exporter.ts`：`spanToOtlp` 用 `span.spanId/parentSpanId`，
   `traceId = record.traceId ?? record.runId`；`flattenSpans` 不再拼 path 派生 id
   （path 仅留遍历用）。v1 旧记录回退到 `sha256(path)`。
5. **桌面类型镜像补字段** —— `pi-bridge.ts` 的 `PiTraceSpan` / `PiTraceRun` 增
   `spanId` / `parentSpanId` / `traceId` / `parentRunId`（P2 才迁去 `pi-protocol`）。
6. **核心断言** —— 同一 record，`traceRunToSpanData` 与 `buildOtlpSpans` 的 span id
   集合与父子关系完全一致；再补一条 v1 旧 JSONL 样本的渲染/导出兼容用例。

**回滚点**：新增字段全部可选，`runId` 保留，任一步失败都不会破坏现有 JSONL 读取。

### commit B — P1 语义补齐

工具错误/结果/类别 → TTFT 首帧捕获 → 时钟统一（provider 时间戳降级为 attr）→
GenAI 属性与 exception 事件 → resource 扩展。对应 §3.2，逐项独立可测。

### commit C — P2 工程卫生

类型迁 `pi-protocol` 单源 → 护栏轮转归档 → 导出 spool + 退避 → live run → 隐私开关。
对应 §3.3。

P0 是地基，必做先行；P1/P2 可拆可缓。

---

## 7. 风险与开放问题

- ~~**子代理父身份可达性**（P0 关键未知）~~ **已核实解决**：Task 工具同时握有父
  `run`（含 `trace`）与 `toolCallId`，且 `tool_execution_start` 先于 `execute()`
  落地 → 直接透传父身份，**不需要注册表**（详见 §3.1-2）。
- **TTFT 与 v1 约束冲突**：需要产品/架构确认放宽「不碰 message_update」的
  约束（本方案限定为首帧 O(1) 捕获）。不接受则 TTFT 降级为 P2。
- **OTel 无 aborted**：用 `pi.aborted` 属性表达是社区惯例，但各后端展示不一；
  需确认目标后端（Langfuse）是否会把 OK+属性 的 span 正确显示为「取消」。
- **random id vs 可复现 id**：v2 选 random（合规）；若团队更看重调试可复现，
  可保留确定性派生，但需接受非严格 OTel 规范。
- **react-o11y experimental**：id 来源变化会触及 adapter；锁版本 + adapter
  隔离（视图仍只吃 `SpanData`）。

---

## 8. 明确不做

- 不引 OTel SDK / protobuf。
- 不改 transcript JSONL 行格式与 seq 语义。
- 不在 token 级路径落盘 / 发包（TTFT 例外见 §3.2，仅首帧一个字段）。
- 导出失败继续丢弃 + 节流（P2 的 spool 是增强，不改变「不反压」原则）。
- 不重写历史 trace 文件。
