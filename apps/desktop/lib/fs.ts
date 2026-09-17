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

export type FsBinaryContent = { base64: string; size: number };

/**
 * 面板图片预览支持的扩展名 → data URL mime（CSP img-src 已放行 data:）。
 * svg 不在列：它是文本，fs_read_file 正常出内容，走源码渲染。
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  tiff: "image/tiff",
};

/** 按扩展名取图片 mime；非图片返回 null（调用方据此决定走哪条读取路径） */
export function imageMimeFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * 读文件原始字节（base64，图片预览专用，Rust 侧封顶 20MB）。
 * 成功返回内容；超过 20MB 返回 "too-large"；读不到/网页端返回 null。
 */
export async function fsReadFileBase64(
  cwd: string,
  path: string,
): Promise<FsBinaryContent | "too-large" | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<FsBinaryContent>("fs_read_file_base64", { cwd, path });
  } catch (err) {
    return err === "too-large" ? "too-large" : null;
  }
}

/* ---------------- 写命令（文件树右键菜单）：成功返回 null，失败返回错误码 ---------------- */

async function fsWriteCommand(
  cmd: "fs_mkdir" | "fs_touch" | "fs_rename" | "fs_delete" | "fs_reveal",
  args: Record<string, string>,
): Promise<string | null> {
  if (!isTauri()) return "not-tauri";
  try {
    await invoke(cmd, args);
    return null;
  } catch (err) {
    return typeof err === "string" ? err : "unknown";
  }
}

/** 新建目录（父目录一并创建）；成功返回 null，失败返回错误码 */
export function fsMkdir(cwd: string, path: string): Promise<string | null> {
  return fsWriteCommand("fs_mkdir", { cwd, path });
}

/** 新建空文件（已存在则报 already-exists）；成功返回 null，失败返回错误码 */
export function fsTouch(cwd: string, path: string): Promise<string | null> {
  return fsWriteCommand("fs_touch", { cwd, path });
}

/** 同目录内改名（newName 必须是纯名字）；成功返回 null，失败返回错误码 */
export function fsRename(
  cwd: string,
  path: string,
  newName: string,
): Promise<string | null> {
  return fsWriteCommand("fs_rename", { cwd, path, newName });
}

/** 删除文件/目录（目录递归，永久删除）；成功返回 null，失败返回错误码 */
export function fsDelete(cwd: string, path: string): Promise<string | null> {
  return fsWriteCommand("fs_delete", { cwd, path });
}

/** 在系统文件管理器中显示；成功返回 null，失败返回错误码 */
export function fsReveal(cwd: string, path: string): Promise<string | null> {
  return fsWriteCommand("fs_reveal", { cwd, path });
}

/** 错误码 → 提示文案（fs.rs 写命令统一返回短码） */
export function fsErrorText(code: string): string {
  const map: Record<string, string> = {
    "cwd-not-allowed": "当前目录不受信任，操作被拒绝",
    "bad-path": "路径不合法",
    "bad-name": "名称不合法（不能包含 \\ / : * ? \" < > |）",
    "already-exists": "同名文件或文件夹已存在",
    "not-found": "目标不存在（可能已被移动或删除）",
    "not-a-directory": "目标不是文件夹",
    "mkdir-failed": "新建文件夹失败",
    "write-failed": "新建文件失败",
    "rename-failed": "重命名失败",
    "delete-failed": "删除失败",
    "reveal-failed": "打开系统文件管理器失败",
    "not-tauri": "仅桌面端可用",
  };
  return map[code] ?? "操作失败";
}
