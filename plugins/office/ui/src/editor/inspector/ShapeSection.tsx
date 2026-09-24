/**
 * 形状属性区（自 Inspector 拆出）：描边（色板/粗细/线形）、弧度（线/箭头/双箭头：
 * 滑杆+数值+反向弯/拉直，缺省 0＝直；折线 pts≥3 时换成折线态提示+拉直）、
 * 填充（线类无）、圆角（仅矩形）。
 */
import { type FC } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { LINE_SHAPE_KINDS, type LinePt, type ShapeEl } from "@/doc";
import { dirFromVec } from "@/bind";
import { isPolyline, polyLocal } from "@/viewspec";
import { GroupCard, NumField, SectionTitle } from "../fields";
import {
  CornerGlyph,
  SegGroup,
  SHAPE_BG_PRESETS,
  StrokeGlyph,
  STROKE_PRESETS,
  SwatchRow,
} from "../swatches";

/** 折线拉直：只留首末两点，回退为 bbox+dir 两点线（清 pts/curve） */
function straightenPatch(el: ShapeEl): Partial<ShapeEl> {
  const pp = polyLocal(el);
  const a = pp[0];
  const b = pp[pp.length - 1];
  const ax = el.x + a.x;
  const ay = el.y + a.y;
  const bx = el.x + b.x;
  const by = el.y + b.y;
  return {
    x: Math.round(Math.min(ax, bx)),
    y: Math.round(Math.min(ay, by)),
    w: Math.max(1, Math.round(Math.abs(bx - ax))),
    h: Math.max(1, Math.round(Math.abs(by - ay))),
    dir: dirFromVec(ax, ay, bx, by) || undefined,
    pts: undefined,
    curve: undefined,
  };
}

export const ShapeSection: FC<{ el: ShapeEl; patch: (p: Partial<ShapeEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  const poly = isPolyline(el) ? ((el.pts as LinePt[]) || []) : null;
  return (
    <>
      <SectionTitle>描边</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
      <SwatchRow
        presets={STROKE_PRESETS}
        value={el.stroke}
        ariaLabel="描边颜色"
        onPick={(hex) => patch({ stroke: hex } as Partial<ShapeEl>, true)}
        onNone={() => patch({ stroke: "none" } as Partial<ShapeEl>, true)}
      />
      <div className="flex items-center gap-2">
        <NumField
          label="粗细"
          min={0.5}
          max={40}
          value={el.strokeWidth ?? 2}
          onChange={(v) => patch({ strokeWidth: v } as Partial<ShapeEl>, true)}
        />
        <SegGroup
          className="min-w-0 flex-[1.3]"
          value={el.strokeStyle ?? "solid"}
          ariaLabel="边框样式"
          onChange={(v) => patch({ strokeStyle: v } as Partial<ShapeEl>, true)}
          options={[
            { v: "solid", node: <StrokeGlyph />, title: "实线" },
            { v: "dashed", node: <StrokeGlyph dash="4 3" />, title: "虚线" },
            { v: "dotted", node: <StrokeGlyph dash="0.1 2.4" />, title: "点线" },
          ]}
        />
      </div>
      </GroupCard>
      {LINE_SHAPE_KINDS.includes(el.shape) && poly && (
        <>
          <SectionTitle>折线 · {poly.length} 点</SectionTitle>
          <GroupCard className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[10px] leading-4 text-foreground/50">
              拖动画布上的顶点调整，Alt 点内部顶点删除；折线暂不支持弧度
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 border border-border/60 text-xs"
              title="只保留首末两点，回到直线（仍保留箭头）"
              onClick={() => patch(straightenPatch(el))}
            >
              拉直
            </Button>
          </GroupCard>
        </>
      )}
      {LINE_SHAPE_KINDS.includes(el.shape) && !poly && (
        <>
          <SectionTitle>弧度</SectionTitle>
          <GroupCard className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Slider
              min={-1}
              max={1}
              step={0.05}
              value={[el.curve ?? 0]}
              onValueChange={([v]) => patch({ curve: v ?? 0 } as Partial<ShapeEl>, true)}
              className="min-w-0 flex-1"
            />
            <span className="w-10 shrink-0 text-right font-mono text-[11px] text-foreground/60">
              {(el.curve ?? 0).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 border border-border/60 text-xs"
              title="弯向另一侧（沿行进方向翻边）"
              onClick={() => {
                const c = el.curve ?? 0;
                patch({ curve: c === 0 ? 0.3 : -c } as Partial<ShapeEl>);
              }}
            >
              反向弯
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 border border-border/60 text-xs"
              title="弯度归零（变直，仍保留箭头）"
              onClick={() => patch({ curve: 0 } as Partial<ShapeEl>)}
            >
              拉直
            </Button>
          </div>
          <div className="flex justify-between text-[10px] text-foreground/50">
            <span>反向弯</span>
            <span>0（直）</span>
            <span>正向弯</span>
          </div>
          </GroupCard>
        </>
      )}
      {!LINE_SHAPE_KINDS.includes(el.shape) && (
        <>
          <SectionTitle>填充</SectionTitle>
          <GroupCard>
          <SwatchRow
            presets={SHAPE_BG_PRESETS}
            value={el.fill}
            ariaLabel="背景颜色"
            onPick={(hex) => patch({ fill: hex } as Partial<ShapeEl>, true)}
            onNone={() => patch({ fill: "none" } as Partial<ShapeEl>, true)}
          />
          </GroupCard>
        </>
      )}
      {el.shape === "rect" && (
        <>
          <SectionTitle>圆角</SectionTitle>
          <GroupCard className="flex flex-col gap-2">
          <SegGroup
            value={(el.radius ?? 0) > 0 ? "round" : "sharp"}
            ariaLabel="边角"
            onChange={(v) => patch({ radius: v === "round" ? 8 : 0 } as Partial<ShapeEl>, true)}
            options={[
              { v: "sharp", node: <CornerGlyph />, title: "直角" },
              { v: "round", node: <CornerGlyph round />, title: "圆角" },
            ]}
          />
          {(el.radius ?? 0) > 0 && (
            <NumField label="圆角" min={0} value={el.radius ?? 0} onChange={(v) => patch({ radius: v } as Partial<ShapeEl>, true)} />
          )}
          </GroupCard>
        </>
      )}
    </>
  );
};
