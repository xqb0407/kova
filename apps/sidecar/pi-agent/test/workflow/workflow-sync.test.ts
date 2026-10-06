import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptProposal,
  confirmProposal,
  validatePlan,
} from "../../src/workflow/plan-state";
import {
  commitWorkflow,
  getWorkflow,
  syncWorkflowOnUserPrompt,
  clearWorkflow,
} from "../../src/workflow/workflow";
import type { Running } from "../../src/types";

/**
 * syncWorkflowOnUserPrompt 的语义锁定(实机回归:用户一句「确认」被当成接管,
 * 把正在跑的执行器整条暂停,表现为「点了确认没反应」)。
 */

let seq = 0;
function makeRun(): Running {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), "wf-sync-"));
  // sessionId 用临时目录下的绝对路径:测试未初始化 storage,sessionPath 会把它
  // 拼到进程 cwd(sidecar 包目录)——相对 id 会把会话行写进仓库
  const sessionId = join(cwd, "session");
  return {
    agent: { state: { messages: [] } } as unknown as Running["agent"],
    threadId: `t-wf-sync-${seq}`,
    sessionId,
    cwd,
    persistedSeq: 0,
    jsonlSeq: 0,
    compactionGeneration: 0,
    pendingOverflowRecovery: false,
    providerRetry: {} as Running["providerRetry"],
    retryCapture: {},
    providerRetryChunkId: "r",
    providerRetryActive: false,
    providerRetryTurnSeq: 1,
    delegations: new Map(),
    stopRequested: false,
    mode: "workflow",
    approvalLevel: "ask",
    appMode: "code",
    planning: "inactive",
    baseTools: [],
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
    usagePending: 0,
  } as unknown as Running;
}

function planSteps() {
  const checked = validatePlan([
    { key: "a", kind: "delegate", title: "A", prompt: "任务", agent: "explorer" },
    { key: "s", kind: "synthesize", title: "汇总", prompt: "汇总 {{a}}", dependsOn: ["a"] },
  ]);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.steps;
}

describe("工作流同步的实机语义", () => {
  test("无运行时:用户消息建出「编排中」运行", () => {
    const run = makeRun();
    syncWorkflowOnUserPrompt(run, "把这件事编排成工作流剧本");
    const wf = getWorkflow(run.threadId);
    expect(wf?.status).toBe("proposing");
    expect(wf?.objective).toContain("编排成工作流");
    clearWorkflow(run.threadId);
    rmSync(run.cwd, { recursive: true, force: true });
  });

  test("running 中的用户消息**不**暂停运行(实机修复:一句「确认」不该掐掉执行器)", () => {
    const run = makeRun();
    syncWorkflowOnUserPrompt(run, "目标");
    let wf = getWorkflow(run.threadId)!;
    wf = acceptProposal(wf, planSteps(), "测试");
    wf = confirmProposal(wf)!;
    commitWorkflow(run, wf);

    syncWorkflowOnUserPrompt(run, "确认");
    syncWorkflowOnUserPrompt(run, "怎么样了?");
    expect(getWorkflow(run.threadId)?.status).toBe("running");
    clearWorkflow(run.threadId);
    rmSync(run.cwd, { recursive: true, force: true });
  });

  test("proposed 中的用户消息 = 对剧本的意见(驳回带回 feedback)", () => {
    const run = makeRun();
    syncWorkflowOnUserPrompt(run, "目标");
    let wf = getWorkflow(run.threadId)!;
    wf = acceptProposal(wf, planSteps(), "测试");
    commitWorkflow(run, wf);

    syncWorkflowOnUserPrompt(run, "第二步不要用 Explorer");
    const after = getWorkflow(run.threadId)!;
    expect(after.status).toBe("proposing");
    expect(after.proposalFeedback).toContain("Explorer");
    clearWorkflow(run.threadId);
    rmSync(run.cwd, { recursive: true, force: true });
  });
});
