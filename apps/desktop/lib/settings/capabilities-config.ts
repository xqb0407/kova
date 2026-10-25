"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type {
  PiCapabilityFailure,
  PiCapabilityItem,
  PiCapabilityReloadFailure,
  PiCapabilitySettings,
} from "@/lib/pi/pi-bridge";

/**
 * 能力装配层开关（设置 → 智能体 → 智能体配置 → 上下文预算）的配置镜像。
 * 事实源在 sidecar——SQLite kv pi.capabilities 整包持久化，能力钩子实时读。
 *
 * 关键约束：set_capabilities 是**全量覆盖**。写入必须从本镜像持有的整包
 * settings 出发只合并改动的 key——否则一次开关就会清掉其它能力的开关和
 * 用户配过的参数（tool-budget 阈值、loop-guard 阈值等）。
 *
 * loop-guard 的 UI 语义是「开即 steer」：shadow 档只写日志，作为用户开关
 * 不可感知；开启时联动写 params.mode = "steer"（合并保留其余参数）。
 */

export type CapabilitiesSnapshot = {
  /** 生效态（含 defaultEnabled 解析；UI 显示读这份而不是 settings.enabled） */
  readonly enabled: Record<string, boolean>;
  /** sidecar 侧的完整设置（写入的合并基底） */
  readonly settings: PiCapabilitySettings;
};

export const TOOL_BUDGET_ID = "tool-budget";
export const LOOP_GUARD_ID = "loop-guard";

const DEFAULT_SNAPSHOT: CapabilitiesSnapshot = {
  enabled: {},
  settings: { enabled: {}, params: {} },
};

/** 保存结果：reloadFailures 非空表示个别会话保留旧工具表、下次 resolve 自愈 */
export type CapabilitiesSaveResult = {
  reloadFailures: readonly PiCapabilityReloadFailure[];
};

let current: CapabilitiesSnapshot = DEFAULT_SNAPSHOT;
const listeners = new Set<() => void>();
/** 已成功拿到 sidecar 真值；false 时写入必须先补一次 GET（否则全量覆盖会拿空包清库） */
let hydrated = false;
/** 水合/补取单飞：并发 GET 的旧响应晚到会把新状态覆盖回去 */
let refreshPromise: Promise<boolean> | undefined;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCapabilitiesSnapshot(): CapabilitiesSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_SNAPSHOT,
  );
}

type CapabilitiesResponse = {
  type: "capabilities";
  lifecycle: string;
  settings: PiCapabilitySettings;
  items: PiCapabilityItem[];
  failures: PiCapabilityFailure[];
  reloadFailures?: PiCapabilityReloadFailure[];
};

/** 应答帧 → 镜像快照（items 是解析默认值后的生效态） */
function fromResponse(res: CapabilitiesResponse): CapabilitiesSnapshot {
  const enabled: Record<string, boolean> = {};
  for (const item of res.items ?? []) enabled[item.id] = item.enabled;
  return { enabled, settings: res.settings };
}

/** 单飞刷新：成功返回 true 并更新镜像；失败保持原状，调用方决定是否拒绝写入。 */
function refreshCapabilities(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const res = await piRequest<CapabilitiesResponse>({
        type: "get_capabilities",
      });
      current = fromResponse(res);
      hydrated = true;
      emit();
      return true;
    } catch {
      // sidecar 不可用（启动早期/连接断开）：保持默认，下次 mount/save 重试
      return false;
    } finally {
      refreshPromise = undefined;
    }
  })();
  return refreshPromise;
}

/**
 * 从 sidecar 水合镜像。模块加载调一次；失败不 latch，设置页挂载时会重试——
 * 全量覆盖的写入依赖这份快照，长期停留在默认值会让"关一下"变成"清空配置"。
 */
export function initCapabilitiesConfig(): Promise<void> {
  if (hydrated) return Promise.resolve();
  return refreshCapabilities().then(() => undefined);
}

/**
 * 保存能力开关：乐观更新本地镜像；sidecar 落库并重建驻留会话后用应答帧
 * 回填（避免二次漂移），失败时回滚并抛出（设置页据此提示）。
 *
 * 未水合时先补一次真值再合并：set_capabilities 是全量覆盖，拿空镜像写入
 * 会清掉工具阈值等既有配置——取不到真值时必须拒绝写入，而不是"尽力而为"。
 */
async function saveCapabilityToggle(
  capabilityId: string,
  enabled: boolean,
  paramsPatch?: Record<string, unknown>,
): Promise<CapabilitiesSaveResult> {
  if (!hydrated) {
    const ok = await refreshCapabilities();
    if (!ok) throw new Error("capabilities unavailable");
  }

  const previous = current;
  // 全量合并：只动本能力的 enabled key 与 params key，其余原样保留
  const nextSettings: PiCapabilitySettings = {
    enabled: { ...previous.settings.enabled, [capabilityId]: enabled },
    params: paramsPatch
      ? {
          ...previous.settings.params,
          [capabilityId]: {
            ...(previous.settings.params[capabilityId] ?? {}),
            ...paramsPatch,
          },
        }
      : previous.settings.params,
  };
  current = { enabled: { ...previous.enabled, [capabilityId]: enabled }, settings: nextSettings };
  emit();
  try {
    const res = await piRequest<CapabilitiesResponse>({
      type: "set_capabilities",
      settings: nextSettings,
    });
    current = fromResponse(res);
    hydrated = true;
    emit();
    return { reloadFailures: res.reloadFailures ?? [] };
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

export function setToolBudgetEnabled(enabled: boolean): Promise<CapabilitiesSaveResult> {
  return saveCapabilityToggle(TOOL_BUDGET_ID, enabled);
}

/** loop-guard 开即 steer（shadow 只写日志，对用户不可感知）；关只动开关、保留参数 */
export function setLoopGuardEnabled(enabled: boolean): Promise<CapabilitiesSaveResult> {
  return saveCapabilityToggle(LOOP_GUARD_ID, enabled, enabled ? { mode: "steer" } : undefined);
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initCapabilitiesConfig();
