"use client";

/**
 * 知识引用链接（助手回答里的来源）：
 *
 * - `kova://library?rel=<enc>&line=<n>` → 打开资料库里的笔记；
 * - `kova://project?path=<rel>&line=<n>` → 在文件面板打开项目文件。
 *
 * 链接由 sidecar 的 kb_read 返回，模型原样抄进回答；渲染层只解析这两种
 * scheme，绝不放行任意 URL。资料库页是整页视图，打开请求用模块级 pending
 * 跨过「切页 → 组件重挂载」的那一帧。
 */

export type KnowledgeTarget =
  | { kind: "library"; rel: string; line?: number }
  | { kind: "project"; path: string; line?: number; cwd?: string };

export const LIBRARY_OPEN_REQUEST_EVENT = "kova:library-open-request";

let pendingLibraryOpen: { rel: string; line?: number } | null = null;
let pendingLibraryOpenAt = 0;
/** 跨页 pending 的有效期：切页失败/组件没挂载时不能几小时后突然跳转 */
const PENDING_TTL_MS = 10_000;

/** 资料库内相对路径：POSIX 分段、非绝对、无 `..`、无控制字符 */
export function isSafeLibraryRel(rel: string): boolean {
  if (!rel || rel.length > 1024) return false;
  if (rel.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rel)) return false;
  if (/[\u0000-\u001f]/.test(rel)) return false;
  return rel
    .split(/[\\/]/)
    .every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** 项目内相对路径：与资料库同规则（文件面板按 cwd 解析） */
export function isSafeProjectPath(path: string): boolean {
  return isSafeLibraryRel(path);
}

function parseLine(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `kova://` 引用 → 目标；其他链接或非法内容返回 null */
export function parseKnowledgeHref(href: string): KnowledgeTarget | null {
  if (!href || !href.startsWith("kova://")) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const line = parseLine(url.searchParams.get("line"));
  if (url.hostname === "library") {
    const rel = url.searchParams.get("rel")?.trim() ?? "";
    if (!isSafeLibraryRel(rel)) return null;
    return { kind: "library", rel, ...(line ? { line } : {}) };
  }
  if (url.hostname === "project") {
    const path = url.searchParams.get("path")?.trim() ?? "";
    if (!isSafeProjectPath(path)) return null;
    const rawCwd = url.searchParams.get("cwd")?.trim() ?? "";
    // cwd 只接受绝对路径：来自 kb_read 的会话目录；相对值会让文件面板解析到
    // 当前工作区之外的地方，直接忽略退回 getWorkspace()。
    const cwd =
      /^([a-zA-Z]:[\\/]|[\\/])/.test(rawCwd) && !/[\u0000-\u001f]/.test(rawCwd)
        ? rawCwd
        : undefined;
    return {
      kind: "project",
      path,
      ...(line ? { line } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  return null;
}

/** 请求打开一篇资料库笔记（切页由 base 监听事件完成） */
export function requestOpenLibraryFile(rel: string, line?: number): void {
  if (!isSafeLibraryRel(rel)) return;
  pendingLibraryOpen = { rel, ...(line ? { line } : {}) };
  pendingLibraryOpenAt = Date.now();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LIBRARY_OPEN_REQUEST_EVENT));
}

function livePending(): { rel: string; line?: number } | null {
  if (!pendingLibraryOpen) return null;
  if (Date.now() - pendingLibraryOpenAt > PENDING_TTL_MS) {
    pendingLibraryOpen = null;
    return null;
  }
  return pendingLibraryOpen;
}

/** 页面挂载/事件到达时取走待打开请求（取走即清空） */
export function consumePendingLibraryOpen(): { rel: string; line?: number } | null {
  const next = livePending();
  pendingLibraryOpen = null;
  return next;
}

/** 是否有待处理请求（路由恢复 root 后可重试） */
export function peekPendingLibraryOpen(): { rel: string; line?: number } | null {
  return livePending();
}
