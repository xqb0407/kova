"use client";

/**
 * 【临时验证页，验证后删除】消息流渲染 harness：
 * 用真实组件（TurnSlot / UserMessage / AssistantMessage + TurnWorkSummary）
 * 配假消息渲染，页面自己把每条消息的实际布局测量结果写进 <pre data-slot="diag">，
 * 供无头浏览器 --dump-dom 抓出来核对（折叠是否吞消息、屏外跳过有没有把高度打没）。
 * 不依赖 Tauri：运行时用 useLocalRuntime + initialMessages 喂数据。
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";
import { EditComposer, UserMessage } from "@/components/agent-thread/user-message";
import { ManualCompactionTailAfter } from "@/components/agent-thread/compaction-banner";
import { TurnSlot, TurnTimingRecorder } from "@/components/agent-thread/turn-summary";
import { getTurnIndex, packTurnSlot } from "@/lib/panels/message-turns";

const text = (t: string) => ({ type: "text" as const, text: t });
const tool = (id: string, name: string, args: Record<string, string>) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: name,
  args,
  argsText: JSON.stringify(args),
  result: "ok",
});

const started = Date.now() - 8 * 60_000;

const MESSAGES: readonly ThreadMessageLike[] = [
  // 轮 1：用户 + 4 条 assistant（过程会被收起），末条带 timing（应显示「已工作 4 分 8 秒」）
  {
    id: "u1",
    role: "user",
    content: [text("帮我重构这个函数，顺便把测试补上")],
    createdAt: new Date(started),
  },
  {
    id: "a1",
    role: "assistant",
    content: [
      text("我先看一下现状。"),
      tool("t1", "read", { file_path: "/a.ts" }),
      tool("t2", "read", { file_path: "/b.ts" }),
      text("读完了两个文件，接下来动手改。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮中带压缩分隔线：折叠时也要保留可见（keepsVisible 规则）,
  {
    id: "a2",
    role: "assistant",
    content: [
      { type: "data", name: "compaction", data: { phase: "complete", summary: "早期上下文已压缩" } },
      text("上下文压缩过了，继续。"),
      tool("t3", "edit", { file_path: "/a.ts" }),
    ],
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "a3",
    role: "assistant",
    content: [text("改完了 a.ts，跑一下测试。"), tool("t4", "bash", { command: "bun test" })],
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "a4",
    role: "assistant",
    content: [tool("t7", "bash", { command: "bun test" }), text("## 结论\n\n重构完成，测试全绿。")],
    status: { type: "complete", reason: "stop" },
    metadata: {
      timing: {
        streamStartTime: started + 1_000,
        totalStreamTime: 248_000,
        totalChunks: 12,
        toolCallCount: 4,
      },
    },
  },
  // 轮 2：用户 + 2 条 assistant,
  {
    id: "u2",
    role: "user",
    content: [text("那再帮我看看性能问题")],
    createdAt: new Date(started + 300_000),
  },
  {
    id: "a5",
    role: "assistant",
    content: [text("先 profile 一下。"), tool("t5", "bash", { command: "bun run profile" })],
    status: { type: "complete", reason: "stop" },
  },
  {
    id: "a6",
    role: "assistant",
    content: [text("热点在反序列化，建议加缓存。")],
    status: { type: "complete", reason: "stop" },
    metadata: {
      timing: {
        streamStartTime: started + 420_000,
        totalStreamTime: 90_000,
        totalChunks: 5,
        toolCallCount: 1,
      },
    },
  },
  // 轮 3（最新轮）：不收起，完整展示,
  {
    id: "u3",
    role: "user",
    content: [text("好，那就加缓存吧")],
    createdAt: new Date(started + 600_000),
  },
  {
    id: "a7",
    role: "assistant",
    content: [text("这就动手。"), tool("t6", "edit", { file_path: "/c.ts" })],
    status: { type: "complete", reason: "stop" },
  },
  // 第 4 轮：用户手动中断——过程应自动收起，只留回答与「已停止」标记
  {
    id: "u4",
    role: "user",
    content: [text("先停一下，我想看看现在到哪了")],
    createdAt: new Date(started + 700_000),
  },
  {
    id: "a8",
    role: "assistant",
    content: [
      text("我先扫了一遍依赖图。"),
      tool("t8", "bash", { command: "bun run deps" }),
      tool("t9", "bash", { command: "bun run scan" }),
      text("正在跑扫描…"),
      { type: "data", name: "stopped", data: {} },
    ],
    status: { type: "incomplete", reason: "cancelled" },
    metadata: {
      timing: {
        streamStartTime: started + 700_000,
        totalStreamTime: 62_000,
        totalChunks: 7,
        toolCallCount: 2,
      },
    },
  },
  // 第 5 轮（最新轮）：聊天型一轮——user + [reasoning, text]，过程只有思考块，
  // 且没有 timing（对齐定时任务会话：两行同批落盘，耗时不显示）
  {
    id: "u5",
    role: "user",
    content: [text("你好啊。")],
    createdAt: new Date(started + 800_000),
  },
  {
    id: "a9",
    role: "assistant",
    content: [
      { type: "reasoning", text: "想一下怎么打招呼比较自然" },
      text("喵～你好呀！有什么我可以帮你的吗？"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 第 4 轮：用户手动中断——过程应自动收起，只留回答与「已停止」标记,
];


const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 验证页默认不跑真实对话 */
  },
};

