"use client";

/**
 * 工作区落盘目录名的唯一来源：`项目/<目录名>`（划词笔记、工作区 KB 的父目录、
 * composer 的 preferPrefix 都用它）。独立成叶子模块——knowledge-bases 与
 * library-save-note 互相需要，避免循环导入。
 */

/** 来源项目 → 笔记子目录；无 cwd / 取不到目录名时落收件箱 */
export function projectFolderFor(cwd: string | null | undefined): string {
  const base = cwd
    ? (cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "")
    : "";
  const safe = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return safe ? `项目/${safe}` : "收件箱";
}
