# Goal 模式 v2：设计、测试与审查记录

状态：实现完成（自动化门禁通过；手工 E2E 已执行，截图与日志留在本地，未纳入提交）

## 1. 范围

目标：把 goal 从「多一层确认流程」改成「有边界的交互式长任务执行器」。

本次改动：
- sidecar 运行时与 `pi-protocol`
- 桌面端 goal 常驻条与 goal 客户端
- 不改移动端 UI（协议字段可选，旧端忽略）
- 不开放无人值守自动化（保持现有禁令）

## 2. 设计摘要

### 2.1 验收标准三模式

`Goal.acceptanceMode: "auto" | "manual" | "skip"`：

- `auto`：`goal_propose_criteria` 成功后直接确认（`confirmedBy="auto"`），同一轮继续执行。
- `manual`：保持原有「提议后停下等用户确认」。
- `skip`：建目标即跳过标准，直接执行。

用户可在常驻条上查看/编辑已确认标准；`goal_edit_criteria` 以 `confirmedBy="user"`
替换清单，并把老目标的 `evidencePolicy` 升级为 `refs`。

### 2.2 时间预算

`Goal.maxDurationSeconds`（默认 2 小时，`null` 不限）与 `timeUsedSeconds` /
`activeRunStartedAtMs`。只计活跃窗口：暂停时结算，恢复时重开窗口。
`decideContinuation` 在轮边界检查，超时转 `paused`，原因 `time budget reached`。

### 2.3 进度台账

`Goal.progress` 最多 12 条，每轮记录工具/文件/命令/失败数与 assistant 文本摘要。
只进 UI、产物与续跑 user 消息，**不进 system prompt**（保护前缀缓存）。

### 2.4 结构化证据

`goal_complete.results[].refs` 支持：

- `command`：必须匹配本次目标内成功 bash 调用（exitCode 0/缺省）
- `file`：存在 / 修改（修改需有本次目标成功 write/edit，内容哈希一致）
- `tool`：同名成功调用，可选路径
- `manual`：允许，但标记「需人工确认」；整个目标至少一条机器可核验证据

台账来源：`afterToolCall` 记录主代理与子代理的工具结果；重启从 JSONL 回放。
老目标 `evidencePolicy="legacy"` 不要求 refs，保持升级前行为。

### 2.5 权限

不静默提权：goal 沿用当前审批档；`ask` 档下常驻条提示「每条命令都会确认」，
用户可点「放手跑」选择 `auto-edit` 或 `auto`。确认标准卡片仍可在确认时选权限档。

## 3. 自动化测试基线

固化脚本：

- `bun run test:goal`（sidecar goal 测试）
- `bun run test:desktop`（桌面 `bun test lib`）
- `bun run test:protocol`（pi-protocol 契约测试）
- `bun run verify:goal`（以上 + typecheck）

本次实现后的结果：

| 命令 | 结果 |
| --- | --- |
| `bun run test:goal` | 182 pass / 0 fail |
| `bun run test:desktop` | 851 pass / 0 fail |
| `bun run test:protocol` | 27 pass / 0 fail |
| `bun run --filter pi-agent-sidecar test`（全量） | 1739 pass / 0 fail |
| `bun run typecheck` | desktop + main 均通过 |

新增/扩展的测试文件：

- `apps/sidecar/pi-agent/test/goal/goal-evidence.test.ts`（新增）
- `apps/sidecar/pi-agent/test/goal/goal-state.test.ts`（v2 状态/时间/进度/迁移）
- `apps/sidecar/pi-agent/test/goal/goal-continuation.test.ts`（时间预算/进度）
- `apps/sidecar/pi-agent/test/goal/goal-criteria.test.ts`（auto/skip/编辑）
- `apps/sidecar/pi-agent/test/goal/goal-lifecycle.test.ts`（turn_end 接线）
- `apps/desktop/lib/pi/pi-goal-limit-draft.test.ts`（模式/时长草稿）
- `packages/pi-protocol/test/contract.test.ts`（goalState v2 字段）

## 4. 手工 E2E 剧本（已执行）

8 个场景均已执行；截图、日志与测试数据保留在本地 `docs/e2e/goal-mode-v2/`，
按约定不纳入提交。执行中发现并修复了「完成/受阻后未终止本轮」和
「goal handler 回包用错 threadId」两个问题。

前置：`bun run build && bun run start`；在 `/tmp/kova-goal-e2e` 建临时 git 仓库。

1. **默认 auto 快路径**：goal 档发「把 README 补全」。期望：标准自动确认并同轮开始执行，常驻条显示「标准 N 条」。
2. **权限提示/放手跑**：保持 `ask` 档。期望：条上出现「每条命令都会确认」；点「放手跑（编辑免确认）」后 write 不再弹卡。
3. **进度可见**：跑 2-3 轮。期望：进度 popover 能看到每轮工具/文件/命令摘要。
4. **证据拒绝/通过**：自由文本完成 → 拒绝；引用不存在的命令 → 拒绝并列出实际命令；真实命令 + 文件 refs → 通过，核验 popover 显示「已核验」。
5. **时间预算**：设 1 分钟，等超时。期望：paused，原因「time budget reached」；调高并继续可恢复。
6. **重启恢复**：运行中退出再启动。期望：paused；进度和证据台账恢复；继续可跑。
7. **老目标兼容**：加载改动前会话。期望：legacy 行为，自由文本完成仍可用。
8. **自动化禁令**：跑定时任务。期望：goal 工具仍被禁止。

每个场景记录：截图 + `kova-worker.log` 片段 + 通过/失败。

## 5. 审查记录模板

每个阶段在下面追加一条：

```text
Phase N review
- Changed files:
- Behavior change:
- Risk points:
- Test evidence:
- Rollback:
- Open questions:
```

高风险文件（必须人工/独立复审）：

- `apps/sidecar/pi-agent/src/goal/goal-state.ts`
- `apps/sidecar/pi-agent/src/goal/goal-evidence.ts`
- `apps/sidecar/pi-agent/src/agent/modes.ts`
- `apps/sidecar/pi-agent/src/sessions/resolve.ts`
- `packages/pi-protocol/src/payloads.ts`
- `apps/desktop/components/agent-thread/goal-strip.tsx`

## 6. 回滚开关

- 自动确认：目标/session 偏好设为 `manual`。
- 时间预算：`maxDurationSeconds=null`。
- 结构化证据：目标 `evidencePolicy="legacy"`。
- 整体：按阶段 commit revert（当前分支 `feat/goal-mode-v2`）。