/** 慢速流式：?livedemo=1 时用它真跑一轮，再手动 cancel，验证「手动 stop」的耗时。
 *  带 reasoning part（= 有过程可收）——这样停止后摘要行会渲染出来，能看到文案。 */
const liveChatModel: ChatModelAdapter = {
  async *run() {
    let acc = "";
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 120));
      acc += `片段${i} `;
      yield {
        content: [
          { type: "reasoning" as const, text: `思考中：${acc}` },
          { type: "text" as const, text: acc },
        ],
      };
    }
  },
};

/** 挂载后测量真实布局，把结果写进 DOM 供无头浏览器抓取：
 *  默认（上一轮收起）→ 点击摘要行展开 → 动画中途 / 完成各采一次。 */
function Diagnostics() {
  const [report, setReport] = useState("测量中…");
  useEffect(() => {
    // 默认只测一次静态快照；?autodiag=1 才跑"点击展开/收起"的编排
    // （它会写显式覆盖，会污染"自然结束是否收起"的验证）
    const autodiag =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("autodiag") === "1";
    if (!autodiag) {
      const t = setTimeout(() => setReport(measure("快照")), 1200);
      return () => clearTimeout(t);
    }
    const measure = (tag: string) => {
      const lines: string[] = [`—— ${tag} ——`];
      const viewport = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      lines.push(`viewport.scrollHeight=${viewport?.scrollHeight ?? -1}`);
      const ids = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
        .map((el) => `${el.dataset.messageId}:${el.offsetHeight}`)
        .join(" ");
      lines.push(
        `消息根=${document.querySelectorAll("[data-message-id]").length} 气泡=${document.querySelectorAll('[data-slot="aui_user-message-root"]').length} 摘要行=${document.querySelectorAll('[data-slot="aui_turn-summary"]').length}`,
      );
      lines.push(`挂载明细: ${ids}`);
      const panels = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="collapsible-content"]'),
      );
      lines.push(`过程面板=${panels.length}`);
      for (const panel of panels) {
        const cs = getComputedStyle(panel);
        const anims = panel
          .getAnimations()
          .map(
            (a) =>
              `${(a as CSSAnimation).animationName}:${a.playState}:${Math.round(Number(a.currentTime ?? -1))}ms`,
          )
          .join(", ");
        lines.push(
          `  panel h=${Math.round(panel.getBoundingClientRect().height)} open=${panel.hasAttribute("data-open")} closed=${panel.hasAttribute("data-closed")} cssVar=${cs.getPropertyValue("--collapsible-panel-height") || "无"} anims=[${anims}]`,
        );
      }
      // 轮 1：摘要行 → 轮末回答（轮中有 keepsVisible 的压缩分隔线，本来就占位）
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="aui_turn-summary"]'));
      const answer1 = document.querySelector<HTMLElement>('[data-message-id="a4"]');
      if (rows[0] && answer1) {
        lines.push(
          `轮1 摘要行→回答 间距=${Math.round(answer1.getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom)}px`,
        );
      }
      const chevron = rows[0]?.querySelector("svg");
      if (chevron) {
        lines.push(
          `chevron transform=${getComputedStyle(chevron).transform} transition=${getComputedStyle(chevron).transitionDuration}`,
        );
      }
      return lines.join("\n");
    };

    const parts: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clickFirstRow = () => {
      document
        .querySelector<HTMLElement>('[data-slot="aui_turn-summary"] button')
        ?.click();
    };
    timers.push(
      setTimeout(() => {
        parts.push(measure("① 默认（非最新轮收起）"));
        clickFirstRow();
        timers.push(
          setTimeout(() => {
            parts.push(measure("② 点击后 80ms（动画进行中）"));
            timers.push(
              setTimeout(() => {
                parts.push(measure("③ 展开完成"));
                clickFirstRow();
                timers.push(
                  setTimeout(() => {
                    parts.push(measure("④ 收起中 80ms"));
                    document
                      .querySelectorAll<HTMLElement>('[data-slot="collapsible-content"]')
                      .forEach((panel) => panel.getAnimations().forEach((a) => a.finish()));
                    timers.push(
                      setTimeout(() => {
                        parts.push(measure("⑤ 动画 finish() 后（卸载链路）"));
                        setReport(parts.join("\n\n"));
                      }, 200),
                    );
                  }, 80),
                );
              }, 400),
            );
          }, 80),
        );
      }, 1200),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <pre
      data-slot="diag"
      className="bg-muted m-2 rounded p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {report}
    </pre>
  );
}

