import type { ReactNode } from "react"

export type ToastVariant = "message" | "notice"

export type ToastFormatInput = {
  title: ReactNode
  description?: ReactNode
  action?: unknown
}

export type ParsedToastText = {
  head: string
  message?: string
  detail?: string
}

export type FormattedToastContent = {
  title: ReactNode
  description?: ReactNode
  details: string[]
}

/** 单行 message 的标题上限；超过就升级成 notice，避免被 truncate 吃掉信息。 */
const MESSAGE_TITLE_MAX = 24

/** 原始 JSON 只用于排查，限制长度，避免异常响应把 toast 撑爆。 */
const MAX_DETAIL_LENGTH = 8000

export function resolveToastVariant(input: ToastFormatInput): ToastVariant {
  if (input.description || input.action) return "notice"
  // ReactNode 标题无法可靠测量宽度，直接按 notice 处理，避免截断。
  if (typeof input.title !== "string") return "notice"
  return input.title.length > MESSAGE_TITLE_MAX ? "notice" : "message"
}

/**
 * 接口错误经常被整段塞进文案（`连接失败: HTTP 429 - {"error":{...}}`），
 * 直接铺在通知里又长又难读。这里把可解析的 JSON 尾巴拆出来：标题只留
 * 人类可读的前缀，`message` 用于描述，原始 JSON 收进可展开的详情。
 */
export function parseStructuredText(value: string): ParsedToastText {
  const index = value.indexOf("{")
  if (index < 0) return { head: value }

  const raw = value.slice(index).trim()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return { head: value }

    const record = parsed as Record<string, unknown>
    const error = record.error
    const errorMessage =
      error && typeof error === "object"
        ? (error as Record<string, unknown>).message
        : undefined
    const message =
      typeof errorMessage === "string"
        ? errorMessage
        : typeof record.message === "string"
          ? record.message
          : undefined
    const head = value
      .slice(0, index)
      .replace(/[\s:：\-–—·]+$/u, "")
      .trim()
    const pretty = JSON.stringify(parsed, null, 2)

    return {
      head: head || message || value,
      message: head ? message : undefined,
      detail:
        pretty.length > MAX_DETAIL_LENGTH
          ? `${pretty.slice(0, MAX_DETAIL_LENGTH)}\n…`
          : pretty,
    }
  } catch {
    return { head: value }
  }
}

export function formatToastContent(
  input: ToastFormatInput,
  variant: ToastVariant,
): FormattedToastContent {
  if (variant === "message") {
    return {
      title: input.title,
      description: input.description,
      details: [],
    }
  }

  let title = input.title
  let description = input.description
  const details: string[] = []

  if (typeof title === "string") {
    const parsed = parseStructuredText(title)
    if (parsed.detail) {
      title = parsed.head
      details.push(parsed.detail)
      if (description === undefined && parsed.message) {
        description = parsed.message
      }
    }
  }

  // description 里也常放原始错误；同样拆开，避免整段 JSON 直接铺开。
  if (typeof description === "string") {
    const parsed = parseStructuredText(description)
    if (parsed.detail) {
      description =
        parsed.head && parsed.message
          ? `${parsed.head} · ${parsed.message}`
          : parsed.head
      if (!details.includes(parsed.detail)) details.push(parsed.detail)
    }
  }

  return { title, description, details }
}
