"use client";

/**
 * 滚动触底自动翻页的哨兵：放进滚动容器末尾，进入视口（提前 240px 预取）
 * 即触发一次 onVisible。ClawHub / MCP 市场列表共用。
 *
 * active/loading 变化时重建 observer——加载完成后哨兵若仍在视口内会立即
 * 续载，直到装满一屏或没有下一页。onVisible 走 ref：回调每轮渲染都是新
 * 引用，不因它反复断连 observer。
 */
import { useEffect, useRef, type FC } from "react";
import { Loader2Icon } from "lucide-react";

export const LoadMoreSentinel: FC<{
  onVisible: () => void;
  /** false 时停止观察（没有下一页 / 搜索态 / 正在加载） */
  active?: boolean;
  loading?: boolean;
}> = ({ onVisible, active = true, loading = false }) => {
  const ref = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisibleRef.current();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, loading]);

  return (
    <div
      ref={ref}
      className="text-muted-foreground flex h-10 items-center justify-center"
    >
      {loading && <Loader2Icon className="size-4 animate-spin" />}
    </div>
  );
};
