"use client";

import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";

/**
 * Rust 侧文件树命令（原 Rust 宿主的 fs.rs）的 invoke 封装 + 桌面壳门控。
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

/** 产物卡批量 stat 的单条结果（不读内容，只取存在性/大小/mtime） */
export type FsStatEntry = {
  path: string;
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  mtimeMs?: number;
};

/** 单层列目录（dir = workspace 相对路径，"" 为根）；失败/网页端返回 null */
export async function fsListDir(
  cwd: string,
  dir: string,
): Promise<FsDirListing | null> {
  if (!isDesktop()) return null;
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
  if (!isDesktop()) return null;
  try {
    return await invoke<FsFileContent>("fs_read_file", { cwd, path });
  } catch {
    return null;
  }
}

/**
 * 产物卡批量 stat：一条 IPC 拿回存在性/大小/mtime，不读内容。
 * 相对路径由 Host 收在 workspace 信任根内；绝对路径只做只读元数据。
 * 非桌面端/失败返回 null，调用方降级为不校验。
 */
export async function fsStatMany(
  cwd: string,
  paths: readonly string[],
): Promise<FsStatEntry[] | null> {
  if (!isDesktop() || paths.length === 0) return null;
  try {
    const result = await invoke<{ results?: FsStatEntry[] }>("fs_stat_many", {
      cwd,
      paths: [...paths],
    });
    return Array.isArray(result?.results) ? result.results : null;
  } catch {
    return null;
  }
}

/** 用系统默认应用打开交付物；成功返回 null，失败返回错误码 */
export async function fsOpen(
  cwd: string,
  path: string,
): Promise<string | null> {
  if (!isDesktop()) return "not-desktop";
  try {
    await invoke("fs_open", { cwd, path });
    return null;
  } catch (err) {
    return typeof err === "string" ? err : "open-failed";
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
  if (!isDesktop()) return null;
  try {
    return await invoke<FsBinaryContent>("fs_read_file_base64", { cwd, path });
  } catch (err) {
    return err === "too-large" ? "too-large" : null;
  }
}

/**
 * 写文件内容（workspace 相对路径，UTF-8）：UI 插件面板的文档保存通道
 * （Rust fs_write_file：同受信任根守卫，父目录自动创建，32MB 封顶）。
 * 成功返回 null，失败返回错误码。
 */
export async function fsWriteFileBase64(
  cwd: string,
  path: string,
  base64: string,
): Promise<string | null> {
  if (!isDesktop()) return "not-desktop";
  try {
    await invoke("fs_write_file", { cwd, path, base64 });
    return null;
  } catch (err) {
    return typeof err === "string" ? err : "write-failed";
  }
}

/** 写文本文件（内部转 base64 走同一命令）；语义同 fsWriteFileBase64 */
export async function fsWriteFile(
  cwd: string,
  path: string,
  text: string,
): Promise<string | null> {
  // TextEncoder → 二进制 → base64；分块 String.fromCharCode 防超长参数调用栈
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return fsWriteFileBase64(cwd, path, btoa(binary));
}

/* ---------------- 写命令（文件树右键菜单）：成功返回 null，失败返回错误码 ---------------- */

async function fsWriteCommand(
  cmd:
    | "fs_mkdir"
    | "fs_touch"
    | "fs_rename"
    | "fs_delete"
    | "fs_reveal"
    /** 侧栏项目目录定位：只做绝对路径 + 目录存在校验（见 main 的 project_reveal） */
    | "project_reveal",
  args: Record<string, string>,
): Promise<string | null> {
  if (!isDesktop()) return "not-desktop";
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

/** 同根内移动（树里把行拖到某个文件夹）；成功返回落位名（重名已加序号）与是否真的动了 */
export async function fsMove(
  cwd: string,
  path: string,
  destDir: string,
): Promise<{ ok: true; name: string; moved: boolean } | { ok: false; error: string }> {
  if (!isDesktop()) return { ok: false, error: "not-desktop" };
  try {
    const r = await invoke<{ ok: boolean; name: string; moved: boolean }>(
      "fs_move",
      { cwd, path, destDir },
    );
    return { ok: true, name: r.name, moved: r.moved };
  } catch (err) {
    return { ok: false, error: typeof err === "string" ? err : "unknown" };
  }
}

/** 在系统文件管理器中显示；成功返回 null，失败返回错误码 */
export function fsReveal(cwd: string, path: string): Promise<string | null> {
  return fsWriteCommand("fs_reveal", { cwd, path });
}

/** 在系统文件管理器中定位项目目录（macOS=Finder / Windows=资源管理器）。
 *  项目目录未必是当前 workspace，所以走 project_reveal 而非 fs_reveal；
 *  成功返回 null，失败返回错误码 */
export function projectReveal(path: string): Promise<string | null> {
  return fsWriteCommand("project_reveal", { path });
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
    "move-failed": "移动失败",
    "delete-failed": "删除失败",
    "open-failed": "打开文件失败",
    "reveal-failed": "打开系统文件管理器失败",
    "not-desktop": "仅桌面端可用",
    "bad-base64": "内容编码异常，写入被拒绝",
    "too-large": "内容超过 32MB 上限",
    "home-not-allowed": "不能把家目录本身设为资料库位置（请选其中的一个文件夹）",
    "app-data-not-allowed": "该目录存放应用私有数据，不能设为资料库位置",
  };
  return map[code] ?? "操作失败";
}
