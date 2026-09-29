## 目标

给会话加第三档模式「问答」：只读工具子集（不给 bash）、提示词砍掉 todo/Subagents 段、界面收敛，配一个"模型提议切档"的出口。

按调研结论校正的两点：
- **叫「问答」不叫「快速」**。业界没有一家把轻量问答叫 fast mode；Claude Code 的 `/fast` 是同模型的低延迟档，叫这个名字会让用户预期成"回答更快"。Cursor / Devin 都叫 Ask mode。
- **不清空工具表，收走的是"写"**。Cursor 的 Ask 是 read-only 不是 tool-free，Claude Code 的 Manual 档是 "Reads only"——读照常。kova 里这个子集已经存在（`CONTRACT_TOOL_NAMES`，`modes.ts:79`），plan 模式正在用。

## 前提：默认值不动

你选了默认仍是编码/变更前确认。这意味着"简单问答被 agent 一通操作"这个痛点，**只在你主动切到问答档时才消失**。所以计划里把两件事分开：

- 主体是问答档本身（第 1–6 步），这是你选的范围内必须做的。
- 另外单列一条**可独立回退**的提示词微调（第 7 步），直接打在 agent 档"接到新指令就建 todo"这个过度触发上——这条是即使不进问答档也能缓解痛点的部分。

问答档的可达性靠 Shift+Tab 循环 + composer 第五项，不靠默认。

---

## 1. 类型与协议

`apps/sidecar/pi-agent/src/types.ts:240`
```
export type SessionMode = "agent" | "plan" | "ask";
```

`apps/sidecar/pi-agent/src/protocol/handlers/interactive.ts:79` — set_mode 白名单加 `"ask"`。

`apps/sidecar/pi-agent/src/protocol/handlers/sessions.ts:126` — 会话列表投影 `r.mode === "agent" || r.mode === "plan" ? r.mode : undefined` 的白名单同步加 `ask`，否则列表里问答会话的模式字段是空。

## 2. 工具表：只读子集

`apps/sidecar/pi-agent/src/agent/modes.ts`

新增 `ASK_TOOL_NAMES`，从现有 `CONTRACT_TOOL_NAMES`（`modes.ts:79`）派生并**去掉 `bash`**——bash 不是只读，留着就破坏了问答档的安全边界。保留 read / glob / grep / WebFetch / WebSearch / Question / skill_use。

`toolsForMode`（`modes.ts:135`）加第三个分支：
```ts
if (run.mode === "ask") {
  return run.baseTools.filter((t) => ASK_TOOL_NAMES.has(t.name));
}
```
不加 plan 三件套，不加 subagentTools。子代理工具整批不下发——它那六行提示词和多轮委派是"工程味"的主要来源之一。

## 3. 结构性只读拦截

复用 plan 模式那套代码级保证，不依赖工具表新鲜度（`modes.ts:386` 已有先例，注释写明"轮中切换前模型可能还带着旧 schema"）：

```ts
if (run.mode === "ask" && ASK_MODE_MUTATING_TOOLS.has(name)) {
  return { block: true, reason: "..." };
}
```

## 4. 提示词

`composeModeSystemPrompt`（`modes.ts:110`）现在是无条件拼 `SYSTEM_PROMPT_CORE`。问答档需要它变薄，而这要求把 `SYSTEM_PROMPT_CORE` 从一个扁平数组**拆成可选取的段**（`tools.ts:397`）——这是整个改动里唯一有侵入性的重构，因为该常量被注释明确要求"字节级稳定"以保住 OpenAI 前缀缓存。

拆法保持那条不变式：所有静态段顺序不变、动态段（cwd / 环境事实）仍在最末尾，code/plan 档重组后的字节流与现在**完全一致**。用 `modes.test.ts:465` 那个 `describe("系统提示词结构（缓存友好）")` 做回归断言钉住。

新增 `ASK_MODE_PROMPT`，纪律三条：直接回答不要动手；问的是代码就读代码回答、别改；确实需要动文件时调 `ask_needs_work` 提议切档。

问答档不拼 `environmentPromptBlock` 之外的 memory/mcp/skills/instructions 是否保留——**先保留**，它们是工作区相关的（memory 段 1,508 字符最大，但里面是用户自己的记忆，砍掉可能损失有用信息）。这一条实现时按实际内容再定，先按保留写。

