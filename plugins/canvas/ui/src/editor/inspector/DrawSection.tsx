/**
 * 手绘笔迹属性区（自 Inspector 拆出）：描边色/粗细 + 采样点提示。
 */
import { type FC } from "react";
import { type DrawEl } from "@/doc";
import { ColorField, GroupCard, NumField, SectionTitle } from "../fields";

export const DrawSection: FC<{ el: DrawEl; patch: (p: Partial<DrawEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>手绘笔迹</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <ColorField label="颜色" value={el.stroke} onChange={(hex) => patch({ stroke: hex }, true)} />
        <NumField
          label="粗细"
          min={0.5}
          max={40}
          value={el.strokeWidth ?? 2}
          onChange={(v) => patch({ strokeWidth: v }, true)}
        />
        <p className="text-muted-foreground text-[10.5px] leading-relaxed">
          {el.points.length} 个采样点；缩放笔迹会按包围盒拉伸。
        </p>
      </GroupCard>
    </>
  );
};
