"use client"
// Animated toast stack — 视觉与动效取自 beui.dev/components/motion/animated-toast-stack，
// 存储改为模块级外部 store（useSyncExternalStore），因此 `toast.add(...)` 可以在
// React 组件之外直接调用；旧版 `type` 字段保留为 status 的别名，调用点无需改动。

import {
  AlertCircle,
  Bell,
  Check,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "framer-motion"
import {
  forwardRef,
  isValidElement,
  memo,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { EASE_OUT } from "@/lib/ease"
import { cn } from "@/lib/utils"

export type ToastStatus =
  | "neutral"
  | "info"
  | "loading"
  | "success"
  | "warning"
  | "error"

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"

export type ToastAction = {
  label: ReactNode
  onClick: (toast: Toast) => void
}

export type Toast = {
  id: string
  title: ReactNode
  description?: ReactNode
  status: ToastStatus
  icon?: ReactNode
  action?: ToastAction
  /** 毫秒；<= 0 表示常驻，需手动 dismiss。 */
  duration: number
  dismissible: boolean
  createdAt: number
}

export type ToastInput = {
  id?: string
  title: ReactNode
  description?: ReactNode
  status?: ToastStatus
  /** base-ui 时代的别名，等价于 status。 */
  type?: ToastStatus
  icon?: ReactNode
  action?: ToastAction
  duration?: number
  dismissible?: boolean
}

const DEFAULT_DURATION = 4200

const STACK_SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.75,
}

const CONTENT_TRANSITION = {
  duration: 0.28,
  ease: EASE_OUT,
} as const

const STATUS_ICON: Record<ToastStatus, LucideIcon> = {
  neutral: Bell,
  info: Info,
  loading: LoaderCircle,
  success: Check,
  warning: TriangleAlert,
  error: AlertCircle,
}

const STATUS_CLASS: Record<ToastStatus, string> = {
  neutral: "text-muted-foreground bg-primary/[0.05]",
  info: "text-primary bg-primary/10",
  loading: "text-primary bg-primary/10",
  success: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400",
  warning: "text-amber-600 bg-amber-500/10 dark:text-amber-400",
  error: "text-destructive bg-destructive/10",
}

const POSITION_CLASS: Record<ToastPosition, string> = {
  "top-left": "left-4 top-4",
  "top-center": "left-1/2 top-4 -translate-x-1/2",
  "top-right": "right-4 top-4",
  "bottom-left": "bottom-6 left-4",
  "bottom-center": "bottom-6 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-6 right-4",
}

// ---------------------------------------------------------------------------
// 外部 store：模块级单例，可在任意位置（事件回调、工具函数）发 toast
// ---------------------------------------------------------------------------

let idSeed = 0
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<string, { timer: number; signature: string }>()

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Toast[] {
  return toasts
}

function clearTimer(id: string) {
  const entry = timers.get(id)
  if (entry) {
    window.clearTimeout(entry.timer)
    timers.delete(id)
  }
}

/** 与参考实现一致：按 createdAt+duration 签名管理定时器，update 换 duration 会重挂。 */
function syncTimers() {
  const activeIds = new Set(toasts.map((toastItem) => toastItem.id))
  timers.forEach((_, id) => {
    if (!activeIds.has(id)) clearTimer(id)
  })

  toasts.forEach((toastItem) => {
    if (toastItem.duration <= 0) {
      clearTimer(toastItem.id)
      return
    }
    const signature = `${toastItem.createdAt}:${toastItem.duration}`
    const existing = timers.get(toastItem.id)
    if (existing?.signature === signature) return
    if (existing) window.clearTimeout(existing.timer)

    const remaining = Math.max(
      toastItem.duration - (Date.now() - toastItem.createdAt),
      0,
    )
    const timer = window.setTimeout(() => {
      dismissToast(toastItem.id)
    }, remaining)
    timers.set(toastItem.id, { timer, signature })
  })
}

function normalizeStatus(input: ToastInput): ToastStatus {
  return input.status ?? input.type ?? "neutral"
}

function addToast(input: ToastInput): string {
  const status = normalizeStatus(input)
  // 同内容去重：title+description+status 完全相同的 toast 不叠放，
  // 而是挪到最新位置并重启发倒计时（重复点刷新类按钮不再刷屏）。
  if (input.id === undefined) {
    const dupIndex = toasts.findIndex(
      (toastItem) =>
        toastItem.status === status &&
        Object.is(toastItem.title, input.title) &&
        Object.is(toastItem.description, input.description),
    )
    if (dupIndex !== -1) {
      const dup = toasts[dupIndex]
      const refreshed: Toast = { ...dup, createdAt: Date.now() }
      toasts = [
        ...toasts.filter((toastItem) => toastItem.id !== dup.id),
        refreshed,
      ]
      syncTimers()
      emit()
      return dup.id
    }
  }
  const id = input.id ?? `toast-${Date.now()}-${idSeed++}`
  const next: Toast = {
    id,
    title: input.title,
    description: input.description,
    status,
    icon: input.icon,
    action: input.action,
    duration: input.duration ?? DEFAULT_DURATION,
    dismissible: input.dismissible !== false,
    createdAt: Date.now(),
  }
  toasts = [...toasts, next]
  syncTimers()
  emit()
  return id
}

function updateToast(id: string, patch: Omit<ToastInput, "id">) {
  let changed = false
  toasts = toasts.map((toastItem) => {
    if (toastItem.id !== id) return toastItem
    changed = true
    return {
      ...toastItem,
      ...(patch.title !== undefined ? { title: patch.title } : null),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : null),
      ...(patch.status || patch.type
        ? { status: normalizeStatus(patch) }
        : null),
      ...(patch.icon !== undefined ? { icon: patch.icon } : null),
      ...(patch.action !== undefined ? { action: patch.action } : null),
      ...(patch.dismissible !== undefined
        ? { dismissible: patch.dismissible }
        : null),
      ...(patch.duration !== undefined
        ? { duration: patch.duration, createdAt: Date.now() }
        : null),
    }
  })
  if (changed) {
    syncTimers()
    emit()
  }
}

