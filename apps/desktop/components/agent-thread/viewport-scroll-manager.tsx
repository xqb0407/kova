"use client";

// 视口滚动管理器：把「锚点兜底重放」（top-anchor-keeper）与「流式贴尾跟随」
// 合并成一套监听、一个节拍。
//
// 一轮里视口只有两件事，都挂在同一个内容节拍上（ResizeObserver，每帧至多一次
// 回调；垫片阶段差值恒为 0，贴尾分支自动空转）：
//   · 钉顶兜底：框架的一次性置顶被 isRunning 空窗吃掉时补一次——只在该轮还在跑、
//     锚点已重新挂上、且用户这一轮还没表达过滚动意图时；
//   · 贴尾跟随：正文长过视口之后，每帧把差值补掉，让最新输出留在视野里。
//     两道闸：只在该轮进行中、且高出来的确实是正在流的那条消息。展开折叠轮、
//     检查点卡出现、图片加载都会让内容变高，但视口不该跟着走——否则用户展开
//     一轮折叠内容时，用户消息会被顶出视野（实测：注入 900px 后 top 被拽到底）。
//
// 用户意图只认手势（wheel 向上 / 触摸 / 翻页键 / 在视口上按下=拖滚动条），
// 不从 scroll 事件反推方向：框架自己的置顶修正是一次向上平滑滚动、内容变短
// 时浏览器会把 scrollTop 夹小、content-visibility 的占位还会让高度反复跳变
// ——认方向的判据（"高度没变时的向上位移"）在这些情况下会把它们误判成用户
// 意图，于是整轮跟随被关掉（在 long-turn 页上实测踩到）。位置只用来"接管"：
// 贴回底部就恢复跟随，位置本身不需要方向推断。
//
// 视口外的程序化跳转（刻度条点击定位）没有手势可听：由跳转方显式调用
// yieldViewportScroll() 让位。
//
// 相比两份补丁各挂一套监听，这里省掉：350ms 轮询、周期 getBoundingClientRect
// （只剩钉顶兜底那条窄路径要用）、以及 scroll 路径上的 scrollHeight 读取
// （贴底判定用内容节拍里缓存的上限）。
//
// 探针（dev 构建计时，生产零开销）：视口-节拍 / 视口-贴尾写 / 视口-钉顶写 +
// 计数（有差值 / 让位 / 接管 / 钉顶真滚），累计量走 perf-store，读数见
// dev-preview/long-turn 报告。

import { useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { reportFrontendWarning } from "@/lib/frontend-logging";
import {
  noteCount,
  noteSpan,
  noteSpanAccum,
} from "@/components/debug/perf-store";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const GROUP_SELECTOR = '[data-slot="aui_message-group"]';
/** 位置容差：垫片按整像素对齐（snapScrollTop），留 1px 吸收取整误差 */
const TOL_PX = 1;
/** 目标消息"长高了"的最小幅度：小于它当作噪声（不会一路攒差，差值按累计算） */
const GROW_TOL_PX = 2;
/** 钉顶写入的滚动静默期（ms）：框架在新轮 anchor 上跑 smooth scroll，动画期间
 *  每拍都有滚动事件；这期间再写 scrollTop 会与动画互相拉扯（表现为聊天区上下
 *  跳一下）。等滚动停稳后再校正，把「两个写入者」收敛成一次。 */
const PIN_SCROLL_IDLE_MS = 160;
/** 用户滚动键（文本输入键不在此列；编辑框内的翻页键另按目标元素过滤） */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
/** 交互元素内的 pointerdown 不算「用户要滚视图」（点按钮/开合折叠/点输入框） */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, summary, [role='button'], [contenteditable]";

/** 计时探针：布局读写在同一条回调里交替（读 scrollHeight → 写 scrollTop），
 *  是候选卡顿源。只在开发构建计时，生产直接跑。 */
const span = <T,>(label: string, fn: () => T): T => {
  if (process.env.NODE_ENV === "production") return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    noteSpan(label, ms);
    noteSpanAccum(label, ms);
  }
};

