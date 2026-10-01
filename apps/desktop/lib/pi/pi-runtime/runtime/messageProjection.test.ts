import { describe, expect, it } from "bun:test";
import { toMessagePartStatus } from "@assistant-ui/core/internal";
import type { ToolCallMessagePartStatus } from "@assistant-ui/core";
import {
  projectPiThreadMessages,
  projectPiThreadRepository,
  type PiProjectionInput,
} from "./messageProjection";
import { isCompleteTranscriptMessage } from "../client/validation";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiHostUiRequest,
  PiToolCall,
} from "../types";

const assistant = (
  content: PiAssistantMessage["content"],
  overrides: Partial<PiAssistantMessage> = {},
): PiAssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 100,
  ...overrides,
});

const toolCall = (id: string, name: string, args: object): PiToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args as Record<string, unknown>,
});

const input = (
  messages: PiAgentMessage[],
  extra: Partial<PiProjectionInput> = {},
): PiProjectionInput => ({
  messages,
  toolExecutions: {},
  runStatus: "idle",
  hostUiRequests: [],
  ...extra,
});

const contentParts = (m: { content: unknown }) =>
  m.content as ReadonlyArray<Record<string, unknown>>;

describe("messageProjection", () => {
  it("projects a user text message", () => {
    const out = projectPiThreadMessages(
      input([{ role: "user", content: "hello", timestamp: 1 }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toEqual([{ type: "text", text: "hello" }]);
  });

  // 并入哨兵前缀（steer 注入）：直播 message_start 与快照直出走同一投影出口，
  // 剥前缀 + 徽标标记 part（user-message.tsx 渲染「已并入当前回复」）——
  // 刷新前后一致，前缀绝不裸显（「已并入 html 随便写番茄时钟」事故回归钉）
  it("strips the steer sentinel and prepends the steeredNote badge part", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: "[[queued-steer]] 随便写番茄时钟。",
          timestamp: 1,
        },
      ]),
    );
    expect(out[0]!.content).toEqual([
      { type: "data", name: "steeredNote", data: {} },
      { type: "text", text: "随便写番茄时钟。" },
    ]);
  });

  it("strips the steer sentinel on array content, keeping following images", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: [
            { type: "text", text: "[[queued-steer]] 看图" },
            { type: "image", data: "abc", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ]),
    );
    expect(out[0]!.content).toEqual([
      { type: "data", name: "steeredNote", data: {} },
      { type: "text", text: "看图" },
    ]);
    // 图片投成 attachments（气泡外附件卡），不再留在 content
    expect(out[0]!.attachments).toEqual([
      {
        id: "pi-msg-idx:0-att-1",
        type: "image",
        name: "image-1.png",
        contentType: "image/png",
        status: { type: "complete" },
        content: [
          {
            type: "image",
            image: "data:image/png;base64,abc",
            filename: "image-1.png",
          },
        ],
      },
    ]);
  });

  it("does not touch text that merely contains the steer sentinel later on", () => {
    const out = projectPiThreadMessages(
      input([
        { role: "user", content: "说说 [[queued-steer]] 前缀是什么", timestamp: 1 },
      ]),
    );
    expect(out[0]!.content).toEqual([
      { type: "text", text: "说说 [[queued-steer]] 前缀是什么" },
    ]);
  });

  it("projects user image content as an attachment with a data URL", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: [{ type: "image", data: "abc", mimeType: "image/png" }],
          timestamp: 1,
        },
      ]),
    );
    // UI 格式回归：图片进 attachments（气泡外附件卡），content 不再内联 image
    expect(out[0]!.content).toEqual([]);
    expect(out[0]!.attachments).toEqual([
      {
        id: "pi-msg-idx:0-att-1",
        type: "image",
        name: "image-1.png",
        contentType: "image/png",
        status: { type: "complete" },
        content: [
          {
            type: "image",
            image: "data:image/png;base64,abc",
            filename: "image-1.png",
          },
        ],
      },
    ]);
  });

  it("does not re-wrap image data that is already an uppercase-scheme data URL", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: [
            {
              type: "image",
              data: "DATA:image/png;base64,abc",
              mimeType: "image/png",
            },
          ],
          timestamp: 1,
        },
      ]),
    );
    expect(out[0]!.attachments?.[0]?.content).toEqual([
      {
        type: "image",
        image: "DATA:image/png;base64,abc",
        filename: "image-1.png",
      },
    ]);
  });

  it("names user image attachments image-N with jpeg normalized to jpg", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: [
            { type: "image", data: "aaa", mimeType: "image/jpeg" },
            { type: "image", data: "bbb", mimeType: "image/webp" },
          ],
          timestamp: 1,
        },
      ]),
    );
    expect(out[0]!.attachments?.map((a) => a.name)).toEqual([
      "image-1.jpg",
      "image-2.webp",
    ]);
  });

  it("drops user content parts of a type it does not project", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "audio", data: "abc", mimeType: "audio/wav" },
      ],
      timestamp: 1,
    } as unknown as PiAgentMessage;
    expect(isCompleteTranscriptMessage(message)).toBe(true);

    const out = projectPiThreadMessages(input([message]));
    expect(out[0]!.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("projects assistant text vs thinking vs tool-call distinctly with parentId", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "the answer" },
          toolCall("tc1", "bash", { command: "ls" }),
        ]),
      ]),
    );
    expect(out).toHaveLength(1);
    const parts = contentParts(out[0]!);
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "let me think" });
    expect(parts[1]).toMatchObject({ type: "text", text: "the answer" });
    expect(parts[2]).toMatchObject({ type: "tool-call", toolName: "bash" });
    // all parts grouped under the same turn step（fixture 无 __seq → 独立前缀下标回退）
    expect(parts[0]!.parentId).toBe("pi-step-idx:0");
    expect(parts[1]!.parentId).toBe("pi-step-idx:0");
    expect(parts[2]!.parentId).toBe("pi-step-idx:0");
    // step recorded with usage
    expect(out[0]!.metadata?.steps).toEqual([
      {
        messageId: "pi-step-idx:0",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ]);
  });

  it("renders redacted thinking with an affordance", () => {
    const out = projectPiThreadMessages(
      input([assistant([{ type: "thinking", thinking: "", redacted: true }])]),
    );
    expect(contentParts(out[0]!)[0]).toMatchObject({
      type: "reasoning",
      text: "[reasoning redacted]",
    });
  });

  it("pairs a tool result into the tool-call by toolCallId", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("tc1", "bash", { command: "ls" })]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "bash",
          content: [{ type: "text", text: "file1\nfile2" }],
          isError: false,
          timestamp: 2,
        },
      ]),
    );
    // merged into one assistant message
    expect(out).toHaveLength(1);
    const part = contentParts(out[0]!)[0]!;
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "tc1",
      result: "file1\nfile2",
    });
    // 纯文本结果不产生图片 data part
    expect(contentParts(out[0]!)).toHaveLength(1);
  });

  it("dedupes a repeated toolCallId within one merged assistant group", () => {
    // 上游快照/直播合并漏出同一在飞 assistant 的两份相邻拷贝（历史缺陷：
    // @assistant-ui part 查找表按 toolCallId 键控，重复即 Duplicate key 崩溃）。
    // 同组合并后同 toolCallId 只留一份 part，后到状态胜出；不同 id 不误并。
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("call-1", "bash", { command: "ls" })]),
        assistant([
          toolCall("call-1", "bash", { command: "pwd" }),
          toolCall("call-2", "read", { path: "a" }),
        ]),
      ]),
    );
    expect(out).toHaveLength(1);
    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      args: { command: "pwd" },
    });
    expect(parts[1]).toMatchObject({ type: "tool-call", toolCallId: "call-2" });
  });

  it("keeps a single tool-result image when a repeated toolCallId merges in", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("call-1", "screenshot", {})]),
        assistant([toolCall("call-1", "screenshot", {})]),
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "screenshot",
          content: [
            { type: "image" as const, data: "AAAA", mimeType: "image/png" },
          ],
          isError: false,
          timestamp: 2,
        },
      ]),
    );
    const parts = contentParts(out[0]!);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
    // 旧拷贝挂的成图被替换清理，按新状态补回恰一张
    expect(parts.filter((p) => p.type === "data")).toHaveLength(1);
  });

  it("projects image tool result content as an image data part（sidecar 闸门镜像）", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("tc1", "screenshot", {})]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "screenshot",
          content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }],
          isError: false,
          timestamp: 2,
        },
      ]),
    );

    // 结果行 + 紧随其后的成图 data part（顺序契约：相邻，图廊按 toolCallId 认亲）
    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "tc1",
      result: "",
    });
    expect(parts[1]).toEqual({
      type: "data",
      name: "image",
      data: {
        src: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        bytes: 3, // floor(4*3/4)
        toolCallId: "tc1",
        toolName: "screenshot",
      },
    });
  });

  it("applies sidecar gate semantics: alt / mime 归一 / 超限与降级占位", () => {
    const oversizeB64 = "A".repeat(4 * 1024 * 1024); // ≈3MiB 解码字节 > 2MiB 上限
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("tc1", "screenshot", {})]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "screenshot",
          content: [
            { type: "text" as const, text: "headline line\nmore" },
            // image/jpg 非规范拼写 → 归一 jpeg，正常上屏
            { type: "image" as const, data: "AAAA", mimeType: "image/jpg" },
            // 数据为空 → 占位提示
            { type: "image" as const, data: "", mimeType: "image/png" },
            // 白名单外（svg 可含外链）→ 占位提示
            { type: "image" as const, data: "<svg/>", mimeType: "image/svg+xml" },
          ],
          isError: false,
          timestamp: 2,
        },
        assistant([toolCall("tc2", "read", {})]),
        {
          role: "toolResult",
          toolCallId: "tc2",
          toolName: "read",
          content: [{ type: "image" as const, data: oversizeB64, mimeType: "image/png" }],
          isError: false,
          timestamp: 3,
        },
      ]),
    );

    const parts = contentParts(out[0]!);
    // tc1：1 张上屏（归一 jpeg）+ 2 行占位；tc2：0 张上屏 + 1 行占位
    const dataParts = parts.filter((p) => p.type === "data");
    expect(dataParts).toHaveLength(1);
    expect(dataParts[0]).toMatchObject({
      name: "image",
      data: {
        src: "data:image/jpeg;base64,AAAA",
        mimeType: "image/jpeg",
        toolCallId: "tc1",
        alt: "headline line",
      },
    });
    const tc1 = parts.find((p) => p.type === "tool-call" && p.toolCallId === "tc1")!;
    // 非文本块贡献空段（join 出空行）+ 占位行追加在尾部——与 sidecar output 逐字一致
    expect(tc1.result).toBe(
      "headline line\nmore\n\n\n\n" +
        "[图片未展示：image/png 数据为空]\n" +
        "[图片未展示：不支持的类型 image/svg+xml（仅 png/jpeg/gif/webp）]",
    );
    const tc2 = parts.find((p) => p.type === "tool-call" && p.toolCallId === "tc2")!;
    expect(tc2.result).toBe("[图片未展示：约 3.0 MiB，超过 2.0 MiB 内联上限]");
  });

  it("treats image data as raw base64（sidecar 同款，不特判 data URL）", () => {
    // sidecar image-parts.ts 把 data 一律当裸 base64 拼 src；镜像同款语义，
    // 此测试钉住两侧同构——单侧「修复」data URL 特判会破坏同构
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("tc1", "screenshot", {})]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "screenshot",
          content: [
            {
              type: "image" as const,
              data: "data:image/png;base64,AAAA",
              mimeType: "image/png",
            },
          ],
          isError: false,
          timestamp: 2,
        },
      ]),
    );

    expect(contentParts(out[0]!)[1]).toMatchObject({
      type: "data",
      name: "image",
      data: { src: "data:image/png;base64,data:image/png;base64,AAAA" },
    });
  });

  it("pairs out-of-order parallel tool results by id", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("a", "bash", {}), toolCall("b", "read", {})]),
        {
          role: "toolResult",
          toolCallId: "b",
          toolName: "read",
          content: [{ type: "text", text: "B" }],
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "bash",
          content: [{ type: "text", text: "A" }],
          isError: true,
          timestamp: 3,
        },
      ]),
    );
    const parts = contentParts(out[0]!);
    expect(parts[0]).toMatchObject({
      toolCallId: "a",
      result: "A",
      isError: true,
    });
    expect(parts[1]).toMatchObject({ toolCallId: "b", result: "B" });
  });

  it("fills tool result from live streaming output before the result message lands", () => {
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "bash", {})])], {
        toolExecutions: {
          tc1: {
            toolCallId: "tc1",
            status: "running",
            partialResult: { content: [{ type: "text", text: "partial..." }] },
          },
        },
        runStatus: "running",
      }),
    );
    expect(contentParts(out[0]!)[0]).toMatchObject({
      toolCallId: "tc1",
      result: "partial...",
      isPreliminary: true,
    });
  });

  it.each([
    [
      "the execution ended",
      {
        toolExecutions: {
          tc1: {
            toolCallId: "tc1",
            status: "complete" as const,
            partialResult: {
              content: [{ type: "text" as const, text: "done" }],
            },
          },
        },
      },
    ],
    [
      "the result message landed",
      {
        toolExecutions: {
          tc1: {
            toolCallId: "tc1",
            status: "running" as const,
            partialResult: {
              content: [{ type: "text" as const, text: "partial..." }],
            },
          },
        },
        messages: [
          assistant([toolCall("tc1", "bash", {})]),
          {
            role: "toolResult" as const,
            toolCallId: "tc1",
            toolName: "bash",
            content: [{ type: "text" as const, text: "done" }],
            isError: false,
            timestamp: 101,
          },
        ],
      },
    ],
  ])("settles the streamed result once %s", (_label, extra) => {
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "bash", {})])], {
        runStatus: "running",
        ...extra,
      }),
    );
    const part = contentParts(out[0]!)[0]!;
    expect(part.result).toBe("done");
    expect(part.isPreliminary).toBeUndefined();
  });

  it("projects live image tool result content as an image data part", () => {
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "screenshot", {})])], {
        toolExecutions: {
          tc1: {
            toolCallId: "tc1",
            status: "running",
            partialResult: {
              content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
            },
          },
        },
        runStatus: "running",
      }),
    );

    // 直播路径同构：partialResult 的 image 块同样投影为 data part
    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ toolCallId: "tc1", result: "" });
    expect(parts[1]).toMatchObject({
      type: "data",
      name: "image",
      data: {
        src: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        toolCallId: "tc1",
        toolName: "screenshot",
      },
    });
  });

  it("ignores unsupported tool result parts while preserving recognized content", () => {
    const out = projectPiThreadMessages(
      input(
        [
          assistant([
            toolCall("final", "search", {}),
            toolCall("live", "search", {}),
          ]),
          {
            role: "toolResult",
            toolCallId: "final",
            toolName: "search",
            content: [
              { type: "text", text: "final text" },
              { type: "resource", uri: "resource://result" },
            ],
            isError: false,
            timestamp: 2,
          } as PiAgentMessage,
        ],
        {
          toolExecutions: {
            live: {
              toolCallId: "live",
              status: "running",
              partialResult: {
                content: [
                  { type: "text", text: "live text" },
                  { type: "resource", uri: "resource://partial" },
                ],
              },
            },
          },
          runStatus: "running",
        },
      ),
    );

    expect(contentParts(out[0]!)).toEqual([
      expect.objectContaining({
        toolCallId: "final",
        result: "final text",
      }),
      expect.objectContaining({ toolCallId: "live", result: "live text" }),
    ]);
    // resource 块被过滤，也不产生图片 data part（精确长度由 toEqual 保证）
  });

  it("merges multiple assistant turns into one message with a step each", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([toolCall("tc1", "bash", {})]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
        assistant([{ type: "text", text: "done" }], { timestamp: 200 }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.metadata?.steps).toHaveLength(2);
    const parts = contentParts(out[0]!);
    expect(parts[0]!.parentId).toBe("pi-step-idx:0"); // tool-call from turn 1
    expect(parts[1]).toMatchObject({
      type: "text",
      text: "done",
      parentId: "pi-step-idx:2",
    });
  });

  it("breaks the assistant group on a user message", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([{ type: "text", text: "a1" }]),
        { role: "user", content: "u2", timestamp: 5 },
        assistant([{ type: "text", text: "a2" }], { timestamp: 6 }),
      ]),
    );
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  });

  it("projects non-LLM roles to data parts", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "bashExecution",
          command: "ls",
          output: "x",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
        {
          role: "branchSummary",
          summary: "branched",
          fromId: "e1",
          timestamp: 2,
        },
        {
          role: "compactionSummary",
          summary: "compacted",
          tokensBefore: 1000,
          generation: 2,
          summarized: true,
          timestamp: 3,
        },
      ]),
    );
    expect(contentParts(out[0]!)[0]).toMatchObject({
      type: "data",
      name: "pi-bash-execution",
      data: { command: "ls", exitCode: 0 },
    });
    expect(contentParts(out[1]!)[0]).toMatchObject({
      name: "pi-branch-summary",
    });
    expect(contentParts(out[2]!)[0]).toMatchObject({
      name: "compaction",
      data: {
        phase: "complete",
        generation: 2,
        tokensBefore: 1000,
        summarized: true,
        summary: "compacted",
      },
    });
  });

  it("renders display:true custom messages and hides display:false", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "custom",
          customType: "note",
          content: "visible note",
          display: true,
          timestamp: 1,
        },
        {
          role: "custom",
          customType: "hidden",
          content: "secret",
          display: false,
          timestamp: 2,
        },
      ]),
    );
    expect(out).toHaveLength(1);
    const parts = contentParts(out[0]!);
    expect(parts[0]).toMatchObject({ type: "data", name: "pi-custom-message" });
    expect(parts[1]).toMatchObject({ type: "text", text: "visible note" });
  });

  it("projects unknown roles to a pi-unsupported-message data part", () => {
    const out = projectPiThreadMessages(
      input([{ role: "futuristic_role", foo: "bar" } as PiAgentMessage]),
    );
    expect(contentParts(out[0]!)[0]).toMatchObject({
      type: "data",
      name: "pi-unsupported-message",
      data: { role: "futuristic_role" },
    });
  });

  it("sets running status on the trailing assistant message while running", () => {
    const out = projectPiThreadMessages(
      input([assistant([{ type: "text", text: "typing" }])], {
        runStatus: "running",
      }),
    );
    expect(out[0]!.status).toEqual({ type: "running" });
  });

  it("maps stop reasons to status + carries error metadata", () => {
    const err = projectPiThreadMessages(
      input([
        assistant([{ type: "text", text: "" }], {
          stopReason: "error",
          errorMessage: "rate limited",
        }),
      ]),
    );
    expect(err[0]!.status).toMatchObject({
      type: "incomplete",
      reason: "error",
      error: "rate limited",
    });
    const piCustom = err[0]!.metadata?.custom?.pi as
      | { errorMessage?: string }
      | undefined;
    expect(piCustom?.errorMessage).toBe("rate limited");

    const aborted = projectPiThreadMessages(
      input([assistant([], { stopReason: "aborted" })]),
    );
    expect(aborted[0]!.status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
  });

  it("projects a tool-associated confirm request as a pending approval", () => {
    const request: PiHostUiRequest = {
      id: "r1",
      kind: "confirm",
      title: "Run?",
      message: "ok?",
      toolCallId: "tc1",
    };
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "bash", {})])], {
        hostUiRequests: [request],
      }),
    );
    const part = contentParts(out[0]!)[0]!;
    expect(part.approval).toEqual({ id: "r1", prompt: "Run?\nok?" });
    expect(out[0]!.status).toEqual({
      type: "requires-action",
      reason: "interrupt",
    });
  });

  it("projects a tool-associated select request as a question with one option per choice", () => {
    const request: PiHostUiRequest = {
      id: "r2",
      kind: "select",
      title: "Deploy where?",
      options: ["staging", "production"],
      toolCallId: "tc1",
    };
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "deploy", {})])], {
        hostUiRequests: [request],
      }),
    );
    const part = contentParts(out[0]!)[0]!;
    expect(part.approval).toEqual({
      id: "r2",
      prompt: "Deploy where?",
      display: "select",
      dismissible: true,
      options: [
        { id: "0", kind: "_0", label: "staging" },
        { id: "1", kind: "_1", label: "production" },
      ],
    });
    expect(part.interrupt).toBeUndefined();
    expect(out[0]!.status).toEqual({
      type: "requires-action",
      reason: "interrupt",
    });
  });

  it("projects tool-associated input and editor requests as text questions", () => {
    const requests: PiHostUiRequest[] = [
      { id: "r3", kind: "input", title: "Name?", toolCallId: "tc1" },
      {
        id: "r4",
        kind: "editor",
        title: "Edit the plan",
        prefill: "step one",
        toolCallId: "tc2",
      },
    ];
    const out = projectPiThreadMessages(
      input(
        [assistant([toolCall("tc1", "ask", {}), toolCall("tc2", "plan", {})])],
        { hostUiRequests: requests },
      ),
    );
    const [inputPart, editorPart] = contentParts(out[0]!);
    expect(inputPart!.approval).toEqual({
      id: "r3",
      prompt: "Name?",
      display: "text",
      dismissible: true,
    });
    expect(editorPart!.approval).toEqual({
      id: "r4",
      prompt: "Edit the plan",
      display: "text",
      dismissible: true,
    });
    expect(out[0]!.status).toEqual({
      type: "requires-action",
      reason: "interrupt",
    });
  });

  it("leaves a sibling tool call that has not started without an answer to give", () => {
    const request: PiHostUiRequest = {
      id: "r2",
      kind: "select",
      title: "Deploy where?",
      options: ["staging", "production"],
      toolCallId: "tc1",
    };
    const out = projectPiThreadMessages(
      input(
        [
          assistant([
            toolCall("tc1", "deploy", {}),
            toolCall("tc2", "notify", {}),
          ]),
        ],
        { hostUiRequests: [request], runStatus: "running" },
      ),
    );
    const [gated, sibling] = contentParts(out[0]!);
    expect(gated!.approval).toMatchObject({ id: "r2" });
    expect(sibling!.approval).toBeUndefined();
    expect(sibling!.result).toBeUndefined();
    expect(out[0]!.status).toEqual({
      type: "requires-action",
      reason: "interrupt",
    });
  });

  it.each<PiHostUiRequest>([
    {
      id: "r1",
      kind: "confirm",
      title: "Run?",
      message: "ok?",
      toolCallId: "tc1",
    },
    {
      id: "r2",
      kind: "select",
      title: "Deploy where?",
      options: ["staging", "production"],
      toolCallId: "tc1",
    },
    { id: "r3", kind: "input", title: "Name?", toolCallId: "tc1" },
    { id: "r4", kind: "editor", title: "Edit", toolCallId: "tc1" },
  ])(
    "keeps the $kind request answerable on a tool that already streamed output",
    (request) => {
      const repository = projectPiThreadRepository(
        input([assistant([toolCall("tc1", "bash", {})])], {
          toolExecutions: {
            tc1: {
              toolCallId: "tc1",
              status: "running",
              partialResult: {
                content: [{ type: "text", text: "partial..." }],
              },
            },
          },
          hostUiRequests: [request],
          runStatus: "running",
        }),
      );
      const message = repository.messages[0]!.message;
      const part = message.content[0]!;
      expect(part).toMatchObject({
        type: "tool-call",
        result: "partial...",
        approval: { id: request.id },
      });
      expect(message.status).toEqual({
        type: "requires-action",
        reason: "interrupt",
      });
      expect(toMessagePartStatus(message, 0, part)).toEqual(
        // 改动：bun:test 的 toEqual 形参类型较 vitest 严格，需显式收窄
        message.status as ToolCallMessagePartStatus,
      );
    },
  );

  it("projects the request the side channel leaves to the tool-call when one tool raised two", () => {
    const requests: PiHostUiRequest[] = [
      {
        id: "r7",
        kind: "select",
        title: "Pick one",
        options: [],
        toolCallId: "tc1",
      },
      {
        id: "r8",
        kind: "confirm",
        title: "Run?",
        message: "ok?",
        toolCallId: "tc1",
      },
    ];
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "bash", {})])], {
        hostUiRequests: requests,
      }),
    );
    expect(contentParts(out[0]!)[0]!.approval).toEqual({
      id: "r8",
      prompt: "Run?\nok?",
    });
  });

  it("leaves requests the approval cannot answer off the tool-call", () => {
    const requests = [
      {
        id: "r5",
        kind: "multiselect",
        title: "Pick any",
        toolCallId: "tc1",
      } as unknown as PiHostUiRequest,
      {
        id: "r6",
        kind: "select",
        title: "Pick one",
        options: [],
        toolCallId: "tc2",
      } satisfies PiHostUiRequest,
    ];
    const out = projectPiThreadMessages(
      input(
        [assistant([toolCall("tc1", "pick", {}), toolCall("tc2", "pick", {})])],
        { hostUiRequests: requests },
      ),
    );
    for (const part of contentParts(out[0]!)) {
      expect(part.approval).toBeUndefined();
      expect(part.interrupt).toBeUndefined();
    }
    expect(out[0]!.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("does not attach free-standing host-ui requests to tool-calls", () => {
    const request: PiHostUiRequest = {
      id: "r3",
      kind: "confirm",
      title: "x",
      message: "y",
      // no toolCallId → side channel only
    };
    const out = projectPiThreadMessages(
      input([assistant([toolCall("tc1", "bash", {})])], {
        hostUiRequests: [request],
      }),
    );
    expect(contentParts(out[0]!)[0]!.approval).toBeUndefined();
    expect(out[0]!.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("merges adjacent text blocks into a single text part", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([
          { type: "text", text: "你" },
          { type: "text", text: "好" },
          { type: "text", text: "，世界" },
        ]),
      ]),
    );

    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "text",
      text: "你好，世界",
      parentId: "pi-step-idx:0",
    });
  });

  it("does not merge text parts separated by a tool-call", () => {
    const out = projectPiThreadMessages(
      input([
        assistant([
          { type: "text", text: "先说一句" },
          toolCall("tc1", "bash", {}),
          { type: "text", text: "再说一句" },
        ]),
      ]),
    );

    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", text: "先说一句" });
    expect(parts[1]).toMatchObject({ type: "tool-call", toolCallId: "tc1" });
    expect(parts[2]).toMatchObject({ type: "text", text: "再说一句" });
  });

  // 稳定消息 id（闪没修复）：seq 空间优先、乐观 id 最优先、无 seq 走独立前缀回退
  describe("stable message ids", () => {
    it("projects user id from transcript seq", () => {
      const out = projectPiThreadMessages(
        input([{ role: "user", content: "hello", timestamp: 1, __seq: 5 }]),
      );
      expect(out[0]!.id).toBe("pi-msg:5");
    });

    it("anchors merged assistant id and step parentId on the first assistant seq", () => {
      const out = projectPiThreadMessages(
        input([
          assistant([{ type: "text", text: "answer" }], { __seq: 7 }),
          {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 2,
            __seq: 8,
          } as unknown as PiAgentMessage,
        ]),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe("pi-msg:7");
      expect(contentParts(out[0]!)[0]!.parentId).toBe("pi-step:7");
      expect(out[0]!.metadata?.steps?.[0]?.messageId).toBe("pi-step:7");
    });

    it("keeps optimistic id and prefers it over seq", () => {
      const out = projectPiThreadMessages(
        input([
          {
            role: "user",
            content: "hi",
            timestamp: 1,
            __optimisticId: "pi-optimistic:1",
            __seq: 3,
          },
        ]),
      );
      expect(out[0]!.id).toBe("pi-optimistic:1");
    });

    it("never collides fallback ids with seq ids in the same number range", () => {
      // 落盘 user 行 seq=1 与在飞 assistant（无 seq，下标 1）同号段：
      // 独立前缀保证 pi-msg:1 与 pi-msg-idx:1 不撞。
      const out = projectPiThreadMessages(
        input([
          { role: "user", content: "q", timestamp: 1, __seq: 1 },
          assistant([{ type: "text", text: "streaming" }]),
        ]),
      );
      expect(out).toHaveLength(2);
      expect(out[0]!.id).toBe("pi-msg:1");
      expect(out[1]!.id).toBe("pi-msg-idx:1");
    });
  });
});

