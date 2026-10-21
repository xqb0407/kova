"use client";

/**
 * 消息尾部产物清单的渲染 harness（对齐 dev-preview 其它页：URL 直达，不接桌面桥）：
 * 5 个产物（超阈值→默认折起）/ 3 个 / 2 个 / 1 个（单卡）四种用例，
 * 页面把折叠头、清单、行高的实测值写进 <pre data-slot="diag">，供无头浏览器抓取。
 * workspace 用内存态钉一个，让 html 产物同时出现「代码」与「浏览器预览」两个出口
 * （否则 usePanelCwd 在浏览器里恒空、canPreview 永远 false）。
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/artifacts
 * 注意：IAB 面板不在前台时 requestAnimationFrame 被节流，高度动画量不到，
 * 只看 aria-expanded / 挂载与否这些非动画事实。
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";
import { UserMessage } from "@/components/agent-thread/user-message";
import { TurnSlot } from "@/components/agent-thread/turn-summary";
import { setWorkspace } from "@/lib/workspace/workspace-store";

const WS = "/Users/dev/project";

const text = (t: string) => ({ type: "text" as const, text: t });
const write = (id: string, path: string, content: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "write",
  args: { file_path: `${WS}/${path}`, content },
  argsText: JSON.stringify({ file_path: `${WS}/${path}`, content }),
  result: `Wrote ${content.length} bytes`,
});
const edit = (id: string, path: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "edit",
  args: { file_path: `${WS}/${path}`, old_string: "a", new_string: "b" },
  argsText: JSON.stringify({ file_path: `${WS}/${path}` }),
  result: "Edited 1 line",
});
const task = (id: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "Task",
  args: { agent: "Explore", description: "整理调研笔记" },
  argsText: JSON.stringify({ agent: "Explore" }),
  result: "Delegation deadbeef started",
});

/** 让大小接近截图里的量级：3.9 KB / 1.0 KB / 3.3 KB / 3.7 KB */
const kb = (n: number) => "x".repeat(Math.round(n * 1024));

