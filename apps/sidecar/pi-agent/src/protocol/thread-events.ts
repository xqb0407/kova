/**
 * 原生事件通道（react-pi 迁移阶段 3）：把 pi-agent-core 的 AgentEvent 透传为
 * `thread_event` NDJSON 帧（`{type, sessionId, eventSeq, event}`），经 Rust 合帧
 * 批量转发给 webview。与 AI SDK chunk 流并行存在（阶段 5 才退役 chunk 流）。
 *
 * delta 化（计划 §3a）：message_update 的 assistantMessageEvent 不带 `partial`
 * （完整消息副本）——逐 token 携带 O(n) 副本是 O(n²) wire 成本的根源；客户端
 * 在 TauriPiClient 内按 accumulator 重建 partial。仅 start/toolcall_start 需
 * 附加小字段（toolCall 的 id/name 从 partial 抽取），done/error 为每流一帧的
 * 终态，保留完整 message/error。
 *
 * 在飞 partial 台账（计划 §3c）：桥接侧本就经手完整 partial，顺手留档，
 * thread_snapshot 据此把流式中的 assistant 消息并入快照（崩溃恢复=刷新即自愈）。
 *
 * 事件信封的 seq 取 per-session eventSeq 水位（event-seq.ts，与 context_changed/
 * queue_state 等盖章帧共用号段）：单调即可，缺口合法（快照权威兜底，不做缺口检测）。
 */
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { send } from "./stream";
import { nextEventSeq } from "./event-seq";
import type { Running } from "../types";

/** 输出一帧 thread_event（确认写出才占号，与 sendEventChunk 同规） */
export function emitThreadEvent(sessionId: string, event: Record<string, unknown>): void {
  if (!sessionId) return;
  send({
    type: "thread_event",
    sessionId,
    eventSeq: nextEventSeq(sessionId),
    event,
  });
}

// ---------------- 在飞 partial 台账（快照并入用） ----------------

const partials = new Map<string, Record<string, unknown>>();

/** 流式中的 assistant 消息最新副本（无则在飞流不存在/已落定） */
export function peekPartial(sessionId: string): Record<string, unknown> | undefined {
  return partials.get(sessionId);
}

function notePartial(sessionId: string, message: unknown): void {
  if (!sessionId || !message || typeof message !== "object") return;
  try {
    partials.set(sessionId, structuredClone(message) as Record<string, unknown>);
  } catch {
    // structuredClone 失败（非可克隆值）：跳过留档，快照退回"缺流式尾巴"
  }
}

// ---------------- AgentEvent → 契约事件桥接 ----------------

/** tool_execution_update 整段节流间隔：流式工具（后台任务输出等）的更新
 *  按体积分档——小更新整段直发但限频；大更新直接丢弃（tool_execution_end
 *  才是权威终态，reducer 只把 partialResult 用作运行中预览） */
const TOOL_UPDATE_MIN_INTERVAL_MS = 250;
const TOOL_UPDATE_MAX_BYTES = 256 * 1024;

/** 剥离 assistantMessageEvent 的 partial（重负字段）；toolcall_start 抽取
 *  toolCall 的 id/name（provider 在 start 时已填好，客户端没有就等 end 修正） */
function stripDelta(e: {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: unknown;
  reason?: string;
  message?: unknown;
  error?: unknown;
  partial?: { content?: unknown[] };
}): Record<string, unknown> {
  const base: Record<string, unknown> = { type: e.type };
  if (e.contentIndex !== undefined) base.contentIndex = e.contentIndex;
  if (e.delta !== undefined) base.delta = e.delta;
  if (e.content !== undefined) base.content = e.content;
  if (e.reason !== undefined) base.reason = e.reason;
  switch (e.type) {
    case "toolcall_start": {
      const block = e.partial?.content?.[e.contentIndex ?? -1] as
        | { id?: string; name?: string }
        | undefined;
      base.toolCall = { id: block?.id ?? "", name: block?.name ?? "" };
      break;
    }
    case "toolcall_end":
      base.toolCall = e.toolCall;
      break;
    case "done":
      base.message = e.message;
      break;
    case "error":
      base.error = e.error;
      break;
  }
  return base;
}

