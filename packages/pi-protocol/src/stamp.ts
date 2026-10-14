/**
 * 事件水印（设计文档 §3）与派生相位帧（§2）。
 *
 * 水印不变式（两端共守）：
 * - sidecar 每会话一个单调计数器 eventSeq，只给"状态同步帧"盖章：
 *   session_state / context_changed 通知、data-queue-state /
 *   data-planningState / data-toolApproval / data-question 带内 chunk。
 *   盖章发生在确认写出的时刻（无活跃请求的静默丢弃不占号）。
 * - 盖章帧的线形固定：eventSeq 与 sessionId 在帧顶层（chunk 行是
 *   {id, chunk, sessionId, eventSeq}，通知行是 {type, sessionId, eventSeq, ...}）。
 * - desktop 按 sessionId 检查连续性：跳号 → 回拉权威接口（检漂移不重放）；
 *   回退号 = 陈旧代际（重放缓冲/换代），静默忽略。换代清零走显式 reset
 *   （Tauri pi-exit / WS authed），不经帧推断。
 */
import { z } from "zod";

/** 派生会话相位（§2）：sidecar 广播 running/idle/evicted；
 *  draft/prewarming 由前端按本地知识派生，awaiting 随 M2 挂起交互上线。 */
export const sessionPhaseSchema = z.enum([
  "draft",
  "prewarming",
  "running",
  "awaiting",
  "idle",
  "evicted",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

/** session_state 自发通知帧：取代散落的 turn_changed（旧帧保留一个版本周期） */
export const sessionStateFrameSchema = z.looseObject({
  type: z.literal("session_state"),
  sessionId: z.string(),
  phase: sessionPhaseSchema,
  eventSeq: z.number().int().nonnegative().optional(),
});
export type SessionStateFrame = z.infer<typeof sessionStateFrameSchema>;

/** 缺口回拉类别（§3 回拉表）：与桌面权威接口一一对应 */
export type SeqRepairKind =
  | "queue"
  | "planning"
  | "running"
  | "pending"
  | "context";

/** 带内 chunk 型 -> 回拉类别；非水印帧型返回 null */
function kindForChunkType(type: unknown): SeqRepairKind | null {
  if (type === "data-queue-state") return "queue";
  if (type === "data-planningState") return "planning";
  // 挂起交互发起帧（§4）：漏收 → 回拉 list_pending 补挂起卡
  if (type === "data-toolApproval" || type === "data-question") return "pending";
  return null;
}

/**
 * 从任意已解析的 NDJSON 行提取水印观察值（桌面收帧统一入口，纯函数）：
 * - {type:"session_state", sessionId, eventSeq} → "running"（种子拉 list_running）
 * - {type:"context_changed", ...} → "context"（回拉 context_info 重算镜像）
 * - {id, chunk:{type:"data-queue-state"|"data-planningState"}, sessionId, eventSeq}
 *   → "queue" / "planning"
 * 未盖章 / 不具修复语义的行返回 null（热路径先做字符串粗筛再进此函数）。
 */
export function readSeqStamp(frame: unknown): {
  sessionId: string;
  eventSeq: number;
  kind: SeqRepairKind;
} | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (typeof f.eventSeq !== "number" || !Number.isInteger(f.eventSeq) || f.eventSeq < 0) {
    return null;
  }
  if (typeof f.sessionId !== "string") return null;
  const base = { sessionId: f.sessionId, eventSeq: f.eventSeq };
  if (f.type === "session_state") return { ...base, kind: "running" as const };
  if (f.type === "context_changed") return { ...base, kind: "context" as const };
  const chunk = f.chunk;
  if (chunk && typeof chunk === "object") {
    const kind = kindForChunkType((chunk as Record<string, unknown>).type);
    if (kind) return { ...base, kind };
  }
  return null;
}
