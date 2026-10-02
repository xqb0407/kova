"use client";

import { piRequest, type PiResponse } from "./pi-bridge";

/** optimize_prompt 的两种终态应答（error 帧由 piRequest 抛 Error） */
type OptimizeResponse = Extract<
  PiResponse,
  { type: "prompt_optimized" | "prompt_optimize_cancelled" }
>;

/**
 * 提示词优化 RPC 封装（composer「优化提示词」按钮）：
 * sidecar `optimize_prompt` 派活即返回、结果晚点用同一 reqId 发回
 * （见 apps/sidecar/pi-agent/src/protocol/handlers/optimize.ts——LLM 调用不占
 * mgmt 串行队列），Rust 侧配对不设超时，所以这里只需把 timeoutMs 放宽到
 * 一次慢模型往返的上限；超时后 sidecar 不会重发，任务继续跑完并静默作废。
 *
 * 芯片（技能/子智能体）保护全在 sidecar：掩码 → one-shot → 表驱动还原，
 * 前端只见最终文本，不掺和转义。
 */

/** 等待优化结果的上限：慢端点整段改写也可能要一分多钟 */
const OPTIMIZE_TIMEOUT_MS = 120_000;

/** 优化成功载荷 */
export type PromptOptimizeResult = {
  /** 优化后文本（芯片已还原为原始序列化形式） */
  text: string;
  /** 草稿里被保护的芯片数 */
  chipCount: number;
  /** 实际使用的模型（provider/modelId，供 toast 展示） */
  model: string;
};

/**
 * 发起一次草稿优化。成功返回结果；被取消（覆盖式新优化/手动取消）返回
 * "cancelled"；模型报错等经 sidecar error 帧抛 Error（消息即失败原因文案）。
 */
export async function optimizePrompt(params: {
  threadId: string;
  sessionId?: string;
  /** 前端生成的任务 id：同一时刻一个输入框只有一个在飞任务 */
  jobId: string;
  text: string;
}): Promise<PromptOptimizeResult | "cancelled"> {
  const res = await piRequest<OptimizeResponse>(
    {
      type: "optimize_prompt",
      threadId: params.threadId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      jobId: params.jobId,
      text: params.text,
    },
    OPTIMIZE_TIMEOUT_MS,
  );
  if (res.type === "prompt_optimize_cancelled") return "cancelled";
  return { text: res.text, chipCount: res.chipCount, model: res.model };
}

/** 取消在飞优化（fire-and-forget 语义：失败不抛——任务多半已自然收尾） */
export async function cancelOptimize(jobId: string): Promise<void> {
  try {
    await piRequest({ type: "optimize_cancel", jobId }, 5_000);
  } catch {
    // 取消命令失败无所谓：调用方已按本地状态解锁
  }
}
