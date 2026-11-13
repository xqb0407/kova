import { describe, expect, test } from "bun:test"

import {
  formatToastContent,
  parseStructuredText,
  resolveToastVariant,
} from "./toast-format"

describe("parseStructuredText", () => {
  test("splits a human prefix from a JSON error tail", () => {
    const parsed = parseStructuredText(
      '连接失败: HTTP 429 - {"error":{"code":null,"message":"ZCode: exceed quota limit","type":"rate_limit_error"}}',
    )

    expect(parsed.head).toBe("连接失败: HTTP 429")
    expect(parsed.message).toBe("ZCode: exceed quota limit")
    expect(parsed.detail).toContain('"type": "rate_limit_error"')
  })

  test("leaves plain text untouched", () => {
    expect(parseStructuredText("已复制到剪贴板")).toEqual({
      head: "已复制到剪贴板",
    })
  })

  test("falls back when the JSON tail is malformed", () => {
    const value = "保存失败 {not json"
    expect(parseStructuredText(value)).toEqual({ head: value })
  })

  test("uses the error message as head when the whole text is JSON", () => {
    const parsed = parseStructuredText(
      '{"error":{"message":"quota exceeded"}}',
    )

    expect(parsed.head).toBe("quota exceeded")
    expect(parsed.message).toBeUndefined()
    expect(parsed.detail).toContain('"message": "quota exceeded"')
  })
})

describe("resolveToastVariant", () => {
  test("short titles stay one-line messages", () => {
    expect(resolveToastVariant({ title: "已复制到剪贴板" })).toBe("message")
  })

  test("descriptions and actions upgrade to notices", () => {
    expect(
      resolveToastVariant({ title: "更新失败", description: "网络异常" }),
    ).toBe("notice")
    expect(
      resolveToastVariant({ title: "已归档", action: { label: "撤销" } }),
    ).toBe("notice")
  })

  test("long titles upgrade to notices", () => {
    expect(resolveToastVariant({ title: "一".repeat(25) })).toBe("notice")
  })

  test("non-string titles upgrade to notices", () => {
    expect(resolveToastVariant({ title: 42 })).toBe("notice")
  })
})

describe("formatToastContent", () => {
  test("parses both title and description", () => {
    const content = formatToastContent(
      {
        title: '连接失败: HTTP 429 - {"error":{"message":"quota"}}',
        description: '重试失败: HTTP 500 - {"error":{"message":"upstream"}}',
      },
      "notice",
    )

    expect(content.title).toBe("连接失败: HTTP 429")
    expect(content.description).toBe("重试失败: HTTP 500 · upstream")
    expect(content.details).toHaveLength(2)
  })

  test("message content is passed through as-is", () => {
    const content = formatToastContent({ title: "已复制" }, "message")
    expect(content).toEqual({ title: "已复制", description: undefined, details: [] })
  })
})
