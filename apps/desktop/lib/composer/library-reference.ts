/**
 * 资料库引用（「引用到对话」）：把资料库里的文件/笔记变成一条 **agent 按需读取的
 * 紧凑引用**。与代码引用（lib/composer/code-reference）同一套机制：
 *
 * - **芯片文本**（输入框/消息里显示）：`:library[标题:12-20]{name=library:<encRel>:<encAbs>#L12-L20}`
 *   —— 复用 directive 芯片机制（cm-directive 的 Decoration.replace 原子芯片）；
 * - **发送展开**（buildPiSendInput 调用本模块）：
 *   `[资料库笔记] rel → \`/abs/path\` (lines 12-20)`；内容由 agent 用自己的文件工具
 *   读取——内容永远最新、不占上下文。id 内固化插入时的绝对路径：资料库根改位置
 *   后，旧引用仍指向原文件，不会被新根下的同名文件顶替。
 * - **缺失安全网**：草稿里的引用由 lib/workspace/library-ref-guard 校验；发送展开时
 *   若命中缺失集合，输出 `[资料库文件已删除] …`，绝不把死路径发给模型。
 *
 * 本模块保持纯函数（只依赖 directive formatter 与一个模块级缺失集合），发送链路与
 * 测试可直接引用。
 */
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";

export const LIBRARY_DIRECTIVE_TYPE = "library";

/** 资料库引用（插入芯片用；absPath 在插入时固化） */
export type LibraryReference = {
  /** 相对资料库根的路径（POSIX 分隔） */
  rel: string;
  /** 展示名：笔记标题或文件名（芯片 label 用） */
  name: string;
  /** 绝对路径 */
  absPath: string;
  startLine?: number;
  endLine?: number;
};

/** 从指令 id 解析出的引用参数（无展示名） */
export type ParsedLibraryReference = {
  rel: string;
  absPath: string;
  startLine?: number;
  endLine?: number;
};

/* ------------------------------ id 构造与解析 ------------------------------ */

/** 行号后缀：`#L12` / `#L12-20`；无行号返回空串 */
function lineSuffix(startLine?: number, endLine?: number): string {
  if (!startLine || startLine < 1) return "";
  const end = endLine && endLine >= startLine ? endLine : startLine;
  return end === startLine ? `#L${startLine}` : `#L${startLine}-${end}`;
}

/** 指令 id：`library:<encRel>:<encAbs>#L12-20`（两个路径各自整段 encodeURIComponent，
 *  所以 id 里未编码的 `:` 只有分隔符，`#` 只可能是行号后缀的起点） */
export function buildLibraryDirectiveId(ref: LibraryReference): string {
  const encRel = encodeURIComponent(ref.rel);
  const encAbs = encodeURIComponent(ref.absPath);
  return `library:${encRel}:${encAbs}${lineSuffix(ref.startLine, ref.endLine)}`;
}

/** 指令 id（或退而用 label）→ 引用参数；不合法返回 null */
export function parseLibraryDirectiveId(id: string): ParsedLibraryReference | null {
  if (!id.startsWith("library:")) return null;
  const hash = id.indexOf("#L");
  const base = hash >= 0 ? id.slice(0, hash) : id;
  const linePart = hash >= 0 ? id.slice(hash + 2) : "";
  const parts = base.split(":");
  if (parts.length !== 3) return null;
  const encRel = parts[1];
  const encAbs = parts[2];
  if (!encRel || !encAbs) return null;
  try {
    const rel = decodeURIComponent(encRel);
    const absPath = decodeURIComponent(encAbs);
    let startLine: number | undefined;
    let endLine: number | undefined;
    if (linePart) {
      const match = /^(\d+)(?:-(\d+))?$/u.exec(linePart);
      if (!match) return null;
      startLine = Number(match[1]);
      endLine = match[2] ? Number(match[2]) : startLine;
      if (!Number.isFinite(startLine) || startLine < 1) return null;
      if (!Number.isFinite(endLine) || endLine < startLine) return null;
    }
    return {
      rel,
      absPath,
      ...(startLine ? { startLine, endLine } : {}),
    };
  } catch {
    return null;
  }
}

/* ------------------------------ 芯片文本 ------------------------------ */

/** 芯片 label 不能含 `]` / 换行（会截断 formatter 序列化）：替换而不是丢字 */
export function sanitizeDirectiveLabel(label: string): string {
  const cleaned = label
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "file";
}

