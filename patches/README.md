# 依赖补丁

> 2026-10-01 修正：早前版本的本 README 曾错误记载「pi-agent-core 0.99.2 上游已修
> estimateTokens」——当时 node_modules 里残留着未走 patch 注册流程的手工守卫，被误判
> 为上游自带。`bun patch` 重置后核实：**0.99.2 原始代码三处分支全部裸访问**。两个包
> 均需 patch，已全部注册。

## @earendil-works/pi-agent-core@0.99.2

`dist/harness/compaction/compaction.js` 的 `estimateTokens` assistant 分支：
text / thinking / toolCall 三类块对 `block.text` / `block.thinking` / `block.name`
裸访问 `.length`，字段缺位的畸形块会让 sidecar 崩（Bun JSC 报
`undefined is not an object (evaluating 'block.text.length')`，历史真实发生过，
见上游 issue #7660）。补丁对三类块加 `typeof === "string"` 守卫。

## @earendil-works/pi-ai@0.99.2

### 1. estimate.js（token 估算守卫）

`estimateMessageTokens` assistant 分支三类块同款裸访问（toolCall 分支加
`block.type === "toolCall"` 前置，原 else 会把任何未知块类型当 toolCall 取
`block.name.length`）；`estimateTextAndImageContentChars` 的 text 分支补
`typeof block.text === "string"`（对应上游 issue #6819 更正诊断：畸形
toolResult 触发此函数，且 `clampMaxTokensToContext` 每次请求前都跑）。

### 2. anthropic-messages.js / openai-completions.js（空 text 块过滤）

构建请求体时对 text 字段调 `.trim()`，畸形块会让请求 400。补丁过滤
`typeof b.text === "string" && b.text.trim().length > 0`。

### 已知纵深缺口（评估后不修，勿当活跃 bug）

- anthropic-messages.js:1110、openai-completions.js:979 的 `block.thinking.trim()`：
  消毒层 normalizeBlock（sidecar transcript.ts）已保证 thinking 块仅在
  thinking 为 string 时放行，活跃路径封死。
- mistral-conversations.js:647/653：项目不使用 mistral provider。

## @assistant-ui/core@0.3.22

`dist/react/runtimes/RemoteThreadListThreadListRuntimeCore.js` 的
`_switchToThread`：上游要等新线程 runtime 附着完成（`_whenRuntimeAttached`）
才翻转 `_mainThreadId`，等待窗口内 UI 一直渲染上一条会话——移动端叠加
index→chat 路由转场后「切换先闪上次对话，再骨架，才加载」肉眼可见。补丁
改为切换一开始就乐观翻转 `_mainThreadId` 并 notify：`getMainThreadRuntimeCore`
落到 `EMPTY_THREAD_CORE`（`isLoading=true`、`messages=[]`），thread UI 直接进
`isHistoryLoadingView` 骨架态；附着失败（如线程被删）时回滚到原线程并原样
抛错。副作用（均为改善）：`onThreadIdChange`/`threads.selectionChanged` 提前
触发（chat 页水合更早开始）、切换窗口内对主线程发消息会落到 inert 空核报错
而不是误发进旧线程。

## 升级指引（同上）

升级任一包版本时：`bun patch <pkg>@<ver>` 后**逐处核对**守卫是否需要迁移——
不要以 node_modules 现状判断「上游已修」（它可能混着未注册的手工改动），
以 `bun patch` 重置后的 pristine 内容为准。
