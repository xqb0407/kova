"use client";

import { invoke } from "@tauri-apps/api/core";

/**
 * 全局数据目录文件清单（插件市场 → 管理 → 我的文件 → 本地）。
 * 事实源在 Rust：fs::app_file_list 只读列 ~/.xulux（sidecar 全局层，
 * skills / mcp.json / soul.md 等都住这里），不接收路径参数。
 */

/** ~/.xulux 顶层条目；size 仅文件有效，目录恒 0（UI 显示 "—"） */
export interface AppFileEntry {
  name: string;
  dir: boolean;
  size: number;
  /** ISO 8601（本地时区）；不可得为 null */
  modified: string | null;
}

/** 列 AI 产物目录（task-workspace）顶层条目 */
export function listAppFiles(): Promise<AppFileEntry[]> {
  return invoke<{ entries: AppFileEntry[] }>("app_file_list").then((r) => r.entries);
}

/** 宫格预览结果：图片（base64 data） / HTML（iframe 渲染） / 文本（前 32KB） / 不支持（回退图标） */
export type AppFilePreview =
  | { kind: "image"; mime: string; data: string }
  | { kind: "html"; text: string }
  | { kind: "text"; text: string }
  | { kind: "unsupported" };

/** 取 task-workspace 顶层文件的预览内容（图片 base64 / 文本片段） */
export function previewAppFile(name: string): Promise<AppFilePreview> {
  return invoke<AppFilePreview>("app_file_preview", { name });
}

/** 删除 task-workspace 顶层条目（目录递归；调用方须先经 AlertDialog 确认） */
export function deleteAppFile(name: string): Promise<void> {
  return invoke<{ ok: boolean }>("app_file_delete", { name }).then(() => undefined);
}
