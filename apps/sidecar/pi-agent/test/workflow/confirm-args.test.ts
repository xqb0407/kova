import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptProposal, resolveStepPrompt, validatePlan } from "../../src/workflow/plan-state";
import { gateDependencyWarnings } from "../../src/workflow/tools";
import {
  clearWorkflow,
  commitWorkflow,
  confirmWorkflowPlan,
  findWorkflowRun,
  getWorkflow,
  migrateWorkflow,
  restoreWorkflow,
  startWorkflow,
  workflowStatePayload,
  workflowStepDetailPayload,
} from "../../src/workflow/workflow";
import { initStorage } from "../../src/storage/storage";
import type { Running } from "../../src/types";

/**
 * v2 UI 的两条新服务端契约:
 * 1) 提案确认可带参数槽的值(确认 = 授权步骤清单 + 这组参数;参数必须在
 *    执行器起点前落进 run——指纹读 run.args);
 * 2) 步骤详情按需拉取(prompt 插值结果 / 结果 / gate 命令不进常规快照)。
 */

let seq = 0;
function makeRun(): Running {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), "wf-args-"));
  return {
    agent: { state: { messages: [] } } as unknown as Running["agent"],
    threadId: `t-wf-args-${seq}`,
    sessionId: `wf-args-session-${seq}`,
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

/** 带参数占位符与 gate 的最小剧本 */
function acceptPlan(run: Running) {
  const wf = startWorkflow(run, "看看行情");
  const checked = validatePlan([
    {
      key: "fetch",
      kind: "delegate",
      title: "拉取行情",
      prompt: "拉取 {{args.symbol}} 的行情",
      agent: "Explorer",
    },
    {
      key: "check",
      kind: "gate",
      title: "命令门",
      prompt: "确认依赖还在",
      gate: { command: "pnpm", args: ["test"] },
      dependsOn: ["fetch"],
    },
    {
      key: "report",
      kind: "synthesize",
      title: "汇总",
      prompt: "汇总 {{fetch}}",
      dependsOn: ["fetch", "check"],
    },
  ]);
  if (!checked.ok) throw new Error(checked.reason);
  // 提案接受的入口在 tools 层,这里直调同一契约的 plan-state acceptProposal
  const proposed = acceptProposal(wf, checked.steps, "行情日报");
  commitWorkflow(run, proposed);
  return proposed;
}

describe("提案确认带参(v2 参数槽)", () => {
  test("参数落进 run 并进 prompt 插值;无参数时不写 args 键", () => {
    const run = makeRun();
    acceptPlan(run);
    const res = confirmWorkflowPlan(run, { symbol: "BTC" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wf.status).toBe("running");
    expect(res.wf.args).toEqual({ symbol: "BTC" });
    const step = res.wf.plan!.steps.find((s) => s.key === "fetch")!;
    expect(resolveStepPrompt(res.wf, step, "fetch")).toBe("拉取 BTC 的行情");

    const run2 = makeRun();
    acceptPlan(run2);
    const bare = confirmWorkflowPlan(run2);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.wf.args).toBeUndefined();
  });

  test("非 proposed 状态拒绝确认,且不改动槽位", () => {
    const run = makeRun();
    const proposed = acceptPlan(run);
    const first = confirmWorkflowPlan(run, { symbol: "ETH" });
    expect(first.ok).toBe(true);
    const again = confirmWorkflowPlan(run, { symbol: "DOGE" });
    expect(again.ok).toBe(false);
    // 第二次确认被拒:槽位仍是第一次的盘面(参数没有被覆盖)
    expect(getWorkflow(run.threadId)?.args).toEqual({ symbol: "ETH" });
    expect(getWorkflow(run.threadId)?.status).toBe("running");
    // proposed 之前的建槽也拒绝
    const run2 = makeRun();
    startWorkflow(run2, "还没提案");
    const early = confirmWorkflowPlan(run2);
    expect(early.ok).toBe(false);
    expect(getWorkflow(run2.threadId)?.status).toBe("proposing");
    clearWorkflow(run.threadId);
    clearWorkflow(run2.threadId);
    void proposed;
  });
});

describe("中文参数名与 gate 依赖警告(实机事故的两条防线)", () => {
  test("resolveStepPrompt:中文参数名照常插值(不再是原样漏给子代理的占位符)", () => {
    const run = makeRun();
    acceptPlan(run);
    const res = confirmWorkflowPlan(run, { symbol: "半导体" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const wf = res.wf;
    const step = wf.plan!.steps.find((s) => s.key === "fetch")!;
    // 原本的剧本用 symbol,这里直接验证中文名的插值路径
    const zh = { ...step, prompt: "调研 {{args.行业}} 的竞品" };
    expect(resolveStepPrompt(wf, zh, "fetch")).toBe("调研 <missing arg: 行业> 的竞品");
    const withArg = { ...wf, args: { 行业: "金融" } };
    expect(resolveStepPrompt(withArg, zh, "fetch")).toBe("调研 金融 的竞品");
    clearWorkflow(run.threadId);
  });

  test("gateDependencyWarnings:无依赖的门被点名;只有门时不提醒", () => {
    const steps = [
      { key: "a", kind: "delegate", title: "调研", dependsOn: [] as string[] },
      { key: "g", kind: "gate", title: "质检", dependsOn: [] as string[] },
    ];
    const warnings = gateDependencyWarnings(steps);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"g"');
    // 依赖齐备的门不提醒
    expect(gateDependencyWarnings([steps[0]!, { ...steps[1]!, dependsOn: ["a"] }])).toHaveLength(0);
    // 剧本里只有门(对既有环境做检查):没有上游可言,不提醒
    expect(gateDependencyWarnings([steps[1]!])).toHaveLength(0);
  });
});

describe("槽位恢复与迁移(实机:执行器活着,槽位被水合的暂停副本覆盖)", () => {
  // 存储根必须本文件自己钉:全套跑时别的测试会 initStorage/initHostMode 换掉
  // sessionsDir,而「绝对路径 sessionId 直通」只在未初始化时成立——不钉的话
  // 写行的根与读行的根会不是同一个(实机表现为「单跑绿、全量红」)
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "wf-args-sessions-"));
    initStorage(join(dir, "state.db"), join(dir, "sessions"));
  });

  test("restoreWorkflow 绝不覆盖活槽(活槽是在跑的那份,恢复源可能更旧)", () => {
    const run = makeRun();
    const proposed = acceptPlan(run);
    const confirmed = confirmWorkflowPlan(run);
    expect(confirmed.ok).toBe(true);
    // 模拟执行器已推进:槽位里有 done 的步骤
    const live = { ...getWorkflow(run.threadId)!, steps: { ...getWorkflow(run.threadId)!.steps, fetch: { key: "fetch", status: "done" as const, result: "产物" } } };
    commitWorkflow(run, live);
    // 水合(转录行是旧快照:还在 running、没有结果)——不许把活槽改回去
    restoreWorkflow(run.threadId, run.sessionId!);
    const after = getWorkflow(run.threadId)!;
    expect(after.status).toBe("running");
    expect(after.steps.fetch?.status).toBe("done");
    expect(after.steps.fetch?.result).toBe("产物");
    // 线程键迁移:槽位跟着走(迁移后推快照由 emit 负责,测试只验槽位本身)
    migrateWorkflow(run.threadId, `${run.threadId}-moved`);
    expect(getWorkflow(run.threadId)).toBeUndefined();
    expect(getWorkflow(`${run.threadId}-moved`)?.status).toBe("running");
    clearWorkflow(`${run.threadId}-moved`);
    void proposed;
  });

  test("槽位不存在时恢复照常工作(进程重启路径不受影响)", () => {
    const run = makeRun();
    acceptPlan(run);
    // 模拟进程重启:槽位没了,转录里的 workflow_state 行还在
    clearWorkflow(run.threadId);
    expect(getWorkflow(run.threadId)).toBeUndefined();
    restoreWorkflow(run.threadId, run.sessionId!);
    const restored = getWorkflow(run.threadId);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe("proposed");
    expect(restored!.plan?.steps.map((x) => x.key)).toContain("fetch");
    clearWorkflow(run.threadId);
  });
});

