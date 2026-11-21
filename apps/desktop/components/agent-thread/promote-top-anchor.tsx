"use client";

import { useAuiState, useThreadViewportStore } from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  clampFor,
  THREAD_FOOTER_SELECTOR,
  topAnchorScrollTop,
  viewportUsableHeight,
} from "@/lib/ui/top-anchor-target";
import {
  clearPromoteAnchor,
  usePromoteAnchorBaseline,
} from "@/lib/ui/promote-anchor";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const GROUP_SELECTOR = '[data-slot="aui_message-group"]';
const USER_ROOT_SELECTOR = '[data-slot="aui_user-message-root"]';
/** 位置容差（与框架 snapScrollTop 同量级） */
const TOL_PX = 1;
/** 等框架建垫片的最长拍数：正常 1-2 拍，超时交回框架自己的平滑滚动 */
const MAX_PIN_FRAMES = 30;
/** 线程回到空闲多久后判定这一轮不会有回复（失败路径），撤掉临时锚点 */
const IDLE_CLEAR_MS = 2000;
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
/** 交互元素内的 pointerdown 不算「用户要滚视图」（点按钮/开折叠/点输入框） */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, summary, [role='button'], [contenteditable]";

/**
 * 「立即发送」时的临时顶部锚点 target。
 *
 * 框架的顶部锚点要等 assistant 消息（target）挂载才成立，垫片（把用户消息顶到
 * 视口顶部所需的空白）也随之才有。promote 的气泡上屏时回复还没开始，于是：
 * 气泡先落在底部 → 首个 token 到达 → 框架建垫片并做一次 smooth 置顶。
 * 用户看到的「先出去、再慢慢拉到视口」就是后半段。
 *
 * 这里在气泡上屏的那一帧先登记一个零高 target，让框架立刻把垫片建出来；
 * 下一帧（框架写垫片之后、paint 之前）直接把视口写到顶部锚点位置，抢在
 * 框架的 smooth 滚动之前——目标一致时它不会再补动画。回复消息一出现，临时
 * target 让位给真正的 assistant 消息，垫片与后续跟随交还框架。
 *
 * 等待窗口里上一轮过程折叠 / 队列行消失会挪动锚点，用 ResizeObserver 保持
 * 钉位；用户一动手（滚轮/触摸/翻页键/拖滚动条）立即交还。
 */
