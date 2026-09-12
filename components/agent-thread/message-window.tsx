"use client";

// 迭代 5a：长会话渲染窗口化（P5）。assistant 消息滚出「视口附近」后，
// 把重型子树（markdown 正文、工具输出 pre）整体卸载，wrapper 原位保留
// 等高占位（box-sizing: border-box ⇒ 总滚动高度不变，滚动条/锚点不跳），
// 回到附近再挂载真实内容。只动渲染、不动 runtime 数据：复制/导出走
// message runtime（DOM 无关），编辑重发由 thread.tsx 换整行渲染、不经此处。
//
// 与预览刻度条（thread-preview-rail）的契约：wrapper 永远保持
// data-slot="aui_assistant-message-content" 挂载（锚点集合与几何不变），
// 卸载期间打 data-windowed="1"，rail 据此跳过从 DOM 重取预览文本。

import { useAuiState } from "@assistant-ui/react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import { useUiPrefs } from "@/lib/ui-prefs";

/** 视口上下各扩出的「附近」带：进出这个范围才换挂载，滚动条扫过不频繁抖动 */
const NEAR_MARGIN = "2500px 0px";

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
  // 最近一次真实挂载下的盒高（含 padding）；折叠期间不更新（占位高度不参与）
  const heightRef = useRef(0);
  const [windowed, setWindowed] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.dataset.windowed !== "1") heightRef.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
        } else if (heightRef.current > 0) {
          // 还没量到高度（首帧竞态）就保持挂载，避免占位 0 高跳动
          setPlaceholderHeight(heightRef.current);
          setWindowed(true);
        }
      },
      { rootMargin: NEAR_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  return (
    <div
      ref={ref}
      data-slot="aui_assistant-message-content"
      data-windowed={windowed ? "1" : undefined}
      className="text-foreground px-2 leading-relaxed wrap-break-word"
      style={windowed ? ({ height: placeholderHeight } satisfies CSSProperties) : undefined}
    >
      {windowed ? null : children}
    </div>
  );
};
