/**
 * SVG 源码属性区（自 Inspector 拆出）：源码编辑 + 渲染/导出限制说明。
 */
import { type FC } from "react";
import { type SvgEl } from "@/doc";
import { GroupCard, SectionTitle } from "../fields";

export const SvgSection: FC<{ el: SvgEl; patch: (p: Partial<SvgEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>SVG 源码</SectionTitle>
      <GroupCard className="flex flex-col gap-2">
        <textarea
          value={el.code}
          spellCheck={false}
          onChange={(e) => patch({ code: e.target.value }, true)}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-40 w-full resize-y rounded-lg border border-transparent bg-secondary/60 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ink"
        />
        <p className="text-muted-foreground text-[10.5px] leading-relaxed">
          完整 &lt;svg&gt;…&lt;/svg&gt; 源码；经 &lt;img&gt; 沙箱渲染，脚本不执行。含 foreignObject
          的源码在桌面端（WKWebView）可能无法显示；导出 SVG/HTML 保留矢量，导出 PPT 转位图。
        </p>
      </GroupCard>
    </>
  );
};
