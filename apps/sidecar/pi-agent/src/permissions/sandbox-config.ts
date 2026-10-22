/**
 * 沙箱配置（kv pi.sandbox）：档位、网络、包缓存、后端不可用时的回退。
 *
 * 与 auto-review 同一套生命周期：启动闸门内 init 一次，设置页 set 时同步内存
 * 并落库；工具路径每次实时读内存，避免每轮都查 SQLite。
 */
import {
  DEFAULT_SANDBOX_CONFIG,
  normalizeSandboxConfig,
  type SandboxConfig,
} from "pi-sandbox";
import { logErr } from "../log";
import { kvGet, kvSet } from "../storage/hostdb";

const CONFIG_KV_KEY = "pi.sandbox";

let config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG };
let version = 0;
let stateLoad: Promise<void> | undefined;

/** 启动装配调一次（index.ts 闸门内）；幂等。 */
export function initSandboxConfig(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(CONFIG_KV_KEY);
      if (!row?.value) return;
      config = normalizeSandboxConfig(JSON.parse(row.value));
      version += 1;
    } catch (err) {
      logErr("sandbox config:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

/** 全量覆盖（桌面端 set_sandbox 推送）；同步内存并落库。 */
export async function setSandboxConfig(raw: unknown): Promise<void> {
  config = normalizeSandboxConfig(raw);
  version += 1;
  try {
    await kvSet(CONFIG_KV_KEY, JSON.stringify(config));
  } catch (err) {
    logErr("sandbox config save:", err instanceof Error ? err.message : String(err));
  }
}

export function getSandboxConfig(): SandboxConfig {
  return { ...config };
}

/** 配置版本：plan 缓存用，set 后让下一次工具调用立即看到新档位。 */
export function sandboxConfigVersion(): number {
  return version;
}

/** 测试钩子：清空配置与 kv 装载缓存。 */
export function resetSandboxConfigForTest(): void {
  config = { ...DEFAULT_SANDBOX_CONFIG };
  version += 1;
  stateLoad = undefined;
}
