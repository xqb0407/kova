# 队列系统 v2 重构计划

> 目标：以 `pi-message-queue`（参考实现，`~/Downloads/pi-extensions-main/pi-message-queue`）的架构为准绳，
> 重构桌面端消息队列，解决联调暴露的一系列问题。本计划只做设计，不动代码。

## 一、为什么要重构（现状问题清单）

本轮联调暴露的问题，多数指向同一类根源：**队列状态没有持久化、事实源分散、前端对消息数组做多路手术**。

| # | 问题 | 根源 |
|---|------|------|
| P1 | 刷新/重启后排队消息失踪（排队条 ghost、消息不可见） | 队列纯内存（sidecar + 前端镜像都是） |
| P2 | 消息数组手术规则分散：摘除/回填/恢复/抑制四条路径 + 多个竞态（恢复竞态、对账重复追加出分支、顺序错乱） | 乐观消息在 Chat 数组里，与「非末条流写入 pushMessage 重复项」的框架行为对抗，只能靠多路径补偿 |
| P3 | data-queue chunk 语义过载 | queued/active/steered 三态 + 取消的 abort+finish 混在一种 chunk 里按流分发 |
| P4 | status 单槽冲突：任意旁路流结束把会话状态打回 ready（删除时按钮闪烁已定位；steer 已用「挂起 finish」修复，属补丁） | 框架 status 单槽 + 旁路流生命周期 |
| P5 | 无暂停/恢复派发 | 未实现 |
| P6 | 失败不熔断：某轮 provider 级失败后，后续排队项逐个撞同样的错误 | 未实现 |
| P7 | 双通道时序竞态（invoke 回复 vs chunk 事件到达顺序）引发过恢复竞态 | 事件驱动增量同步的固有复杂度 |

## 二、参考设计提炼（pi-message-queue）

- **QueueEngine 纯状态机**：队列/暂停/自增 id/dispatching 全部收口在一个无 I/O 类里；快照 `snapshot()` / 容错恢复 `restoreSnapshot()`。
- **快照持久化**：每次变更 `appendEntry` 一份全量快照进 session；`session_start`/`session_tree` 时从条目恢复 → 跨 reload/resume/树导航存活。
- **两阶段派发**：`markSending`（accepted=false）→ 宿主真正接受（`before_agent_start`）→ `acceptPendingDispatch` 才出队 → `agent_end` 清 sending。派发中的项锁定（不可删/改/清）。
- **发送看门狗**：N 秒未被宿主接受 → `failSend()` = 队列自动暂停 + 提示，绝不静默卡死。
- **steer 与队列职责分离**：Enter 进队列等待；显式 steer 用原生 steer 通道，两者是不同概念、不同快捷键。
- **暂停/恢复**：暂停只停派发，不清队列。

## 三、目标架构

### 3.1 sidecar：QueueEngine + 快照持久化（事实源）

- `prompt-queue.ts` 重写为纯状态机 `QueueEngine`：
  - `items: { id: 稳定自增, reqId, text, createdAt, state: "queued" | "dispatching" }[]` + `paused` + `nextId` + `dispatchingId`；
  - 操作：enqueue / remove / updateText / promote / markDispatching / acceptDispatch / clearDispatching / pause / resume / snapshot / restoreFrom；
  - 去掉「worker-slot 轮到时取队首」的隐式语义，派发由链节显式走两阶段（与参考一致，promote 重排天然正确）。
- **持久化**：每次变更向 session JSONL 追加一行 `{ type: "queue_state", snapshot }`（转录层本来就是自定义行格式）；`resolveSession`/转录回放时取最后一条恢复。sidecar 重启、会话切换后队列原样恢复。
- **快照广播**：每次变更向该线程广播一条 `data-queue-state` 全量快照 chunk。前端「最后快照胜出」，不再做增量对账。

### 3.2 协议变更

| 变更 | 说明 |
|---|---|
| 新增 `data-queue-state` | 每线程全量快照：`{ items: [{id, reqId, text, state, createdAt}], paused, dispatchingId }`；变更即广播 |
| 废弃 `data-queue` 增量 chunk | queued/active/steered 三态全部由快照的 item.state 表达 |
| 新增 `queue_pause` / `queue_resume` | 暂停只停派发，不清队列；链节在队首等待 resume（带唤醒，无死锁） |
| 保留 | `queue_update` / `queue_cancel` / `queue_promote` / `queue_steer`（参数不变） |
| 熔断 | 同一线程连续 2 次 turn 级失败（provider 错误）→ 自动 `paused` + 通知，UI 一键恢复 |

