# Agent Inbox：统一收件箱设计

状态：设计稿（未实现，2026-11-15）
范围：sidecar 事件投影与协议、桌面主区页面、远程/移动端消费
非目标：工作流引擎、团队共享收件箱、AI 自动分诊、外部工作项（GitHub / Jira / Linear）聚合

> 一句话：把「需要你处理」和「刚完成、等你查看」的异步结果，从各个会话、面板和
> 管理页里收拢成一个**跨会话、跨端、可执行、可持久化**的收件箱。
>
> 本文的 Inbox 指 **agent 运行时事件收件箱**，不是外部工作项收件箱。后者若以后
> 落地，作为另一类 source / 另一个 Tab 接入，不混进 v1 的事件模型。

---

## 0. 结论（先读）

1. **不新建事实源。** 审批/提问的事实源仍是转录里的 `pending_interaction` 行，
   自动化的仍是 `tasks.json` 的 `runHistory`，子代理的仍是活动文件，目标的仍是
   `goal_state` 行。Inbox 只做**投影 + 用户状态覆盖层**。
2. **用 append-only 事件日志做全局索引。** 新增
   `<sessionsDir>/inbox/events.jsonl`，源侧在状态变化时追加一条 `upsert` / `resolve`；
   `list_inbox` 只读这份日志，不扫全部转录。日志损坏或丢失时，源仍然是权威，
   启动对账可以重建「仍打开」的条目。
3. **v1 只收六类**：审批、提问、目标暂停/受阻/待确认标准、自动化失败/完成、
   子代理终态、后台任务终态。**不收**每一轮完成、每一 token、每一次工具调用；
   队列暂停与检查点审阅放到 v1.1 / v2。
4. **所有动作回到既有命令/领域函数。** Inbox 不是新的权限通道：批准仍然走
   `tool_confirm` 的领域函数，回答仍然走 `question_answer`，目标恢复仍然走
   `goal_resume`，自动化重跑仍然走 `automation_run_now`。Inbox 不允许「直接放行」。
5. **先桌面，协议天然支持远程/移动。** 新帧 `inbox_changed` 加入远程广播白名单；
   移动端和网页端复用同一份 `list_inbox` / `inbox_action`，不另做一套状态。
6. **ACP 模式不启用。** 编辑器里的 agent 已有自己的权限 UI，Inbox 投影在
   `isAcpMode()` 下 no-op，避免重复提醒与无谓落盘。

---

## 1. 问题：异步工作散落在五个地方

| 来源 | 现在在哪里 | 用户要发现它，必须 | 断掉之后 |
|---|---|---|---|
| 逐工具审批 / Question | 当前会话的 composer 上方卡片；`pi-interactions` 按 thread 存 | 正好打开那个会话 | 选别的会话就看不到；刷新靠 `list_pending` 回拉 |
| 自动化运行结果 | 「自动化 → 运行记录」页；每任务 `runHistory` ≤25 条 | 主动进自动化页翻 | 成功/失败只是历史行，没有「待处理」概念 |
| 子代理报告 | 父会话里的 `[[subagent-report]]` 注入 + 面板「辅助会话」 | 打开父会话或面板 | 父轮结束后报告可能没人看；没有全局列表 |
| 目标暂停 / 受阻 / 待确认标准 | 当前会话的 goal 常驻条 | 打开那个会话 | 没有跨会话提醒；刷新靠 `get_goal_state` |
| 后台 bash 任务 | 当前会话 header 徽标 / 快速查看浮层 | 打开那个会话 | 任务结束后徽标消失，没有「完成待查看」记录 |

另外还有两个结构性问题：

- 未读状态在 `apps/desktop/lib/pi/pi-unread-sessions.ts` 里用 **localStorage** 存，
  只对当前浏览器/窗口有效，移动端和网页端各算各的；
- `agent-events.ts` 的提示音/webhook 是一次性事件，没有可回看的持久记录。用户
  离开电脑十分钟，回来只能靠记忆判断「刚才有没有东西需要我」。

结果：后台 agent 干完活没人知道；一个后台会话卡在审批，用户可能几小时后才发现；
移动端只能处理当前打开的会话，不能做全局分诊。

---

## 2. 目标与非目标

### 2.1 目标

- **一个入口**：所有「需要你」和「刚完成」的异步结果，在侧栏一个徽标里可见。
- **可执行**：审批批准/拒绝、提问作答、目标恢复、自动化重跑、打开报告/会话，
  尽量在 Inbox 内完成，不必先找到原会话。
- **跨端一致**：桌面、网页远程、移动端看到同一份条目和同一份已读/归档状态。
- **可持久化**：重启、刷新、换端后不丢；源已消失的条目能显示「已失效」而不是报错。
- **安静**：只收阻塞与终态，不做每轮/每步通知；同一件事只产生一条，结算后不重复。
- **可审计**：每条动作有来源、时间、结果；不把完整工具输入/密钥写进日志。

### 2.2 非目标

- 不做任务管理/项目看板；不替代会话列表、自动化页、子代理面板。
- 不做工作流编排（见 `docs/workflow-engine-gap.md`）。
- 不做多用户/团队共享收件箱（见 `docs/agents/bot-team.md` 之后再谈）。
- 不做外部工作项聚合（GitHub / Jira / Linear）；不混入 v1 的 Item 模型。
- 不做 AI 自动分诊/自动摘要（v1 的 summary 是确定性截取，不额外调模型）。
- 不做「全部批准」这类批量授权；审批必须逐条。
- 不把 Inbox 内容自动回灌给模型；它只是人的视图。

---

## 3. 设计原则

1. **源权威**：Inbox 的 `state` 永远从源推导；源说已结算，Inbox 不能还显示 pending。
2. **投影，不是复制**：日志只存展示所需的摘要 + 指针；完整载荷按需从源读取。
3. **可执行优先**：没有动作也没有深链的条目不应存在。
4. **稳定 ID + 幂等 upsert**：同一源事件重复到达不会产生重复条目。
5. **动作不绕过边界**：Inbox 的动作必须复用既有领域函数/命令，权限、沙箱、
   会话归属、并发检查全部照旧。
6. **安静默认**：只有「阻塞」和「终态」进入；中间态（running/queued）不进。
7. **失败不拖垮主流程**：日志写失败只记日志，不影响审批/自动化/子代理本身。
8. **本地优先**：日志与用户状态都在本地 sessions 目录；不上传、不做遥测。

---

## 4. 信息模型

### 4.1 Item 类型（v1）

