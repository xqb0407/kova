/**
 * 插入/历史工具组（自 App.tsx 拆出）：deck 横排入顶栏 / board 竖排浮条，行为同源。
 * 点击一律"插入成品"（线类给 240×140 斜线）；拖拽画线走 A/L 快捷键（见 useEditorShell）。
 */
import { useState, type FC } from "react";
import {
  ArrowUpRightIcon,
  ChartColumnIcon,
  CircleIcon,
  CodeXmlIcon,
  DiamondIcon,
  GalleryVerticalEndIcon,
  GlobeIcon,
  HexagonIcon,
  ImagePlusIcon,
  MinusIcon,
  MoveHorizontalIcon,
  PenIcon,
  PentagonIcon,
  Redo2Icon,
  ShapesIcon,
  SquareIcon,
  StarIcon,
  TableIcon,
  TriangleIcon,
  TypeIcon,
  Undo2Icon,
  WorkflowIcon,
  EllipsisVerticalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { DeckStore } from "@/state";
import type { SelKind } from "./newEl";

/* ---------------- 插入/历史工具组（deck 横排入顶栏 / board 竖排浮条，行为同源） ---------------- */

export const ToolButtons: FC<{
  store: DeckStore;
  pen: boolean;
  onPen: () => void;
  insert: (kind: SelKind) => void;
  pickImage: () => void;
  deck: boolean;
  vertical: boolean;
}> = ({ store, pen, onPen, insert, pickImage, deck, vertical }) => {
  const side = vertical ? "right" : "bottom";
  const sep = vertical ? <Separator className="my-1 !h-px w-5" /> : <Separator orientation="vertical" className="mx-1 !h-5" />;
  const [shapesOpen, setShapesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const shapeBtn = "flex h-auto w-14 flex-col items-center gap-0.5 rounded py-1.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-foreground";
  return (
    <>
      <Hint label="文本（Enter/双击可编辑）" side={side}>
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => insert("text")} aria-label="插入文本">
          <TypeIcon className="size-4" />
        </Button>
      </Hint>
      <Popover open={shapesOpen} onOpenChange={setShapesOpen}>
        <Hint label="形状（点击插入；按 A/L 键可拖拽画线/箭头）" side={side}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="sc-tool" aria-label="插入形状">
              <ShapesIcon className="size-4" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent side={vertical ? "right" : "bottom"} align={vertical ? "center" : "start"} className="w-auto p-1.5">
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ["rect", SquareIcon, "矩形"],
                ["ellipse", CircleIcon, "椭圆"],
                ["diamond", DiamondIcon, "菱形"],
                ["triangle", TriangleIcon, "三角形"],
                ["trapezoid", GalleryVerticalEndIcon, "梯形"],
                ["pentagon", PentagonIcon, "五边形"],
                ["hexagon", HexagonIcon, "六边形"],
                ["star", StarIcon, "五角星"],
                ["line", MinusIcon, "直线"],
                ["arrow", ArrowUpRightIcon, "箭头"],
                ["double-arrow", MoveHorizontalIcon, "双箭头"],
              ] as const
            ).map(([kind, Icon, label]) => (
              <Button
                key={kind}
                variant="ghost"
                size="icon"
                title={kind === "line" || kind === "arrow" || kind === "double-arrow" ? `${label}（点击插入；或按 A/L 键拖拽绘制）` : label}
                aria-label={label}
                onClick={() => {
                  insert(kind);
                  setShapesOpen(false);
                }}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Hint label="图片（选择文件，自动落盘到资产目录）" side={side}>
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={pickImage} aria-label="插入图片">
          <ImagePlusIcon className="size-4" />
        </Button>
      </Hint>
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <Hint label="更多插入：表格 / 图表 / Mermaid / 网页 / SVG" side={side}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="sc-tool" aria-label="更多插入">
              <EllipsisVerticalIcon className="size-4" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent side={vertical ? "right" : "bottom"} align={vertical ? "center" : "start"} className="w-auto p-1.5">
          <div className={cn("grid gap-1", vertical ? "grid-cols-1" : "grid-cols-5")}>
            {(
              [
                ["table", TableIcon, "表格", "点击插入；双击进入单元格编辑"],
                ["chart", ChartColumnIcon, "图表", "点击插入；双击弹出数据表单"],
                ["mermaid", WorkflowIcon, "Mermaid", "点击插入；双击编辑代码"],
                ["embed", GlobeIcon, "网页", "贴 URL 双击可交互；也可直接粘贴链接"],
                ["svg", CodeXmlIcon, "SVG", "双击编辑源码，矢量导出"],
              ] as const
            ).map(([kind, Icon, label, tip]) => (
              <Button key={kind} variant="ghost" className={shapeBtn} title={tip} aria-label={`插入${label}`} onClick={() => { insert(kind); setMoreOpen(false); }}>
                <Icon className="size-4" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {sep}
      <Hint
        label={deck ? "钢笔手绘（P）：在页面内拖动起笔，出页丢弃；Esc 退出" : "钢笔手绘（P）：按下拖动起笔，抬起成线；Esc 退出"}
        side={side}
      >
        <Button variant={pen ? "secondary" : "ghost"} size="icon-sm" className="sc-tool" onClick={onPen} aria-label="钢笔手绘" aria-pressed={pen}>
          <PenIcon className="size-4" />
        </Button>
      </Hint>
      {sep}
      <Hint label="撤销 ⌘Z" side={side}>
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={!store.canUndo} onClick={() => store.undo()} aria-label="撤销">
          <Undo2Icon className="size-4" />
        </Button>
      </Hint>
      <Hint label="重做 ⇧⌘Z" side={side}>
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={!store.canRedo} onClick={() => store.redo()} aria-label="重做">
          <Redo2Icon className="size-4" />
        </Button>
      </Hint>
    </>
  );
};

/* ---------------- 顶栏模式分段（deck 入顶栏 / board 浮层） ---------------- */
