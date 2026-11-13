"use client"
// antd message / notification 风格 toast，底层换成 react-hot-toast。
// 短提示走 message（单行居中），带描述/操作或长文案走 notice（右上角卡片）；
// 对外 API 保持与旧实现一致（toast.add/update/loading/success/...），
// 因此调用点不需要改动；队列、定时、定位和进出场交给 react-hot-toast，
// 这里只负责把每条 toast 渲染成对应的视觉。

import {
  Bell,
  Check,
  ChevronDown,
  LoaderCircle,
  X,
} from "lucide-react"
import { motion, useReducedMotion } from "framer-motion"
import {
  isValidElement,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react"
import toastRHT, {
  Toaster as HotToaster,
  useToaster,
} from "react-hot-toast"

import { useT } from "@/lib/i18n"
import { EASE_OUT } from "@/lib/motion/ease"
import {
  formatToastContent,
  resolveToastVariant,
  type FormattedToastContent,
  type ToastVariant,
} from "@/lib/toast-format"
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
  /** 旧版别名，等价于 status。 */
  type?: ToastStatus
  icon?: ReactNode
  action?: ToastAction
  duration?: number
  dismissible?: boolean
}

const DEFAULT_DURATION = 4200

// 退出动画约 200ms；给 react-hot-toast 一个略长的移除延迟，避免不可见的
// toast 在退场期间继续拦截点击。
const REMOVE_DELAY = 240

// message 在顶部居中、notice 在右上角；窗口太窄时两列会横向叠在一起。
const NOTICE_SPLIT_MIN_WIDTH = 1024

// Toaster 挂载的位置。短提示留在原地走 antd message；长内容（描述/操作/
// 长文案）改成 antd notification 的右上角卡片。
let stackPosition: ToastPosition = "top-center"

function noticePosition(position: ToastPosition): ToastPosition {
  if (
    typeof window !== "undefined" &&
    window.innerWidth < NOTICE_SPLIT_MIN_WIDTH
  ) {
    return position
  }
  return position.startsWith("top") ? "top-right" : "bottom-right"
}

// antd message 自定义样式的调色板：浅色底 + 同色 2px 描边 + 4px 硬阴影，
// 暗色用 antd 对应的深色色阶。neutral/loading 是项目自有状态，沿用灰/蓝。
const STATUS_STYLES: Record<
  ToastStatus,
  { pill: string; icon: string }
> = {
  neutral: {
    pill: "border-[#d9d9d9] bg-[#fafafa] text-[#595959] shadow-[4px_4px_0_#f0f0f0] dark:border-[#303030] dark:bg-[#1f1f1f] dark:text-[#d9d9d9] dark:shadow-[4px_4px_0_#141414]",
    icon: "bg-[#8c8c8c] text-white dark:bg-[#595959] dark:text-white",
  },
  info: {
    pill: "border-[#91caff] bg-[#e6f4ff] text-[#0958d9] shadow-[4px_4px_0_#bae0ff] dark:border-[#15325b] dark:bg-[#111a2c] dark:text-[#65a9f3] dark:shadow-[4px_4px_0_#15325b]",
    icon: "bg-[#0958d9] text-white dark:bg-[#1668dc] dark:text-white",
  },
  loading: {
    pill: "border-[#91caff] bg-[#e6f4ff] text-[#0958d9] shadow-[4px_4px_0_#bae0ff] dark:border-[#15325b] dark:bg-[#111a2c] dark:text-[#65a9f3] dark:shadow-[4px_4px_0_#15325b]",
    icon: "bg-[#0958d9] text-white dark:bg-[#1668dc] dark:text-white",
  },
  success: {
    pill: "border-[#95de64] bg-[#f6ffed] text-[#237804] shadow-[4px_4px_0_#d9f7be] dark:border-[#274916] dark:bg-[#162312] dark:text-[#8fd460] dark:shadow-[4px_4px_0_#274916]",
    icon: "bg-[#237804] text-white dark:bg-[#49aa19] dark:text-white",
  },
  warning: {
    pill: "border-[#ffe58f] bg-[#fffbe6] text-[#d48806] shadow-[4px_4px_0_#fff1b8] dark:border-[#594214] dark:bg-[#2b2111] dark:text-[#f3cc62] dark:shadow-[4px_4px_0_#594214]",
    icon: "bg-[#d48806] text-white dark:bg-[#d89614] dark:text-white",
  },
  error: {
    pill: "border-[#ffccc7] bg-[#fff2f0] text-[#cf1322] shadow-[4px_4px_0_#ffccc7] dark:border-[#58181c] dark:bg-[#2a1215] dark:text-[#ff7875] dark:shadow-[4px_4px_0_#58181c]",
    icon: "bg-[#cf1322] text-white dark:bg-[#d32029] dark:text-white",
  },
}

