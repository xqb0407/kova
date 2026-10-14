/**
 * 资源管理器的 桌面桥调用封装。
 *
 * 同一份静态产物也会被远程网关当网页 serve，那里没有 桌面桥 IPC——所以每个函数
 * 在非桌面环境返回 null / 空结果，页面据此显示"仅桌面端可用"的空状态，而不是
 * 抛出一串 `invoke is not a function`。
 */

import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";
import type { CleanResult, Sample, Storage } from "./types";

/** 进程与系统资源快照（调用方每 2s 拉一次；Rust 侧靠差值算 CPU） */
export async function fetchSample(): Promise<Sample | null> {
  if (!isDesktop()) return null;
  return invoke<Sample>("resource_sample");
}

/** 数据目录占用扫描（阻塞线程扫描 + 预算上限，调用方负责 loading 态） */
export async function fetchStorage(): Promise<Storage | null> {
  if (!isDesktop()) return null;
  return invoke<Storage>("resource_storage_scan");
}

/** 清理白名单类目：logs / browser-cache / model-cache */
export async function cleanStorage(ids: string[]): Promise<CleanResult | null> {
  if (!isDesktop()) return null;
  return invoke<CleanResult>("resource_storage_clean", { ids });
}

/** 在文件管理器中打开某个类目的路径（Rust 侧只放行本应用自己的数据根） */
export async function revealPath(path: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("resource_reveal", { path });
}

/** 打开（或唤回）资源管理器窗口。已存在时只聚焦，不会开出第二个 */
export async function openResourceManager(): Promise<void> {
  if (!isDesktop()) return;
  await invoke("resource_open_window");
}

/** 是否具备真实数据源（网页端为 false，页面显示空状态） */
export function hasResourceSource(): boolean {
  return isDesktop();
}
