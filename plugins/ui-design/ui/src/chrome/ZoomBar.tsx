/** ZoomBar：左下缩放 pill：− 百分比 + 适配（⌘0）/100%（⌘1） */
import type { FC } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import type { DesignStore } from "../state";
import { IconBtn, Menu, MenuItem } from "./ui";

export const ZoomBar: FC<{ store: DesignStore }> = ({ store }) => {
  const { view, zoomBy, zoomTo, fitView } = store;
  return (
    <div
      className="pointer-events-auto flex items-center gap-0.5 rounded-full p-0.5"
      style={{ background: "var(--background)", boxShadow: "var(--sh-float)" }}
    >
      <IconBtn tip="缩小" size={26} onClick={() => zoomBy(1 / 1.2)}>
        <Minus size={14} />
      </IconBtn>
      <Menu
        align="start"
        trigger={
          <button
            type="button"
            className="h-6 min-w-[52px] rounded px-1 text-[12px] tabular-nums"
            style={{ color: "var(--foreground)" }}
            title="缩放选项"
          >
            {Math.round(view.s * 100)}%
          </button>
        }
      >
        <MenuItem onClick={() => fitView()}>适配内容（⌘0）</MenuItem>
        <MenuItem onClick={() => zoomTo(1)}>实际大小 100%（⌘1）</MenuItem>
        <MenuItem onClick={() => zoomTo(0.5)}>50%</MenuItem>
        <MenuItem onClick={() => zoomTo(2)}>200%</MenuItem>
      </Menu>
      <IconBtn tip="放大" size={26} onClick={() => zoomBy(1.2)}>
        <Plus size={14} />
      </IconBtn>
      <IconBtn tip="适配内容（⌘0）" size={26} onClick={() => fitView()}>
        <Maximize size={13} />
      </IconBtn>
    </div>
  );
};
