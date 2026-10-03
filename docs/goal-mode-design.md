# 目标模式（goal mode）设计

## 一、这是什么

目标模式是会话模式的第四档。切到这一档之后，用户说的**第一句话就是目标**，模型跨轮
自治地把它做完，中途不需要用户点「继续」；直到被停机阀叫停为止。

```
agent  = baseTools + subagentTools + plan_enter
plan   = 只读子集 + plan_write + plan_exit
ask    = 纯只读子集（无 bash）+ ask_needs_work
goal   = baseTools + subagentTools + goal_complete + goal_blocked      ← 本设计
```

`goal` 拿的是**完整工具集**（含 write/edit/bash），不含 plan 三件套。理由很直接：
目标模式的价值是「放手做完」，给它只读工具就退化成 plan 了。

### 思想来源与 clean-room 声明

问题分解层面参考了 `pi-goal`（MIT, Copyright (c) 2026 narumiruna）。MIT 允许复制与
商用，本项目实际**未复制任何一行代码、任何一段提示词原文**：目标状态机、字段命名、
提示词文本、护栏实现全部按本项目既有风格独立撰写。吸收的只有三条问题意识——

1. 目标是一个**显式状态机**而不是「跑到底」的布尔标志（终态、暂停态需要可区分）；
2. 出口工具要带 **stale-turn guard**（过期护栏，见 §四）；
3. 消耗类上限必须**自动停下并给出理由**，而不是把配额烧光（本项目只吸收了其中的轮次上限一条，见 §三；且做了不同处理——上限挂在每条目标上而不是全局配置）。

没有吸收的是它对 Pi CLI `ExtensionAPI` 钩子竞态的补偿代码（约占其 `runtime.ts` 的大半），
本项目直接持有裸 `Agent`，这些竞态不存在。详见 §七。

## 二、状态机

```
                 ┌──────────────────────────────────────┐
                 ↓                                      │
   (建目标) → active ──goal_complete──→ complete ◄──goal_blocked── blocked
                 │  ↑                                      │
   轮次上限 /    │  │ resume                  resume      │
   停滞 / 用户   │  │                                      │
   输入 / 异常   ↓  │                                      │
              paused  ─────────────────────────────────────┘
```

| 状态 | 含义 | 允许的出口 |
|---|---|---|
| `active` | 自治循环中（**注意：只有这一档配上「有 run 在飞」才真的在跑**，见 §五） | 两条停机阀 + 两个工具 + 离开 goal 档 |
| `paused` | 停机阀触发 / 用户输入接管 / 离开 goal 档 / 重启恢复 | `resumeGoal` → active（点「继续」会补起一轮） |
| `blocked` | 模型主动报告死锁 | `resumeGoal` → active |
| `complete` | 终态 | 无（`VALID_TRANSITIONS.complete` 是空集） |

迁移表在 `src/goal/goal-state.ts` 的 `VALID_TRANSITIONS`，所有迁移经
`transitionGoal` 走，非法迁移返回 `undefined` 而不是抛异常——调用方一律按
「迁移没生效」兜底，绝不因为一次状态竞争让整个 turn 崩掉。

## 三、两条停机阀 + 用户输入即接管

判定全部收敛在 `decideContinuation()` 一个纯函数里（`src/goal/goal-continuation.ts`），
逐条短路，**顺序即优先级**：

```
1. provider 报错 / 被中止                                   → paused
   ↓ 否则
2. 轮次上限        turnCount >= goal.maxAutoTurns（默认 300） → paused
   ↓ 否则
3. 无进展停滞      连续 maxStallTurns 轮（默认 3）零工具且输出指纹不变 → paused

   都不触发 → 注入续跑消息
```

**「模型自己收了尾」不在这里判**：`goal_complete` / `goal_blocked` 在工具的 `execute`
里就把状态改好了，所以函数开头那次 status 检查已经覆盖它。曾经在这里加过一个「本轮
出现过目标工具调用就停」的分支，本意是兜底「工具被 modeBeforeToolCall 拦掉」，结果
只有 bug：那个场景下 `run.mode` 已不是 goal，`stream.ts` 根本不会调到这个函数，于是
该分支只在**工具被拒**时执行——过期护栏拒掉旧 `goal_id`、或摘要命中「说没做完」的
正则——一次误判就终止整个目标。