function dismissToast(id: string) {
  clearTimer(id)
  const next = toasts.filter((toastItem) => toastItem.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

function clearToasts() {
  timers.forEach((_, id) => clearTimer(id))
  toasts = []
  emit()
}

type ShortcutInput = Omit<ToastInput, "status" | "type">

function statusShortcut(status: ToastStatus) {
  return (input: ReactNode | ShortcutInput): string => {
    // 结构化入参以 title 字段判别；React 元素/字符串/数组都视作 title
    const structured =
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      !isValidElement(input) &&
      "title" in input
    return addToast({
      ...(structured ? input : { title: input as ReactNode }),
      status,
      // loading 默认常驻，靠 update/dismiss 收尾
      ...(status === "loading" ? { duration: 0 } : null),
    })
  }
}

export const toast = {
  /** 兼容旧调用：toast.add({ title, description, type: "success" }) */
  add: addToast,
  update: updateToast,
  dismiss: dismissToast,
  clear: clearToasts,
  message: statusShortcut("neutral"),
  info: statusShortcut("info"),
  loading: statusShortcut("loading"),
  success: statusShortcut("success"),
  warning: statusShortcut("warning"),
  error: statusShortcut("error"),
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_TOASTS)
}

const EMPTY_TOASTS: Toast[] = []

export interface ToasterProps {
  position?: ToastPosition
  maxVisible?: number
  className?: string
}

export function Toaster({
  position = "bottom-right",
  maxVisible = 4,
  className,
}: ToasterProps) {
  const toasts = useToasts()
  const [portalTarget, setPortalTarget] = useState<Element | null>(null)

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  const visibleToasts = toasts.slice(-maxVisible)
  const isBottom = position.startsWith("bottom")

  const stack = (
    <ol
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        "pointer-events-none fixed z-[90] flex w-[calc(100vw-2rem)] max-w-sm gap-2",
        isBottom ? "flex-col-reverse" : "flex-col",
        POSITION_CLASS[position],
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {visibleToasts.map((toastItem, index) => (
          <ToastItem key={toastItem.id} toast={toastItem} index={index} />
        ))}
      </AnimatePresence>
    </ol>
  )

  if (!portalTarget) return null
  return createPortal(stack, portalTarget)
}

// ref 必须转发到 motion.li：AnimatePresence 的 popLayout 模式靠它把退出
// 元素弹出文档流，否则退场中的 toast 仍占位，堆叠间距会被撑开。
const ToastItem = memo(
  forwardRef<HTMLLIElement, { toast: Toast; index: number }>(
    function ToastItem({ toast: toastData, index }, ref) {
  const reduce = useReducedMotion()
  const { status } = toastData
  const Icon = STATUS_ICON[status]
  const iconNode = toastData.icon ?? <Icon className="h-3.5 w-3.5" />
  const canDismiss = toastData.dismissible
  const hasDetails = Boolean(toastData.description || toastData.action)

  return (
    <motion.li
      ref={ref}
      layout
      initial={
        reduce
          ? { opacity: 0 }
          : { opacity: 0, y: 22, scale: 0.96, filter: "blur(10px)" }
      }
      animate={
        reduce
          ? { opacity: 1 }
          : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
      }
      exit={
        reduce
          ? { opacity: 0 }
          : {
              opacity: 0,
              x: 32,
              scale: 0.96,
              filter: "blur(8px)",
              transition: { duration: 0.18, ease: EASE_OUT },
            }
      }
      transition={STACK_SPRING}
      drag={canDismiss && !reduce ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.18}
      onDragEnd={(_, info) => {
        if (!canDismiss) return
        if (Math.abs(info.offset.x) > 72 || Math.abs(info.velocity.x) > 520) {
          dismissToast(toastData.id)
        }
      }}
      className="pointer-events-auto relative will-change-transform"
      style={{ zIndex: 20 - index }}
    >
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-xl">
        <div
          className={cn(
            "flex gap-3",
            hasDetails ? "items-start" : "items-center",
          )}
        >
          <motion.span
            layout
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
              hasDetails && "mt-0.5",
              STATUS_CLASS[status],
            )}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={status}
                initial={
                  reduce
                    ? { opacity: 0 }
                    : { opacity: 0, y: 8, scale: 0.8, filter: "blur(6px)" }
                }
                animate={
                  reduce
                    ? { opacity: 1 }
                    : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
                }
                exit={
                  reduce
                    ? { opacity: 0 }
                    : { opacity: 0, y: -8, scale: 0.9, filter: "blur(6px)" }
                }
                transition={CONTENT_TRANSITION}
                className="inline-flex"
              >
                {status === "loading" ? (
                  <span className="inline-flex animate-spin">{iconNode}</span>
                ) : (
                  iconNode
                )}
              </motion.span>
            </AnimatePresence>
          </motion.span>

          <div className="min-w-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={`${toastData.id}:${status}`}
                initial={
                  reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(6px)" }
                }
                animate={
                  reduce
                    ? { opacity: 1 }
                    : { opacity: 1, y: 0, filter: "blur(0px)" }
                }
                exit={
                  reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)" }
                }
                transition={CONTENT_TRANSITION}
              >
                <p className="truncate text-sm font-medium leading-5 text-foreground">
                  {toastData.title}
                </p>
                {toastData.description ? (
                  <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">
                    {toastData.description}
                  </p>
                ) : null}
              </motion.div>
            </AnimatePresence>

            {toastData.action ? (
              <button
                type="button"
                onClick={() => toastData.action?.onClick(toastData)}
                className="mt-2 inline-flex h-7 items-center rounded-full bg-primary/[0.06] px-3 text-xs font-medium text-foreground transition-colors hover:bg-primary/[0.1]"
              >
                {toastData.action.label}
              </button>
            ) : null}
          </div>

          {canDismiss ? (
            <button
              type="button"
              onClick={() => dismissToast(toastData.id)}
              aria-label="Dismiss toast"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/[0.06] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </motion.li>
  )
    },
  ),
)