// ---------------------------------------------------------------------------
// 兼容层：react-hot-toast 的 update 用同 id 重发实现，这里额外保留一份记录，
// 用于同内容去重和 action 回调。
// ---------------------------------------------------------------------------

let idSeed = 0
let records: Toast[] = []
const activeIds = new Set<string>()
const dismissedIds = new Set<string>()

// add/dismiss 之后 revision 会变。Toaster 的 effect 拿的是本次 render 的快照，
// 若 effect 执行前又有 toast 入队，直接同步会把刚加入的 record 清掉；用这个
// 版本号跳过过期的快照，等下一次 store 更新再对齐。
let storeRevision = 0

function normalizeStatus(input: {
  status?: ToastStatus
  type?: ToastStatus
}): ToastStatus {
  return input.status ?? input.type ?? "neutral"
}

function toRHTDuration(duration: number) {
  return duration > 0 ? duration : Infinity
}

function renderToast(data: Toast) {
  const variant = resolveToastVariant(data)
  const content = formatToastContent(data, variant)
  toastRHT.custom(
    (hotToast) => (
      <ToastMessage
        data={data}
        content={content}
        visible={hotToast.visible}
        variant={variant}
      />
    ),
    {
      id: data.id,
      duration: toRHTDuration(data.duration),
      removeDelay: REMOVE_DELAY,
      // 更新时若从 notice 变回 message，显式写回 undefined 让位置回落到
      // Toaster 的默认位置。
      position:
        variant === "notice" ? noticePosition(stackPosition) : undefined,
    },
  )
}

function addToast(input: ToastInput): string {
  const status = normalizeStatus(input)
  // 同内容去重：title+description+status 完全相同的 toast 不叠放，
  // 而是复用同一条并重启发倒计时（重复点刷新类按钮不再刷屏）。
  // RHT 的 upsert 会保留原堆叠位置，所以这里只刷新内容；action/icon 采用
  // 最新一次调用的值，避免旧闭包被复用。
  if (input.id === undefined) {
    const duplicate = records.find(
      (item) =>
        activeIds.has(item.id) &&
        !dismissedIds.has(item.id) &&
        item.status === status &&
        Object.is(item.title, input.title) &&
        Object.is(item.description, input.description),
    )
    if (duplicate) {
      const refreshed: Toast = {
        ...duplicate,
        ...(input.icon !== undefined ? { icon: input.icon } : null),
        ...(input.action !== undefined ? { action: input.action } : null),
        ...(input.dismissible !== undefined
          ? { dismissible: input.dismissible }
          : null),
        ...(input.duration !== undefined
          ? { duration: input.duration }
          : null),
        createdAt: Date.now(),
      }
      records = [
        ...records.filter((item) => item.id !== duplicate.id),
        refreshed,
      ]
      renderToast(refreshed)
      storeRevision++
      return duplicate.id
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
  records = [...records.filter((item) => item.id !== id), next]
  activeIds.add(id)
  dismissedIds.delete(id)
  renderToast(next)
  storeRevision++
  return id
}

function updateToast(
  id: string,
  patch: Partial<Omit<ToastInput, "id">>,
) {
  // 自动 dismiss 的 toast 在 removeDelay 内还在 RHT store 里；
  // 迟到的 update 不能把它 upsert 回可见状态。
  if (!activeIds.has(id) || dismissedIds.has(id)) return

  const current = records.find((item) => item.id === id)
  if (!current) return

  const next: Toast = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : null),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : null),
    ...(patch.status || patch.type ? { status: normalizeStatus(patch) } : null),
    ...(patch.icon !== undefined ? { icon: patch.icon } : null),
    ...(patch.action !== undefined ? { action: patch.action } : null),
    ...(patch.dismissible !== undefined
      ? { dismissible: patch.dismissible }
      : null),
    ...(patch.duration !== undefined
      ? { duration: patch.duration, createdAt: Date.now() }
      : null),
  }

  records = records.map((item) => (item.id === id ? next : item))
  renderToast(next)
  storeRevision++
}

