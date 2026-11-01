# 工作流引擎：编排能力差距

状态：分析稿（未实现）。
范围：Kova 现有 automation / subagent / goal 能力，对照脚本化多代理工作流引擎（以 x 暴露的工作流工具契约为参照）。

## 结论

Kova 的差距不在“能不能让 agent 干活”，而在**能不能把多步、可重复、可恢复的流程从模型手里拿走**。

- 现有 **automation** 是“触发器 + 单条 prompt”，每次触发跑一个完整 agent 会话，不是工作流引擎。
- 现有 **Task / TaskWait / SendMessage** 是模型驱动的 fan-out / fan-in，灵活，但不确定、不可重放、失败只能按子代理恢复。
- 真正的缺口有五个：**确定性控制流、类型化步骤契约、工作流级持久化/恢复/缓存、步骤级失败语义、工作流视图与复用**。
- Kova 并不全面落后：调度（cron/interval/once/补跑）、权限审批、沙箱、无人值守策略是它的强项。差距集中在“编排层”，不在“执行层”。

## Kova 现有能力盘点

### 1. Automation：触发层，不是编排层

代码：`apps/sidecar/pi-agent/src/automation/`

- 任务类型：`once` / `interval` / `cron`；
- 每个任务一条 `prompt`，触发时新建独立会话（`automation:<taskId>:<historyEntryId>`）跑完整 agent 轮次；
- 可按任务指定模型、workspace、超时、无人值守工具档位（`read-only` / `workspace-write` / `full`）；
- 有单实例锁、启动补跑、once 任务保留期清理、全局并发队列、runHistory（每任务 ≤25 条）；
- 运行结果只有 success/error 与一段会话，可跳到会话回溯。

**本质**：一个可靠的定时器 + 一次 agent 调用。没有步骤、依赖、分支、循环、步骤级产物或恢复点。

### 2. Subagent：执行原语，编排权在模型

代码：`apps/sidecar/pi-agent/src/subagent/`

- `Task` 启动后台 delegate；同一 assistant 消息里的多个 Task 并行；
- `TaskWait` 支持 all / any / minCompleted / timeout；`TaskList`、`TaskStop`；
- `SendMessage`：running 时 steer，结束后带历史 resume；
- 活动流/历史/终态/报告持久化在 `<sessionsDir>/subagents/`；
- 有并发上限 `MAX_SUBAGENT_CONCURRENCY`；
- delegate 不能再嵌套 Task（自己的工具表不含子代理组），也不能管理定义。

**本质**：一套很强的“并行子任务运行时”，但**何时扇出、等几个、失败怎么办、下一步做什么**全部由父模型在对话里决定。没有可执行的流程定义，也没有工作流级运行记录。

### 3. Goal：单代理自治循环，不是多步编排

代码：`apps/sidecar/pi-agent/src/goal/`

- 目标 + 验收标准 + 轮次/时长/token 预算 + 证据校验 + 自动续跑；
- 解决的是“一个目标不要中途停”，不是“多个步骤按依赖执行”。

### 4. 可观测与安全：已有较好的地基

- trace / loop 视图、子代理活动面板、工具行、产物卡；
- 审批链、plan 模式、逐工具授权、命令/MCP allow-list；
- 沙箱（macOS Seatbelt + 跨平台文件/网络工具校验）；
- 每次自动化运行有独立会话，可回溯。

这些是工作流引擎可以直接复用的部分，不需要重造。

## 对照：工作流引擎需要什么

从 Ekova 暴露的工作流工具契约看，一个完整引擎至少包含：

| 能力 | 具体形态 |
|---|---|
| 确定性控制流 | 脚本/DSL 里的循环、条件、并行扇出、依赖顺序 |
| 类型化中间结果 | 每个子代理返回结构化结果，可校验、可引用 |
| 持久化运行记录 | run journal：每步状态、输入输出、token、错误 |
| 恢复/缓存/重跑 | 从最后完成步骤续跑；已完成步骤不重复付费；可 amend 重跑 |
| 动态扩展 | 运行中补步骤（holes）、向子代理追问、人工裁决 |
| 失败语义 | 每步重试/超时/降级/补偿；失败定位到步骤 |
| 并发与预算 | 全局/工作流级并发上限、token/费用预算 |
| 人审闸门 | 步骤边界审批、问题升级、批准后继续 |
| 可观测 | run 列表、日志尾、每步耗时/token、产物 |
| 复用 | 保存工作流、参数化、版本化、按名字调用 |
| 产物 | 主交付物、文件、报告，和步骤输出分离 |

## 差距矩阵

