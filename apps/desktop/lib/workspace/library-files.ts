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