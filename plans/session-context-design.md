# 设计文档：pi-kova 会话与上下文管理层（v1，参考 ZCode 架构）

> 定稿于 2026-09-22。定位：目标态设计 + 分期落地路线。概念骨架取自 ZCode 的会话管理层（状态机 / 冻结契约 / 水印同步 / 挂起交互 / 错误归因），数据模型对齐 pi 上游 0.85.1（会话树 v3 条目行、AgentLane/operation 语义），实现落点全部指向现有文件。
>
> **明确不做的**：全局 ConversationSnapshot 对象改造、`@earendil-works/pi-protocol` CBOR 帧、整体采纳 AgentHarness（storage format 4 未稳定，`watchSession`/search/remote 均为 stub）。
>
> 背景调研：ZCode 会话管理层分析（zread.ai/zai-org/ZCode 第 7 章）、pi-main 源码（= 已锁定依赖 0.85.1：coding-agent 会话格式文档、agent harness/tool-durability/assistant-durability 规格、session-backends/sqlite-node）。

## 1. 架构总览：三层映射

| 层 | ZCode 对应物 | 本项目落点 |
|---|---|---|
| 契约 | ConversationSnapshot v4（zod 冻结、A/B 分区） | 新包 `packages/pi-protocol`：**按子系统的小快照契约**（队列/交互/上下文各一份），不做全局快照对象；A 区语义 = "全量快照整字段替换、禁深合并"，B 区语义 = "帧流追加 + seq 检缺口" |
| 编排 | IZCodeSessionService 门面 | sidecar `sessions/registry.ts` + `protocol/prompt-pipeline.ts`（已具雏形：驻留治理、turn 广播、串行链） |
| 持久化 | SQLite 任务索引 + 记忆文件 | JSONL 转录 = 事实源；SQLite = 投影索引（Rust 独占写，经 hostdb RPC） |

数据流不变：UI → Tauri invoke / WS → sidecar NDJSON → 流式 `UIMessageChunk` + 无 id 通知帧。

## 2. 会话状态机（派生枚举，不新增引擎状态）

ZCode 有显式 `sessionPhase`；不引入平行真相，把已有信号**收敛成一个可广播的派生相位**，在 `registry.ts` 单点计算：

```
draft      未物化（无 JSONL / resolveSession 未跑）        ← 现有懒建
prewarming resolveSession 进行中                          ← 现有
running    activeTurns.has(threadId)                      ← 现有
awaiting   存在未结算 PendingInteraction（§4）             ← 新增判定
idle       驻留但无在跑轮次                                ← 现有
evicted    被 LRU 驱逐；JSONL 为唯一真相，打开即恢复        ← 现有
```

- 新通知帧 `session_state { sessionId, phase, eventSeq }` 取代散落的 `turn_changed`（保留旧帧一个版本周期做兼容）。
- 驱逐保护谓词 `isEvictable` 的审批项从"内存 size>0"改为"有未结算 interaction 行"（跨重启成立）。

## 3. 事件水印与同步契约（ZCode seq/revision 的轻量版）

**原则**：seq 只负责"发现漂移"，修复一律回拉权威接口（不建帧重放——上游远程方案 C1 未决，自研重放不成比例）。

- sidecar：per-session `eventSeq`，初值 = 转录最大行 `seq`（重启连续）；注入点收口在 `protocol/stream.ts` 的 `sendEventChunk` 与通知 `send`（带 sessionId 的帧）。
- desktop：`lib/pi/pi-seq-guard.ts`，per-session `lastSeq`；跳号 → 按帧类型防抖回拉：

| 缺口帧 | 回拉 |
|---|---|
| data-queue-state | `get_queue_state` |
| 交互发起/结算 | `list_pending`（§4） |
| session_state | `list_running` |
| data-planningState | `get_planning_state` |
| context_changed | `context_info`（§7 镜像回填） |

- `WsPiChannel` 重连后全量拉平，替换现在"清 resumable 回落历史"的盲重置；`TauriPiChannel` 同款。首次见号只登记不报警（水合期防误报）。
- ~~门禁：等 queue-v2 分支合并后开工~~ **已解除（2026-09-22，e602038 合入并简化为四操作模型）**——本阶段触碰 `sendEventChunk` 与 `pi-queue.ts` 读侧。

## 4. PendingInteraction（ZCode 挂起交互 + 上游 operation 语义的薄版）

```
PendingInteraction { interactionId, kind: "permission" | "question",
  anchorToolCallId, payload(可辨识联合), createdAt }
```

