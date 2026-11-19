"use client";

/**
 * 桌宠悬浮窗路由（独立透明置顶小窗的页面，dev: /pet-window，生产: kova://app/pet-window）。
 *
 * 与主窗口的关系：
 * - **事件**：独立渲染进程听不到 agent-events 总线，主进程把转发链投递的
 *   `pet-agent-event` 经 kova-event 通道送来，这里 `listen` 订阅；
 * - **气泡跳会话**：点气泡 → 桥 `pet_focus_session` → 主进程聚焦主窗口并广播
 *   `pet-open-session`（主窗口 PetDock 接收后 requestOpenSession）；
 * - **点击穿透**：窗口默认 ignoreMouseEvents(forward)，本页在 pointermove 里
 *   命中测试 `data-pet-interactive`，经桥开关穿透——空白区域不吃点击；
 *   Windows 不支持可靠的穿透（见主进程），整窗可点击，留白也接拖拽。
 * - **拖拽**：程序化协议（拖身体或窗内留白均可）——pointerdown → `pet_window_begin_drag`
 *   记基点，pointermove 把累计偏移交给 `pet_window_move_offset`，pointerup 收尾。
 *   刻意不用 -webkit-app-region：它与穿透开关有按下时序竞争，浏览器里也无效；
 *   Windows 上 focusable:false 的窗用 app-region 更不稳定。按下时显式
 *   setPointerCapture，窗口被拎着走时指针甩出窗框也收得到 pointerup。
 *   拖身体时 `dragging` 传给宠物，播左右跑动画（对齐 Codex 的拖拽表达）。
 *
 * 非桌面（浏览器直开本路由）：宠物照常渲染作预览，穿透/桥相关全部跳过。
 */

import * as React from "react";
import { listen } from "@/desktop-bridge/event";
import { invokeBridge } from "@/desktop-bridge/_host";
import {
  beginPetDrag,
  petContextMenu,
  endPetDrag,
  focusPetMainWindow,
  focusPetSession,
  movePetWindowOffset,
  openPetSettings,
  setPetIgnoreMouse,
  setPetWindowSize,
  type PetAgentEventFrame,
} from "@/desktop-bridge/pet";
import { PetWidget } from "@/components/pet/pet-widget";
import type { PetEventSubscribe } from "@/components/pet/use-pet-agent-events";
import { usePetPrefs } from "@/lib/settings/pet-prefs";
import { isDesktop, isWindowsPlatform } from "@/lib/desktop-env";

/** 悬浮窗事件源：主进程转发链（模块级稳定引用）。 */
const bridgeEventsSubscribe: PetEventSubscribe = (cb) => {
  if (!isDesktop()) return () => undefined;
  let cancelled = false;
  let off: (() => void) | null = null;
  void listen<PetAgentEventFrame>("pet-agent-event", (e) => {
    cb(e.payload);
  }).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
};

