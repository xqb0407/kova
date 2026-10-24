# 子代理对话（SendMessage + resume）审查与限制说明

状态：实现已完成并提交（`fed1f0a` 及后续「子智能体并发」设置提交）。
配套设计文档：`docs/agents/subagent-conversation.md`。

本文记录这一轮审查发现的问题、修复方式、当前语义、已知限制与处置决定，供后续维护和提交说明使用。

## 结论

- resume 主链路有 3 个会直接破坏真实使用的缺陷，已修复：历史序列化丢工具配对键、恢复记录未注册进父会话、resume 状态未落盘。
- 另有一批稳定性与 UI 收敛问题（并发 resume、快照回放旧状态、重复气泡、旧报告串轮、崩溃残留）已一并处理。
- 全量回归绿：sidecar 1908、desktop 955、electron 60、pi-protocol 30；三端 typecheck 通过；sidecar 单文件构建冒烟通过。
- 剩余限制均不阻塞当前提交；其中“Task 显式 `model` 覆盖未持久化”最值得在下一轮处理。

## 审查发现与修复

### P0-1 历史存档丢失 `toolResult` 的 `toolCallId/toolName`

**现象**：带工具的子代理结束后，resume 发给 provider 的请求里会出现没有 id 的 tool 消息，OpenAI 兼容端点直接拒绝。

**根因**：旧 `historySnapshot` 只存 `{ role, content }`，把 `toolResult` 顶层的 `toolCallId/toolName` 丢了；`SubagentRun` 构造初始上下文时又只重建 `role/content`，双重丢失。

**修复**：

