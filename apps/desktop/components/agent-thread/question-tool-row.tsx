"use client";

import { ChevronDownIcon, CircleQuestionMark, MessageCircleIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning";

/**
 * Question 工具在消息列表里的已答留痕：默认收起为「已询问 N 个问题」，
 * 展开显示每题与用户的回答（提问当下的交互仍归 composer 上方的卡片，
 * 见 question-card.tsx；回答完成后列表里以本条目留痕，刷新后随历史重建）。
 * 样式与 reasoning 折叠同构（同一套 Collapsible + 展开动画，无左边框）；
 * 输出文本格式由 sidecar question-tools.ts 的 formatAnswersForLLM 定义，
 * 此处按行宽松解析（Q<i>: 标题行开块，选择:/回答:/补充: 前缀剥掉）。
 */

type QaItem = { title: string; answer: string };

function parseAnswered(output: unknown): { cancelled: boolean; items: QaItem[] } {
  if (typeof output !== "string") return { cancelled: false, items: [] };
  const text = output.trim();
  if (!text) return { cancelled: false, items: [] };
  if (text.startsWith("用户取消了这次提问")) return { cancelled: true, items: [] };
  const items: QaItem[] = [];
  let current: QaItem | null = null;
  for (const line of text.split("\n")) {
    const m = /^Q\d+: (.*)$/.exec(line);
    if (m) {
      current = { title: m[1].trim(), answer: "" };
      items.push(current);
      continue;
    }
    if (!current) continue;
    const stripped = line.replace(/^(?:选择|回答|补充):\s*/, "");
    current.answer = current.answer ? `${current.answer}\n${stripped}` : stripped;
  }
  return { cancelled: false, items };
}

export const QuestionToolRow: ToolCallMessagePartComponent = ({
  args,
  result,
  status,
}) => {
  // 提问进行中不渲染（composer 卡片是交互面）；结果未到也不占位
  if (status?.type === "running" || result == null) return null;
  const asked = (args as { questions?: unknown[] } | undefined)?.questions;
  const count = Array.isArray(asked) ? asked.length : 0;
  const { cancelled, items } = parseAnswered(result);
  if (!cancelled && items.length === 0) return null;
  return (
    <ReasoningRoot variant="ghost" data-slot="question-tool-row">
      {/* 触发行与 reasoning-trigger 同款（chevron 随展开旋转） */}
      <CollapsibleTrigger
        className="group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]"
      >
        <CircleQuestionMark className="size-4 shrink-0" />
        <span className="inline-block leading-none">
          已询问 {count || items.length} 个问题
          {cancelled ? "（已取消）" : ""}
        </span>
        <Chevron />
      </CollapsibleTrigger>
      <ReasoningContent>
        <ReasoningText>
          <div className="space-y-3">
            {cancelled ? (
              <p>用户取消了这次提问。</p>
            ) : (
              items.map((it, i) => (
                <div key={i}>
                  <p className="font-medium text-foreground/90">{it.title}</p>
                  <p className="whitespace-pre-wrap">{it.answer || "（空回答）"}</p>
                </div>
              ))
            )}
          </div>
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

/** 与 reasoning-trigger 的 chevron 同款（-rotate-90 收起、展开转正） */
const Chevron = () => (
  <ChevronDownIcon className="aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none -rotate-90 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0" />
);
