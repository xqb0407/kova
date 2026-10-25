import { describe, expect, test } from "bun:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { toolBudgetCapability } from "../../src/agent/assembly/capabilities/tool-budget";
import { CapabilityRegistry } from "../../src/agent/assembly/registry";
import type { TurnSnapshot } from "../../src/agent/assembly/contracts";
import { resetCapabilitySettingsForTest } from "../../src/agent/assembly/settings";

const turn: TurnSnapshot = {
  sessionId: "session-budget",
  threadId: "thread-budget",
  cwd: "/tmp/ws",
  mode: "agent",
  appMode: "code",
  model: null,
  turnId: "turn-budget",
  messages: [],
  userText: "hi",
  approvalLevel: "ask",
};

function context(content: unknown[], isError = false): AfterToolCallContext {
  return {
    assistantMessage: { role: "assistant", content: [], timestamp: 0 },
    toolCall: { type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "x" } },
    args: { pattern: "x" },
    result: { content },
    isError,
    context: {},
  } as unknown as AfterToolCallContext;
}

async function planFor(writeArtifact: Parameters<typeof toolBudgetCapability>[0]) {
  resetCapabilitySettingsForTest();
  const registry = new CapabilityRegistry();
  registry.register(toolBudgetCapability(writeArtifact));
  await registry.installAll();
  registry.setEnabled("tool-budget", true);
  return registry.assembleTurn(turn);
}

describe("tool-budget 能力", () => {
  test("超限文本外置并保留图片块", async () => {
    const writes: unknown[] = [];
    const plan = await planFor({
      writeArtifact: async (input) => {
        writes.push(input);
        return { reference: "/tmp/artifacts/out.txt", bytes: 40000, truncated: false };
      },
    });
    const large = "A".repeat(40_000);
    const override = await plan.hooks.toolAfter[0].handler(
      context([
        { type: "text", text: large },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ]),
      plan.snapshot,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      toolCallId: "call-1",
      toolName: "grep",
    });
    expect(override?.content?.[0]?.type).toBe("text");
    expect((override?.content?.[0] as { text: string }).text).toContain(
      "/tmp/artifacts/out.txt",
    );
    expect(override?.content?.[1]?.type).toBe("image");
    expect(
      (override?.details as { tool_output_budget: { externalized: boolean } })
        .tool_output_budget.externalized,
    ).toBe(true);
  });

  test("未超限时不做任何改写", async () => {
    const plan = await planFor({
      writeArtifact: async () => ({ reference: "unused", bytes: 0, truncated: false }),
    });
    const override = await plan.hooks.toolAfter[0].handler(
      context([{ type: "text", text: "small" }]),
      plan.snapshot,
    );
    expect(override).toBeUndefined();
  });

  test("超过 512KB 的 artifact 提示改用 read，而不是 grep", async () => {
    const plan = await planFor({
      writeArtifact: async () => ({
        reference: "/tmp/artifacts/big.txt",
        bytes: 700_000,
        truncated: false,
      }),
    });
    const override = await plan.hooks.toolAfter[0].handler(
      context([{ type: "text", text: "A".repeat(600 * 1024) }]),
      plan.snapshot,
    );
    const text = (override?.content?.[0] as { text: string }).text;
    expect(text).toContain("512 KiB");
    expect(text).not.toContain("search this artifact with grep");
  });

  test("错误输出外置时保留头部原文", async () => {
    const plan = await planFor({
      writeArtifact: async () => ({
        reference: "/tmp/artifacts/error.txt",
        bytes: 40_000,
        truncated: false,
      }),
    });
    const override = await plan.hooks.toolAfter[0].handler(
      context(
        [{ type: "text", text: `ERROR: boom ${"A".repeat(40_000)}` }],
        true,
      ),
      plan.snapshot,
    );
    const text = (override?.content?.[0] as { text: string }).text;
    expect(text).toContain("Head of the error output:");
    expect(text).toContain("ERROR: boom");
  });

  test("artifact 写失败时降级为头尾预览且保留图片", async () => {
    const plan = await planFor({
      writeArtifact: async () => {
        throw new Error("disk full");
      },
    });
    const override = await plan.hooks.toolAfter[0].handler(
      context([
        { type: "text", text: "A".repeat(40_000) },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ]),
      plan.snapshot,
    );
    const text = (override?.content?.[0] as { text: string }).text;
    expect(text).toContain("artifact storage failed");
    expect(override?.content?.[1]?.type).toBe("image");
    expect(
      (override?.details as { tool_output_budget: { fallback: boolean } })
        .tool_output_budget.fallback,
    ).toBe(true);
  });
});
