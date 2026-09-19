# Agent 调用轨迹与可观测性实施计划（agent trace / o11y）

> 目标：能看到一次 agent prompt 从发起到结束的完整调用轨迹——LLM 请求
> （模型 / 用量 / 耗时 / 停止原因）、工具调用瀑布、provider 重试，覆盖主线程、
> 子代理与 automation 旁路 run。分三档：
>   - **P1 自研轨迹**：sidecar 内记录 + 本地存储 + 查询命令（无外部依赖，必做）
>   - **P2 轨迹 UI**：header「更多」入口 → 右侧面板链路总轨迹图
>     （@assistant-ui/react-o11y 渲染）+ JSON 导出
>   - **P3 导出**：设置页配置 + OTLP/HTTP 导出器（Langfuse 走其 OTLP 端点，可选）
>
> 现状：仓库无任何 tracing（无 OTel / Langfuse 接入，无 traceId / span 概念）。
> 最接近的三块是分级日志（`log.ts` / `logging.rs`）、消息级转录落盘（`transcript.ts`）、
> 用量聚合（`usage-stats.ts`）——都是结果记录，没有单轮内部调用链的结构化耗时。
> 轨迹所需事件流全部汇聚在 `stream.ts onAgentEvent`（`stream.ts:88`），事件粒度见
> `@mariozechner/pi-agent-core` 的 `AgentEvent`（agent / turn / message / tool 四组，
> 含 `agent_start`、`turn_start`、`message_start`、`tool_execution_start/update/end`，
> 目前 switch 未消费的分支也都会流经此函数）。

---

## 设计基准

### Span 模型（P1 定型，P2/P3 共用）

```
run（agent_start → agent_end）            trace 根，一次 prompt
├─ turn × n（turn_start → turn_end）
│  ├─ llm_call（message_start → message_end，role=assistant）
│  │    model / provider / usage / stopReason / 耗时 / errorMessage
│  ├─ tool_call × n（tool_execution_start → end，按 toolCallId 配对）
│  │    toolName / args 摘要 / isError / 耗时
│  └─ retry × n（provider-retry 打点：attempt / delayMs / code / status / 等待区间）
└─ turn ...
```

```ts
type TraceSpan = {
  kind: "turn" | "llm_call" | "tool_call" | "retry";
  name?: string;               // tool 名 / retry code
  startMs: number; endMs: number;
  status: "ok" | "error" | "aborted";
  attrs?: Record<string, string | number | boolean>;
  children?: TraceSpan[];      // 仅 turn 持有子 span
};
type TraceRun = {
  runId: string;               // 32hex traceId，由 sessionId + run 序号派生（可复现）
  sessionId: string;
  startMs: number; endMs: number;
  source?: "ui" | "automation" | "subagent";   // 尽力而为标注（无 reqId 即非 ui）
  status: "ok" | "error" | "aborted";
  model?: string;              // 末轮模型
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  spans: TraceSpan[];
};
```

### 存储与写入时机

- 文件：`<PI_SESSIONS_DIR>/traces/<sessionId>.jsonl`，**一行一个 run**——
  内存攒整棵树，`agent_end` 时与现有 `persist` 同点一次性 `appendFileSync`。
  崩溃只丢在飞 run（转录仍兜底消息内容），读取端零部分树问题。
- 体积护栏：追加前若文件 > 5MB，重写为仅保留末尾 1MB（目录先例：
  `<sessionsDir>/automation/`）。
- 记录器**纯同步内存操作**，不阻塞流路径；不在 `message_update`（token 级）上做任何事。

---

## P1：sidecar 轨迹记录 + 查询命令（必做，预计 0.5~1 天）

### P1-1. 新文件 `apps/sidecar/pi-agent/src/trace.ts`（记录器）

- 生命周期全由 `stream.ts onAgentEvent` 驱动：
  `agent_start` 开 run → `turn_start`/`turn_end` 开合 turn →
  `message_start`/`message_end`（`role==="assistant"`）记 llm_call（usage/model/
  stopReason 从 `event.message` 读取）→ `tool_execution_start`/`end` 按
  `toolCallId` 配对记 tool_call → `agent_end` 落盘并清态。
