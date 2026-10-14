"use client";

/**
 * 【临时验证页，验证后删除】代码高亮（edit/write 行的 diff 框）展开高度验证：
 * 复刻「编辑行展开 → diff 框一瞬间拉高再回落」的现场，供 Playwright 逐帧量
 * 行/面板/滚动框/pierre-diff-host 四个高度。消息用静态 initialMessages 喂，
 * 只做点击展开（不涉及流式）。
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";

const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 只做展开验证，不跑真实对话 */
  },
};

const OLD = [
  "  --glass-rgb:255,255,255;  --glass-brd:rgba(255,255,255,.72);",
  "  --glass-sh:0 24px 54px -32px rgba(6,22,44,.55);",
  "  --inset-glow:rgba(255,255,255,.5);",
].join("\n");

const NEW =
  "  --glass-sh:inset 0 1px 0 rgba(255,255,255,.5),0 24px 54px -32px rgba(6,22,44,.55);";

const BIG = Array.from(
  { length: 300 },
  (_, i) => `  --glass-${i}: rgba(${i % 255}, 255, 255, .${i % 90});`,
).join("\n");

const MESSAGES: readonly ThreadMessageLike[] = [
  {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "把玻璃拟态的阴影改一下" }],
    createdAt: new Date(Date.now() - 60_000),
  },
  {
    id: "a1",
    role: "assistant",
    status: { type: "complete", reason: "stop" },
    content: [
      { type: "text", text: "改一下 index.html 的玻璃层变量。" },
      {
        type: "tool-call",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { file_path: "index.html", old_string: OLD, new_string: NEW },
        argsText: JSON.stringify({ file_path: "index.html" }),
        result: "Edited index.html",
      },
      {
        type: "tool-call",
        toolCallId: "write-1",
        toolName: "write",
        args: { file_path: "theme.css", content: BIG },
        argsText: JSON.stringify({ file_path: "theme.css" }),
        result: "Wrote theme.css",
      },
      { type: "text", text: "改完了。" },
    ],
  },
];

export default function CodeExpandPage() {
  const runtime = useLocalRuntime(noopChatModel, { initialMessages: MESSAGES });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen flex-col">
        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
          >
            <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6">
              <ThreadPrimitive.Messages>
                {({ message }) =>
                  message.role === "assistant" ? (
                    <AssistantMessage />
                  ) : (
                    <div className="text-muted-foreground text-sm">把玻璃拟态的阴影改一下</div>
                  )
                }
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
