"use client";

import type { ThreadMessage } from "@assistant-ui/react";
import { fileChangePair } from "@/lib/panel-activity";

/**
 * 产物（artifact）派生层：把一条 assistant 消息里 agent 用 `write` 工具产出的
 * 「面向用户的交付文件」识别出来，归并成消息尾部的产物卡数据。
 *
 * 关键：不依赖模型主动调用任何专用工具——`write` 的 args 里本就带
 * `file_path` + 完整 `content`（见 panel-activity.fileChangePair），卡片的大小、
 * 预览、打开全部从消息快照派生，刷新/切线程后 transcript 重建的 tool part 同样可用。
 * 因此 sidecar / Rust / 协议层零改动。
 *
 * 判定口径 = 扩展名白名单：代码源文件（.ts/.tsx/.css…）不进卡，维持普通「写入」行，
 * 避免编码任务里每建一个文件都弹卡。
 */

/** 交付物扩展名白名单（小写、不含点）。二进制（pdf/png/…）无法经文本 write 工具产出，故不列。 */
const DELIVERABLE_EXT = new Set([
  "html",
  "htm",
  "xhtml",
  "md",
  "markdown",
  "mdx",
  "txt",
  "rtf",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "log",
  "ics",
  "vtt",
  "srt",
]);

/** 取小写扩展名（不含点）；无扩展名或以点开头的文件（.gitignore）返回空串 */
export function extOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 是否交付物（按扩展名白名单） */
export function isDeliverable(path: string): boolean {
  return DELIVERABLE_EXT.has(extOf(path));
}

/** 适合「浏览器预览」的类型：网页类 + PDF（浏览器原生渲染）。md/csv/json 等用代码/文件查看即可，不进浏览器。 */
const BROWSER_PREVIEW_EXT = new Set(["html", "htm", "xhtml", "svg", "pdf"]);
export function isBrowserPreviewable(path: string): boolean {
  return BROWSER_PREVIEW_EXT.has(extOf(path));
}

/** UTF-8 字节数 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 字节数 → 人类可读（B 整数；KB/MB/GB 一位小数，1024 进制） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export type MessageArtifact = {
  /** write part 的 toolCallId：预览据此在「文件」标签定位内容快照 */
  toolCallId: string;
  /** 模型给的路径（可能相对工作区或绝对） */
  path: string;
  /** 文件名（含扩展名） */
  base: string;
  /** 内容字节数（由 write args.content 现算） */
  size: number;
};

/**
 * 从一条消息的 parts 派生产物列表：
 * 扫已完成的 `write` 工具调用 → 交付物白名单过滤 → 按路径去重（后写覆盖）。
 * 运行中（无 result）或失败（isError）的 write 不收录。
 * 只在消息回合结束时调用一次（组件侧已 gate），避免流式逐 token 重算字节数。
 */
export function messageArtifacts(
  parts: ThreadMessage["content"],
): MessageArtifact[] {
  const byPath = new Map<string, MessageArtifact>();
  for (const part of parts) {
    if (part.type !== "tool-call" || part.toolName !== "write") continue;
    // 结果未回填 = 还在执行；失败 = 未落盘：都不算产物
    if (part.result == null || part.isError === true) continue;
    const pair = fileChangePair("write", part.args);
    if (!pair || !isDeliverable(pair.path)) continue;
    const norm = pair.path.replace(/\\/g, "/");
    byPath.set(norm, {
      toolCallId: part.toolCallId,
      path: pair.path,
      base: norm.slice(norm.lastIndexOf("/") + 1),
      size: byteLength(pair.newText),
    });
  }
  return [...byPath.values()];
}
