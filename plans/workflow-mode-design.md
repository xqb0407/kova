# 设计文档:pi-kova 工作流模式(v1,剧本化多代理编排)

> 定稿于 2026-10-06。定位:目标态设计 + 分期落地路线,**只设计、不实现**。概念骨架取自两份外部参照——pi-dynamic-workflows(Pi 扩展:vm 确定性编排 + 位置 journal + 恢复/预算体系)与 ZCode dynamic-workflows(TS 静态编译 facade + world.run 确定性门 + 具名 actor 逐 ask 缓存)——但编排形态、安全阀与产品面全部按 Kova 现有结构重新推导,实现落点全部指向现有文件。
>
> **明确不做的(整个功能)**:JS 脚本 / vm 编排(§1)、**运行时**嵌套工作流(§4.8;组合用提案期展开替代,§5.1)、token 预算阀(§4.4,理由照抄 goal-state.ts 的否决论证)、关键词自动武装(§4.1)、跨线程 / 跨项目 run(§4.6)、进程外执行器(§2)。
>
> 背景调研:pi-dynamic-workflows 源码(`~/Downloads/pi-dynamic-workflows-main`,核心 `workflow.ts` 的 journal/replay、`workflow-manager.ts` 的生命周期、`errors.ts` 的失败分类);ZCode dynamic-workflows skill(facade 契约、AmendWorkflow 缓存语义、escalation)。

## 0. 一句话定位

Kova 已经有"团队成员"——子智能体定义(`subagent-definitions.ts` 的三层发现:内置 > 系统 > 工作区/插件)。工作流模式补上"剧本":把多个委派编成一份**可保存、可重放、可观测**的运行。这与产品主张(ai-teamplte = 可保存的 AI 团队)是同一件事的两半:成员是名词,剧本是动词。

与现有三档的分工(模式枚举在 `types.ts:321` 的 `SessionMode`):

| 模式 | 形态 | 执行者 | 产物 |
|---|---|---|---|
| plan | 单线程 HITL 计划执行 | 主模型自己 | 计划文件(plan_write) |
| goal | 单代理长自治循环 + 验收契约 | 主模型逐轮续跑 | goal artifact |
| **workflow(新)** | **多代理扇出编排** | **执行器(sidecar 纯 TS)驱动 Task 委派** | **运行记录 + 合成报告/artifact** |

## 1. 编排形态:结构化剧本,不是 JS 脚本(决策依据)

pi-dw 的做法是"模型写一段 JS,进 vm 跑,按位置索引 journal"。ZCode 的做法是"模型写 TS,编译期校验后跑"。Kova 两条都不取,取**第三形态:主模型用工具声明结构化步骤(剧本),确定性执行器在 sidecar 里跑**。理由四条,全部锚定本项目现实:

1. **产品面**。桌面应用的用户看到的是步骤卡、确认对话框、中文 phase 名——不是一闪而过的脚本。pi-dw 自己也在 3.0 把"关键词强制改写消息"退成"授权不强制",就是被 #88/#89 这类产品问题教的;Kova 从第一天就该用显式触发 + 结构化提案。
2. **维护成本**。vm realm + 确定性守卫(`DETERMINISM_PRELUDE` 废 `Date.now`/`Math.random`)那一整套,是为"模型手写代码"的表达力付的税。工具声明式步骤天然结构化,不需要沙箱——执行器就是 sidecar 里的普通 TS,和 `subagent/run.ts` 同一信任级别。
3. **已有基建的引力**。Kova 的委派循环(`Task`/`TaskWait`,并发 8,活动流,报告 12k 上限,报告回投)就是现成的"agent() 调用"原语;goal 模式的"协商轮提案 → 确认 → 出口工具结算"就是现成的人机骨架。剧本方案全部复用,脚本方案全部绕开。
4. **journal 可以做得更好**(§4.2)。工具声明的步骤有稳定 key,内容寻址缓存不存在"插入步骤使后续位置全部失效"的问题——这是相对 pi 位置索引的真实改进空间,不是妥协。

**从两家各拿什么:**

