/**
 * 模型选择的运行时状态：当前模型键（启动从 kv 恢复，set_model 维护）与
 * 全局思考档位。目录本体见 catalog.ts，自定义 provider 见 custom-providers.ts。
 */
import { kvGet } from "../storage/hostdb";
import { logErr } from "../log";

/** 默认模型（启动时 initCurrentModelKey 从 kv 恢复；仅由无 sessionId 的 set_model
 *  ——设置页/启动恢复——维护。对话页的定靶选择不写这里：它是会话级真值
 *  （转录行 + sessions 偏好列），全局键漂移会殃及所有无记录会话） */
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
 * 启动恢复：从 kv 读「默认模型」写入内存键（在目录就绪闸门内调用）。
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
 * 由 provider adapter 按 model.thinkingLevelMap 落值）。这里是**默认档位**、
 * 与默认模型同款语义：仅由无 sessionId 的 set_thinking（设置页/启动恢复）维护，
 * 供新会话与从未定靶选档的会话跟随；对话页选择走会话定靶（转录行 + 偏好列）。
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
