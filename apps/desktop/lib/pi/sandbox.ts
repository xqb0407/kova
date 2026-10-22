"use client";

import { useSyncExternalStore } from "react";
import { piRequest, type PiSandboxConfig } from "@/lib/pi/pi-bridge";

/**
 * 沙箱配置镜像：事实源在 sidecar kv（pi.sandbox，见 permissions/sandbox-config.ts）。
 * 与 auto-review 同款：client bundle 加载即 get_sandbox 水合，保存走 set_sandbox。
 */

export type SandboxSettings = PiSandboxConfig;

export const SANDBOX_DEFAULT: SandboxSettings = {
  // 与 sidecar 缺省一致：发布默认关闭，用户在设置页显式开启。
  tier: "off",
  network: "allow",
  allowPackageCaches: true,
  onUnavailable: "deny",
};

let current: SandboxSettings = SANDBOX_DEFAULT;
const listeners = new Set<() => void>();
let initialized = false;

// getServerSnapshot 必须返回稳定引用，避免 React 判定快照每次都在变。
const SERVER_SNAPSHOT: SandboxSettings = SANDBOX_DEFAULT;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSandboxSettings(): SandboxSettings {
  return current;
}

export function useSandboxSettings(): SandboxSettings {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => SERVER_SNAPSHOT,
  );
}

/** 从 sidecar 水合镜像（client bundle 加载即调；sidecar 不可用则保持缺省） */
export async function initSandboxSettings(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{ type: "sandbox"; settings: SandboxSettings }>({
      type: "get_sandbox",
    });
    current = res.settings ?? SANDBOX_DEFAULT;
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持缺省，保存时仍会尝试
  }
}

/** 全量覆盖：乐观更新 + 失败回滚（与 hooks/auto-review 同款） */
export async function saveSandboxSettings(next: SandboxSettings): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    const res = await piRequest<{ type: "sandbox"; settings: SandboxSettings }>({
      type: "set_sandbox",
      settings: next,
    });
    current = res.settings ?? SANDBOX_DEFAULT;
    emit();
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

/** 测试钩子：重置镜像与初始化标记，允许在 mock 下重新水合。 */
export function resetSandboxSettingsForTest(): void {
  current = SANDBOX_DEFAULT;
  initialized = false;
}

// client bundle 加载即水合（SSR 端不请求）
void initSandboxSettings();