| 拿来 | 来源 | 落点 |
|---|---|---|
| journal + 未变前缀免费重放 | pi-dw | §4.2(改成内容寻址) |
| 失败三分类:可恢复→重试→null / 不可恢复→run 败 / 配额→暂停 | pi-dw `errors.ts` | §4.5(简化) |
| "gate 放在缓存查找之后,免费回放不能被预算卡死"的顺序纪律 | pi-dw audit #1 | §4.2 |
| 确定性门:命令能判定的不问模型,退出码是值 | ZCode `world.run` | §3 `gate` 步骤 |
| 提案时用户确认的是**整个计划(含命令集)** | ZCode 确认对话框 | §4.1 |
| 剧本 args 声明 + 运行时校验填充 | ZCode saved workflow args | §5 |
| 空产出舰队警告(全 null 不能伪装成功) | pi-dw | §4.5 |
| 活动可观测三件套:广播行 + 快照水合 + 落盘回放 | Kova 自己(subagent) | §4.7 |

## 2. 架构总览

```
composer 模式档「工作流」(types.ts SessionMode 加 "workflow")
   │
   ▼  主模型 = 编排器(只在两个环节在环)
[勘察: 现有只读工具] ──► workflow_propose_plan(结构化剧本 + 验收标准,协商轮)
   │                              │
   │                     用户在提案对话框确认(确认的是整个计划,含 gate 命令集)
   ▼                              ▼
   └──────────► 执行器 runner(sidecar 纯 TS,进程内)
                    │  依赖解析 · 就绪调度(并发 ≤ 8,复用委派上限)
                    │  每步 = 一次 Task 委派 / 一条 bash / 一组评审委派
                    │  journal 逐步落盘(§4.2)· 事件广播(§4.7)
                    ▼
              终局结算:workflow_complete / workflow_blocked(镜像 goal 出口)
                    │
                    ▼
        合成报告回投聊天(复用 delegationResumeText 同款机制)+ artifact 落盘
```

**上下文经济的关键决策:运行中主模型不在环。** 中间结果不进主会话转录(与 delegate 同一条边界,`subagent.ts` 头注释),全量结果由执行器持有在 run 记录里,编排器只在提案前勘察、终局时拿到有界摘要。pi-dw 用"结果活在脚本变量里"解决的同一个问题,这里用"结果活在 run 记录里"解决——不需要脚本语言。

**组件落点:**

| 组件 | 落点 | 对齐的现有先例 |
|---|---|---|
| 快照契约(zod,loose) | `packages/pi-protocol/src/workflow.ts`(新) | `queue.ts` 的快照 v2 风格 |
| 剧本/状态机纯逻辑层(零 I/O) | `src/workflow/plan-state.ts`(新) | `goal/goal-state.ts` 的分层理由原文 |
| 执行器 | `src/workflow/runner.ts`(新) | `subagent/run.ts` 的执行循环 |
| journal 读写 | `src/workflow/journal.ts`(新) | `subagent/activity-store.ts` 的落盘/回放 |
| 模式工具组 | `src/workflow/tools.ts`(新) | `subagent/tools.ts` 的工具组组装 |
| 模式注册 | `agent/modes.ts` 扩一档 | plan/goal 的现有接法 |
| 桌面面板/常驻条 | desktop 复用委派面板组件 | `subagent_activity` 面板 + goal 常驻条 |

## 3. 核心对象模型