**轮次上限挂在目标上**（`Goal.maxAutoTurns`），不是全局设置：该跑多少轮取决于任务
本身，「补个 README」和「把整个鉴权重构完」差两个数量级，全局值注定对一半任务是错的。
它随目标落盘、随目标回放，用户在常驻条上点分母就地改（见 §九）。默认 300 轮，0 = 不限。
判定每个轮边界读一次，所以改完下一轮即生效，不需要重排提示词（这个参数只进停机判定，
不进系统提示词）。把上限**调到已跑轮数以下**时顺手暂停目标——否则会出现「上限 50、
当前已跑 120 轮还在跑」这种自相矛盾的状态。

**另有一层会话记忆**（`sessions.goal_max_turns` 偏好列），与 model / 思考档位同型：
用户定过的数按会话记住，这个会话的下一条目标不用重新估。取值顺序：

```
请求显式带的（用户在条上填的）
  → 会话偏好列（这个会话上次定的）
    → 默认 300
```

三态必须分得开，合并过一次、代价是「用户选过不限，下一条却被当成没设过」：

| 层 | 「从未定过」 | 「明确不限」 | 具体轮数 |
|---|---|---|---|
| `Running.goalMaxTurns` | `undefined` | `null` | number |
| `sessions.goal_max_turns`（文本列） | NULL | `"0"` | `"120"` |
| `Goal.maxAutoTurns` | ——（永远有值） | `null` | number |

⚠️ 读这三层时**不能用 `??`**：`null` 是「明确不限」，`??` 会把它当成缺省值悄悄回落成
300。测试里有一条专门钉这个（「会话偏好是「不限」(null) 时不能回落默认 300」）。

桌面侧还有一层「本次运行里显式改过的值」，它的作用是**决定要不要发这个字段**：
没改过就不发，让 sidecar 按自己的顺序裁决——前端补一个默认值只会把会话记忆冲掉。

无进展阈值（默认 3）**刻意不开放给用户**——调大等于放任模型对同一盘面反复重试，
调小会让正常的思考停顿被误判成停滞，两个方向都只会更难受。

停滞判定用的是「有没有**实质**工具调用」：只有目标工具调用的轮次不算进展——那种轮次
意味着目标工具被拒了（成功的会在函数开头就停掉），模型拿到的是一句「重新调用试试」，
原地重复并不比什么都不做更前进。

两条停机阀谁先谁后无所谓——触到任意一条都只是停，不存在「另一条会给出更好理由」
的情况。第三条停机阀（用户输入即接管）不在这个函数里，它发生在 `input` 阶段，
由 `syncGoalOnUserPrompt` 在用户消息进 run 时触发——**普通发送与「并入当前轮」两条路
都要调它**，只挂一条的话另一条就是能绕过接管的缺口。

### 为什么没有 token 预算

原本还有第四道阀：目标可带一个 token 预算，超限后转入 `budget_limited` 并注入一条
「只准调 `goal_complete`」的收尾轮。它已经整体删除（字段、状态、收尾提示词、哨兵前缀、
协议字段、UI 读数、判定分支一并清掉），删掉的理由是它设计上就说不清：

- **用户无法预判**。一个「把测试跑通」的目标可能花 20k 也可能 2M，预算填多少都是猜。
  填小了目标被腰斩，填大了等于没设。
- **它按累计量截断，不看进度**。同一目标跑到第 4 轮和第 24 轮花掉的 token 可能
  一样多，预算并不知道该在哪停。
- **收尾轮本身还要再烧一次模型请求**去写完成说明，而此时用户已经看不到「还剩多少
  目标没做完」这个事实——它用一个模型自己判断的「完成」覆盖了预算。