export default function PetWindowPage() {
  const prefs = usePetPrefs();
  const [dragging, setDragging] = React.useState(false);
  const dragStartRef = React.useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const lastSentRef = React.useRef<{ ox: number; oy: number } | null>(null);
  const lastPosRef = React.useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = React.useState<boolean | "left" | "right" | "up" | "down">(false);
  // 拖拽期间命中测试不得把穿透重新打开：pointerup 不被 forward 转发，
  // 穿透一开拖拽就永久卡死（松手事件丢了）
  const dragActiveRef = React.useRef(false);
  // 拖过的那次 click 要拦掉（capture 阶段），否则拖着身子松手还会白白挥个手
  const dragMovedRef = React.useRef(false);
  // 显式 Pointer Capture 的落点：lostpointercapture 时据此判断是不是自己的拖拽
  const captureRef = React.useRef<{ el: HTMLElement; pointerId: number } | null>(null);

  /* 点击穿透：命中宠物/气泡 → 可点击；其余区域 → 透传给下层窗口。
     forward:true 保证忽略期间本页仍收得到 pointermove，命中测试不会瞎。 */
  React.useEffect(() => {
    // Windows 不走穿透（见主进程说明）：窗口整块可点击，无需命中测试
    if (!isDesktop() || isWindowsPlatform()) return undefined;
    let last: boolean | null = null;
    let inFlight = false;
    const onMove = (event: PointerEvent) => {
      if (dragActiveRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      // 别写成 target?.closest(...) !== null：target 为空时会误判成"在宠物上"
      const over = target !== null && target.closest("[data-pet-interactive]") !== null;
      if (over === last || inFlight) return;
      last = over;
      inFlight = true;
      void setPetIgnoreMouse(!over)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  /* 生命周期自管理：悬浮窗自己跟着模式显隐，绝不留一个空壳浮在桌面上——
     mode floating = 显示宠物；inline/off/未选宠物 = 窗口自动隐藏（不销毁，
     切回秒回）。未选宠物必须藏：Windows 上整窗吃点击，空窗就是一块看不见的
     点击遮挡区。显示动作由主窗口 PetDock 的模式 effect 负责（showPetWindow）。 */
  React.useEffect(() => {
    if (!isDesktop()) return;
    if (prefs.mode === "floating" && prefs.configUrl !== "") return;
    void invokeBridge("win_hide").catch(() => {});
  }, [prefs.mode, prefs.configUrl]);

  /* 画布跟随显示尺寸：slider 拉多大，窗口就多大（主进程 clamp 在工作区内）。
     高度额外留出气泡头部空间（~56px）——否则气泡会被窗口上缘裁掉。 */
  React.useEffect(() => {
    if (!isDesktop() || prefs.mode !== "floating") return;
    const width = prefs.size + 24;
    const height = Math.round((prefs.size * 208) / 192) + 24 + 56;
    void setPetWindowSize(width, height).catch(() => {});
  }, [prefs.mode, prefs.size]);

  /* 程序化拖窗：按下的那一刻基点已在主进程备好，move 只发相对偏移。
     按下时显式 setPointerCapture——窗口被 setPosition 拎着走，指针甩出窗框
     （或越过屏幕边缘）时仍能收到 pointerup，拖拽态不会永久卡住。 */
  const beginDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isDesktop() || event.button !== 0) return;
      const el = event.currentTarget;
      try {
        el.setPointerCapture(event.pointerId);
        captureRef.current = { el, pointerId: event.pointerId };
      } catch {
        // 浏览器直开/指针已失效：退回 window 监听，拖拽照常
        captureRef.current = null;
      }
      dragStartRef.current = { sx: event.screenX, sy: event.screenY, ox: 0, oy: 0 };
      lastSentRef.current = null;
      lastPosRef.current = { x: event.screenX, y: event.screenY };
      dragMovedRef.current = false;
      dragActiveRef.current = true;
      void beginPetDrag().catch(() => {
        dragStartRef.current = null;
        dragActiveRef.current = false;
      });
      setDragging(true);
    },
    [],
  );

  React.useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const ox = event.screenX - start.sx;
      const oy = event.screenY - start.sy;
      if (Math.hypot(ox, oy) >= 5) dragMovedRef.current = true;
      // 四向判定（1px 死区防抖）：水平 → 左右行走；竖直 → 跳跃（拎起/落下）
      if (lastPosRef.current !== null) {
        const stepX = event.screenX - lastPosRef.current.x;
        const stepY = event.screenY - lastPosRef.current.y;
        if (Math.abs(stepX) > 1 && Math.abs(stepX) >= Math.abs(stepY)) {
          setDrag(stepX > 0 ? "right" : "left");
        } else if (Math.abs(stepY) > 1) {
          setDrag(stepY > 0 ? "down" : "up");
        }
      }
      lastPosRef.current = { x: event.screenX, y: event.screenY };
      const last = lastSentRef.current;
      if (last !== null && last.ox === ox && last.oy === oy) return;
      lastSentRef.current = { ox, oy };
      void movePetWindowOffset(ox, oy).catch(() => {});
    };
    const onUp = () => {
      // pointerup / lostpointercapture / blur 可能重复到达：收尾动作本身幂等
      dragStartRef.current = null;
      dragActiveRef.current = false;
      lastPosRef.current = null;
      setDrag(false);
      setDragging(false);
      const cap = captureRef.current;
      captureRef.current = null;
      if (cap !== null) {
        try {
          cap.el.releasePointerCapture(cap.pointerId);
        } catch {
          // 已被浏览器隐式释放
        }
      }
      // 拖留白区域时 click 落在 main 上，不经过 wrapper 的 capture 拦截：
      // 一拍后主动清标记，别让这次拖拽吞掉下一次宠物点击（拖身体时
      // wrapper 的 onClickCapture 会同步清掉，这里清也是无害的）
      const moved = dragMovedRef.current;
      if (moved) {
        window.setTimeout(() => {
          dragMovedRef.current = false;
        }, 0);
      }
      void endPetDrag().catch(() => {});
    };
    const onLostCapture = (event: PointerEvent) => {
      if (captureRef.current?.pointerId === event.pointerId) onUp();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // 兜底：Pointer Capture 被系统/浏览器抢走时也收尾（否则 dragging 永久为真）
    window.addEventListener("lostpointercapture", onLostCapture);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("lostpointercapture", onLostCapture);
      window.removeEventListener("blur", onUp);
    };
  }, [dragging]);

  /* Windows 上整窗可点击（没有穿透）：留白区域也接拖拽，把窗口变成一个大号
     抓手——宠物本体的命中框只有中间一小块，只靠它拖容易"抓空"。 */
  const onBackgroundPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isDesktop() || !isWindowsPlatform() || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target.closest("[data-pet-interactive]") !== null) return;
      beginDrag(event);
    },
    [beginDrag],
  );

  /** 拖过的那次 click 截停在 capture 阶段：拖完松手不该白白挥个手。 */
  const onClickCapture = React.useCallback((event: React.MouseEvent) => {
    if (dragMovedRef.current) {
      event.stopPropagation();
      dragMovedRef.current = false;
    }
  }, []);

  /** 左键点宠物：唤起主窗口（对齐 Codex 的"一键回主界面"）。 */
  const onPetClick = React.useCallback(() => {
    if (!isDesktop()) return;
    void focusPetMainWindow().catch(() => {});
  }, []);

  /* 右键弹系统原生菜单（OS 层浮层，不遮宠物本体，也没有裁剪问题）。
     动作在主进程执行：open-settings / set-mode:* 由主进程处理或转播回窗口。 */
  const onHitboxContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    void petContextMenu([
      { label: "打开设置", action: "open-settings" },
      { label: "切回应用内", action: "set-mode:inline" },
      { label: "关闭桌宠", action: "set-mode:off" },
    ]).catch(() => {});
  }, []);

  return (
    <main
      onPointerDown={onBackgroundPointerDown}
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Windows 整窗可拖（含透明留白）；macOS 留白走穿透，不显示抓取光标
        cursor: isWindowsPlatform() ? (dragging ? "grabbing" : "grab") : undefined,
      }}
    >
      {/* dev 期 Next 调试按钮在透明小窗上非常突兀（且会盖住右键菜单）：本窗内隐藏 */}
      <style>{`nextjs-portal{display:none!important}`}</style>
      {/* 对齐 Codex：悬浮窗上没有任何 chrome——没有拖拽条、没有关闭钮、没有提示文案。
          拖宠物身体或窗口留白即移动；左键点宠物唤起主窗；右键是菜单；关闭走右键/托盘/设置。 */}
      {prefs.mode === "floating" && prefs.configUrl !== "" ? (
        <div onClickCapture={onClickCapture} onClick={onPetClick}>
          <PetWidget
            variant="floating"
            manifest={prefs.configUrl}
            size={prefs.size}
            subscribeEvents={bridgeEventsSubscribe}
            onOpenSession={(sessionId) => {
              void focusPetSession(sessionId).catch(() => {});
            }}
            dragging={drag || dragging}
            onHitboxPointerDown={beginDrag}
            onContextMenu={onHitboxContextMenu}
          />
        </div>
      ) : null}
    </main>
  );
}
