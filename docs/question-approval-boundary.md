# Question 与审批边界加固：Plan / Review / Test

状态：已实施并通过验证（2026-10-21）
范围：sidecar 的 Question 工具、逐工具审批链、AI 审查档的 medium 拒绝路径
非目标：MCP 审查路径的 medium 拒绝转卡、UI 改版、协议字段变更、数据库/配置迁移

> 本文档是实施后的闭环记录：Plan 段保留当时的设计决定与改动清单，Review 段是
> 代码自审，Test 段是实际执行结果。未完成的端到端取证在 §5 明确标出。

## 0. 结论

破坏性动作的授权只走审批卡；Question 只负责模型拿不到的信息。此前这条边界只有
提示词约束，运行时没有兜底，于是出现了「模型用 Question 列清单要用户确认删除」。
本次把边界落到代码：执行档拦截权限类提问，AI 审查拒绝文案不再引导提问，review 档
的 medium bash 拒绝改为转人工审批卡。

## 1. 问题与根因

截图现象：模型输出「删除操作需要你显式确认授权（审批系统要求逐项点名）。我列好
清单，请你确认：」，随后出现 `已询问 1 个问题`，用户作答后模型执行删除。

排查结论：

1. **Question 与审批是两条独立链路。** `Question` 的 `execute` 只负责挂起并推
   `data-question`，审批链不参与；`approvalLevel` 也不会让 Question 变成审批卡。
2. **提示词约束没有运行时兜底。** 系统提示词（`tools/tools.ts`）和 Question 工具
   描述都写了「不要用 Question 申请权限」，但模型不遵守时没有代码纠正。
3. **AI 审查档的拒绝文案把模型推回 Question。** 旧文案是
   `ask the user to confirm the exact action and scope`；模型把它转述成
   「审批系统要求逐项点名」。但 Question 的答案不是用户消息，审查器
   （`recentReviewContext` 只取 user/assistant 文本）不会把它当成授权，形成
   「问了也白问」的死路。
4. **完全访问（auto）档没有审批卡。** `gateToolCall` 在 auto 档直接放行；模型若
   想确认删除，唯一可用的交互就是 Question。这是模型自找的替代品，不是审批系统
   的行为。

## 2. Plan

### 2.1 设计决定

| 决定 | 理由 |
| --- | --- |
| 保留 Question，不移除、不整体加审批 | 澄清是核心能力；给 Question 加审批只会多一张卡，不解决「答案不授权」 |
| 在执行档做运行时拦截，而不是只改提示词 | 提示词已经写过但未生效；需要在工具执行前兜底 |
| 拦截只认高置信形状，不做通用语义分类 | 避免误伤真正的范围澄清（「先删哪几个？」），不引入第二次模型调用 |
| plan / ask 档不拦 | 两个档只读，提问本身就是计划/回答的一部分，不承担审批语义 |
| review 档 medium bash 拒绝转审批卡 | 只有审批卡能产生一次性授权；high 风险仍硬拦截 |
| 转卡不提供「记住」 | 删除类命令不做常驻授权，避免一次误点永久放行 |

### 2.2 改动清单

| 文件 | 改动 |
| --- | --- |
| `apps/sidecar/pi-agent/src/tools/question-tools.ts` | 新增 `isPermissionSeekingQuestion`；`buildQuestionTool(threadId, getMode?)` 在执行档拦截权限类提问，返回纠正文案而不挂起；工具描述补充「问答案不是授权」 |
| `apps/sidecar/pi-agent/src/tools/tools.ts` | `buildTools` 增加 `getMode` 闭包并传给 Question；系统提示词的 Permissions 段明确「只有审批卡是授权」 |
| `apps/sidecar/pi-agent/src/sessions/resolve.ts` | 5 个 `buildTools` 调用点接入 `() => run.mode` / `() => projectedMode` |
| `apps/sidecar/pi-agent/src/permissions/auto-review.ts` | medium 拒绝文案删除「去问用户」，明确禁止用 Question 申请权限 |
| `apps/sidecar/pi-agent/src/agent/modes.ts` | review 档记录未命中常驻规则的 bash；medium deny 时转人工审批卡并附说明；high deny 不变 |
| `apps/sidecar/pi-agent/test/tools/question-tools.test.ts` | 分类器正反例、执行档拦截、plan 档放行 |
| `apps/sidecar/pi-agent/test/agent/modes.test.ts` | review 档 medium bash → 审批卡、无「记住」、批准后放行 |
| `apps/sidecar/pi-agent/test/permissions/auto-review.test.ts` | medium 文案不再包含 `ask the user`，包含 Question 否定指引 |

### 2.3 行为矩阵

| 会话模式 / 审批档 | 模型想用 Question 确认删除 | 实际执行删除时 |
| --- | --- | --- |
| agent / 变更前确认（ask） | 拦截，要求直接调用工具 | 审批卡 |
| agent / 工作区内自动 | 拦截 | bash 仍走审批卡 |
| agent / 自动编辑 | 拦截 | bash 仍走审批卡 |
| agent / AI 审查（review） | 拦截 | 审查 allow → 执行；medium deny → 审批卡；high deny → 硬拦截 |
| agent / 完全访问（auto） | 拦截 | 直接执行（该档定义就是不再询问） |
| plan / ask | 不拦截（只读档的澄清） | 不可执行 |

## 3. 审查报告

### 3.1 守住的不变量

1. **Question 不是授权通道。** 拦截文案明确告知模型「答案不是授权」，下一步必须
   调用执行工具。
2. **审批卡仍是唯一授权面。** review 档转卡不写可写根、不写命令前缀；批准只对
   本次调用有效。