`tokensUsed` 因此降级为纯展示字段（常驻条上的一个计数，鼠标悬停写明「仅供参考，
不参与停机判定」），不参与任何停机判定。想省配额的用户有轮次上限、随时可以打断，
目标真的很贵时正确反应是让人看见消耗再自己决定，而不是让程序在他没定的数字上
自动刹车。

### token 账是现累的，不是从转录重算的

`Goal.tokensUsed` **单调递增**：每个轮边界把 run 上攒着的增量折进来，只加不减。

```
message_end（assistant，带 usage）→ run.usagePending += 四项相加
子代理结算（settleDelegation）    → run.usagePending += result.tokens
turn_end（continueGoalTurn）      → goal.tokensUsed += usagePending; usagePending = 0
```

早期实现是「会话累计 − 建目标时的基线」，两个来源都是读转录。它有三个毛病，
换掉的理由分别是：

1. **看不见子代理。** 子代理是独立 `Agent`、独立 `messages`，用量从不写进父会话
   转录（`src/subagent/` 整个目录里没有 `usage`）。而 goal 档的工具表带 Task 组，
   也就是鼓励委派——「目标靠子代理干完了大半活」时读数会严重少报。现在子代理自己
   记账（`SubagentRun.tokens`），结算时汇给父 run：重复结算被 `record.status` 守卫
   挡住，同一笔不会记两次。
2. **把暂停期间的消耗算进来。** 基线只在建目标时取一次，之后 resume 不重取，于是
   用户在别的模式里干的活、以及用户接管的那一轮，全被记在这条目标账上。现累的
   增量只在「目标是 active 且这一轮正在跑」时才累加——暂停轮结算时
   `decideContinuation` 直接返回，那个数被丢掉（顺带把累加器清零）。
3. **是 O(n²)。** `sessionUsageTotals` → `readTranscript` → `scanTranscript` 是
   `readFileSync(整个文件)` + 逐行 `JSON.parse`，无缓存；而它在**每个轮边界**被调
   一次。300 轮的目标就是 300 次全长重读，文件还在变长。现累是四个加法。

建目标时清零累加器：同一 run 里建目标之前花掉的（比如用户先聊了两句才切到目标档）
不算这条目标的。

口径不变：四项相加（input + output + cacheRead + cacheWrite），与用量统计页
（`usage-stats.ts`）和上下文面板同源，error/aborted 轮不计（`messageUsageTokens`）。
含 cacheRead 意味着长循环里这个数会比直觉大一个数量级——这是**全局口径**，不是目标
模式特有的偏差，单改一处会让两个页面数字对不上。

### 停下之后，提示词必须跟着改口

`goalPromptBlock` 是**状态敏感**的，不是「有目标就注入同一段」：

- `active` → 目标原文 + `goal_id` + 轮次 + 自治纪律段；
- `paused` / `blocked` / `complete` → 目标原文（用户下一句话常拿它作指代）+
  一段显式撤销：**「模式段那套『别收手、别问、系统会自动续下一轮』此刻不适用」**。

不这么做就会出现一个很难归因的症状：静态模式段 `GOAL_MODE_PROMPT` 通篇是在给
`active` 写的，而它**不随状态变化**。目标 paused 之后用户在 goal 档里说话，模型
同时读到「你正在自治循环里，别停下来问」和（本该有的）「目标已暂停」——如果后者
根本不存在，模型就继续埋头干目标，而 composer 上方明明写着「已暂停」。用户看到的
是「上面说暂停了，对话还在进行中」。修复前正是如此。

这也是为什么「用户输入即接管」这条阀看起来生效了（状态确实变了）却没真的接管：
状态机停了，提示词没停。

### 无进展指纹

取本轮 assistant 全部 text 块 → NFKC 归一 → 去空白 → 去控制字符 → sha256。

归一化的意义是让「同一段话的排版/大小写/全角差异」不被误判成进展——模型卡住时的
典型表现正是把同一句话换几种标点再吐一遍。空输出与纯标点输出返回 `undefined`，
不参与停滞判定（本轮什么都没说 ≠ 原地打转，而是可能正在想）。

**调过任何工具就一定在推进**，直接清零计数——这条比指纹比较更粗但更可靠：工具调用
意味着模型做了什么实际动作。

