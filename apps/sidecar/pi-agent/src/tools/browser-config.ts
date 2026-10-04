/**
 * 浏览器相关能力开关（设置 → 电脑控制）：
 * enabled 管 browser_* 驱动工具（navigate/snapshot/click/type/resize/scroll/back），
 * pixelShot 管 browser_shot（无头 Chrome 拍页面像素），
 * screenShot 管 screenshot（读用户真实屏幕）。
 * 配置整包存 SQLite kv（key = KV_KEY），前端经协议 get/set_browser 访问。
 * 工具在 tools.ts buildTools 常驻注册（工具表变更会破坏 Anthropic tools 块缓存，
 * 故不按开关增删），execute 时实时读配置门控（与 memory 同款机制）——
 * 关闭时工具婉拒并给模型替代路径，运行中的会话下一次调用即生效。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export const BROWSER_KV_KEY = "pi.browser";

/** 浏览器设置整包（kv 与协议共用同一形状） */
export type BrowserConfig = {
  /** 浏览器驱动总开关：关闭时 browser_* 工具一律婉拒（面板浏览器仍可用） */
  enabled: boolean;
  /** 像素截图：browser_shot 用一次性无头 Chrome 拍页面画面。默认关。
   *  关掉时 navigate/snapshot/click 全都照常，只是 canvas/WebGL 拍不到。 */
  pixelShot: boolean;
  /** 屏幕截图：screenshot 工具读用户真实屏幕。默认关——
   *  这是唯一会"看见你的桌面"的能力，与"应用自己操作自己"这条要求相悖，
   *  所以必须由用户显式开。 */
  screenShot: boolean;
};

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  pixelShot: false,
  screenShot: false,
};

/** 任意来源（kv JSON / 协议消息）的宽松规整：布尔取真值 */
export function normalizeBrowserConfig(raw: unknown): BrowserConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_BROWSER_CONFIG.enabled,
    pixelShot:
      typeof r.pixelShot === "boolean" ? r.pixelShot : DEFAULT_BROWSER_CONFIG.pixelShot,
    screenShot:
      typeof r.screenShot === "boolean" ? r.screenShot : DEFAULT_BROWSER_CONFIG.screenShot,
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

/** 测试辅助：只改内存不落 kv。
 *  applyBrowserConfig 会经 kvSet 走一次 host RPC，在 fake transport 下会等到
 *  超时——测门控分支要的是"配置处于某个状态"，不是"配置能落库"。 */
export function setBrowserConfigForTest(cfg: Partial<BrowserConfig>): void {
  current = normalizeBrowserConfig({ ...current, ...cfg });
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
