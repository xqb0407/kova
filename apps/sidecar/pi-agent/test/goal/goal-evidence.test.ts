/**
 * 结构化证据的判定矩阵。
 *
 * 这一层挡的是「模型写一段完美但编造的证据」：refs 必须能在本次目标的工具台账里
 * 找到真实记录，文件类证据还要核对当前内容哈希。这里全部用合成台账与临时文件，
 * 不跑真实命令、不调模型。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  clearGoalEvidence,
  dropGoalEvidence,
  getGoalEvidence,
  normalizeEvidenceRefs,
  recordGoalToolResult,
  restoreGoalEvidence,
  verifyEvidenceRefs,
} from "../../src/goal/goal-evidence";
import { createGoal } from "../../src/goal/goal-state";
import { initStorage, sessionPath } from "../../src/storage/storage";

let scratch = "";
let threadSeq = 0;
let callSeq = 0;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "goal-evidence-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function threadId(): string {
  threadSeq += 1;
  return `t-evidence-${threadSeq}`;
}

function run(thread: string) {
  return { threadId: thread, cwd: scratch };
}

function context(
  name: string,
  args: Record<string, unknown>,
  opts: { isError?: boolean; exitCode?: number } = {},
): AfterToolCallContext {
  callSeq += 1;
  return {
    toolCall: { type: "toolCall", id: `call-${callSeq}`, name, arguments: args },
    args,
    result: {
      content: [],
      details: opts.exitCode === undefined ? undefined : { exitCode: opts.exitCode },
    },
    isError: opts.isError ?? false,
  } as unknown as AfterToolCallContext;
}

beforeEach(() => {
  // 每个用例自己 clear，避免上一组台账串味
});

describe("台账号", () => {
  test("bash 成功与失败都记录，退出码保留", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await recordGoalToolResult(run(t), context("bash", { command: "pnpm test" }, { exitCode: 0 }));
    await recordGoalToolResult(
      run(t),
      context("bash", { command: "pnpm build" }, { isError: true, exitCode: 1 }),
    );
    const entries = getGoalEvidence(t);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ toolName: "bash", command: "pnpm test", exitCode: 0, isError: false });
    expect(entries[1]).toMatchObject({ toolName: "bash", command: "pnpm build", exitCode: 1, isError: true });
    dropGoalEvidence(t);
  });

  test("目标工具自身不记证据", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await recordGoalToolResult(run(t), context("goal_complete", { goal_id: "g" }));
    expect(getGoalEvidence(t)).toHaveLength(0);
    dropGoalEvidence(t);
  });

  test("write 成功后记录文件路径与内容哈希", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    const file = join(scratch, "a.txt");
    await writeFile(file, "hello");
    await recordGoalToolResult(run(t), context("write", { file_path: "a.txt" }));
    expect(getGoalEvidence(t)[0]).toMatchObject({ toolName: "write", path: "a.txt" });
    expect(getGoalEvidence(t)[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    dropGoalEvidence(t);
  });
});

describe("command refs", () => {
  test("成功命令按规范化空白匹配", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await recordGoalToolResult(run(t), context("bash", { command: "pnpm  test" }, { exitCode: 0 }));
    const result = verifyEvidenceRefs(t, scratch, [
      { kind: "command", command: "pnpm test" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.verifiedCount).toBe(1);
    dropGoalEvidence(t);
  });

  test("未跑过、失败、退出码非 0 的命令都拒绝", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await recordGoalToolResult(
      run(t),
      context("bash", { command: "pnpm build" }, { isError: true, exitCode: 1 }),
    );
    for (const command of ["pnpm test", "pnpm build"]) {
      const result = verifyEvidenceRefs(t, scratch, [{ kind: "command", command }]);
      expect(result.ok).toBe(false);
    }
    expect(getGoalEvidence(t)[0]?.command).toBe("pnpm build");
    dropGoalEvidence(t);
  });
});

describe("file refs", () => {
  test("工作区内存在通过，越界路径拒绝", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await writeFile(join(scratch, "exists.txt"), "x");
    expect(
      verifyEvidenceRefs(t, scratch, [{ kind: "file", path: "exists.txt", expect: "exists" }]).ok,
    ).toBe(true);
    const escaped = verifyEvidenceRefs(t, scratch, [
      { kind: "file", path: "../outside.txt", expect: "exists" },
    ]);
    expect(escaped.ok).toBe(false);
    expect(escaped.errors.join("\n")).toContain("escapes the workspace");
    dropGoalEvidence(t);
  });

  test("modified 需要本次目标的成功写入；内容变化后拒绝", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    const file = join(scratch, "modified.txt");
    await writeFile(file, "v1");
    await recordGoalToolResult(run(t), context("write", { file_path: "modified.txt" }));
    expect(
      verifyEvidenceRefs(t, scratch, [
        { kind: "file", path: "modified.txt", expect: "modified" },
      ]).ok,
    ).toBe(true);

    await writeFile(file, "v2");
    const changed = verifyEvidenceRefs(t, scratch, [
      { kind: "file", path: "modified.txt", expect: "modified" },
    ]);
    expect(changed.ok).toBe(false);
    expect(changed.errors.join("\n")).toContain("no longer matches");
    dropGoalEvidence(t);
  });

  test("没有写入记录时 modified 拒绝", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await writeFile(join(scratch, "untouched.txt"), "x");
    const result = verifyEvidenceRefs(t, scratch, [
      { kind: "file", path: "untouched.txt", expect: "modified" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("no successful write/edit");
    dropGoalEvidence(t);
  });
});

describe("tool / manual refs", () => {
  test("tool ref 匹配成功调用与路径", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    await recordGoalToolResult(run(t), context("write", { file_path: "x.ts" }));
    expect(
      verifyEvidenceRefs(t, scratch, [{ kind: "tool", tool: "write", path: "x.ts" }]).ok,
    ).toBe(true);
    expect(
      verifyEvidenceRefs(t, scratch, [{ kind: "tool", tool: "write", path: "other.ts" }]).ok,
    ).toBe(false);
    dropGoalEvidence(t);
  });

  test("manual 通过但计入 manualCount，不产生机器核验数", async () => {
    const t = threadId();
    clearGoalEvidence(t);
    const result = verifyEvidenceRefs(t, scratch, [
      { kind: "manual", note: "视觉检查" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.manualCount).toBe(1);
    expect(result.verifiedCount).toBe(0);
    dropGoalEvidence(t);
  });
});

describe("refs 形状与重启回放", () => {
  test("非法 ref 形状被收窄并报错", () => {
    const parsed = normalizeEvidenceRefs([
      { kind: "command", command: "x" },
      { kind: "file", path: "y", expect: "weird" },
      { kind: "manual" },
    ]);
    expect(parsed.refs).toHaveLength(1);
    expect(parsed.errors.length).toBe(2);
  });

  test("从 JSONL 回放 toolResult 重建台账", () => {
    const t = threadId();
    const tmp = join(scratch, `replay-${t}`);
    mkdirSync(tmp, { recursive: true });
    initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
    const sessionId = `s-${t}`;
    const rows = [
      {
        type: "message",
        seq: 0,
        agent: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
          timestamp: 1,
        },
      },
      {
        type: "message",
        seq: 1,
        agent: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          details: { exitCode: 0 },
          timestamp: 2,
        },
      },
    ];
    writeFileSync(sessionPath(sessionId), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const goal = { ...createGoal("x"), startedSeq: 0, startedAt: 0 };
    restoreGoalEvidence(t, sessionId, goal);
    expect(getGoalEvidence(t)).toHaveLength(1);
    expect(
      verifyEvidenceRefs(t, scratch, [{ kind: "command", command: "pnpm test" }]).ok,
    ).toBe(true);
    dropGoalEvidence(t);
  });
});
