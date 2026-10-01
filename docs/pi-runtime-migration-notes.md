# react-pi 迁移核对笔记

> 阶段 2 建立的工具卡/消息形状核对清单。每条记录「react-pi 投影层产出的形状 →
> 现有 UI 消费的形状」，差异收敛在 projection/client 层，不改 UI 数据契约。

## 阶段 2（快照路径 + 降级轮询）

### 已接通
- **线程身份**：threadId = pi sessionId（metadata.id）。usePiRuntime controller、
  sidecar prompt/abort 的 running 键、ResumeRunningThread 回切目标全部同键。
- **发送**：`controller.sendMessage` → `TauriPiClient.sendMessage` → `pi_prompt`
  （threadId=sessionId、sessionId 定靶、cwd=工作区胶囊）。steer/followUp 二态：
  `streamingBehavior:"steer"` → `steer:true`；followUp → 普通 prompt（忙时 sidecar 自动排队）。
- **终态落定（降级）**：chunk-batch 收尾帧观察（finish/error/start 前缀预筛，
  只解析在飞 requestId 的行）+ 运行期 1.2s 快照轮询（指纹去重：seq|status|条数|末条 ts|审批数）。
  pending（发送后等起跑）有 90s 安全上限。
- **审批**：转录 pending_interaction(permission) 行 → thread_snapshot 里映射为
  confirm 型 hostUiRequest（id=approvalId，toolCallId 锚定）→ 投影层挂到工具卡。
  `respondToHostUiRequest` → `tool_confirm`。question 类不映射（阶段 4b）。
- **列表**：list_sessions + list_running 合并；status=running 直接来自 activeTurns。

### 已知差异 / 暂缺（阶段 3/4 处理）
| 项 | 现状 | 去向 |
|---|---|---|
| 流式渲染 | 无（轮询快照按消息行增量落定） | 阶段 3 delta 化事件流 |
| 文档附件 | `buildPiSendInput` 只透出 text+image，file part 被丢弃 | 阶段 4 扩展 vendored ThreadController |
| 队列栏 | state.queue 仅乐观镜像；快照不带 queuedMessages；clearQueue 为 no-op 占位 | 阶段 4a（queue_cancel/promote/steer 接线） |
| thinking_seed / subagent 旁路 | 未接（data-* 通道只在旧链路） | 阶段 4c |
| thinkingLevel 会话定靶 | `set_thinking` 全局广播（sidecar 无会话形参） | 阶段 4 |
| 压缩分隔线 | 投影 compactionSummary → 独立 DataMessagePart（与旧 data-compaction 渲染器名不同），分隔线样式可能回退为默认 | 阶段 4d 逐一核对 |
| 图片/检查点 data-* part | 快照路径不重建（旧路径 get_history 重建 data-image/data-compaction） | 阶段 3/4 |
| seq 水位 | thread_snapshot 用 peekEventSeq 现读；从未盖章过的会话不带 seq（冷读） | 阶段 3 事件盖章后自然对齐 |
| running 键混跑 | 旧链路发起的轮以本地 threadId 为键，新链路 abort/steer 找不到它（仅迁移期并存时出现） | 阶段 5 删旧链路后消失 |

### 形状核对（pi-agent-core 0.99.2 vs react-pi verified 0.78–0.80）
- 消息：转录 agent 行直出。pi-ai 0.99.2 Message 各 role 均带 `timestamp`（types.d.ts
  L365-497），与镜像一致；user/assistant/toolResult/bashExecution/custom 逐字段对上。
- compactionSummary：转录无此 role 的消息行——由 thread_snapshot 从 compaction
  检查点行重建（summary/tokensBefore/timestamp），语义与上游 branchSummary 家族对齐。
- 内容块：toolCall `{type,id,name,arguments}`、image `{type,data,mimeType}`、
  thinking `{type,thinking}`——0.99.2 与镜像同形（落盘前 normalizeBlock 已保证必备字段）。
- 未知 role/事件：镜像 union 开放 + reducer default 分支 bump seq 后台刷新，天然容忍。

## 阶段 3（delta 化原生事件流 + 快照自愈）

### 已接通
- **thread_event 帧（3a）**：sidecar `wireSessionEvents(run)` 订阅全部 AgentEvent
  翻译为 `{type:"thread_event", sessionId, eventSeq, event}` NDJSON 帧（不带 `id`，
  避免被 Rust stdout 泵误做请求-响应配对）；`is_flush_line` 对其返回 false，
  走 pi-chunk-batch 合帧批处理。remote.rs broadcast 白名单不含 thread_event
  （远程通道阶段 5c 再接）。