const MESSAGES: readonly ThreadMessageLike[] = [
  // 轮 1：5 个产物（超过默认展开阈值 3）
  {
    id: "u1",
    role: "user",
    content: [text("把这几个探针的结论整理成报告")],
    createdAt: new Date(Date.now() - 60_000),
  },
  {
    id: "a1",
    role: "assistant",
    content: [
      text("前两次联机探针 FAIL 是探针自己的 bug，改成扫描历史帧缓冲后通过。"),
      write("w1", "README.md", kb(3.9)),
      write("w2", "probe.html", kb(1)),
      write("w3", "probe-defect.html", kb(3.3)),
      write("w4", "probe-net.html", kb(3.7)),
      write("w5", "docs/report/turn-summary.md", kb(12.4)),
      text("报告写完了，四个页面加一份说明。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 2：3 个产物（默认铺开）
  {
    id: "u2",
    role: "user",
    content: [text("再补三张对照页")],
    createdAt: new Date(Date.now() - 30_000),
  },
  {
    id: "a2",
    role: "assistant",
    content: [
      write("w6", "a.html", kb(2)),
      write("w7", "b.html", kb(2.5)),
      write("w8", "c.html", kb(2.2)),
      text("三张都在。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 3：2 个产物
  {
    id: "u3",
    role: "user",
    content: [text("改成两页")],
    createdAt: new Date(Date.now() - 10_000),
  },
  {
    id: "a3",
    role: "assistant",
    content: [
      write("w9", "index.html", kb(4.1)),
      write("w10", "slides/deck.md", kb(1.8)),
      text("合成两页。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 4：单个产物（保持单卡形态）
  {
    id: "u4",
    role: "user",
    content: [text("只出一份说明")],
    createdAt: new Date(Date.now() - 5_000),
  },
  {
    id: "a4",
    role: "assistant",
    content: [write("w11", "README.md", kb(3.9)), text("一份就够。")],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 5：edit-only（deck/表格逐页续写的主路径——旧实现完全漏掉）
  {
    id: "u5",
    role: "user",
    content: [text("继续完善 roadmap，把第三页补上")],
    createdAt: new Date(Date.now() - 4_000),
  },
  {
    id: "a5",
    role: "assistant",
    content: [
      edit("e1", "roadmap-q3.deck.canvas.json"),
      text("第三页补好了。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 6：子代理写文件（Task 内 write 不进父转录）
  {
    id: "u6",
    role: "user",
    content: [text("让子代理整理调研笔记")],
    createdAt: new Date(Date.now() - 3_000),
  },
  {
    id: "a6",
    role: "assistant",
    content: [
      task("t1"),
      text("子代理把笔记写好了。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
  // 轮 7：纯讨论旧文件，本轮没有任何工具调用——不能误报出卡
  {
    id: "u7",
    role: "user",
    content: [text("README.md 里写了什么？")],
    createdAt: new Date(Date.now() - 2_000),
  },
  {
    id: "a7",
    role: "assistant",
    content: [text("README.md 是仓库说明文件。")],
    status: { type: "complete", reason: "stop" },
  },
];

const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 验证页不跑真实对话 */
  },
};

/** 挂载后测量真实布局，把结果写进 DOM 供无头浏览器抓取 */
function Diagnostics() {
  const [report, setReport] = useState("测量中…");
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        const lines: string[] = [];
        const folds = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="aui_artifact-fold"]'),
        );
        lines.push(`折叠组=${folds.length} 单卡=${document.querySelectorAll('[data-slot="aui_artifact-card"]').length}`);
        for (const fold of folds) {
          const trigger = fold.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
          const panel = fold.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
          const rows = fold.querySelectorAll<HTMLElement>('[data-slot="aui_artifact-row-inline"]');
          const h = (el: HTMLElement | null) =>
            el ? Math.round(el.getBoundingClientRect().height) : -1;
          lines.push(
            `  head="${trigger?.textContent?.trim()}" aria=${trigger?.getAttribute("aria-expanded")} headH=${h(trigger)} panelH=${h(panel)} rows=${rows.length} rowH=${h(rows[0] as HTMLElement | null)} foldH=${h(fold)}`,
          );
        }
        // 轮 5-7 的验收事实：edit-only / 子代理出卡、纯讨论不出卡。
        // 走派生层直接算（浏览器无 Host stat → write/edit/task 候选保留），
        // 比从 DOM 反推可靠：不出卡的场景本来就没有 DOM 节点。
        void (async () => {
          const { collectTurnArtifactCandidates, finalizeArtifactCandidates } =
            await import("@/lib/panels/artifacts");
          const { clearArtifactStatCache } = await import(
            "@/lib/panels/artifact-stats"
          );
          clearArtifactStatCache();
          const turn = (index: number) =>
            MESSAGES.filter(
              (m) => m.role === "assistant",
            )[index]?.content ?? [];
          const label = (name: string, parts: unknown) => {
            const candidates = collectTurnArtifactCandidates({
              parts: parts as never,
              cwd: WS,
              turnStartMs: Date.now(),
              subagentPaths: new Map([["t1", [`${WS}/notes.md`]]]),
              includeTextReferences: true,
            });
            const finalized = finalizeArtifactCandidates(candidates, null, {
              turnStartMs: Date.now(),
            });
            lines.push(
              `${name}: 候选=${candidates.length} 渲染=${finalized.length} [${finalized.map((a) => a.base).join(", ")}]`,
            );
          };
          label("轮5 edit-only", turn(4));
          label("轮6 子代理", turn(5));
          label("轮7 纯讨论", turn(6));
          setReport(lines.join("\n"));
        })();
      }, 900),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <pre
      data-slot="diag"
      className="bg-muted m-2 shrink-0 rounded p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {report}
    </pre>
  );
}

export default function ArtifactsPreviewPage() {
  const [messages] = useState(() => MESSAGES);
  const runtime = useLocalRuntime(noopChatModel, { initialMessages: messages });

  // 固定一个工作区（非桌面端下只改内存态）：html 产物才会出现「浏览器预览」出口
  useEffect(() => {
    setWorkspace(WS, "user");
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen flex-col">
        <div className="text-muted-foreground px-3 py-1 text-xs">
          artifact fold harness
        </div>
        <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            turnAnchor="top"
            className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
          >
            <div className="mb-14 flex flex-col gap-y-6">
              <ThreadPrimitive.Messages>
                {({ message }) => (
                  <TurnSlot
                    messageId={String(message.id)}
                    isEditing={!!message.composer.isEditing}
                  >
                    {message.role === "user" ? <UserMessage /> : <AssistantMessage />}
                  </TurnSlot>
                )}
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
        <Diagnostics />
      </div>
    </AssistantRuntimeProvider>
  );
}
