"use client";

import { type FC, type RefObject, useEffect, useRef } from "react";
import { Link2Icon } from "lucide-react";
import type { CitationEntry } from "@/lib/panels/panel-activity";
import { openExternal } from "@/lib/external-link";
import { scrollIntoScroller } from "@/lib/motion/scroll";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import { cn } from "@/lib/utils";
import { CountPill, PanelSection } from "./section-shell";

/**
 * 一条引用（详细版，与消息里的一行速览互补）：站点图标 + 标题，
 * 下方 URL 一行 + 摘要两行截断；悬浮 title 显示完整 href，
 * 点击走系统浏览器（webview 里 target=_blank 点了没反应）。
 */
const CitationRow: FC<{ item: CitationEntry; focused?: boolean }> = ({
  item,
  focused,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  // 消息来源条定位进来：滚到视野中央（只滚面板自身容器，见 lib/motion/scroll 注释）
  useEffect(() => {
    if (!focused) return;
    scrollIntoScroller(rowRef.current, "center");
  }, [focused]);

  const url = item.url;
  const body = (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <SiteIcon url={url ?? ""} />
        <span className="text-foreground/90 group-hover/cite:text-primary min-w-0 truncate text-sm leading-snug underline-offset-2 decoration-1 group-hover/cite:underline">
          {item.title}
        </span>
      </div>
      {url ? (
        <div className="text-muted-foreground/70 mt-0.5 truncate pl-5 font-mono text-xs">
          {url}
        </div>
      ) : null}
      {item.snippet ? (
        <div className="text-muted-foreground mt-0.5 line-clamp-2 pl-5 text-xs leading-relaxed">
          {item.snippet}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      ref={rowRef}
      className={cn("rounded-lg", focused && "bg-muted/40 ring-2 ring-ring/40")}
    >
      {!url ? (
        <div className="px-2.5 py-1.5">{body}</div>
      ) : (
        <button
          type="button"
          // 悬浮显示完整链接地址（webview 没有浏览器状态栏，title 是唯一入口）
          title={url}
          onClick={() => openExternal(url)}
          className="group/cite hover:bg-muted/40 block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors"
        >
          {body}
        </button>
      )}
    </div>
  );
};

/**
 * 活动面板「引用资料」：当前线程所有 WebSearch/WebFetch 结果的汇总
 * （store 侧已按 url 去重）。focusUrl 命中的行高亮并滚到中央；
 * revealKey 非空时把整个区块滚到顶部（消息来源条点击进来），值变化即重滚
 * ——调用方在 focus 里编 nonce，activity 标签已停在引用区时重复点击也生效。
 */
export const ReferencesSection: FC<{
  items: CitationEntry[];
  /** 外层滚动容器 ref：PanelSection 吸顶判定（IntersectionObserver root） */
  scrollRoot?: RefObject<HTMLElement | null>;
  /** 定位：命中的引用行（按 url 匹配）高亮并滚到视野中央 */
  focusUrl?: string;
  /** 定位：滚动到引用资料区块顶部（nonce 编码在值里，变化即重滚） */
  revealKey?: string;
}> = ({ items, scrollRoot, focusUrl, revealKey }) => {
  const sectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revealKey) return;
    scrollIntoScroller(sectionRef.current, "start");
  }, [revealKey]);

  if (items.length === 0) return null;

  return (
    <div ref={sectionRef}>
      <PanelSection
        scrollRoot={scrollRoot}
        icon={<Link2Icon className="size-4" />}
        title="引用资料"
        trailing={<CountPill>{items.length}</CountPill>}
      >
        <div className="flex flex-col gap-1.5">
          {items.map((c) => (
            <CitationRow
              key={c.url ?? `${c.toolCallId}\u0000${c.title}`}
              item={c}
              focused={focusUrl != null && focusUrl === c.url}
            />
          ))}
        </div>
      </PanelSection>
    </div>
  );
};
