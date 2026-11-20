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
 * - **拖拽**：程序化协议——pointerdown → `pet_window_begin_drag` 记基点，
 *   pointermove 按帧请求主进程重算位置，pointerup 收尾。
 *   窗口位移由**主进程采样系统光标**计算（`screen.getCursorScreenPoint`），
 *   不信任渲染层的 screenX——Windows 透明/无焦点窗下它可能恒为 0，导致
 *   偏移永远是 0、窗口拖不动。
 *   刻意不用 -webkit-app-region：它与穿透开关有按下时序竞争，浏览器里也无效；
 *   Windows 上 focusable:false 的窗用 app-region 更不稳定。按住期间交给 OS
 *   隐式捕获（鼠标事件继续投递到本页，指针甩出窗框也能收到 pointerup）；
 *   不用显式 setPointerCapture——窗口被 setPosition 拎着走时 capture 可能被
 *   释放，且会把 click 目标改成捕获元素，宠物本体 onClick 失效。
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
  // 拖拽期间累计的物理位移（movementX/Y）：只用于 5px 阈值与四向动画；
  // 窗口实际位移由主进程采样系统光标计算（见 main/pet-window.ts）
  const dragAccumRef = React.useRef({ x: 0, y: 0 });
  // 拖拽移动请求的帧节拍：每帧最多一次 ipc，主进程按当前光标重算
  const moveRafRef = React.useRef(0);
  const [drag, setDrag] = React.useState<boolean | "left" | "right" | "up" | "down">(false);
  // 拖拽期间命中测试不得把穿透重新打开：pointerup 不被 forward 转发，
  // 穿透一开拖拽就永久卡死（松手事件丢了）
  const dragActiveRef = React.useRef(false);
  // 拖过的那次 click 要拦掉（capture 阶段），否则拖着身子松手还会白白挥个手
  const dragMovedRef = React.useRef(false);

  /* 点击穿透：命中宠物/气泡 → 可点击；其余区域 → 透传给下层窗口。
     forward:true 保证忽略期间本页仍收得到 pointermove，命中测试不会瞎。 */
  React.useEffect(() => {
    // Windows 不走穿透（见主进程说明）：窗口整块可点击，无需命中测试
    if (!isDesktop() || isWindowsPlatform()) return undefined;
    let last: boolean | null = null;
    const onMove = (event: PointerEvent) => {
      if (dragActiveRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      // 别写成 target?.closest(...) !== null：target 为空时会误判成"在宠物上"
      const over = target !== null && target.closest("[data-pet-interactive]") !== null;
      if (over === last) return;
      last = over;
      // 不吞掉 in-flight 期间的翻转：之前用 inFlight 门闩，指针在切换未完成时
      // 快速进出宠物会丢掉最后一次状态，窗口停在穿透态（点不到、拖不动）。
      // invoke 按调用顺序进主进程，最后一次 setIgnoreMouseEvents 就是最终态。
      void setPetIgnoreMouse(!over).catch(() => {});
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

  /* 程序化拖窗：pointerdown 让主进程记下窗口/光标基点；之后渲染层只按帧
     发"可以重算位置了"，主进程用系统光标算位移（渲染层 screenX 不可信）。 */
  const beginDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isDesktop() || event.button !== 0) return;
      dragAccumRef.current = { x: 0, y: 0 };
      if (moveRafRef.current !== 0) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
      dragMovedRef.current = false;
      dragActiveRef.current = true;
      void beginPetDrag().catch(() => {
        // 主进程没接住（窗口刚销毁等）：别让 dragging 永久为真
        dragActiveRef.current = false;
        if (moveRafRef.current !== 0) {
          cancelAnimationFrame(moveRafRef.current);
          moveRafRef.current = 0;
        }
        setDragging(false);
      });
      setDragging(true);
    },
    [],
  );

  React.useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      if (!dragActiveRef.current) return;
      const accum = dragAccumRef.current;
      accum.x += event.movementX;
      accum.y += event.movementY;
      if (Math.hypot(accum.x, accum.y) >= 5) dragMovedRef.current = true;
      // 四向判定（1px 死区防抖）：水平 → 左右行走；竖直 → 跳跃（拎起/落下）
      const stepX = event.movementX;
      const stepY = event.movementY;
      if (Math.abs(stepX) > 1 && Math.abs(stepX) >= Math.abs(stepY)) {
        setDrag(stepX > 0 ? "right" : "left");
      } else if (Math.abs(stepY) > 1) {
        setDrag(stepY > 0 ? "down" : "up");
      }
      // 每帧最多一次：主进程按当前系统光标重算窗口位置
      if (moveRafRef.current === 0) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = 0;
          if (!dragActiveRef.current) return;
          void movePetWindowOffset().catch(() => {});
        });
      }
    };
    const onUp = () => {
      // pointerup / pointercancel 可能重复到达：收尾动作本身幂等
      dragActiveRef.current = false;
      if (moveRafRef.current !== 0) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
      dragAccumRef.current = { x: 0, y: 0 };
      setDrag(false);
      setDragging(false);
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
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
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
        // 拖拽挂在整块宠物包装上（而非中心 hitbox）：macOS 留白是点击穿透的，
        // 只有 data-pet-interactive 这一块可交互；hitbox 只占 50% 宽，抓边就拖不动
        <div
          onPointerDown={beginDrag}
          onClickCapture={onClickCapture}
          onClick={onPetClick}
          onContextMenu={onHitboxContextMenu}
        >
          <PetWidget
            variant="floating"
            manifest={prefs.configUrl}
            size={prefs.size}
            subscribeEvents={bridgeEventsSubscribe}
            onOpenSession={(sessionId) => {
              void focusPetSession(sessionId).catch(() => {});
            }}
            dragging={drag || dragging}
          />
        </div>
      ) : null}
    </main>
  );
}