## 5. 塌陷点修复（不加会静默丢数据）

这些都是 `x === "a" || x === "b"` 或三元，加了 `ask` 不报错、直接丢：

| 位置 | 现状 | 后果 |
|---|---|---|
| `sessions/resolve.ts:419` | 只认 agent\|plan | 恢复问答会话时模式被丢弃 |
| `sessions/resolve.ts:433` | 同上，读 kv | 同上 |
| `sessions/resolve.ts:698` | `row.mode === "plan" ? "plan" : "agent"` | 上下文用量统计把问答会话算成带全套工具 |
| `agent/modes.ts:116` | `mode === "plan" ? PLAN : AGENT` | 问答会话拿到 agent 纪律段 |
| `agent/modes.ts:543` | `mode === "agent" ? "inactive" : "planning"` | **问答会话继承 planning 态，UI 显示成计划模式** |
| `lib/pi/pi-session-mode.ts:56` | chunk 守卫 | **整个 chunk 被丢弃，UI 卡在旧模式，表现是"点了没反应"** |
| `lib/pi/pi-session-mode.ts:126` | 恢复守卫 | 刷新后模式回退 |

统一改成显式映射表，别再加三元。

## 6. 前端

- `components/agent-thread/mode-picker.tsx` — `OPTIONS` 加第五项「问答」，`activeKey`（`:101`）的 `snap.mode === "plan" ? "plan" : snap.approvalLevel` 改成能识别 ask。绑定 Shift+Tab 循环。
- `lib/pi/pi-session-mode.ts` — 类型 + 上面两处守卫。

## 7. 出口：模型提议切档（可独立回退）

问答档给模型挂一个 `ask_needs_work` 工具，它调用时不切档，只在 composer 冒一个 chip："这题需要动文件 → 切到编码？"，用户点了才发 `set_mode`。

不做成模型直接切档，是因为切档会当场把提示词和工具表一起换掉——那正是问答档要避免的"变重"。`plan_exit` 已经是 HITL，这条路子一致。

## 8. 界面收敛

- `components/assistant-ui/elements/tool-row.aui.tsx:212` — `const compact = useAppMode() === "work"` 扩成 `|| 会话是问答档`，复用已有的行折叠逻辑。
- `components/agent-thread/agent-panel/tab-registry.tsx:65` — 问答档隐藏 git / shell 标签。
- composer 底栏在问答档下收起思考档、上下文用量等控件，保留模型选择器。

## 9. 顺带修 agent 档的 todo 过度触发（独立可回退）

`tools.ts` 的 Task tracking 段现在写着 "or **immediately after receiving new instructions to capture requirements**"，后半句在鼓励模型对每条消息建 todo——这大概率就是你说的"一直给我做这个做那个"的一部分。软化成只在明确的多步任务时触发。

这条不改任何状态机、只改一段文案，可以单独回退。如果实测没改善，撤掉零成本。

---

## 测试

`apps/sidecar/pi-agent/test/agent/modes.test.ts`（已有 34 个用例，`makeRun(mode)` 辅助函数现成可用）扩：
- `toolsForMode` 问答分支返回只读子集，不含 bash / write / edit / subagent
- `modeBeforeToolCall` 问答档拦截写类工具
- `applyMode` 问答档 planning 为 `inactive`
- `composeModeSystemPrompt` 问答段不含 todo/Subagents 字样，且 code/plan 档输出与改动前逐字节相同（缓存不变式回归）

新增 `apps/desktop/lib/pi/pi-session-mode.test.ts`，照 `app-mode.test.ts` 的写法：问答 chunk 能被 `applyPlanningChunk` 接受、不再被丢弃。

## 验证

- `cd apps/sidecar/pi-agent && bun test`（根 `bun run test` 走的就是这个）
- `cd apps/desktop && bun test lib/pi/pi-session-mode.test.ts`
- 手动：问答档下 `write` 应被结构拦截；发一条纯问题，确认没有 todo 冒出来

## 不做的事

- 不改默认值
- 不碰自动化/子代理/队列逻辑
- 不做 Devin 那种"生成交接 prompt"的产物式交接，也不做 Cursor 的 side chat——都是第二阶段
- 不引入 "fast" 字样到任何面向用户的文案