- ✅ **发起即落盘**：转录追加 `pending_interaction` 行，结算追加 `interaction_resolved` 行（模式 = 已有的 `queue_state` 行事件溯源，同款**不占 seq**；语义 ≈ 上游 tool-durability 的 `outcome_ready` 前态，命名对齐留升级通道）。三个发起点（modes 审批 / question 工具 / MCP 审批）统一走 `sessions/pending-interactions.ts` 台账；转录扫描配对是权威源，内存台账只管驱逐阻塞与重启回放。
- ✅ `get_history` 回放未结算项 + `list_pending` 按会话/线程权威拉取 → 刷新/驱逐恢复后挂起卡不再丢（解决 `registry.ts` 注释自证的"恢复路径带不回审批态"）；`isEvictable` 审批判据随之改为"有未结算交互"（跨重启成立）。重启后点旧卡的陈旧结算走台账兜底：照写结算行、解阻塞，不抛幽灵错误。
- ✅ 结算命令 `tool_confirm`/`question_answer` 原形状保留，新增按 `interactionId` 寻址。
- ✅ 前端 `pi-tool-approval.ts`/`pi-question.ts` 合并为 `pi-interactions.ts` 单一 store（渲染组件不动，旧模块变薄再导出）；`list_pending` 应答整表替换（A 区语义），带在途结算豁免防刚点掉的卡被滞后快照复活。审批/提问发起帧纳入 §3 水印（kind=`pending`，跳号回拉 `list_pending`）。
- `autoResolution`（宽限倒计时自动批准）schema 预留 `expiresAt?`，实现推后（默认关）。

## 5. 队列（现有 v2 收编进契约包，不加新状态）

现引擎（`sessions/prompt-queue.ts`：线程隔离 FIFO、上限 5、steer/promote/cancel、快照广播+落盘）设计已对齐 ZCode 的 queueState + 输入路由（enqueue / steer=独有优势 / promote=立即发送）。e602038 已将队列定版为四操作（默认排队/并入当前轮/立即发送/删除），快照 version:2 无 paused/失败计数字段。本期只做三件事：

1. ✅ `QueueSnapshot` 类型迁入 pi-protocol（两端 import，删手抄镜像）；
2. ~~暂停闸收口后快照加 `pauseReason?: "manual" | "error"`~~ **作废**：队列不再存在暂停态，ZCode 的 pauseReason 语义无对应物；
3. 队列帧纳入 §3 水印。

前端 R1/R2/R3 摘除/回填规则不动——那是 assistant-ui/AI SDK 技术栈的必要税。

## 6. 转录行 schema（对齐上游会话树 v3 的"线性子集"）✅ M4 落地（2026-09-22）

行格式一次定版（读端跳过未知行 = 天然向前兼容），新增/保留：

```
message / compaction / queue_state         （现有）
pending_interaction / interaction_resolved （§4 新增）
model_change { provider, modelId }         （上游同名行：替代 SQLite 偏好镜像的真值来源）
thinking_level_change { level }            （上游同名行："思考等级重放"用行历史回答）
session_info { name }                      （rename 落转录本体，索引退为投影）
header.parentSession?                      （fork 溯源；文件复制行为本期不变）
```

**历史分页**（ZCode rowsWindow 的对应物）：✅ `get_history` 加 `tail?/beforeSeq?`，应答带 `firstSeq/lastSeq/hasMore`；缺省全量不破旧端。游标就用行 `seq`。compaction/queue 行仍需全遍扫描，`scanTranscript` 保持单遍、输出截尾（compaction 不进窗——`throughSeq` 锚定语义要求全量交付）。桌面端首屏已按 `tail=800` 请求；向上翻页 UI 入口留 M 后续（`hasMore` 已在线上）。

