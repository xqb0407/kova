"use client";

/**
 * 从 assistant 正文里抽取「本轮交付文件」候选。
 *
 * 为什么不复用 tool part：产物可能由 bash、脚本、子代理、MCP 或外部 App 写出，
 * 它们没有 write part；正文是用户最终看到的交付声明，和 ZCode 的
 * Assistant File Preview Cards 同一思路。
 *
 * 这里只负责“找路径 + 解析成绝对路径”，是否算交付物、是否本轮产出、文件是否
 * 真实存在，分别由 artifacts.ts 的扩展名表和 Host stat 决定。
 */

export type ArtifactFileReference = {
  start: number;
  end: number;
  /** 正文里的原始写法（诊断用） */
  raw: string;
  /** 解析后的绝对路径（统一 / 分隔） */
  path: string;
};

export type ExtractArtifactFileReferencesOptions = {
  /** 交付物扩展名判定；由 artifacts.ts 注入，避免模块环形依赖 */
  isDeliverable: (path: string) => boolean;
};

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*，。！？；：、]+/giu;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const DELIMITED_FILE_PATH_RE =
  /([`"'“”‘’])([^`"'“”‘’\r\n]+?\.[a-zA-Z0-9]{1,10}(?::\d+(?::\d+)?)?)\1/giu;
// 与 X 的 shared 抽取器同形：支持 Unicode 文件名、空格、Windows 盘符与行号。
// 扩展名先放宽到 1–10 个字母数字，最终由 isDeliverable 过滤，避免维护两份表。
const FILE_PATH_RE =
  /(?:^|[\s("'`“”‘’,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:[a-zA-Z0-9]{1,10})(?::\d+(?::\d+)?)?)(?=$|[\s)"'`“”‘’,.;:!?，。！？；：、])/giu;

function stripFencedCodeBlocks(content: string): string {
  // 保留长度，避免 start/end 偏移错位；代码示例不参与产物推断。
  return content.replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
}

function isAbsoluteLikePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(path)
  );
}

function normalizeAbsolutePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (slashed.startsWith("//")) {
    return `//${normalizeAbsolutePath(slashed.slice(2)).replace(/^\/+/, "")}`;
  }
  const prefix = slashed.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join("/")}`;
}

function normalizeRelativePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
}

function parseFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decoded = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(decoded)) {
      return normalizeAbsolutePath(decoded.slice(1));
    }
    if (url.hostname && url.hostname !== "localhost") {
      return normalizeAbsolutePath(`//${url.hostname}${decoded}`);
    }
    return normalizeAbsolutePath(decoded);
  } catch {
    return null;
  }
}

/**
 * 正文路径 → 绝对路径。相对路径以当前 workspace/task-workspace 为锚；
 * `..` 越界与 `~` 一律拒绝（Host Home 不在 renderer 的事实面里）。
 */
export function resolveArtifactReference(
  workspacePath: string,
  rawPath: string,
): string | null {
  const cleaned = cleanCandidate(rawPath);
  if (!cleaned) return null;
  if (/^https?:\/\//i.test(cleaned)) return null;
  if (/^file:\/\//i.test(cleaned)) return parseFileUrlPath(cleaned);
  if (/^~[\\/]/.test(cleaned)) return null;
  if (isAbsoluteLikePath(cleaned)) return normalizeAbsolutePath(cleaned);

  const relative = normalizeRelativePath(cleaned);
  if (relative === null) return null;
  return normalizeAbsolutePath(`${normalizeAbsolutePath(workspacePath)}/${relative}`);
}

function overlapsRanges(
  start: number,
  end: number,
  ranges: readonly [number, number][],
): boolean {
  return ranges.some(
    ([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart,
  );
}

function normalizeMarkdownHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    if (closing > 0) return trimmed.slice(1, closing);
  }
  // Markdown title：`path "title"` / `path 'title'`
  return trimmed.replace(/\s+["'].*$/u, "");
}

export function extractArtifactFileReferences(
  content: string,
  workspacePath: string,
  options: ExtractArtifactFileReferencesOptions,
): ArtifactFileReference[] {
  if (!content.trim()) return [];
  const text = stripFencedCodeBlocks(content);
  const references: ArtifactFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];

  const add = (raw: string, start: number, end: number) => {
    const path = resolveArtifactReference(workspacePath, raw);
    if (!path || !options.isDeliverable(path)) return;
    references.push({ start, end, raw, path });
  };

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const href = normalizeMarkdownHref(match[2] ?? "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    protectedRanges.push([start, end]);
    add(href, start, end);
  }

  for (const match of text.matchAll(FILE_URL_RE)) {
    const raw = cleanCandidate(match[0] ?? "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (overlapsRanges(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    add(raw, start, end);
  }

  for (const match of text.matchAll(DELIMITED_FILE_PATH_RE)) {
    const raw = cleanCandidate(match[2] ?? "");
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + (match[0]?.length ?? raw.length);
    if (!raw || overlapsRanges(fullStart, fullEnd, protectedRanges)) continue;
    protectedRanges.push([fullStart, fullEnd]);
    const start = fullStart + (match[0]?.indexOf(raw) ?? 0);
    add(raw, start, start + raw.length);
  }

  for (const match of text.matchAll(FILE_PATH_RE)) {
    const raw = cleanCandidate(match[1] ?? "");
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (!raw || overlapsRanges(start, end, protectedRanges)) continue;
    if (/^~[\\/]/.test(raw)) {
      protectedRanges.push([start, end]);
      continue;
    }
    add(raw, start, end);
  }

  // 同一路径只保留最后一次出现（正文越靠后越接近“最终交付”），再按出现顺序返回。
  const latestByPath = new Map<string, ArtifactFileReference>();
  for (const reference of references) {
    const existing = latestByPath.get(reference.path);
    if (!existing || existing.start <= reference.start) {
      latestByPath.set(reference.path, reference);
    }
  }
  return [...latestByPath.values()].sort((left, right) => left.start - right.start);
}