/** 引用 → 芯片文本：`:library[标题:12-20]{name=library:...}` */
export function buildLibraryDirective(ref: LibraryReference): string {
  const lineLabel = ref.startLine
    ? `:${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ""}`
    : "";
  return unstable_defaultDirectiveFormatter.serialize({
    type: LIBRARY_DIRECTIVE_TYPE,
    label: sanitizeDirectiveLabel(`${ref.name}${lineLabel}`),
    id: buildLibraryDirectiveId(ref),
  });
}

/* ------------------------------ 发送展开 ------------------------------ */

/** 展开串里的路径呈现：反引号包裹；路径本身含反引号时退回双引号 */
function formatRefPath(absPath: string): string {
  if (absPath.includes("`")) return `"${absPath.replace(/"/g, "'")}"`;
  return `\`${absPath}\``;
}

/** 引用 → 给模型的引用串（笔记与普通文件分开标注，行号可选） */
export function formatLibraryReference(ref: ParsedLibraryReference): string {
  const lines = ref.startLine
    ? ref.endLine && ref.endLine !== ref.startLine
      ? ` (lines ${ref.startLine}-${ref.endLine})`
      : ` (line ${ref.startLine})`
    : "";
  const kind = /\.(md|markdown|knote)$/iu.test(ref.rel)
    ? "资料库笔记"
    : "资料库文件";
  return `[${kind}] ${ref.rel} → ${formatRefPath(ref.absPath)}${lines}`;
}

/* ------------------------------ 缺失安全网 ------------------------------ */

/**
 * 失效引用集合（lib/workspace/library-ref-guard 校验后写入）。key 是指令 id。
 * 发送展开时的安全网：命中即输出「已删除」标记，绝不把死路径发给模型。
 */
const missingRefIds = new Set<string>();

export function setMissingLibraryRefIds(ids: ReadonlySet<string>): void {
  missingRefIds.clear();
  for (const id of ids) missingRefIds.add(id);
}

export function isLibraryRefMissing(id: string): boolean {
  return missingRefIds.has(id);
}

/* ------------------------------ 笔记正文内联 ------------------------------ */

/**
 * 小笔记的正文缓存（library-note-inline.ts 的 prefetch 在发送前写入）：
 * 命中时模型随 prompt 直接拿到正文，无需一次 read 工具调用。
 *
 * 上下文预算：
 * - 单篇全文内联上限 8KB（超出走路径引用，由 agent 按需 read）；
 * - 单条消息的内联总预算 24KB——引用多篇笔记时，超出预算的从后往前退回
 *   路径引用，避免一次发送把上下文顶爆；
 * - 选区引用只内联选中的行（不再把整篇灌进去），切片后仍受单篇上限约束；
 * - 缓存本身允许到 64KB：选区可能落在较大的笔记里，切片需要原文。
 */
export const LIBRARY_INLINE_MAX_BYTES = 8 * 1024;
export const LIBRARY_INLINE_TOTAL_MAX_BYTES = 24 * 1024;
export const LIBRARY_NOTE_CACHE_MAX_BYTES = 64 * 1024;

// key = 绝对路径：同一篇笔记的全文引用与不同选区引用共用一份正文，不重复读盘
const noteBodyCache = new Map<
  string,
  { title: string; body: string; bytes: number }
>();

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function rememberLibraryNoteBody(
  absPath: string,
  title: string,
  body: string,
): void {
  noteBodyCache.set(absPath, { title, body, bytes: byteLength(body) });
}

export function peekLibraryNoteBody(
  absPath: string,
): { title: string; body: string; bytes: number } | undefined {
  return noteBodyCache.get(absPath);
}

/** 正文缓存失效（读失败/超限/本次不内联）：避免下一次拿旧正文喂模型 */
export function forgetLibraryNoteBody(absPath: string): void {
  noteBodyCache.delete(absPath);
}

// key = 绝对路径：发送前 prefetch 从 library_file_meta 重读，保证标签新鲜
const noteTagsCache = new Map<string, string[]>();

export function rememberLibraryNoteTags(
  absPath: string,
  tags: readonly string[],
): void {
  noteTagsCache.set(absPath, [...tags]);
}

export function peekLibraryNoteTags(absPath: string): string[] | undefined {
  return noteTagsCache.get(absPath);
}

export function forgetLibraryNoteTags(absPath: string): void {
  noteTagsCache.delete(absPath);
}

/** 选区引用只取选中的行（1-based，闭区间）；越界自动夹取，空结果返回 null */
function sliceNoteBody(
  body: string,
  startLine?: number,
  endLine?: number,
): string | null {
  if (!startLine) return body;
  const lines = body.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(
    lines.length,
    endLine && endLine >= startLine ? endLine : startLine,
  );
  if (start >= lines.length) return null;
  return lines.slice(start, end).join("\n");
}

