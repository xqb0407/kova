# 子 agent 活动持久化设计（回放版）

> 状态：待实现。设计已定，无阻塞项。

---

## 0. 人话版（不看代码也能懂）

现在子 agent 干活的**过程**（它想了什么、调了什么工具、写了什么字）只活在内存里。
应用一重启（或这个子 agent 太旧被清掉），打开右侧"子智能体"面板就只剩一句
"记录已过期"——只有最终报告还留在主对话里。

这套改动做的事情很简单：**让子 agent 边干边把过程写到一个小文件里**。
这样重启之后再打开面板，能看到它完整的思考、工具调用、正文和报告，
只是正在跑的那个会被标成"已中断"（因为进程没了，它不可能还在跑）。

就三件事：
1. **存哪**：每个子 agent 一个文件，`sessions/subagents/<它的id>.jsonl`。
2. **怎么存**：边干边写，但**攒一下再写**（不是每打一个字就写一次盘），
   所以又快又不伤硬盘。
3. **丢了怎么办**：重启后从文件里读回来，面板照常显示。

---

## 1. 背景与问题

| 现状 | 问题 |
|---|---|
| `DelegationRecord.activity` 是内存数组，上限 400 条（[delegation.ts](../apps/sidecar/pi-agent/src/subagent/delegation.ts#L34-L62)） | sidecar 重启即全丢 |
| `delegationIndex` 是内存 Map | 重启即丢，`get_subagent_activity` 查无记录 |
| 满 400 条时优先丢 `thinking/text` 的 `delta` | 长任务的活动会被裁掉（内存快照不完整） |
| 只有 trace 落盘（[storage.ts](../apps/sidecar/pi-agent/src/storage/storage.ts#L32-L36)） | trace 是每次 run 一行摘要树，**不是消息流**，面板无法据此回放 |
| 父转录保留 Task 的结果文本 | 只有最终报告，中间过程不在 |

结论：子 agent 的**中间过程目前没有任何持久化**，重启后不可回放。

---

## 2. 目标与非目标

**目标**

- sidecar 重启 / 记录被裁剪后，`get_subagent_activity` 仍能返回完整活动流。
- 面板无需改动即可完整回放（复用现有 item 形状与前端 reducer）。
- 崩溃丢失率可控且可解释（见 §5）。
- 写入不阻塞 agent 主循环（沿用 trace/otlp 的"零阻塞 + 失败静默"纪律）。

**非目标（明确不做）**

- **不做续跑**：重启后不恢复执行链，未完成的委派只是"可回放的历史"，不自动接着干。
- 不把子 agent 活动写进父 session JSONL（会污染被整份读取的转录）。
- 不引入新的存储引擎（SQLite/LevelDB 等）；复用 JSONL + 现有的写入纪律。
- 不加"优先级"字段（现有模型无此概念，回放用不上）。

---

## 3. 存储格式

**位置**：`<sessionsDir>/subagents/<delegationId>.jsonl`（新增 `storage.subagentPath(id)`）。
每个委派一个文件，一行一条记录，append-only。

**记录形状**：直接复用既有的 `SubagentActivityItem`（[types.ts](../apps/sidecar/pi-agent/src/types.ts)），
不新造格式——它已经带了"消息类型 + 处理状态 + 时间戳"：

```jsonl
{"kind":"turn","n":1,"at":1790876127837}
{"kind":"thinking","op":"start","id":"c0","at":1790876127900}
{"kind":"thinking","op":"delta","id":"c0","delta":"先看目录结构……","at":1790876128200}
{"kind":"thinking","op":"end","id":"c0","at":1790876129000}
{"kind":"tool","op":"start","toolCallId":"a1b2","toolName":"bash","argsSummary":"ls -la","at":1790876129100}
{"kind":"tool","op":"end","toolCallId":"a1b2","toolName":"bash","resultSummary":"total 48","failed":false,"at":1790876129800}
{"kind":"status","status":"completed","turns":3,"toolCalls":8,"report":"……","at":1790876143341}
```

字段对应需求：

| 需求项 | 承载字段 |
|---|---|
| 消息类型 | `kind`（turn / thinking / text / tool / status） |
| 处理状态 | `tool.done`、`tool.failed`、`status.status`（终态） |
| 时间戳 | `at`（所有条目都有） |
| 内容 | `text/thinking.delta`、`tool.toolName/argsSummary/resultSummary`、`status.report` |

---

## 4. 写入路径

`pushActivity(record, item)`（[delegation.ts](../apps/sidecar/pi-agent/src/subagent/delegation.ts#L52-L62)）
在「进内存缓冲 + 广播」之外，**再同步入队**到该委派的 writer。

writer 的职责是**合并 + 批量**：

1. **增量合并**：相邻同 `(kind, id)` 的 `delta` 合并成一条再写。
   —— 这是控制写入量的关键：**token 级内容不逐条落盘**。
   （回放语义不变：前端 reducer 对合并后的 `delta` 与逐条 `delta` 一视同仁。）
2. **批量刷盘**，任一条件触发：
   - 距上次刷盘 ≥ **250ms**；
   - 未刷条目 ≥ **64 条**或 ≥ **32KB**；
   - 收到**终态事件**（`kind:"status"`）→ **立即同步刷**。
3. **零阻塞纪律**：入队是同步内存操作；刷盘失败只 `logErr`，绝不抛回 agent 主循环
   （同 trace.ts / otlp-exporter）。
4. 写闩：同一个委派的刷盘串行化，避免并发写交错。

---

## 5. 崩溃丢失率保证

**定义**（必须先明确定义，否则"0.1%"不可证）：
> 丢失率 = 崩溃时丢失的记录数 / 该委派已产出的记录数。

**保证**：

- 崩溃最多丢失**当前未刷批次**（≤250ms 内的增量，且已被合并成极少条）。
- 终态（报告）**强制同步刷**，因此**结果永不失**。
- 推论：委派运行时长 ≥30s 时，边界损失占比远低于 0.1%；
  运行越久越低。**短任务（<1s）不承诺此指标**——其记录本身就少，
  单批次损失按条数可能 >0.1%，这是刻意接受的（短任务过程价值低）。

**读取端容错**：末行可能撕裂 → 跳过 JSON.parse 失败的行（同 `readTraceRuns`）。

---

## 6. 恢复流程

```
get_subagent_activity(delegationId)
  ├─ 内存命中 → 现有行为（不变）
  └─ 内存未命中 → 读 <sessionsDir>/subagents/<id>.jsonl
        ├─ 文件不存在 → 维持现状（前端置 expired 空态）
        └─ 文件存在 → 重建 record + items 原样返回
             └─ 持久化时为 running 的委派 → status 记为 interrupted
```

- **前端 store 逻辑零改动**：`hydrateSubagentSnapshot` 走同一个 RPC，store 的 `applyItemTo`
  照常回放（[subagent-runs.ts](../apps/desktop/lib/subagent/subagent-runs.ts)）。
  （**唯一**的前端改动是状态标签映射补一个"已中断"，见 §8。）
- **触发时机**：懒加载——只在 `get_subagent_activity` 内存未命中时读盘，
  不做启动期全量预热（省启动时间，够用）。
- **`interrupted` 状态**：新增终态值，表示"进程没了、没跑完"。
  连带 3 处标签映射：sidecar `types.ts`、桌面 `pi-channel`/`pi-bridge` 的镜像、
  面板 `subagent-tab.tsx` 与 `tool-row.aui.tsx` 的 `STATUS_LABEL`。

---

## 7. 保留与护栏

- **单文件体积**：> 5MB 时截尾保留 1MB（同 `trimTraceFile` 的策略与阈值），防止长任务把磁盘打满。
- **文件数量**：**按目录盘点**（不是按内存里的 `run.delegations`——重启后内存是空的，
  必须扫盘才知道有哪些文件）：目录内文件超过上限时删最旧的 `mtime`，
  上限对齐现有 `MAX_RETAINED_DELEGATIONS = 50`
  （[delegation.ts](../apps/sidecar/pi-agent/src/subagent/delegation.ts#L31-L32)）。
  触发时机：sidecar 启动时一次 + 每次委派 settle 时一次。**只在无委派在跑时清理**，
  避免删掉正在写的文件。
- running 的委派文件永不淘汰。

---

## 8. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `apps/sidecar/pi-agent/src/storage/storage.ts` | 新增 `subagentPath(id)` |
| `apps/sidecar/pi-agent/src/subagent/activity-store.ts` | **新增**：writer（合并 + 批量刷盘）+ reader（回读重建） |
| `apps/sidecar/pi-agent/src/subagent/delegation.ts` | `pushActivity` 追加入队；`getDelegationSnapshot` 未命中时读盘回建 |
| `apps/sidecar/pi-agent/src/types.ts` | `SubagentRunStatus` 增 `interrupted` |
| `apps/desktop/lib/pi/pi-channel.ts`、`pi-bridge.ts` | 状态镜像增 `interrupted` |
| `apps/desktop/components/agent-thread/agent-panel/subagent-tab.tsx`、`components/assistant-ui/elements/tool-row.aui.tsx` | `STATUS_LABEL` 增"已中断" |

前端 store / 面板渲染逻辑**不动**。

---

## 9. 测试与验收

单测（bun test，风格对齐 `trace.test.ts`）：

1. **合并器**：连续 `delta` 合并为一条；`start`/`end` 边界不误并；
   不同 `(kind,id)` 不混。
2. **批量刷盘**：达条数/字节阈值即写；终态事件强制同步刷；
   写入失败不抛（mock 抛错，断言调用方不受影响）。
3. **回读重建**：写入后再读，`items` 与 `record` 与原始一致；
   末行撕裂被跳过；`running` 记录回读后为 `interrupted`。
4. **护栏**：单文件超限截尾；文件数超上限淘汰最旧的已完成项。

手动验收：

1. 跑一个多工具委派（不结束）→ 杀掉 sidecar → 重开 → 打开面板：
   能看到完整的思考/工具/正文，状态显示"已中断"。
2. 跑一个正常结束的委派 → 重启 → 面板完整回放，报告仍在，状态"已完成"。
3. 观察写入量：一个长任务的 `subagents/<id>.jsonl` 体积远小于逐 token 落盘。

---

## 10. 风险与开放问题

- **`interrupted` 的传播面**：新增终态值需要 sidecar 与桌面的类型镜像同步改；
  漏改一处会导致状态标签回落为原始英文值（不致命，但难看）。实现时以
  `grep SubagentRunStatus` 全量核对。
- **文件清理的时机**：启动 + settle 两处触发；进程频繁崩溃时未结算的文件可能
  暂时超出上限，等下次启动清理——可接受（单文件有 5MB 护栏）。
- **回放的字体/顺序**：合并后的 `delta` 与原始逐条 `delta` 在 reducer 里等价，
  已由现有单测覆盖；若将来前端改为"按 delta 计数"渲染，需要重新评估。

---

## 11. 明确不做

- 不续跑、不恢复执行。
- 不写父 session JSONL。
- 不引新存储引擎。
- 不加优先级字段。
- 不为短任务（<1s）承诺 0.1% 丢失率。