function dismissToast(id: string) {
  records = records.filter((item) => item.id !== id)
  activeIds.delete(id)
  dismissedIds.add(id)
  toastRHT.dismiss(id)
  storeRevision++
}

function clearToasts() {
  records = []
  activeIds.clear()
  dismissedIds.clear()
  toastRHT.removeAll()
  storeRevision++
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

function StatusIcon({
  status,
  icon,
  size = "sm",
  className,
}: {
  status: ToastStatus
  icon?: ReactNode
  size?: "sm" | "md"
  className?: string
}) {
  const box = size === "md" ? "h-6 w-6" : "h-5 w-5"
  const glyph = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"
  const textSize = size === "md" ? "text-[13px]" : "text-[11px]"

  if (icon !== undefined) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          box,
          className,
        )}
      >
        {icon}
      </span>
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        box,
        STATUS_STYLES[status].icon,
        className,
      )}
    >
      {status === "loading" ? (
        <LoaderCircle className={cn("animate-spin", glyph)} />
      ) : status === "neutral" ? (
        <Bell className={glyph} />
      ) : status === "success" ? (
        <Check className={glyph} strokeWidth={4} />
      ) : status === "error" ? (
        <X className={glyph} strokeWidth={4} />
      ) : (
        <span className={cn("font-bold leading-none", textSize)}>
          {status === "warning" ? "!" : "i"}
        </span>
      )}
    </span>
  )
}

