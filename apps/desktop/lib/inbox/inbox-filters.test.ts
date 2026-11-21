import { describe, expect, it } from "bun:test";
import type { InboxItem } from "pi-protocol";
import {
  initiatorOf,
  matchesTime,
  sourceOf,
  sourceOptions,
} from "./inbox-filters";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "approval:a1",
    kind: "approval",
    state: "open",
    outcome: "needs_action",
    priority: 0,
    requiresAction: true,
    title: "需要批准：bash",
    sourceId: "a1",
    sessionId: "s1",
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    actions: ["open", "approve", "deny"],
    hasDetail: true,
    ...overrides,
  };
}

describe("inbox 筛选", () => {
  it("来源映射：本地任务/自动化/子代理/后台/外部 provider", () => {
    expect(sourceOf(item())).toBe("task");
    expect(sourceOf(item({ kind: "automation" }))).toBe("automation");
    expect(sourceOf(item({ kind: "subagent" }))).toBe("subagent");
    expect(sourceOf(item({ kind: "background_task" }))).toBe("background");
    expect(
      sourceOf(
        item({ kind: "external", external: { provider: "github", key: "o/r#1" } }),
      ),
    ).toBe("github");
  });

  it("来源选项按固定顺序 + 未知 provider 追加", () => {
    expect(
      sourceOptions([
        item({ kind: "external", external: { provider: "linear" } }),
        item(),
        item({ kind: "automation" }),
        item({ kind: "external", external: { provider: "custom" } }),
      ]),
    ).toEqual(["task", "automation", "linear", "custom"]);
  });

  it("发起人：外部=人；自动化/后台=系统；目标安全阀=系统；其余=Agent", () => {
    expect(initiatorOf(item({ kind: "external", external: { provider: "jira" } }))).toBe("human");
    expect(initiatorOf(item({ kind: "automation" }))).toBe("system");
    expect(initiatorOf(item({ kind: "background_task" }))).toBe("system");
    expect(
      initiatorOf(item({ kind: "goal", meta: { pauseReason: "time budget reached" } })),
    ).toBe("system");
    expect(initiatorOf(item({ kind: "question" }))).toBe("agent");
  });

  it("时间筛选：今天 / 7 天 / 30 天", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z");
    expect(matchesTime(item(), "today", now)).toBe(true);
    expect(matchesTime(item({ createdAt: "2026-11-10T10:00:00.000Z" }), "7d", now)).toBe(true);
    expect(matchesTime(item({ createdAt: "2026-10-01T10:00:00.000Z" }), "30d", now)).toBe(false);
    expect(matchesTime(item({ createdAt: "not-a-date" }), "today", now)).toBe(false);
  });
});
