import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { replayHistory, type SnapshotMessage } from "../../src/acp/history";

async function replay(messages: SnapshotMessage[]) {
  const updates: acp.SessionNotification["update"][] = [];
  await replayHistory({
    sessionId: "s1",
    cwd: "/ws",
    messages,
    sendUpdate: (update) => {
      updates.push(update);
    },
  });
  return updates;
}

describe("session/load 历史回放", () => {
  test("user/assistant/thinking/toolResult 顺序与配对", async () => {
    const updates = await replay([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "working" },
          { type: "toolCall", id: "t1", name: "read", arguments: { file_path: "a.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "file body" },
          { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
    });
    expect(updates[2]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "working" },
    });
    expect(updates[3]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "pending",
    });
    const result = updates[4] as { status?: string; content?: unknown[] };
    expect(result.status).toBe("completed");
    expect(result.content).toHaveLength(2);
    expect(JSON.stringify(result.content)).toContain("file body");
    expect(JSON.stringify(result.content)).toContain("image");
    expect(updates[5]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
  });

  test("注入消息、压缩/模型切换行被跳过", async () => {
    const updates = await replay([
      { role: "user", content: "[[auto-continue]] keep going" },
      { role: "user", content: "[[goal-continue]] step" },
      { role: "user", content: "[[capability-reminder]] note" },
      { role: "user", content: "[[queued-steer]] merged" },
      { role: "user", content: "real question" },
      { role: "compactionSummary", summary: "summary", tokensBefore: 10 },
      { role: "modelChange", provider: "p", modelId: "m" },
      { role: "bashExecution", command: "ls", output: "x" },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "real question" },
    });
  });

  test("没有结果的工具调用收成 failed", async () => {
    const updates = await replay([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "sleep 1" } }],
      },
    ]);
    const last = updates[updates.length - 1] as { status?: string; content?: unknown };
    expect(last.status).toBe("failed");
    expect(JSON.stringify(last.content)).toContain("No result recorded");
  });

  test("user 图片回放为 user_message_chunk image", async () => {
    const updates = await replay([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" },
        ],
      },
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: "image/png" },
    });
  });
});