### 轮次只在结算时 +1

`turnCount` 在 `turn_end` 判定时由 `settleGoalTurn` 递增，**注入本身不计数**。

原因：上下文溢出时 `dispatchPrompt` 会用**同一条文本**重跑那一轮（`runStepWithRecovery`）。
若在注入时就计数，重跑会让轮次凭空多算一格——用户设 300 轮上限，实际可能只跑 200 轮。

### 用户输入即接管

在 `dispatchPrompt` 每轮开跑前同步（`syncGoalOnUserPrompt`）：

- goal 档且**无目标** → 这条消息就是目标（用 `msg.text` 原话，不是拼了附件提示行的 `promptText`）；
- goal 档且有 active 目标 → `paused` + `resetSafetyEpoch`。

必须重置安全 epoch：用户中途发消息通常是在纠偏，这条消息本身已经占掉一轮上下文，
模型拿到的是全新起点。沿用暂停前的计数等于让用户的纠偏白白吃掉半个轮次预算。

非 goal 档一律不动目标——agent 档里那句「顺便把这个做完」不该复活一个已停的目标。

## 四、过期护栏（stale-turn guard）

两个出口工具的 `goal_id` 是**必填参数**，执行时与当前目标比对，不一致就拒绝并把当前
目标原文回给模型。

这不是防御性编程，是真实竞态：模型的 `goal_complete` 在 tool_call 排队期间，用户已经
发了新消息或换了目标。没有 id 比对就会出现「旧目标的完成把新目标标成完成」——而这个
bug 的症状（目标莫名完成）是静默的，日志里什么都看不出来。

护栏做在 `transitionGoal` 的 `expectedGoalId` 参数上，所以所有终结路径都免费获得它。

## 五、续跑注入的时序契约 ⚠️

**这是本设计对 `@earendil-works/pi-agent-core@0.99.2` 的唯一隐式依赖，升级时必须复查。**

```
turn_end 监听器 settle 之后、vendor 循环退出之前，循环恰好轮询一次 followUp 队列。
```

长度截断续跑（`stream.ts` 的 `makeAutoContinueMessage`）就是靠这条契约生效的，本设计
复用同一入口 `run.agent.followUp(...)`，没有另造唤醒机制。

若上游改动这个时序（例如把轮询提前到 turn_end 监听器**之前**），症状是：**所有安全阀
都判定正确、状态盘面正确，但目标永远只跑一轮**。排查时先确认这条契约是否还在。

### ⚠️ 状态是 active ≠ 循环在跑

**这是本模块最容易踩的一条，一次踩出过三个 bug（「继续」按钮点了没用、切档后卡死、
重启后谎报进行中），共同症状都是「条上说在跑，实际什么都没跑」。**

唯一的循环驱动源是：**有一个 run 正在跑，并且它走到了 `turn_end`**。换句话说，

- 把状态改成 active **不会**启动任何东西；
- 一个已经停下来的目标，**不会**被任何定时器/轮询唤醒；
- `paused` 意味着那个 run 早就结束了（`decideContinuation` 对非 active 一律 stop，
  之后 followUp 队列为空，vendor 循环退出）。

所以凡是「让目标重新跑起来」的入口，都必须自己补上那一轮：

| 入口 | 做了什么 |
|---|---|
| 用户在 goal 档发消息建目标 | 这一轮本来就是他要发起的，跑完 `turn_end` 自然接上循环 |
| 点「继续」（`goal_resume`） | 状态搬回 active 后，**空闲时必须补起一轮**（`kickGoalLoop` → `dispatchPrompt`，文本带 `GOAL_CONTINUE_PREFIX`），否则状态是 active 而没有任何东西在跑 |
| 进程重启 | run 随进程没了，回放出来的 active 一律降级为 paused，等用户点「继续」；**不自动续跑**（没人看着就自动开始烧钱不是好默认） |
| 离开 goal 档 | 主动暂停目标（`pauseGoalOnModeExit`）——续跑判定被 `run.mode === "goal"` 门着，切走后既没人续也没有任何代码会去停机它 |

