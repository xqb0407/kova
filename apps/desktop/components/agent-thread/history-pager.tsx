"use client";

// 往上滚动懒加载更早历史（§6 分页的渲染侧）：视口滚到顶部附近、本会话窗口
// 还有更早的行、且当前没在跑时，用 beforeSeq 游标再取一窗并入消息流。
//
// 两个副作用需要处理：
//  - prepend 会长高上方内容：按「距底部距离」补偿 scrollTop，视觉停在原处；
//  - 下标锚定的旁路态（检查点卡、手动压缩分隔线）随消息条数整体后移。

import { useAui, useAuiState } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
} from "react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { cn } from "@/lib/utils";
import { shiftManualCompactionAnchor } from "@/lib/pi/pi-compaction-marker";
import { shiftRunCheckpointAnchors } from "@/lib/pi/pi-checkpoints";
import { getHistoryWindowMeta } from "@/lib/pi/pi-history-window";
import {
  loadOlderPiHistory,
  piSessionRegistry,
} from "@/lib/pi/pi-thread-adapter";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
/** 距顶小于该值时触发翻页（留一点余量，滚动中不至于卡在临界反复触发） */
const TOP_TRIGGER_PX = 240;

/**
 * 挂在 ThreadPrimitive.Viewport 内最上方（消息流之前）。
 * 不 loading 时容器隐藏，不参与布局。
 */
export const HistoryPager: FC = () => {
  const aui = useAui();
  const rootRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  // 待补偿的 preload 现场（并入前的高度/滚动位置 + 并入条数），由 layout effect 消费。
  // 并入条数由 loadOlderPiHistory 返回，不用"前后消息总数相减"——那样会把加载
  // 期间恰好新到的消息也算进平移量（检查点卡/压缩线会错位）。
  const pendingRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    added: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const messageCount = useAuiState((s) => s.thread.messages.length);

  const loadOlder = useCallback(async () => {
    if (loadingRef.current || isRunning) return;
    const viewport = rootRef.current?.closest<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport || !threadId) return;
    const remoteId = piSessionRegistry.get(threadId);
    const meta = remoteId ? getHistoryWindowMeta(remoteId) : undefined;
    // 没有游标或没有更早的行：无处可翻（不进入 loading 态，避免闪一下）
    if (!remoteId || !meta?.hasMore || meta.firstSeq === null) return;

    loadingRef.current = true;
    setLoading(true);
    const scrollHeight = viewport.scrollHeight;
    const scrollTop = viewport.scrollTop;
    try {
      const added = await loadOlderPiHistory(aui, remoteId, threadId);
      pendingRef.current = added > 0 ? { scrollHeight, scrollTop, added } : null;
    } catch (err) {
      pendingRef.current = null;
      console.warn("[pi-history] load older failed", String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [aui, isRunning, threadId]);

  // 并入后（消息条数变化的那次提交）在绘制前补滚动：prepend 长高了多少，
  // scrollTop 就加多少——视觉停在原处。同时把下标锚定的旁路态整体后移。
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const viewport = rootRef.current?.closest<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport || !threadId) return;
    if (pending.added > 0) {
      shiftRunCheckpointAnchors(threadId, pending.added);
      shiftManualCompactionAnchor(threadId, pending.added);
    }
    const grew = viewport.scrollHeight - pending.scrollHeight;
    if (grew > 0) viewport.scrollTop = pending.scrollTop + grew;
  }, [messageCount, threadId]);

  useEffect(() => {
    const viewport = rootRef.current?.closest<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport) return;

    const handleScroll = () => {
      if (viewport.scrollTop > TOP_TRIGGER_PX) return;
      void loadOlder();
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [loadOlder, messageCount]);

  return (
    <div
      ref={rootRef}
      data-slot="aui_history-pager"
      role="status"
      className={cn(
        "mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 px-6 py-2",
        !loading && "hidden",
      )}
    >
      <DotMatrix state="loading" aria-hidden />
      <span className="shimmer shimmer-speed-200 text-foreground/60 text-sm">
        正在载入更早的对话...
      </span>
    </div>
  );
};
