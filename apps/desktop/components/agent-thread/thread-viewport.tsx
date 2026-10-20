"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FC,
} from "react";
import { ThreadPrimitive, useThreadViewportStore } from "@assistant-ui/react";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { registerTopAnchorReserveRecomputer } from "@/lib/ui/top-anchor-reserve";

/** sticky composer 页脚（与 thread-preview-rail 同一选择器） */
const FOOTER_SELECTOR = ".aui-thread-viewport-footer";
/** 超视口被裁切时至少保留的可见高度：再长的消息也能看到一段完整上下文 */
const MIN_VISIBLE_PX = 96;
/** 超视口被裁切时留给回复/状态的比例：可视区的 40% */
const ASSISTANT_RESERVE_RATIO = 0.4;
/** 视口上下留一点余量，避免消息边缘贴死 */
const EDGE_MARGIN_PX = 8;

type ThreadViewportProps = Omit<
  ComponentProps<typeof ThreadPrimitive.Viewport>,
  "ref" | "topAnchorMessageClamp"
>;

/** 可用高度 → 框架顶部锚点的数值配置（px） */
const clampFor = (usableHeight: number) => ({
  tallerThan: Math.max(0, usableHeight - EDGE_MARGIN_PX),
  visibleHeight: Math.min(
    usableHeight,
    Math.max(
      MIN_VISIBLE_PX,
      Math.round(usableHeight * (1 - ASSISTANT_RESERVE_RATIO)),
    ),
  ),
});

/**
 * 同步顶部锚点的长消息 clamp。
 *
 * 框架的 viewport store 只在创建时读一次 `topAnchorMessageClamp`（provider 用
 * useState 初始化），之后再改 prop 不会生效，所以这里改在 target 注册后直接
 * 重新登记一次数值配置：
 *   · target 出现时（每轮 assistant 消息挂载）；
 *   · 视口可用高度变化时（窗口/面板/多行 composer）。
 * 只覆盖 `element.target` 与 `targetConfig`，不碰视口/滚动状态。
 */
const TopAnchorClampSync: FC<{ usableHeight: number }> = ({ usableHeight }) => {
  const store = useThreadViewportStore();
  const config = useMemo(() => clampFor(usableHeight), [usableHeight]);

  useEffect(() => {
    if (usableHeight <= 0) return;

    const apply = () => {
      const state = store.getState();
      const target = state.element.target;
      if (!target) return;
      state.registerAnchorTargetElement(target, config);
    };

    apply();
    // 折叠面板（思考/工具组/轮过程）的高度变化不在框架的观察范围内；
    // useScrollLock 在动画结束后调这里，按新的 scrollHeight 重写垫片。
    const offRecompute = registerTopAnchorReserveRecomputer(apply);
    const unsubscribe = store.subscribe((state) => {
      const target = state.element.target;
      if (!target) return;
      if (
        state.targetConfig?.tallerThan === config.tallerThan &&
        state.targetConfig?.visibleHeight === config.visibleHeight
      ) {
        return;
      }
      // 框架在 target 挂载/重新激活时会用默认 10em/6em 再登记一次，这里抢回来
      state.registerAnchorTargetElement(target, config);
    });
    return () => {
      offRecompute();
      unsubscribe();
    };
  }, [store, config, usableHeight]);

  return null;
};

/**
 * 视口包装：把框架顶部锚点的长消息 clamp 改成按视口实际可用高度动态计算。
 *
 * 框架默认 `tallerThan = 10em`、`visibleHeight = 6em`：用户消息只要超过
 * 约 160px 就只保留最后约 96px——哪怕视口完全放得下整条消息，顶部也会被
 * 裁掉，表现就是发完长消息后要往上滚才能看全。
 *
 * 这里量出「视口高度 - sticky composer 高度」作为真正可用的阅读高度：
 *   · 消息放得下 → 不裁切，顶部锚定后整条可见；
 *   · 确实超过视口 → 才保留底部一段（可视区 60%），给回复和状态留 40%。
 *
 * 滚动定位仍由框架的 top-anchor 逻辑和 ViewportScrollManager 负责。
 */
export const ThreadViewport: FC<ThreadViewportProps> = ({
  children,
  ...props
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [usableHeight, setUsableHeight] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      // 拖拽调宽期间逐帧测量会与布局互相踩踏；松手后由 resize-settled 补一次
      if (isResizing()) return;
      const footer = viewport.querySelector<HTMLElement>(FOOTER_SELECTOR);
      const next = Math.max(
        0,
        Math.round(viewport.clientHeight - (footer?.offsetHeight ?? 0)),
      );
      setUsableHeight((current) => (current === next ? current : next));
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(viewport);
    // composer 是多行输入，页脚会自己长高——不跟着观察的话，可用高度会偏大
    const footer = viewport.querySelector<HTMLElement>(FOOTER_SELECTOR);
    if (footer) observer?.observe(footer);
    const offSettled = onResizeSettled(measure);

    return () => {
      observer?.disconnect();
      offSettled();
    };
  }, []);

  return (
    <ThreadPrimitive.Viewport ref={viewportRef} {...props}>
      {children}
      <TopAnchorClampSync usableHeight={usableHeight} />
    </ThreadPrimitive.Viewport>
  );
};