/** 让位入口（模块级）：视口外的程序化跳转也是用户意图，但手势监听收不到。
 *  刻度条的"跳到第 N 轮"这类跳转在跳之前调一次，跟随就交还给用户。 */
const yielders = new Set<() => void>();

export const yieldViewportScroll = (): void => {
  for (const yieldNow of yielders) yieldNow();
};

/** 「该轮还在跑」：线程级 ∨ 消息级。线程级有排队准备段/中止收尾的空窗（见
 *  message-turns 的 Turn.running 注释），消息级在压缩期间没有消息在流。 */
const useTurnLive = () =>
  useAuiState(
    (s) =>
      s.thread.isRunning ||
      s.thread.messages.at(-1)?.status?.type === "running",
  );

/** 本轮锚点（末两条 = 用户 + 回复时的用户消息 id），与框架 getActiveTopAnchorTurn
 *  同口径，但不带 isRunning——空窗正是要靠它兜住的时刻。 */
const useAnchorId = () =>
  useAuiState((s) => {
    const anchor = s.thread.messages.at(-2);
    return anchor?.role === "user" &&
      s.thread.messages.at(-1)?.role === "assistant"
      ? String(anchor.id)
      : "";
  });

/** 正在流的那条 assistant 消息 id：贴尾只认「它自己在长」——投影切块会在一轮内
 *  换掉末尾消息，所以取值要走 ref，不能只依赖 effect 的重建时机。 */
const useTargetId = () =>
  useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    return last?.role === "assistant" ? String(last.id) : "";
  });

/**
 * 挂载点：ThreadPrimitive.Viewport 内（渲染 null）。
 */
