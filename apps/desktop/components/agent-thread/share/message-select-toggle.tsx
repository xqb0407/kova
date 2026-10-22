"use client";

/**
 * 消息级勾选框：分享模式下出现在每条消息左侧的独立栏位里（进入选择模式时
 * 由 globals.css 的 body.share-selecting 规则给消息根让出左栏），点它按整轮
 * 选中/取消。选中态只有勾选框本身，不再铺底色（对齐豆包的干净列表）。
 *
 * 必须挂在消息根节点内，并且只在「非 process 变体」渲染：轮末消息会被
 * TurnSlot 拆成 process + answer 两棵子树，两边都挂会出现两个勾选框。
 */
import { useAuiState } from "@assistant-ui/react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleShareMessage, useShareState } from "@/lib/share/share-store";
import type { CSSProperties, FC } from "react";

/** 用户消息根是 grid，父级把所有直接子元素的 grid-column-start 都设成 2；
 *  内联覆写成 auto，勾选框才能贴着行左缘定位 */
const ESCAPE_GRID_PLACEMENT: CSSProperties = { gridColumnStart: "auto" };

export const MessageSelectToggle: FC = () => {
  const share = useShareState();
  const messageId = useAuiState((s) => s.message.id);
  if (share.mode !== "selecting" || !messageId) return null;
  const selected = share.selected.has(messageId);

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={selected ? "取消选择这一轮对话" : "选择这一轮对话"}
      style={ESCAPE_GRID_PLACEMENT}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleShareMessage(messageId);
      }}
      className={cn(
        "absolute top-1 left-2 z-10 flex size-[18px] cursor-pointer items-center justify-center rounded-[6px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-transparent hover:border-primary/50",
      )}
    >
      <CheckIcon className="size-3" strokeWidth={3} />
    </button>
  );
};