```ts
/** pi-protocol/src/workflow.ts —— zod loose,同 queue.ts 风格 */
type StepKind = "delegate" | "gate" | "verify" | "synthesize";

interface WorkflowStep {
  /** 剧本内唯一、人写、稳定 —— journal 的键(§4.2) */
  key: string;
  kind: StepKind;
  /** 展示分组(中文),面板按此分节;同 plan 的 phases 语义 */
  phase: string;
  /** 卡片标题,用户语言(modes.ts §9 的"写给用户不写给机器"同款纪律) */
  title: string;
  /** delegate/synthesize:任务说明。模板插值 {item}/{upstream.key} */
  prompt?: string;
  /** 子智能体定义名(三层发现解析);缺省 ad-hoc(只读工具 + 会话模型) */
  agent?: string;
  /** 模型覆盖链最顶层(优先级对齐 tools.ts:39:Task 参数 > kv 覆盖 > 定义 > 会话) */
  model?: string;
  /** DAG 依赖:全部 done 才就绪 */
  dependsOn: string[];
  /** 扇出:按上游步骤的结果数组逐项展开,展开键 `${key}#${index}` */
  foreach?: { from: string };
  /** 失败传播,默认 "abort";skip = 该步记 failed、下游按 null 继续 */
  onFail?: "abort" | "skip";
  /** 可恢复失败的额外重试次数,默认 1 */
  retries?: number;
  /** kind=gate:确定性命令门。command 必须是提案时的字面量(用户确认的就是它),参数才可插值 */
  gate?: { command: string; args?: string[]; timeoutMs?: number };
  /** kind=verify:N 个评审委派投票,{real, reason} schema 固定 */
  verify?: { reviewers?: number; threshold?: number };  // 默认 2 / 0.5
  /** 组合:引用一个已存剧本,提案期展开为带前缀的子步骤(§5.1);与 prompt/agent/gate/verify 互斥 */
  use?: { playbook: string; args?: Record<string, unknown> };
}
```

四类步骤的职责与对应物:

- **delegate** —— 走现有 `Task` 委派循环(`subagent/run.ts`),定义、模型覆盖链、工具白名单、活动流、12k 报告上限全部白得。这是唯一会"思考"的步骤类型。
- **gate** —— 确定性检查:跑一条命令,退出码即判定,stderr 作为反馈值带进下游 prompt。对齐 ZCode `world.run` 的核心思想:**命令能决定的事不烧一次委派、也不信模型的转述**。命令走现有 `permissions/` + bash 基建,写根约束生效。
- **verify** —— N 个只读评审委派对抗式投票(pi-dw `verify()` 的移植,投票 schema 固定 `{real: boolean, reason?: string}`),real 占比 ≥ threshold 判真;不达阈值的上游产出按 `onFail` 处理。评审 agent 禁写工具。
- **synthesize** —— 收束步:选中若干上游结果喂给一个合成委派,产出最终报告/artifact(落盘对齐 `goal/goal-artifact.ts` 模式)。一个剧本恰好一个,是 exit 的前置。

Run 记录(落盘形态,§4.6):

```ts
interface WorkflowRunState {
  version: 1;
  runId: string;            // uuid,同 delegationId 生成惯例
  threadId: string;         // 单线程槽位,同 goal 的 per-thread Map
  title: string;            // 提案时定,面板/历史列表用
  status: "proposing" | "running" | "paused" | "blocked" | "complete" | "failed";
  plan: { steps: WorkflowStep[]; args?: Record<string, unknown> };
  /** journal:stepKey(展开含 #index)→ 条目;整字段替换,禁增量合并(queue-v2 语义) */
  journal: Record<string, JournalEntry>;
  tokensUsed: number;       // 纯展示,聚合 run.usagePending + 各步结算,同 goal 的口径
  createdAt / updatedAt / completedAt?: string;
}
interface JournalEntry {
  fingerprint: string;      // sha256(步骤声明 hash + 依赖结果 hash 链)——§4.2
  status: "done" | "failed" | "skipped" | "interrupted";
  result?: unknown;         // 有界:delegate 报告 ≤ 12k,verify 存投票, gate 存退出码+stderr 尾部
  usage?: { tokens: number };
  startedAt / endedAt?: string;
}
```

## 4. 关键机制

### 4.1 触发与协商轮:授权不强制,提案即过滤

- **显式模式切换**,不做关键词武装。pi-dw 3.0 的教训(关键词触发引发 #88 误触发、#89 空转)以另一形式吸收:模式提示词写明——用户切到工作流档后,问答/闲聊照常直接回答,**只有真实可分解的请求才触发提案轮**;提案轮本身就是过滤器,琐事会被提案成一个两步小剧本或劝退回 agent 档。
- 提案走 goal 同款协商轮:主模型勘察后调 `workflow_propose_plan`(独占 tool call 批次,`modeBeforeToolCall` 现成拦截),前端弹**结构化提案卡**:phase 分组的步骤列表、每步的 agent/模型/命令、验收说明。用户确认 = 授权整个计划(含 gate 命令集——这是把 ZCode "确认时用户看到的是命令白名单"的洞察移植过来)。
- 出口工具镜像 goal:`workflow_complete`(全部步骤 done + 合成报告结算)、`workflow_blocked`(死锁报告,镜像 `goal_blocked` 语义)。三个工具都必须独占批次。

### 4.2 Journal:内容寻址,不用位置索引

- 键 = `step.key`(foreach 展开项再拼 `#index`)。命中条件 = **指纹一致**:`fingerprint = sha256(步骤声明 + args + 依赖链上各上游的 fingerprint)`。上游重跑产出不同 → 下游 prompt 插值内容变 → 指纹自动 miss。插删步骤、调整 DAG 都不影响无关步骤的缓存——这是对 pi 位置前缀(插一个调用、后面全失效)的直接改进,工具声明式步骤才能做到。
- **顺序纪律照抄 pi 的 audit #1**:resume 先做缓存匹配,后做任何配额/上限 gate——免费的回放不能被挡在门外,否则一个跑满的 run 永远恢复不动。
- 重放即 resume:恢复执行时,全部 `done` 且指纹匹配的步骤直接取 journal(0 token),其余按 DAG 就绪序重跑。同一剧本换 args 重跑 = 天然的"部分复用"。
- 落盘:每次步骤结算即原子写整份快照(全量、最后胜出,queue-v2 的语义),不做 append-only 日志——Kova 的 run 体量(≤ 百步)撑得住整文件写,换来实现简单和与 queue 快照同一套心智。