| kind | 何时产生 | 默认优先级 | 需要动作 | 主要动作 | 事实源 |
|---|---|---|---|---|---|
| `approval` | 逐工具审批挂起（含 MCP 网关审批、plan_exit 确认） | P0 | 是 | 批准 / 拒绝 / 允许并记住 / 打开会话 | `pending_interaction` 行 + `pending-interactions.ts` 台账 |
| `question` | `Question` 工具挂起 | P0 | 是 | 作答 / 取消 / 打开会话 | `pending_interaction` 行 + `question-tools.ts` |
| `goal` | 目标暂停、受阻、等待确认验收标准 | P0 / P1 | 是 | 恢复 / 确认或调整标准 / 打开会话 | `goal_state` 行 + `goal.ts` 内存槽 |
| `automation` | 一次自动化运行成功/失败 | P1（失败）/ P2（成功） | 失败=是，成功=否 | 打开运行会话 / 重跑 / 归档 | `tasks.json` 的 `runHistory` + `runner.ts` |
| `subagent` | 子代理进入终态（completed / failed / truncated / stopped / interrupted） | P1（失败/中断）/ P2（完成） | 失败=是，完成=否 | 打开父会话 / 打开报告 / 续聊（后续）/ 归档 | `subagents/<delegationId>.jsonl` + `delegation.ts` |
| `background_task` | 后台 bash 任务退出 | P1（非零退出）/ P2（成功） | 非零=是，成功=否 | 打开会话 / 归档 | sidecar `bg-tasks.ts` 台账 + 宿主 `bgTasks` 表 |

v1.1 再加入：

- `queue`：用户 Stop 后队列自动暂停（`pauseReason="stopped"`）或手动暂停；动作为恢复队列。
- `checkpoint`：仅当用户显式开启「审阅本轮改动」或一轮改动达到阈值时产生；动作为查看 diff / 回滚。

**刻意不收**：

- 每一轮正常结束（`agent.turn.completed`）——会话列表已经有未读/运行态，收进来会变成第二个会话列表。
- 自动化 running / queued——每次触发都建条目会淹没真正的失败。
- 子代理 running 的中间活动——面板已经流式展示；Inbox 只收终态。
- 普通工具调用、token 用量、心跳。

### 4.2 状态、结果与优先级

```ts
type InboxState = "open" | "done" | "expired";

type InboxOutcome =
  | "needs_action"   // 阻塞：审批/提问/目标暂停
  | "approved" | "denied" | "answered" | "cancelled"
  | "completed"      // 子代理/目标完成
  | "success"        // 自动化/后台任务成功
  | "failed"
  | "stopped"
  | "interrupted";

type InboxPriority = 0 | 1 | 2 | 3; // P0 阻塞 / P1 需关注 / P2 待查看 / P3 FYI
```

- `state` 是**源侧生命周期**：`open`（还没结算）、`done`（已结算）、`expired`
  （源已消失，无法再打开详情）。
- `requiresAction` 是**展示判据**：`open && kind in {approval, question, goal}`，
  以及失败的自动化/子代理/后台任务。侧栏徽标只数 `requiresAction`，不数普通未读。
- `priority` 决定默认排序：P0 最前，同优先级按 `createdAt` 升序（阻塞越久越靠前）；
  P2 按 `createdAt` 降序（新完成在前）。
- 用户状态（已读/归档/稍后提醒）不进 `state`，单独存，见 §4.4。

### 4.3 InboxItem

```ts
type InboxItem = {
  /** 稳定 ID：`${kind}:${sourceId}`，见 §4.4 */
  id: string;
  kind: InboxItemKind;
  state: InboxState;
  outcome?: InboxOutcome;
  priority: InboxPriority;
  requiresAction: boolean;

  title: string;
  /** 单行摘要，已脱敏、已压缩空白，≤ 240 字符 */
  summary?: string;

  /** 源对象 id：approvalId / questionId / goalId / runId / delegationId / taskId */
  sourceId: string;
  sessionId?: string;
  threadId?: string;
  projectId?: string;

  createdAt: string;   // 源事件发生时间（ISO）
  updatedAt: string;   // 最近一次 upsert/resolve 时间

  /** 允许的动作；服务端按 kind 白名单校验，前端只渲染这里的项 */
  actions: InboxAction[];

  /** 打开时需要的定位信息；不保证所有源都有 */
  deepLink?: {
    sessionId?: string;
    threadId?: string;
    /** 转录 seq（打开会话后跳转/highlight）；审批/提问通常没有 */
    seq?: number;
    /** 审批/提问锚定的工具调用 id */
    anchorToolCallId?: string;
    /** 面板 tab：subagents / artifacts / git ... */
    panel?: string;
  };

  /** kind 专属的最小元数据；禁止放完整工具输入、报告全文、命令输出 */
  meta?: Record<string, unknown>;

  /** 是否有可拉取的详情（inbox_item） */
  hasDetail: boolean;
};
```

**ID 规则**：

| kind | ID | 说明 |
|---|---|---|
| approval / question | `approval:<interactionId>` / `question:<interactionId>` | `interactionId` 已由 `beginInteraction` 保证唯一 |
| goal | `goal:<sessionId|threadId>:<goalId>` | 同一目标多次状态变化只更新一条；换目标 = 新 ID，旧条目 resolve |
| automation | `automation:<taskId>:<runId>` | 每次运行独立；重跑产生新 runId |
| subagent | `subagent:<delegationId>:<completedAtMs>` | 每次终态结算一条；resume 后再次 settle = 新条目，旧报告保留 |
| background_task | `bg:<sessionId|threadId>:<taskId>` | 宿主 taskId 可能复用，带会话键防串 |

`sessionId` 缺失时用 `threadId` 兜底（MCP 审批可能发生在会话落库前）；两者都没有
时用 `thread:<threadId>`，并在对账时按 24h 过期。

`sourceId` 只放源主键；不要用标题/哈希做 ID，标题会变。

### 4.4 用户状态

```ts
type InboxItemUserState = {
  readAt?: string;
  archivedAt?: string;
  /** 到点后重新出现在默认列表；null/缺省 = 不 snooze */
  snoozedUntil?: string;
  pinnedAt?: string;
};
```

- 存 `<sessionsDir>/inbox/state.json`，key = item ID，value 如上；原子写（临时文件 + rename）。
- **跨端共享**：不是 localStorage。桌面、网页远程、移动端读写同一份。
- 读/归档/稍后都是幂等操作；重复请求不报错。
- **未结算的阻塞项不允许归档**（`open && requiresAction`）：归档会把审批/提问藏起来，
  用户可能忘记。这类条目只允许「稍后提醒」；`inbox_update` 对归档请求返回
  `INBOX_ACTION_NOT_ALLOWED`。结算后（done/expired）才可归档。
- 归档不删除条目；「已归档」Tab 可恢复。删除源（会话/任务）时条目标 `expired`，
  用户状态保留到保留期结束。
- 上限 5000 条；超出按「最旧且已归档」淘汰。`state.json` 超过 1MB 时做一次压缩。

---

## 5. 采集与存储

### 5.1 为什么不是「每次扫描源」或「新建 SQLite 表」

| 方案 | 问题 |
|---|---|
| A. `list_inbox` 每次扫全部源 | 审批/提问分散在每会话转录里，跨会话找要扫所有 JSONL；目标也要扫 `goal_state` 行；会话一多就是 O(n) 启动卡顿 |
| B. 在 `state.db` 新建 `inbox_items` 表 | 生产库的业务表由宿主（`apps/electron/main/data.ts`，对齐 Rust `data.rs`）持有；新增表要两边同步迁移，成本高，且 Inbox 本质是可重建缓存 |
| C. append-only 文件日志 + 源侧 hook（**采用**） | 写入小、读取 O(items)、无需 DB 迁移；日志丢了源仍可对账；与 transcript / activity / automation 的文件纪律一致 |

