import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  parsePromptContent,
  permissionInputFor,
  permissionOptionsFor,
  StreamTranslator,
  toolKindFor,
  toolTitleFor,
} from "../../src/acp/translate";

describe("parsePromptContent", () => {
  test("text/image/resource_link/resource 内容块", () => {
    const blocks: acp.ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
      {
        type: "image",
        data: Buffer.from("png").toString("base64"),
        mimeType: "image/png",
        uri: "file:///tmp/a.png",
      },
      { type: "resource_link", name: "src/index.ts", uri: "file:///ws/src/index.ts" },
      {
        type: "resource",
        resource: { uri: "file:///ws/notes.md", mimeType: "text/markdown", text: "notes" },
      },
      { type: "audio", data: "x", mimeType: "audio/wav" },
    ];
    const parsed = parsePromptContent(blocks, "/ws");
    expect(parsed.text).toContain("hello");
    expect(parsed.text).toContain("world");
    expect(parsed.text).toContain("resource link");
    expect(parsed.text).toContain("notes");
    expect(parsed.text).toContain("audio content is not supported");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.mimeType).toBe("image/png");
    expect(parsed.attachments[0]?.name).toBe("a.png");
  });

  test("超大内联图片降级为说明行", () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10).toString("base64");
    const parsed = parsePromptContent(
      [{ type: "image", data: big, mimeType: "image/png" }],
      "/ws",
    );
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.text).toContain("larger than 2MiB");
  });
});

describe("tool metadata", () => {
  test("kind/title/locations", () => {
    expect(toolKindFor("bash")).toBe("execute");
    expect(toolKindFor("read")).toBe("read");
    expect(toolKindFor("edit")).toBe("edit");
    expect(toolKindFor("grep")).toBe("search");
    expect(toolKindFor("WebFetch")).toBe("fetch");
    expect(toolKindFor("plan_exit")).toBe("switch_mode");
    expect(toolKindFor("mystery")).toBe("other");

    expect(toolTitleFor("bash", { command: "pnpm test" })).toContain("pnpm test");
    expect(toolTitleFor("read", { file_path: "a.ts" })).toBe("Read a.ts");
    expect(toolTitleFor("edit", { file_path: "a.ts" })).toBe("Edit a.ts");
    expect(toolTitleFor("plan_exit", { title: "Plan A" })).toBe("Approve plan: Plan A");
  });
});

