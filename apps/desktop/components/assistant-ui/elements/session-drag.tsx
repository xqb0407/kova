"use client";

import {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type FC,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { FolderInputIcon } from "lucide-react";
import {
  piSessionCwdMap,
  piSessionProjectMap,
} from "@/lib/pi/pi-thread-adapter";

/**
 * 会话拖拽移动到项目（项目 tab）：按住会话行拖动超过阈值进入拖拽，
 * 悬停高亮可接收的项目组头，松开即换绑 cwd——与行菜单「移动到项目…」
 * 走同一条 moveSessionToDirectory 链路，落点语义一致。
 *
 * 结构：
 * - 外部 store 只存「拖拽元信息 + 命中目标」；逐帧指针坐标不过 React——
 *   ghost 位置由控制器经 subscribeGhostMove 直改 DOM，命中变化才触发渲染。
 * - 拖拽源是 ThreadListItem 行（经 SessionDragContext 拿控制器；任务 tab
 *   不提供该 context，行自然不可拖）；落点是项目组头上的 PROJECT_DROP_ATTR。
 * - 命中检测 elementFromPoint + closest，免维护注册表；ghost 与列表的
 *   悬浮高亮均 pointer-events-none，不会挡住命中。
 * - 仅响应鼠标/触控板（pointerType touch 排除，触屏滚动优先），拖拽结束
 *   短窗吞掉 click——拖完松手不激活会话。
 */

/** 项目组头上的落点标记（值 = 组 cwd） */
export const PROJECT_DROP_ATTR = "data-project-drop";

/** 按下后位移超过该值才进入拖拽，与点击（激活会话）区分 */
const DRAG_START_PX = 6;

export interface SessionDragSource {
  sessionId: string;
  title: string;
}

interface SessionDragStore {
  source: SessionDragSource | null;
  overCwd: string | null;
}

const IDLE: SessionDragStore = { source: null, overCwd: null };

let dragStore: SessionDragStore = IDLE;
const dragListeners = new Set<() => void>();

const setDragStore = (next: SessionDragStore) => {
  dragStore = next;
  for (const listener of dragListeners) listener();
};

const subscribeDrag = (listener: () => void) => {
  dragListeners.add(listener);
  return () => {
    dragListeners.delete(listener);
  };
};

export const useSessionDragStore = (): SessionDragStore =>
  useSyncExternalStore(
    subscribeDrag,
    () => dragStore,
    () => IDLE,
  );

/** 当前拖拽悬停的项目组 cwd（未悬停在有效落点上为 null） */
export const useSessionDragOverCwd = (): string | null =>
  useSyncExternalStore(
    subscribeDrag,
    () => dragStore.overCwd,
    () => null,
  );

/** 该会话行是否正在被拖拽（行置灰用） */
export const useIsSessionDragged = (
  sessionId: string | null | undefined,
): boolean =>
  useSyncExternalStore(
    subscribeDrag,
    () => sessionId != null && dragStore.source?.sessionId === sessionId,
    () => false,
  );

// --- ghost 位置：逐帧事件（不过 React 状态） ---

type GhostMoveListener = (x: number, y: number) => void;
const ghostListeners = new Set<GhostMoveListener>();
let lastPoint = { x: 0, y: 0 };

const emitGhostMove = (x: number, y: number) => {
  lastPoint = { x, y };
  for (const listener of ghostListeners) listener(x, y);
};

const subscribeGhostMove = (listener: GhostMoveListener) => {
  ghostListeners.add(listener);
  return () => {
    ghostListeners.delete(listener);
  };
};

// --- 拖拽后吞 click：松手不激活会话。短窗自愈，未跟发 click 也不会永久吞掉 ---

let swallowClickUntil = 0;
const clickSwallower = (event: MouseEvent) => {
  if (Date.now() >= swallowClickUntil) {
    window.removeEventListener("click", clickSwallower, true);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
};
const swallowClicksAfterDrag = () => {
  swallowClickUntil = Date.now() + 300;
  window.addEventListener("click", clickSwallower, true);
};

// --- 控制器与行侧 API ---

export interface SessionDragApi {
  onRowPointerDown: (
    event: ReactPointerEvent,
    source: SessionDragSource & {
      /** 运行中/有挂起交互/批量模式：不进入拖拽，行保持原点击行为 */
      blocked: boolean;
    },
  ) => void;
}

export const SessionDragContext = createContext<SessionDragApi | null>(null);

/**
 * 项目 tab 挂一块即可：返回经 context 下发的行按下处理器；拖到组头松开时
 * 调 onDrop(sessionId, targetCwd, title)（由调用方决定直接移动或先确认）。
 */
export const useSessionDragController = (
  onDrop: (sessionId: string, targetCwd: string, title: string) => void,
): SessionDragApi => {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const teardownRef = useRef<(() => void) | null>(null);

  const api = useMemo<SessionDragApi>(
    () => ({
      onRowPointerDown: (event, source) => {
        if (source.blocked || !source.sessionId) return;
        if (event.button !== 0 || event.pointerType === "touch") return;
        if (dragStore.source) return;
        const startX = event.clientX;
        const startY = event.clientY;
        // 拖回自己所属的项目不算有效落点（same-dir 语义直接静默取消）
        const ownCwd =
          piSessionProjectMap.get(source.sessionId) ||
          piSessionCwdMap.get(source.sessionId) ||
          "";
        let dragging = false;

        const endDrag = (perform: boolean) => {
          teardownRef.current = null;
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerCancel);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
          if (!dragging) return;
          dragging = false;
          const target = perform ? dragStore.overCwd : null;
          setDragStore(IDLE);
          swallowClicksAfterDrag();
          if (target) onDropRef.current(source.sessionId, target, source.title);
        };

        const onPointerMove = (e: PointerEvent) => {
          if (!dragging) {
            if (
              Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_START_PX
            )
              return;
            dragging = true;
            // 行内文字随指针划过会被框选；拖拽期间整体禁用选择
            document.body.style.userSelect = "none";
            document.body.style.cursor = "grabbing";
            setDragStore({
              source: { sessionId: source.sessionId, title: source.title },
              overCwd: null,
            });
          }
          emitGhostMove(e.clientX, e.clientY);
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const hitCwd =
            el
              ?.closest(`[${PROJECT_DROP_ATTR}]`)
              ?.getAttribute(PROJECT_DROP_ATTR) ?? null;
          const over = hitCwd && hitCwd !== ownCwd ? hitCwd : null;
          if (dragStore.overCwd !== over)
            setDragStore({ ...dragStore, overCwd: over });
        };
        const onPointerUp = () => endDrag(true);
        const onPointerCancel = () => endDrag(false);

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        teardownRef.current = () => endDrag(false);
      },
    }),
    [],
  );

  // 拖拽中途列表卸载（切 tab/换布局）时收尾，避免全局监听泄漏
  useEffect(() => () => teardownRef.current?.(), []);

  return api;
};

/** 拖拽悬浮牌：跟随指针的小药丸，显示被拖会话标题（位置直改 DOM 不走渲染） */
export const SessionDragGhost: FC = () => {
  const source = useSessionDragStore().source;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!source) return;
    const place = (x: number, y: number) => {
      const el = ref.current;
      if (el)
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -110%)`;
    };
    place(lastPoint.x, lastPoint.y);
    return subscribeGhostMove(place);
  }, [source]);

  if (!source) return null;
  // portal 到 body：侧边栏内层列常驻 translate-x-0（fixed 后代的包含块）+
  // aside overflow-hidden，就地渲染会被裁剪在侧栏范围内
  return createPortal(
    // transform 定位是物理坐标，不用 start-0（RTL 下会从右缘起算）
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[100] will-change-transform"
    >
      <div className="bg-popover text-popover-foreground border-border/60 shadow-lg flex max-w-56 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm animate-in fade-in-0 zoom-in-95">
        <FolderInputIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{source.title || "新对话"}</span>
      </div>
    </div>,
    document.body,
  );
};
