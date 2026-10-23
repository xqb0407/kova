/**
 * 子智能体并发设置（设置 → 智能体 → 智能体配置）。
 *
 * 事实源在 SQLite kv（key pi.subagentMaxConcurrency）；工具执行时实时读内存
 * 配置，不重建工具表。默认 8，范围 [1, 16] 由 pi-protocol 的值域常量统一
 * 约束，桌面端和 sidecar 用同一份边界。
 */
import {
  kvGet,
  kvSet,
} from "../storage/hostdb";
import { logErr } from "../log";
import {
  SUBAGENT_MAX_CONCURRENCY_DEFAULT,
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
} from "pi-protocol";

export const SUBAGENT_SETTINGS_KV_KEY = "pi.subagentMaxConcurrency";

let current = SUBAGENT_MAX_CONCURRENCY_DEFAULT;
let stateLoad: Promise<void> | undefined;

/** 任意来源（kv JSON / 协议消息）的宽松规整；非法值回落默认 */
export function normalizeSubagentMaxConcurrency(raw: unknown): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : Number.NaN;
  const value = Number.isFinite(n) ? Math.round(n) : SUBAGENT_MAX_CONCURRENCY_DEFAULT;
  return Math.min(
    Math.max(value, SUBAGENT_MAX_CONCURRENCY_MIN),
    SUBAGENT_MAX_CONCURRENCY_MAX,
  );
}

/** 启动装配调一次（index.ts 闸门内）；幂等（同 hooks 的 stateLoad 模式） */
export function initSubagentSettings(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(SUBAGENT_SETTINGS_KV_KEY);
      if (!row?.value) return;
      current = normalizeSubagentMaxConcurrency(JSON.parse(row.value));
    } catch (err) {
      logErr(
        "subagent-settings: load failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
  return stateLoad;
}

export function getSubagentMaxConcurrency(): number {
  return current;
}

/** 全量覆盖：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function setSubagentMaxConcurrency(raw: unknown): Promise<number> {
  current = normalizeSubagentMaxConcurrency(raw);
  try {
    await kvSet(SUBAGENT_SETTINGS_KV_KEY, JSON.stringify(current));
  } catch (err) {
    logErr(
      "subagent-settings: save failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return current;
}

/** 测试辅助：清内存与装载缓存，不删 kv */
export function resetSubagentSettingsForTest(): void {
  current = SUBAGENT_MAX_CONCURRENCY_DEFAULT;
  stateLoad = undefined;
}
