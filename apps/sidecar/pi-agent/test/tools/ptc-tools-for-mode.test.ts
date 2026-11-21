import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import type { Running } from "../../src/types";
import { toolsForMode } from "../../src/agent/modes";

function readTool(): AgentTool {
  return {
    name: "read",
    label: "Read",
    description: "Read a file",
    parameters: obj({ path: str() }),
    execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
  };
}

function makeRun(mode: "agent" | "plan" | "ask" | "goal", ptcEnabled: boolean): Running {
  return {
    mode,
    ptcEnabled,
    baseTools: [readTool()],
    subagentTools: [],
    pendingToolApprovals: new Map(),
    cwd: "/tmp",
    sessionId: "s",
    threadId: "t",
  } as unknown as Running;
}

const names = (run: Running) => toolsForMode(run).map((tool) => tool.name);

describe("toolsForMode PTC injection", () => {
  test("agent mode appends run_code only when the session snapshot is enabled", () => {
    expect(names(makeRun("agent", true))).toContain("run_code");
    expect(names(makeRun("agent", false))).not.toContain("run_code");
  });

  test("goal mode appends run_code", () => {
    expect(names(makeRun("goal", true))).toContain("run_code");
  });

  test("ask and plan modes never expose run_code", () => {
    expect(names(makeRun("ask", true))).not.toContain("run_code");
    expect(names(makeRun("plan", true))).not.toContain("run_code");
  });
});
