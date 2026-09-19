/**
 * 浏览器驱动开关（设置 → 通用 → 智能体工具）：
 * 控制 browser_* 工具（browser_navigate/snapshot/click/type/resize/scroll/back）
 * 是否可用。配置整包存 SQLite kv（key = KV_KEY），前端经协议 get/set_browser 访问。
 * 工具在 tools.ts buildTools 常驻注册（工具表变更会破坏 Anthropic tools 块缓存，
 * 故不按开关增删），execute 时实时读配置门控（与 memory 同款机制）——
 * 关闭时工具婉拒并给模型替代路径，运行中的会话下一次调用即生效。
 */
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

export const BROWSER_KV_KEY = "pi.browser";

/** 浏览器驱动设置整包（kv 与协议共用同一形状） */
export type BrowserConfig = {
  /** 总开关：关闭时 browser_* 工具一律婉拒 */
  enabled: boolean;
};

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
};

/** 任意来源（kv JSON / 协议消息）的宽松规整：布尔取真值 */
export function normalizeBrowserConfig(raw: unknown): BrowserConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_BROWSER_CONFIG.enabled,
  };
}

let current: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG };

export function getBrowserConfig(): BrowserConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initBrowserConfig(): Promise<void> {
  try {
    const row = await kvGet(BROWSER_KV_KEY);
    if (row?.value) current = normalizeBrowserConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("browser-config: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv */
export function resetBrowserConfigForTest(): void {
  current = { ...DEFAULT_BROWSER_CONFIG };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyBrowserConfig(raw: unknown): Promise<BrowserConfig> {
  const next = normalizeBrowserConfig(raw);
  current = next;
  try {
    await kvSet(BROWSER_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("browser-config: persist failed:", err);
  }
  return next;
}
