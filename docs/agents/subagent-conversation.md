# 子代理对话（SendMessage + resume）

状态：V1 已实现。每个委派是一个可续聊的会话：跑着的时候能插话，结束后能带上下文续聊。

审查记录、已知限制与处置决定见 `docs/agents/subagent-conversation-review.md`。

## 用户入口

- **面板对话页**（子智能体 tab）：底部输入行。running 时发送 = 插话，子代理下一个模型调用边界消费（不中断）；finished 后发送 = resume，以完整历史 + 新消息重新拉起同一 delegate（tab 不换、轮次/工具计数跨轮累加）。
- **父代理工具** `SendMessage(delegationId, message)`：与面板同一条链。任务简报写错/漏关键信息时用它纠正，报告后要追问/派补充活时也用它——对父代理来说不必 TaskStop 重开。
- **并发上限**：设置 → 智能体 → 智能体配置 → 子智能体并发（默认 8，范围 1–16，事实源 `pi.subagentMaxConcurrency`）。每个父会话独立计算；达到上限后新的 Task/resume 直接报错，不排队；调低不会中断已在运行的委派。

## 语义

| 委派状态 | SendMessage 行为 |
|---|---|
| running | steer 进 pi-core steering 队列，下个模型边界消费；返回"已送达" |
| completed/failed/truncated/stopped 且有存档历史 | resume：新 SubagentRun 带 `[...存档历史, 新消息]`，回到 running |
| interrupted 且至少完成过一轮（有中途快照） | same resume：从中途快照继续，最后半轮不完整的内容会丢 |
| interrupted 且一轮都没跑完 / 记录被裁 / 定义已删 | 明确报错，不可续聊（面板输入行直接禁用并说明原因） |

不改变既有 Task / TaskWait / TaskStop 语义；TaskWait 对 resume 后的委派照常等到新报告。

## 实现要点

- **插话**：`SubagentRun.steer(text)` 走 `agent.steer`（与主代理"并入当前轮"同一原语），消息前缀 `[user follow-up]`。settled 后返回 false（集成语义——prompt 返回后 steer 是否被消费——由 e2e 覆盖，本模块只钉受理面）。
- **历史存档**：两条路。① 每轮结束覆盖写 `<delegationId>.history.json`（独立文件，原子 rename）——进程被重启/崩溃打断时至少保住最后一个完整轮次；② 终态结算（settleDelegation）再把最终 `agent.state.messages`（裁到 100 条，剥掉开头无主的 toolResult）追加进活动文件 `{ t:"transcript", messages }`。回读优先取最后一个 transcript 行，缺失时回落中途快照。
- **历史序列化**：`toSubagentHistory` 保留消息的全部顶层字段——`toolResult` 必须带 `toolCallId/toolName`，只存 role+content 会让续聊请求出现"没有 id 的 tool 消息"被 provider 拒绝。旧存档（role+content 形态）由 `normalizeSubagentHistory` 归一：剥掉无法配对的 toolCall/toolResult，退化成纯文本对话，保证能续聊而不是一发送就报错。
- **resume**：`resumeDelegation(record, text, fallbackOwner?)` 用原 definition/model/toolGate 重建 capabilities + SubagentRun（`initialMessages` 承载历史），原位重置 record 为 running（同 delegationId）。与 Task 启动共用 `launchSubagentRun`——审批链（subagentToolGate）、goal 证据、轨迹因果边完全一致。**没有存档历史一律拒绝**：只带一条新消息重开会伪造"上下文仍在"。
  - 从磁盘恢复的记录会补登记进父会话 `run.delegations`（否则 TaskWait/TaskList/TaskStop 看不见、并发上限漏算），并重开活动 writer（原进程的 writer 已随重启消失）。
  - resume 开始先落一条 `status:"running"` 标记：活动文件里上一轮的 completed/failed 不能让重启后的回读把本轮误判成已结束。回读把文件里的 running 映射为 interrupted，并丢弃上一轮报告。
  - 同一委派在异步准备阶段有进程内并发闸（`resuming` Set），双发不会拉起两个 SubagentRun。
- **寻址**：`findDelegationRecord`（delegation.ts）全局扫描 + 磁盘回读；record 带 `ownerSession {sessionId, threadId, cwd}`，resume 时按需 `resolveSession` 物化父会话（不要求父会话仍驻留内存）。老记录缺该字段时，工具路径用当前父 run 兜底；仍无法确定则明确报错。
- **崩溃恢复**：恢复父会话上下文时，`repairDanglingToolCalls` 为没有结果的 toolCall 补一条 `isError` 的 interrupted toolResult（挂起审批/提问的锚点跳过）。否则下次 prompt 会把残缺的 toolCall 序列发给 provider，被 OpenAI 兼容端点拒绝。
- **快照**：`get_subagent_activity` 的 items 不含任何 status 条目——快照 record 的 status/report/turns/toolCalls 才是权威值；回放旧 status 会把已判 interrupted 的记录翻成上一轮的 completed 或本轮的 running。
- **协议**：`send_subagent_message { delegationId, text }` → `{ type:"subagent_message_sent", delegationId, ok, resumed }`；消息经 pushActivity 进活动流（落盘 + 广播），面板时间线自然显示。
- **前端去重**：`sendSubagentMessage` 乐观插入 message 块；sidecar 的同条广播按「文本队列」认领占位并跳过。占位由广播消费或 15s TTL 清理——应答先到不能立刻删，否则随后到达的广播会再插一条（重复气泡）。

## 限制

- interrupted 委派只保留最后一个完整轮次（中途快照每轮覆盖；那一轮未完成的半截内容会丢）。
- 一轮都没跑完就中断的委派不可续聊（没有历史可存）。
- 被目录清理裁掉的委派不可续聊（活动文件 5MB 截尾护栏 / 50 文件上限不变；截尾会保留 meta 行）。
- resume 的 token 成本随历史增长（上限 100 条 / 约 2MB 序列化字节，从最新往回取）；无 UI 控碳。
- 子代理 → 父代理主动消息、子代理互发、附件随消息：均不做。

## 测试

- `test/subagent/send-message.test.ts`：steer settled 边界、historySnapshot、历史序列化（toolResult 的 id/toolName 不丢）、旧存档归一、transcript 写盘/回读往返（含多轮 resume 取末行）、无存档拒绝、settle 接 archiveHistory、fake provider 的 resume 上下文 e2e。
- `test/subagent/activity-store.test.ts`：中途快照回落、resume 的 running 标记（回读判 interrupted、旧报告丢弃、writer 不收摊）、旧 transcript 归一、目录清理。
- `test/subagent/subagent.test.ts`：快照 items 不回放 status（record 是权威）。
- `test/agent/context.test.ts`：悬空 toolCall 补 interrupted toolResult（含挂起审批锚点跳过）。
- `test/subagent/subagent-mgmt.test.ts`：工具组清单含 SendMessage。
- `apps/desktop/lib/subagent/subagent-runs.test.ts`：发送占位去重（应答先到/广播后到、同文本连发）、resume 轮计时、过期态。