补起一轮时那个 `GOAL_CONTINUE_PREFIX` 前缀是必需的，不是装饰：注入走的是普通 prompt
路径，会在 `syncGoalOnUserPrompt` 里被判定「这条消息和目标什么关系」；没有前缀就会被
当成用户接管，刚 resume 就被自己暂停。反过来，那条判据也是**唯一**能让系统注入和用户
输入区分开的地方——所以「并入当前轮」（steer）那条路也接进了同一个函数，两条输入路径
共用一套判据。

### goal 档不走长度截断续跑

`stream.ts` 的 `turn_end` 分支里，goal 档**跳过** `needsLengthContinuation` 路径直接进
目标判定。两条原因：

1. 目标续跑消息会把目标原文重述一遍，严格强于长度续跑的「继续」；
2. `run.lengthContinues` 是按**用户轮**重置的（`dispatchPrompt` 每轮清零），一个跑 300 轮
   的目标会在第 4 轮左右撞上 `MAX_LENGTH_CONTINUES` 被误杀。

## 六、持久化

目标状态是**派生盘面而非模型消息**，所以走「不占 seq 的事件溯源行」形态
（与 `queue_state` / `model_change` 同款）：每次变更追加一行 `goal_state`，
`scanTranscript` 单遍 last-wins 回放。撕裂行整条判废、保留上一份有效状态。

**回放出来的 `active` 一律降级为 paused**，理由见 §五：驱动那个循环的 run 随进程一起
没了，原样带回来的 active 是个谎报。降级时顺手落一行，避免内存与 JSONL 长期不一致。
上限、轮次、停滞计数、指纹都按原样带回来（重启不该偷偷放宽安全阀）。

**token 账随行一起回来**：`tokensUsed` 是单调累加值（见 §三），不需要任何基线补偿。
换成现累器之前这里有一段「基线 = 当前累计 − tokensUsed」的补偿代码，是给「从转录
重算」那套擦屁股用的，已随那套一起删掉。

`goal: null` 的行**必须落**：目标停在「已完成」和「被用户清掉」在回放上要区分得开，
否则重启后 UI 会把一个早就收工的目标重新当成进行中显示。

消息侧过滤：`GOAL_CONTINUE_PREFIX` 哨兵常量单源在 `pi-protocol`（`GOAL_INTERNAL_PREFIXES`
数组是 UI 隐藏判定的唯一入口），在 5 处过滤——`toUiMessage`、`historyToUiMessages`、
`isTruncationStoppedRow` 的下一行判定、`sameRunTail` 计算、`thread_snapshot` 循环。
（原本还有一条收尾注入的哨兵 `GOAL_WRAP_UP_PREFIX`，随 token 预算一并删除。）

## 七、明确不做的事

| pi-goal 的做法 | 本项目的既有能力 | 结论 |
|---|---|---|
| `session_before_compact` / `session_compact` 钩子手工记账并决定是否续跑 | `runCompaction` 保留转录首条 system 头，目标上下文**随系统提示词天然跨压缩存活** | 不需要任何压缩钩子 |
| `isPiOwnedCompactionRetry` / `goalRecovery` 溢出重试归属仲裁（约 200 行） | `run.pendingOverflowRecovery` + `dispatchPrompt` 压缩后同文本重跑 | 不需要 |
| `pendingNonGoalInputs` steer/followUp 优先级仲裁 | `prompt-queue.ts` v2/v3 队列 + `steerIntoActiveRun` + `findUnansweredSteers` 回收 | 不需要 |
| `GoalToolPolicy` 动态隐藏/恢复工具避免 schema 抖动 | `toolsForMode` 按模式整表重建，切模式本就是既有路径 | 不需要 |

另外两项**暂时不做**，留作未来考虑：

- **`goal_wait`（外部等待）**：依赖一个「非目标消息唤醒目标」的信号源。当前只有
  用户输入，而用户输入的语义已经是「接管」（暂停目标）而不是「喂给目标」——两者的
  优先级需要先想清楚，否则会出现用户纠偏一句、目标接着跑两句的错位。
