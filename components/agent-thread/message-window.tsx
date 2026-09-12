"use client";

// 迭代 5a：长会话渲染窗口化（P5）。assistant 消息滚出「视口附近」后，
// 把重型子树（markdown 正文、工具输出 pre）整体卸载，wrapper 原位保留
// 等高占位（box-sizing: border-box ⇒ 总滚动高度不变，滚动条/锚点不跳），
// 回到附近再挂载真实内容。只动渲染、不动 runtime 数据：复制/导出走
// message runtime（DOM 无关），编辑重发由 thread.tsx 换整行渲染、不经此处。
//
// 抖动修复（对话流式滚动抖动的根因与对策）：
// 1) 折叠时的高度 = IO 回调里同步实测（原方案用 ResizeObserver 异步缓存值，
//    流式收尾/思考块关闭动画未沉淀就折叠会留下偏差占位）。
// 2) 还原挂载时高度仍可能与占位不等——组件的初始展开态按「是否流式中」
//    推导（如思考块 defaultOpen={running}），占位期间组件被卸载重挂，
//    默认态从"流式展开"翻成"历史收起"。这种不等不再试图避免（重挂语义
//    本就等价于刷新页面），而是在绘制前对视口上方的消息做 scrollTop
//    补偿：视口内容保持原位，用户无感。补偿赋值须临时切 scroll-behavior
//    （容器带 scroll-smooth），否则修正本身变成一次可见滚动动画。
//
// 与预览刻度条（thread-preview-rail）的契约：wrapper 永远保持
// data-slot="aui_assistant-message-content" 挂载（锚点集合与几何不变），
// 卸载期间打 data-windowed="1"，rail 据此跳过从 DOM 重取预览文本。

import { useAuiState } from "@assistant-ui/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import { useUiPrefs } from "@/lib/ui-prefs";

/** 视口上下各扩出的「附近」带：进出这个范围才换挂载，滚动条扫过不频繁抖动 */
const NEAR_MARGIN = "2500px 0px";

/** 迭代 1b 起 thread.tsx 的滚动容器约定选择器（preview rail 同源） */
const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';

export const MessageWindow: FC<{ children: ReactNode }> = ({ children }) => {
  const windowingEnabled = useUiPrefs().renderWindowing;
  // 流式中、等待动作（工具审批未决）、最后一条永不折叠：前两者内容还在
  // 增长或有可交互 UI（测量无意义 / 按钮不该消失），后者是锚点定位目标
  const pinned = useAuiState(
    (s) =>
      s.message.isLast ||
      s.message.status?.type === "running" ||
      s.message.status?.type === "requires-action",
  );
  const active = windowingEnabled && !pinned;

  const ref = useRef<HTMLDivElement>(null);
  const [windowed, setWindowed] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState(0);
  const wasWindowedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      setWindowed(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        if (e.isIntersecting) {
          setWindowed(false);
          return;
        }
        // 折叠发生在这一帧的 IO 回调（滚动后布局已定），同步实测即时高度；
        // 高度为 0（尚未完成首帧布局的竞态）则保持挂载，下次越界再折
        const h = el.getBoundingClientRect().height;
        if (h > 0) {
          setPlaceholderHeight(h);
          setWindowed(true);
        }
      },
      { rootMargin: NEAR_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  // 还原挂载 ⇒ 实测与占位的高度差若发生在视口上方，绘制前补偿 scrollTop，
  // 保持视口内容不动（抖动根因消解）；视口内/下方展开无需补偿。
  useLayoutEffect(() => {
    const was = wasWindowedRef.current;
    wasWindowedRef.current = windowed;
    if (!was || windowed) return;
    const el = ref.current;
    if (!el) return;
    const delta = el.getBoundingClientRect().height - placeholderHeight;
    if (Math.abs(delta) < 0.5) return;
    const vp = el.closest<HTMLElement>(VIEWPORT_SELECTOR);
    if (!vp || vp.scrollTop <= 0) return;
    if (el.getBoundingClientRect().bottom > vp.getBoundingClientRect().top + 1)
      return; // 非"完全在视口上方"：不补
    const prevBehavior = vp.style.scrollBehavior;
    vp.style.scrollBehavior = "auto";
    vp.scrollTop += delta;
    vp.style.scrollBehavior = prevBehavior;
  }, [windowed, placeholderHeight]);

  return (
    <div
      ref={ref}
      data-slot="aui_assistant-message-content"
      data-windowed={windowed ? "1" : undefined}
      className="text-foreground px-2 leading-relaxed wrap-break-word"
      style={
        windowed
          ? ({ height: placeholderHeight } satisfies CSSProperties)
          : undefined
      }
    >
      {windowed ? null : children}
    </div>
  );
};
