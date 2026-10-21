"use client";

import type { ThreadMessage } from "@assistant-ui/react";
import {
  FAILED_RE,
  fileChangePair,
  resultText,
  type FileChangeEntry,
  type FileChangeGroup,
} from "@/lib/panels/panel-activity";
import { extractArtifactFileReferences } from "@/lib/panels/artifact-file-references";
import type { FsStatEntry } from "@/lib/workspace/fs";

/**
 * 产物（artifact）派生层。
 *
 * 旧口径只认 `write` 工具 + 文本扩展名白名单，导致 edit-only、bash/脚本/
 * 子代理产出、Office/PDF/媒体全部漏掉。现在按“本轮”聚合多源候选：
 *   write / edit / 子代理 write/edit / 正文文件引用
 * 再由 Host 侧 stat 做存在性、大小、mtime 校验，最后按最新优先截断。
 *
 * 这里只保留纯函数；异步 stat 与 React 生命周期在 artifact-card.tsx 的
 * useTurnArtifacts 里。
 */

/** 文本类交付物：需要“本轮真的动过”或 mtime 新，避免正文讨论误报。 */
const TEXT_DELIVERABLE_EXT = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
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

/** 二进制/办公/媒体交付物：write 文本工具通常产不出，但脚本/插件/子代理可以。 */
const BINARY_DELIVERABLE_EXT = new Set([
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
  "tiff",
  "heic",
  "heif",
  "zip",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "opus",
  "flac",
  "mp4",
  "mov",
  "webm",
  "m4v",
]);

const DELIVERABLE_EXT = new Set([
  ...TEXT_DELIVERABLE_EXT,
  ...BINARY_DELIVERABLE_EXT,
]);

/** 浏览器可直接渲染：html 类 + PDF + SVG。 */
const BROWSER_PREVIEW_EXT = new Set(["html", "htm", "xhtml", "svg", "pdf"]);

/** 右侧文件面板能显示的类型：文本类 + 图片（图片走 fs_read_file_base64）。 */
const FILE_PANEL_EXT = new Set([
  ...TEXT_DELIVERABLE_EXT,
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
  "tiff",
  "heic",
  "heif",
]);

/** 正文里的文件引用若 mtime 早于本轮开始这么多，视为“旧文件被讨论”，不出卡。 */
const TEXT_REFERENCE_MTIME_SKEW_MS = 120_000;

export const ARTIFACT_CANDIDATE_LIMIT = 15;
export const ARTIFACT_VISIBLE_LIMIT = 10;

export type ArtifactSource =
  | "write"
  | "edit"
  | "subagent"
  | "text"
  | "checkpoint";
export type ArtifactOpenMode = "browser" | "file" | "system";

/** 取小写扩展名（不含点）；无扩展名或以点开头的文件（.gitignore）返回空串 */
export function extOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 是否交付物（文本 + 办公/PDF/图片/媒体） */
export function isDeliverable(path: string): boolean {
  return DELIVERABLE_EXT.has(extOf(path));
}

export function isTextDeliverable(path: string): boolean {
  return TEXT_DELIVERABLE_EXT.has(extOf(path));
}

/**
 * checkpoint diff 是全仓改动，json/yaml/xml/log 这类配置/日志噪音太多；
 * 产物发现只收文档、办公、PDF、图片、媒体与压缩包。Office 的
 * `*.deck.canvas.json` 由同轮 edit/write 候选覆盖，不依赖这里。
 */
const CHECKPOINT_EXCLUDED_EXT = new Set([
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "log",
]);

export function isCheckpointDeliverable(path: string): boolean {
  return isDeliverable(path) && !CHECKPOINT_EXCLUDED_EXT.has(extOf(path));
}

/** 适合「浏览器预览」的类型：网页类 + PDF。md/csv/json 等用代码/文件查看即可。 */
export function isBrowserPreviewable(path: string): boolean {
  return BROWSER_PREVIEW_EXT.has(extOf(path));
}

export function openModeFor(path: string): ArtifactOpenMode {
  if (isBrowserPreviewable(path)) return "browser";
  if (FILE_PANEL_EXT.has(extOf(path))) return "file";
  return "system";
}