function ToastMessage({
  data,
  content,
  visible,
  variant,
}: {
  data: Toast
  content: FormattedToastContent
  visible: boolean
  variant: ToastVariant
}) {
  const reduce = useReducedMotion()
  const t = useT()
  const [detailOpen, setDetailOpen] = useState(false)
  const detailId = useId()
  const isNotice = variant === "notice"
  const hasDetails = content.details.length > 0

  return (
    <motion.div
      role={data.status === "error" ? "alert" : "status"}
      aria-live={data.status === "error" ? "assertive" : "polite"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={
        visible
          ? reduce
            ? { opacity: 1 }
            : { opacity: 1, y: 0 }
          : reduce
            ? { opacity: 0 }
            : { opacity: 0, y: -6 }
      }
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className={cn(
        "pointer-events-auto flex rounded-[16px] border-2 text-sm font-semibold",
        STATUS_STYLES[data.status].pill,
        isNotice
          ? "w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 p-4"
          : "w-fit max-w-[min(560px,calc(100vw-2rem))] items-center gap-2 px-4 py-2",
        !visible && "pointer-events-none",
      )}
    >
      <StatusIcon
        status={data.status}
        icon={data.icon}
        size={isNotice ? "md" : "sm"}
      />

      {isNotice ? (
        <>
          <div className="min-w-0 flex-1 select-text">
            <p className="text-sm leading-5 font-semibold break-words text-pretty">
              {content.title}
            </p>
            {content.description ? (
              <p className="mt-1 text-xs leading-4 font-normal break-words whitespace-pre-line opacity-75">
                {content.description}
              </p>
            ) : null}
            {hasDetails ? (
              <div className="mt-1.5">
                <button
                  type="button"
                  aria-expanded={detailOpen}
                  aria-controls={detailId}
                  onClick={() => setDetailOpen((open) => !open)}
                  className="inline-flex items-center gap-1 text-[11px] font-normal opacity-70 transition-opacity hover:opacity-100"
                >
                  {t("common.toast.details")}
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform",
                      detailOpen && "rotate-180",
                    )}
                  />
                </button>
                <div id={detailId}>
                  {detailOpen ? (
                    <pre className="mt-1 max-h-28 overflow-auto rounded-lg bg-black/5 p-1.5 font-mono text-[10px] leading-4 font-normal break-words whitespace-pre-wrap opacity-80 dark:bg-white/10">
                      {content.details.join("\n\n")}
                    </pre>
                  ) : null}
                </div>
              </div>
            ) : null}
            {data.action ? (
              <button
                type="button"
                onClick={() => data.action?.onClick(data)}
                className="mt-2 inline-flex text-xs font-semibold underline-offset-2 hover:underline"
              >
                {data.action.label}
              </button>
            ) : null}
          </div>

          {data.dismissible ? (
            <button
              type="button"
              onClick={() => dismissToast(data.id)}
              aria-label={t("common.toast.dismiss")}
              className="-mt-0.5 -mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </>
      ) : (
        <>
          {/* 短提示固定单行，放不下的长文案在 resolveToastVariant 里改走 notice。 */}
          <p className="min-w-0 flex-1 truncate text-sm leading-5">
            {content.title}
          </p>

          {data.dismissible ? (
            <button
              type="button"
              onClick={() => dismissToast(data.id)}
              aria-label={t("common.toast.dismiss")}
              className="-mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg opacity-60 transition-colors hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </>
      )}
    </motion.div>
  )
}

export interface ToasterProps {
  position?: ToastPosition
  maxVisible?: number
  className?: string
}

export function Toaster({
  position = "top-center",
  maxVisible = 4,
  className,
}: ToasterProps) {
  const { toasts } = useToaster()
  const revisionAtRender = storeRevision

  // 模块级 renderToast 需要在创建时知道 Toaster 的位置；放到 effect 里，
  // 避免 render 阶段写模块变量。
  useEffect(() => {
    stackPosition = position
  }, [position])

  // 同步活跃 id / 已 dismiss id，并清掉已经从 RHT store 里移除的记录。
  // revision 变化说明本次快照之后又有 add/dismiss，跳过以免误删新记录。
  useEffect(() => {
    if (revisionAtRender !== storeRevision) return
    activeIds.clear()
    dismissedIds.clear()
    toasts.forEach((item) => {
      activeIds.add(item.id)
      if (item.dismissed) dismissedIds.add(item.id)
    })
    records = records.filter((item) => activeIds.has(item.id))
  }, [toasts, revisionAtRender])

  // react-hot-toast 没有 maxVisible 选项，超出的最旧 toast 主动收掉。
  // 它的列表是最新在前，因此末尾就是最旧的。
  useEffect(() => {
    const visibleToasts = toasts.filter((item) => !item.dismissed)
    if (visibleToasts.length > maxVisible) {
      visibleToasts
        .slice(maxVisible)
        .forEach((item) => toastRHT.dismiss(item.id))
    }
  }, [toasts, maxVisible])

  return (
    <HotToaster
      position={position}
      // 顶部堆叠时让最新的落在最下面，与 antd message / 旧实现一致。
      reverseOrder={position.startsWith("top")}
      gutter={8}
      containerClassName={className}
    />
  )
}