3. **high 风险不可人工覆盖。** 敏感数据外发仍由 `autoReviewDenyReason` 硬拦截，
   不进入转卡分支。
4. **plan/ask 只读语义不变。** `canExecute` 只在 agent/goal 或未注入模式时生效；
   plan/ask 的澄清提问照常挂起。
5. **自动化无人值守语义不变。** guard 排在 `getAutomationPolicy` 之后，定时任务
   仍拿到原有的「无人值守、按假设继续」文案。

### 3.2 边界与已知限制

- 分类器是**词形启发式**，不是语义模型：破坏性动词 + 确认/授权词，或破坏性动词 +
  确认/取消选项对。它覆盖截图这类高置信形状，不承诺识别所有改写。
- 模型可以在 assistant 正文里继续问「请你确认」，但不会再弹 Question 卡；真正的
  授权仍只发生在审批卡上。流式正文已输出，代码无法回收，这是可接受的残余体验。
- review 档的转卡范围是 **bash**。MCP 调用的 medium deny 仍是直接拒绝；本次没有
  扩大 MCP 的卡片面，避免把每个 MCP 拒绝都变成用户点击。
- 完全访问档不会出现审批卡；这是档位定义，不是本次遗漏。需要卡片时应切到
  「变更前确认 / 工作区内自动 / AI 审查」。
- 系统提示词 Permissions 段有字节变化，会导致一次缓存前缀失效；这属于预期成本。

### 3.3 兼容性检查

- 无协议字段变更；`data-question` / `data-toolApproval` 的线格式不变。
- 无数据库、无 `state.db`、无 `.kova/permissions*.json` 迁移。
- `buildTools` 新增的是可选尾参，所有旧调用保持兼容；测试中的两参调用不受影响。
- Question 的 UI 渲染不变：拦截结果没有 `Q1:` 条目且未标记 cancelled，
  `QuestionToolRow` 按既有逻辑返回 null，不会留下「已询问」假记录。
- 现有 `ask` / `workspace-write` / `auto-edit` / `auto` 的审批语义未改。

### 3.4 审查结论

通过。没有发现会放大权限的路径；唯一的行为扩面是 review 档的 medium bash 从
「直接拒绝」变成「用户可批准一次」，方向是收权给用户，不是放宽给模型。

## 4. 测试报告

### 4.1 执行记录

| 命令 | 结果 |
| --- | --- |
| `cd apps/sidecar/pi-agent && bun test test/tools/question-tools.test.ts test/permissions/auto-review.test.ts` | 32 pass / 0 fail |
| `cd apps/sidecar/pi-agent && bun test test/agent/modes.test.ts` | 102 pass / 0 fail |
| `cd apps/sidecar/pi-agent && bun test test/automation/policy.test.ts test/tools/tools.test.ts` | 20 pass / 0 fail |
| `cd apps/sidecar/pi-agent && bun run test` | **1745 pass / 0 fail**，106 files，13.99s |
| `cd apps/sidecar/pi-agent && bun run typecheck` | 通过（0 错误） |
| 根目录 `bun run typecheck` | desktop 0，kova-electron-main 0 |

### 4.2 新增用例

- `isPermissionSeekingQuestion`
  - 「确认删除以下临时文件？」→ 命中
  - 「Delete these files? / Yes / No」→ 命中
  - 「rm -rf dist 可以吗」→ 命中（`rm` 按词边界，不误命中 confirm）
  - 「清理 dist / 继续 / 停止」→ 命中
  - 「先删哪几个？/ diag.py / diag2.py」→ 不命中
  - 「选哪种存储？」→ 不命中
- `buildQuestionTool`
  - agent 档权限类提问：不挂起，返回 `rejected: true` 与纠正文案
  - plan 档同样的提问：照常进入挂起路径（随后按取消结算，验证未被 guard 拦截）
- `approvalBeforeToolCall：AI 审查档`
  - medium deny 的 bash：产生 1 条 pending 审批卡；`rememberRoot` /
    `rememberCommand` 均为空；卡上说明包含「AI 审查没有确认这条命令」；批准后
    调用放行
  - high deny：仍 `block: true`，不产生审批卡
- `autoReviewDenyReason`
  - medium 文案包含 `Question` 与 `not an authorization`，不再包含 `ask the user`

### 4.3 全量输出摘要

```text
$ cd apps/sidecar/pi-agent && bun run test
1745 pass
0 fail
5669 expect() calls
Ran 1745 tests across 106 files. [13.99s]
```

```text
$ bun run typecheck          # 根目录
desktop typecheck: Exited with code 0
kova-electron-main typecheck: Exited with code 0
```

### 4.4 未覆盖项

- 真实 provider 端到端：没有跑「模型实际生成权限类提问 → 被拦截 → 改调 bash →
  审批卡批准」的完整链路。需要 Desktop E2E 或手工会话取证。
- 移动端渲染：本次未改 UI 与协议，未做实机复验。
- MCP medium deny 的产品决策：保持直接拒绝，未纳入本次验收。

## 5. 闭环验收

- [x] 根因有代码证据（Question 执行路径、review 拒绝文案、auto 档放行）
- [x] Plan 的设计决定与非目标已记录
- [x] 改动清单与实际 diff 一致
- [x] 代码审查完成，列出不变量、边界、兼容性与残余风险
- [x] 单测覆盖新增行为，全量 sidecar 测试通过
- [x] sidecar 与根目录 typecheck 通过
- [ ] 真实模型 + Desktop 审批卡的端到端取证（建议下一步补）
- [ ] MCP medium deny 是否也转卡（产品决策，留待后续）

**当前状态：代码与自动化测试闭环完成；端到端实机取证未做，不宣称生产已验证。**
