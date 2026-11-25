"use client";

/**
 * 代码行评论的芯片载荷（`:comment[...]{name=comment:<id>}`）。
 *
 * 芯片文本只带 id，完整评论放这里；点击芯片由 Dialog 读取展示，发送时由
 * `expandCodeCommentDirectives` 还原成模型可读的引用 + 评论正文。
 *
 * 模块级 Map 与 `element-refs` 同口径：生命周期跟随页面，不落盘。评论只
 * 存在于当前 composer 草稿；发送后 transcript 里是展开后的正文。
 */
import type { CodeCommentRange } from "./code-comment";

export type CodeCommentEntry = CodeCommentRange & {
  id: string;
  path: string;
  comment: string;
  /** 评论范围对应的源码快照（Dialog 展示用；diff 从 patch 提取） */
  selectedText?: string;
  createdAt: number;
};

export const OPEN_CODE_COMMENT_EVENT = "kova:code-comment-open";

const entries = new Map<string, CodeCommentEntry>();
/** 芯片删掉/发送后理论上应清；这里再兜一层上限，防极端情况无界增长 */
const MAX_ENTRIES = 200;

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCodeCommentEntry(
  ref: CodeCommentRange & { path: string },
  comment: string,
  selectedText?: string,
): CodeCommentEntry {
  return {
    id: createId(),
    path: ref.path,
    startLine: ref.startLine,
    endLine: ref.endLine,
    ...(ref.deleted ? { deleted: true } : {}),
    comment: comment.trim(),
    ...(selectedText ? { selectedText } : {}),
    createdAt: Date.now(),
  };
}

export function putCodeComment(entry: CodeCommentEntry): void {
  entries.set(entry.id, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (!oldest) break;
    entries.delete(oldest);
  }
}

export function getCodeComment(id: string): CodeCommentEntry | undefined {
  return entries.get(id);
}

export function removeCodeComment(id: string): void {
  entries.delete(id);
}

/** 芯片 id（`comment:<uuid>`）→ store key */
export function commentIdFromDirectiveId(id: string): string {
  return id.startsWith("comment:") ? id.slice("comment:".length) : id;
}