### 5.2 目录

```
<sessionsDir>/inbox/
├── events.jsonl       # append-only：upsert / resolve，last-wins
├── events.jsonl.tmp   # 压缩时的临时文件（rename 覆盖）
└── state.json         # 用户状态：read / archived / snoozed / pinned
```

- 目录权限 0700（与 sessions 一致）。
- `events.jsonl` 单行一条 JSON；写失败只 `logErr`，不抛回调用方。
- `state.json` 原子写；写失败保留内存态，下一次变更重试。

### 5.3 日志行

```ts
type InboxJournalRow =
  | {
      v: 1;
      op: "upsert";
      at: string;
      item: InboxItem;
    }
  | {
      v: 1;
      op: "resolve";
      at: string;
      id: string;
      outcome?: InboxOutcome;
      summary?: string;
    };
```

读取时按行顺序 reduce：`upsert` 覆盖同 ID，`resolve` 把 `state` 改为 `done` 并写
`outcome`。不认识的字段/版本跳过（向前兼容，同转录行纪律）。

**写入顺序**：源先落盘（转录行 / tasks.json / 活动文件 / goal_state 行），再写
Inbox 日志，最后广播。Inbox 写失败不回滚源；源是权威。

**压缩**：文件超过 2MB 或累计 500 次追加时，重写为「每个 ID 的最后状态」，
丢弃 90 天前且已 `done/expired` 的条目；仍在 `open` 的条目永不丢。压缩用临时文件
+ rename，失败保留旧文件。

### 5.4 写入点（实现时按这张表接）

| 源 | 文件 / 函数 | 触发 | 写入 |
|---|---|---|---|
| 审批/提问挂起 | `apps/sidecar/pi-agent/src/sessions/pending-interactions.ts` `beginInteraction()` | 落 `pending_interaction` 行之后 | `upsert`：`approval` / `question`，P0，`requiresAction=true` |
| 审批/提问结算 | 同文件 `settleInteraction()` | 落 `interaction_resolved` 行之后 | `resolve`：`approved/denied/answered/cancelled` |
| 目标状态 | `apps/sidecar/pi-agent/src/goal/goal.ts` `commitGoal()` | 落 `goal_state` 行之后、`emitGoalState()` 之前 | 按 §7.2 映射；用 fingerprint 去重，progress 变化不写 |
| 自动化运行 | `apps/sidecar/pi-agent/src/automation/runner.ts` `runAutomationTask()` | 成功返回 / 抛错 / 超时收尾 | `upsert`：成功 P2，失败 P1；带 runId + sessionId |
| 子代理终态 | `apps/sidecar/pi-agent/src/subagent/delegation.ts` `settleDelegation()` | `pushActivity(status)` 之后 | `upsert`：按状态 P1/P2；带 report 摘要，不写全文 |
| 后台任务退出 | `apps/sidecar/pi-agent/src/tools/bg-tasks.ts` `observeBgToolResult()` / `refreshBgTasks()` | `running` 从 true → false | `upsert`：exitCode 0 = P2，非零 = P1 |
| 队列暂停（v1.1） | `apps/sidecar/pi-agent/src/sessions/prompt-queue.ts` `pauseQueue()` / `resumeQueue()` | 暂停位变化 | `upsert` / `resolve` |
| 检查点（v2） | `apps/sidecar/pi-agent/src/checkpoint/store.ts` 的轮次收尾 | 用户开启审阅 / 阈值命中 | `upsert` |

**门控**：所有写入经 `inbox/store.ts` 的 `upsertInboxItem()`；`initInbox({ enabled: !isAcpMode() })`
在 `index.ts` 初始化时调用。ACP 模式下全部 no-op。

**依赖方向**：`inbox/*` 只依赖 `pi-protocol` 类型与 storage；对账需要读 transcript /
delegation / automation 时用 `await import(...)` 懒加载，禁止反向 import
`protocol/handlers`，避免与 `protocol.ts` 的 handler 注册形成模块环（同
`pending-interactions.ts` 的既有纪律）。

**去重**：

- 审批/提问：`interactionId` 天然唯一；重复 `beginInteraction` 防御性覆盖。
- 目标：`goalInboxFingerprint = goalId|status|acceptance.status|pauseReason|completionSummary`；
  相同指纹不写。重启后首次 `commitGoal` 会写一次，无害。
- 自动化：runId 唯一；重跑是新 runId。
- 子代理：每次终态结算用 `subagent:<delegationId>:<completedAtMs>`，resume 后再次
  settle 是**新条目**；旧条目保持 done，历史报告不会被覆盖，也不会因为用户归档过
  旧条目而让新报告消失。
- 后台任务：`taskId` + `sessionId`；状态未变不写。

### 5.5 启动对账

Inbox 日志是缓存，不是权威。`list_inbox` 第一次调用时（懒加载）：

1. 读取 `events.jsonl`，reduce 出内存 `Map<id, InboxItem>`；
2. 异步执行 `reconcileOpenItems()`，只检查 `state === "open"` 的条目：
   - approval/question：有 `sessionId` 时读 `scanTranscript(sessionId).pending`；
     有 `threadId` 时用 `sessionForThread(threadId)`；已经不在 pending 集合 → `resolve`；
     无会话绑定且超过 24h → `expired`。
   - goal：有 `sessionId` 时 `readGoalState(sessionId)`；`active`/`complete`/无目标 →
     `resolve`；仍是 paused/blocked/proposed → 更新摘要与优先级。
   - automation：读 `automation_list` 的任务，按 runId 找 `runHistory`；状态不符 → 更新；
     找不到且超过 7 天 → `expired`（历史被 25 条上限裁掉）。
   - subagent：`findDelegationRecord(delegationId)`；找不到活动文件且超过 7 天 → `expired`。
   - background_task：宿主 `bgTasks` 表/当前台账查不到且超过 24h → `expired`。
3. 对账完成后发一次 `inbox_changed`（带最新 counts），前端刷新。

对账**不得**把已 `done` 的条目翻回 `open`；只有源明确说仍 pending 且日志里没有
对应 resolve 时，才允许 `open`。

### 5.6 保留

- `open`：直到源结算或对账判 `expired`，不按时间清理。
- `done`：默认保留 30 天；`expired` 保留 7 天。
- 用户归档：保留 90 天，之后随压缩丢弃。
- 日志压缩后目标大小 < 2MB；条目上限 5000。

---

## 6. 协议

新增 `packages/pi-protocol/src/inbox.ts`，并从 `index.ts` 导出。所有请求/应答沿用
现有 NDJSON 命令约定：请求带 `id`，应答 `{ id, type: ... }`；错误走
`{ id, type: "error", errorText, error }`。

### 6.1 命令

