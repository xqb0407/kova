"use client";

// 顶部锚点的兜底重放（turnAnchor="top" 的可靠性补丁）。
//
// 框架的置顶是一次性的：只有「锚点消息 id 变了」才滚一次（见 @assistant-ui/react
// 的 mountTopAnchorReserve）。而锚点元素与垫片的注册条件是 thread.isRunning
// ——本应用里 isRunning 由「快照权威」推导（threadState.applySnapshot 按
// metadata.status 覆盖 runStatus），运行中会短暂被打回 idle（空窗，代码里
// 多处注释记录过这个现象）。空窗一来：锚点/垫片被拆掉，垫片一撤内容缩回视口
// 高度以内，浏览器把 scrollTop 夹回顶部；空窗结束后它们重新挂上，可那一次
// 性的滚动机会已经消耗掉了——于是整轮都不置顶。是否撞上空窗看时序，表现就是
// 「有时顶上去、有时不」。
//
// 这里补的正是这一下：只在「框架锚点已挂上」（说明垫片在、位置可达）且新用户
// 消息位于视口顶部**下方**时补滚一次；一旦看到用户自己的滚动手势（滚轮/触摸/
// 键盘翻页/拖拽内容）就整轮让位——与框架语义一致：钉住之后滚动权归用户。
// 不往上看（锚点顶边高于视口顶部）时不动：那是用户在往下读正文，或是框架对
// 超高用户消息的有意过滚（topAnchorMessageClamp），补滚会与它打架。

import { useAuiState } from "@assistant-ui/react";
import { useEffect } from "react";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
/** 位置容差：框架自己滚到位后这里不再动作 */
const TOLERANCE_PX = 4;
/** 复检节拍：够松，不与框架的平滑滚动抢帧；撞上空窗也能在一个节拍内补回 */
const RECHECK_MS = 350;
/** 用户滚动键（不含方向键上下之外的编辑键；文本框内的按键另按目标元素过滤） */
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

/**
 * 挂载点：ThreadPrimitive.Viewport 内（渲染 null）。锚点候选与框架
 * getActiveTopAnchorTurn 同口径：运行中、末两条为「user + assistant」。
 */
export const TopAnchorKeeper = () => {
  const anchorId = useAuiState((s) =>
    s.thread.isRunning &&
    s.thread.messages.at(-1)?.role === "assistant" &&
    s.thread.messages.at(-2)?.role === "user"
      ? String(s.thread.messages.at(-2)?.id ?? "")
      : "",
  );

  useEffect(() => {
    if (!anchorId) return;
    const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!viewport) return;

    let yielded = false;
    const yieldToUser = () => {
      yielded = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      const target = event.target as Element | null;
      if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
      yieldToUser();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
      yieldToUser();
    };

    const repin = () => {
      if (yielded) return;
      const anchor = viewport.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchorId)}"][data-aui-top-anchor-user]`,
      );
      // 框架锚点没挂上（首 token 前 / 空窗中）：不抢滚动——垫片不在位时也钉不住
      if (!anchor) return;
      const delta =
        anchor.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top;
      if (delta <= TOLERANCE_PX) return;
      viewport.scrollTo({
        top: viewport.scrollTop + delta,
        behavior: "smooth",
      });
    };

    viewport.addEventListener("wheel", yieldToUser, { passive: true });
    viewport.addEventListener("touchstart", yieldToUser, { passive: true });
    viewport.addEventListener("touchmove", yieldToUser, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("pointerdown", onPointerDown);
    const timer = setInterval(repin, RECHECK_MS);
    repin();
    return () => {
      viewport.removeEventListener("wheel", yieldToUser);
      viewport.removeEventListener("touchstart", yieldToUser);
      viewport.removeEventListener("touchmove", yieldToUser);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("pointerdown", onPointerDown);
      clearInterval(timer);
    };
  }, [anchorId]);

  return null;
};
