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

/** 取消在飞优化的等待上限：取消本身是本地 abort，给短的就够（协议表未登记该命令，
 *  通道按默认侧车预算 5s 兜底，不会被抬） */
const OPTIMIZE_CANCEL_TIMEOUT_MS = 5_000;

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
 *
 * sessionId 必须是**真会话 id**（`piSessionIdForThread` 转换后的值）：sidecar 用它
 * 读会话模型真值。model 是界面当前显示的模型，只在 sidecar 解析不到会话模型时
 * 采用（草稿期选择只在前端内存，这是它唯一的过河通道）。
 */
export async function optimizePrompt(params: {
  threadId: string;
  sessionId?: string;
  /** 界面当前显示的模型（会话解析不到时 sidecar 的兜底档，采用前会校验凭据） */
  model?: { provider: string; modelId: string };
  /** 前端生成的任务 id：同一时刻一个输入框只有一个在飞任务 */
  jobId: string;
  text: string;
}): Promise<PromptOptimizeResult | "cancelled"> {
  // 超时不传：预算由协议表给（pi-protocol/timeouts 的 optimize_prompt =
  // 一次 provider 请求的 120s 级），通道会自动抬到表值，别在这里写死
  const res = await piRequest<OptimizeResponse>(
    {
      type: "optimize_prompt",
      threadId: params.threadId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.model ? { model: params.model } : {}),
      jobId: params.jobId,
      text: params.text,
    },
  );
  if (res.type === "prompt_optimize_cancelled") return "cancelled";
  return { text: res.text, chipCount: res.chipCount, model: res.model };
}

/** 取消在飞优化（fire-and-forget 语义：失败不抛——任务多半已自然收尾） */
export async function cancelOptimize(jobId: string): Promise<void> {
  try {
    await piRequest({ type: "optimize_cancel", jobId }, OPTIMIZE_CANCEL_TIMEOUT_MS);
  } catch {
    // 取消命令失败无所谓：调用方已按本地状态解锁
  }
}
