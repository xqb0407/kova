"use client";

import { useSyncExternalStore } from "react";
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 任务产物根的渲染层镜像（设置 → 通用 → 任务产物位置）。
 *
 * 事实源在主进程 kv：缺省 `<appData>/task-workspace`，用户可改到任意文件夹
 * （Windows 上常从 C 盘挪到数据盘）。前端据此把无目录任务的相对路径拼成
 * 绝对路径做预览——与 sidecar 的 PI_TASK_CWD、「我的文件」命令根同源。
 * 改位置后模块级镜像 emit、所有消费方跟随。
 */

export const TASK_WORKSPACE_PROGRESS_EVENT = "task:migrate-progress";

export interface TaskWorkspaceRootInfo {
  root: string;
  defaultRoot: string;
  isDefault: boolean;
  exists: boolean;
}

/** task:migrate-progress 事件负载（与 backup:progress 同款） */
export interface TaskWorkspaceMigrateProgress {
  phase: "renaming" | "copying" | "verify" | "finalizing" | "cleanup";
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message: string;
}

let info: TaskWorkspaceRootInfo | null = null;
let inflight: Promise<TaskWorkspaceRootInfo | null> | null = null;
/** 切根代数：在途刷新若跨过一次切根，其返回值作废（否则会把镜像覆盖回旧路径） */
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTaskWorkspaceRoot(): TaskWorkspaceRootInfo | null {
  return useSyncExternalStore(subscribe, () => info, () => null);
}

/** 同步读取（非 hook 场景）；未就绪 null，调用方自行降级。 */
export function getTaskWorkspaceRootInfo(): TaskWorkspaceRootInfo | null {
  return info;
}

/** 拉取/刷新根信息（并发调用共用同一在途请求） */
export function refreshTaskWorkspaceRoot(): Promise<TaskWorkspaceRootInfo | null> {
  if (!isDesktop()) return Promise.resolve(null);
  const gen = generation;
  inflight ??= invoke<TaskWorkspaceRootInfo>("task_workspace_get_root")
    .then((r) => {
      if (gen !== generation) return info ?? r;
      info = r;
      emit();
      return r;
    })
    .catch(() => info)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 无目录任务会话的执行目录（agent 产物落盘点）：当前任务产物根。
 *  镜像已解析时同步返回；未解析则等首次拉取。 */
export function taskWorkspaceDir(): Promise<string | null> {
  if (!isDesktop()) return Promise.resolve(null);
  if (info) return Promise.resolve(info.root);
  return refreshTaskWorkspaceRoot().then((r) => r?.root ?? null);
}

/**
 * 无目录会话的产物子目录：<task-workspace>/<sessionId>（与 sidecar
 * taskSessionCwd 同源规则）。桌面端把会话的相对产物路径拼回绝对路径全靠它。
 */
export function taskWorkspaceSessionDir(sessionId: string): Promise<string | null> {
  return taskWorkspaceDir().then((base) => (base ? `${base}/${sessionId}` : null));
}

const ERROR_TEXT: Record<string, string> = {
  busy: "有会话或工具正在运行，请等待当前对话完成后再切换",
  overlap: "新位置不能与当前位置互相包含，请选择其它文件夹",
  "bad-path": "路径不合法",
  "home-not-allowed": "不能把家目录本身设为任务产物位置（请选其中的一个文件夹）",
  "app-data-not-allowed": "该目录存放应用私有数据，不能设为任务产物位置",
  "path-too-long": "路径过长，请选择层级更浅的文件夹",
};

/** 切根错误 → 提示文案；已知短码查表，其余（含空间不足等带明细的消息）原样显示 */
export function taskWorkspaceErrorText(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return ERROR_TEXT[raw] ?? raw;
}

/** 切换位置：成功返回 null 并刷新镜像；失败返回可展示文案 */
export async function changeTaskWorkspaceRoot(
  dir: string,
  migrate: boolean,
): Promise<string | null> {
  try {
    const res = await invoke<{ root: string }>("task_workspace_set_root", { root: dir, migrate });
    generation += 1;
    info = {
      root: res.root,
      defaultRoot: info?.defaultRoot ?? res.root,
      isDefault: res.root === (info?.defaultRoot ?? res.root),
      exists: true,
    };
    emit();
    // 等更早的在途刷新落定后再拉一次，避免旧响应覆盖新根
    const pending = inflight;
    void (pending ? pending.catch(() => null) : Promise.resolve()).then(() =>
      refreshTaskWorkspaceRoot(),
    );
    return null;
  } catch (err) {
    return taskWorkspaceErrorText(err);
  }
}

/** 启动时是否有未完成的迁移（上次强退/断电的收尾提示用；无则 false） */
export function taskWorkspaceMigrateState(): Promise<{ migrating: boolean } | null> {
  if (!isDesktop()) return Promise.resolve(null);
  return invoke<{ migrating: boolean }>("task_workspace_migrate_state").catch(() => null);
}

// client bundle 加载即解析一次（SSR 端 isDesktop() 为 false，直接跳过）
if (isDesktop()) void refreshTaskWorkspaceRoot();