| 请求 | 应答 | 说明 |
|---|---|---|
| `{ type: "list_inbox", id, filter?, limit?, cursor? }` | `{ id, type: "inbox", items, counts, nextCursor? }` | 只读日志 + 用户状态；`limit` 默认 50、最大 100 |
| `{ type: "inbox_item", id, itemId }` | `{ id, type: "inbox_item", item, detail, stale? }` | 懒加载详情；`stale=true` 表示源已消失 |
| `{ type: "inbox_action", id, itemId, action, payload? }` | `{ id, type: "inbox_action_done", itemId, action, item, counts }` | 执行动作；按 kind 白名单校验 |
| `{ type: "inbox_update", id, itemIds, patch }` | `{ id, type: "inbox_updated", itemIds, counts }` | 已读/归档/稍后；纯用户状态，不碰源 |

`filter`：

```ts
type InboxFilter = {
  tab?: "action" | "done" | "archived" | "all"; // 默认 action
  kinds?: InboxItemKind[];
  sessionId?: string;
  projectId?: string;
  query?: string;          // 标题/摘要/来源名，服务端子串匹配
  includeSnoozed?: boolean;
};
```

`counts`：

```ts
type InboxCounts = {
  needsAction: number; // requiresAction && !archived && 不在 snooze
  unread: number;      // !readAt && !archived
  open: number;        // state === "open"
  done: number;        // state === "done" 或 "expired"
  archived: number;    // archivedAt 存在
};
```

**Tab 语义**（服务端过滤，不是前端再筛）：

| tab | 条件 | 排序 |
|---|---|---|
| `action` | `requiresAction === true && !archivedAt && !snoozed`（含失败的 done 条目） | `priority` 升序、`createdAt` 升序（阻塞越久越靠前） |
| `done` | `state !== "open" && requiresAction === false && !archivedAt` | `createdAt` 降序 |
| `archived` | `archivedAt` 存在 | `archivedAt` 降序 |
| `all` | 全部（默认也排除 snoozed；`includeSnoozed=true` 才显示） | 先 action 后 done |

游标是 base64 的 `${createdAt}|${id}`，服务端只按 `createdAt` 过滤，不依赖索引。

### 6.2 推送

```ts
{ type: "inbox_changed", reason: "upsert" | "resolve" | "read" | "archive" | "expire",
  itemId?: string, counts: InboxCounts }
```

- 无 `id` 的自发帧，与 `sessions_changed` / `automation_run_done` 同族。
- 服务端节流 100ms：同一窗口内多次变化合并成一条，`counts` 始终是最新值。
- 前端收到后：立即更新侧栏徽标（用 `counts`），防抖 200ms 重拉当前 Tab 列表。
- `apps/electron/main/remote.ts` 的 `BROADCAST_TYPES` 加入 `inbox_changed`，网页/移动端
  才能收到。
- `REMOTE_DENIED_TYPES` **不加入** `list_inbox` / `inbox_item` / `inbox_update` /
  `inbox_action`：远程端必须能审批/作答；动作本身仍走既有权限闸。
- **但 `inbox_action` 不能成为远程绕过通道**：它把多个动作收进一个命令，远程网关
  必须按 `action` 做二次校验。v1 明确：`retry` 对应桌面专属的
  `automation_run_now`，远程调用直接回 `REMOTE_DENIED`；`approve/deny/answer/
  resume/archive/mark_read` 允许。未来新增动作时，在 `remote.ts` 维护
  `INBOX_REMOTE_DENIED_ACTIONS` 并加测试，不能默认放行。

### 6.3 详情

```ts
type InboxDetail =
  | { kind: "approval"; interaction: PendingInteraction }
  | { kind: "question"; interaction: PendingInteraction }
  | { kind: "goal"; goal: GoalState }
  | {
      kind: "automation";
      task: { id: string; name?: string };
      run: { id: string; status: string; createdAt: string; message?: string };
      sessionId?: string;
    }
  | {
      kind: "subagent";
      record: {
        delegationId: string;
        agentName: string;
        status: SubagentRunStatus;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        canResume: boolean;
      };
      report?: string; // 已截断（boundedReport）
    }
  | {
      kind: "background_task";
      task: { taskId: number; command: string; source: string; startedAt: number; exitCode: number | null };
    };
```

详情**按需**从源读取，不存日志。审批/提问的完整 `input` 来自转录的
`pending_interaction` 行；即使是已结算条目，也按 `interactionId` 读原始行做历史
审阅（需要 `transcript.ts` 暴露一个按 id 查行的 helper）；子代理报告来自活动文件；
自动化来自 `automation_list`；目标来自 `goal_state` 行。读不到时返回
`stale=true`，前端展示「来源已不存在」并只保留归档动作。

### 6.4 动作映射

| kind | action | 底层调用 | 说明 |
|---|---|---|---|
| `approval` | `approve` / `deny` | 既有逐工具审批领域函数（从 `handlers/interactive.ts` 抽出的 `applyToolConfirm()`；MCP 走 `resolveMcpApproval()`） | `payload`: `{ approved, remember?, reason? }`；`remember` 只对 `canRemember` 的条目开放 |
| `question` | `answer` / `cancel` | `resolveQuestionAnswer()` / `cancelQuestionAnswer()` | `payload`: `{ answers?, cancelled? }` |
| `goal` | `resume` | `resume(run)` + `kickGoalLoop` | 只对 paused/blocked |
| `automation` | `retry` | `automationRunNowPayload({ taskId })` | 旧条目保持 done；新运行结算后产生新条目 |
| `subagent` | `open` | 前端打开父会话 + 子代理面板 | 无服务端动作 |
| `background_task` | `open` | 前端打开会话 | 无服务端动作 |
| 任意 | `open` | 前端 `requestOpenSession(sessionId, { seq })` | 无服务端动作 |
| 任意 | `archive` / `unarchive` / `mark_read` / `mark_unread` / `snooze` | `inbox_update` | 只改用户状态 |

**关键约束**：`inbox_action` 不得直接调用协议 handler（那会以同一个 `id` 再发一条
既有应答帧，前端 `piRequest` 会收到两条）。应把审批 handler 里的结算逻辑抽成
领域函数，由 `handlers/interactive.ts` 和 `handlers/inbox.ts` 共用；其他动作同理。
动作完成后：

1. 领域函数结算源（转录行 / 目标状态 / runHistory）；
2. 源的 hook 写 Inbox `resolve`；
3. `inbox_action` 返回最新的 `item` + `counts`；
4. 服务端广播 `inbox_changed`（其他端刷新）。

### 6.5 错误语义

| code | 场景 | 前端行为 |
|---|---|---|
| `INBOX_ITEM_NOT_FOUND` | itemId 不在日志/已压缩 | 从列表移除，提示已失效 |
| `INBOX_ITEM_STALE` | 源已消失（审批已结算、会话删除） | 标 `expired`，只留归档 |
| `INBOX_ACTION_NOT_ALLOWED` | 该 kind 不支持该 action，或动作不在 `item.actions` | 禁用按钮并刷新 |
| `INBOX_ALREADY_RESOLVED` | 另一端先结算 | 刷新条目，不报红屏 |
| `INBOX_SESSION_BUSY` | 目标会话在跑，不能 resume | 提示稍后重试 |
| `INBOX_FORBIDDEN` | 远程端越权/会话不匹配 | 通用错误文案 |

写操作幂等：`inbox_update` 重复执行成功；`inbox_action` 对已结算条目返回
`INBOX_ALREADY_RESOLVED` + 当前 item，让 UI 收敛而不是留在旧状态。

