/**
 * 装配层入口：内置能力注册、启动初始化、设置应用与诊断快照。
 */
import { logErr } from "../../log";
import { loopGuardCapability } from "./capabilities/loop-guard";
import { toolBudgetCapability } from "./capabilities/tool-budget";
import { CapabilityRegistry } from "./registry";
import {
  getCapabilitySettings,
  initCapabilitySettings,
  resetCapabilitySettingsForTest,
  type CapabilitySettings,
} from "./settings";

let registry = new CapabilityRegistry();

export function getCapabilityRegistry(): CapabilityRegistry {
  return registry;
}

function applySettings(target: CapabilityRegistry, settings: CapabilitySettings): void {
  // 设置是全量覆盖：先清掉旧的全局开关，再由新值决定。少了这一步，
  // 新设置里被删除的 key 会沿用上一次的 enabled，表现为"关不掉"。
  target.clearSettingsEnablement();
  for (const [capabilityId, enabled] of Object.entries(settings.enabled)) {
    try {
      target.setEnabled(capabilityId, enabled);
    } catch {
      // 设置里可能残留已下线能力的 id：忽略，不影响其它能力。
    }
  }
}

/**
 * 启动初始化：读配置 → 注册内置能力 → 安装 → 应用开关。
 * 失败只记日志并保留 failed 注册表（装配退化为"无能力"），不阻断 sidecar 启动。
 */
export async function initCapabilities(): Promise<void> {
  const settings = await initCapabilitySettings();
  const next = new CapabilityRegistry();
  next.register(toolBudgetCapability());
  next.register(loopGuardCapability());
  try {
    await next.installAll(settings.params);
    applySettings(next, settings);
  } catch (error) {
    logErr("capabilities: initialization failed:", error);
  }
  registry = next;
}

/** 设置变更后应用到当前注册表（未知 id 忽略）。 */
export function applyCapabilityEnablement(settings: CapabilitySettings): void {
  applySettings(registry, settings);
}

export type CapabilitiesPayload = {
  readonly lifecycle: string;
  readonly settings: CapabilitySettings;
  readonly items: ReturnType<CapabilityRegistry["list"]>;
  readonly failures: ReturnType<CapabilityRegistry["failedCapabilities"]>;
};

export function getCapabilitiesPayload(sessionId?: string): CapabilitiesPayload {
  return {
    lifecycle: registry.lifecycleState(),
    settings: getCapabilitySettings(),
    items: registry.list(sessionId),
    failures: registry.failedCapabilities(),
  };
}

/** 测试辅助：丢弃注册表与内存设置。 */
export function resetCapabilitiesForTest(): void {
  registry = new CapabilityRegistry();
  resetCapabilitySettingsForTest();
}

export { CapabilityRegistry } from "./registry";
export * from "./contracts";
export {
  assembleSessionOrFallback,
  emptyTurnPlan,
  reminderMessages,
  renderReminders,
  runToolAfterHooks,
  runToolBeforeHooks,
  runTurnEndHooks,
} from "./assemble";
export {
  applyCapabilitySettings,
  getCapabilitySettings,
  normalizeCapabilitySettings,
  readCapabilityParams,
  setCapabilitySettingsForTest,
} from "./settings";
