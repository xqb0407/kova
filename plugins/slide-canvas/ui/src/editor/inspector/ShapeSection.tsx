/**
 * 形状属性区（自 Inspector 拆出）：描边（色板/粗细/线形）、填充（线/箭头无）、圆角（仅矩形）。
 */
import { type FC } from "react";
import { type ShapeEl } from "@/doc";
import { GroupCard, NumField, SectionTitle } from "../fields";
import {
  CornerGlyph,
  SegGroup,
  SHAPE_BG_PRESETS,
  StrokeGlyph,
  STROKE_PRESETS,
  SwatchRow,
} from "../swatches";

export const ShapeSection: FC<{ el: ShapeEl; patch: (p: Partial<ShapeEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
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
      {el.shape === "curve-arrow" && (
        <>
          <SectionTitle>弧度</SectionTitle>
          <GroupCard className="flex flex-col gap-2">
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={el.curve ?? 0.3}
            aria-label="弧度"
            onChange={(e) => patch({ curve: Number(e.target.value) } as Partial<ShapeEl>, true)}
            className="w-full accent-foreground"
          />
          <div className="flex justify-between text-[10px] text-foreground/50">
            <span>反向弯</span>
            <span>正向弯</span>
          </div>
          </GroupCard>
        </>
      )}
      {el.shape !== "line" && el.shape !== "arrow" && el.shape !== "double-arrow" && el.shape !== "curve-arrow" && (
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