/** ?livedemo=1：真跑一轮（慢速流式）再手动 cancel，验证「手动 stop」的耗时显示。
 *  必须挂在 AssistantRuntimeProvider 内（useAui 需要 AuiProvider）。 */
function LiveDemoDriver({ enabled }: { enabled: boolean }) {
  const aui = useAui();
  useEffect(() => {
    if (!enabled) return;
    const send = setTimeout(() => {
      void aui.thread.append({
        role: "user",
        content: [{ type: "text", text: "跑一轮然后我手动停掉" }],
        parentId: null,
        sourceId: null,
        runConfig: undefined,
        startRun: true,
      } as never);
    }, 400);
    // livedemo=2：不中断，让它自然跑完——验证"正常结束"路径的收起
    const noCancel =
      new URLSearchParams(window.location.search).get("livedemo") === "2";
    const stop = setTimeout(() => {
      if (!noCancel) aui.thread.cancelRun();
    }, 2000);
    return () => {
      clearTimeout(send);
      clearTimeout(stop);
    };
  }, [enabled, aui]);
  return null;
}

export default function TurnsPreviewPage() {
  // ?running=1：把最新轮的末条回答标记成流式中——验证"进行中的轮不显示摘要行、
  // 过程保持展开"（不能只看线程级 isRunning，它有空窗）
  const [runningDemo] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("running") === "1",
  );
  const [messages] = useState(() => {
    if (!runningDemo) return MESSAGES;
    // 最新轮造两条：前一条已结算（应被收起），末条流式中（应可见）
    const extra = {
      id: "a9-step1",
      role: "assistant" as const,
      content: [
        { type: "reasoning" as const, text: "先确认一下现场" },
        { type: "text" as const, text: "我先把现场确认一遍。" },
      ],
      status: { type: "complete", reason: "stop" } as const,
    };
    return MESSAGES.flatMap((m) =>
      m.id === "a9"
        ? [extra, { ...m, status: { type: "running" } as const }]
        : [m],
    );
  });
  const [liveDemo] = useState(
    () =>
      typeof window !== "undefined" &&
      ["1", "2"].includes(
        new URLSearchParams(window.location.search).get("livedemo") ?? "",
      ),
  );
  const runtime = useLocalRuntime(liveDemo ? liveChatModel : noopChatModel, {
    initialMessages: liveDemo ? [] : messages,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen flex-col">
        <LiveDemoDriver enabled={liveDemo} />
        <div className="text-muted-foreground px-3 py-1 text-xs">
          turns harness · 轮数={getTurnIndex(runtime.thread.getState().messages).turns.length}
        </div>
        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
          >
            <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6">
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const inner = message.composer.isEditing ? (
                    <EditComposer />
                  ) : message.role === "user" ? (
                    <UserMessage />
                  ) : (
                    <AssistantMessage />
                  );
                  return (
                    <ManualCompactionTailAfter messageId={String(message.id)}>
                      <TurnSlot
                        messageId={String(message.id)}
                        isEditing={!!message.composer.isEditing}
                      >
                        {inner}
                      </TurnSlot>
                    </ManualCompactionTailAfter>
                  );
                }}
              </ThreadPrimitive.Messages>
              <TurnTimingRecorder />
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
        <Diagnostics />
      </div>
    </AssistantRuntimeProvider>
  );
}