export const PromoteTopAnchor = () => {
  const store = useThreadViewportStore();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const lastRole = useAuiState((s) => s.thread.messages.at(-1)?.role);
  const lastMessageId = useAuiState((s) =>
    String(s.thread.messages.at(-1)?.id ?? ""),
  );
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // baseline = 点击 promote 时的最后一条消息 id：只有它换成新气泡才接管
  //（压缩分隔线等插入不会误触发，见 lib/ui/promote-anchor）
  const baselineLastId = usePromoteAnchorBaseline(threadId);
  const armed = baselineLastId !== null;
  const active =
    armed && lastMessageId !== baselineLastId && lastRole === "user";
  const spacerRef = useRef<HTMLDivElement>(null);

  // 真正的 assistant 消息出现：target 让位，锚点交还框架
  useEffect(() => {
    if (armed && lastRole === "assistant") clearPromoteAnchor();
  }, [armed, lastRole]);

  // 起跑后线程回到空闲（无回复的失败路径）：别把临时锚点/空白常驻下去
  useEffect(() => {
    if (!active || isRunning) return;
    const timer = window.setTimeout(clearPromoteAnchor, IDLE_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [active, isRunning]);

  useLayoutEffect(() => {
    if (!active) return;
    const spacer = spacerRef.current;
    if (!spacer) return;
    const viewport = spacer.closest<HTMLElement>(VIEWPORT_SELECTOR);
    const group = viewport?.querySelector<HTMLElement>(GROUP_SELECTOR);
    if (!viewport || !group) return;

    // 乐观镜像会被真实回显替换成新节点：每拍重查最后一个用户气泡
    let registered: HTMLElement | null = null;
    let unregisterAnchor: (() => void) | null = null;
    const resolveAnchor = (): HTMLElement | null => {
      const roots = group.querySelectorAll<HTMLElement>(USER_ROOT_SELECTOR);
      const next = roots[roots.length - 1] ?? null;
      if (next && next !== registered) {
        unregisterAnchor = store.getState().registerAnchorElement(next);
        registered = next;
      }
      return next;
    };
    if (!resolveAnchor()) return;

    // 临时 target：框架据此建立垫片（anchor + target + clamp 齐全才生效）
    const unregisterTarget = store
      .getState()
      .registerAnchorTargetElement(
        spacer,
        clampFor(viewportUsableHeight(viewport)),
      );

    let yielded = false;
    const yieldToUser = () => {
      yielded = true;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) yieldToUser();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      if ((event.target as Element | null)?.closest?.(INTERACTIVE_SELECTOR)) {
        return;
      }
      yieldToUser();
    };
    const onPointerDown = (event: PointerEvent) => {
      // 目标就是视口本身 = 点在滚动条或内边距上（拖滚动条）
      if (event.target === viewport) yieldToUser();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchstart", yieldToUser, { passive: true });
    viewport.addEventListener("touchmove", yieldToUser, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("pointerdown", onPointerDown);

    /** 已把气泡写到顶部锚点位置（此后才启用高度变化的钉位保持） */
    let pinned = false;
    let frames = 0;
    let stable = 0;
    let raf = 0;
    const pin = () => {
      raf = 0;
      if (yielded || !viewport.isConnected) return;
      const anchor = resolveAnchor();
      if (!anchor) return;
      const target = Math.round(topAnchorScrollTop(viewport, anchor));
      // 垫片还没写出来时目标不可达：等下一拍，别先写一个被夹住的位置
      const reachable =
        target <= viewport.scrollHeight - viewport.clientHeight + TOL_PX;
      if (reachable) {
        if (Math.abs(viewport.scrollTop - target) > TOL_PX) {
          viewport.scrollTop = target;
          pinned = true;
          stable = 0;
        } else if (pinned && ++stable >= 2) {
          return; // 连续两帧到位：后续由框架的锚点校验接管
        }
      }
      frames += 1;
      if (frames <= MAX_PIN_FRAMES) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);

    // 等待窗口内上方内容变化（上一轮过程折叠、队列行消失）会挪动锚点：
    // 保持它钉在顶部锚点位置；用户一动手就不再回抢（yielded）。
    // 比的是「目标 scrollTop」而不是锚点顶边——超高气泡的目标本身是有意
    // 过滚（只保留底部 visibleHeight），按顶边比会把它拉回去。
    const groupObserver = new ResizeObserver(() => {
      if (yielded || !pinned) return;
      const anchor = resolveAnchor();
      if (!anchor) return;
      const target = Math.round(topAnchorScrollTop(viewport, anchor));
      // 目标暂不可达（页脚刚变、垫片还没补）：等框架补完垫片引发的下一拍
      if (target > viewport.scrollHeight - viewport.clientHeight + TOL_PX) {
        return;
      }
      if (Math.abs(viewport.scrollTop - target) > TOL_PX) {
        viewport.scrollTop = target;
      }
    });
    groupObserver.observe(group);
    // 页脚高度（队列行消失/输入框变高）会改变可达高度：垫片要等框架下一拍
    // 才补齐，这期间先按新目标保住锚点；视口尺寸变化同理
    const footer = viewport.querySelector<HTMLElement>(THREAD_FOOTER_SELECTOR);
    if (footer) groupObserver.observe(footer);
    groupObserver.observe(viewport);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      groupObserver.disconnect();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", yieldToUser);
      viewport.removeEventListener("touchmove", yieldToUser);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("pointerdown", onPointerDown);
      // 真正的 target 已登记（回复出现）：锚点/垫片都归框架管，别再撤锚点
      // （同一元素上框架的登记与我们的登记共用槽位，撤了会把它的也清掉）
      const frameworkOwnsTarget = store.getState().element.target !== spacer;
      unregisterTarget();
      if (!frameworkOwnsTarget) unregisterAnchor?.();
    };
    // lastMessageId：乐观气泡被真实回显替换时节点会换，重跑一次把锚点
    // 登记指到新节点（同 id 内的流式更新不触发）
  }, [active, lastMessageId, store]);

  return active ? (
    <div
      ref={spacerRef}
      aria-hidden
      className="pointer-events-none"
      data-slot="aui_promote-top-anchor-target"
    />
  ) : null;
};