### 4.3 数据流与上下文经济

- 步骤间数据流只有一条路:**下游 prompt 模板插值上游 `result`**(`{upstream.key}` 取对象字段、`{item}` 取 foreach 项)。执行器做插值时对单值施加长度上限(对齐报告 12k 的量级),超限截断并在插值处留标记——把 pi-dw README 里"parseOrFlag 防御"整段问题从根上消掉:结构由 verify/synthesize 的固定 schema 保证,不靠模型自觉。
- 全量结果只活在 run 记录;进主会话的只有:提案卡、终局合成报告、常驻条计数。中段用户想看细节 → 面板点步骤看委派活动流(已有基建)。
- 主模型运行中不在环,所以**不需要** pi-dw 那套 fan-out 批取消 / run-fatal 广播 / drain grace 的取消层次——执行器是同步调度循环,取消就是停调度 + 中止在跑委派(复用 TaskStop 通道)。

### 4.4 状态机与安全阀:承袭 goal 三阀,不做 token 预算

Run 状态机镜像 goal 四态:`proposing → running ⇄ paused / blocked → complete / failed`。所有终局迁移带 `expectedRunId` 护栏(照抄 `goal-state.ts` 的过期护栏论证:排队中的 tool_call 可能在用户换 run 后才落地)。

安全阀只有三条,与 goal 完全同构:**步骤总数上限**(kv 可配,默认展开后 100 步)、**无进展检测**(连续 N 步 failed/skip 即转 blocked)、**用户随时暂停/接管**。tokensUsed 是常驻条上的纯展示计数。goal-state.ts 头部那段"为什么没有 token 预算"的三条否决论证(用户无法预判、按累计量不看进度、收尾轮自证)对工作流同样成立,直接引用,不再另写。

### 4.5 失败分类与重试(简化 pi 分类)

| 类别 | 例 | 处置 |
|---|---|---|
| 可恢复 | 委派超时、空报告(`AGENT_EMPTY_OUTPUT` 同款)、provider 抖动 | 指数退避重试 `retries` 次(默认 1),耗尽按 `onFail`:abort → run failed;skip → 该步记 failed,下游按 null 继续 |
| 不可恢复 | `model` 解析不到、剧本校验错(缺 key/环依赖/未知 agent 名) | 步骤 failed;abort 传播。校验错在**提案时**就拦(提案卡即校验面),运行期只剩极少数 |
| provider 配额 | 订阅/限额打满 | run 转 `paused` + 通知,不 failed(pi-dw 的 `PROVIDER_USAGE_LIMIT` 单列精神;自动恢复列 M3) |
| 全军覆没 | 全部 delegate 步 skipped/failed 却"完成" | 终局结算强制附带警示行,合成报告开头明说(pi-dw 空产出舰队警告的移植) |