/** 标签行：模型据此知道笔记的分类（无标签返回空串） */
function tagsLine(tags: readonly string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  return `Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`;
}

/** 内联块（给模型的隐藏上下文；展示层剥掉） */
function noteInlineBlock(
  title: string,
  ref: ParsedLibraryReference,
  body: string,
  tags: readonly string[] | undefined,
): string {
  const range = ref.startLine
    ? ref.endLine && ref.endLine !== ref.startLine
      ? ` lines ${ref.startLine}-${ref.endLine}`
      : ` line ${ref.startLine}`
    : "";
  const tagLine = tagsLine(tags);
  return [
    `Referenced note "${title}" (source: ${formatRefPath(ref.absPath)}${range}):`,
    ...(tagLine ? [tagLine] : []),
    "",
    body.trim(),
  ].join("\n");
}

/** 文本里所有 `:library[...]` 芯片 → 解析后的引用（按出现顺序，id 去重） */
export function collectLibraryReferences(
  text: string,
): { id: string; ref: ParsedLibraryReference }[] {
  if (!text.includes(":library[")) return [];
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  const out: { id: string; ref: ParsedLibraryReference }[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "text") continue;
    if (segment.type !== LIBRARY_DIRECTIVE_TYPE) continue;
    if (seen.has(segment.id)) continue;
    const ref =
      parseLibraryDirectiveId(segment.id) ??
      parseLibraryDirectiveId(segment.label);
    if (!ref) continue;
    seen.add(segment.id);
    out.push({ id: segment.id, ref });
  }
  return out;
}

/**
 * 发送前的资料库上下文（**芯片原样保留**——用户气泡渲染芯片，而不是展开后的
 * 绝对路径）：
 * - 缺失引用 → 「已删除」标记行；
 * - 小笔记正文在缓存里（≤16KB）→ 经 `onInlineNote` 交出正文块（隐藏块）；
 * - 其余 → 一行可读引用（rel + 绝对路径 + 行号）。
 * 返回要放进隐藏块的行；没有引用返回 null。
 */
export function buildLibraryContext(
  text: string,
  onInlineNote?: (block: string) => void,
): string | null {
  const refs = collectLibraryReferences(text);
  if (refs.length === 0) return null;
  const lines: string[] = [];
  // 单条消息的内联总预算：多篇笔记引用时，超出预算的退回路径引用（agent 自己读）
  let inlineBudget = LIBRARY_INLINE_TOTAL_MAX_BYTES;
  for (const { id, ref } of refs) {
    if (isLibraryRefMissing(id)) {
      lines.push(`[资料库文件已删除] ${ref.rel}（原路径 ${ref.absPath}）`);
      continue;
    }
    const note = peekLibraryNoteBody(ref.absPath);
    if (note && onInlineNote) {
      // 选区引用只内联选中的行；整篇引用受单篇上限约束
      const slice = sliceNoteBody(note.body, ref.startLine, ref.endLine);
      if (slice) {
        const bytes = byteLength(slice);
        if (bytes <= LIBRARY_INLINE_MAX_BYTES && bytes <= inlineBudget) {
          onInlineNote(
            noteInlineBlock(
              note.title,
              ref,
              slice,
              peekLibraryNoteTags(ref.absPath),
            ),
          );
          inlineBudget -= bytes;
          continue;
        }
      }
    }
    const line = formatLibraryReference(ref);
    const tags = peekLibraryNoteTags(ref.absPath);
    lines.push(
      tags && tags.length > 0
        ? `${line} [${tagsLine(tags)}]`
        : line,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** 从文本里删除指定 id 的 `:library[...]` 芯片（失效引用条「移除」用）；
 *  其余指令与正文原样保留。没有任何命中时一字不动。 */
export function removeLibraryDirectives(
  text: string,
  ids: ReadonlySet<string>,
): string {
  if (ids.size === 0 || !text.includes(":library[")) return text;
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  let out = "";
  let changed = false;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.type === LIBRARY_DIRECTIVE_TYPE && ids.has(segment.id)) {
      changed = true;
      continue;
    }
    out += unstable_defaultDirectiveFormatter.serialize({
      type: segment.type,
      label: segment.label,
      id: segment.id,
    });
  }
  if (!changed) return text;
  // 删完芯片可能留下多余空白/空行：收一下，不让草稿看起来破破的
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* ------------------------------ 路径工具 ------------------------------ */

/** 资料库根 + rel → 绝对路径。跟随 root 自身的分隔符（Windows 反斜杠 / POSIX 斜杠） */
export function joinFsPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const tail = rel
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(sep);
  return tail ? `${base}${sep}${tail}` : base;
}
