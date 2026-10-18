"use client";

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type PointerEvent,
} from "react";
import { motion } from "framer-motion";
import {
  ChevronDownIcon,
  PlusIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  closeAllDockTabs,
  closeDockTab,
  closeTerminalDock,
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  newDockTerminal,
  restartDockTerminal,
  setActiveDockTab,
  setTerminalDockHeight,
  toggleTerminalDock,
  useTerminalDock,
  useTerminalDockOpen,
  type DockTab,
} from "@/lib/terminal/dock";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { findShell } from "@/lib/shell";
import { beginResizeSession, endResizeSession } from "@/lib/ui/resize-session";
import { isDesktop } from "@/lib/desktop-env";
import { useIsAskMode } from "@/lib/pi/pi-session-mode";
import { cn } from "@/lib/utils";
import { ShellViewport } from "./agent-panel/shell-viewport";

/**
 * 底部终端坞：聊天列卡片下缘的横条（VSCode 集成终端形态），只占对话区
 * 的高度——右列 Agent 面板始终贯通全高，不被坞顶起。
 * 标签栏（标签胶囊 + ×，右缘「+ / 菜单」）在上，xterm 视口在下；
 * 顶缘是一条拖高条，拖动改高（落盘在 store，拖拽中只做节流写）。
 *
 * 高度按聊天卡片实高钳制：保留 Header + 一段正文，其余可一路拉到接近
 * 全屏（VSCode 面板同款：用户想多大就多大）。
 * 开合是高度动画：内层卡片保持目标高、外层从 0 滑出/收回。这样收起时
 * 视口尺寸不变，xterm 不用重新 fit（收起再展开零重排、零 pty_resize），
 * 动画期间由 resize 会话让其它重测量组件跳过中间帧。
 * 开关从不销毁会话：收起后 PTY/缓冲照常活着，再次唤起原样接回
 * （见 lib/terminal/dock 注释）。
 */

/** 关标签的悬停底色等交互对齐面板标签条 */
const DockTabChip: FC<{ tab: DockTab; active: boolean }> = ({ tab, active }) => (
  <div
    role="button"
    tabIndex={0}
    title={tab.title}
    onClick={() => setActiveDockTab(tab.id)}
    onMouseDown={(e) => {
      // 中键：直接关闭标签（浏览器会闪滚动指针，需 preventDefault）
      if (e.button === 1) {
        e.preventDefault();
        closeDockTab(tab.id);
      }
    }}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") setActiveDockTab(tab.id);
    }}
    className={cn(
      "group flex h-6 max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs outline-none transition-colors",
      active
        ? "border-border bg-muted text-foreground"
        : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
    )}
  >
    <SquareTerminalIcon className="size-3.5 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
    <button
      type="button"
      aria-label="关闭终端"
      onClick={(e) => {
        e.stopPropagation();
        closeDockTab(tab.id);
      }}
      className={cn(
        "hover:bg-foreground/10 hover:text-foreground -mr-1 flex size-4 shrink-0 items-center justify-center rounded transition-opacity",
        active ? "opacity-60" : "opacity-0 group-hover:opacity-60",
      )}
    >
      <XIcon className="size-3" />
    </button>
  </div>
);

/**
 * 终端坞开关按钮（Header 右上角按钮簇 / 面板顶栏两处共用，随面板停靠
 * 交接——与窗口控件的交接规则一致）：只订阅开合位，拖高时不会逐帧重渲染。
 * 坞展开时按钮点亮（aria-pressed + 底色，VSCode 同款，一眼看出终端在开着——
 * 收起态坞不会露出任何痕迹）。
 * 显隐与面板终端标签同源：仅桌面端、且问答档不露（那一档不碰工程）。
 */