- **managed-run RPC**：本项目协议层是 requestId 驱动的请求-响应模型，不是 Pi 那种
  托管长进程模型。目标循环完全活在一次 `agent.prompt()` 调用内部，不需要额外生命周期。

## 八、枚举扩容检查表

`SessionMode` 加第四档时，下面每一处都必须同步（漏改的表现都是**静默降级**而不是报错）：

- [x] sidecar `src/types.ts` 的 `SessionMode` 联合
- [x] sidecar `src/agent/modes.ts` 的 `normalizeSessionMode`
- [x] sidecar `src/agent/modes.ts` 的 `PLANNING_BY_MODE`（显式映射，加 `goal: "inactive"`）
- [x] sidecar `src/agent/modes.ts` 的 `toolsForMode` / `composeModeSystemPrompt` / `modeBeforeToolCall`
- [x] sidecar `src/protocol/handlers/interactive.ts` 的 `set_mode`（改走 `normalizeSessionMode` 比对）
- [x] `packages/pi-protocol` 的 `sessionSummarySchema.mode`
- [x] desktop `lib/pi/pi-session-mode.ts` 的 `SessionMode` + `normalizeSessionMode`
- [x] desktop `lib/pi/pi-bridge.ts` 的 `mode_changed` / `planning_state` 响应类型
- [x] desktop `components/agent-thread/mode-picker.tsx` 的 `OPTIONS` + `currentOption`

> 顺带修的历史漏项：`sessionSummarySchema.mode` 原本是 `z.enum(["agent","plan"])`，
> **漏了 `"ask"`**——ask 档的会话偏好一直写不进索引表。本次一并补齐。

## 九、UI

两个入口：**模式切换器的第六项** + **composer 上方常驻条**（`goal-strip.tsx`）。
轮次上限不设设置页入口——它是每条目标自己的字段，入口就在显示它的那个数上。

常驻条的底色不能省：它就贴在消息列表末尾上方，透明的话滚动的消息会直接穿过条里
的文字（一长串代码从「进行中 · 第 3/300 轮」底下穿过去）。做法与输入框同款——
`bg-(--composer-bg)` 叠 `backdrop-blur-md`，滚动内容被糊掉而不是透出来。

### 输入框上方三条悬浮条的间距约定

队列条（`PromptQueueBar`）、审批卡（`ToolApprovalCard`）、目标条（`GoalStrip`）是
`ComposerPrimitive.Root` 里并排的三个兄弟。约定：**各自带 `mb-2`、满宽不缩边**，
与输入框左右对齐。

不给父级加 `gap`：队列条是常驻挂载、靠 `grid-template-rows: 0fr↔1fr` 折叠的容器，
父级 `gap` 会在它折叠时留下幽灵间距。所以「按内容有无决定要不要留边距」这件事必须
留在子元素自己身上。历史上这三条各写各的（8px / 4px / 0px，且目标条还额外 `mx-2`
缩了一圈），看起来就是没对齐、且目标条直接贴在输入框上。

### 轮次上限的编辑入口

分母就是按钮。三态各自的行为：

- **goal 档但无目标** → 条右侧显示「上限 300 轮」，点开可改（0 = 不限）。显示的是
  「本次改过 → 会话记忆 → 默认」三层算出来的那个数，也就是建目标时真正会用的数；
  只有本次真的改过才随第一句话带给 sidecar（`prompt.goalMaxAutoTurns` → `createGoal`）；
- **进行中** → 「第 12/300 轮」，点分母就地改，走 `goal_set_limit` 直接改目标自己的字段；
- **因撞上限暂停** → 触发文字换成「提高上限并继续」，提交后顺手恢复目标——「改大上限」
  和「继续跑」本来就是一件事，没必要点两次。

预设值经桌面侧的 `pi-goal-limit-draft.ts` 中转，理由很实际：值在常驻条上，提交它的
动作在 `pi-client` 里，两者不在同一棵组件树上。目标一旦建好就不再走这个中转（后用
`goal_set_limit` 直接改目标字段，sidecar 同时回写会话偏好列）。

