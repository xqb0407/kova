"use client";

/**
 * 快速查看浮层的渲染 harness（对齐 dev-preview 其它页：URL 直达，不接桌面桥）：
 * 验证 header 开关按钮显隐（有消息/新对话）、浮层四分区的显隐与折叠开合、
 * 条目点击后面板标签集合的落点（getPanelTabs）与 agent-panel:open 事件计数。
 * todo 快照经 applyTodoChunk 注入、委派绑定经 applyDelegationChunk 注入，
 * workspace 用内存态钉一个让产物候选成立。
 *
 * 跑法：cd apps/desktop && bun run dev →
 *   http://localhost:3000/dev-preview/quick-view            （有消息：按钮在、卡片可开）
 *   http://localhost:3000/dev-preview/quick-view?empty=1    （新对话：按钮隐藏）
 *   http://localhost:3000/dev-preview/quick-view?ask=1      （问答档：Git 分区在 web
 *     端本就因 git_status 不可用而隐藏，无法与编码档区分——该门槛由 tab-registry
 *     同款判定背书，预览页只记录档位注入成功与否）
 * 页面把实测值写进 <pre data-slot="diag">，供无头浏览器抓取。
 */

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import {
  QuickViewCard,
  QuickViewToggleButton,
} from "@/components/agent-thread/quick-view-popover";
import { toggleQuickView, useQuickViewOpen } from "@/lib/quick-view";
import { applyTodoChunk } from "@/lib/pi/pi-todo";
import { applyDelegationChunk } from "@/lib/subagent/subagent-runs";
import { applyPlanningChunk } from "@/lib/pi/pi-session-mode";
import {
  getPanelTabs,
  setCurrentPanelThread,
} from "@/lib/panels/panel-tabs";
import { setWorkspace } from "@/lib/workspace/workspace-store";

const WS = "/Users/dev/project";
const THREAD_ID = "pv-quick-view-thread";

const text = (t: string) => ({ type: "text" as const, text: t });
const write = (id: string, path: string, content: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "write",
  args: { file_path: `${WS}/${path}`, content },
  argsText: JSON.stringify({ file_path: `${WS}/${path}`, content }),
  result: `Wrote ${content.length} bytes`,
});
const task = (id: string, agent: string, description: string, result: string) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName: "Task",
  args: { agent, description },
  argsText: JSON.stringify({ agent, description }),
  result,
});

const kb = (n: number) => "x".repeat(Math.round(n * 1024));

const MESSAGES: readonly ThreadMessageLike[] = [
  {
    id: "u1",
    role: "user",
    content: [text("把调研结论整理成页面，再派个智能体补齐笔记")],
    createdAt: new Date(Date.now() - 60_000),
  },
  {
    id: "a1",
    role: "assistant",
    content: [
      text("页面和说明都写好了，笔记交给子智能体。"),
      write("w1", "index.html", kb(4.1)),
      write("w2", "docs/report.md", kb(12.4)),
      // 有绑定 chunk 的委派（运行中）：行 = Explore · 整理调研笔记 · 转圈计时
      task("task-1", "Explore", "整理调研笔记", "Delegation deadbeef started"),
      // 无绑定、靠结果文本兜底解析的委派（历史重建形态）：行可点开 tab
      task(
        "task-2",
        "general-purpose",
        "归档旧版页面",
        "Delegation cafe5678 started",
      ),
      text("完成。"),
    ],
    status: { type: "complete", reason: "stop" },
  },
];

const EMPTY_MESSAGES: readonly ThreadMessageLike[] = [];

const noopChatModel: ChatModelAdapter = {
  async *run() {
    /* 验证页不跑真实对话 */
  },
};

/** todo 快照：对齐截图 1 的形态（7 条已完成划线 + 1 条进行中 + 2 条待办） */
function seedTodos() {
  applyTodoChunk(THREAD_ID, {
    nextId: 11,
    tasks: [
      ...[1, 2, 3, 4, 5, 6, 7].map((id) => ({
        id,
        subject: `已完成事项 ${id}：确认目标与视觉方向`,
        status: "completed",
      })),
      {
        id: 8,
        subject: "本地预览与打包交付",
        activeForm: "本地预览与打包交付，等待用户确认",
        status: "in_progress",
      },
      { id: 9, subject: "多视口渲染检查（390/768/1440）", status: "pending" },
      { id: 10, subject: "自托管字体收尾", status: "pending" },
    ],
  });
}

