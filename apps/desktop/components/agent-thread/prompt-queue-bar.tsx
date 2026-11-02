"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import {
  usePiController,
  usePiQueue,
  restoreQueueItemsToComposer,
  type PiQueueEntry,
} from "@/lib/pi/pi-runtime";
import { previewQueueContent } from "@/lib/pi/queue-preview";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  ImageIcon,
  Loader2Icon,
  MergeIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  QuoteIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
} from "react";
import {
  DirectiveText,
  directiveChipVariants,
} from "@/components/assistant-ui/elements/directive-text.aui";
import { toast } from "@/components/ui/toast";
import { cn } from "cn";

// DirectiveText 运行时签名就是 ({ text })（memo 导出被放宽成 TextMessagePartComponent
// 才要求 part），排队条只有纯文本无 part，收窄回真实签名
const QueueDirectiveText = DirectiveText as unknown as FC<{ text: string }>;

/** 队列行拖拽载荷 MIME：与文件树/会话拖拽、附件拖入隔离开 */
const QUEUE_DRAG_MIME = "application/x-kova-queue-item";

/** 注入消息上屏后，「已并入」打勾再停留多久 */
const STEER_CONFIRM_MS = 1000;
/** 兜底：注入已受理但队列项迟迟没被 queue_update 摘掉时，别让打勾常驻 */
const STEER_QUEUED_FALLBACK_MS = 3000;

/** 线程里最后一条已上屏「并入」用户消息的 id（data-steeredNote part）：
 *  并入的 user 消息不在直播侧渲染，要等本轮落盘/快照才出现；队列条的
 *  「已并入」打勾要等这个 id 变化（气泡真的上屏了）才能撤。从尾部往前找，
 *  命中即停。 */
function lastSteeredMessageId(
  messages: readonly {
    id?: string;
    role?: string;
    content?: unknown;
  }[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    const steered = message.content.some((part) => {
      const p = part as { type?: string; name?: string };
      return p.type === "data" && p.name === "steeredNote";
    });
    if (steered) return message.id ?? null;
  }
  return null;
}

/** 队列行交互集合：行内只发意图，busy 门闩/状态清理都留在父组件。 */
type QueueRowActions = {
  move(id: string, toIndex: number): void;
  cancel(id: string): void;
  promote(id: string): void;
  steer(item: PiQueueEntry, index: number): void;
  edit(item: PiQueueEntry): void;
  dragStart(item: PiQueueEntry, event: React.DragEvent<HTMLElement>): void;
  dragEnd(): void;
  dragOver(item: PiQueueEntry, event: React.DragEvent<HTMLElement>): void;
  dragLeave(item: PiQueueEntry, event: React.DragEvent<HTMLElement>): void;
  drop(item: PiQueueEntry, event: React.DragEvent<HTMLElement>): void;
};