⚠️ **协议边界上的坑**：`pi_prompt` 这个 Tauri 命令是按固定键重建 JSON 的，`invoke`
传进来的多余参数会被 serde 静默丢弃。所以新增任何 prompt 字段，必须在
`src-tauri/src/pi_agent.rs` 的命令签名里加一个参数并写进 payload——漏了就是
「前端填 100、发出去仍是 300」，不报错、不警告。

常驻条之所以是「常驻」而不是 toast：两条停机阀都会让自治循环**静默停下**。
用户离开十分钟回来，如果停机原因只在一条转瞬即逝的通知里出现过，他看到的就只是
「模型突然不干活了」——看不出是自己设的上限到点了，还是模型卡住了。

条的三态：

- goal 档但无目标 → 「描述你要完成的目标……」。这一行不是装饰性引导，
  是目标模式**唯一的建目标入口**的功能说明；
- active → 目标文本 + 状态 + `轮次/上限` + 累计 token（悬停写明仅供参考）；
- 停止态 → 同上 + 暂停原因（把 sidecar 的英文判定句翻成中文）+ 「继续」按钮。

两个容易踩的表述坑，都已修：

1. **运行中的指示不能是暂停符号**。原实现给 active 态配了一个 `PauseIcon`，而状态
   文字在窄窗口下被 `hidden sm:flex` 隐藏——于是窄窗口只剩一个 ⏸，读起来就是
   「已暂停，但对话还在跑」。现在运行中用呼吸绿点，状态文字不再参与响应式隐藏。
2. **「目标停了」与「这一轮在跑」是两个事实，要分开说**。用户发消息接管后目标立即
   paused，但这条消息的轮次正在跑；条上只写「已暂停」会被读成「什么都没在跑」。
   现在这种情况补一行「正在处理这条消息」。

`statusLine` 由 sidecar 算好后随快照下发，**两端不各算一遍**：轮次上限的展示口径必须
与「什么时候真的停下来」同源，否则条上会显示「3/300」而实际已经停了。

## 十、测试

```
bun test test/goal/                 # 状态机 + 停机判定矩阵 + 生命周期接缝 + 提示词块
bun test test/agent/modes.test.ts   # 工具表 / 门控 / 提示词结构 / 切档收尾
```

`test/goal/goal-lifecycle.test.ts` 专门守「状态与生命周期」的接缝——这一层出过的
全是「状态对了但没人跑」类问题（没有异常、没有报错，只有条上说一套、实际干另一套）：

- 哨兵注入不被当成用户接管（resume 能跑通的前提）、普通消息仍然接管；
- 离开 goal 档收尾、已停下的目标不重复迁移、无目标时不抛；
- per-goal 上限随目标走、改上限不动状态、调低到已跑轮数以下顺手暂停；
- 重启回放：active 降级为 paused、上限与计数原样带回来；
- token 账的现累语义：增量折进目标并清零、**暂停期间的增量不记进目标**、建目标清零
  累加器、单调不减（`test/goal/goal-lifecycle.test.ts`），以及子代理用量汇给父 run
  且重复结算不重复记账（`test/subagent/subagent.test.ts`）；
- 会话偏好的三层取值顺序、以及「明确不限」不能被 `??` 当成缺省（回归钉子）。

数据层（`sessions.goal_max_turns`）的往返在两端各有测试：Rust 侧
`data.rs::session_prefs_goal_max_turns_roundtrip`（含 session_list 投影——漏了列表
投影的列，前端切回会话就无从水合，表现成「这条会话的数没记住」）。

其余重点覆盖：迁移表全枚举、过期护栏、**被拒的目标工具不终止循环且不计进展**
（「只有目标工具调用不算进展」是删掉误判分支后的补偿判据）、**非 active 目标块
必须撤销自治指令**（提示词与状态机同向变化）、两条停机阀各自触发、**token 用量不
产生任何停机判定**、指纹归一化的边界、哨兵消息不误判为用户气泡、`planning` 态在
goal 档是 `inactive`（枚举扩容塌陷点）、自动化 turn 里目标工具不可达。