---

## 7. 来源适配细节

### 7.1 审批 / 提问

- `beginInteraction(threadId, interaction)` 在落 `pending_interaction` 行之后调用
  `upsertInboxItem()`。注意注释里提到的窗口：MCP 审批可能发生在会话落库前，此时
  `sessionId` 为空；条目不因此丢失，`threadId` 仍然可用于深链和结算，24h 无会话则
  对账判 `expired`。
- `title`：
  - approval：`需要批准：<toolName>`；`summary` 取 `note`，否则取输入的安全预览
    （`command` 首行 / `file_path` / JSON 截断），≤240 字符；
  - question：`Agent 提问`；`summary` 取首个问题标题，附 `共 N 个问题`。
- `meta` 只放 `{ approvalId/toolCallId/toolName/canRemember }` 或
  `{ questionId, count }`，不放完整 `input`。
- `deepLink`：`{ threadId, sessionId?, anchorToolCallId }`。前端打开会话后，挂起卡
  本来就会渲染；`anchorToolCallId` 用于可选滚动定位。
- 结算（包括 `tool_confirm` / `question_answer` 的陈旧条目兜底路径）一律
  `resolve`；`outcome` 取 `approved/denied/answered/cancelled`。
- 会话删除时 `dropSessionInteractions()` 调 `expireInboxItemsForSession()`，
  避免留下永远打不开的审批。
- 详情：`inbox_item` 直接返回 `PendingInteraction`；前端把现有的审批/提问卡抽成
  受控展示组件（见 §8.3），避免维护两套卡片。

### 7.2 Goal

`commitGoal()` 是目标的唯一变更出口，在这里按状态映射：

| Goal 状态 / 验收状态 | Inbox |
|---|---|
| `active` + `acceptance.status="proposed"` | `open`，P0，`requiresAction=true`，标题「待确认验收标准」，摘要目标原文 |
| `paused`（time budget / turn limit / no progress / sidecar restarted） | `open`，P1，`requiresAction=true`，摘要 `pauseReason` |
| `paused`（user left goal mode / user takeover） | `open`，P2，`requiresAction=false`，摘要说明是用户主动离开 |
| `blocked` | `open`，P0，`requiresAction=true`，摘要 `pauseReason` |
| `complete` | `done`，P2，`outcome=completed`，摘要 `completionSummary`；保留 completionAudit 供详情 |
| `active`（普通续跑） | `resolve` 可能存在的旧条目 |
| 清空目标（`goal_clear`） | `resolve` |
| 换新目标 | 旧 goalId 的条目 `resolve`；新 goalId 新建 |

`meta` 放 `{ goalId, status, acceptanceStatus }`，不放 progress 全量。`deepLink`
带 `sessionId/threadId`，打开后 goal 常驻条会显示同一状态。动作只做 `resume`
（v1）；确认/驳回/调整标准仍引导用户打开会话（避免两处 UI 语义漂移），v1.1 再把
`goal_confirm_criteria` 等接进来。

**不要为 `acceptanceMode="auto"` 的 `proposed` 建条目**：自动模式会在同一轮里立刻
确认，条目只会产生一次闪烁的「待确认标准」；`commitGoal` 里判断
`goal.acceptanceMode === "manual"` 才写 proposal 条目。自动确认后如果目标被暂停，
仍按 paused 条目处理。

### 7.3 Automation

- 在 `runAutomationTask()` 的成功返回处和失败/超时收尾处调用
  `recordAutomationInbox(task, run, outcome)`；不要依赖调度器进程的 hook——生产
  环境的调度器是独立进程（`kova-automation`），sidecar 才是实际执行 turn 的一侧。
- 成功：`done`，P2，`outcome=success`，摘要 `任务名 · 用时/状态`；`deepLink.sessionId`
  用 `getAutomationRunSession(run.historyEntryId)`。
- 失败：`done`，P1，`outcome=failed`，摘要错误文本（≤240 字符）；`requiresAction=true`，
  动作为 `retry` / `open`。
- 超时：按失败处理，摘要「运行超时」。
- 调度器侧取消/未启动（sidecar 崩、锁冲突）：runHistory 可能是 error，但没有真实
  sessionId；条目仍可创建，`deepLink` 只带 taskId，详情提示「未产生会话」。
- `meta`：`{ taskId, runId, ok }`，错误文本只放 `summary`，不放完整日志。
- 详情：从 `automation_list` 按 taskId/runId 读 `runHistory`；找不到则 `stale`。
- 重跑：`automation_run_now` 只接受 taskId；不允许从 Inbox 改任务定义。

### 7.4 Subagent

- `settleDelegation()` 在 `pushActivity(status)` 之后调用 `upsertInboxItem()`：
  - `completed` → `done`，P2，`requiresAction=false`；
  - `failed` / `truncated` / `interrupted` → `done`，P1，`requiresAction=true`；
  - `stopped` → `done`，P2，`requiresAction=false`（用户主动停的）。
- 条目 ID 用 `subagent:<delegationId>:<completedAtMs>`：resume 后再次 settle 会
  产生新条目；旧条目保留，用户归档旧报告不会遮住新报告。
- `title`：`子代理完成：<agentName>`（失败时 `子代理失败：...`）。
- `summary`：`report` 的安全截取（≤240 字符，压空白）；`meta` 放
  `{ delegationId, agentName, status, turns, toolCalls }`。
- `deepLink`：父会话 `record.ownerSession.sessionId` + `threadId`，`panel="subagents"`。
- `reportedToParent` 只表示报告是否注入过**模型上下文**，不能当用户已读；Inbox 的
  已读只看 `readAt`。
- 详情：`getDelegationSnapshot(delegationId)`；报告正文已在快照里（`boundedReport`）。
- v1.1 再接 `send_subagent_message` 做「继续聊」；v1 只打开面板。

### 7.5 Background task

- `observeBgToolResult()` 在 `task_output` / `task_stop` 看到 `running` 从 true 变
  false 时，以及 `refreshBgTasks()` 探测到退出时，调用 `upsertInboxItem()`。
- `title`：`后台命令完成` / `后台命令失败`；`summary` 取命令首行（≤240 字符，脱敏）。
- `meta`：`{ taskId, exitCode, source }`；`deepLink` 带 `sessionId/threadId`。
- 宿主的后台任务表可能跨重启保留；sidecar 台账是内存态。对账时查不到且超过 24h
  标 `expired`。v1 不做「停止运行中的后台任务」动作（那需要宿主工具通道，放到
  v1.1）。
- 详情只给命令/退出码；输出尾巴仍然通过打开会话/快速查看看，避免把大输出塞进
  Inbox 日志。

### 7.6 Queue / Checkpoint（v1.1 / v2）

- Queue：`pauseQueue()` 写 `open` P1，摘要「有 N 条排队消息因停止而暂停」；
  `resumeQueue()` / `queue_clear` 写 `resolve`。动作为 `resume`。
- Checkpoint：默认不写入。用户打开「审阅本轮改动」开关，或一轮 `write/edit` 文件数
  达到阈值时，才写一条 P2 审阅项；动作为打开 diff / 回滚。避免每轮都产生噪音。

