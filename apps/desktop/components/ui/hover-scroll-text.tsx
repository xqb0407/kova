"use client";

/**
 * 一行长文本 + 溢出时悬浮滚动（侧边栏会话标题同款）。
 *
 * 溢出时右缘渐隐收尾（shadcn scroll-fade-e 的等效形态）取代省略号；鼠标进入
 * 后向左平移展示全文，离开回位。文字从渐隐下滚过，读起来就是真实滚动容器的
 * 观感——比 tooltip 更直接，也不遮住相邻行。
 *
 * 不挂工具类而走内联 mask：scroll-fade-e 依赖 @property + animation-timeline
 * + 嵌套 @supports 的机制，在 Chromium 下不可靠（实测无效果）；这里直接写
 * 等价 mask 渐变，并仍按实测溢出施加（短文本不蚀尾字）。
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const FADE =
  "linear-gradient(to right, #000 calc(100% - 16px), transparent)";

export const HoverScrollText = ({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & { children: ReactNode }) => {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [dx, setDx] = useState(0);
  const [overflows, setOverflows] = useState(false);

  const measure = () => {
    // 侧边栏拖拽期间跳过：每帧宽度变化会让所有行的 RO 回调排队做布局读取，
    // 是拖动卡顿的主因；松手后由 rail-resize-end 统一补测一次
    if (document.documentElement.classList.contains("is-resizing")) return;
    const el = outerRef.current;
    if (el) setOverflows(el.scrollWidth - el.clientWidth > 1);
  };

  useLayoutEffect(() => {
    measure();
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onResizeEnd = () => measure();
    window.addEventListener("rail-resize-end", onResizeEnd);
    return () => {
      ro.disconnect();
      window.removeEventListener("rail-resize-end", onResizeEnd);
    };
    // children 变化（改名/标题生成）后重测
  }, [children]);

  const enter = () => {
    const el = outerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    // 末尾多留一点呼吸空间，避免最后一个字贴着裁切边
    if (overflow > 1) setDx(-(overflow + 16));
  };

  return (
    <span
      ref={outerRef}
      onMouseEnter={enter}
      onMouseLeave={() => setDx(0)}
      className={cn(
        "block min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        className,
      )}
      // 截断时：mask 渐隐收尾（蚀字而非叠色，任何底色自适应），省略号退役；
      // 未截断保持原样。text-overflow 只对行内 inline-level 溢出生效，
      // 所以内层用 inline-block 而非 block。
      style={
        overflows
          ? {
              textOverflow: "clip",
              WebkitMaskImage: FADE,
              maskImage: FADE,
            }
          : undefined
      }
      {...props}
    >
      {/* w-max：inline-block 默认 shrink-to-fit 会被容器宽度封顶，文字溢出
          发生在内层盒子内部，外层的 ellipsis 就永远不触发；按 max-content
          撑开让内层盒子本身溢出行盒，省略号才会画出来。 */}
      <span
        className="inline-block w-max"
        style={{
          transform: `translateX(${dx}px)`,
          transition:
            dx !== 0
              ? `transform ${Math.min(6, Math.abs(dx) / 30)}s linear`
              : "transform 0.2s ease",
        }}
      >
        {children}
      </span>
    </span>
  );
};