describe("恢复写回必须带回 cwd(否则下次恢复丢结果)", () => {
  test("恢复落的那一行保留 cwd,第二次恢复仍能找到 run 文件", () => {
    const run = makeRun();
    const proposed = acceptPlan(run);
    const confirmed = confirmWorkflowPlan(run);
    expect(confirmed.ok).toBe(true);
    // 模拟进程重启:槽位清掉,从转录恢复(这次恢复会写回一行 paused)
    clearWorkflow(run.threadId);
    restoreWorkflow(run.threadId, run.sessionId!);
    // 恢复出的 running 是谎报(驱动它的进程没了)→ 降级 paused
    expect(getWorkflow(run.threadId)?.status).toBe("paused");
    // 再清一次槽,恢复出的这一份若丢了 cwd,下一次就只能退回瘦身行(resultsUnavailable)
    clearWorkflow(run.threadId);
    restoreWorkflow(run.threadId, run.sessionId!);
    expect(getWorkflow(run.threadId)?.resultsUnavailable).toBeUndefined();
    clearWorkflow(run.threadId);
    void proposed;
  });
});

describe("线程键漂移:按会话查找,不搬运(实机:搬运造成 flapping + UI 刷爆)", () => {
  test("同一运行在草稿键与会话键下都查得到,且只有一份(不复制、不搬)", () => {
    const run = makeRun();
    acceptPlan(run);
    const confirmed = confirmWorkflowPlan(run);
    expect(confirmed.ok).toBe(true);
    const draftKey = run.threadId;
    const sessionId = run.sessionId!;
    // 草稿键直查
    expect(getWorkflow(draftKey)?.status).toBe("running");
    // 会话键查不到(槽只在草稿键下),按会话回落到同一份
    expect(getWorkflow(sessionId)).toBeUndefined();
    expect(findWorkflowRun(sessionId, sessionId)?.id).toBe(getWorkflow(draftKey)?.id);
    // 不搬运:草稿键下那份仍在原处(过去会搬走 → 两个调用方轮流拽 → flapping)
    expect(getWorkflow(draftKey)?.status).toBe("running");
    // restoreWorkflow 见到同会话的活槽就不再从磁盘恢复
    restoreWorkflow(sessionId, sessionId);
    expect(getWorkflow(sessionId)).toBeUndefined();
    clearWorkflow(draftKey);
  });

  test("别的会话查不到(按 sessionId 认,不按「随便一个活槽」)", () => {
    const run = makeRun();
    acceptPlan(run);
    expect(findWorkflowRun("t-other", "session-that-does-not-exist")).toBeUndefined();
    clearWorkflow(run.threadId);
  });
});