export const ViewportScrollManager = () => {
  const live = useTurnLive();
  const anchorId = useAnchorId();
  const targetId = useTargetId();
  // live 变化不重建监听：重建会把「用户已让位」的状态一起丢掉
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const targetIdRef = useRef(targetId);
  useEffect(() => {
    targetIdRef.current = targetId;
  }, [targetId]);
  /** 收缩夹取后的钉顶暂停截止时刻：内容塌陷（重发截断/折叠）会让浏览器把
   *  scrollTop 夹到新 max；若紧接着再钉顶，会把视口重新拽回去，观感是
   *  「上下一跳」。暂停期内交给贴尾跟随，等新一轮内容长起来自然复位。 */
  const pinSuppressedUntilRef = useRef(0);

  useEffect(() => {
    if (!anchorId) return;
    const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    const group = viewport?.querySelector<HTMLElement>(GROUP_SELECTOR);
    if (!viewport || !group) return;

    // 贴底上限在内容节拍里缓存：scroll 路径只比一次 scrollTop。
    let maxTop = viewport.scrollHeight - viewport.clientHeight;
    /** 跟随权（管贴尾）：新一轮默认在跟随位——发起这一轮之前视口本来就在底部
     *  或被锚点钉着。不能拿"挂载那一刻的位置"当初值：挂载时正文已经在长了，
     *  位置没动也会显得"不在底部"，整轮跟不上（踩过）。 */
    let followed = true;
    /** 用户这一轮表达过滚动意图没有（管钉顶兜底）：一旦表达过，这一轮滚动权归用户 */
    let yielded = false;
    /** 目标消息元素（正在流的那条）：被投影换掉时重新查一次——isConnected 是
     *  廉价属性读，不触发布局；查不到返回 -1，此时不认为有流式增长 */
    let target: HTMLElement | null = null;
    let lastTargetHeight = 0;
    /** 最近一次滚动事件（框架 smooth 置顶、浏览器 scroll anchoring、用户手势
     *  都算）：钉顶写入只在它静默后做，避免与框架动画互相拉扯。 */
    let lastScrollAt = performance.now();
    let idleSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    /** 跳变留痕（仅 dev）：单次滚动事件位移 ≥24px 说明有一次性跳，记下前后值
     *  与内容高度，排查「回复开始时聊天区上下跳」用 */
    let lastSeenTop = viewport.scrollTop;
    const traceJump = (why: string) => {
      if (process.env.NODE_ENV === "production") return;
      const top = viewport.scrollTop;
      const delta = top - lastSeenTop;
      if (Math.abs(delta) >= 24) {
        reportFrontendWarning(
          `[scroll] ${why} ${Math.round(lastSeenTop)}→${Math.round(top)} (Δ${Math.round(delta)}, h=${viewport.scrollHeight}, ch=${viewport.clientHeight})`,
        );
      }
      lastSeenTop = top;
    };
    const scheduleIdleSettle = () => {
      if (disposed) return;
      if (idleSettleTimer) clearTimeout(idleSettleTimer);
      idleSettleTimer = setTimeout(() => {
        idleSettleTimer = null;
        if (!disposed) settle();
      }, PIN_SCROLL_IDLE_MS);
    };
    const measureTargetHeight = (): number => {
      if (!target?.isConnected) {
        target = viewport.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(targetIdRef.current)}"]`,
        );
      }
      return target ? target.getBoundingClientRect().height : -1;
    };

    const onScroll = () => {
      const prevTop = lastSeenTop;
      // 用户滚动的每一拍都只对齐跳变基准、不落日志（噪声太大）；留痕只管
      // 程序写入（钉顶/贴尾）那两处
      lastSeenTop = viewport.scrollTop;
      lastScrollAt = performance.now();
      // 只做接管不做让位：贴回底部就恢复跟随，让位由手势决定。这里读实时
      // 高度而不是缓存值——缓存落后于流式增长时会误判"还在底部"而回抢。
      maxTop = viewport.scrollHeight - viewport.clientHeight;
      // 内容变矮导致 scrollTop 被夹到新 max：这是重发截断/折叠的收缩信号。
      // 立刻钉顶会把视口再拽一次（上一下、下一下），暂停钉顶让跟随接管。
      if (
        viewport.scrollTop < prevTop - 2 &&
        Math.abs(viewport.scrollTop - maxTop) <= TOL_PX
      ) {
        pinSuppressedUntilRef.current = performance.now() + 1500;
        noteCount("视口-收缩夹取-暂停钉顶");
      }
      if (viewport.scrollTop >= maxTop - TOL_PX) {
        if (!followed) noteCount("视口-接管");
        followed = true;
      }
      // 滚动本身就是"置顶可能已经丢了"的证据（夹取、框架的平滑置顶被中断、
      // 别的组件跳转）：顺势补一次判定——只等内容节拍的话，置顶丢失时若内容
      // 恰好不再变化，这一拍永远不来（实测：破坏后 700ms 没人补回）
      noteCount("视口-滚动补判");
      settle();
    };
    /** 用户滚动意图入口 */
    const yieldToUser = () => {
      if (!yielded) noteCount("视口-让位");
      yielded = true;
      followed = false;
    };
    const onWheel = (event: WheelEvent) => {
      // 只认向上：向下滚是"我要回底部"，由位置判定接管
      if (event.deltaY < 0) yieldToUser();
    };
    const onPointerDown = (event: PointerEvent) => {
      // 目标就是视口本身 = 点在滚动条或内边距上（拖滚动条）；点消息内容不算
      if (event.target === viewport) yieldToUser();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target as Element | null;
      if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
      yieldToUser();
    };

    /** 钉顶阶段：垫片还在吃高度（正文还没超过视口）——框架的置顶只在
     *  anchorId 变化那一刻做一次，丢了就整轮不置顶，这里按内容节拍补。
     *  读 style 字符串不触发布局（垫片高度是框架写的内联样式）。 */
    const inPinPhase = (): boolean => {
      const reserve = viewport.querySelector<HTMLElement>(
        "[data-aui-top-anchor-reserve]",
      );
      return !!reserve && reserve.style.height !== "0px";
    };

    const settle = () => {
      // 拖拽调宽期间正文每帧 rewrap：逐帧 scrollHeight/scrollTop 读写会与
      // 布局互相踩踏，拖动中跳过内容节拍，松手后 resize-settled 补一次
      if (isResizing()) return;
      span("视口-节拍", settleInner);
    };

    const settleInner = () => {
      maxTop = viewport.scrollHeight - viewport.clientHeight;

      // 「正在流的那条消息自己在长」才算流式增长。展开折叠轮、检查点卡出现、
      // 图片加载、折叠收放都会让内容变高，但那不是流式输出：把视口补到底部
      // 会把用户消息顶出视野（"展开折叠轮把用户消息往上推"就是这么来的）。
      const targetHeight = measureTargetHeight();
      const targetGrew =
        lastTargetHeight > 0 && targetHeight > lastTargetHeight + GROW_TOL_PX;
      if (targetHeight > 0) lastTargetHeight = targetHeight;

      // 钉顶阶段优先，与贴尾互斥（靠垫片高度分界）：正文短于视口时视口只有
      // 一件事——把用户消息钉在顶部，更早的历史滚出上方、回复在下方展开。
      // 门只认「用户有没有自己滚过」，不认位置：用户正停在底部（followed）时
      // 恰恰最需要这次补钉——框架那次一次性置顶被空窗吃掉就没人再来补，
      // 表现就是"有时顶上去、有时不"（贴尾先接管会让它整轮顶不上去）。
      if (
        liveRef.current &&
        !yielded &&
        performance.now() >= pinSuppressedUntilRef.current &&
        inPinPhase()
      ) {
        // 框架新轮的 smooth 置顶/浏览器 scroll anchoring 正在动：这一拍只
        // 安排静默后补判，不写 scrollTop（两个写入者会互相拉扯 = 上下跳）
        if (performance.now() - lastScrollAt < PIN_SCROLL_IDLE_MS) {
          scheduleIdleSettle();
          return;
        }
        span("视口-钉顶写", () => {
          const anchor = viewport.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(anchorId)}"][data-aui-top-anchor-user]`,
          );
          if (!anchor) return;
          const delta =
            anchor.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top;
          if (delta <= TOL_PX) return; // 负值 = 已在上方（用户在往下读），不抢
          viewport.scrollTop += delta;
          traceJump("钉顶写");
          noteCount("视口-钉顶真滚");
        });
        return;
      }

      // 贴尾阶段：正文长过视口之后，每帧把差值补掉，让最新输出留在视野里。
      if (followed) {
        const slack = maxTop - viewport.scrollTop;
        if (slack > TOL_PX) {
          noteCount("视口-节拍-有差值");
          // 两道闸：只在流式进行中（轮结束后展开折叠轮不能被拽走），且高出来
          // 的必须是正在流的那条消息自己（流式中展开别处的块同理）
          if (!liveRef.current) {
            noteCount("视口-跳跟随-非流式");
            return;
          }
          if (!targetGrew) {
            noteCount("视口-跳跟随-非目标增长");
            return;
          }
          span("视口-贴尾写", () => {
            viewport.scrollTop += slack;
            traceJump("贴尾写");
          });
        }
        return;
      }

      // 两个阶段都不适用：用户在看历史，或这一轮已结束——视口归用户
    };

    yielders.add(yieldToUser);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchstart", yieldToUser, { passive: true });
    viewport.addEventListener("touchmove", yieldToUser, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(settle);
    observer.observe(group);
    const offSettled = onResizeSettled(settle);
    settle();
    return () => {
      disposed = true;
      if (idleSettleTimer) clearTimeout(idleSettleTimer);
      yielders.delete(yieldToUser);
      offSettled();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", yieldToUser);
      viewport.removeEventListener("touchmove", yieldToUser);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, [anchorId]);

  return null;
};