### 4.6 暂停 / 恢复 / 崩溃恢复

- 暂停:面板按钮 / `workflow_stop` 类控制(模型侧不提供停止工具,用户专属,同 TaskStop 定位)。在跑委派走现有中止通道,记 `interrupted`。
- 恢复:按 §4.2 重放。同一 threadId 一次只有一个活跃 run(单槽,同 goal)。
- 崩溃恢复:sidecar 启动时扫 `.kova/workflows/`,status=running 的 run → 在跑步骤记 `interrupted`、run 记 `paused`,等用户从面板恢复。这是 `restoreDelegation`(delegation.ts:93)同款思路升到 run 级;活动文件那种"无终态即中断"的判定直接复用。

### 4.7 可观测性:复用委派三件套模式

- 广播:`{type: "workflow_activity", runId, item}` 无 id 通知行——与 `subagent_activity` 同款(父 turn 已结束后台运行照发,delegation.ts 头注释已验证这条通路的正确性)。item 里区分 run 级事件(phase 进入/步骤状态迁移)与透传的委派活动。
- 水合:`get_workflow_state` 全量快照(同 `get_goal_state` / `get_subagent_activity`),前端重启/切线程后 hydrate。
- 常驻条:`sendEventChunk` 推 `data-workflow-state` 全量快照(同 goal 的 data-goal-state),显示 phase 进度 + 步骤计数 + tokensUsed。
- 面板:phase 分节步骤卡;每个 delegate 步骤**就是**一个 delegation,点开即现有委派活动视图,一行新代码不用写。

### 4.8 防递归与权限边界

- 剧本运行期间派生的 delegate,工具表沿用现有 delegate 组装(本就没有 Task 组);workflow 提案/出口工具同样永不进 delegate 工具表。**运行时**嵌套剧本(执行期一个 run 动态拉起另一个 run)明确不做——pi-dw 限一层且为它付出了 journal 键命名空间、子树缓存切断、runId 防撞三重复杂度(workflow.ts:66/133/1427),ZCode 干脆零嵌套;Kova 的组合需求由提案期展开满足(§5.1),运行期只有一份扁平 DAG,journal/面板/恢复全部不变。
- gate 步的命令经现有 permissions/write-roots;工作区剧本(`.kova/workflows/*.yml`)的信任语义对齐 `.kova/subagents/`(未信任不挂载)。

## 5. 模板化:剧本库进数据库,组合靠提案期展开

复用有三层,逐层便宜过运行时嵌套:**模板复用**(存为剧本 → 随时按名运行)、**步骤缓存复用**(同剧本改参重跑,指纹一致的已结算步骤 0 token 回放,§4.2)、**剧本组合**(本节)。

### 5.1 剧本组合:提案期展开(macro),不是运行时嵌套

- 步骤声明 `use: { playbook, args }`,在**提案/校验阶段**把被引剧本的步骤平铺进当前 plan:子步骤键加命名空间前缀(`父步骤key.子key`)、phase 继承引用处的 phase(或被引剧本自带的)、args 插值进子步骤 prompt。运行期看到的就是一份扁平 DAG——journal、面板、恢复、并发上限全部不感知"组合"的存在。
- 护栏:引用解析在提案时完成,环引用(A 用 B、B 用 A)直接校验失败;展开深度 ≤ 2(剧本引用剧本引用剧本,再有需求就该拆成两个 run);被引剧本的 args 走同一套声明校验(§5.3);用户在提案卡上看到的是**展开后**的完整步骤列表,确认的仍然是整个计划。
- 面板呈现:引用步骤渲染为可折叠分组节点(标题 = `use` 步骤的 title,内层是展开的子步骤),不改步骤卡组件,只加一个分组壳。
- 这是相对 pi-dw 的差异化:pi-dw 的 `workflow(name)` 运行时嵌套一层,代价是 journal 键命名空间、子树缓存切断、runId 防撞(workflow.ts:66/133/1427 三处复杂度的直接来源);展开式组合拿到同一复用能力,零运行时成本。

### 5.2 存储:剧本库在 hostdb(SQLite),文件降级为导入/导出格式

