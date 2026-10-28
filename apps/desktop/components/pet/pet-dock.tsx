"use client";

/**
 * 主窗口内嵌桌宠（常驻在对话主栏内，可拖拽换位）。
 *
 * 职责三件，无论开关与否都要活着的两件放在最前面：
 * 1. **事件转发**（startPetEventRelay）：悬浮窗听不到主窗口内存总线，靠这里
 *    把 agent 事件转给主进程——即使内嵌宠物被关掉，悬浮窗照样收得到；
 * 2. **气泡跳会话接收**：悬浮窗点气泡 → 桥聚焦主窗口 + `pet-open-session`
 *    事件 → 这里 `requestOpenSession` 打开会话（复用通知点击的等价路径）；
 * 3. 内嵌本体：偏好开着才渲染，事件直连 `subscribeAgentEvents`（不走转发链）。
 *
 * 拖拽是页面内的（fixed 偏移），与悬浮窗的跨进程拖窗协议无关：
 * - **拖拽边界 = 对话主栏**（`data-chat-card`，即侧边栏与右面板之间的红框区），
 *   宠物永远完整落在主栏内，不会跑到消息内容之外压住面板/侧栏；
 * - 5px 阈值内算点击（单击插播 waving 照常生效），超过才算拖；拖到哪停哪，
 *   位置以右/下边距持久化（pet-prefs.dock），并对主栏尺寸变化（开合面板/
 *   缩放窗口）自动重钳；
 * - 首次使用（无持久化位置）默认停在主栏右下角。
 */

import * as React from "react";
import { listen } from "@/desktop-bridge/event";
import { hidePetWindow, petContextMenu, showPetWindow } from "@/desktop-bridge/pet";
import { PetWidget } from "@/components/pet/pet-widget";
import type { PetEventSubscribe } from "@/components/pet/use-pet-agent-events";
import { startPetEventRelay } from "@/lib/pet/relay";
import { usePetLibrary } from "@/lib/pet/library";
import { patchPetPrefs, usePetPrefs, type PetMode } from "@/lib/settings/pet-prefs";
import { subscribeAgentEvents, type AgentEvent } from "@/lib/pi/agent-events";
import { requestOpenSession } from "@/lib/pi/open-session";
import { isDesktop } from "@/lib/desktop-env";

const DRAG_THRESHOLD = 5;
/** 停靠位离主栏边缘的距离 */
const DOCK_MARGIN = 16;

