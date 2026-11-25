/**
 * 代码行评论（悬浮 + → 行下内联编辑 → 评论芯片 → 对话）：纯函数层。
 *
 * 输入框里只放一条 `:comment[path:lines · preview]{name=comment:<id>}` 芯片，
 * 完整评论在 code-comment-store；点击芯片由 Dialog 展示，发送时展开为
 * `@path (lines N-M)` + 评论正文，模型按行号读文件。
 * 这里做三件容易出错的事：diff 行选择归一成单侧行号、拼芯片、发送前展开。
 */
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  formatCodeReference,
  parseCodeDirectiveId,
  type CodeReference,
} from "./code-reference";
import {
  commentIdFromDirectiveId,
  type CodeCommentEntry,
} from "./code-comment-store";

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

/** 从整份源码里取评论范围的行文本（1 起，越界夹取） */
export function getTextForLineRange(
  code: string,
  startLine: number,
  endLine: number,
): string {
  const lines = code.split(/\r?\n/);
  const start = Math.max(1, Math.min(startLine, endLine));
  const end = Math.min(lines.length, Math.max(startLine, endLine));
  if (start > end) return "";
  return lines.slice(start - 1, end).join("\n");
}

/**
 * 从 unified patch 提取某一侧的行文本（diff 芯片 Dialog 展示源码用）。
 * lineNumber 是该侧的展示行号：additions 侧 = 新文件行号，deletions 侧 =
 * 旧文件行号。不在 hunk 里的行取不到，按空行处理。
 */
export function extractPatchLineRange(
  patch: string,
  side: "deletions" | "additions",
  startLine: number,
  endLine: number,
): string {
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  let oldNumber = 0;
  let newNumber = 0;

  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldNumber = Number(match[1]);
        newNumber = Number(match[2]);
      }
      continue;
    }
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      oldLines.set(oldNumber, text);
      newLines.set(newNumber, text);
      oldNumber += 1;
      newNumber += 1;
    } else if (marker === "-") {
      oldLines.set(oldNumber, text);
      oldNumber += 1;
    } else if (marker === "+") {
      newLines.set(newNumber, text);
      newNumber += 1;
    }
  }

  const lines = side === "deletions" ? oldLines : newLines;
  const start = Math.max(1, Math.min(startLine, endLine));
  const end = Math.max(startLine, endLine);
  const result: string[] = [];
  for (let line = start; line <= end; line += 1) {
    result.push(lines.get(line) ?? "");
  }
  return result.join("\n");
}

/** 评论 → 输入框芯片：label 带路径/行号和评论预览，完整正文在 store。 */
export function buildCodeCommentChip(entry: CodeCommentEntry): string {
  const range =
    entry.startLine === entry.endLine
      ? `${entry.startLine}`
      : `${entry.startLine}-${entry.endLine}`;
  const preview = entry.comment
    .replace(/[\[\]\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 48);
  const label = `${entry.path}:${range}${preview ? ` · ${preview}` : ""}`;
  return unstable_defaultDirectiveFormatter.serialize({
    type: "comment",
    label,
    id: `comment:${entry.id}`,
  });
}

/**
 * 发送前展开：`:comment[...]` 芯片 → `@path (lines N-M)` + 评论正文。
 * 芯片对应的 store 条目在编辑/发送期间应一直存在；找不到时退而解析 label
 * 前缀（path:range），至少保住文件行号引用，绝不把内部 token 发给模型。
 */
/** 文本里所有评论芯片的 store id（发送成功后清理行下卡片用） */
export function collectCodeCommentIds(text: string): string[] {
  if (!text.includes(":comment[")) return [];
  return unstable_defaultDirectiveFormatter
    .parse(text)
    .flatMap((segment) =>
      segment.kind === "mention" && segment.type === "comment"
        ? [commentIdFromDirectiveId(segment.id)]
        : [],
    );
}

export function expandCodeCommentDirectives(
  text: string,
  lookup: (id: string) => CodeCommentEntry | undefined,
): string {
  if (!text.includes(":comment[")) return text;
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  let out = "";
  let changed = false;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.type === "comment") {
      const entry = lookup(commentIdFromDirectiveId(segment.id));
      if (entry) {
        const ref: CodeReference = {
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          ...(entry.deleted ? { deleted: true } : {}),
        };
        const body = entry.comment.trim();
        out += body ? `${formatCodeReference(ref)}\n${body}` : formatCodeReference(ref);
        changed = true;
        continue;
      }
      // store 丢失（页面刷新后的旧草稿等）：label 前缀仍能还原引用
      const labelRef = parseCodeDirectiveId(segment.label.split(" · ")[0] ?? "");
      if (labelRef) {
        out += formatCodeReference(labelRef);
        changed = true;
        continue;
      }
    }
    out += unstable_defaultDirectiveFormatter.serialize({
      type: segment.type,
      label: segment.label,
      id: segment.id,
    });
  }
  return changed ? out : text;
}
