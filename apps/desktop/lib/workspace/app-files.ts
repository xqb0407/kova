"use client";

import { invoke } from "@tauri-apps/api/core";

/**
 * 「我的文件 → 本地」文件清单与操作（AI 产物目录）。
 * 事实源在 Rust：fs::app_file_list 列 app_data/task-workspace（无目录任务
 * 会话的执行工作目录）下的相对目录，支持子路径逐层下钻；路径校验（拒 `..`
 * 与绝对路径、canonicalize 防符号链接逃逸）在 Rust join_rel 完成。
 */

/** rel 相对条目；size 仅文件有效，目录恒 0（UI 显示 "—"） */
export interface AppFileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** ISO 8601（本地时区）；不可得为 null */
  modified: string | null;
}

/** 列 task-workspace 下 rel（"" = 根）一层条目 */
export function listAppFiles(rel = ""): Promise<AppFileEntry[]> {
  return invoke<{ entries: AppFileEntry[] }>("app_file_list", { rel }).then((r) => r.entries);
}

/** 宫格预览结果：图片（base64 data） / HTML（iframe 渲染） / 文本（前 32KB） / 不支持（回退图标） */
export type AppFilePreview =
  | { kind: "image"; mime: string; data: string }
  | { kind: "html"; text: string }
  | { kind: "text"; text: string }
  | { kind: "unsupported" };

/** 取 task-workspace 内 rel（根内相对路径）文件的预览内容（图片 base64 / 文本片段） */
export function previewAppFile(rel: string): Promise<AppFilePreview> {
  return invoke<AppFilePreview>("app_file_preview", { rel });
}

/** 删除 task-workspace 内 rel 条目（目录递归；调用方须先经 AlertDialog 确认） */
export function deleteAppFile(rel: string): Promise<void> {
  return invoke<{ ok: boolean }>("app_file_delete", { rel }).then(() => undefined);
}

/** 在系统文件管理器中打开/显示：目录打开该目录，文件选中显示 */
export function revealAppFile(rel: string): Promise<void> {
  return invoke<{ ok: boolean }>("app_file_reveal", { rel }).then(() => undefined);
}