/** 拖拽边界：视口坐标下的矩形（取不到主栏时退回整个视口）。 */
interface BoundsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 拖拽边界 = 对话主栏（红框区）；元素未挂载/零尺寸时退回整个视口。 */
function getBoundsRect(): BoundsRect {
  const el = document.querySelector("[data-chat-card]");
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/** 右边距 clamp：宠物右缘不越过主栏右缘 - GAP，左缘不越过主栏左缘 + GAP。 */
function clampRight(margin: number, petWidth: number, bounds: BoundsRect, viewportWidth: number): number {
  const lo = viewportWidth - bounds.right + DOCK_MARGIN;
  const hi = viewportWidth - bounds.left - DOCK_MARGIN - petWidth;
  if (hi < lo) return Math.round((lo + hi) / 2); // 主栏比宠物还窄：取中
  return Math.min(Math.max(Math.round(margin), lo), hi);
}

/** 下边距 clamp：同理，纵向。 */
function clampBottom(margin: number, petHeight: number, bounds: BoundsRect, viewportHeight: number): number {
  const lo = viewportHeight - bounds.bottom + DOCK_MARGIN;
  const hi = viewportHeight - bounds.top - DOCK_MARGIN - petHeight;
  if (hi < lo) return Math.round((lo + hi) / 2);
  return Math.min(Math.max(Math.round(margin), lo), hi);
}

/** 主栏右下角停靠位（首次使用/位置失效时的默认落点）。 */
function defaultDockInBounds(bounds: BoundsRect, viewportWidth: number, viewportHeight: number) {
  return {
    right: viewportWidth - bounds.right + DOCK_MARGIN,
    bottom: viewportHeight - bounds.bottom + DOCK_MARGIN,
  };
}

const agentEventsSubscribe: PetEventSubscribe = (cb) =>
  subscribeAgentEvents((event: AgentEvent) => {
    cb({
      name: event.name,
      threadId: event.threadId,
      data: event.data,
      occurredAt: event.occurredAt,
    });
  });

export function PetDock() {
  const prefs = usePetPrefs();
  // 宠物只来自目录/自定义：未选择时自动落目录第一只（没有就什么都不显示）
  const library = usePetLibrary(0);
  React.useEffect(() => {
    if (prefs.configUrl === "" && library.pets.length > 0) {
      patchPetPrefs({ configUrl: library.pets[0]!.configUrl });
    }
  }, [prefs.configUrl, library.pets]);
  // 网页/远程端没有窗口系统，"独立悬浮窗"模式回落为应用内角标，避免宠物凭空消失
  const effectiveMode: PetMode = !isDesktop() && prefs.mode === "floating" ? "inline" : prefs.mode;

  React.useEffect(() => {
    startPetEventRelay();
  }, []);

  React.useEffect(() => {
    // 悬浮窗气泡点击 → 主进程聚焦主窗口并广播 pet-open-session → 这里打开会话
    if (!isDesktop()) return undefined;
    let cancelled = false;
    let off: (() => void) | null = null;
    void listen<{ sessionId: string }>("pet-open-session", (e) => {
      if (typeof e.payload?.sessionId === "string") requestOpenSession(e.payload.sessionId);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  React.useEffect(() => {
    // 悬浮窗右键「打开设置」→ 主进程聚焦主窗口并广播 → 这里跳桌宠分区
    if (!isDesktop()) return undefined;
    let cancelled = false;
    let off: (() => void) | null = null;
    void listen("pet-open-settings", () => {
      window.dispatchEvent(new CustomEvent("kova:open-settings-section", { detail: "pet" }));
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  React.useEffect(() => {
    // 托盘「桌宠 显示/隐藏」：off ↔ 上次形态（模式是唯一事实源，显隐随之自动化）
    if (!isDesktop()) return undefined;
    let cancelled = false;
    let off: (() => void) | null = null;
    void listen("pet-tray-toggle-pet", () => {
      const next = prefs.mode === "off" ? prefs.lastNonOffMode : "off";
      patchPetPrefs({ mode: next });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [prefs.mode, prefs.lastNonOffMode]);

  // 模式是唯一事实源：切到悬浮窗自动开窗，切走自动关（托盘手动开的窗不受影响）。
  // 用原始偏好驱动（网页端切悬浮窗不产生窗口操作）。
  React.useEffect(() => {
    if (!isDesktop()) return;
    if (prefs.mode === "floating") void showPetWindow().catch(() => {});
    else void hidePetWindow().catch(() => {});
  }, [prefs.mode]);

  /* ---- 页面内拖拽：5px 阈值分投票/拖，边界锁定对话主栏，位置持久化 ---- */

  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    sx: number;
    sy: number;
    baseRight: number;
    baseBottom: number;
    width: number;
    height: number;
    bounds: BoundsRect;
    viewportWidth: number;
    viewportHeight: number;
  } | null>(null);
  const movedRef = React.useRef(false);
  const lastPosRef = React.useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = React.useState<boolean | "left" | "right" | "up" | "down">(false);
  /** 右键弹系统原生菜单（OS 层浮层，不遮宠物；动作在主进程执行/转播）。 */
  const onHitboxContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    void petContextMenu([
      { label: "打开设置", action: "open-settings" },
      ...(isDesktop() ? [{ label: "切换到悬浮窗", action: "set-mode:floating" }] : []),
      { label: "收起桌宠", action: "set-mode:off" },
    ]).catch(() => {});
  }, []);

  const onHitboxPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    dragRef.current = {
      sx: event.clientX,
      sy: event.clientY,
      baseRight: window.innerWidth - rect.right,
      baseBottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
      bounds: getBoundsRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
    lastPosRef.current = { x: event.clientX, y: event.clientY };
    movedRef.current = false;
  }, []);

  // 位置自愈：持久化位置可能落在主栏外（主栏宽度随面板开合/窗口缩放变化、
  // 旧数据），挂载与主栏尺寸变化时按边界重钳，保证宠物永远完整停在红框内
  React.useEffect(() => {
    if (effectiveMode !== "inline") return undefined;
    const validate = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const bounds = getBoundsRect();
      const rect = wrapper.getBoundingClientRect();
      if (rect.width === 0) return;
      if (!prefs.dock) {
        // 首次使用：落主栏右下角
        patchPetPrefs({ dock: defaultDockInBounds(bounds, window.innerWidth, window.innerHeight) });
        return;
      }
      const maxRight = window.innerWidth - bounds.left - DOCK_MARGIN - rect.width;
      const minRight = window.innerWidth - bounds.right + DOCK_MARGIN;
      const maxBottom = window.innerHeight - bounds.top - DOCK_MARGIN - rect.height;
      const minBottom = window.innerHeight - bounds.bottom + DOCK_MARGIN;
      if (
        prefs.dock.right > maxRight ||
        prefs.dock.right < minRight ||
        prefs.dock.bottom > maxBottom ||
        prefs.dock.bottom < minBottom
      ) {
        patchPetPrefs({
          dock: {
            right: clampRight(prefs.dock.right, rect.width, bounds, window.innerWidth),
            bottom: clampBottom(prefs.dock.bottom, rect.height, bounds, window.innerHeight),
          },
        });
      }
    };
    validate();
    // 主栏尺寸变化（面板开合、窗口缩放）不一定触发 window resize：直接观察主栏元素
    const boundsEl = document.querySelector("[data-chat-card]");
    const observer = boundsEl ? new ResizeObserver(validate) : null;
    if (boundsEl && observer) observer.observe(boundsEl);
    window.addEventListener("resize", validate);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", validate);
    };
    // 依赖取原始值：拖拽期间每个 pointermove 都会 patch dock，对象引用当依赖
    // 会让本 effect（含 ResizeObserver 重挂）跟着每次移动重跑
    // eslint-disable-next-line react/exhaustive-deps -- dock 的两个原始字段就是完整语义
  }, [effectiveMode, prefs.dock?.right, prefs.dock?.bottom]);

  React.useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;
      const dx = event.clientX - start.sx;
      const dy = event.clientY - start.sy;
      if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!movedRef.current) {
        movedRef.current = true;
        setDragging(true);
      }
      // 四向判定（1px 死区防抖）：水平 → 左右行走；竖直 → 跳跃（拎起/落下）
      if (lastPosRef.current !== null) {
        const stepX = event.clientX - lastPosRef.current.x;
        const stepY = event.clientY - lastPosRef.current.y;
        if (Math.abs(stepX) > 1 && Math.abs(stepX) >= Math.abs(stepY)) {
          setDragging(stepX > 0 ? "right" : "left");
        } else if (Math.abs(stepY) > 1) {
          setDragging(stepY > 0 ? "down" : "up");
        }
      }
      lastPosRef.current = { x: event.clientX, y: event.clientY };
      patchPetPrefs({
        dock: {
          right: clampRight(start.baseRight - dx, start.width, start.bounds, start.viewportWidth),
          bottom: clampBottom(start.baseBottom - dy, start.height, start.bounds, start.viewportHeight),
        },
      });
    };
    const onUp = () => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      lastPosRef.current = null;
      // click 事件在 pointerup 之后派发：拖过的这次要拦掉，别让宠物白白挥个手
      const moved = movedRef.current;
      setDragging(false);
      if (moved) {
        window.setTimeout(() => {
          movedRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  /** 拖过的那次 click 到不了 Pet 的 onClick（capture 阶段截停），单击不受影响。 */
  const onClickCapture = React.useCallback((event: React.MouseEvent) => {
    if (movedRef.current) {
      event.stopPropagation();
      movedRef.current = false;
    }
  }, []);

  if (effectiveMode !== "inline" || prefs.configUrl === "") return null;
  const dock = prefs.dock;

  /** 右键菜单：打开设置 / 切到悬浮窗（桌面）/ 收起 */

  return (
    <div
      className="pointer-events-none fixed z-40"
      style={{ right: dock?.right ?? DOCK_MARGIN, bottom: dock?.bottom ?? DOCK_MARGIN }}
    >
      <div
        ref={wrapperRef}
        data-dragging={dragging || undefined}
        className="pointer-events-auto"
        onClickCapture={onClickCapture}
      >
        <PetWidget
          variant="inline"
          manifest={prefs.configUrl}
          size={prefs.size}
          subscribeEvents={agentEventsSubscribe}
          onOpenSession={(sessionId) => requestOpenSession(sessionId)}
          dragging={dragging}
          onHitboxPointerDown={onHitboxPointerDown}
          onContextMenu={onHitboxContextMenu}
        />
      </div>
    </div>
  );
}