- **delta 化（O(n²) wire 治理）**：message_update 剥离 `partial` 重负字段只发
  assistantMessageEvent；toolcall_start 附加抽取的 `{id,name}`；done/error 为
  每流一帧终态带完整 message；tool_execution_update 整段限频
  （250ms/toolCallId + 256KB 硬丢弃，end 恒发）。
- **客户端重建（3b）**：TauriPiClient per-thread StreamAcc（message + toolcall
  参数 JSON 缓冲），按 contentIndex 就地补丁重建 partial 再 dispatch
  （reducer 只消费完整 message；vendored 层不读 assistantMessageEvent）。
- **快照权威自愈（3c）**：thread_snapshot 并入在飞 partial（peekPartial 台账，
  message_start 置/message_update 更/message_end 与 agent_end 清）；dispatch
  快照时 running 且末条 assistant → 以快照 partial 为重建基底（线程中途打开），
  陈旧快照（seq 落后）不回退基底。
- **轮询退役**：阶段 2 的 1.2s 快照轮询删除；保留收尾帧观察（inflight
  requestId→sessionId，finish/error 即时 refreshNow）兜底 prompt 起跑前失败；
  新增 pi-exit 监听清重建台账 + 逐订阅线程拉快照（空闲态自愈）。
- **旁路事件接入**：compaction_start/end（context.ts 五出口）、queue_update
  （prompt-queue，steering[]+followUp id 列表）、context_usage（prompt-pipeline，
  tokens/window/percent）、session_info_changed（改名）。

### 设计权衡记录
- seq 共用 per-session 号段（event-seq.ts，与 context_changed/queue_state 同段），
  缺口合法、**不做缺口检测**——快照权威兜底已覆盖丢失场景。
- tool_update 整段节流而非增量：节流窗内只保留最新整段，end 帧权威收口。
- 不合成 dangling-user 占位：优雅退出（kill_on_exit）已把 partial 落盘转录，
  重开线程由快照自愈；「本回合因错误中断」占位由投影层 assistant-message.tsx
  对 stopReason=error 的消息原生处理。
- message_start 仅 assistant 消息触发（agent.js 核验），accumulator 生命周期
  不会误伤 user/toolResult 行。

### 已知差异 / 暂缺（阶段 4/5 处理）
| 项 | 现状 | 去向 |
|---|---|---|
| 文档附件 | `buildPiSendInput` 只透出 text+image，file part 被丢弃 | 阶段 4 扩展 vendored ThreadController |
| 队列栏 | queue_update 事件已发但客户端未消费；clearQueue 仍为 no-op 占位 | 阶段 4a（queue_cancel/promote/steer 接线） |
| thinking_seed / subagent 旁路 | thread_event 通道未承载（data-* 通道只在旧链路） | 阶段 4c |
| thinkingLevel 会话定靶 | `set_thinking` 全局广播（sidecar 无会话形参） | 阶段 4 |
| 压缩分隔线 | compaction_end 事件已发，投影层未消费 | 阶段 4d 逐一核对 |
| 图片/检查点 data-* part | 快照路径不重建（旧路径 get_history 重建 data-image/data-compaction） | 阶段 4 |
| running 键混跑 | 旧链路发起的轮以本地 threadId 为键，新链路 abort/steer 找不到它（仅迁移期并存时出现） | 阶段 5 删旧链路后消失 |

## 验证记录
- `bunx tsc --noEmit`（apps/desktop 与 sidecar）干净
- vendored 85 测试 + 全仓 929 测试绿
- 待用户实测：开线程 / 发消息收终态 / 历史显示 / 工具卡基本渲染 / 停止按钮 / 审批卡

### 阶段 3 验证（2026-10-01，commit 88790c0）
- `bunx tsc --noEmit` 两端干净；`cargo check` 通过（pi_agent.rs 合帧改动）
- pi-runtime 90 项测试绿（新增 tauri-pi-client.test.ts 5 项：快照基底+delta 续接 /
  message_start 起基+text/thinking 累积 / toolcall 参数缓冲+权威替换 / done 终态
  替换 / 未知会话静默+收尾帧兜底）
- 全仓 929 项测试绿
- 待用户实测（perf 对比）：多会话并发流式流畅度（阶段 2 轮询 vs 阶段 3 事件流，
  后台线程不再全价消化 chunk）；流式中途刷新恢复；崩溃后重开线程自愈