| 维度 | x 工作流引擎 | Kova 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| 确定性控制流 | TS 脚本：循环/条件/fan-out | 模型在对话里决定 Task 调用 | **大** | P0 |
| 类型化步骤契约 | 子代理结果有类型，可校验 | 报告是自由文本，父模型自己解析 | **大** | P0 |
| 工作流级持久化 | journal + 步骤状态 + 缓存 | 只有子代理级活动/历史；工作流状态在父上下文里 | **大** | P0 |
| 恢复/重放 | 中断后从已完成步骤续跑 | 只能 resume 单个子代理；工作流整体重来 | **大** | P0 |
| 步骤级失败语义 | 脚本控制 + 重试/降级 | TaskWait 超时、TaskStop；无 per-step retry/onError | 中 | P1 |
| 并发/预算 | 工作流级 max_concurrency/token | 子代理并发上限；无工作流级预算 | 中 | P1 |
| 人审闸门 | 工作流问题/孔位 + 工具审批 | 工具级审批很强；自动化无人值守直接拒绝，没有步骤边界审批 | 中（形态不同） | P1 |
| 可观测 | run 列表、日志、token、产物 | trace/活动/面板齐全；缺 DAG/步骤视图 | 中 | P1 |
| 复用/参数化 | 保存工作流 + args + 版本 | automation 任务、skills（提示词级）；无参数化流程定义 | **大** | P1 |
| 动态 amend/补步 | 运行中修订、补洞 | SendMessage/resume 可追问；不能改流程 | **大** | P2 |
| 调度 | 引擎外（Cron/Off-peak） | cron/interval/once + 补跑 + 并发队列 | Kova 领先 | — |
| 隔离/权限 | 工作流世界命令闸门 | 工具审批 + 沙箱 + 无人值守档位 | Kova 持平或领先 | — |
| 模型选择 | 工作流级/子代理级 | 任务级/子代理级 | 持平 | — |

## 什么时候这个差距是真的

- **重复流程**：周报/发布检查/批量迁移/内容流水线/多源调研，每次步骤相同、只是输入不同；
- **要可审计**：出了错要定位到“哪一步、哪个输入、哪个工具”；
- **要可恢复**：第 4 步失败，不想重跑前 3 步、重复付 token；
- **要给非技术用户重复运行**：用户不应该每次重新对模型说一遍流程；
- **要回归/对比**：同一流程换模型、换参数，结果可比较。

## 什么时候不需要

- 一次性探索、开放式任务：模型驱动的 Task 扇出更灵活，写死流程反而限制它；
- 只需要“每天跑一段 prompt”：现有 automation 已经够用；
- 流程步骤每次都不一样：先别抽象，等模式稳定。

**因此不建议直接做一个通用工作流引擎**。先确认产品里是否存在稳定的多步流程；如果没有，投入产出比很低。

## 目标形态：两个方案

### 方案 A：声明式工作流（推荐）

面向桌面产品和非技术用户：YAML/JSON 定义，sidecar 执行。

```yaml
id: weekly-release-check
inputs:
  repo: { type: string, required: true }
steps:
  - id: collect
    agent: explorer
    task: |
      盘点 {{inputs.repo}} 本周改动，输出 changedFiles / riskyFiles / summary。
    output:
      schema:
        type: object
        required: [changedFiles, summary]
        properties:
          changedFiles: { type: array, items: { type: string } }
          summary: { type: string }
  - id: review
    agent: code-reviewer
    dependsOn: [collect]
    when: "{{steps.collect.output.changedFiles.length > 0}}"
    task: |
      审查这些文件：{{steps.collect.output.changedFiles}}。
    retry: { maxAttempts: 2 }
  - id: gate
    approval: release-check
    dependsOn: [review]
  - id: publish
    run: "bun run release:check"
    dependsOn: [gate]
    onError: fail
```

关键语义：

- 步骤类型：`agent`（子代理）、`run`（受沙箱/审批约束的命令）、`approval`（人审闸门）、`artifact`（交付物）；
- 控制流：`dependsOn`、`when`、`fanOut`（对一个数组展开）、`retry`、`timeout`、`onError`（fail/continue/fallback）；
- 数据流：每步输出按 JSON Schema 校验；自由文本报告必须转成结构化输出或落产物文件；
- 持久化：`workflow_runs/<runId>.jsonl`，记录每步 started/completed/failed、输入输出摘要、token、产物；
- 恢复：从最后完成的步骤继续；已完成步骤的输出作为缓存；
- 人审：`approval` 步骤复用现有审批卡片与通知；
- 触发：automation 任务从“一条 prompt”升级为“workflowId + inputs”。

**优点**：可校验、可测试、非技术用户能填参数、UI 容易可视化；与现有 automation/权限/沙箱/子代理运行时贴合。
**代价**：表达能力有限；复杂动态流程要退化成脚本或多次运行。

### 方案 B：脚本化工作流（x 形态）

