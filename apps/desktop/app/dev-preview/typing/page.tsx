"use client";

/**
 * 【临时测量页，测完可删】输入框打字性能定位：
 * 用真实 Composer + 真实消息列表（TurnSlot / UserMessage / AssistantMessage），
 * 把"每次击键"的两段成本分别量出来：
 *   - t_sync：aui.composer.setText 内部同步耗时（store 通知 + 全应用选择器重算）
 *   - 真实按键（headless 键盘事件）期间的帧间隔，看用户实际感知的顿挫
 * 对比档位由 query 控制：
 *   ?turns=40&perTurn=4   消息列表规模（0 = 不挂消息列表，只有 composer）
 * 结果由 playwright 从 window.__bench 读，页面本身也把最近一次结果写进 <pre data-slot="bench">。
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAui,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";
import { UserMessage } from "@/components/agent-thread/user-message";
import { TurnSlot, TurnTimingRecorder } from "@/components/agent-thread/turn-summary";
import { Composer } from "@/components/agent-thread/composer";
import { CheckpointTail } from "@/components/agent-thread/checkpoint-card";

const textPart = (t: string) => ({ type: "text" as const, text: t });
const toolPart = (id: string, name: string, args: Record<string, string>) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: name,
  args,
  argsText: JSON.stringify(args),
  result: "ok",
});

/** 一段够真实的轮：user 提问 + perTurn 条 assistant（正文/工具/思考交错） */
function buildMessages(turns: number, perTurn: number): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];
  const started = Date.now() - turns * 60_000;
  for (let t = 0; t < turns; t++) {
    out.push({
      id: `u${t}`,
      role: "user",
      content: [textPart(`第 ${t + 1} 轮：帮我看看这个模块，顺便把测试补上。`)],
      createdAt: new Date(started + t * 60_000),
    });
    for (let m = 0; m < perTurn; m++) {
      const isLast = m === perTurn - 1;
      out.push({
        id: `a${t}-${m}`,
        role: "assistant",
        content: [
          ...(m === 0
            ? [{ type: "reasoning" as const, text: "先梳理一下调用链，再决定从哪下手。" }]
            : []),
          textPart(`第 ${t + 1} 轮第 ${m + 1} 步：已经读完相关文件，正在调整实现。`),
          toolPart(`t${t}-${m}`, m % 2 === 0 ? "read" : "edit", {
            file_path: `/src/module-${t}-${m}.ts`,
          }),
          ...(isLast ? [textPart("## 结论\n\n改动完成，测试通过。")] : []),
        ],
        status: { type: "complete", reason: "stop" },
        metadata: isLast
          ? {
              timing: {
                streamStartTime: started + t * 60_000 + 1_000,
                totalStreamTime: 8_000,
                totalChunks: 12,
                toolCallCount: perTurn,
              },
            }
          : undefined,
      });
    }
  }
  return out;
}

const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 测量页不跑真实对话 */
  },
};

/** 持续流式（?stream=1）：每 80ms 吐一段正文，模拟"回复进行中"时打字 */
const endlessStreamModel: ChatModelAdapter = {
  async *run() {
    let acc = "";
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 80));
      acc += `第 ${i} 段流式正文，用来把主线程占住。`;
      yield {
        content: [
          { type: "reasoning" as const, text: `思考：${i}` },
          { type: "text" as const, text: acc },
        ],
      };
    }
  },
};

/** 启动一次跑批（流式场景用）：与真实发送同路径（append + startRun） */
function StreamDriver() {
  const aui = useAui();
  useEffect(() => {
    const timer = setTimeout(() => {
      void aui.thread.append({
        role: "user",
        content: [{ type: "text", text: "跑一轮长回复" }],
        parentId: null,
        sourceId: null,
        runConfig: undefined,
        startRun: true,
      } as never);
    }, 300);
    return () => clearTimeout(timer);
  }, [aui]);
  return null;
}

type FrameStats = {
  n: number;
  p50: number;
  p95: number;
  max: number;
};

