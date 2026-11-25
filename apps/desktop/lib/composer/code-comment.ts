/**
 * 代码行评论（悬浮 + → 写评论 → 进输入框）：纯函数层。
 *
 * 复用「引用到对话」的 `:code` 芯片，评论正文追加在芯片后面；发送时现有
 * expandCodeDirectives 展开为 `@path (lines N-M) 评论`，模型按行号读文件。
 * 这里只做两件容易出错的事：把 diff 的行选择归一成单侧行号、拼芯片与正文。
 */
import { buildCodeDirective, type CodeReference } from "./code-reference";

/** @pierre/diffs 的 gutter utility 回调形状（只取用得到的字段） */
export type DiffLineSelection = {
  start: number;
  end: number;
  side?: "deletions" | "additions";
  endSide?: "deletions" | "additions";
};

export type CodeCommentRange = Pick<CodeReference, "startLine" | "endLine" | "deleted">;

/**
 * diff 行选择 → 可引用到当前文件的行范围。
 *
 * - additions 侧（新增行 + 上下文行）：行号就是当前文件行号；
 * - deletions 侧：行号是旧文件行号，标 deleted 让模型别直接按新文件读；
 * - 跨旧/新两侧（拖选穿过删除块与新增块）：两侧行号不能组成一个连续区间，
 *   退回锚点所在侧的单行，避免给出错误的 @path (lines ...)。
 */
export function normalizeDiffLineSelection(range: DiffLineSelection): CodeCommentRange {
  const startSide = range.side ?? "additions";
  const endSide = range.endSide ?? startSide;
  if (startSide !== endSide) {
    const line = startSide === "additions" ? range.start : range.end;
    return { startLine: line, endLine: line };
  }
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    ...(startSide === "deletions" ? { deleted: true } : {}),
  };
}

/** 输入框插入文本：`:code[...]` 芯片 + 一个空格 + 评论正文（空评论只留芯片） */
export function buildCodeCommentText(ref: CodeReference, comment: string): string {
  const chip = buildCodeDirective(ref);
  const body = comment.trim();
  return body ? `${chip} ${body}` : chip;
}
