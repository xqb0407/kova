/**
 * 会话摘要 → 侧栏分组镜像：projectCwd 必须按 sessionId 落到 project map，
 * 且会话移出项目（projectCwd 缺失）时旧映射要删除，否则侧栏会一直把它
 * 留在旧项目卡下。
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  applySessionSummaries,
  piSessionCwdMap,
  piSessionOriginMap,
  piSessionProjectMap,
} from "@/lib/pi/pi-thread-adapter";
import type { PiSessionSummary } from "@/lib/pi/pi-bridge";

function summary(overrides: Partial<PiSessionSummary>): PiSessionSummary {
  return {
    sessionId: "s1",
    firstMessage: "hi",
    messageCount: 1,
    modified: "2026-10-22T00:00:00Z",
    cwd: "/abs/backend",
    ...overrides,
  } as PiSessionSummary;
}

afterAll(() => {
  piSessionCwdMap.clear();
  piSessionProjectMap.clear();
  piSessionOriginMap.clear();
});

describe("applySessionSummaries：项目归属镜像", () => {
  test("附加根会话带 projectCwd，原始 cwd 与归属分别落两张表", () => {
    applySessionSummaries([
      summary({ sessionId: "s-root", cwd: "/abs/backend", projectCwd: "/abs/frontend" }),
      summary({ sessionId: "s-main", cwd: "/abs/frontend", projectCwd: "/abs/frontend" }),
      summary({ sessionId: "s-task", cwd: "" }),
    ]);
    expect(piSessionCwdMap.get("s-root")).toBe("/abs/backend");
    expect(piSessionProjectMap.get("s-root")).toBe("/abs/frontend");
    expect(piSessionProjectMap.get("s-main")).toBe("/abs/frontend");
    expect(piSessionProjectMap.has("s-task")).toBe(false);
  });

  test("会话移除项目归属后旧映射被删除（不会留在旧项目卡）", () => {
    applySessionSummaries([
      summary({ sessionId: "s-move", cwd: "/abs/backend", projectCwd: "/abs/frontend" }),
    ]);
    expect(piSessionProjectMap.get("s-move")).toBe("/abs/frontend");

    applySessionSummaries([
      summary({ sessionId: "s-move", cwd: "/abs/standalone" }),
    ]);
    expect(piSessionProjectMap.has("s-move")).toBe(false);
    expect(piSessionCwdMap.get("s-move")).toBe("/abs/standalone");
  });
});

describe("applySessionSummaries：会话来源镜像", () => {
  test("IM 会话落 origin；来源缺失时删除（侧栏不残留放行标记）", () => {
    applySessionSummaries([
      summary({ sessionId: "s-im", cwd: "/abs/im", origin: "im" }),
    ]);
    expect(piSessionOriginMap.get("s-im")).toBe("im");

    applySessionSummaries([summary({ sessionId: "s-im", cwd: "/abs/im" })]);
    expect(piSessionOriginMap.has("s-im")).toBe(false);
  });
});
