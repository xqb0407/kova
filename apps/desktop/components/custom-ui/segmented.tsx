"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** 可选前导图标，渲染在文字左侧（纯文字段不受影响） */
  icon?: ReactNode;
  /** 原生 tooltip：分段器里放不下说明文字，需要时挂在按钮上 */
  title?: string;
};

/**
 * 分段选择器：胶囊容器内互斥单选，激活段以主色（--primary）高亮。
 * 滑块是常驻节点 + 「激活段相对容器的 left/top/width/height」CSS 变量
 * + CSS transition（曲线与 ui/tabs 一致：500ms cubic-bezier(.16,1,.3,1)）。
 *
 * 刻意不用 framer 的 layoutId 共享布局：dialog popup 按内容高度垂直
 * 居中，切换页签时高度瞬时塌缩又弹回，整块列表在视口里重定位；framer
 * 按视口坐标做投影，会把这次「祖先被重新居中」回放成滑块的飞行动画
 * （纵向漂移 bug，与 ui/tabs 同根因，layoutRoot 也挡不住外部 reflow）。
 * 这里的变量由 getBoundingClientRect 差值量得（容器系内相对坐标，
 * 祖先平移/居中对两边等量作用、差值不变），ResizeObserver 跟随尺寸
 * 变化重测，天然免疫祖先 reflow。
 * motion-safe: 前缀处理 prefers-reduced-motion；泛型 T 由 options
 * 字面量推断，onChange 回传具体联合类型。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  size = "md",
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** md = 默认（h-7 / text-xs，设置页与市场用）；lg 给主区里的主操作（h-9 / text-sm） */
  size?: "md" | "lg";
  className?: string;
}) {
  const large = size === "lg";
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [vars, setVars] = useState<CSSProperties>({});
  // 首次测量前不渲染滑块：否则滑块从 0×0 起被 transition 一路"长"过来
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const cont = containerRef.current;
    const btn = itemRefs.current.get(value);
    if (!cont || !btn) return;
    const c = cont.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    setVars({
      "--seg-left": `${b.left - c.left}px`,
      "--seg-top": `${b.top - c.top}px`,
      "--seg-width": `${b.width}px`,
      "--seg-height": `${b.height}px`,
    } as CSSProperties);
    setReady(true);
  }, [value]);

  // value 切换 / 字体异步就绪导致文本宽度变化，都要在绘制前跟上
  useLayoutEffect(measure, [measure]);

  // 选项集合签名（消费方常传内联数组，不能用引用相等做依赖）
  const shape = options.map((o) => `${o.value}\0${o.label}`).join("\x01");
  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;
    const ro = new ResizeObserver(measure);
    ro.observe(cont);
    for (const el of itemRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, shape]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "bg-background/70 relative flex shrink-0 items-center gap-0.5 rounded-full border-[0.5]",
        large ? "p-[3px]" : "p-0.5",
        className,
      )}
    >
      {ready ? (
        <span
          aria-hidden
          style={vars}
          className={cn(
            "bg-primary pointer-events-none absolute left-(--seg-left) top-(--seg-top) h-(--seg-height) w-(--seg-width) rounded-full",
            "motion-safe:transition-[left,top,width,height] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
          )}
        />
      ) : null}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <div key={opt.value} className={cn("relative", disabled && "opacity-60")}>
            <button
              ref={(el) => {
                if (el) itemRefs.current.set(opt.value, el);
                else itemRefs.current.delete(opt.value);
              }}
              type="button"
              disabled={disabled}
              title={opt.title}
              aria-pressed={active}
              onClick={() => !active && onChange(opt.value)}
              className={cn(
                "relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-transparent",
                large ? "h-9 px-3.5 text-sm" : "h-7 px-3 text-xs",
                "transition-colors",
                "disabled:cursor-not-allowed",
                // 指示器负责主色底，按钮自身保持透明，避免底色与滑动胶囊叠出双层圆角；
                // 未选中段悬浮时仍给淡主色背景提示可点击
                active
                  ? "text-primary-foreground"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-foreground",
              )}
            >
              {opt.icon}
              {opt.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