**上下文设定行（M4）**：✅ 三类行 + `parentSession` 落地。定稿与初稿的差异只有一处字段名：`thinking_level_change` 的行内字段抄上游实名 `thinkingLevel`（初稿写作 `level`——§11 决策 4"字段名抄上游"优先于本文笔误）；三类行都带可选 ISO `timestamp`（写端盖 `new Date().toISOString()`，读端不用、纯溯源留档，对齐上游条目同名字段）。行契在 `pi-protocol/transcript.ts`（loose 透传：思考档位不锁枚举，上游未来加档不改契约）；sidecar 侧 writer 三件套 + `scanTranscript` 单遍 last-wins 回放，事件溯源行不占 seq（queue_state/pending_interaction 同款机制）。
- ✅ 真值迁移：模型 = 转录行 > SQLite 偏好行（旧会话无行的兜底；偏好行退为投影，仍随 set_model 同步维护，不引入新分叉）> 全局 kv。思考档位此前**只有全局选择**，本期新增"重开会话延续上次档位"（行回放，回落全局；行值先过 `THINKING_LEVELS` 校验，被收窄/下线的档位不炸恢复路径）。自动化 turn 的 `getAutomationPolicy` 闸保留——行真值同样只约束真人会话。落行点：`set_model`/`set_thinking` 逐驻留会话广播时落行；改名统一入口 `setSessionName`（先落 `session_info` 行再写索引 title 投影——崩溃窗口内真值不落后于投影），rename_session 与 AI 标题总结共用。空串 name = 显式清名，与无行的 `null` 可区分。
- ✅ `header.parentSession`：fork 写源会话 **id**（上游同名字段取文件路径——我们会话身份是 id 不是 path，抄名不抄取值法）。分支复制过滤器不动（仍只放 message/compaction）：设定行不进分支，fork 出的新会话按全局/偏好默认打开，与"文件复制行为本期不变"一致；溯源语义由 header 承载。
- ✅ 互测（§10 门禁）双向：(a) 上游 docs 原版 v3 条目行（带 id/parentId 的树形态 + `type:"session"` header）逐字喂我们的 `scanTranscript`——三个设定值全读得出，外来 message 行（无 seq）按未知行跳过不污染消息重建；(b) 我们 writer 的逐行输出喂 vendored 的上游 `getSessionContextSettings`（自 session-manager.ts 逐行保留、仅入参类型放宽，出处注释在测试内）回放——得同一设定。契约测试同时锁定上游文档示例行能被 pi-protocol loose schema 收字段名。

## 7. 上下文窗口跟踪（ZCode contextWindow 字段的拉转推）✅ 已落地（2026-09-22，M3）

- 阈值/公式/生成（`agent/context.ts`，已对齐 PI-Desktop + fresh_window 兜底）不动。
- ✅ 轮次收尾点 `noteActiveTurn(false)`/`markTurnEnd` 后（`prompt-pipeline.ts` dispatchPrompt finally）推 `context_changed { sessionId, usedTokens, threshold, contextWindow, cacheHitRatio }` 带水印帧。定帧时实际比初稿多带两个字段：`sessionId`（水印路由必需）与 `contextWindow`（占用环要"占用/容量"口径，只有 threshold 画不出环）。resolveSession 失败没有 run 的轮不推（finally 里 `running.get` 拿不到即弃，协议测试锁定"不新增行"）。未驻留会话仍走现成 `context_info` 只读投影拉取（不物化 Agent——比 ZCode 的常驻快照更省）。
- ✅ desktop `pi-context.ts` 改"推送镜像 + 拉取兜底"：per-thread `PiContextMirror`（帧按 sessionId 进，经 `piSessionRegistry` 反查线程）；`eventSeq ≤` 已登记号的帧丢弃（重放/换代防护），拉取写入（`eventSeq:null`）总是生效并解除该门槛；通道订阅惰性一次，旧通道无 `subscribeContextChanges` 时镜像退化为纯拉取（首挂水合 + popover 打开），正确性不依赖推送。seq-guard 缺口回拉 `refreshContextMirror`（kind=`context`）。远程端 `remote.rs` 广播白名单已放行 `context_changed`。
- ✅ UI（`context-button.tsx`）：composer 占用环与 title 改镜像驱动**常显**"上下文占用 X% · 距自动压缩 Y%"（越过阈值显式文案并染琥珀色）；popover 打开才拉完整 `context_info`（分项/模型名/miss 统计不在推送里）并顺带校准镜像；完整读数未达而有镜像时 popover 显镜像摘要。

## 8. 错误归因（ZCode ErrorAttribution → 复用已有分类器）✅ 已落地（2026-09-22，M3）

