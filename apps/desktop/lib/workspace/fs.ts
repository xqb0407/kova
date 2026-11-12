"use client";

import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";
import { t } from "@/lib/i18n";
import { piRequest } from "@/lib/pi/pi-bridge";
import {
  ensureRemoteProjectsLoaded,
  findRemoteProjectByPath,
  isKnownRemotePath,
} from "@/lib/workspace/remote-projects";

/* ---------------- 远程项目分流 ----------------
 * 远程项目的 cwd 是远端路径。若本机恰好存在同名目录（如 /home），按本地
 * fs_* 读会读到本机文件、写会改本机文件——必须按远程项目清单分流：
 * 命中则走 sidecar 的 remote_fs_*（SSH 通道，主进程注入凭据），绝不下落本地。 */

async function remoteProjectFor(cwd: string): Promise<boolean> {
  if (!isDesktop()) return false;
  await ensureRemoteProjectsLoaded();
  // 当前登记命中 OR 曾经登记过（项目被删、旧会话仍在）——后者也绝不能
  // 回落到本地守卫：宁可报错（无 hostId 时 sidecar 会拒绝）也不读本地盘
  return findRemoteProjectByPath(cwd) !== null || isKnownRemotePath(cwd);
}

/** 远程 fs 调用：remote 只带 hostId，凭据由主进程在转发前注入 */
async function remoteFsCall<T>(
  type: string,
  cwd: string,
  extra: Record<string, unknown>,
): Promise<T> {
  return (await piRequest({
    type,
    cwd,
    remote: { hostId: findRemoteProjectByPath(cwd)?.hostId ?? "" },
    ...extra,
  })) as T;
}

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
    if (await remoteProjectFor(cwd)) {
      const res = await remoteFsCall<{ entries?: FsDirEntry[]; truncated?: boolean }>(
        "remote_fs_list",
        cwd,
        { dir },
      );
      return { entries: res.entries ?? [], truncated: res.truncated === true };
    }
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
    if (await remoteProjectFor(cwd)) {
      const res = await remoteFsCall<FsFileContent>("remote_fs_read", cwd, { path });
      return {
        content: res.content ?? "",
        truncated: res.truncated === true,
        binary: res.binary === true,
      };
    }
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
  // 远程项目：产物卡批量 stat 降级为不校验（逐文件 SSH 往返成本高，且仅
  // 影响"文件是否还在"的提示，不阻塞打开）
  if (await remoteProjectFor(cwd)) return null;
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
  // 远程文件在本机不存在：用系统应用打开无意义，返回明确错误
  if (await remoteProjectFor(cwd)) return "not-supported";
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
    if (await remoteProjectFor(cwd)) {
      const res = await remoteFsCall<{ base64?: string; size?: number; tooLarge?: boolean }>(
        "remote_fs_read_base64",
        cwd,
        { path },
      );
      if (res.tooLarge) return "too-large";
      if (typeof res.base64 === "string") {
        return { base64: res.base64, size: res.size ?? 0 };
      }
      return null;
    }
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
    if (await remoteProjectFor(cwd)) {
      await remoteFsCall("remote_fs_write", cwd, { path, base64 });
      return null;
    }
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

/** 本地写命令 → 远程命令映射（fs_reveal/project_reveal 远程无意义） */
const REMOTE_WRITE_CMD: Partial<Record<string, string>> = {
  fs_mkdir: "remote_fs_mkdir",
  fs_touch: "remote_fs_touch",
  fs_rename: "remote_fs_rename",
  fs_delete: "remote_fs_delete",
};

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
  // 远程项目：写操作走 SSH（路径收敛在远端工作区内）；reveal 类明确不支持
  const cwd = args.cwd ?? "";
  const revealOnly = cmd === "fs_reveal" || cmd === "project_reveal";
  if (revealOnly) {
    const probePath = cmd === "project_reveal" ? args.path ?? "" : cwd;
    if (probePath && (await remoteProjectFor(probePath))) return "not-supported";
  } else if (cwd && (await remoteProjectFor(cwd))) {
    const type = REMOTE_WRITE_CMD[cmd];
    if (!type) return "not-supported";
    try {
      const { cwd: _cwd, ...rest } = args;
      await remoteFsCall(type, cwd, rest);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : typeof err === "string" ? err : "unknown";
    }
  }
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
    if (await remoteProjectFor(cwd)) {
      const res = await remoteFsCall<{ ok?: boolean; name?: string; moved?: boolean }>(
        "remote_fs_move",
        cwd,
        { path, destDir },
      );
      return { ok: true, name: res.name ?? "", moved: res.moved !== false };
    }
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
  // 短码 → 词典键（文案在 common.fsErrors，随语言切换即时生效）
  const key: Record<string, string> = {
    "cwd-not-allowed": "cwdNotAllowed",
    "bad-path": "badPath",
    "bad-name": "badName",
    "already-exists": "alreadyExists",
    "not-found": "notFound",
    "not-a-directory": "notADirectory",
    "mkdir-failed": "mkdirFailed",
    "write-failed": "writeFailed",
    "rename-failed": "renameFailed",
    "move-failed": "moveFailed",
    "delete-failed": "deleteFailed",
    "open-failed": "openFailed",
    "reveal-failed": "revealFailed",
    "not-desktop": "notDesktop",
    "bad-base64": "badBase64",
    "too-large": "tooLarge",
    "not-supported": "notSupported",
    "path outside workspace": "outsideWorkspace",
    "file not found or unreadable": "fileUnreadable",
    "home-not-allowed": "homeNotAllowed",
    "app-data-not-allowed": "appDataNotAllowed",
    busy: "busy",
  };
  const name = key[code];
  return name
    ? t(`common.fsErrors.${name}`)
    : t("common.fsErrors.fallback");
}