describe("permission options", () => {
  test("canRemember 才给 allow_always；plan_exit 永不给", () => {
    expect(permissionOptionsFor("bash", false).map((o) => o.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);
    expect(permissionOptionsFor("bash", true).map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    expect(permissionOptionsFor("plan_exit", true).map((o) => o.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  test("大内容在权限 rawInput 里被截断，plan markdown 保留结构", () => {
    const input = permissionInputFor("write", {
      file_path: "a.txt",
      content: "x".repeat(5000),
    });
    expect(String(input.content)).toContain("truncated for permission preview");
    const plan = permissionInputFor("plan_exit", {
      title: "P",
      markdown: "m".repeat(10),
    });
    expect(plan.markdown).toBe("m".repeat(10));
  });
});

describe("StreamTranslator", () => {
  function makeTranslator(overrides?: {
    onPermission?: (data: unknown) => void | Promise<void>;
    onQuestion?: (data: Record<string, unknown>) => void | Promise<void>;
    onInteractionResolved?: (data: Record<string, unknown>) => void | Promise<void>;
    onModeChange?: (mode: string) => void;
  }) {
    const updates: acp.SessionNotification["update"][] = [];
    const translator = new StreamTranslator({
      sessionId: "s1",
      cwd: "/ws",
      sendUpdate: (update) => {
        updates.push(update);
      },
      onPermission: overrides?.onPermission ?? (() => {}),
      onQuestion: overrides?.onQuestion ?? (() => {}),
      onInteractionResolved: overrides?.onInteractionResolved ?? (() => {}),
      onModeChange: overrides?.onModeChange,
    });
    return { translator, updates };
  }

  test("正文/思考 delta → agent_message_chunk / agent_thought_chunk", async () => {
    const { translator, updates } = makeTranslator();
    await translator.handle({ type: "text-delta", delta: "hi" });
    await translator.handle({ type: "reasoning-delta", delta: "think" });
    expect(updates[0]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    expect(updates[1]).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" },
    });
  });

  test("tool 事件 + 图片累积为完整 content", async () => {
    const { translator, updates } = makeTranslator();
    await translator.handle({
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "read",
      input: { file_path: "a.png" },
    });
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "in_progress",
    });
    await translator.handle({
      type: "tool-output-available",
      toolCallId: "t1",
      output: "attached",
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    expect(JSON.stringify(updates[1])).toContain("attached");
    await translator.handle({
      type: "data-image",
      data: {
        toolCallId: "t1",
        mimeType: "image/png",
        src: `data:image/png;base64,${Buffer.from("img").toString("base64")}`,
      },
    });
    const last = updates[updates.length - 1] as { content?: unknown[] };
    expect(last.content).toHaveLength(2);
    expect(JSON.stringify(last.content)).toContain("attached");
    expect(JSON.stringify(last.content)).toContain("image");
  });

  test("data-todo → plan 并过滤 deleted", async () => {
    const { translator, updates } = makeTranslator();
    await translator.handle({
      type: "data-todo",
      data: {
        tasks: [
          { id: 1, subject: "a", status: "pending" },
          { id: 2, subject: "b", status: "in_progress" },
          { id: 3, subject: "c", status: "completed" },
          { id: 4, subject: "d", status: "deleted" },
        ],
      },
    });
    expect(updates[0]).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "a", priority: "medium", status: "pending" },
        { content: "b", priority: "medium", status: "in_progress" },
        { content: "c", priority: "medium", status: "completed" },
      ],
    });
  });

  test("data-planningState 只在实际变化时发 current_mode_update；goal 映射 agent", async () => {
    const modes: string[] = [];
    const { translator, updates } = makeTranslator({
      onModeChange: (mode) => modes.push(mode),
    });
    await translator.handle({ type: "data-planningState", data: { mode: "goal" } });
    await translator.handle({ type: "data-planningState", data: { mode: "agent" } });
    await translator.handle({ type: "data-planningState", data: { mode: "plan" } });
    expect(updates).toEqual([
      { sessionUpdate: "current_mode_update", currentModeId: "agent" },
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    ]);
    // agent 用它同步 entry.lastMode（configOptions 的 Mode 当前值不能分叉）
    expect(modes).toEqual(["agent", "plan"]);
  });

  test("data-toolApproval / data-question / data-interactionResolved 回调", async () => {
    const seen: string[] = [];
    const { translator } = makeTranslator({
      onPermission: (data) => {
        seen.push(`permission:${(data as { toolCallId: string }).toolCallId}`);
      },
      onQuestion: (data) => {
        seen.push(`question:${String(data.questionId)}`);
      },
      onInteractionResolved: (data) => {
        seen.push(`resolved:${String(data.interactionId)}`);
      },
    });
    await translator.handle({
      type: "data-toolApproval",
      data: { approvalId: "a1", toolCallId: "t1", toolName: "bash", input: {} },
    });
    await translator.handle({
      type: "data-question",
      data: { questionId: "q1", questions: [] },
    });
    await translator.handle({
      type: "data-interactionResolved",
      data: { interactionId: "a1", resolution: "approved" },
    });
    expect(seen).toEqual(["permission:t1", "question:q1", "resolved:a1"]);
  });

  test("ensureToolCall 在已公告时发 pending update，markToolRunning 推进", async () => {
    const { translator, updates } = makeTranslator();
    await translator.handle({
      type: "tool-input-available",
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "ls" },
    });
    await translator.ensureToolCall({
      approvalId: "a2",
      toolCallId: "t2",
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "pending",
    });
    await translator.markToolRunning("t2");
    expect(updates[2]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
    });
  });
});