/** 挂载后把实测值写进 DOM 供无头浏览器抓取 */
function Diagnostics({ askMode }: { askMode: boolean }) {
  const [report, setReport] = useState("测量中…");
  const open = useQuickViewOpen(THREAD_ID);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const lines: string[] = [];
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="快速查看"]',
      );
      lines.push(
        `开关按钮=${button ? "在" : "无"} aria-pressed=${button?.getAttribute("aria-pressed") ?? "-"}`,
      );
      lines.push(`storeOpen=${open}`);
      const card = document.querySelector('[data-slot="quick-view-card"]');
      lines.push(`浮层=${card ? "在" : "无"}`);
      if (card) {
        const sections = Array.from(
          card.querySelectorAll('[data-slot="collapsible-trigger"]'),
        ).map((el) => {
          const title = el.textContent?.trim() ?? "";
          const content = el
            .closest("[data-slot=collapsible]")
            ?.querySelector('[data-slot="collapsible-content"]');
          const expanded =
            content?.querySelector("ul, p, div") != null ? "展开" : "收起";
          return `${title}(${expanded})`;
        });
        lines.push(`分区=${sections.join(" ") || "无"}`);
        const rows = card.querySelectorAll('li button[type="button"]').length;
        lines.push(`可点行=${rows}`);
      }
      const { tabs, activeId } = getPanelTabs();
      lines.push(
        `面板标签=[${tabs.map((t) => `${t.type}${t.id === activeId ? "*" : ""}`).join(", ")}]`,
      );
      lines.push(
        `面板唤起事件=${window.__qvPanelOpenEvents ?? 0} 问答档注入=${askMode ? "是" : "否"}`,
      );
      setReport(lines.join("\n"));
    }, 400);
    return () => window.clearInterval(timer);
  }, [open, askMode]);
  return (
    <pre
      data-slot="diag"
      className="m-4 max-w-2xl rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
    >
      {report}
    </pre>
  );
}

function Harness({ empty, askMode }: { empty: boolean; askMode: boolean }) {
  const messages = empty ? EMPTY_MESSAGES : MESSAGES;
  const runtime = useLocalRuntime(noopChatModel, { initialMessages: messages });
  useEffect(() => {
    setWorkspace(WS);
    setCurrentPanelThread(THREAD_ID);
    if (!empty) {
      seedTodos();
      // 有绑定 chunk 的委派：store 立条目（默认 running，行转圈计时）
      applyDelegationChunk({
        toolCallId: "task-1",
        delegationId: "deadbeefdeadbeef",
        agentName: "Explore",
        description: "整理调研笔记",
      });
      if (askMode) {
        applyPlanningChunk(THREAD_ID, {
          mode: "ask",
          planning: "inactive",
          approvalLevel: "ask",
        });
      }
    }
    // agent-panel:open 事件计数（条目点击的唤起面板副作用）
    window.__qvPanelOpenEvents = 0;
    const onPanelOpen = () => {
      window.__qvPanelOpenEvents = (window.__qvPanelOpenEvents ?? 0) + 1;
    };
    window.addEventListener("agent-panel:open", onPanelOpen);
    return () => window.removeEventListener("agent-panel:open", onPanelOpen);
  }, [empty, askMode]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="bg-background flex min-h-screen flex-col">
        {/* 模拟 header 按钮簇（只取与本功能相关的一个） */}
        <div className="flex items-center gap-1 border-b p-2">
          <QuickViewToggleButton />
          <span className="text-muted-foreground text-xs">
            ← header 按钮簇（终端/面板开关不在本页）
          </span>
        </div>
        {/* 聊天内容区：浮层挂载点（relative 容器对齐 base 的 chatColumn 内容层） */}
        <div className="relative min-h-[480px] flex-1 overflow-hidden">
          <div className="p-4">
            <button
              type="button"
              data-slot="pv-open"
              onClick={() => toggleQuickView(THREAD_ID)}
              className="bg-muted rounded-lg px-3 py-1.5 text-sm"
            >
              toggle 浮层（等价点开关按钮）
            </button>
          </div>
          <QuickViewCard threadId={THREAD_ID} />
        </div>
        <Diagnostics askMode={askMode} />
      </div>
    </AssistantRuntimeProvider>
  );
}

declare global {
  interface Window {
    __qvPanelOpenEvents?: number;
  }
}

export default function QuickViewPreviewPage() {
  const [params, setParams] = useState<{ empty: boolean; ask: boolean } | null>(
    null,
  );
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    setParams({ empty: search.has("empty"), ask: search.has("ask") });
  }, []);
  if (!params) return null;
  return <Harness empty={params.empty} askMode={params.ask} />;
}