- `agent_start` 时检查残留未闭合的 run：强制收尾为 `status:"error"`（进程内
  异常/被 abort 的 run 不留悬空树）。
- `tool_execution_update` 忽略（进度事件，不参与计时）。
- run 计数器 per-session 自维护，不与 stream.ts 的 runSeq 强绑。

### P1-2. retry 打点

文件：`apps/sidecar/pi-agent/src/provider-retry.ts`

- 在重试包装层内部（计算 attempt / delayMs 并调用 `controller.onRetry` 的同一处）
  直接调 tracer 打点——任何经过该包装层的 run（主代理、子代理）都被记录，
  主代理 UI 的 `data-retry` 卡片路径不动（`makeUiRetryController`，sessions.ts:610）。
- 实现时确认一件事：subagent 的 streamFn 装配是否走同一包装层（预期共用，
  若不是则在 subagent 装配处补接同一 tracer 调用，并在测试里断言覆盖）。

### P1-3. 查询命令 `trace_query`

文件：`apps/sidecar/pi-agent/src/protocol.ts`、`types.ts`、桌面端 `lib/pi-bridge.ts`

- 入站：`{ "type": "trace_query", "id", "sessionId", "limit"? }`
  出站：`{ id, type: "trace_query", runs: TraceRun[] }`（按 run 倒序，limit
  默认 50、上限 200——参照 usage_stats 的 limit 处理，protocol.ts:1965）。
- 命令分发与类型镜像参照 `usage_stats`（protocol.ts:1520）；**同步更新
  protocol.ts 顶部协议注释**（现有惯例，~71-121 行区块）。
- 读取实现放 trace.ts（`readTraceRuns(sessionId, limit)`），容错撕裂行
  （JSON.parse 失败跳过该行）。

### P1 测试与验收

- 新增 `trace.test.ts`（bun test，与 browser-config.test.ts 同风格）：
  1. 合成事件流（2 turn，每 turn 1 llm + 2 tool + 一次 429 retry）→ 断言树形、
     usage 聚合、重试区间、runId 稳定；
  2. 残留 run 强制收尾；撕裂行容错；> 5MB 护栏截断。
- 手动验收：
  1. 跑一个多轮工具调用会话 → `traces/<sessionId>.jsonl` 每轮一行、树完整，
     usage 与设置→使用统计口径一致（error/aborted 轮的口径对齐 usage-stats）；
  2. 配一个 automation 定时任务跑一次 → 旁路 run 有轨迹（`source` 非 ui）；
  3. 人为制造 429（限流模型）→ retry span 出现且带 delayMs。

---

## P2：轨迹时间线面板（header 入口 + react-o11y + 导出，预计 1~1.5 天）

### P2-0. 依赖与数据适配

- 安装 `@assistant-ui/react-o11y` 及其依赖 `@assistant-ui/store`（react-o11y
  处于 experimental，**锁死版本**，装包时确认与现有 `@assistant-ui/react`
  0.15.x 无 peer 冲突）。
- 新文件 `apps/desktop/lib/trace-adapter.ts`：TraceRun / TraceSpan（sidecar
  形状）→ react-o11y 的扁平 `SpanData[]`——`{ id, parentSpanId, name, type,
  status, startedAt, endedAt, latencyMs }`，树靠 parentSpanId 表达而非嵌套：
  - type 映射：turn→`"turn"`、llm_call→`"llm"`、tool_call→`"tool"`、
    retry→`"retry"`；
  - status 映射：ok→`completed`、error→`failed`、aborted→`skipped`；
  - id 用 span 路径键（如 `runId:t0:llm1`），跨查询重渲染时 React 复用稳定。

### P2-1. 入口：header「更多」菜单

文件：`apps/desktop/components/agent-thread/header.tsx`（会话标题旁的
DropdownMenu，现仅"重命名"一项，~83-102 行）