### 3.3 前端：快照镜像 + 注册表（消息数组规则收敛为三条）

- `pi-queue.ts` 重写：store = **快照镜像**（全量替换，无增量对账）+ `reqId → { messageId, message }` 注册表（发送时登记，会话期有效）。
- 消息数组同步规则收敛为三条（幂等，由快照状态驱动，组件挂载时按当前快照应用一次即完成对账）：
  - **R1 queued**：消息只在排队条（Chat 数组摘除，防非末条流写入的重复项）；
  - **R2 dispatching→出队**：轮真正开始（快照中该项消失）→ 消息回填列表末尾（有 stash 用 stash；无 stash——刷新后——用快照 text 重建气泡，`id = queued-<reqId>`）；
  - **R3 steered**：并入瞬间回填保持「宿主轮收尾回填」（期间宿主轮仍在写入，提前回填会触发重复项增长与乱序——维持本会话已实现的挂起语义）。
- 删除的旧路径：restore 竞态补偿、cancelled 标记、对账方向分支——全部由「快照状态 + 三条规则」替代。
- 附件限制：快照只持久化文本，刷新后重建的气泡不带附件（已知限制，v2.1 可持久化附件中转路径）。

### 3.4 UI（prompt-queue-bar）

- 渲染完全由快照驱动：条目列表 + 每项操作（删除/编辑/立即发送/并入）+ **暂停/恢复开关**；
- `dispatching` 项锁定并显示「发送中」（不可删改，对齐参考的 isInFlight）；
- 熔断暂停时显示横幅 + 一键恢复。

### 3.5 保留项（本轮已修的真实 bug 防护，重构不回退）

- `openRequestIds` 自动重挂守卫（双重消费 → 2/2 分支）；
- BranchPicker 移除（重新生成直接替换）；
- `pendingTurn` 加载动画（status 空窗）；
- regenerate 不进队列；
- 消息同步的「无变化不赋值」纪律（messages setter 无条件通知）。

## 四、实施里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 快照引擎与持久化（sidecar） | QueueEngine 重写、transcript `queue_state` 行、replay 恢复 | QueueEngine 单测（快照/恢复/两阶段/暂停/熔断）；replay 集成测试 |
| M2 快照广播 + 前端镜像重写 | `data-queue-state` chunk、pi-queue 快照镜像、三条同步规则、排队条改造 | 前端单测（镜像/规则）；现有用例迁移；刷新恢复手测 |
| M3 派发语义与暂停/恢复 | dispatching 锁定、看门狗/熔断、pause/resume 协议与 UI | 集成测试 + 手测（暂停后队列保持、恢复后自动续发） |
| M4 清理 | data-queue 增量 chunk 废弃、旧补偿路径移除、文档更新 | 全量测试 + 手工回归清单 |

手工回归清单：发消息排队 → 立即发送 / 删除 / 编辑 / 并入；刷新后队列恢复并可操作；暂停/恢复；连续失败熔断与恢复；多任务并发线程互不干扰。

## 五、关键决策与权衡

| 决策 | 选择 | 理由 / 代价 |
|---|---|---|
| D1 快照 vs 增量 | 全量快照 | 队列 ≤5 条，全量最简单、无对账逻辑；广播频率低 |
| D2 持久化位置 | session 转录 JSONL 行 | 复用现有 appendFileSync/replay 管道，与 todo 回放同模式；队列随会话生命周期天然一致 |
| D3 前端 messageId 映射 | reqId→messageId 注册表留在前端 | 快照不含前端 id；刷新后注册表清空，回填用快照文本重建（附件丢失为已知限制） |
| D4 steer 回填时机 | 维持宿主轮收尾回填 | 立即回填会在宿主轮写入窗口内触发重复项增长与乱序（本轮实测）；代价是并入后消息在轮结束前不可见，UI 上以「已并入」状态明示 |
| D5 失败熔断 | 连续 2 次 turn 级失败自动暂停 | 对齐参考 failSend 语义；一键恢复，避免级联报错轰炸 |
| D6 兼容 | 前后端同仓同发布 | 协议不兼容无迁移负担；旧转录无 queue_state 行 → 空队列启动 |

## 六、风险

- 链节与 pause 的交互：暂停时链节点在队首等待，需 resume 唤醒防死锁（实现为可唤醒的 deferred）。
- 「发送后、确认前」刷新：注册表丢失，该项按快照文本重建（无附件），可接受。
- 快照广播量：每变更一条广播，队列规模小，无需节流。
