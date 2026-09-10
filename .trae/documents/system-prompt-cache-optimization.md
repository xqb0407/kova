# 系统提示词优化 + Prompt 缓存命中率提升

## Context

用户提出两点：①系统（提示词）优化一下 ②提高（prompt）缓存命中率。

**现状调研结论**（已核实 pi-agent-core / pi-ai 源码机制）：

- 当前系统提示词只有 6 行（[tools.ts:283-291](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/tools.ts#L283-L291)），且**第 2 行就嵌入 cwd**（每会话不同）→ 跨会话时 system 前缀缓存失效
- pi-ai 的 Anthropic 适配**默认已开启** `cache_control`（system 块 + 最后一个 tool + 最后一条消息三个断点，[anthropic-messages.js L29-39](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js#L29-L39)）；OpenAI 走服务端自动前缀缓存
- pi-ai 支持 `options.sessionId`：OpenAI 映射为 `prompt_cache_key`（路由到同一缓存分片，[openai-completions.js L588-591](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js#L588-L591)），Anthropic 用作 session-affinity。**pi-agent-core 的 Agent 构造函数原生接受 `sessionId` 并透传给 streamFn**（agent.js L130 → agent-loop.js L192-196），但 sidecar 建 Agent 时没传
- 工具描述不含 cwd（cwd 只在闭包里）→ 工具 JSON 跨会话字节级一致，工具前缀缓存天然命中
- 消息流为 append-only（defaultConvertToLlm 纯过滤，无动态注入）；工具集只在会话初始化/模式切换时变化 → 会话内前缀稳定性已具备
- pi-ai 支持 `cacheRetention: "long"`（Anthropic 1h TTL / OpenAI 24h），compat 守门，不支持的 provider 自动降级

## 改动内容

### 1. sessionId 透传（一行，缓存路由改善）

[sessions.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/sessions.ts#L104-L114) Agent 构造加 `sessionId`：

```ts
const agent = new Agent({
  streamFn: ...,
  sessionId,            // ← 新增：OpenAI prompt_cache_key + Anthropic session-affinity
  initialState: ...,
  ...
});
```

[subagent.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/subagent.ts#L248) 的子代理 Agent 同样加（委派的模型请求也享受缓存路由）。

### 2. 系统提示词重排 + 内容扩充

**重排原则：静态核心在前，cwd 挪到末尾**（同会话内不变 → 会话内缓存零影响；跨会话时 OpenAI 前缀增量仍命中静态部分，Anthropic 仅 system 块失效、tools 块照常命中）。不把 cwd 挪进首条用户消息——压缩（compaction）后历史被摘要替换会丢失 cwd，风险大于收益。

[tools.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/tools.ts#L283-L291) `systemPrompt(cwd)` 重写为：

- **静态核心**（英文，~35 行，结构化小节）：
  - Identity：Xulux desktop app 内的编码 agent
  - Code change discipline：改前先读相关代码；最小 diff，不顺手重构/不加未要求的抽象；遵循现有代码风格与框架约定；不碰无关文件
  - Tool preference：read/glob/grep 优于 bash 勘察（保留现有）；批量工具调用前一句话说明（保留）
  - Correctness：改完跑验证（build/test/lint）；报错先找根因，不盲改
  - Communication：与用户同语言（保留）；最终消息自包含：结果/变更/遗留（保留）
- **尾部动态段**：`The workspace directory is \`${cwd}\`.` 单独一行放最后

[modes.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/modes.ts#L83-L92) `composeModeSystemPrompt` 顺序调整为：**静态核心 → 模式附加段 → cwd 行**（cwd 永远最尾）。

### 3. 长缓存可配（可选开关，默认不动）

[sessions.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/sessions.ts#L104) streamFn 包装透传环境变量：

```ts
streamFn: (m, context, options) =>
  getModels().streamSimple(m, context, {
    ...options,
    ...(process.env.PI_CACHE_RETENTION === "long" ? { cacheRetention: "long" } : {}),
  }),
```

- 默认 short（现状）；`PI_CACHE_RETENTION=long` 启动 sidecar 时开启（Anthropic 1h TTL，适合桌面端「想一会儿再发」的节奏；写缓存成本 2x vs 1.25x，权衡交给用户）
- pi-ai compat 守门，不支持长缓存的 provider 自动忽略，无需自己判断模型

### 不做的事

- 不改 compaction / one-shot（标题总结）请求——独立上下文无共享前缀，动了也没收益
- 不引入时间戳/日期进提示词（会杀死缓存）
- 不改工具定义（已字节级稳定）

## 验证

1. `bun test`（现有 155 全过）+ 新增单测：
   - `composeModeSystemPrompt`：静态核心在前、cwd 行在最尾、模式段夹中间
   - `systemPrompt`：不含时间戳；cwd 只出现在末段
2. sidecar `npx tsc --noEmit` + `bun run build:sidecar`
3. 冒烟：启动应用对话一轮，查 `sessions` 用量统计（[context.ts](file:///Users/herther/Desktop/ai-teamplte/sidecar/pi-agent/src/context.ts#L309-L315) 已有 cacheRead/cacheWrite 汇总）确认第二轮起 `cacheRead > 0`；日志（app.log / pi-agent.log）无异常