export const TerminalToggleButton: FC<{ className?: string }> = ({
  className,
}) => {
  const open = useTerminalDockOpen();
  const ask = useIsAskMode();
  if (!isDesktop() || ask) return null;
  return (
    <TooltipIconButton
      variant="ghost"
      size="icon"
      tooltip={open ? "收起终端面板" : "打开终端面板"}
      side="bottom"
      aria-pressed={open}
      onClick={() => toggleTerminalDock()}
      className={cn(
        "size-8 shrink-0",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      <SquareTerminalIcon className="size-4" />
    </TooltipIconButton>
  );
};

/** 聊天正文至少保留的高度（坞最大只能顶到这里；之上还有 48px 的 Header） */
const CHAT_KEEP_PX = 48;
/** 聊天卡片顶栏（Header）高度：算坞上限时整卡高度里要扣掉它 */
const HEADER_PX = 48;

export const TerminalDock: FC = () => {
  const { open, height, tabs, activeId } = useTerminalDock();
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  // rootRef 指坞本体（拖拽起点读 offsetHeight）；wrapperRef 指开合动画
  // 外层，它的父级才是聊天卡片——高度上限必须量卡片，量外层会把动画
  // 高度反馈成上限，逐帧自我收缩
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // 高度上限：按聊天卡片实高钳（留出 Header 与一段正文，允许拉到近全屏）
  const [maxH, setMaxH] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number; maxH: number } | null>(
    null,
  );
  // 拖拽中的高度写回按帧合并：pointermove 在高回报率鼠标下可达 120+/s，
  // 每个事件都 setState 会把主区重排跑成事件频率。存最新值，rAF 一次落一帧
  const pendingHRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const flushHeight = () => {
    rafRef.current = 0;
    const next = pendingHRef.current;
    pendingHRef.current = null;
    if (next !== null) setTerminalDockHeight(next);
  };

  /** 聊天卡片实高（动画外层 .parentElement）；量不到按窗口高度兜底 */
  const hostHeight = (): number => {
    const host = wrapperRef.current?.parentElement;
    return host && host.clientHeight > 0 ? host.clientHeight : window.innerHeight;
  };

  // 聊天卡片高度变化（窗口缩放/侧栏收放）时重钳上限。依赖 open：坞收起时
  // 该 effect 不挂（展开这一拍重新量一次）——空依赖版本会在"收起态"
  // 跑过一次就再也不跑，展开后 maxH 永远是 null，向上拖被当前高度锁死
  // （实报"只能缩不能拉"）
  useEffect(() => {
    if (!open) return;
    const host = wrapperRef.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const avail = host.clientHeight;
      if (avail > 0)
        setMaxH(Math.max(DOCK_MIN_HEIGHT, avail - HEADER_PX - CHAT_KEEP_PX));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [open]);

  const shownH = maxH === null ? height : Math.min(height, maxH);

  // 开合动画期间挂 resize 会话（与面板开合同款）：聊天/面板里的重测量
  // 组件跳过中间帧，xterm 也冻结 fit；落位后统一补一次终态测量。
  // 首次挂载（恢复上次开着的坞）不播动画、也不挂会话——直接落位
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    beginResizeSession();
    const timer = window.setTimeout(() => endResizeSession(), 260);
    return () => {
      window.clearTimeout(timer);
      endResizeSession();
    };
  }, [open]);

  // 展开即聚焦终端：视口常驻（收起时不卸载，保 xterm 尺寸/缓冲），
  // 焦点归还只能由这里补
  useEffect(() => {
    if (!open) return;
    findShell(active?.sessionId ?? undefined)?.terminal.focus();
  }, [open, active?.sessionId]);

  // 顶缘拖高：拖拽期间挂 resize 会话（重测量组件跳过中间帧、xterm 冻结
  // fit），松手一次落位；高度写回 store（节流落盘）
  const beginDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const box = rootRef.current;
    if (!box) return;
    // 上限现算而不是只认 RO 的 state：拖拽起点必须可靠，measure 尚未跑到
    // （首帧、坞刚展开）时也按聊天卡片实高算，而不是按当前高度锁死
    const limit = Math.max(
      DOCK_MIN_HEIGHT,
      hostHeight() - HEADER_PX - CHAT_KEEP_PX,
    );
    dragRef.current = {
      startY: e.clientY,
      startH: box.offsetHeight,
      maxH: limit,
    };
    beginResizeSession();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 拖顶缘：向上拖动变高（起点高度 + 位移反向）
    const next = drag.startH - (e.clientY - drag.startY);
    pendingHRef.current = Math.min(
      drag.maxH,
      Math.max(DOCK_MIN_HEIGHT, next),
    );
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushHeight);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // 收尾落在指针最终位置：取消未跑的帧，同步补上最后一个待写值
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    flushHeight();
    endResizeSession();
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // 拖拽中窗口失焦/指针取消的兜底（否则 is-resizing 永久残留）
  useEffect(() => {
    const stop = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pendingHRef.current = null;
      endResizeSession();
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 非桌面端没有 PTY 后端，按钮本就不露（快捷键误触也不出横条）；
  // 无标签（标签关光）时整块不渲染——没有内容的横条不该占位
  if (!isDesktop() || tabs.length === 0) return null;

  return (
    // 外层只做开合动画：高度 0 ↔ shownH，内容按目标高常驻（收起时被裁掉，
    // 但尺寸不变 → xterm 不重排、不重 fit）。inert 挡住收起态下的键盘焦点。
    // 坞挂在聊天卡片内下缘：不画自己的描边/圆角（由卡片裁切），顶缘一道
    // 分隔线区分正文与终端
    <motion.div
      ref={wrapperRef}
      initial={false}
      animate={{ height: open ? shownH : 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="shrink-0 overflow-hidden"
      inert={!open}
      aria-hidden={!open}
    >
      <div
        ref={rootRef}
        data-terminal-dock
        style={{ height: shownH }}
        className="flex min-h-0 flex-col overflow-hidden"
      >
        {/* 顶缘拖高条：8px 命中区 + 悬停浮现"可拖"的抓手（2px 圆角短横），
            顶缘一条分隔线；VSCode 只给光标变化，这里做成看得见的抓手，
            不然用户根本不知道这条能拖。双击复位默认高 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整终端面板高度（拖动改高，双击复位）"
          title="拖动调整高度，双击复位"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => setTerminalDockHeight(DOCK_DEFAULT_HEIGHT)}
          className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center border-t-[0.5] border-border/70"
        >
          <div className="bg-muted-foreground/30 group-hover:bg-muted-foreground/60 h-[3px] w-10 rounded-full transition-colors" />
        </div>

        {/* 标签栏：左为标签条（溢出横向滚动），右为新建/菜单动作 */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b-[0.5] px-2">
          <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <DockTabChip key={t.id} tab={t} active={t.id === active?.id} />
            ))}
          </div>
          <button
            type="button"
            aria-label="新建终端"
            title="新建终端"
            onClick={() => newDockTerminal()}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <PlusIcon className="size-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="终端面板菜单"
                  title="终端面板菜单"
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="min-w-44">
              <DropdownMenuItem onClick={() => newDockTerminal()}>
                <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
                新建终端
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => closeAllDockTabs()}>
                <Trash2Icon className="text-muted-foreground size-3.5 shrink-0" />
                关闭全部终端
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => closeTerminalDock()}>
                <SquareTerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
                收起终端面板
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 视口：当前标签的 xterm 宿主（会话对象活在 shell store，切标签只换挂载） */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {active ? (
            <ShellViewport
              key={active.id}
              sessionId={active.sessionId}
              visible={open}
              onRestart={() => restartDockTerminal(active.id)}
              className="relative h-full min-h-0 overflow-hidden px-2 py-1"
            />
          ) : null}
        </div>
      </div>
    </motion.div>
  );
};