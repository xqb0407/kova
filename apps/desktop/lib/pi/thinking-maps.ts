"use client";

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";
import { piRequest } from "@/lib/pi/pi-bridge";

/**
 * 模型级思考参数映射（pi-ai thinkingLevelMap 语义，composer 档位与下发值的真相源）：
 * 键为 off / minimal / low / medium / high / xhigh / max；
 *   字符串值 = 该档可用且按此值下发（透传档位名即可，如 "medium"；
 *   off 的字符串 = 关闭思考时显式下发的参数值——默认开思考的网关必须靠它关得掉，
 *   常见 "none"（OpenAI 兼容 reasoning_effort））；
 *   null = 显式禁用该档（档位下拉里不再出现）。
 * 持久化在 Tauri kv（pi.model_thinking，与 pi.model 同套路），整包经
 * set_thinking_maps 推给 sidecar 覆盖到模型目录（见 model-catalog.ts）。
 */
export type ModelThinkingMap = Record<string, string | null>;

const KV_KEY = "pi.model_thinking";
const KNOWN_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

let maps: Record<string, ModelThinkingMap> = {};
let initialized = false;

async function syncToSidecar(): Promise<void> {
  try {
    await piRequest({ type: "set_thinking_maps", maps }, 15000);
  } catch {
    // sidecar 暂不可用时保留本地值，下次启动/保存再同步
  }
}

function cleanMap(raw: ModelThinkingMap | null | undefined): ModelThinkingMap | null {
  if (!raw) return null;
  const out: ModelThinkingMap = {};
  for (const key of KNOWN_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
    else if (v === null) out[key] = null;
  }
  return Object.keys(out).length ? out : null;
}

export function getModelThinkingMap(
  provider: string,
  modelId: string,
): ModelThinkingMap | undefined {
  return maps[`${provider}/${modelId}`];
}

/** 合并保存一个模型的映射 patch（patch 里没出现的键保持原值）；空 map = 删除 */
export async function setModelThinkingMap(
  provider: string,
  modelId: string,
  patch: ModelThinkingMap | null,
): Promise<void> {
  const key = `${provider}/${modelId}`;
  const cleaned = cleanMap(patch);
  const merged = cleaned
    ? { ...(maps[key] ?? {}), ...cleaned }
    : null;
  if (merged) maps = { ...maps, [key]: merged };
  else {
    const next = { ...maps };
    delete next[key];
    maps = next;
  }
  await syncToSidecar();
  if (!isTauri()) return;
  void invoke("kv_set", { key: KV_KEY, value: JSON.stringify(maps) }).catch(
    () => {},
  );
}

/** 从 SQLite kv 恢复映射并下发 sidecar；client bundle 加载即执行 */
export async function initThinkingMaps(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;
  try {
    const value = await invoke<string | null>("kv_get", { key: KV_KEY });
    if (!value) return;
    const parsed = JSON.parse(value) as Record<string, ModelThinkingMap>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const next: Record<string, ModelThinkingMap> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      const cleaned = cleanMap(raw);
      if (cleaned) next[key] = cleaned;
    }
    maps = next;
    await syncToSidecar();
  } catch {
    // 数据库不可用时按无映射处理
  }
}

void initThinkingMaps();
