"use client";

import { invoke } from "@/desktop-bridge/core";

/**
 * 资料库（侧边栏「资料库」页）主进程命令封装。
 * 库内文件的读/写/建/删/改名/定位全走 lib/workspace/fs.ts（资料库根子树已
 * 加入 fs_* 可信根，见 main/library.ts），这里只收资料库特有的四件事：
 * 根目录读改、外部文件导入、库内清单扫描（笔记列表 / 名字搜索）。
 */

export interface LibraryRootInfo {
  /** 当前资料库根（绝对路径） */
  root: string;
  /** 缺省资料库根（<appData>/library），设置页「恢复默认」用 */
  defaultRoot: string;
  isDefault: boolean;
  exists: boolean;
}

export function libraryGetRoot(): Promise<LibraryRootInfo> {
  return invoke<LibraryRootInfo>("library_get_root");
}

/** 改资料库位置：成功返回新根，失败 reject 错误短码（bad-path 等） */
export function librarySetRoot(root: string): Promise<{ root: string }> {
  return invoke<{ root: string }>("library_set_root", { root });
}

/** 扫描条目：rel 相对资料库根（POSIX 分隔）或任务工作区根 */
export interface LibraryScanEntry {
  rel: string;
  name: string;
  size: number;
  modified: string | null;
}

export interface LibraryScanResult {
  entries: LibraryScanEntry[];
  truncated: boolean;
}

/**
 * 库内清单扫描：notesOnly = 全库 md（笔记列表）；query = 名字包含匹配（搜索，
 * 能命中未展开目录里的文件）。scope=artifacts 时扫任务工作区（AI 产物搜索）。
 */
export function libraryScan(opts: {
  scope?: "library" | "artifacts";
  notesOnly?: boolean;
  query?: string;
  /** 只扫库根下这棵子树（KB 计数/详情搜索用）；rel 仍是库根相对 */
  under?: string;
}): Promise<LibraryScanResult> {
  return invoke<LibraryScanResult>("library_scan", opts);
}

export interface LibraryImportResult {
  /** 实际落库的名字（重名已加序号） */
  imported: string[];
  renamed: { from: string; to: string }[];
  failed: { path: string; error: string }[];
}

/** 把外部文件/文件夹导入库内 rel 目录（拷贝，重名自动加序号） */
export function libraryImport(
  rel: string,
  paths: string[],
): Promise<LibraryImportResult> {
  return invoke<LibraryImportResult>("library_import", { rel, paths });
}

export interface LibrarySaveNoteResult {
  rel: string;
  name: string;
  title: string;
  tags: string[];
}

/** 「存为笔记」：正文由渲染层拼好，主进程负责落库与去重。
 *  format = "knote" 时 content 是原生 envelope JSON（默认仍是 Markdown）。 */
export function librarySaveNote(args: {
  dir: string;
  title: string;
  tags?: string[];
  content: string;
  format?: "md" | "knote";
}): Promise<LibrarySaveNoteResult> {
  return invoke<LibrarySaveNoteResult>("library_save_note", args);
}

/** 旧笔记路径 → 迁移后的原生笔记路径（历史聊天引用用） */
export function libraryNoteAliasResolve(
  root: string,
  rel: string,
): Promise<{ rel: string | null }> {
  return invoke<{ rel: string | null }>("library_note_alias_resolve", {
    root,
    rel,
  });
}

/** 迁移/重命名后登记旧路径别名；失败由调用方决定是否视为迁移失败 */
export function libraryNoteAliasSet(
  root: string,
  oldRel: string,
  newRel: string,
): Promise<null> {
  return invoke<null>("library_note_alias_set", { root, oldRel, newRel });
}

export interface KnowledgeRefStat {
  count: number;
  lastTs: number | null;
}

/** 一条知识被哪些任务用过（笔记详情/热度排序共用） */
export function knowledgeRefsStats(input: {
  source: string;
  scopeId: string;
  path: string;
}): Promise<KnowledgeRefStat> {
  return invoke<KnowledgeRefStat>("knowledge_refs_stats", { ...input });
}

export interface KnowledgeRefRow {
  sessionId: string;
  ts: number;
  title: string | null;
  cwd: string;
}

export function knowledgeRefsForPath(input: {
  source: string;
  scopeId: string;
  path: string;
  limit?: number;
}): Promise<KnowledgeRefRow[]> {
  return invoke<KnowledgeRefRow[]>("knowledge_refs_for_path", { ...input });
}

export interface KnowledgeRecentRef {
  path: string;
  lastTs: number;
}

export function knowledgeRefsRecent(input: {
  source: string;
  scopeId: string;
  limit?: number;
}): Promise<KnowledgeRecentRef[]> {
  return invoke<KnowledgeRecentRef[]>("knowledge_refs_recent", { ...input });
}

/** KB 改名后迁移知识使用记录（sidecar kb_read 落库的 path 前缀） */
export function knowledgeRefsRepath(input: {
  source: string;
  scopeId: string;
  from: string;
  to: string;
}): Promise<null> {
  return invoke<null>("knowledge_refs_repath", { ...input });
}