---

## 8. UI

### 8.1 侧栏入口

- `apps/desktop/components/agent-thread/clone-thread-shell.tsx` 的 `menuItems` 增加：

  ```ts
  { id: "inbox", label: t("chat.sidebar.inbox"), icon: InboxIcon }
  ```

  位置放在「自动化」之上；它是比自动化更常用的分诊入口。
- 徽标：`needsAction > 0` 显示数字（上限 99+），否则有未读时显示小圆点。不要用
  颜色作为唯一信号：数字 + `aria-label`（`收件箱，3 项需要处理`）。
- `apps/desktop/components/agent-thread/base.tsx`：
  - `activeMenu === "inbox"` 渲染 `<InboxView />`；
  - 加入「全幅管理页时退出面板全屏」的列表（与 automation/usage/files/remote 同组）；
  - 点任意会话行时清空 `activeMenu` 的行为沿用现有 shell 委托。
- 首屏种子：`ensureInboxLoaded()` 在 Base 挂载时调用一次（与 `ensureAutomationsLoaded`
  同款），只拉 counts，不拉全量列表。

### 8.2 页面结构

```
┌ 收件箱 ────────────────────────────────────────────────┐
│  [待处理 3]  [已完成 8]  [已归档]      类型 ▾  搜索  ⋯  │
├────────────────────────────────────────────────────────┤
│  需要你处理                                             │
│  ⚠  需要批准：bash            release-check · 2 分钟前   │
│  ?  Agent 提问                数据迁移会话 · 5 分钟前    │
│  ⏸  目标已暂停                 周报整理 · 12 分钟前      │
│  已完成，待查看                                         │
│  ✓  子代理完成：code-reviewer  支付重构 · 1 小时前       │
│  ✓  自动化完成：每周发布检查    运行会话 · 昨天          │
└────────────────────────────────────────────────────────┘
```

- 顶部：标题 + 三个 Tab（带计数）+ 类型筛选（多选）+ 搜索 + 批量已读/归档。
- 列表：分组标题「需要你处理」「已完成，待查看」「更早」；组内按 §6.1 排序。
- 行：kind 图标（颜色仅辅助）、标题、单行摘要、来源 chip（会话名/项目/任务名）、
  相对时间、未读点、hover 快捷动作。
- 详情：宽屏右侧 380px 面板；窄屏用 Dialog/Sheet。详情顶部固定「打开会话」和
  「归档」，中部按 kind 渲染。
- 分页：「加载更多」按钮；不做无限滚动（避免长列表里误触）。
- 空态：待处理为空 → 「没有需要你处理的事。后台 agent 完成后会出现在这里」；
  已完成为空 → 「还没有已完成的任务」；搜索无结果 → 「没有匹配的条目」。

### 8.3 行/详情复用

- **审批/提问**：把 `pi-tool-approval` / `pi-question` 的卡片展示部分抽成受控组件
  （`ApprovalCardView` / `QuestionCardView`），入参是 `PendingInteraction` 的视图
  模型与 `onApprove/onDeny/onAnswer` 回调。线程内卡片和 Inbox 详情共用，避免两套
  文案与状态逻辑。
- **子代理**：报告用现有 markdown 渲染；头部信息复用面板里的 agent 名称/状态。
- **自动化**：只展示任务名、运行状态、错误摘要、打开运行会话/重跑。
- **目标**：状态行 + pauseReason + 验收标准列表（只读）+ 恢复按钮。
- **后台任务**：命令首行 + 退出码 + 打开会话；不内嵌完整输出。
- 所有详情都必须显示来源；已结束条目显示「归档」，**未结算的阻塞条目归档按钮
  禁用**（tooltip：先处理或稍后提醒），只能稍后提醒。不可逆动作（拒绝/停止/重跑）
  要有明确文案，不做二次弹窗（审批卡本身已有语义），但拒绝理由输入沿用现有卡片。

### 8.4 状态

- 加载：骨架行（3–5 条），不阻塞侧栏。
- 错误：顶部条「收件箱加载失败」+ 重试；保留上次缓存列表。
- 离线/远程断线：显示「连接断开，恢复后自动刷新」；不把条目清空。
- 条目失效：详情顶部黄色提示「来源已不存在」，只保留归档/删除。
- 并发结算：动作返回 `INBOX_ALREADY_RESOLVED` 时，静默刷新并提示「已在别处处理」。

### 8.5 键盘与无障碍

- `j` / `k` 上下移动，`Enter` 打开详情，`Esc` 关闭详情。
- `a` 批准、`d` 拒绝（仅在当前条目是 approval 且焦点在列表时生效）；`e` 归档；
  `r` 标记已读；`/` 聚焦搜索。
- 所有图标按钮有 `aria-label`；徽标变化用 `aria-live="polite"` 播报。
- 焦点进入详情后限制在详情内；关闭后回到原行。
- 颜色不是唯一状态信号：图标 + 文案 + 数字。

### 8.6 移动端 / 远程

- 移动端（Expo）新增「收件箱」Tab/入口，复用同一套协议；列表行与详情可以简化，
  但审批/提问必须能作答。
- 网页远程端在侧栏显示同一入口；它本来就有 `piRequest` 与 `wire-bus`，不需要新通道。
- 推送：v1 只做侧栏徽标与现有系统通知（审批/提问），不新增推送类型；v1.1 再评估
  「完成类」推送与免打扰时段。

---

## 9. 通知与未读

- **不重复通知**：审批/提问的提示音/webhook 已由 `agent-events.ts` 的
  `agent.approval.pending` / `agent.question.pending` 发出；Inbox 不新增同义事件。
- **徽标语义**：数字 = `needsAction`（必须处理）；小圆点 = 有未读完成项。
  打开 Inbox 页面**不清零**；只有逐条已读/归档或「全部已读」才清。
- **自动已读**（客户端规则）：当 `inbox_changed` 到达且条目的 `sessionId` 等于当前
  前台会话、页面可见时，终端类条目（automation/subagent/bg_task）可自动
  `mark_read`；阻塞类不自动已读。这样用户刚看着会话跑完，不会在 Inbox 里再看到
  一个未读。跨端读状态共享，桌面看过即移动端也读过——这是预期行为。
- **稍后提醒**：v1.1 加 `snooze`（1 小时 / 明天 / 下周），到点重新出现在「待处理」，
  但仍受 `requiresAction` 约束。
- **免打扰**：复用现有设置页的提示音/webhook 开关；Inbox 不另造一套通知偏好。

---

## 10. 安全与隐私

- **摘要脱敏**：`safePreview()` 统一处理**所有** title/summary/detail 文本（命令、
  工具输入、目标原文、报告、错误、后台任务命令）：
  - 压空白、去控制字符、截断 240 字符；
  - 打码 `sk-...`、`Bearer ...`、`*_KEY=`、`*_TOKEN=`、长 base64（>80 字符）；
  - 不写完整 `input`、完整报告、完整命令输出；详情需要原文时从源按需读，并沿用
    线程内已有的脱敏/权限面。
