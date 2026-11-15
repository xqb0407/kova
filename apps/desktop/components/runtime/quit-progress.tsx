"use client";

/**
 * ⌘Q 退出确认（主进程 quit.ts 的状态投影）。
 *
 * 窗口中央的浮动圆形进度卡（不是窗口边缘的条状进度）：
 *  - holding：圆环按按住时长 0→100%（中心显示剩余秒数），松键即取消；
 *  - 圆环转满 = 退出已确认；后续逐项停止任务时圆环保持满格（中心显示 2/4），
 *    全部停完才真正退出；
 *  - cancelled：圆环满格 + 对勾，1.2s 后自动隐藏。
 *
 * 只有卡片本身接收指针事件，取消后页面可直接继续用。主进程发事件；渲染层
 * 晚挂载（刷新/启动中）时用 quit_get_state 补一次状态。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { invoke } from "@/desktop-bridge/core";
import { listen } from "@/desktop-bridge/event";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { isDesktop, isMacPlatform } from "@/lib/desktop-env";

const QUIT_STATE_EVENT = "app-quit-state";
/** cancelled 提示的展示时长（主进程同步 1.2s 后清状态） */
const CANCEL_NOTICE_MS = 1_200;

type QuitTaskKind =
  | "session"
  | "background"
  | "terminal"
  | "automation"
  | "engine"
  | "remote"
  | "im";

type QuitState = {
  phase: "holding" | "stopping" | "finalizing" | "cancelled";
  holdProgress: number;
  holdMs: number;
  completed: number;
  total: number;
  current: { kind: QuitTaskKind; title: string | null } | null;
  cancelable: boolean;
  stoppedCount: number;
};

const KIND_LABEL: Record<QuitTaskKind, string> = {
  session: "quit.kind.session",
  background: "quit.kind.background",
  terminal: "quit.kind.terminal",
  automation: "quit.kind.automation",
  engine: "quit.kind.engine",
  remote: "quit.kind.remote",
  im: "quit.kind.im",
};

/** 纯 CSS/SVG 圆环：progress 0..1，中心内容由调用方给 */
function ProgressRing({
  progress,
  tone = "default",
  children,
}: {
  progress: number;
  tone?: "default" | "success";
  children?: ReactNode;
}) {
  const size = 64;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, progress));
  const offset = circumference * (1 - clamped);
  return (
    <span className="relative inline-flex size-16 shrink-0 items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-foreground/15"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(
            "transition-[stroke-dashoffset] duration-150 ease-out",
            tone === "success" ? "stroke-emerald-500" : "stroke-foreground",
          )}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
        {children}
      </span>
    </span>
  );
}

export function QuitProgress() {
  const t = useT();
  const [state, setState] = useState<QuitState | null>(null);
  const [mounted, setMounted] = useState(false);
  const cancelingRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const apply = (next: QuitState | null) => {
      if (disposed) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (!next) {
        setState(null);
        return;
      }
      setState(next);
      if (next.phase === "cancelled") {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (!disposed) setState(null);
        }, CANCEL_NOTICE_MS);
      }
    };

    void listen<QuitState | null>(QUIT_STATE_EVENT, (event) => apply(event.payload)).then(
      (fn) => {
        if (disposed) fn();
        else off = fn;
      },
    );
    // 渲染层晚挂载（启动中/刷新）时补状态；无退出流程返回 null
    void invoke<QuitState | null>("quit_get_state")
      .then((initial) => {
        if (!disposed && initial) apply(initial);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      off?.();
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  const cancel = useCallback(() => {
    if (cancelingRef.current) return;
    cancelingRef.current = true;
    void invoke("quit_cancel")
      .catch(() => undefined)
      .finally(() => {
        // 主进程状态事件到达后按钮会随 cancelable 消失；短暂防抖即可
        setTimeout(() => {
          cancelingRef.current = false;
        }, 300);
      });
  }, []);

  const cancelable = state?.cancelable ?? false;
  useEffect(() => {
    if (!cancelable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelable, cancel]);

  // 松键取消的渲染层兜底：主进程的 before-input-event keyUp 在部分键盘/焦点
  // 组合下可能收不到，页面这一侧收到 Meta/Control/Q 的 keyup 也直接取消。
  // 失焦取消由主进程负责（页面 blur 在菜单加速键闪一下时也会触发，太激进）。
  const holding = state?.phase === "holding";
  useEffect(() => {
    if (!holding) return;
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        event.key === "Meta" ||
        event.key === "Control" ||
        event.key.toLowerCase() === "q"
      ) {
        cancel();
      }
    };
    window.addEventListener("keyup", onKeyUp, true);
    return () => window.removeEventListener("keyup", onKeyUp, true);
  }, [holding, cancel]);

  if (!mounted || !state) return null;

  const shortcut = isMacPlatform() ? "⌘Q" : "Ctrl+Q";
  const remainingSeconds = Math.max(
    0,
    Math.ceil(((1 - state.holdProgress) * state.holdMs) / 1000),
  );
  // 圆环只表示“按住确认”：转满即代表退出已确认；逐项停止的进度看中心计数
  const ringProgress =
    state.phase === "holding" ? Math.min(1, Math.max(0, state.holdProgress)) : 1;
  const percent =
    state.total > 0
      ? Math.round(Math.min(1, Math.max(0, state.completed / state.total)) * 100)
      : 100;
  const currentLabel = state.current
    ? state.current.title ??
      (state.current.kind === "session"
        ? t("quit.untitledSession")
        : t(KIND_LABEL[state.current.kind] ?? "quit.kind.session"))
    : null;

  let label: string;
  switch (state.phase) {
    case "holding":
      label = t("quit.hold", { shortcut });
      break;
    case "stopping":
      label =
        state.total > 0
          ? t("quit.stopping", { done: state.completed, total: state.total })
          : t("quit.stoppingNoTasks");
      break;
    case "finalizing":
      label = t("quit.finalizing");
      break;
    case "cancelled":
      label =
        state.stoppedCount > 0
          ? t("quit.cancelledPartial", { count: state.stoppedCount })
          : t("quit.cancelled");
      break;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center p-6">
      <div className="border-border/60 bg-popover/95 text-popover-foreground pointer-events-auto flex w-[min(20rem,calc(100vw-2rem))] flex-col items-center gap-2 rounded-2xl border px-5 py-4 text-center shadow-2xl backdrop-blur-md">
        <ProgressRing
          progress={ringProgress}
          tone={state.phase === "cancelled" ? "success" : "default"}
        >
          {state.phase === "cancelled" ? (
            <CheckIcon className="size-6 text-emerald-500" />
          ) : state.phase === "holding" ? (
            `${remainingSeconds}s`
          ) : state.total > 0 ? (
            `${state.completed}/${state.total}`
          ) : (
            `${percent}%`
          )}
        </ProgressRing>

        <span aria-live="polite" className="mt-1 text-[13px] font-medium">
          {label}
        </span>
        {(state.phase === "stopping" || state.phase === "finalizing") &&
        currentLabel ? (
          <span className="text-muted-foreground max-w-full truncate text-[11px]">
            {currentLabel}
          </span>
        ) : null}

        {state.cancelable ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-1 h-7 gap-1.5 px-3"
            onClick={cancel}
          >
            <XIcon className="size-3.5" />
            {t("quit.cancel")}
            <Kbd className="bg-background/60 h-4 min-w-4 px-1 text-[10px]">Esc</Kbd>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