- 新增 `DropdownMenuItem`「链路追踪」→ 打开右侧面板 trace 标签并携带当前
  线程 sessionId（见 P2-2）。

### P2-2. 右侧面板：链路总轨迹视图

文件：`apps/desktop/lib/panel-tabs.ts`、agent-panel 相关组件

- `PanelTabType` 增加 `"trace"`（`VALID_TYPES` 同步；标签持久化/恢复机制
  免费获得），tab 记录绑定 sessionId——沿用 `PanelTab.sessionId` 字段
  （shell 标签先例），header 唤起时写入；tab-registry 注册视图。
- 视图组件（新 `agent-panel/trace-panel/`）：
  - 顶部 run 列表（倒序：时间 / 模型 / 总耗时 / 状态 / token 数）；选中 run
    经 `SpanResource({ spans })` + `AuiProvider` 挂载（spans prop 换数组即
    切换 run，react-o11y 自行重推导树）；
  - 详情用 `SpanPrimitive.Children`（自定义 SpanRow：StatusIndicator /
    TypeBadge / Name / 耗时）+ `SpanPrimitive.Timeline` / `TimelineBar` 画
    瀑布（CSS 变量百分比定位，不自研时间条）；`CollapseToggle` 折叠子树；
  - attrs 摘要（retry 的 code/delayMs、llm 的 usage、tool 的 args 截断）放
    SpanRow 展开区或 tooltip；
  - 数据经 `piRequest("trace_query", { sessionId })`；面板可见且线程 run
    结束后重查一次；不做 token 级直播（在飞 run 不在文件里，后续可选）。
- 空态：无轨迹文件 / 旧会话给引导文案，请求失败静默降级为空态。

### P2-3. 导出

- 面板头部加"导出"按钮：当前会话全部 `TraceRun[]` 原样 JSON 落盘
  （全量拉取，不受列表 limit 影响）。
- Tauri 桌面端走 save 对话框（`tauri_plugin_dialog` 已接入，lib.rs:27）+
  既有 fs 通道写文件；网页端 fallback `Blob` + `URL.createObjectURL` 下载。
- 文件名 `<sessionId>-traces-<date>.json`；Markdown 摘要导出属后续可选，
  P2 先不做。

### P2 验收

1. header more 菜单点「链路追踪」→ 右侧面板打开该会话 run 列表，选中 run
   出瀑布（llm/tool/retry 层级正确、可折叠、状态色区分）；
2. usage 与设置→使用统计口径一致；子代理（Task 委派）与 automation 旁路
   run 在列表可见（source 标注）；
3. 导出 JSON 与 trace_query 返回一致，桌面与网页两种形态均可落盘；
4. 旧会话（无 trace 文件）不报错；react-o11y 锁版本后构建无 peer 冲突。

---

## P3：设置页配置 + OTLP 导出器（可选，预计 1 天）

> 一个导出器同时覆盖 Langfuse 与任意 OTel 后端：Langfuse 原生摄取 OTLP/HTTP
> （云端 `https://cloud.langfuse.com/api/public/otel/v1/traces`，Basic auth
> 公钥:私钥），带 `gen_ai.*` 语义属性的 span 映射为 generation（模型 / token /
> 成本）。文档：langfuse.com/docs/opentelemetry。

### P3-1. 配置链路（模板：browser-config 全套）

- sidecar 新文件 `observability.ts`（模板 `browser-config.ts`）：kv 键
  `pi.observability`，`normalizeObservabilityConfig` + `initObservability`
  （挂进 `index.ts` 初始化闸门，与 `initBrowserConfig` 并排）。
  配置形状：`{ enabled, endpoint, headers, sampleRate, redactContent }`。
- 协议 `get_observability` / `set_observability`（模板 get/set_browser，
  protocol.ts:1571），顶部协议注释同步。
- 桌面端 `lib/observability-config.ts`（模板 `lib/browser-config.ts`，
  useSyncExternalStore 镜像）。