面向开发者：沙箱里跑 TypeScript/JS，脚本调用 `agent()` / `report()` / `run()`，有类型化结果、循环、条件、fan-out。

**优点**：表达力最强，适合“对任意数据集扇出”“运行时决定步骤”。
**代价**：需要脚本沙箱、API 设计、调试/日志、版本与信任边界；对普通用户不友好；与现有权限/审批链的接缝更多。

**建议**：先做方案 A。只有当用户明确需要“对任意数据动态编排”时，再加脚本逃生口（例如 `run: workflow.ts` 作为一种步骤类型），而不是一上来做通用脚本引擎。

## 分阶段路线（方案 A）

### 阶段 1：契约与运行记录

- 定义 `WorkflowDefinition` / `WorkflowRun` / `WorkflowStepRun` 类型；
- 步骤输出 JSON Schema 校验；失败时把校验错误回给该步子代理重试一次；
- 落 `workflow_runs/<runId>.jsonl`：run_started、step_started、step_completed、step_failed、run_completed；
- 先只支持线性 `dependsOn`，不做分支/循环。

### 阶段 2：步骤执行器与失败语义

- 复用 `SubagentRun`/`launchSubagentRun` 作为 `agent` 步骤执行器；
- `run` 步骤走现有沙箱 + 审批链；
- `retry` / `timeout` / `onError` / `when`；
- 步骤失败定位到 stepId，父代理/用户能看到原因。

### 阶段 3：恢复、缓存与预算

- 从最后完成步骤恢复；已完成步骤输出缓存（按 stepId + 输入哈希）；
- 工作流级并发上限与 token 预算；
- 运行取消/暂停；
- 与 automation 的 timeout/并发队列打通。

### 阶段 4：UI 与触发

- 面板新增 workflow run 视图：步骤树、状态、耗时、token、产物、审批；
- automation 编辑器支持选择 workflow + 填 inputs；
- 运行历史沿用现有 automation 时间线。

### 阶段 5：复用与版本

- 保存/复制/参数化 workflow；
- 版本化定义，运行记录绑定版本；
- 导入/导出（技能包/插件包）。

## 复用映射

| 现有模块 | 工作流中的角色 |
|---|---|
| `automation/runner.ts` `runAutomationTask` | 改成 `runWorkflow`：一次触发 = 一个 workflow run |
| `automation/index.ts` `ScheduledTask` | 触发器保留；增加 `workflowId` + `inputs` |
| `subagent/tools.ts` `Task/TaskWait` | `agent` 步骤执行器；不要把 Task 工具直接暴露给流程定义 |
| `subagent/delegation.ts` `DelegationRecord` | step run 记录；增加 `workflowRunId` / `stepId` |
| `subagent/activity-store.ts` | 每步子代理活动；工作流层另建 run journal |
| `subagent/history.ts` / `run.ts` | 步骤输出的上下文与 resume |
| `agent/context.ts` `repairDanglingToolCalls` | 崩溃恢复的步骤级复用 |
| `permissions/*` + `apps/electron/main/sandbox/*` | 每步工具策略与沙箱 |
| `protocol/trace.ts` + loop 面板 | 步骤可观测、token/耗时 |
| `pi-protocol` | 新增 `workflow_run_*` / `workflow_step_*` 事件 |
| `components/automations/*` | 触发编辑 + 运行历史入口 |
| `components/agent-thread/agent-panel/*` | workflow run 面板 |

## 不做什么

- **不先做可视化节点编辑器**：瓶颈在运行语义，不在画布；先用 YAML/JSON，UI 只做运行视图和参数表单。
- **不做任意嵌套工作流**：V1 只支持一层步骤；需要嵌套时用子代理或独立 run。
- **不把流程状态只放在父代理上下文里**：必须落 workflow run journal，否则无法恢复/审计。
- **不让模型“记得”流程**：流程定义是文件，不是提示词；模型只负责步骤内的判断。
- **不用自由文本当步骤契约**：没有 schema 的输出等于没有输出。

## 验收指标

- 同一 workflow + inputs 重复运行，步骤顺序与依赖一致；
- 中断后从最后完成步骤恢复，已完成步骤不重复计费；
- 每步输出通过 schema 校验；失败能定位到 stepId；
- 工作流级并发/token 预算可配置、可观测；
- 非技术用户能在 UI 里选 workflow、填参数、看步骤状态与产物；
- 运行记录可导出，能回答“这一步为什么失败/花了多少 token/产出了什么”。

## 一句话判断

**Kova 已经有“执行层”（子代理、权限、沙箱、调度），缺的是“编排层”（流程定义、步骤契约、运行记录、恢复与复用）。** 如果产品里存在稳定的多步流程，先做声明式方案 A；如果不存在，继续用 Task/TaskWait + automation，不要把一次性探索硬做成工作流。
