/**
 * Mermaid 属性区（自 Inspector 拆出）：主题选择 + 代码编辑。
 */
import { type FC } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type MermaidEl, type MermaidTheme } from "@/doc";
import { GroupCard, SectionTitle } from "../fields";

export const MermaidSection: FC<{ el: MermaidEl; patch: (p: Partial<MermaidEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>Mermaid</SectionTitle>
      <GroupCard className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">主题</span>
          <Select value={el.theme ?? "follow"} onValueChange={(v) => patch({ theme: v as MermaidTheme })}>
            <SelectTrigger className="h-7 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="follow">跟随应用</SelectItem>
              <SelectItem value="default">浅色</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="neutral">中性</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <textarea
          value={el.code}
          spellCheck={false}
          onChange={(e) => patch({ code: e.target.value }, true)}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-40 w-full resize-y rounded-lg border border-transparent bg-secondary/60 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ink"
        />
        <p className="text-muted-foreground text-[10.5px] leading-relaxed">
          支持 flowchart / sequence / pie / state 等全部 mermaid 图类型；画布上双击也可直接改代码。
        </p>
      </GroupCard>
    </>
  );
};