- [history.ts:16](../../apps/sidecar/pi-agent/src/subagent/history.ts#L16) `toSubagentHistory` 保留消息全部顶层字段；畸形 `toolResult`（无 id）不写入。
- [run.ts:272](../../apps/sidecar/pi-agent/src/subagent/run.ts#L272) `historySnapshot` 按“100 条 + 约 2MB 字节”双上限裁剪，剥掉开头无主的 `toolResult`；字节预算从最新往回取。
- [run.ts](../../apps/sidecar/pi-agent/src/subagent/run.ts) 构造 `initialMessages` 时展开完整对象，再对悬空调用补 interrupted 结果。
- [history.ts:60](../../apps/sidecar/pi-agent/src/subagent/history.ts#L60) `normalizeSubagentHistory` 兼容旧存档：检测到无 id 的 `toolResult` 时，整体剥掉 toolCall/toolResult，退化成纯文本对话——会丢工具细节，但能续聊，而不是一发送就报 provider 错误。

**旧数据影响**：当前数据目录里 6 条带工具的完成记录都是旧形态，只能按纯文本续聊。工具结果本身已不可恢复。

### P0-2 从磁盘恢复的委派 resume 后，父会话与持久化都“看不见”它

**现象**：面板 resume 一条重启前的委派，`TaskWait/TaskList/TaskStop` 找不到它，并发上限漏算；本轮活动只广播不落盘，下次重启即丢。

**根因**：`restoreDelegation` 只把记录放进全局 `delegationIndex`，不在父会话的 `run.delegations`；原进程的 activity writer 已随重启消失。

**修复**：[tools.ts:296](../../apps/sidecar/pi-agent/src/subagent/tools.ts#L296)

- resume 时补登记 `run.delegations.set(record.delegationId, record)`；
- `openDelegationActivity(record)` 幂等重开 writer（同进程不会重复写 meta）；
- 工具侧 `findDelegation` 在内存未命中时按 id 回读磁盘，并只接受 `ownerSession.sessionId` 与当前父会话一致的记录（[tools.ts:89](../../apps/sidecar/pi-agent/src/subagent/tools.ts#L89)）。

### P0-3 resume 开始没有落盘标记，重启后被读成上一轮的“已完成”

**现象**：resume 中途被重启，活动文件最后一条 status 仍是上一轮的 `completed`，回读会把旧报告当成这一轮的结果。

**修复**：

- resume 开始同步写一条 `status:"running"` 标记（[tools.ts:324](../../apps/sidecar/pi-agent/src/subagent/tools.ts#L324)）；
- activity writer 不再把 running 当终态收摊，status 一律同步刷盘（[activity-store.ts](../../apps/sidecar/pi-agent/src/subagent/activity-store.ts)）；
- 回读把文件里的 running 映射为 `interrupted`，并丢弃旧报告（[activity-store.ts:368](../../apps/sidecar/pi-agent/src/subagent/activity-store.ts#L368)）。

### P1-1 快照回放旧 status，覆盖真实状态

**现象**：面板打开时回放 items 里的旧 `completed`/`running`，把已判 `interrupted` 的记录重新翻成“已完成/工作中”，并盖掉输入行。

**修复**：`getDelegationSnapshot` 的 items 不再包含任何 status 条目，快照 `record` 的 status/report/turns/toolCalls 是唯一权威值（[delegation.ts:235](../../apps/sidecar/pi-agent/src/subagent/delegation.ts#L235)）。

### P1-2 并发 resume 拉起两个 SubagentRun

**修复**：[tools.ts:205](../../apps/sidecar/pi-agent/src/subagent/tools.ts#L205) 增加进程内 `resuming` Set，覆盖异步准备段；record 翻成 running 后由 handler/tool 的 status 检查接管。另加“running 时不允许 resume，应走 steer”的守卫。

### P1-3 面板发送：重复气泡与时间线倒序

**现象**：

- 应答先到、广播后到：占位在响应后被删，随后广播再插一条 → 重复气泡；
- 乐观气泡在响应后才插入：广播先到时被跳过，气泡最后才上屏，排到子代理已开始的输出后面。

**修复**：[subagent-runs.ts:471](../../apps/desktop/lib/subagent/subagent-runs.ts#L471)

- 发送前就插入乐观气泡，保证顺序；
- 广播按“文本队列”认领占位（同文本连发各认领各的）；
- 占位由广播消费或 15s TTL 清理，响应先到不立刻删；
- 请求失败时撤回乐观气泡与占位。

### P1-4 旧报告/计时串轮

**修复**：

- resume 开始时清掉上一轮 `report`，`buildSubagentTranscript` 在 running 期间不会渲染旧报告；
- 终态报告以 status 条目为准，失败/中止轮不会保留上一轮报告；
- 新增 `activeSince`：resume 轮的 header 计时从本轮开始算，不把上一轮/上几天的时长算进来；终态总时长仍按原始 `startedAt`；
- 快照查无记录时，面板 header 与消息行都显示“记录不可用”，不再永远转圈；直播活动到达会自愈 `expired`。

### P1-5 启动失败与意外 rejection

**修复**：

- `launchSubagentRun` 同步抛错时，恢复上一轮 status/result/completedAt/reportedToParent，并推一条终态 status，不让 record 卡在 running；
- 意外 rejection 的 settle 结果保留 `turnBase/toolCallBase`，不清零跨轮计数。

### P2 父会话崩溃恢复：悬空 toolCall

**现象**：sidecar 在工具执行中被杀，父转录停在 `assistant(toolCall)` 而没有 `toolResult`；下次 prompt 会把这套残缺序列发给 provider。

**修复**：

- [context.ts:346](../../apps/sidecar/pi-agent/src/agent/context.ts#L346) `repairDanglingToolCalls` 为没有结果的调用补一条 `isError` 的 interrupted toolResult；
- 挂起审批/提问的锚点跳过（`scan.pending` 的 `anchorToolCallId`），否则挂起卡永远无法结算；
- 在 [resolve.ts:742](../../apps/sidecar/pi-agent/src/sessions/resolve.ts#L742) 恢复上下文时应用；
- 合成消息只进内存、不落盘，`persistedSeq` 按构造后的 state 对齐，`jsonlSeq` 独立递增，不会撞号。

### P2 其他健壮性

- 活动文件 5MB 截尾保留首行 meta，避免把整个委派裁到不可寻址；
- 每轮历史写独立 `<delegationId>.history.json`（原子 rename），不追加进活动流，避免加速触发截尾；
- 清理残留的 `.history.json.tmp`；
- 回读对非数组 transcript、畸形 item、畸形 history 条目做防护；
- Task 工具描述删掉“运行时无法纠正子代理”的过期说法，指向 SendMessage。

## 当前语义

### 状态

| 状态 | 含义 |
|---|---|
| running | 执行中；面板输入 = steer，下个模型边界消费 |
| completed / failed / truncated / stopped | 正常终态；有历史即可 resume |
| interrupted | 进程中断（含 resume 中途被杀）；有历史即可再次 resume |
| 无历史 + interrupted | 不可续聊，面板直接显示说明 |

### 持久化

活动文件 `<sessionsDir>/subagents/<delegationId>.jsonl`：

- `meta`：身份 + `ownerSession {sessionId, threadId, cwd}`；
- `item`：turn/thinking/text/tool/message/status；
- `status:"running"`：resume 开始标记；回读映射为 interrupted；
- `status:<终态>`：turns/toolCalls/report/canResume；
- `transcript`：终态历史存档（settle 在终态 status 之前写）。

中途历史文件 `<delegationId>.history.json`：

- 每轮 `turn_end` 覆盖写；最多 100 条 / 约 2MB；
- 回读优先取 transcript 行，缺失时回落此文件；
- 旧形态由 `normalizeSubagentHistory` 归一。

### resume 时序

1. 守卫：非 running、历史非空、无并发 resume；
2. 解析/物化父会话（ownerSession 或工具侧 fallbackOwner），失败给明确错误；
3. 重新解析 definition/model/tools/capabilities；
4. 补登记父会话委派表，重开 activity writer；
5. 保存上一轮终态；record 重置为 running，新建 completion；
6. 写 message 活动 + `status:"running"` 标记；
7. 启动 SubagentRun：`initialMessages = 存档历史 + [user follow-up]`，带 turnBase/toolCallBase；
8. 同步启动失败 → 恢复上一轮终态并推回 status；
9. 结算：先写 transcript，再推终态 status，resolve completion。

### 面板状态

| 条件 | 输入行 |
|---|---|
| running | 显示，提示“下一步送达” |
| 终态 + canResume（有历史 + ownerSession） | 显示，提示“以此会话的上下文继续运行” |
| 终态 + 无历史 | 不显示输入框，直接说明“无法续聊，请重新派发” |
| 快照查无记录（expired） | 不显示输入框，显示“运行记录已过期” |

## 已知限制与处置

| 限制 | 影响 | 成本 | 处置 |
|---|---|---|---|
| Task 显式 `model` 覆盖未持久化 | 续聊可能换回 definition/当前会话模型，行为突变 | 小：record/meta 存 `modelOverride`，resume 传回 | **建议下一轮优先处理** |
| resume 开始后、第一轮结束前被杀，这条 follow-up 不在存档 | 用户需重发一次；窗口很窄 | 小：launch 成功后立刻写一份 `[...历史, 新消息]` 快照 | 可顺手做，非必须 |
| `reportedToParent` 不落盘 | 重启后面板续聊完成的新报告不自动投递；显式 TaskWait 仍会重投 | 中：新增持久化行型 + 投递语义 | 不处理，文档记录 |
| 协议 handler 不校验调用方会话归属 | 本地单用户应用；理论上可按 id 操作其他会话的委派 | 中：tab 需携带当前 thread/session | 不处理，本地信任模型 |
| 旧存档丢工具细节 | 那 6 条记录只能纯文本续聊 | 信息已不存在，无法恢复 | 不处理 |
| 一轮都没跑完就中断的委派不可续聊 | 没有历史可存，UI 已提示 | 无法恢复 | 不处理 |
| `resumeDelegation` 没有真实 `resolveSession` 的 e2e | 回归防护缺口，不是当前行为错误 | 中：需要可注入的父会话/假 provider harness | 后续补测试 |
| 会话模型变更时 resume 继承当前模型 | 用户换模型后用新模型续聊 | 设计选择 | 保持现状；只修显式 `model` 覆盖 |

### 若处理“Task 显式 model 覆盖”的建议方案

1. `DelegationRecord` 增加 `modelOverride?: string`；
2. Task 启动时把 `p.model` 存进 record，`openDelegationActivity` 写进 meta；
3. `readDelegationActivity` / `restoreDelegation` 回读；
4. `resumeDelegation` 调 `resolveDelegateModel(run, definition, record.modelOverride ?? "")`；
5. 模型不可用时给明确错误（或记录降级日志后继承当前模型，二选一，需产品确认）。

## 测试与验证

本轮新增/更新的回归：

- `apps/sidecar/pi-agent/test/subagent/send-message.test.ts`
  - steer settled 边界、historySnapshot 裁剪；
  - `toSubagentHistory` 保留 toolResult 的 id/toolName；畸形结果不写入；
  - 旧存档归一（剥工具对、保留文本）；
  - transcript 写盘/回读、多轮 resume 取末行；
  - 无 history 拒绝 resume；settle 接 archiveHistory；
  - fake provider 的 resume 上下文 e2e（历史 + follow-up、计数带基数）。
- `apps/sidecar/pi-agent/test/subagent/activity-store.test.ts`
  - 中途快照回落；running 标记 → interrupted、旧报告丢弃、writer 不收摊；
  - 旧 transcript 归一；目录清理。
- `apps/sidecar/pi-agent/test/subagent/subagent.test.ts`
  - 快照 items 不回放 status（record 权威）。
- `apps/sidecar/pi-agent/test/agent/context.test.ts`
  - 悬空 toolCall 补 interrupted 结果；已有配对不改；挂起锚点跳过；中途缺结果插入位置正确。
- `apps/desktop/lib/subagent/subagent-runs.test.ts`
  - 应答先到/广播后到的同文本去重；resume 轮 `activeSince` 计时。
- `apps/sidecar/pi-agent/test/subagent/settings.test.ts`
  - 并发设置 normalize/set/init；Task/resume 共用运行时上限，用实际运行数判定。
- `apps/desktop/lib/pi/subagent-concurrency-input.test.ts`
  - 设置页空输入回退当前值；合法值取整并钳到共享范围。

验证命令与结果：

```bash
# sidecar
cd apps/sidecar/pi-agent
bun run typecheck          # 通过
bun test                   # 1908 pass / 0 fail
bun run build              # 单文件构建 + smoke check 通过

# desktop
cd apps/desktop
bun run typecheck          # 通过
bun test lib               # 955 pass / 0 fail

# electron
cd apps/electron
bun run typecheck          # 通过
bun test                   # 60 pass / 0 fail

# protocol
cd packages/pi-protocol
bun test                   # 30 pass / 0 fail
```

## 真机验收清单

1. 旧线程里悬空的 TaskWait：直接发一条新消息，应能继续，不再触发 provider 的 tool 序列错误。
2. 截图里的 `754e6d0e`（旧记录、无中途历史）：面板应显示“无法续聊，请重新派发”，不再出现可发送却报错的输入框。
3. 新跑一个带工具的子代理，完成后在面板追问：应带历史续跑，报告更新，tab 不换。
4. 子代理运行中发消息：应作为 steer 在下一步送达，不打断、不重开。
5. 委派运行中重启 sidecar：重启后应显示“已中断”；若至少完成过一轮，输入行可用，resume 带最后一轮上下文。
6. 父代理 `SendMessage` → `TaskWait`：应能等到 resume 后的新报告。
7. 检查面板计时：resume 轮从本轮开始计时，不显示上一轮累计的巨大秒数。

## 文件索引

| 文件 | 作用 |
|---|---|
| `apps/sidecar/pi-agent/src/subagent/history.ts` | 历史序列化 / 旧存档归一 |
| `apps/sidecar/pi-agent/src/subagent/run.ts` | SubagentRun、每轮快照、初始上下文、字节上限 |
| `apps/sidecar/pi-agent/src/subagent/tools.ts` | Task/SendMessage/resume、注册、并发闸、running 标记 |
| `apps/sidecar/pi-agent/src/subagent/activity-store.ts` | 活动 JSONL、中途历史、回读、截尾、清理 |
| `apps/sidecar/pi-agent/src/subagent/delegation.ts` | 注册表、结算、快照、TaskWait 原语 |
| `apps/sidecar/pi-agent/src/agent/context.ts` | 父会话悬空 toolCall 修复 |
| `apps/sidecar/pi-agent/src/sessions/resolve.ts` | 恢复上下文时应用修复 |
| `apps/desktop/lib/subagent/subagent-runs.ts` | 运行 store、乐观发送/去重、快照水合、计时 |
| `apps/desktop/components/agent-thread/agent-panel/subagent-tab.tsx` | 面板 header / 输入行 / 不可续聊说明 |
| `apps/desktop/components/assistant-ui/elements/tool-row.aui.tsx` | Task 行运行态/过期态 |
| `packages/pi-protocol/src/notifications.ts` | 活动条目协议（message/canResume） |
| `docs/agents/subagent-conversation.md` | 功能设计与使用语义 |
