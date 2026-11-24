"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiHookConfig } from "@/lib/pi/pi-bridge";
import { getPiChannel } from "@/lib/pi/pi-channel";

/**
 * 生命周期钩子（设置 → 钩子）：Claude Code 式外部命令钩子的配置镜像。
 * 事实源在 sidecar——SQLite kv（键 pi.hooks）整包持久化，PreToolUse /
 * PermissionRequest 在工具调用/审批路径同步生效；这里只做镜像缓存：
 * 启动 get_hooks 水合，保存走 set_hooks（与 memory 同款链路）。
 */

export type HookConfig = PiHookConfig;

let current: HookConfig[] = [];
/** 水合前的稳定空表：getServerSnapshot 每次返回同一个引用（React 的快照约定） */
const EMPTY_HOOKS: HookConfig[] = [];
const listeners = new Set<() => void>();
/** 是否已成功从 sidecar 拉过配置。失败不置位：设置页挂载/保存前会重试，
 *  避免把空镜像当成事实源全量写回（那会清掉 sidecar 里已有钩子）。 */
let hydrated = false;
let hydrating: Promise<void> | undefined;
/** 镜像版本：hooks_changed 推送/本地保存会推进；水合响应只在版本未变时落地，
 *  避免「先拿到 get_hooks 的旧快照、后收到他端推送」把新配置覆盖回旧值。 */
let revision = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHookConfigs(): HookConfig[] {
  return current;
}

export function useHookConfigs(): HookConfig[] {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY_HOOKS,
  );
}

/** 从 sidecar 水合镜像（client bundle 加载即调；设置页挂载时再调一次可重试）。
 *  并发调用共享同一个请求；失败保持未水合状态，下次调用重新尝试。 */
export function initHookConfigs(): Promise<void> {
  if (hydrated) return Promise.resolve();
  hydrating ??= (async () => {
    const startedRevision = revision;
    try {
      const res = await piRequest<{ type: "hooks"; hooks: HookConfig[] }>({
        type: "get_hooks",
      });
      // 请求期间收到他端 hooks_changed（或完成本地保存）→ 快照已过期，丢弃
      if (revision !== startedRevision) return;
      current = res.hooks ?? [];
      hydrated = true;
      emit();
    } catch {
      // sidecar 不可用（启动早期/连接断开）：保持空表，下次调用重试
    } finally {
      hydrating = undefined;
    }
  })();
  return hydrating;
}

async function push(update: (list: HookConfig[]) => HookConfig[]): Promise<void> {
  // 未水合就全量 set_hooks = 用空/残缺镜像覆盖 sidecar 的持久化配置。
  // 先补拉一次；仍失败则拒绝保存，让 UI 提示通信中断，而不是静默丢数据。
  if (!hydrated) {
    await initHookConfigs();
    if (!hydrated) throw new Error("hooks not loaded from agent service");
  }
  const previous = current;
  // 在补水合之后才基于权威列表计算 next：否则「水合前算好的空表 + 新增项」
  // 仍会把已有配置覆盖掉。
  const next = update(current);
  const requestRevision = revision + 1;
  revision = requestRevision;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_hooks", hooks: next });
  } catch (err) {
    // 请求期间若已收到他端 hooks_changed，镜像已是更新的真值，不能再回滚覆盖
    if (revision === requestRevision) {
      current = previous;
      emit();
    }
    throw err;
  }
}

/** 新增一条钩子（id 在镜像侧生成，sidecar 兜底补缺） */
export async function addHookConfig(config: Omit<HookConfig, "id">): Promise<void> {
  const id = `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await push((list) => [...list, { ...config, id }]);
}

export async function updateHookConfig(id: string, next: HookConfig): Promise<void> {
  await push((list) => list.map((h) => (h.id === id ? next : h)));
}

export async function removeHookConfig(id: string): Promise<void> {
  await push((list) => list.filter((h) => h.id !== id));
}

/** 测试钩子：重置镜像与水合状态（允许在 mock 下重新水合）。 */
export function resetHooksMirrorForTest(): void {
  current = [];
  hydrated = false;
  hydrating = undefined;
  revision = 0;
}

/** 他端 set_hooks 后 sidecar 广播 hooks_changed：直接替换镜像，避免多窗口
 *  各拿旧列表全量写回互相覆盖。 */
export function applyHooksChanged(next: HookConfig[]): void {
  revision += 1;
  current = next;
  hydrated = true;
  emit();
}

/** 订阅变更推送（通道能力可选：远程 WS 不实现，远程也已被禁止读写 hooks） */
function subscribeHooksChanged(): void {
  try {
    const channel = getPiChannel();
    const subscribe = channel.subscribeHooksChanged;
    if (!subscribe) return;
    const result = subscribe.call(channel, applyHooksChanged);
    // 退订函数可能异步返回；订阅安装失败不应变成未处理 rejection
    if (typeof result !== "function") void result.catch(() => {});
  } catch {
    // 通道未就绪：由 initHookConfigs 水合兜底
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回空表）
void initHookConfigs();
// 变更订阅只在浏览器侧装配（SSR/测试无宿主传输，装了只会打警告）
if (typeof window !== "undefined") subscribeHooksChanged();