- 设置页：`settings-page.tsx` GROUPS"系统"组加"追踪"（ActivityIcon）→
  新组件 `components/observability-settings.tsx`（模板
  computer-control-settings.tsx）：开关、endpoint、headers 键值对编辑、
  采样率、"测试连接"按钮（探活或发一条探针 span）、Langfuse 预设快捷项
  （填好 endpoint 路径与 Basic auth 提示）。

### P3-2. 导出器 `apps/sidecar/pi-agent/src/otlp-exporter.ts`

- 手写最小 OTLP/HTTP JSON 导出（POST，`resourceSpans` 结构），**不引
  OpenTelemetry SDK / protobuf 依赖**。
- 内存批队列：5s 或 50 spans 触发 flush；失败丢弃 + 节流 `logErr`，
  **任何异常不得抛回 agent 主流程**（catch-all）。
- 映射：`TraceRun` → trace（runId 即 traceId）；llm_call 带
  `gen_ai.system` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` /
  `gen_ai.usage.output_tokens` / `gen_ai.response.finish_reasons`（Langfuse
  据此显示 generation）；tool_call 带 `gen_ai.tool.name`；resource
  `service.name = "pi-agent"`。spanId 由 span 序号派生 16hex。
- **默认 `redactContent: true`**：只传元数据（耗时 / token / 模型 / 工具名），
  不传 prompt 与工具正文；正文上传做成显式开关留后续（涉及体积与隐私）。
- sampleRate 按 run 粒度采样（默认 1.0）。
- 接线：tracer 在 `agent_end` 落盘后调 `exportTraceRun(run)`（exporter
  内部判断 enabled，开销为零路径）。

### P3 测试与验收

- `observability-config.test.ts`（normalize / 默认值 / headers 规整）；
  `otlp-exporter.test.ts`（payload 形状、鉴权头、批触发阈值、失败不抛）。
- 手动验收：配置 Langfuse 云端 → 跑两轮会话 → Langfuse Traces 出现 pi-agent
  trace，generation 显示模型与 token；关 enabled 停止上传；断网跑任务无报错
  无卡顿（导出静默失败）。

---

## 执行顺序与提交切分

1. commit A：P1 全部（trace.ts + 两处打点 + trace_query + 测试）——sidecar
   单包，独立可回归
2. commit B：P2（react-o11y 依赖 + trace-adapter + header 入口 + trace 面板 + 导出）
3. commit C：P3-1 配置链路（kv + 协议 + 设置页）
4. commit D：P3-2 导出器 + Langfuse 映射
（P2 与 P3 顺序可互换；P1 是其余一切的地基，必做先行）

## 不要顺手做的事

- **不改 transcript JSONL 行格式与 seq 语义**（readTranscript /
  historyToUiMessages / 压缩检查点全依赖它）；trace 独立文件不动转录。
- 不在 `message_update`（token 级）路径上记录或发送任何东西。
- 不引 OpenTelemetry SDK / protobuf 运行时依赖，OTLP 手写最小实现。
- span / 导出默认不含 prompt 与工具正文（redactContent=true）；
  traces 文件 5MB 护栏必须实现，不做就等于给长会话埋磁盘炸弹。
- exporter 任何失败不得反压 / 阻塞 agent 主流程（丢弃 + 节流日志）。
- 不动 credential / 主密钥代码；Langfuse 密钥放 kv 的 headers 里，
  但任何日志输出必须脱敏 Authorization 头。

## 风险与待确认（实现时落实）

- subagent streamFn 是否经过 provider-retry 同一包装层（P1-2 中确认，
  预期共用；不是则补接）。
- `gen_ai.*` 各后端映射粒度有差异（Langfuse 成本计算依赖其价格表，
  未收录模型显示 0）——文档注明即可，不做兼容层。
- react-o11y 为 experimental（API 可能无通知变更）：锁版本 + 适配器层隔离
  （视图只吃 SpanData，上游模型/库变更只改 `trace-adapter.ts`）；装包时确认
  `@assistant-ui/store` 与现有 `@assistant-ui/react` 0.15.x 无 peer 冲突。
