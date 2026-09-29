/**
 * Toolbar：底部居中悬浮工具栏（Figma 布局）。
 * 移动/画板/形状▾(九种)/直线/箭头/文本/抓手 + 撤销重做。图标 + 悬浮全称提示。
 */
import type { FC } from "react";
import {
  ArrowUpRight,
  Circle,
  Diamond,
  Frame,
  Hand,
  Hexagon,
  Minus,
  MousePointer2,
  PenTool,
  Pentagon,
  Redo2,
  Shapes,
  Square,
  Star,
  Triangle,
  Type,
  Undo2,
} from "lucide-react";
import type { NodeType } from "../doc";
import type { DesignStore, Tool } from "../state";
import { IconBtn, Menu, MenuItem } from "./ui";

const TOOLS: { id: Tool; icon: FC<{ size?: number }>; name: string; key: string }[] = [
  { id: "select", icon: MousePointer2, name: "移动", key: "V" },
  { id: "frame", icon: Frame, name: "画板", key: "F" },
];

const SHAPES: { id: NodeType; icon: FC<{ size?: number }>; name: string; key?: string }[] = [
  { id: "rect", icon: Square, name: "矩形", key: "R" },
  { id: "ellipse", icon: Circle, name: "椭圆", key: "O" },
  { id: "triangle", icon: Triangle, name: "三角形" },
  { id: "diamond", icon: Diamond, name: "菱形" },
  { id: "pentagon", icon: Pentagon, name: "五边形" },
  { id: "hexagon", icon: Hexagon, name: "六边形" },
  { id: "star", icon: Star, name: "星形" },
];

const REST: { id: Tool; icon: FC<{ size?: number }>; name: string; key: string }[] = [
  { id: "line", icon: Minus, name: "直线", key: "L" },
  { id: "arrow", icon: ArrowUpRight, name: "箭头", key: "A" },
  { id: "text", icon: Type, name: "文本", key: "T" },
  { id: "icon", icon: Shapes, name: "图标（拖出后右侧选图案）", key: "I" },
  { id: "hand", icon: Hand, name: "抓手（或按住空格）", key: "H" },
];

export const Toolbar: FC<{ store: DesignStore }> = ({ store }) => {
  const { tool, setTool, undo, redo, canUndo, canRedo } = store;
  const shapeActive = SHAPES.some((s) => s.id === tool);
  const Sep = () => <div className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />;
  return (
    <div
      className="pointer-events-auto flex items-center gap-0.5 rounded-full p-1"
      style={{ background: "var(--background)", boxShadow: "var(--sh-float)" }}
    >
      {TOOLS.map((t) => (
        <IconBtn key={t.id} tip={`${t.name}（${t.key}）`} active={tool === t.id} onClick={() => setTool(t.id)}>
          <t.icon size={16} />
        </IconBtn>
      ))}
      <Menu
        align="start"
        trigger={
          <span className="relative">
            <IconBtn tip="更多形状" active={shapeActive}>
              <Square size={16} />
            </IconBtn>
          </span>
        }
      >
        {SHAPES.map((s) => (
          <MenuItem key={s.id} icon={<s.icon size={13} />} selected={tool === s.id} onClick={() => setTool(s.id)}>
            {s.name}
            {s.key ? `（${s.key}）` : ""}
          </MenuItem>
        ))}
      </Menu>
      {REST.map((t) => (
        <IconBtn key={t.id} tip={`${t.name}（${t.key}）`} active={tool === t.id} onClick={() => setTool(t.id)}>
          <t.icon size={16} />
        </IconBtn>
      ))}
      <IconBtn
        tip="钢笔（点击落直角锚 · 按拖拉曲线 · 点首锚闭合 · Enter 收笔 · Esc 取消）"
        active={tool === "pen"}
        onClick={() => setTool("pen")}
      >
        <PenTool size={16} />
      </IconBtn>
      <Sep />
      <IconBtn tip="撤销（⌘Z）" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </IconBtn>
      <IconBtn tip="重做（⌘⇧Z）" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </IconBtn>
    </div>
  );
};
