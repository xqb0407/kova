/**
 * 白板顶部工具条（自 App.tsx 拆出）：高频工具直出 + 「插入」面板收纳其余（点击展开）。
 * 点击一律"插入成品"；拖拽画线/箭头走 A/L 快捷键。
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
  HandIcon,
  HexagonIcon,
  ImagePlusIcon,
  MinusIcon,
  MousePointer2Icon,
  MoveHorizontalIcon,
  PenIcon,
  PentagonIcon,
  ShapesIcon,
  SquareIcon,
  StarIcon,
  TableIcon,
  TriangleIcon,
  TypeIcon,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import type { DeckStore } from "@/state";
import type { SelKind } from "./newEl";

/* ---------------- 白板顶部工具条（高频直出 + 插入面板，参考 Excalidraw 的收敛思路） ---------------- */

export const BoardToolbar: FC<{
  store: DeckStore;
  pen: boolean;
  hand: boolean;
  drawTool: "line" | "arrow" | "double-arrow" | null;
  onSelect: () => void;
  onHand: () => void;
  onPen: () => void;
  insert: (kind: SelKind) => void;
  pickImage: () => void;
}> = ({ pen, hand, drawTool, onSelect, onHand, onPen, insert, pickImage }) => {
  const [insertOpen, setInsertOpen] = useState(false);
  type Tool = { key: string; Icon: FC<{ className?: string }>; label: string; hint: string; active: boolean; onClick: () => void; sepBefore?: boolean };
  const tools: Tool[] = [
    { key: "V", Icon: MousePointer2Icon, label: "选择", hint: "选择/框选（V）；Esc 回到选择", active: !pen && !hand && !drawTool, onClick: onSelect },
    { key: "H", Icon: HandIcon, label: "抓手", hint: "抓手平移（H）：拖拽移动画布；也可按住空格或中键", active: hand, onClick: onHand },
    { key: "P", Icon: PenIcon, label: "画笔", hint: "钢笔手绘（P）：按下拖动起笔，抬起成线；Esc 退出", active: pen, onClick: onPen, sepBefore: true },
    { key: "T", Icon: TypeIcon, label: "文本", hint: "插入文本（T）；Enter/双击进入编辑", active: false, onClick: () => insert("text"), sepBefore: true },
    { key: "I", Icon: ImagePlusIcon, label: "图片", hint: "插入图片（选择文件，自动落盘资产目录）", active: false, onClick: pickImage },
  ];
  const shapeBtn = "flex h-auto w-14 flex-col items-center gap-0.5 rounded py-1.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-foreground";
  return (
    /* 窄面板时工具自动换行成第二行（玻璃底由外层顶栏提供） */
    <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1">
      {tools.map((t) => (
        <span key={t.label} className="flex items-center">
          {t.sepBefore && <Separator orientation="vertical" className="mx-1 !h-6" />}
          <Hint label={t.hint} side="bottom">
            <Button
              variant={t.active ? "secondary" : "ghost"}
              size="icon-sm"
              className="sc-tool"
              aria-label={t.label}
              aria-pressed={t.active}
              onClick={t.onClick}
            >
              <t.Icon className="size-4" />
            </Button>
          </Hint>
        </span>
      ))}
      <Separator orientation="vertical" className="mx-1 !h-6" />
      <Popover open={insertOpen} onOpenChange={setInsertOpen}>
        <Hint label="插入：形状 / 表格 / 图表 / Mermaid / 网页 / SVG" side="bottom">
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="sc-tool" aria-label="插入">
              <ShapesIcon className="size-4" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent side="bottom" align="end" className="w-auto p-2">
          <div className="grid grid-cols-6 gap-1">
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
                className={shapeBtn}
                title={kind === "line" || kind === "arrow" || kind === "double-arrow" ? `${label}（点击插入；或按 A/L 键拖拽绘制）` : label}
                aria-label={label}
                onClick={() => {
                  insert(kind);
                  setInsertOpen(false);
                }}
              >
                <Icon className="size-4" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
          <div className="bg-border my-1.5 h-px" />
          <div className="grid grid-cols-5 gap-1">
            {(
              [
                ["table", TableIcon, "表格", "点击插入；双击进入单元格编辑"],
                ["chart", ChartColumnIcon, "图表", "点击插入；双击弹出数据表单"],
                ["mermaid", WorkflowIcon, "Mermaid", "点击插入；双击编辑代码"],
                ["embed", GlobeIcon, "网页", "贴 URL 双击可交互；也可直接粘贴链接"],
                ["svg", CodeXmlIcon, "SVG", "双击编辑源码，矢量导出"],
              ] as const
            ).map(([kind, Icon, label, tip]) => (
              <Button key={kind} variant="ghost" className={shapeBtn} title={tip} aria-label={`插入${label}`} onClick={() => { insert(kind); setInsertOpen(false); }}>
                <Icon className="size-4" />
                <span>{label}</span>
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
