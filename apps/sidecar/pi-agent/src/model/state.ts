/**
 * 模型选择的运行时状态：当前模型键（启动从 kv 恢复，set_model 维护）与
 * 全局思考档位。目录本体见 catalog.ts，自定义 provider 见 custom-providers.ts。
 */
import { kvGet } from "../storage/hostdb";
import { logErr } from "../log";

/** 当前选中的模型（启动时 initCurrentModelKey 从 kv 恢复；运行中由 set_model 维护） */
let currentModelKey: { provider: string; modelId: string } | null = null;

export function getCurrentModelKey(): {
  provider: string;
  modelId: string;
} | null {
  return currentModelKey;
}

export function setCurrentModelKey(key: {
  provider: string;
  modelId: string;
} | null): void {
  currentModelKey = key;
}

/**
 * 启动恢复：从 kv 读「最近一次使用的模型」写入内存键（在目录就绪闸门内调用）。
 * 只写内存键不校验目录/凭据——校验延迟到真正取模型时（resolveCurrentModel 回落），
 * 避免启动早期自定义提供商尚未加载时把有效选择误判为失效。
 * 之前恢复由前端经 set_model 完成，但前端命令可能早于 sidecar 就绪发出而丢失，
 * sidecar 侧自行恢复后该竞态消失（远程网页模式也由此获得恢复）。
 */
export async function initCurrentModelKey(): Promise<void> {
  try {
    const raw = await kvGet("pi.model");
    if (!raw?.value) return;
    const saved = JSON.parse(raw.value) as { provider?: string; modelId?: string };
    if (saved?.provider && saved?.modelId) {
      currentModelKey = { provider: saved.provider, modelId: saved.modelId };
    }
  } catch (err) {
    logErr("model key restore failed:", err);
  }
}

/**
 * 深度思考阶梯（pi-agent-core 的 7 档，xhigh/max 仅部分模型支持，
 * 由 provider adapter 按 model.thinkingLevelMap 落值）。全局一档、
 * 与选模型同款语义：set_thinking 广播到活动 Agent，新会话建 Agent 时取用。
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 当前思考档位（重启后由前端通过 set_thinking 恢复；深度思考开关置 medium/off） */
let currentThinkingLevel: ThinkingLevel = "off";

export function getCurrentThinkingLevel(): ThinkingLevel {
  return currentThinkingLevel;
}

export function setCurrentThinkingLevel(level: ThinkingLevel): void {
  currentThinkingLevel = level;
}
