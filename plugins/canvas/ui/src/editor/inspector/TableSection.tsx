/**
 * 表格属性区（自 Inspector 拆出）：表头开关、字号、单元格/表头底色、网格线与文字色。
 * 内容编辑走画布双击（Tab 分列、换行分行），列宽在编辑文本里改不动、暂不开放。
 */
import { type FC } from "react";
import { type TableEl } from "@/doc";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { SegGroup, SHAPE_BG_PRESETS, STROKE_PRESETS, SwatchRow, TEXT_PRESETS } from "../swatches";

export const TableSection: FC<{ el: TableEl; patch: (p: Partial<TableEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>表格</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <SegGroup
          value={el.header === false ? "off" : "on"}
          ariaLabel="首行表头"
          onChange={(v) => patch({ header: v === "on" } as Partial<TableEl>, true)}
          options={[
            { v: "on", node: <span className="text-[11px] font-semibold">表头</span>, title: "首行表头样式" },
            { v: "off", node: <span className="text-[11px]">无表头</span>, title: "全部数据行" },
          ]}
        />
        <NumField label="字号" min={8} max={96} value={el.size ?? 18} onChange={(v) => patch({ size: v } as Partial<TableEl>, true)} />
      </GroupCard>
      <SectionTitle>底色</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <SwatchRow
          presets={SHAPE_BG_PRESETS}
          value={el.fill}
          ariaLabel="单元格底色"
          onPick={(hex) => patch({ fill: hex } as Partial<TableEl>, true)}
        />
        <SwatchRow
          presets={SHAPE_BG_PRESETS}
          value={el.headerFill}
          ariaLabel="表头底色"
          onPick={(hex) => patch({ headerFill: hex } as Partial<TableEl>, true)}
        />
      </GroupCard>
      <SectionTitle>网格与文字</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <SwatchRow
          presets={STROKE_PRESETS}
          value={el.stroke}
          ariaLabel="网格线颜色"
          onPick={(hex) => patch({ stroke: hex } as Partial<TableEl>, true)}
        />
        <SwatchRow
          presets={TEXT_PRESETS}
          value={el.color}
          ariaLabel="文字颜色"
          onPick={(hex) => patch({ color: hex } as Partial<TableEl>, true)}
        />
      </GroupCard>
    </>
  );
};
