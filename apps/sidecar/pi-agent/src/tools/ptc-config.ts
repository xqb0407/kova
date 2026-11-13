/**
 * PTC（Programmatic Tool Calling）设置。
 *
 * 开关在会话物化时快照（见 sessions/resolve.ts 的 run.ptcEnabled）：已存在的
 * 会话不会因为设置页翻转而中途换工具表，避免打断前缀缓存；新会话才生效。
 */
import { logErr } from "../log";
import { kvGet, kvSet } from "../storage/hostdb";

export const PTC_KV_KEY = "pi.ptc";

export type PtcConfig = {
  enabled: boolean;
};

export const DEFAULT_PTC_CONFIG: Readonly<PtcConfig> = Object.freeze({
  // 发布默认关闭：Beta 能力，用户显式开启后才在新会话里出现 run_code。
  enabled: false,
});

/** 宽松归一化：设置来自 UI/旧版本 kv，坏字段回落到默认，不能把整份配置读崩。 */
export function normalizePtcConfig(raw: unknown): PtcConfig {
  const value =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : DEFAULT_PTC_CONFIG.enabled,
  };
}

let current: PtcConfig = { ...DEFAULT_PTC_CONFIG };

export function getPtcConfig(): PtcConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动）。 */
export async function initPtc(): Promise<void> {
  try {
    const row = await kvGet(PTC_KV_KEY);
    if (row?.value) current = normalizePtcConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("ptc: load failed:", err);
  }
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落）。 */
export async function applyPtcConfig(raw: unknown): Promise<PtcConfig> {
  const next = normalizePtcConfig(raw);
  current = next;
  try {
    await kvSet(PTC_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("ptc: persist failed:", err);
  }
  return next;
}

/** 测试辅助：仅清内存不落 kv。 */
export function resetPtcConfigForTest(): void {
  current = { ...DEFAULT_PTC_CONFIG };
}