/** UTF-8 字节数 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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

function isAbsoluteLikePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(path)
  );
}

function toAbsolutePath(cwd: string, path: string): string {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  return isAbsoluteLikePath(path)
    ? normalizeAbsolutePath(path)
    : normalizeAbsolutePath(`${normalizedCwd}/${path}`);
}

function toWorkspaceRelativePath(cwd: string, absPath: string): string | null {
  const root = normalizeAbsolutePath(cwd).replace(/\/$/, "");
  const target = normalizeAbsolutePath(absPath);
  if (target === root) return null;
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : null;
}

function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1) || norm;
}

/**
 * 工作区相对/绝对路径 → file:// URL（内置浏览器只吃 URL，本地文件靠它加载）。
 * 逐段 encodeURIComponent 兼容空格/中文；Windows 盘符走三斜杠 file:///C:/…。
 * 产物卡与「产物」标签页共用一份语义。
 */
export function toFileUrl(cwd: string, rel: string): string {
  let abs = rel.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(abs) && !abs.startsWith("/")) {
    abs = `${cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/${abs.replace(/^\/+/, "")}`;
  }
  // Windows 盘符段（C:）不参与编码，否则编码成 C%3A 后三斜杠判定失效
  const segments = abs.split("/");
  const drive = /^[A-Za-z]:$/.test(segments[0]);
  const encoded = segments
    .map((seg, i) => (drive && i === 0 ? seg : encodeURIComponent(seg)))
    .join("/");
  return drive ? `file:///${encoded}` : `file://${encoded}`;
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
  /** write part 的 toolCallId：没有磁盘实时内容时，预览据此在「文件」标签定位快照 */
  toolCallId: string;
  /** 模型给的路径（可能相对工作区或绝对） */
  path: string;
  /** 归一化绝对路径（目录实时打开/去重身份） */
  absPath?: string;
  /** 在 cwd 下时的相对路径；绝对路径/工作区外为 null */
  relPath?: string | null;
  /** 文件名（含扩展名） */
  base: string;
  /** 内容字节数（stat 优先；无 stat 时 write 用 args.content 降级） */
  size: number;
  source?: ArtifactSource;
  openMode?: ArtifactOpenMode;
};

export type ArtifactCandidate = {
  path: string;
  absPath: string;
  relPath: string | null;
  base: string;
  source: ArtifactSource;
  order: number;
  toolCallId?: string;
  touched: boolean;
  fallbackSize?: number;
  /** 所属轮次的开始时间：跨轮汇总（产物页签）时正文引用的 mtime 门控用 */
  turnStartMs?: number;
};

export interface CollectTurnArtifactCandidatesInput {
  parts: ThreadMessage["content"];
  cwd: string;
  /** 本轮开始的毫秒时间戳：正文引用的 mtime 门控用 */
  turnStartMs: number;
  /** Task toolCallId → 子代理写出的路径列表 */
  subagentPaths?: ReadonlyMap<string, readonly string[]>;
  /** web/dev-preview 没有 Host stat：默认不启用正文引用，避免无法校验的误报 */
  includeTextReferences?: boolean;
}

function makeCandidate(input: {
  path: string;
  cwd: string;
  source: ArtifactSource;
  order: number;
  toolCallId?: string;
  touched: boolean;
  fallbackSize?: number;
}): ArtifactCandidate {
  const absPath = toAbsolutePath(input.cwd, input.path);
  return {
    path: input.path,
    absPath,
    relPath: toWorkspaceRelativePath(input.cwd, absPath),
    base: baseName(input.path),
    source: input.source,
    order: input.order,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    touched: input.touched,
    ...(input.fallbackSize !== undefined
      ? { fallbackSize: input.fallbackSize }
      : {}),
  };
}

const SOURCE_PRIORITY: Record<ArtifactSource, number> = {
  write: 4,
  edit: 3,
  subagent: 2,
  text: 1,
  // checkpoint 只兜底：同路径只要有 write/edit/子代理/正文证据，就用更高优先级的。
  checkpoint: 0,
};

/**
 * 同路径合并：来源优先级 write > edit > subagent > text；order 取最新，
 * touched 取并集；write 的 toolCallId 优先保留（绝对路径的快照降级要用）。
 */
