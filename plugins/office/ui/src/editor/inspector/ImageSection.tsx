/**
 * 图片属性区（自 Inspector 拆出）：适配方式 / 圆角 / 源路径。
 */
import { type FC } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ImageEl } from "@/doc";
import { GroupCard, NumField, SectionTitle } from "../fields";

export const ImageSection: FC<{ el: ImageEl; patch: (p: Partial<ImageEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>图片</SectionTitle>
      <GroupCard className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">适配</span>
          <Select value={el.fit ?? "cover"} onValueChange={(v) => patch({ fit: v as ImageEl["fit"] })}>
            <SelectTrigger className="h-7 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cover">裁剪填满 cover</SelectItem>
              <SelectItem value="contain">整图 contain</SelectItem>
              <SelectItem value="stretch">拉伸 stretch</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <NumField label="圆角" min={0} value={el.radius ?? 0} onChange={(v) => patch({ radius: v } as Partial<ImageEl>, true)} />
        <div className="text-muted-foreground truncate text-[10.5px]" title={el.src}>
          {el.src}
        </div>
      </GroupCard>
    </>
  );
};