type BenchApi = {
  mountedMessages: () => number;
  textLength: () => number;
  /** setText 的同步阻塞时间（ms）：store 通知 + 全部订阅者选择器重算 */
  setTextSync: (rounds: number) => { median: number; p95: number; max: number };
  /** 帧间隔采样：begin() 后开始记录 rAF 间隔，end() 返回统计 */
  beginFrames: () => void;
  endFrames: () => FrameStats;
  /** 真实按键路径（键盘事件 → CM → setText）的端到端耗时采样 */
  beginKeys: () => void;
  endKeys: () => FrameStats;
  /** 程序化写一次草稿（等价于一次击键的 store 更新） */
  pokeText: (i: number) => void;
  /** CodeMirror 文档长度（验证按键真的进了编辑器） */
  cmDocLength: () => number;
  /** 线程是否在跑（流式场景校验） */
  isRunning: () => boolean;
};

declare global {
  interface Window {
    __bench?: BenchApi;
  }
}

const stats = (values: number[]): FrameStats => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0,
  };
};

function BenchBridge() {
  const aui = useAui();
  useEffect(() => {
    let frames: number[] = [];
    let last = 0;
    let raf = 0;
    const tick = (t: number) => {
      if (last) frames.push(t - last);
      last = t;
      raf = requestAnimationFrame(tick);
    };
    const api: BenchApi = {
      mountedMessages: () => document.querySelectorAll("[data-message-id]").length,
      textLength: () => aui.composer.getState().text.length,
      setTextSync: (rounds) => {
        const samples: number[] = [];
        for (let i = 0; i < rounds; i++) {
          const next = "x".repeat((i % 20) + 1);
          const t0 = performance.now();
          aui.composer.setText(next);
          samples.push(performance.now() - t0);
        }
        aui.composer.setText("");
        return {
          median: stats(samples).p50,
          p95: stats(samples).p95,
          max: stats(samples).max,
        };
      },
      beginFrames: () => {
        frames = [];
        last = 0;
        raf = requestAnimationFrame(tick);
      },
      endFrames: () => {
        cancelAnimationFrame(raf);
        return stats(frames);
      },
      pokeText: (i) => {
        aui.composer.setText("测量草稿 " + i);
      },
      cmDocLength: () =>
        document.querySelector(".cm-content")?.textContent?.length ?? -1,
      isRunning: () => aui.thread.getState().isRunning,
      beginKeys: () => {
        frames = [];
        last = 0;
        raf = requestAnimationFrame(tick);
      },
      endKeys: () => {
        cancelAnimationFrame(raf);
        return stats(frames);
      },
    };
    window.__bench = api;
    (window as unknown as { __benchAui?: unknown }).__benchAui = aui;
    return () => {
      delete window.__bench;
    };
  }, [aui]);
  return null;
}

export default function TypingBenchPage() {
  const [params] = useState(() => {
    const q =
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search);
    return {
      turns: Number(q.get("turns") ?? 40),
      perTurn: Number(q.get("perTurn") ?? 4),
      withThread: q.get("turns") !== "0",
      stream: q.get("stream") === "1",
    };
  });
  const [messages] = useState(() =>
    params.withThread ? buildMessages(params.turns, params.perTurn) : [],
  );
  const runtime = useLocalRuntime(params.stream ? endlessStreamModel : noopChatModel, {
    initialMessages: messages,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <BenchBridge />
      {params.stream && <StreamDriver />}
      <div className="flex h-screen flex-col">
        <div className="text-muted-foreground px-3 py-1 text-xs">
          typing bench · turns={params.turns} perTurn={params.perTurn}
        </div>
        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
          >
            <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const inner =
                    message.role === "user" ? <UserMessage /> : <AssistantMessage />;
                  return (
                    <TurnSlot messageId={String(message.id)} isEditing={false}>
                      {inner}
                    </TurnSlot>
                  );
                }}
              </ThreadPrimitive.Messages>
              <CheckpointTail />
              <TurnTimingRecorder />
            </div>
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto z-10 mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible pb-1">
              <Composer />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