describe("步骤详情按需拉取(v2 抽屉)", () => {
  test("常规快照带参数声明与解析后的超时;详情带插值 prompt 与 gate 命令", () => {
    const run = makeRun();
    acceptPlan(run);
    confirmWorkflowPlan(run, { symbol: "BTC" });

    // 常规快照:args 声明(从 {{args.symbol}} 提取)+ argValues + timeoutMs 均已解析
    const payload = workflowStatePayload(run.threadId);
    const snapshot = payload.run as Record<string, unknown>;
    expect(snapshot.args).toEqual([
      { name: "symbol", type: "string", required: false },
    ]);
    expect(snapshot.argValues).toEqual({ symbol: "BTC" });
    const steps = snapshot.steps as Record<string, unknown>[];
    expect(steps.find((s) => s.key === "fetch")?.timeoutMs).toBe(20 * 60_000);
    expect(steps.find((s) => s.key === "check")?.timeoutMs).toBe(120_000);

    // 详情:插值后的 prompt 与 gate 命令
    const fetch = workflowStepDetailPayload(run.threadId, "fetch").detail;
    expect(fetch?.prompt).toBe("拉取 BTC 的行情");
    expect(fetch?.agent).toBe("Explorer");
    const check = workflowStepDetailPayload(run.threadId, "check").detail;
    expect(check?.gate).toEqual({ command: "pnpm", args: ["test"] });
    // 未知键 → null(抽屉据此显示「该步不存在」)
    expect(workflowStepDetailPayload(run.threadId, "nope").detail).toBeNull();
    clearWorkflow(run.threadId);
  });
});