/**
 * prompt 排队条（composer 上方）——迁移 4a：数据源 = react-pi state.queue
 * （sidecar queue_update 事件驱动，条目 id = 真实 reqId）。扁平样式：单块
 * 浅色面板 = 可折叠头部（「N 条排队中 ⌄」）+ 纯文本条目行（无卡片边框/
 * 序号，hover 出逐项操作），参考 2026-10-31 用户给的样式稿。
 *
 * 头部操作：
 *  - 折叠/展开（⌄）：只收起条目列表，头部常驻（暂停/清空随时可用）；
 *    视图偏好在会话内保留，不随线程切换重置
 *  - 暂停/继续（v3.1）：冻结/解冻自动派发——当前轮自然跑完，之后不开下一轮；
 *    恢复由 sidecar 原生接力接棒（kickQueueDrain 补工人槽，顺序与队列一致）。
 *    状态随 queue_update/快照回流，暂停中刷新后仍保持
 *  - 清空（垃圾桶）：取消全部排队项，不回填（与单条删除同语义）
 * 条目操作（hover 显示）：
 *  - 拖动排序：行首 Grip 手柄把 drop 转成 sidecar queue_move；上移/下移保留
 *    作为键盘/触屏回退
 *  - 上移/下移（v3.1）：调整派发顺序（sidecar moveEntry，队首/队尾自动隐藏）
 *  - 编辑（v3.1）：从队列移除并把内容（文本+图片）退回输入框，在 composer
 *    里改完重新发送（重发走正常排队车道，排到队尾——位置让位给简单可靠）；
 *    带「询问」引用的条目回填成 composer 的引用预览，而不是裸 `>` 文本
 *  - 并入当前回复（steer）：注入活跃轮，不中止本轮；点击后行内先显示
 *    「并入中」，受理后打勾「已并入 · 等待并入」，等注入的 user 气泡出现
 *    在消息流后再收起（ghost 行保证空窗里 bar 不消失）
 *  - 立即发送（promote）：中止当前轮、该项插队马上执行（暂停中隐式恢复）
 *  - 删除（cancel）：取消排队项，不执行不回填（想改内容走编辑）
 *
 * 「询问」引用的队列展示：sidecar 队列项 text 是含 Markdown 引用块的 prompt
 * 原文；行内只出「询问」徽标 + 用户正文，不重复引用原文（parse 见
 * lib/pi/queue-preview）。
 * 排队中的消息不进消息列表（sidecar 调度后才落盘转录）——react-pi 原生满足
 * 「调度前不显示气泡」，无需旧链路的 remove/reveal 信号同步。
 *
 * 刷新接力泵（收敛版）：运行轮重挂由 connect + 快照自愈承担（迁移阶段 3）；
 * 队列非空时订阅保活（见 usePiRuntime），sidecar 串行链派发的下一轮
 * agent_start 原生可见——泵只剩一种场景：sidecar 重启后无链节的孤儿队列
 * （暂停恢复不走泵：sidecar 原生接力补槽派发，链节在场时泵被
 * hasPromptChain 守卫拦住，天然互不干扰）。挂载/快照恢复（队列从空变非空）
 * 与运行态下降沿时探测：线程空闲且队列非空且未暂停 → queue_pop（sidecar
 * 守卫暂停位 + isTurnBusy + hasPromptChain 三保险，链节在时绝不误弹）→
 * 弹出队首按原载荷直发重发（文本+图片附件，绕开 composer 共用车道防幽灵
 * pending）。暂停位变化也进探测键：恢复瞬间若接力槽尚未建起（事件在途），
 * 键不含 paused 的话泵不会重新探测。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 运行态不订阅渲染值：下降沿（泵孤儿队列）在下方订阅控制器逐次观察；
  // 泵内部自己读 aui.thread.getState().isRunning。渲染值会被 React 批处理
  // 合并，本轮收尾与下一轮立即派发同批到达时看不到 false 瞬间。
  const controller = usePiController();
  const { queue, cancel, promote, steer, pop, resend, pause, resume, move, clear } =
    usePiQueue();
  const paused = queue.paused;
  const items = queue.followUp;
  const [busy, setBusy] = useState(false);
  // 折叠态：只收条目列表，头部（暂停/清空）常驻
  const [open, setOpen] = useState(true);
  // hover 跑马灯：条目文本溢出时，hover 触发横向滚动到末端停住
  //（--queue-marquee-shift = 溢出像素，滚速 22px/s，keyframes 见 styles/animate.css）
  const [marqueeId, setMarqueeId] = useState<string | null>(null);
  const [marqueeShift, setMarqueeShift] = useState(0);
  const [marqueeDuration, setMarqueeDuration] = useState(0);
  // 拖动排序：源行 / 当前悬停的落点行（目标行整圈高亮）
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  /**
   * 并入当前回复的逐项反馈：
   * - injecting：点了并入，正在等 sidecar 注入完成（图片归一化可能 1-2s）；
   * - done：注入已受理，打勾保留；但注入的 user 消息要等本轮落盘/快照才
   *   上屏，期间即使 sidecar 已把队列项摘掉，也用 ghost 行把打勾留在原位，
   *   直到最后一条 steeredNote 消息 id 变化确认气泡出现，再停留 STEER_CONFIRM_MS。
   */
  const [steerFlash, setSteerFlash] = useState<{
    item: PiQueueEntry;
    /** 原队列下标：条目被 queue_update 摘掉后，ghost 仍插回原位置显示打勾 */
    index: number;
    phase: "injecting" | "done";
    /** 点击时最后一条已上屏并入消息的 id；id 变化 = 新气泡真的出现了 */
    baseSteeredId: string | null;
    /** 已经看到注入消息上屏（决定打勾何时可以撤） */
    revealed: boolean;
  } | null>(null);
  // primitive 切片：只有“并入”气泡真的上屏时 id 变化，流式 token 不重渲。
  // 仅在有一个待上屏的并入确认时扫描，普通会话不为此多遍历消息历史。
  const lastSteeredId = useAuiState((s) =>
    steerFlash && !steerFlash.revealed
      ? lastSteeredMessageId(s.thread.messages)
      : null,
  );
  const steerTimerRef = useRef<number | null>(null);
  const clearSteerTimer = useCallback(() => {
    if (steerTimerRef.current !== null) {
      window.clearTimeout(steerTimerRef.current);
      steerTimerRef.current = null;
    }
  }, []);

  /** 队列操作统一 busy 门闩；返回是否成功（并入需要区分失败并提示）。 */
  const act = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch {
      // 无活跃轮可并入等拒绝：条目原位保留，快照下一次广播对齐
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 并入受理后 sidecar 会立刻把队列项摘掉，但注入的 user 消息要等本轮落盘/
  // 快照才上屏。打勾/ghost 行要留到消息真的出现在消息流里（steeredNote id
  // 变化）才撤，否则会出现“队列没了、用户消息也还没显示”的空窗。
  const steerStillQueued = steerFlash
    ? items.some((item) => item.id === steerFlash.item.id)
    : false;
  useEffect(() => {
    if (!steerFlash || steerFlash.revealed) return;
    if (!lastSteeredId || lastSteeredId === steerFlash.baseSteeredId) return;
    setSteerFlash((current) =>
      current?.item.id === steerFlash.item.id
        ? { ...current, revealed: true }
        : current,
    );
  }, [lastSteeredId, steerFlash]);
  useEffect(() => {
    if (!steerFlash || steerFlash.phase !== "done") return;
    const id = steerFlash.item.id;
    // 队列项还在：正常应很快被 queue_update 摘掉；事件丢失时超时恢复普通
    // 队列行，否则状态会永久占住这一行的操作区。
    // 队列项已摘掉但消息未上屏：用 ghost 一直等，直到 user 气泡出现。
    if (steerStillQueued) {
      steerTimerRef.current = window.setTimeout(() => {
        steerTimerRef.current = null;
        setSteerFlash((current) => (current?.item.id === id ? null : current));
      }, STEER_QUEUED_FALLBACK_MS);
      return () => {
        if (steerTimerRef.current !== null) {
          window.clearTimeout(steerTimerRef.current);
          steerTimerRef.current = null;
        }
      };
    }
    if (!steerFlash.revealed) return;
    steerTimerRef.current = window.setTimeout(() => {
      steerTimerRef.current = null;
      setSteerFlash((current) => (current?.item.id === id ? null : current));
    }, STEER_CONFIRM_MS);
    return () => {
      if (steerTimerRef.current !== null) {
        window.clearTimeout(steerTimerRef.current);
        steerTimerRef.current = null;
      }
    };
  }, [steerFlash, steerStillQueued]);
  useEffect(() => () => clearSteerTimer(), [clearSteerTimer]);

  // 条目被并入后如果又被回队（注入未被本轮回应），撤掉打勾恢复队列行。
  const steerGhostSeenRef = useRef(false);
  useEffect(() => {
    if (!steerFlash) {
      steerGhostSeenRef.current = false;
      return;
    }
    if (!steerStillQueued) {
      steerGhostSeenRef.current = true;
      return;
    }
    if (steerGhostSeenRef.current) setSteerFlash(null);
  }, [steerFlash, steerStillQueued]);

  // 拖动中条目被取消/派发/并入掉：源行与落点高亮一起收掉，别留残影。
  useEffect(() => {
    if (draggingId && !items.some((item) => item.id === draggingId)) {
      setDraggingId(null);
    }
    if (dropId && !items.some((item) => item.id === dropId)) {
      setDropId(null);
    }
  }, [items, draggingId, dropId]);

  // 切会话/线程：并入确认与拖拽状态都属于旧线程，不能带到新线程的队列条。
  // useLayoutEffect：切线程的同一次提交里就清掉，避免旧线程的 ghost/打勾
  // 在新线程闪一帧。
  useLayoutEffect(() => {
    clearSteerTimer();
    setSteerFlash(null);
    setDraggingId(null);
    setDropId(null);
    setMarqueeId(null);
  }, [threadId, clearSteerTimer]);

  const handleSteer = async (item: PiQueueEntry, index: number) => {
    if (busy || index < 0) return;
    clearSteerTimer();
    setMarqueeId(null);
    setDraggingId(null);
    setDropId(null);
    // 基线取点击这一刻的最后一条并入消息 id（不依赖渲染切片，避免历史消息
    // 被误判成“新消息上屏”）。
    setSteerFlash({
      item,
      index,
      phase: "injecting",
      baseSteeredId: lastSteeredMessageId(aui.thread.getState().messages),
      revealed: false,
    });
    const ok = await act(() => steer(item.id));
    if (!ok) {
      setSteerFlash(null);
      toast.error("并入失败：当前回复可能已经结束");
      return;
    }
    setSteerFlash((current) =>
      current?.item.id === item.id ? { ...current, phase: "done" } : current,
    );
  };

  // 接力泵（见头注）：pumpingRef 防重入（内含 await 链）。queue_pop 的
  // sidecar 三保险让误弹不可能——暂停中/链节仍在/轮在跑时 popped 恒为 null。
  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const pumpingRef = useRef(false);
  pumpRef.current = async () => {
    if (!aui || !threadId || pumpingRef.current) return;
    if (queue.paused) return;
    if (queue.steering.length === 0 && queue.followUp.length === 0) return;
    pumpingRef.current = true;
    try {
      // 在跑轮（含链节盲派发的下一轮）：订阅保活下事件原生可见，无需泵
      if (aui.thread.getState().isRunning) return;
      const popped = await pop();
      if (!popped) return;
      // 直发重发（controller.queueResend）：带原载荷图片附件，且绕开 composer
      // 共用车道——弹出后前端队列条与 sidecar 引擎可能短暂分歧（空快照事件
      // 在途），composer 车道会把重发误判进排队压出 pending 幽灵。撞竞态轮
      // （线程又忙了）时 isQueuedSend 照常接管续排队，语义不变
      await resend(popped);
    } catch (err) {
      // 通道异常：下一次下降沿/队列变化再试；留痕防"泵凭空失效"无从排查
      console.warn("[queue-pump] dispatch failed", String(err));
    } finally {
      pumpingRef.current = false;
    }
  };

  // 队列非空即探测（覆盖挂载/线程切换/快照恢复采纳孤儿队列/队列增长/暂停位
  // 翻转）；全空时 key 归零不触发。泵内部有暂停位与 sidecar 双重守卫，多触发无害
  const queueKey = `${queue.steering.length}:${queue.followUp.length}:${
    queue.followUp[0]?.id ?? ""
  }:${paused ? 1 : 0}`;
  useEffect(() => {
    if (queueKey === "0:0::0") return;
    void pumpRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  // 运行态下降沿：链节派发由订阅保活原生覆盖；泵兜孤儿队列。不比较渲染值——
  // 本轮收尾与下一轮立即派发会被 React 合并进同一次渲染，组件看不到 false
  // 瞬间；直接订阅控制器通知逐次观察状态提交，边沿不丢。
  // busy 判定与框架 thread.isRunning 同口径（isPiStateBusy）：runStatus 之外
  // 还看压缩/重试——轮前压缩时 runStatus 可能已是 idle 但轮还没真正结束。
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    return controller.subscribe(() => {
      const s = controller.getState();
      const busy =
        s.runStatus === "running" || s.compaction.active || s.retry.active;
      const was = wasRunningRef.current;
      wasRunningRef.current = busy;
      if (was && !busy) {
        void pumpRef.current();
      }
    });
  }, [controller, threadId]);

  if (!threadId) return null;

  // 进场实测溢出量，超出才起跑马灯（scrollWidth 在 truncate 态也量到完整内容宽）
  const startMarquee =
    (id: string) => (event: React.MouseEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const inner = viewport.firstElementChild as HTMLElement | null;
      if (!inner) return;
      const dist = inner.scrollWidth - viewport.clientWidth;
      if (dist <= 2) {
        setMarqueeId(null);
        return;
      }
      setMarqueeShift(dist);
      setMarqueeDuration(Math.min(45, Math.max(3, dist / 22)));
      setMarqueeId(id);
    };

  // 「已并入」打勾的 ghost：sidecar 的 queue_update 可能已经把条目摘掉，
  // 但用户需要看见打勾这一下；插回原位置保留确认，等确认时长结束再撤。
  // 条目还在队列里时由真实行显示同样的状态，不重复插入。
  const ghost =
    steerFlash && !items.some((item) => item.id === steerFlash.item.id)
      ? steerFlash
      : null;
  const ghostIndex = ghost ? Math.min(ghost.index, items.length) : -1;
  const rows = ghost
    ? [
        ...items.slice(0, ghostIndex),
        ghost.item,
        ...items.slice(ghostIndex),
      ]
    : items;
  const hasRows = rows.length > 0;

  // 队列行的交互集合：行内只发意图，busy 门闩/状态清理都留在父组件。
  const rowActions: QueueRowActions = {
    move: (id, toIndex) => void act(() => move(id, toIndex)),
    cancel: (id) => void act(() => cancel(id)),
    promote: (id) => void act(() => promote(id)),
    steer: (item, index) => void handleSteer(item, index),
    edit: (item) =>
      void act(async () => {
        await cancel(item.id);
        await restoreQueueItemsToComposer(aui, [item]);
      }),
    dragStart: (item, event) => {
      event.stopPropagation();
      event.dataTransfer.setData(QUEUE_DRAG_MIME, item.id);
      event.dataTransfer.effectAllowed = "move";
      const row = event.currentTarget.closest<HTMLElement>("[data-queue-row]");
      if (row) event.dataTransfer.setDragImage(row, 16, 12);
      setDraggingId(item.id);
      setDropId(null);
    },
    dragEnd: () => {
      setDraggingId(null);
      setDropId(null);
    },
    dragOver: (item, event) => {
      if (busy) return;
      if (!Array.from(event.dataTransfer.types).includes(QUEUE_DRAG_MIME))
        return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropId((current) => (current === item.id ? current : item.id));
    },
    dragLeave: (item, event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null))
        return;
      setDropId((current) => (current === item.id ? null : current));
    },
    drop: (target, event) => {
      if (busy) return;
      const sourceId = event.dataTransfer.getData(QUEUE_DRAG_MIME) || draggingId;
      event.preventDefault();
      event.stopPropagation();
      setDraggingId(null);
      setDropId(null);
      if (!sourceId) return;
      const from = items.findIndex((entry) => entry.id === sourceId);
      const to = items.findIndex((entry) => entry.id === target.id);
      if (from < 0 || to < 0 || from === to) return;
      void act(() => move(sourceId, to));
    },
  };

  return (
    <div
      className="relative grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: hasRows ? "1fr" : "0fr" }}
      data-slot="aui-prompt-queue-bar"
      aria-hidden={!hasRows}
    >
      {/* 连体灰背板：向下延伸垫到 composer 卡（z-10）的圆角后面——卡片的
          上圆角缺口透出灰色，队列区与输入卡在轮廓上连成一张（样式稿）。
          top 用 calc(100%-8px) 从面板可视底部起算（容器高度含面板 mb-2 的
          外边距盒，top-full 会偏到卡片顶边、把 mb-2 的 8px 缝隙漏在背板
          外面）；高度 = 圆角 + 缝隙 8px + 4px 余量。必须挂在 grid 容器
          （relative）这一层：内层 overflow-hidden 折叠裁剪层会把超出面板
          底部的部分裁掉；空队列不渲染 */}
      {hasRows && (
        <div
          aria-hidden
          className="bg-muted/80 dark:bg-muted/80 backdrop-blur-md pointer-events-none absolute inset-x-0 top-[calc(100%-8px)] h-[calc(var(--composer-radius)+12px)]"
        />
      )}
      <div className="min-h-0 overflow-hidden">
        <div
          className="bg-muted/80 dark:bg-muted/80 rounded-t-(--composer-radius) mb-2 px-3.5 pt-1.5 pb-1"
          // ComposerRoot 对非交互区域的 mousedown 会 preventDefault 抢焦点
          // （「点击输入区空白聚焦」），队列条正文因此选不中。这里阻断冒泡，
          // 保留原生选区行为（库文档给后代留的逃生口）；点击图标按钮不受影响
          onMouseDown={(event) => event.stopPropagation()}
        >
          {/* 头部：N 条排队中 ⌄（折叠/展开条目列表）｜ 暂停 · 清空 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="text-muted-foreground/80 hover:text-foreground focus-visible:ring-ring/40 -ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm py-1 text-left text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 transition-transform duration-200",
                  !open && "-rotate-90",
                )}
              />
              <span className="truncate" aria-live="polite">
                {items.length > 0
                  ? `${items.length} 条排队中`
                  : steerFlash
                    ? steerFlash.phase === "done"
                      ? steerFlash.revealed
                        ? "已并入当前回复"
                        : "已受理，等待并入…"
                      : "并入中…"
                    : "0 条排队中"}
                {paused && items.length > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}
                    · 已暂停
                  </span>
                )}
              </span>
            </button>
            {items.length > 0 ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <QueueIconButton
                  label={
                    paused
                      ? "继续排队发送"
                      : "暂停排队发送（当前回复跑完不再派发下一条）"
                  }
                  disabled={busy}
                  onClick={() => void act(() => (paused ? resume() : pause()))}
                >
                  {paused ? (
                    <PlayIcon className="size-3.5" />
                  ) : (
                    <PauseIcon className="size-3.5" />
                  )}
                </QueueIconButton>
                <QueueIconButton
                  label="清空全部排队消息"
                  disabled={busy}
                  className="hover:text-destructive"
                  onClick={() =>
                    void act(async () => {
                      // 整队取消（不回填，与单条删除同语义）；回执载荷弃用
                      await clear();
                    })
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </QueueIconButton>
              </div>
            ) : null}
          </div>
          {/* 条目列表：纯文本行（无卡片边框/序号），hover 出逐项操作；
              折叠走 grid-rows 0fr↔1fr 过渡，与外层容器同款 */}
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
            aria-hidden={!open}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-0.5 py-1">
                {rows.map((item) => {
                  const realIndex = items.findIndex(
                    (entry) => entry.id === item.id,
                  );
                  return (
                    <QueueRow
                      key={item.id}
                      item={item}
                      realIndex={realIndex}
                      itemCount={items.length}
                      paused={paused}
                      busy={busy}
                      draggingId={draggingId}
                      dropId={dropId}
                      steerPhase={
                        steerFlash?.item.id === item.id ? steerFlash.phase : null
                      }
                      marqueeId={marqueeId}
                      marqueeShift={marqueeShift}
                      marqueeDuration={marqueeDuration}
                      startMarquee={startMarquee}
                      stopMarquee={() => setMarqueeId(null)}
                      actions={rowActions}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * 队列行（真实行与「已并入」ghost 确认行共用一套渲染）。ghost 行
 * （realIndex = -1）不可拖动、不出操作按钮，只保留内容与并入状态；
 * 所有交互都经 actions 回调到父组件，busy 门闩/拖拽状态也留在父组件。
 */
const QueueRow: FC<{
  item: PiQueueEntry;
  realIndex: number;
  itemCount: number;
  paused: boolean;
  busy: boolean;
  draggingId: string | null;
  dropId: string | null;
  steerPhase: "injecting" | "done" | null;
  marqueeId: string | null;
  marqueeShift: number;
  marqueeDuration: number;
  startMarquee: (id: string) => (event: React.MouseEvent<HTMLDivElement>) => void;
  stopMarquee: () => void;
  actions: QueueRowActions;
}> = ({
  item,
  realIndex,
  itemCount,
  paused,
  busy,
  draggingId,
  dropId,
  steerPhase,
  marqueeId,
  marqueeShift,
  marqueeDuration,
  startMarquee,
  stopMarquee,
  actions,
}) => {
  // ghost = 并入成功后临时保留的确认行：不在真实队列里，不可拖动、不参与操作
  const isGhost = realIndex < 0;
  const showHandle = itemCount > 1;
  const showStatus = steerPhase !== null;
  const isDragging = draggingId === item.id;
  const isDropTarget = dropId === item.id;
  const images = item.attachments ?? [];
  const thumb = images.find((attachment) => attachment.data);
  const preview = previewQueueContent(item.content);
  const body = preview.text.trim();
  // 纯引用只出徽标；纯图片回退成 [图片]；隐藏块/引用原文都不回落到队列行
  //（item.content 可能含给模型看的 prompt 原文）
  const shownText =
    body ||
    (preview.quote
      ? ""
      : images.length > 0
        ? `[图片${images.length > 1 ? ` ×${images.length}` : ""}]`
        : "");
  return (
    <div
      data-queue-row={isGhost ? undefined : item.id}
      className={cn(
        // 不用负外边距通栏：高亮药丸完整浮在面板内部，两端圆角可见
        //（通栏会被面板边缘吃掉圆角，读不出圆角）
        "group hover:bg-muted-foreground/10 flex items-center gap-2 rounded-lg px-2 py-1 transition-colors",
        paused && !isGhost && "opacity-60",
        isDragging && "opacity-40",
        isDropTarget && "ring-1 ring-[var(--drop-line)]",
        isGhost && "bg-muted-foreground/[0.04]",
      )}
      onDragOver={isGhost ? undefined : (event) => actions.dragOver(item, event)}
      onDragLeave={
        isGhost ? undefined : (event) => actions.dragLeave(item, event)
      }
      onDrop={isGhost ? undefined : (event) => actions.drop(item, event)}
    >
      {showHandle ? (
        isGhost ? (
          // ghost 与真实行同宽占位，保证打勾行和队列行缩进一致
          <span className="size-4 shrink-0" aria-hidden />
        ) : (
          <button
            type="button"
            draggable={!busy && !showStatus}
            disabled={busy || showStatus}
            aria-label="拖动调整排队顺序"
            title="拖动调整顺序"
            onDragStart={(event) => actions.dragStart(item, event)}
            onDragEnd={() => actions.dragEnd()}
            className="text-muted-foreground/30 hover:text-muted-foreground inline-flex size-4 shrink-0 cursor-grab items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        )
      ) : null}
      {images.length > 0 &&
        (thumb ? (
          <img
            src={`data:${thumb.mimeType};base64,${thumb.data}`}
            alt={thumb.name ?? "排队消息附图"}
            className="border-border/50 size-5 shrink-0 rounded border object-cover"
          />
        ) : (
          <ImageIcon className="text-muted-foreground/60 size-3.5 shrink-0" />
        ))}
      {preview.quote && <AskQuoteBadge />}
      {shownText ? (
        <div
          className={cn(
            directiveChipVariants,
            "min-w-0 flex-1 overflow-hidden text-sm text-foreground/80",
          )}
          onMouseEnter={isGhost ? undefined : startMarquee(item.id)}
          onMouseLeave={stopMarquee}
        >
          <div
            className={cn("items-center gap-1", marqueeId === item.id ? "flex w-max" : "truncate")}
            style={
              marqueeId === item.id
                ? ({
                    "--queue-marquee-shift": `${marqueeShift}px`,
                    animation: `queue-marquee ${marqueeDuration}s linear forwards`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <QueueDirectiveText text={shownText} />
          </div>
        </div>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {showStatus ? (
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1 text-xs",
            steerPhase === "done"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground",
          )}
        >
          {steerPhase === "done" ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <Loader2Icon className="size-3.5 animate-spin" />
          )}
          {steerPhase === "done" ? "已并入" : "并入中"}
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          {realIndex > 0 && (
            <QueueIconButton
              label="上移"
              disabled={busy}
              onClick={() => actions.move(item.id, realIndex - 1)}
            >
              <ArrowUpIcon className="size-3.5" />
            </QueueIconButton>
          )}
          {realIndex >= 0 && realIndex < itemCount - 1 && (
            <QueueIconButton
              label="下移"
              disabled={busy}
              onClick={() => actions.move(item.id, realIndex + 1)}
            >
              <ArrowDownIcon className="size-3.5" />
            </QueueIconButton>
          )}
          <QueueIconButton
            label="编辑（退回输入框修改后重新发送）"
            disabled={busy}
            onClick={() => actions.edit(item)}
          >
            <PencilIcon className="size-3.5" />
          </QueueIconButton>
          <QueueIconButton
            label="并入当前回复（不中止本轮）"
            disabled={busy}
            onClick={() => actions.steer(item, realIndex)}
          >
            <MergeIcon className="size-3.5" />
          </QueueIconButton>
          <QueueIconButton
            label="立即发送（中止当前回复）"
            disabled={busy}
            onClick={() => actions.promote(item.id)}
          >
            <ZapIcon className="size-3.5" />
          </QueueIconButton>
          <QueueIconButton
            label="删除"
            disabled={busy}
            className="hover:text-destructive"
            onClick={() => actions.cancel(item.id)}
          >
            <XIcon className="size-3.5" />
          </QueueIconButton>
        </div>
      )}
    </div>
  );
};

/** 「询问」徽标：队列行只提示这是一条带引用的询问，不重复展示引用正文；
 *  真正的引用原文在编辑回填后由 composer 的引用预览呈现。 */
const AskQuoteBadge: FC = () => (
  <span
    aria-label="引用了一段文字进行询问"
    className="bg-background/70 text-muted-foreground ring-border/50 inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium ring-1"
  >
    <QuoteIcon className="size-3" />
    询问
  </span>
);

const QueueIconButton: FC<{
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, disabled, className, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "text-muted-foreground/80 hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/10 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  >
    {children}
  </button>
);