- **详情按需读源**：`inbox_item` 从转录/活动文件读完整内容；权限与线程内查看一致。
- **动作授权**：`inbox_action` 按 `itemId` 找到源，校验 `kind` 与允许动作；再调用
  领域函数，后者继续做会话归属、审批档、沙箱、并发检查。Inbox 不是绕过通道。
- **跨会话**：条目带 `sessionId/threadId`，动作必须与源一致；禁止用 itemId 猜
  另一个会话的审批。
- **远程**：`inbox_action` 允许远程调用（移动端要能审批）；但拒绝桌面专属管理命令
  的名单不变；`inbox_item` 不返回超出线程查看范围的内容。
- **不可信内容**：子代理报告、自动化错误、命令输出都是数据；Inbox 只展示，不自动
  执行、不回灌给模型。
- **审计**：`logAt("event", "inbox_action ...")` 记录 itemId/kind/action/结果，
  不记录内容；日志走现有脱敏链路。
- **文件权限**：`inbox/` 目录 0700；`state.json` 不含正文，只有时间戳。

---

## 11. 性能与可靠性

- `list_inbox` 从内存 `Map` 读，O(返回条数)；500 条 p95 < 50ms。
- 启动不阻塞：`initInbox()` 只注册开关；首次 `list_inbox` 懒加载日志。
- 写入：`appendFileSync` 一行，失败只记日志；不 await 磁盘刷新（与 pending row 同纪律）。
- 压缩：异步 idle 执行；压缩期间新写入进内存队列，完成后追加，避免丢行。
- `inbox_changed` 节流 100ms；前端列表重拉防抖 200ms。
- 并发：单 sidecar 写；远程多客户端只读日志 + 写 state.json（sidecar 串行处理命令，
  `inbox_update` 在 mgmtQueue 里天然串行）。
- 崩溃：日志最后一行可能撕裂 → 读取时跳过非法 JSON；源仍是权威，对账修复。
- 多窗口：桌面多窗口共用同一 sidecar；`inbox_changed` 广播到所有窗口，状态一致。

---

## 12. 实施计划

### M0：协议 + 日志 + 审批/提问（最小闭环）

| 文件 | 改动 |
|---|---|
| 新增 `packages/pi-protocol/src/inbox.ts` | Item/State/Outcome/Filter/Action/Counts/请求应答 schema |
| 修改 `packages/pi-protocol/src/index.ts` | 导出 |
| 新增 `apps/sidecar/pi-agent/src/inbox/store.ts` | 日志读写、内存 reduce、用户状态、压缩、`upsertInboxItem` / `resolveInboxItem` / `expireInboxItemsForSession` |
| 新增 `apps/sidecar/pi-agent/src/inbox/summary.ts` | `safePreview`、各 kind 的标题/摘要构造 |
| 新增 `apps/sidecar/pi-agent/src/inbox/index.ts` | `initInbox({enabled})`、`listInbox`、`getInboxDetail`、`applyInboxAction`、`updateInboxState` |
| 新增 `apps/sidecar/pi-agent/src/protocol/handlers/inbox.ts` | 四个命令 |
| 修改 `apps/sidecar/pi-agent/src/protocol/protocol.ts` | 注册 handler；协议头补命令说明 |
| 修改 `apps/sidecar/pi-agent/src/sessions/pending-interactions.ts` | `beginInteraction` / `settleInteraction` 挂钩 |
| 修改 `apps/sidecar/pi-agent/src/sessions/transcript.ts` | 增加 `findInteractionRow(sessionId, interactionId)`：按 id 读原始 `pending_interaction` 行（已结算也可读） |
| 修改 `apps/sidecar/pi-agent/src/protocol/handlers/interactive.ts` | 抽出 `applyToolConfirm()` 领域函数，供 inbox 复用 |
| 修改 `apps/sidecar/pi-agent/src/index.ts` | `initInbox({ enabled: !acpMode })` |
| 新增 `apps/sidecar/pi-agent/test/inbox/store.test.ts` | reduce/幂等/压缩/状态合并 |
| 修改 `apps/sidecar/pi-agent/test/protocol/protocol.test.ts` | list/action/update 协议用例 |

验收：审批/提问挂起后 `list_inbox` 能看到；从 Inbox 批准/作答后原卡片与条目同时结算；
重启后仍未结算的条目还在；ACP 模式无日志写入。

### M1：桌面 MVP

| 文件 | 改动 |
|---|---|
| 新增 `apps/desktop/lib/inbox/inbox-store.ts` | 模块级快照 + `useSyncExternalStore`；`refreshInbox` / `ensureInboxLoaded` / `applyInboxUpdate` / `applyInboxCounts` |
| 新增 `apps/desktop/lib/inbox/inbox-actions.ts` | `piRequest({type:"inbox_action"})`、读/归档/稍后；错误归一 |
| 新增 `apps/desktop/components/inbox/inbox-view.tsx` | 页面壳、Tab、筛选、搜索、批量 |
| 新增 `apps/desktop/components/inbox/inbox-row.tsx` | 行、快捷动作、未读/优先级 |
| 新增 `apps/desktop/components/inbox/inbox-detail.tsx` | 按 kind 渲染详情；审批/提问复用受控卡片 |
| 新增 `apps/desktop/components/inbox/inbox-empty.tsx` | 三种空态 |
| 修改 `apps/desktop/components/agent-thread/clone-thread-shell.tsx` | 侧栏入口 + 徽标 |
| 修改 `apps/desktop/components/agent-thread/base.tsx` | `activeMenu="inbox"` 渲染；全幅页退出面板全屏；首屏种子 |
| 修改 `apps/desktop/lib/i18n/locales/zh/chat.ts` / `en/chat.ts` | `sidebar.inbox` 等键 |
| 新增 `apps/desktop/lib/i18n/locales/zh/inbox.ts` / `en/inbox.ts` | 页面文案；在 `zh.ts` / `en.ts` 聚合 |
| 新增 `apps/desktop/lib/inbox/*.test.ts` | store 合并、动作错误、筛选/排序纯函数 |

验收：侧栏徽标实时变化；待处理列表可批准/拒绝/作答；打开会话定位；已读/归档跨刷新。

### M2：目标 / 自动化 / 子代理 / 后台任务

| 文件 | 改动 |
|---|---|
| 修改 `apps/sidecar/pi-agent/src/goal/goal.ts` | `commitGoal` 挂钩 + fingerprint 去重 |
| 修改 `apps/sidecar/pi-agent/src/automation/runner.ts` | 成功/失败/超时写 Inbox |
| 修改 `apps/sidecar/pi-agent/src/subagent/delegation.ts` | `settleDelegation` 写 Inbox |
| 修改 `apps/sidecar/pi-agent/src/tools/bg-tasks.ts` | 退出转换写 Inbox |
| 修改 `apps/sidecar/pi-agent/src/inbox/*` | 对应 summary/detail/action |
| 修改桌面 Inbox 组件 | 详情渲染、类型筛选、分组 |
| 新增 `apps/sidecar/pi-agent/test/inbox/sources.test.ts` | 四类源的映射矩阵 |

验收：四类终态都能出现；失败项可重跑；目标恢复后条目消失；子代理报告可打开；
后台任务退出可见。