// 长度截断续跑哨兵（[[auto-continue]]，sidecar 自动续跑注入）：thread_snapshot
// 直出原生行不过 sidecar 的 UI 投影，投影层必须与 toUiMessage 同口径隐藏——
// 此前漏成用户提问气泡上屏（2026-10-02 气泡泄漏事故回归钉）。
describe("auto-continue 哨兵过滤与最终中止标记", () => {
  const truncatedAssistant = () =>
    assistant([{ type: "thinking", thinking: "整轮输出预算烧在思考上" }], {
      stopReason: "length",
    });
  const sentinel: PiAgentMessage = {
    role: "user",
    content: "[[auto-continue]] 上一条回复因达到输出 token 上限被截断",
    timestamp: 2,
  };

  it("跳过哨兵 user 行且不打断 assistant 合并（刷新=直播同构）", () => {
    const out = projectPiThreadMessages(
      input([
        { role: "user", content: "开始任务", timestamp: 1 },
        truncatedAssistant(),
        sentinel,
        assistant([{ type: "text", text: "接着写" }]),
      ]),
    );
    // user(开始任务) + 合并后的 assistant 组（截断轮→续跑轮）——哨兵不成泡
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe("assistant");
    // 中途截断（后面跟的是哨兵续跑）不标中止
    expect(
      contentParts(out[1]!).some(
        (p) => p.type === "data" && p.name === "truncation-stopped",
      ),
    ).toBe(false);
  });

  it("正文仅包含（而非以哨兵开头）的普通用户行不受影响", () => {
    const out = projectPiThreadMessages(
      input([
        {
          role: "user",
          content: "为什么会有 [[auto-continue]] 这种前缀",
          timestamp: 1,
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([
      { type: "text", text: "为什么会有 [[auto-continue]] 这种前缀" },
    ]);
  });

  it("__truncationStopped 行转成 data-truncation-stopped part", () => {
    const out = projectPiThreadMessages(
      input([
        { role: "user", content: "开始任务", timestamp: 1 },
        {
          ...truncatedAssistant(),
          __truncationStopped: true,
        } as PiAgentMessage,
        { role: "user", content: "换个思路重试", timestamp: 3 },
      ]),
    );
    expect(out[1]!.role).toBe("assistant");
    expect(
      contentParts(out[1]!).some(
        (p) => p.type === "data" && p.name === "truncation-stopped",
      ),
    ).toBe(true);
  });

  it("无标注的普通截断轮不产生中止标记", () => {
    const out = projectPiThreadMessages(input([truncatedAssistant()]));
    expect(
      contentParts(out[0]!).some(
        (p) => p.type === "data" && p.name === "truncation-stopped",
      ),
    ).toBe(false);
  });
});