- ✅ 线形加性上线：`{ type: "error", errorText, error?: { code, source: "provider"|"network"|"tool"|"runtime", retryable, statusCode? } }`；`errorText` 保留兜底，旧端忽略 `error` 不破（`statusCode` 仅 100–599 合法整数才携带）。
- ✅ 出口实际不止初稿的两个，全部覆盖：`protocol.ts` handleLine catch、`dispatchPrompt` catch、`stream.ts` 两个 error chunk 点（`sendErrorChunk` 新出口收口），以及 `prompt-pipeline.ts` 逐点（含盘点时新发现的 overflow 恢复压缩失败、超限落盘、run 异常共 3 处）。语义分档：provider 流原生错误走默认可重试档（不透明串 → `PROVIDER_ERROR/retriable:true`）；管理与 prep 档出口传 `opaqueFallback:"runtime"`（不透明串 → `RUNTIME_ERROR/false`，不让运行时毛病被误判成"重试就好"）；结构错误手搭载荷（`UNKNOWN_MESSAGE_TYPE`/`QUEUE_LIMIT`（可重试）/`MODEL_NOT_CONFIGURED`/`CONTEXT_COMPACTION_FAILED`/`CONTEXT_TOO_LARGE`）；JS 内建异常名（TypeError 等）直判 `RUNTIME_ERROR/false`。分类器扩 `ErrorSource` + `opaqueFallback` 选项，`toWireError` 做 Classified→线形换算（单测锁定"opaqueFallback 只换不透明桶"）。
- ✅ desktop 消费：AI SDK 可能丢 error chunk 上的未知字段，故 transport 在转发前把 `error` 转成 **`data-errorAttribution` part** 先行入列（data part 落 `message.content`，刷新回放同生，同 data-retry/data-stopped 先例）；`MessageError` 检 part `retryable:true` 才渲染重试按钮（`ActionBarPrimitive.Reload` 重发最后一条用户消息，走正常请求流即继承 provider-retry 的预算语义）。`pi-bridge.PiResponse` error 成员同步补可选 `error` 字段（类型保真）。
- `errorPhase`（prepare/connect/stream/parse…）暂不加——分类器还没有这个维度，先吃 source/retryable 的收益。

## 9. 兼容性铁律

协议只增不改；未知字段两端 passthrough；出帧 dev/test parse-throw、prod 记 `logErr` 放行；单端回退旧版本 = 忽略未知帧型。

## 10. 分期落地

| 里程碑 | 内容 | 工期 | 门禁 |
|---|---|---|---|
| M1 最小闭环 | §1 契约包 ✅（2026-09-22 完成，两端接入+测试+构建全绿）+ §3 水印（含 §2 的 session_state 帧与 §5-③） | 4–7d | 门禁已解除（queue-v2 已合入 e602038） |
| M2 持久可恢复 | §4 挂起交互 ✅ + §6 行 schema 定版与分页 ✅（2026-09-22 完成） | 5–8d | 门禁达成：刷新/重启后挂起卡经 `get_history.pending` + `list_pending` 双路恢复；首屏转录经 `tail=800` 封顶（`hasMore` 上线，UI 翻页入口待接） |
| M3 可观测量 | §7 上下文推送 ✅ + §8 错误归因 ✅（2026-09-22 完成） | 4d | 门禁达成：retryable 重试 UI（errorAttribution part 判 `retryable:true` 显重试按钮）；占用常显（占用环/title 由 context_changed 推送镜像驱动，缺口回拉与首挂水合兜底）。全绿：pi-protocol 18/18、sidecar 748/748+build、desktop 199/199+tsc、cargo check |
| M4 上游对齐 | §6 的 model_change/thinking_level_change/session_info 行 + header.parentSession ✅（~~§5-② pauseReason~~ 随队列四操作定版作废；2026-09-22 完成） | 2d+ | 门禁达成：与上游 v3 解析器**双向**互测（上游文档原版行→我方回放 / 我方 writer 输出→vendored `getSessionContextSettings` 回放），另补 handler 落行断言（set_model/set_thinking 驻留会话、rename 行+投影、fork parentSession 与设定行不复制）。全绿：pi-protocol 22/22、sidecar 756/756+tsc+build；desktop 无 M4 改动，tsc+199/199 复验；无 Rust 改动（cargo 免跑） |

M2 内部两线可并行；M3 依赖 M1。回滚面：每帧型独立加性，任意里程碑后可停在原地。

## 11. 决策记录（为什么不照抄 ZCode）

1. **不做全局快照对象**：本项目是"事件流+权威回拉"形态且本地进程串行管理命令，全局快照要重做 transport/adapter/queue/history 四线；§3 水印以约 1/5 成本拿到同等鲁棒性。
2. **seq 不建重放**：对齐上游 C1 未决的现实，检漂移+回拉即可收敛。
3. **状态机是派生视图不是引擎**：ZCode 状态机绑定 SQLite 行可写性；本项目的等价约束已由 `isEvictable`/`activeTurns` 承担，加枚举只加广播语义不加真相源。
4. **行格式抄上游不抄 ZCode**：pi v3 条目行是依赖包的原生语言，ZCode 的 rowsWindow/Zone 分区是私有协议形态——前者保证未来换 AgentHarness 底盘时转录可读。
