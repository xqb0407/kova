import { describe, expect, test } from "bun:test";
import { applyWorkflowChunk, workflowSnapshotForTest } from "@/lib/pi/pi-workflow";

/**
 * v2 的 store 单合并点(设计文档 §5 第 14 项):chunk / 通知行 / 轮询水合 /
 * 动作回包四条路汇到一个合并函数,按 updatedAt 取新——迟到的旧轮询回包不能
 * 把新的通知行推进顶掉(实机里「卡片退回旧状态」的成因)。
 */

let seq = 0;
const thread = () => `t-wf-merge-${++seq}`;

const run = (updatedAt: number, status: string, id = "wf-1") => ({
  run: {
    id,
    objective: "跑个流程",
    status,
    statusLine: `状态 ${status}`,
    tokensUsed: 0,
    startedAt: 1,
    updatedAt,
  },
});

describe("工作流快照合并点", () => {
  test("迟到的旧包不顶掉新快照(updatedAt 较小者被丢弃)", () => {
    const t = thread();
    applyWorkflowChunk(t, run(200, "running"));
    applyWorkflowChunk(t, run(100, "complete"));
    expect(workflowSnapshotForTest(t).run?.status).toBe("running");
  });

  test("更新的包正常覆盖(推进不丢)", () => {
    const t = thread();
    applyWorkflowChunk(t, run(100, "running"));
    applyWorkflowChunk(t, run(200, "complete"));
    expect(workflowSnapshotForTest(t).run?.status).toBe("complete");
  });

  test("同刻同 run 保留现有对象(轮询重复包不触发变更)", () => {
    const t = thread();
    applyWorkflowChunk(t, run(300, "running"));
    const first = workflowSnapshotForTest(t).run;
    applyWorkflowChunk(t, run(300, "running"));
    expect(workflowSnapshotForTest(t).run).toBe(first);
  });

  test("同槽换 run(id 不同且更新)用新包;同刻不同 id 也认新", () => {
    const t = thread();
    applyWorkflowChunk(t, run(400, "complete", "wf-old"));
    applyWorkflowChunk(t, run(500, "proposing", "wf-new"));
    expect(workflowSnapshotForTest(t).run?.id).toBe("wf-new");
    // 同一时刻换 run(清除后立即新建):id 不同 → 新包胜
    applyWorkflowChunk(t, run(500, "running", "wf-newer"));
    expect(workflowSnapshotForTest(t).run?.id).toBe("wf-newer");
  });

  test("null 接受为清除(显式动作与水合空槽都是事实)", () => {
    const t = thread();
    applyWorkflowChunk(t, run(600, "complete"));
    applyWorkflowChunk(t, { run: null });
    expect(workflowSnapshotForTest(t).run).toBeNull();
  });

  test("归一边界:声明/参数值/超时都在;脏字段整个剔除", () => {
    const t = thread();
    applyWorkflowChunk(t, {
      run: {
        ...run(700, "proposed").run,
        args: [{ name: "symbol", type: "number" }, { name: "" }, { type: "string" }],
        argValues: { symbol: "BTC", bad: { nested: true } },
        steps: [
          { key: "a", kind: "delegate", title: "A", dependsOn: [], timeoutMs: 1200 },
        ],
      },
    });
    const snapshot = workflowSnapshotForTest(t).run!;
    expect(snapshot.args).toEqual([{ name: "symbol", type: "number" }]);
    // 非原始值的参数值被剔掉;原始值保留
    expect(snapshot.argValues).toEqual({ symbol: "BTC" });
    expect(snapshot.steps?.[0]?.timeoutMs).toBe(1200);
  });
});