### M3：跨端与体感

| 文件 | 改动 |
|---|---|
| 修改 `apps/electron/main/remote.ts` | `BROADCAST_TYPES` 加 `inbox_changed` |
| 修改 `apps/mobile/app/*` | 收件箱入口/列表/详情（复用协议） |
| 修改 `apps/desktop/lib/pi/wire-bus.ts` 消费方 | 订阅 `inbox_changed`（不需要改 bus 本体） |
| 修改 `apps/desktop/components/agent-thread/*` | 快捷键、自动已读、通知点击深链 |
| 修改 `docs/remote-access.md` | 说明收件箱在远程端的可用性 |

验收：桌面批准后网页端徽标同步消失；移动端能处理审批/提问；断线重连后状态一致。

### M4：后续（不在本次实施）

- `queue` 暂停项、`checkpoint` 审阅项。
- snooze / 免打扰 / 完成类推送。
- AI 分诊：按项目/类型排序、自动摘要（需用户显式开启，且不把摘要写回模型）。
- 团队收件箱（Bot Team / 多人会话）。
- 外部工作项（GitHub/Jira/Linear）作为独立 Tab。

---

## 13. 测试计划

### 13.1 单元

- `store.ts`：upsert 幂等、resolve 顺序、last-wins、非法行跳过、压缩保留 open、
  用户状态合并、5000 条淘汰。
- `summary.ts`：脱敏（sk-/Bearer/KEY=/base64）、空白压缩、240 字符截断、各 kind 标题。
- `inbox-actions.ts`：允许动作白名单、already-resolved、stale、session mismatch。
- 前端纯函数：tab/kind/query 过滤、排序、计数（needsAction/unread/archived）。

### 13.2 Sidecar 协议集成

| 场景 | 期望 |
|---|---|
| 审批挂起 → `list_inbox` | 一条 P0 approval，`requiresAction=true`，counts.needsAction=1 |
| 从 Inbox 批准 | 转录 `interaction_resolved` 行；原卡片消失；条目 done/approved；counts 归零 |
| 从线程内批准 | `inbox_changed` 推到 Inbox；条目不重复 |
| 另一个会话的审批 | 不打开该会话也能看到并批准 |
| 审批后重启 | 已结算条目不复活；未结算条目仍在 |
| 源已消失（删会话） | 条目 expired；详情 stale；不报红屏 |
| 自动化失败 | P1 failed；`retry` 后新 run 产生新条目 |
| 子代理完成 | P2 completed；报告摘要 ≤240；详情全文来自活动文件 |
| 目标暂停 | P1/P0；`resume` 后条目 resolve |
| 后台任务退出 | 非零退出 P1；0 退出 P2 |
| ACP 模式 | `inbox/` 不写；命令不出现 |

### 13.3 桌面组件 / E2E

- `apps/desktop` 组件测试：空态、加载、错误、筛选、键盘、动作回调。
- CDP e2e（参考 `apps/electron/scripts/e2e-chat.mjs`）：启动 sidecar → 触发审批 →
  Inbox 徽标出现 → 点击批准 → 原会话继续 → 条目消失。
- 远程 e2e（参考 `e2e-remote.mjs`）：桌面挂起审批 → 网页端看到 → 网页批准 →
  桌面条目消失。
- 性能：500 条日志 `list_inbox` < 50ms；100 次 upsert 不阻塞 turn（手动计时/日志）。

### 13.4 验收标准

1. 后台会话的审批/提问在 200ms 内出现在 Inbox（含徽标）。
2. 从 Inbox 结算后，源会话的挂起卡、Inbox 条目、侧栏计数三处一致。
3. 重启桌面后，未结算条目与已读/归档状态保留。
4. 桌面与网页端看到同一份条目；一端归档，另一端同步消失。
5. 同一件事只产生一条；重复事件不增加计数。
6. 日志写失败不影响审批/自动化/子代理主流程。
7. ACP 模式不产生 Inbox 文件，也不影响编辑器权限 UI。

---

## 14. 开放问题

1. **「已完成」的噪音**：自动化成功是否默认进「已完成」？建议进，但默认筛选只看
   P0/P1；用户可在类型筛选里关掉。若实际使用中觉得吵，再改成默认只收失败。
2. **目标完成是否算「待查看」**：建议 P2 展示一次，读后归档；不放进「待处理」。
3. **审批批量**：不做。批量批准会破坏「逐条点名」的授权语义。
4. **snooze 的默认时长**：1 小时 / 明天 9 点 / 下周一，三档；是否记忆上次选择待定。
5. **是否把「普通轮次完成」做成可选**：默认不做；如果用户强烈需要，可作为
   「关注此会话」的订阅，而不是全局收件箱。
6. **后台任务输出尾巴**：v1 不做；需要时通过 `task_output` 拉取并限制 8KB。
7. **多用户/团队**：等 Bot Team / 房间模型落地后再设计共享收件箱，避免现在把
   `userId` 塞进 item 造成半成品多租户。
8. **SQLite 迁移**：如果日志超过 10k 条或需要复杂查询，再评估把索引迁到宿主表；
   v1 保持文件。

---

## 15. 附录：现有代码地图

| 关注点 | 文件 |
|---|---|
| 挂起交互台账 / 转录行 | `apps/sidecar/pi-agent/src/sessions/pending-interactions.ts`、`sessions/transcript.ts` |
| 审批/提问结算 | `apps/sidecar/pi-agent/src/protocol/handlers/interactive.ts`、`agent/modes.ts`、`mcp/mcp-tools.ts`、`tools/question-tools.ts` |
| 挂起交互协议 | `packages/pi-protocol/src/interactions.ts` |
| 目标状态 / 唯一出口 | `apps/sidecar/pi-agent/src/goal/goal.ts`、`goal/goal-state.ts` |
| 自动化调度 / 运行 | `apps/sidecar/pi-agent/src/automation/runtime.ts`、`automation/runner.ts`、`packages/automation-core/src/types.ts` |
| 子代理 | `apps/sidecar/pi-agent/src/subagent/delegation.ts`、`subagent/activity-store.ts` |
| 后台任务 | `apps/sidecar/pi-agent/src/tools/bg-tasks.ts` |
| 队列 | `apps/sidecar/pi-agent/src/sessions/prompt-queue.ts` |
| 协议注册 / 流 | `apps/sidecar/pi-agent/src/protocol/protocol.ts`、`protocol/stream.ts`、`protocol/thread-events.ts` |
| 远程广播白名单 | `apps/electron/main/remote.ts` |
| 桌面交互 store | `apps/desktop/lib/pi/pi-interactions.ts`、`pi-unread-sessions.ts` |
| 桌面事件总线 | `apps/desktop/lib/pi/agent-events.ts`、`wire-bus.ts` |
| 侧栏菜单 / 主区 | `apps/desktop/components/agent-thread/clone-thread-shell.tsx`、`base.tsx` |
| 会话打开总线 | `apps/desktop/lib/pi/open-session.ts`、`pi-thread-navigate.ts` |
| 设计规范 | `DESIGN.md`（界面 token / 构图 / 无障碍） |
