/**
 * 工具诊断码回归门：码表、hostDiagnostic 优先级、tag 幂等、details 合并、
 * image 块不动、effect-free 集合边界（repairDanglingToolCalls 文案分流共用）。
 */
import { describe, expect, test } from "bun:test";
import {
  EFFECT_FREE_TOOL_NAMES,
  applyHostDiagnostic,
  hostDiagnostic,
  stripDiagnostic,
  tagDiagnostic,
} from "../../src/agent/tool-diagnostics";

describe("tagDiagnostic", () => {
  test("文本尾部追加标签", () => {
    expect(tagDiagnostic("denied", "policy_denied")).toBe("denied [diagnostic: policy_denied]");
  });

  test("幂等：同码不叠加", () => {
    const once = tagDiagnostic("denied", "policy_denied");
    expect(tagDiagnostic(once, "policy_denied")).toBe(once);
  });

  test("不同码替换而非追加：一个结果只有一个最终类别", () => {
    const a = tagDiagnostic("timed out", "timeout_backgrounded");
    const b = tagDiagnostic(a, "timeout_killed");
    expect(b).toBe("timed out [diagnostic: timeout_killed]");
    expect(b.match(/\[diagnostic:/g)).toHaveLength(1);
  });

  test("stripDiagnostic 还原文本（UI 投影用）", () => {
    expect(stripDiagnostic("denied [diagnostic: policy_denied]")).toBe("denied");
  });
});

describe("hostDiagnostic 优先级", () => {
  test("cancelled 优先级最高", () => {
    expect(hostDiagnostic({ cancelled: true, timedOut: true, running: true })).toBe("interrupted_by_user");
  });

  test("timedOut && running → timeout_backgrounded", () => {
    expect(hostDiagnostic({ timedOut: true, running: true, taskId: 3 })).toBe("timeout_backgrounded");
  });

  test("timedOut 无 running → timeout_killed", () => {
    expect(hostDiagnostic({ timedOut: true, cancelled: false })).toBe("timeout_killed");
  });

  test("sandbox.denied === write → sandbox_write_denied", () => {
    expect(hostDiagnostic({ sandbox: { denied: "write" } })).toBe("sandbox_write_denied");
    expect(hostDiagnostic({ sandbox: { denied: "read" } })).toBeUndefined();
  });

  test("无匹配返回 undefined（truncated 不打码）", () => {
    expect(hostDiagnostic({ truncated: true, exitCode: 1 })).toBeUndefined();
    expect(hostDiagnostic({})).toBeUndefined();
  });
});

describe("applyHostDiagnostic", () => {
  const textBlock = (text: string) => ({ type: "text" as const, text });

  test("text 块追加标签 + details.diagnostic 合并", () => {
    const result = applyHostDiagnostic(
      { content: [textBlock("Operation not permitted")], details: { exitCode: 1 } },
      { sandbox: { denied: "write" } },
    );
    expect((result.content[0] as { text: string }).text).toBe(
      "Operation not permitted [diagnostic: sandbox_write_denied]",
    );
    expect((result.details as unknown as { diagnostic: string }).diagnostic).toBe("sandbox_write_denied");
    // 原有 details 字段保留（合并而非整块替换）
    expect((result.details as { exitCode: number }).exitCode).toBe(1);
  });

  test("image 块不动，text 块照常打标（text+image 混合）", () => {
    const imageBlock = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const result = applyHostDiagnostic(
      { content: [textBlock("screenshot saved"), imageBlock] },
      { cancelled: true },
    );
    expect((result.content[0] as { text: string }).text).toContain("[diagnostic: interrupted_by_user]");
    expect(result.content[1]).toBe(imageBlock); // 同一对象引用，未被复制/修改
  });

  test("details 缺失或非对象时新建，不崩", () => {
    const r1 = applyHostDiagnostic(
      { content: [textBlock("x")], details: undefined as unknown as Record<string, unknown> },
      { timedOut: true, running: true },
    );
    expect((r1.details as { diagnostic: string }).diagnostic).toBe("timeout_backgrounded");
    const r2 = applyHostDiagnostic(
      { content: [textBlock("x")], details: "legacy-string" as unknown as Record<string, unknown> },
      { cancelled: true },
    );
    expect((r2.details as { diagnostic: string }).diagnostic).toBe("interrupted_by_user");
  });

  test("无可判定码时原样返回同一对象（零改动）", () => {
    const original = { content: [textBlock("ok")], details: { exitCode: 0 } };
    expect(applyHostDiagnostic(original, { truncated: true })).toBe(original);
  });
});

describe("EFFECT_FREE_TOOL_NAMES 边界", () => {
  test("计划声明的 9 个工具在集合内", () => {
    for (const name of ["read", "glob", "grep", "WebFetch", "WebSearch", "kb_search", "kb_read", "task_output", "Question"]) {
      expect(EFFECT_FREE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("有副作用的代表工具不在集合内", () => {
    for (const name of ["write", "edit", "bash", "task_stop", "memory_save"]) {
      expect(EFFECT_FREE_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
