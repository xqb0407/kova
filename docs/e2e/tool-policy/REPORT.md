# Shell 写入策略 E2E

## 自动化（已执行）

```bash
cd apps/sidecar/pi-agent
bun test test/permissions/shell-policy.test.ts test/e2e/shell-policy.e2e.test.ts
bun run typecheck
bun run test
```

结果：

- 分类器：20 pass；
- 真实宿主场景：6 pass；
- sidecar 全量：1922 pass（含并行落地的其他改动）；
- `tsc --noEmit`：通过；
- `bun run build`：通过（build smoke 带 `PI_SHELL_POLICY_SELFTEST=1`，
  确认编译产物能加载 shell 解析器 WASM）。

覆盖场景：

| # | 场景 | 结果 |
|---|---|---|
| 1 | Plan：`sed -n`/`pnpm test` 放行，`sed -i`/`echo >`/heredoc 拦截，文件不变 | PASS |
| 2 | Agent：`sed -i` 拦截，`sed -n`/`prettier --write` 不被 mode gate 拦 | PASS |
| 3 | Agent + `完全访问`：`sed -i` 仍拦截 | PASS |
| 4 | 拦截发生在审批前，不产生挂起项 | PASS |
| 5 | 子代理 gate 复用同一拦截 | PASS |
| 6 | 被拦 sed 后文件不变；`read → edit` 真实落盘 | PASS |

## 手工 UI 场景（待执行）

需要一个运行中的 Electron dev 实例、可用模型和临时 git 工作区。按
`docs/e2e/goal-mode-v2/REPORT.md` 的方式记录截图和工具结果。

| # | 操作 | 期望 |
|---|---|---|
| 1 | Plan 模式让 agent 改文件 | bash 被拦、无审批卡、文件不变、agent 转 `plan_write` |
| 2 | Agent + `完全访问`，要求用 `sed -i` | 拦截；agent 改用 `read` → `edit`；出现逐文件 diff/checkpoint |
| 3 | Agent + `每次确认`，安全 bash | 仍弹审批卡；`sed -i` 不弹卡，直接错误 |
| 4 | Agent + `自动编辑` | write/edit 免确认；`sed -i` 仍拦 |
| 5 | `工作区写入` | 工作区内 edit 自动；`sed -i` 拦 |
| 6 | `AI 审查` | 安全 bash 走审查；`sed -i` 不进入审查 |
| 7 | Goal 协商期 | `sed -i` 拦、`pnpm test` 允许；确认标准后 edit 恢复 |
| 8 | Task 派 Fixer，Fixer 用 `sed -i` | 拦；Fixer 改用 `read` → `edit`；父会话报告正常 |
| 9 | `sed -n` / `pnpm test` / `prettier --write` | 分别允许/允许/允许；Plan 下 formatter 拒绝 |
| 10 | 检查点 | 被拦 sed 不产生 diff；edit 的 diff 可撤销 |

## 手工真实模型场景

脚本化/自动化测试只验证策略，不验证模型行为。需要分别用
`cn:step-5-preview` 和 Claude 系模型跑：

- Plan / Agent / `完全访问` 下各一句“改这个文件”；
- 记录模型在 `sed -i` 被拦后是否改用 `edit`；
- 记录是否仍然反复 sed、是否产生 diff；
- 子代理 Fixer 同样跑一遍。

结果与截图写入本文件。
