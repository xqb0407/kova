"use client";

/**
 * 【临时验证页，验证后删除】过程块自动开合（运行中展开 / 结束收起）验证：
 * 思考与终端调用在过程进行时自动摊开、结束后自动收回；用户手动开合过后不再被
 * 自动跟随。流式适配器按阶段产出，每阶段停在 window.__step() 上等 playwright
 * 放行，便于逐步抓 DOM 状态与截图：
 *   thinking-streaming：思考流式中（思考块应展开）
 *   terminal-running  ：思考结束、终端运行中（思考块应收起；终端组 + 终端行展开）
 *   terminal-done     ：终端完成（终端组 + 终端行收回）
 *   answer-done       ：回答收尾（全部收起）
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAui,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter } from "@assistant-ui/react";
import { useEffect } from "react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";

declare global {
  interface Window {
    __step?: () => void;
    __phase?: string;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let release: (() => void) | null = null;
if (typeof window !== "undefined") {
  window.__step = () => {
    const r = release;
    release = null;
    r?.();
  };
}

const gate = (phase: string) => {
  window.__phase = phase;
  return new Promise<void>((r) => {
    release = r;
  });
};

const bashPart = (
  toolCallId: string,
  command: string,
  result: string,
  preliminary: boolean,
) => ({
  type: "tool-call" as const,
  toolCallId,
  toolName: "bash",
  args: { command },
  argsText: JSON.stringify({ command }),
  result,
  ...(preliminary ? { isPreliminary: true } : {}),
});

const FINAL_OUT = "全部 12 个用例通过\n";

const stagedModel: ChatModelAdapter = {
  async *run() {
    // 阶段：思考流式
    let think = "";
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      think += `先核对待改文件与现状（第 ${i + 1} 轮）。`;
      yield { content: [{ type: "reasoning" as const, text: think }] };
    }
    await gate("thinking-streaming");

    // 阶段：终端运行中——两条连续调用成组，第一条已完成、第二条带部分输出在跑
    // （输出刻意超过视口高度：验证实时视口底部吸附跟到最新一行）
    let out = "";
    for (let i = 0; i < 20; i++) {
      await sleep(90);
      out += `line ${i + 1}: 用例通过（这一段刻意写长一点，撑出滚动条）\n`;
      yield {
        content: [
          { type: "reasoning" as const, text: think },
          bashPart("bash-1", "git status", "工作区干净\n", false),
          bashPart("bash-2", "bun test", out, true),
        ],
      };
    }
    await gate("terminal-running");

    // 阶段：终端完成
    yield {
      content: [
        { type: "reasoning" as const, text: think },
        bashPart("bash-1", "git status", "工作区干净\n", false),
        bashPart("bash-2", "bun test", FINAL_OUT, false),
      ],
    };
    await gate("terminal-done");

    // 阶段：回答正文
    let ans = "";
    for (let i = 0; i < 8; i++) {
      await sleep(80);
      ans += `结论第 ${i + 1} 句。`;
      yield {
        content: [
          { type: "reasoning" as const, text: think },
          bashPart("bash-1", "git status", "工作区干净\n", false),
          bashPart("bash-2", "bun test", FINAL_OUT, false),
          { type: "text" as const, text: ans },
        ],
      };
    }
    window.__phase = "answer-done";
  },
};

/** 挂载后自动发一条消息启动这一轮（同 turns 页的 LiveDemoDriver） */
function Driver() {
  const aui = useAui();
  useEffect(() => {
    const t = setTimeout(() => {
      void aui.thread.append({
        role: "user",
        content: [{ type: "text", text: "跑一下测试" }],
        parentId: null,
        sourceId: null,
        runConfig: undefined,
        startRun: true,
      } as never);
    }, 300);
    return () => clearTimeout(t);
  }, [aui]);
  return null;
}

export default function StreamingAccordionPage() {
  const runtime = useLocalRuntime(stagedModel);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen flex-col">
        <Driver />
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
                    <div className="text-muted-foreground text-sm">
                      跑一下测试
                    </div>
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
