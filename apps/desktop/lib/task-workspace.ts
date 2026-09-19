"use client";

import { appDataDir } from "@tauri-apps/api/path";
import { isTauri } from "@/lib/tauri";

/**
 * 无目录任务会话的执行目录（agent 产物落盘点）：app_data_dir/task-workspace。
 * 与 Rust 注入 sidecar 的 PI_TASK_CWD（pi_agent.rs ensure_spawned）及
 * 「我的文件」命令的根目录（fs.rs app_file_*）完全同源——前端据此把
 * 全局任务里 write 的相对路径拼成 file:// 预览 URL，无需新增 Rust 命令。
 * 模块级缓存：一次解析终身复用；非 Tauri（web 端）恒 null。
 */
let cached: Promise<string | null> | null = null;

export function taskWorkspaceDir(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  cached ??= appDataDir()
    .then((dir) => `${dir.replace(/[\\/]+$/, "")}/task-workspace`)
    .catch(() => null);
  return cached;
}