export function mergeArtifactCandidates(
  candidates: readonly ArtifactCandidate[],
  limit: number = ARTIFACT_CANDIDATE_LIMIT,
): ArtifactCandidate[] {
  const byPath = new Map<string, ArtifactCandidate>();
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.absPath);
    if (!existing) {
      byPath.set(candidate.absPath, candidate);
      continue;
    }
    // 同来源时保留更晚的一条（同路径多次 write 的 toolCallId 必须指向最后一版）；
    // 跨来源仍按 write > edit > subagent > text 取内容锚点。
    const winner =
      SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
        ? candidate
        : SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[existing.source]
          ? existing
          : candidate.order >= existing.order
            ? candidate
            : existing;
    const writeCandidate =
      winner.source === "write"
        ? winner
        : existing.source === "write"
          ? existing
          : candidate.source === "write"
            ? candidate
            : undefined;
    byPath.set(candidate.absPath, {
      ...winner,
      order: Math.max(existing.order, candidate.order),
      touched: existing.touched || candidate.touched,
      toolCallId:
        writeCandidate?.toolCallId ??
        winner.toolCallId ??
        existing.toolCallId ??
        candidate.toolCallId,
      fallbackSize:
        winner.fallbackSize ?? existing.fallbackSize ?? candidate.fallbackSize,
      turnStartMs:
        winner.turnStartMs ?? existing.turnStartMs ?? candidate.turnStartMs,
    });
  }
  return [...byPath.values()]
    .sort((left, right) => right.order - left.order)
    .slice(0, limit);
}

/**
 * 本轮产物候选：write / edit / 子代理 / 正文引用。
 * 不读磁盘；存在性/大小/mtime 由 finalizeArtifactCandidates 处理。
 */
export function collectTurnArtifactCandidates(
  input: CollectTurnArtifactCandidatesInput,
): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  const includeTextReferences = input.includeTextReferences !== false;
  let partIndex = 0;

  for (const part of input.parts) {
    if (part.type === "tool-call") {
      if (part.toolName === "write" || part.toolName === "edit") {
        // 结果未回填 = 还在执行；失败 = 未落盘：都不算产物。
        if (part.result != null && part.isError !== true) {
          const failedText = resultText(part.result) ?? "";
          if (!FAILED_RE.test(failedText)) {
            const pair = fileChangePair(part.toolName, part.args);
            if (pair && isDeliverable(pair.path)) {
              candidates.push(
                makeCandidate({
                  path: pair.path,
                  cwd: input.cwd,
                  source: part.toolName,
                  order: partIndex,
                  toolCallId: part.toolCallId,
                  touched: true,
                  ...(part.toolName === "write"
                    ? { fallbackSize: byteLength(pair.newText) }
                    : {}),
                }),
              );
            }
          }
        }
      } else if (part.toolName === "Task" && input.subagentPaths) {
        const paths = input.subagentPaths.get(part.toolCallId) ?? [];
        paths.forEach((path, index) => {
          if (!isDeliverable(path)) return;
          candidates.push(
            makeCandidate({
              path,
              cwd: input.cwd,
              source: "subagent",
              order: partIndex + Math.min((index + 1) / 1000, 0.999),
              touched: true,
            }),
          );
        });
      }
    } else if (part.type === "text" && includeTextReferences) {
      const references = extractArtifactFileReferences(part.text, input.cwd, {
        isDeliverable,
      });
      for (const reference of references) {
        candidates.push(
          makeCandidate({
            path: reference.path,
            cwd: input.cwd,
            source: "text",
            order: partIndex + Math.min(reference.start / 1_000_000, 0.999),
            touched: false,
          }),
        );
      }
    }
    partIndex += 1;
  }

  for (const candidate of candidates) {
    candidate.turnStartMs ??= input.turnStartMs;
  }
  return mergeArtifactCandidates(candidates);
}

export type CheckpointFileLike = {
  path: string;
  status: string;
  oldPath?: string | null;
};

/**
 * 本轮 checkpoint diff → 候选。它能接住 bash/脚本/MCP/插件写出、但正文
 * 没提到的文件；删除/冲突项排除，通用配置类扩展名排除（见
 * isCheckpointDeliverable）。`touched: true`：diff 本身就是“本轮动过”的证据，
 * 不再走 mtime 门控。
 */
export function checkpointFilesToCandidates(input: {
  cwd: string;
  files: readonly CheckpointFileLike[];
  turnStartMs: number;
  orderBase: number;
}): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  input.files.forEach((file, index) => {
    if (file.status === "D" || file.status === "U") return;
    if (!isCheckpointDeliverable(file.path)) return;
    const candidate = makeCandidate({
      path: file.path,
      cwd: input.cwd,
      source: "checkpoint",
      // 排在本轮同步候选之后；同轮 checkpoint 文件之间保持 diff 顺序。
      order:
        input.orderBase - 0.5 + Math.min(index / 1_000_000, 0.499),
      touched: true,
    });
    candidate.turnStartMs = input.turnStartMs;
    candidates.push(candidate);
  });
  return mergeArtifactCandidates(candidates, 60);
}

