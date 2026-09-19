import { describe, test, expect } from "bun:test";
import { type UIMessageChunk } from "ai";
import { Chat } from "/Users/herther/Desktop/ai-teamplte/node_modules/.bun/@ai-sdk+react@4.0.95+c26ca7207d72091a/node_modules/@ai-sdk/react/dist/index.js";

function manualStream() {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({ start(c) { controller = c; } });
  return {
    stream,
    push: (c: UIMessageChunk) => controller.enqueue(c),
    close: () => controller.close(),
  };
}

describe("Chat promote reproduction", () => {
  test("abort mid-tool-call A then stream B", async () => {
    const streams: ReturnType<typeof manualStream>[] = [];
    let call = 0;
    const chat = new Chat({
      transport: { sendMessages: async () => streams[call++]!.stream } as never,
      id: "repro2",
    });

    // A：start → step → 文本 → 工具调用开始（挂起）
    streams.push(manualStream());
    void chat.sendMessage({ text: "A" });
    streams[0].push({ type: "start" } as UIMessageChunk);
    streams[0].push({ type: "start-step" } as UIMessageChunk);
    streams[0].push({ type: "text-start", id: "t1" } as UIMessageChunk);
    streams[0].push({ type: "text-delta", id: "t1", delta: "A partial, calling tool..." } as UIMessageChunk);
    streams[0].push({
      type: "tool-input-start", id: "tc1", toolName: "bash",
    } as unknown as UIMessageChunk);
    await Bun.sleep(30);

    // B 发送：静默排队
    streams.push(manualStream());
    void chat.sendMessage({ text: "B" });
    await Bun.sleep(30);

    // promote：A 中止
    streams[0].push({ type: "abort" } as UIMessageChunk);
    streams[0].push({ type: "finish" } as UIMessageChunk);
    await Bun.sleep(30);

    // B 开跑
    streams[1].push({ type: "start" } as UIMessageChunk);
    streams[1].push({ type: "start-step" } as UIMessageChunk);
    streams[1].push({ type: "text-start", id: "t2" } as UIMessageChunk);
    streams[1].push({ type: "text-delta", id: "t2", delta: "B new reply" } as UIMessageChunk);
    streams[1].push({ type: "finish" } as UIMessageChunk);
    await Bun.sleep(50);

    const msgs = chat.state.messages;
    console.log("messages:", JSON.stringify(msgs.map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => ("text" in p ? p.text : `${p.type}${"state" in p ? ":" + (p as { state?: string }).state : ""}`)),
    }))));
    const assistant = msgs.filter((m) => m.role === "assistant");
    expect(assistant.length).toBe(2);
  });
});