/** 挂到 run.agent 的事件桥：随会话解析时调用一次（resolve.ts），线程身份=sessionId。
 *  内部自行 agent.subscribe，Agent 生命周期与会话一致，无需退订句柄。 */
export function wireSessionEvents(run: Running): void {
  const sessionId = run.sessionId;
  if (!sessionId) return;
  let turnIndex = 0;
  const toolUpdateAt = new Map<string, number>();
  run.agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        partials.delete(sessionId);
        emitThreadEvent(sessionId, { type: "agent_start" });
        break;
      case "agent_end": {
        partials.delete(sessionId);
        // 收尾定调（完成提醒缺口3）：末条 assistant 的 stopReason/errorMessage
        // 随帧带给前端——aborted/error 的收尾不算完成，与旧链路 finish 分支的
        // sawAborted/sawError 语义一致；undefined 序列化时按键丢弃，旧前端兼容
        const last = event.messages?.at(-1) as
          | { stopReason?: string; errorMessage?: string }
          | undefined;
        emitThreadEvent(sessionId, {
          type: "agent_end",
          stopReason: last?.stopReason,
          errorMessage: last?.stopReason === "error" ? last.errorMessage : undefined,
        });
        break;
      }
      case "turn_start":
        turnIndex += 1;
        emitThreadEvent(sessionId, { type: "turn_start", turnIndex });
        break;
      case "turn_end":
        emitThreadEvent(sessionId, { type: "turn_end", turnIndex });
        break;
      case "message_start":
        notePartial(sessionId, event.message);
        emitThreadEvent(sessionId, { type: "message_start", message: event.message });
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent as unknown as {
          partial?: unknown;
        } & Record<string, unknown>;
        notePartial(sessionId, delta.partial);
        emitThreadEvent(sessionId, {
          type: "message_update",
          assistantMessageEvent: stripDelta(
            delta as unknown as Parameters<typeof stripDelta>[0],
          ),
        });
        break;
      }
      case "message_end": {
        partials.delete(sessionId);
        emitThreadEvent(sessionId, { type: "message_end", message: event.message });
        // 失败消息 → 契约 error 事件（reducer 记 lastError；溢出除外——
        // 恢复路径压缩后同文本重跑，置 failed 会误报中断）
        const m = event.message as { stopReason?: string; errorMessage?: string };
        if (
          m?.stopReason === "error" &&
          !isContextOverflow(event.message as Parameters<typeof isContextOverflow>[0], run.agent.state.model?.contextWindow)
        ) {
          emitThreadEvent(sessionId, {
            type: "error",
            error: m.errorMessage || "pi agent error",
          });
        }
        break;
      }
      case "tool_execution_start":
        toolUpdateAt.set(event.toolCallId, Date.now());
        emitThreadEvent(sessionId, {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? null,
        });
        break;
      case "tool_execution_update": {
        // 体积分档：超限丢弃；限频节流（终态 end 恒发，预览短暂滞后可接受）
        const last = toolUpdateAt.get(event.toolCallId) ?? 0;
        const now = Date.now();
        if (now - last < TOOL_UPDATE_MIN_INTERVAL_MS) break;
        const text = JSON.stringify(event.partialResult ?? null);
        if (text.length > TOOL_UPDATE_MAX_BYTES) break;
        toolUpdateAt.set(event.toolCallId, now);
        emitThreadEvent(sessionId, {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          partialResult: event.partialResult ?? null,
        });
        break;
      }
      case "tool_execution_end":
        toolUpdateAt.delete(event.toolCallId);
        emitThreadEvent(sessionId, {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          result: event.result ?? null,
          isError: event.isError,
        });
        break;
    }
  });
}
