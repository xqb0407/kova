"use client";

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Rust 侧文件树命令（src-tauri/src/fs.rs）的 invoke 封装 + Tauri 门控。
 * 网页端没有本地 FS：读类接口整体返回 null，UI 静默降级（仿 lib/git.ts）。
 * 载荷刻意从简：条目只有 name+dir（Rust 侧不做逐项 stat），文件内容带
 * truncated/binary 标志——渲染层据此提示，不整读大文件。
 */

export type FsDirEntry = { name: string; dir: boolean };

export type FsDirListing = { entries: FsDirEntry[]; truncated: boolean };

export type FsFileContent = {
  content: string;
  truncated: boolean;
  binary: boolean;
};

/** 单层列目录（dir = workspace 相对路径，"" 为根）；失败/网页端返回 null */
export async function fsListDir(
  cwd: string,
  dir: string,
): Promise<FsDirListing | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<FsDirListing>("fs_list_dir", { cwd, dir });
  } catch {
    // cwd-not-allowed / bad-path / not-a-directory：UI 按"空目录"处理
    return null;
  }
}

/** 读文件内容（workspace 相对路径）；读不到/网页端返回 null */
export async function fsReadFile(
  cwd: string,
  path: string,
): Promise<FsFileContent | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<FsFileContent>("fs_read_file", { cwd, path });
  } catch {
    return null;
  }
}
