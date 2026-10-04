/**
 * 网页嵌入属性区（自 Inspector 拆出）：URL 编辑 + 沙箱说明。
 */
import { type FC } from "react";
import { type EmbedEl } from "@/doc";
import { GroupCard, SectionTitle } from "../fields";

export const EmbedSection: FC<{ el: EmbedEl; patch: (p: Partial<EmbedEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  return (
    <>
      <SectionTitle>网页嵌入</SectionTitle>
      <GroupCard className="flex flex-col gap-2">
        <input
          value={el.url}
          spellCheck={false}
          onChange={(e) => patch({ url: e.target.value }, true)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="https://…"
          className="w-full rounded-lg border border-transparent bg-secondary/60 px-2 py-1.5 font-mono text-[11px] outline-none focus-visible:border-ink"
        />
        <div className="text-muted-foreground truncate text-[10.5px]" title={el.title ?? ""}>
          {el.title ? `显示名：${el.title}` : "角标显示 provider 名"}
        </div>
        <p className="text-muted-foreground text-[10.5px] leading-relaxed">
          YouTube / B站 / Vimeo / Google 地图 / Spotify / CodePen / Figma 等链接自动转嵌入地址；其他网址原样内嵌。
          画布上双击进入交互、Esc 或点画布退出。桌面端嵌入运行在沙箱内，无 Cookie/登录态。
        </p>
      </GroupCard>
    </>
  );
};