- **剧本库 = hostdb,用户可编辑库的事实源**。走现有 hostdb 访问路径(kvGet/kvSet 同款链路,`storage/hostdb.ts`),记录含:`id、name、description、plan(JSON)、args 声明、source("saved" 存为 / "imported" 导入 / "builtin" 内置只读)、enabled、created_at / updated_at`。选库而非文件的理由:剧本的主写路径是 UI(存为剧本 / 设置页编辑),不是 git 协作;打法应**跨项目**可用;UI 的列表/搜索/CRUD 直接落库。这是 Kova 既有分层的产品数据一侧——queue_state、个性化都已在库,项目可分享的配置才进文件。
- **发现优先级**(同名遮蔽,方向对齐子智能体:越贴近项目越具体):工作区 `.kova/workflows/*.yml`(项目、git 版本化、只读挂载)> **剧本库 DB**(全局、可编辑)> 内置(常量)。启用开关与参数槽绑定存 kv,不写进任何剧本本体。
- **YAML 的两个角色**:① 导入/导出格式——分享剧本 = 导出 `.yml` 文件,对方导入进自己的库;② 工作区只读挂载——repo 里带 `.kova/workflows/*.yml` 即团队共享打法,签名缓存 + 热生效同 `subagent-definitions.ts` 的目录签名机制。库里的剧本随时可导出 YAML,两个世界互通。
- **运行记录不进库**:`.kova/workflows/<runId>.json` 文件仍是事实源(与 delegation 活动落盘同族);UI 历史列表若嫌扫文件慢,加一张 DB 投影索引行(runId/title/status/threadId/时间/tokensUsed),对齐会话层"文件 = 事实源、SQLite = 投影索引"的总原则。

### 5.3 args 声明与"存为剧本"闭环

- args 声明:`{name, type, required, default}`,运行前校验填充(ZCode saved workflow 的 args 校验移植;schema 用 queue.ts 的 loose zod 风格落 `pi-protocol`)。`args` 进 fingerprint——同一模板不同参数是不同指纹,互不串缓存。
- 闭环:任意一次成功运行可一键"存为剧本"(执行器实际跑的 plan + 参数槽固化入库)——这就是"AI 团队模板"的完整形态:成员(子智能体定义)+ 打法(剧本库)。
- 面板/设置页的剧本条目复用子智能体条目组件(启用开关、来源徽标、YAML 视图都是现成的;编辑器把 YAML 视图换成结构化表单即可,YAML 仍保留为高级视图)。

## 6. 协议与 UI 增量清单

| 层 | 增量 |
|---|---|
| `pi-protocol` | `src/workflow.ts`:run 快照 schema、activity item、提案卡 payload、`GOAL_CONTINUE_PREFIX` 同款的恢复前缀常量 |
| sidecar | `src/workflow/{plan-state, runner, journal, tools, library}.ts`(library = 剧本库,hostdb 读写 + 工作区 YAML 挂载);`types.ts` SessionMode 加 `"workflow"`;`modes.ts` 挂新档(`toolsForMode` / 模式提示词段 / 独占批集合);`protocol/` 挂 `get_workflow_state` 快照应答与 activity 转发 |
| desktop | composer 模式档 + 提案确认卡 + 运行面板(phase 步骤卡,复用委派活动视图)+ 常驻条 + 历史列表(对齐 `/workflows` 导航器的信息密度即可,不需要 TUI) |

## 7. 分期落地

- **M1 最小闭环**:模式 + 提案/确认 + `delegate`/`synthesize` 两类步骤(单发,无 foreach)+ journal 快照落盘 + activity 广播 + 面板 + 终局回投。验证:journal 重放、报告回投、面板水合三条既有通路各接一次。
- **M2 完整步骤集**:`foreach` 扇出、`gate`(含提案时命令确认)、`verify`、重试退避、暂停/恢复、崩溃恢复(启动扫描)。
- **M3 剧本库与迭代**:hostdb 剧本库 + 工作区 YAML 挂载 + args 校验 + "存为剧本" + 提案期组合展开(§5.1);剧本内有界 `repeat-until`(每轮产出喂 key 去重,连续空轮即停——pi `loopUntilDry` 的声明式化);provider 配额自动恢复(解析 reset 提示,到点自动 resume,带尝试上限)。
