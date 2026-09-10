/**
 * 流式事件：把 pi-agent-core 的 Agent 事件转换为 AI SDK UIMessageChunk，
 * 以 {"id":reqId,"chunk":...} 的 NDJSON 行写到 stdout。
 * currentReqId 由协议层在 prompt 前后设置，事件据此路由到当前请求。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { logErr } from "./log";
import { persist } from "./transcript";
import type { Running, UIMessageChunk } from "./types";

export const send = (line: unknown) =>
  process.stdout.write(JSON.stringify(line) + "\n");

export const sendChunk = (id: string, chunk: UIMessageChunk) =>
  send({ id, chunk });

let currentReqId: string | null = null;
let runSeq = 0;
/** 当前运行中 contentIndex -> 流式内容 id */
let contentIds = new Map<number, { text: string; reasoning: string }>();

/** 协议层在 prompt 开始/结束时设置，事件据此路由到当前请求 */
export function setCurrentReqId(id: string | null) {
  currentReqId = id;
}

/** 活跃请求内发一条额外 chunk（如 planning_state）；无活跃请求时静默丢弃 */
export function sendEventChunk(chunk: UIMessageChunk) {
  if (!currentReqId) return;
  sendChunk(currentReqId, chunk);
}

/** 开始新一轮流式输出：递增 runSeq 并重置内容 id 映射 */
export function beginRun() {
  runSeq += 1;
  contentIds = new Map();
}

function contentIdFor(index: number) {
  let ids = contentIds.get(index);
  if (!ids) {
    ids = { text: `text-${runSeq}-${index}`, reasoning: `reasoning-${runSeq}-${index}` };
    contentIds.set(index, ids);
  }
  return ids;
}

/** Agent 事件 -> UIMessageChunk 流（reqId 取当前活跃请求） */
export async function onAgentEvent(event: AgentEvent, run: Running): Promise<void> {
  const reqId = currentReqId;
  if (event.type !== "message_update") logErr("event:", event.type);
  else logErr("event: message_update/", (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type);
  switch (event.type) {
    case "message_end": {
      // 裸 Agent 的 stream 异常（网络/401 等）会合成 stopReason:"error" 的失败消息
      if (!reqId) break;
      const m = event.message as { stopReason?: string; errorMessage?: string };
      if (m?.stopReason === "error") {
        sendChunk(reqId, {
          type: "error",
          errorText: m.errorMessage || "pi agent error",
        });
      }
      break;
    }
    case "message_update": {
      if (!reqId) break;
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "text_start": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-start", id: text });
          break;
        }
        case "text_delta": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-delta", id: text, delta: e.delta });
          break;
        }
        case "text_end": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-end", id: text });
          break;
        }
        case "thinking_start": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-start", id: reasoning });
          break;
        }
        case "thinking_delta": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-delta", id: reasoning, delta: e.delta });
          break;
        }
        case "thinking_end": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-end", id: reasoning });
          break;
        }
        case "error": {
          const detail = (e as { error?: { errorMessage?: string } }).error?.errorMessage ?? "pi agent error";
          sendChunk(reqId, { type: "error", errorText: String(detail) });
          break;
        }
      }
      break;
    }
    case "tool_execution_start": {
      if (!reqId) break;
      sendChunk(reqId, {
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args ?? null,
      });
      break;
    }
    case "tool_execution_end": {
      if (!reqId) break;
      const result = event.result as { content?: { type: string; text?: string }[] };
      const output =
        result?.content
          ?.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("\n") ?? "";
      sendChunk(reqId, {
        type: "tool-output-available",
        toolCallId: event.toolCallId,
        output,
      });
      break;
    }
    case "agent_end": {
      // persist 变 async（索引表经 hostdb 走宿主 RPC）；subscribe 会 await 监听器
      await persist(run);
      break;
    }
  }
}