/**
 * 用 Host stat 收口候选：
 * - 不存在的文件（幻觉路径/已删除）直接丢弃；
 * - 文本类正文引用要求本轮 touched 或 mtime 足够新，避免“讨论 README.md”误报；
 * - 大小用磁盘真实字节；没有 stat（web/dev-preview）时 write 用 content 降级，
 *   正文/子代理候选因无法校验而丢弃。
 */
export function finalizeArtifactCandidates(
  candidates: readonly ArtifactCandidate[],
  stats: ReadonlyMap<string, FsStatEntry> | null,
  options: { turnStartMs: number; visibleLimit?: number },
): MessageArtifact[] {
  const artifacts: MessageArtifact[] = [];
  const visibleLimit = options.visibleLimit ?? ARTIFACT_VISIBLE_LIMIT;
  for (const candidate of candidates) {
    const stat = stats?.get(candidate.absPath);
    const turnStartMs = candidate.turnStartMs ?? options.turnStartMs;
    if (stats !== null) {
      if (!stat || stat.exists !== true || stat.isFile === false) continue;
      if (
        !candidate.touched &&
        isTextDeliverable(candidate.path) &&
        (stat.mtimeMs === undefined ||
          stat.mtimeMs < turnStartMs - TEXT_REFERENCE_MTIME_SKEW_MS)
      ) {
        continue;
      }
    } else {
      // 没有 Host stat（web/dev-preview）就没有存在性证据：
      // 正文引用、checkpoint 清单与子代理路径都是外部事实，不渲染；
      // write/edit 至少有“工具成功返回”这一条证据，保留（write 降级用
      // args.content 计大小）。纯讨论轮既无 touched 候选也无正文引用，
      // 天然为空，不会误报。
      if (
        candidate.source === "text" ||
        candidate.source === "checkpoint" ||
        candidate.source === "subagent"
      ) {
        continue;
      }
    }

    const size =
      stat?.size !== undefined ? stat.size : candidate.fallbackSize;
    artifacts.push({
      toolCallId: candidate.toolCallId ?? `artifact:${candidate.absPath}`,
      path: candidate.path,
      absPath: candidate.absPath,
      relPath: candidate.relPath,
      base: candidate.base,
      size: size ?? 0,
      source: candidate.source,
      openMode: openModeFor(candidate.path),
    });
    if (artifacts.length >= visibleLimit) break;
  }
  return artifacts;
}

/**
 * 兼容旧调用：只从 write parts 派生（不再被消息尾部使用，保留给测试/降级）。
 * 运行中（无 result）或失败（isError）的 write 不收录。
 */
export function messageArtifacts(
  parts: ThreadMessage["content"],
): MessageArtifact[] {
  const byPath = new Map<string, MessageArtifact>();
  for (const part of parts) {
    if (part.type !== "tool-call" || part.toolName !== "write") continue;
    if (part.result == null || part.isError === true) continue;
    if (FAILED_RE.test(resultText(part.result) ?? "")) continue;
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

/**
 * 会话级产物汇总（面板「产物」标签页的数据源）：
 * 把 panel-activity 的文件变更组（edit/write 按路径聚合、条目按时间序）折叠成
 * 交付文件清单——每路径取最后一次成功的 write 为当前版本（edit 只携带替换
 * 片段，不代表全文，故不据其计大小、不换快照锚点）；write 白名单、大小口径
 * 与消息尾部产物卡完全同源，两处展示永远一致。
 * 组序 = 路径首次出现序，这里倒序输出（最新产出的文件在最上）。
 * 在途 / 失败的 write 不收录；消费方以 files 引用做 useMemo，派生廉价。
 */
export function threadArtifacts(groups: FileChangeGroup[]): MessageArtifact[] {
  const out: MessageArtifact[] = [];
  for (const group of groups) {
    if (!isDeliverable(group.path)) continue;
    let last: FileChangeEntry | null = null;
    for (const entry of group.entries) {
      if (entry.op === "write" && !entry.running && !entry.failed) last = entry;
    }
    if (!last) continue;
    const norm = group.path.replace(/\\/g, "/");
    out.push({
      toolCallId: last.toolCallId,
      path: group.path,
      base: norm.slice(norm.lastIndexOf("/") + 1),
      size: byteLength(last.newText),
    });
  }
  return out.reverse();
}

/** 当前轮开始时间：优先取触发本轮的 user 消息 createdAt。 */
export function resolveTurnStartMs(
  messages: readonly { role?: string; createdAt?: Date | string }[],
  turnStartIndex: number,
  fallbackMs: number,
): number {
  const start = messages[turnStartIndex];
  const createdAt = start?.createdAt;
  if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
    return createdAt.getTime();
  }
  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}
