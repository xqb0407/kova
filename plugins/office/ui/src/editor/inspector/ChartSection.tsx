/**
 * 图表属性区（自 Inspector 拆出）：图表类型（柱/折/饼/环）、图例开关、标签字号。
 * 数据编辑走画布双击（首行系列名、行 = 类目 + 数值）；配色用默认色板，暂不开放逐系列改色。
 */
import { type FC } from "react";
import { type ChartEl } from "@/doc";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { SegGroup } from "../swatches";

/** 四种图表类型的小样（16×16 内联 SVG，与 SegGroup 的 node 接口对齐） */
const ChartGlyph: FC<{ kind: "bar" | "line" | "pie" | "doughnut" }> = ({ kind }) => {
  const stroke = { stroke: "currentColor", strokeWidth: 2, fill: "none" } as const;
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      {kind === "bar" && (
        <>
          <line x1="3.5" y1="14" x2="3.5" y2="8" {...stroke} strokeLinecap="round" />
          <line x1="8" y1="14" x2="8" y2="3" {...stroke} strokeLinecap="round" />
          <line x1="12.5" y1="14" x2="12.5" y2="10" {...stroke} strokeLinecap="round" />
        </>
      )}
      {kind === "line" && <polyline points="2.5,12 6.5,6.5 10,9 13.5,4" {...stroke} strokeLinecap="round" strokeLinejoin="round" />}
      {kind === "pie" && (
        <>
          <circle cx="8" cy="8" r="6" {...stroke} />
          <line x1="8" y1="8" x2="8" y2="2" {...stroke} />
          <line x1="8" y1="8" x2="13" y2="11" {...stroke} />
        </>
      )}
      {kind === "doughnut" && <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth={4} fill="none" />}
    </svg>
  );
};

export const ChartSection: FC<{ el: ChartEl; patch: (p: Partial<ChartEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>图表</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <SegGroup
          value={el.chart ?? "bar"}
          ariaLabel="图表类型"
          onChange={(v) => patch({ chart: v } as Partial<ChartEl>, true)}
          options={[
            { v: "bar", node: <ChartGlyph kind="bar" />, title: "柱状图" },
            { v: "line", node: <ChartGlyph kind="line" />, title: "折线图" },
            { v: "pie", node: <ChartGlyph kind="pie" />, title: "饼图" },
            { v: "doughnut", node: <ChartGlyph kind="doughnut" />, title: "环形图" },
          ]}
        />
        <SegGroup
          value={el.showLegend ? "on" : "off"}
          ariaLabel="底部图例"
          onChange={(v) => patch({ showLegend: v === "on" } as Partial<ChartEl>, true)}
          options={[
            { v: "on", node: <span className="text-[11px] font-semibold">图例</span>, title: "显示底部图例" },
            { v: "off", node: <span className="text-[11px]">无图例</span>, title: "隐藏图例" },
          ]}
        />
        <NumField label="字号" min={6} max={48} value={el.size ?? 12} onChange={(v) => patch({ size: v } as Partial<ChartEl>, true)} />
      </GroupCard>
      <p className="text-muted-foreground mt-3 leading-relaxed">双击图表弹出数据表单：每行 = 类目 + 各系列数值，可增删类目与系列。饼/环只取第一个系列。</p>
    </>
  );
};
