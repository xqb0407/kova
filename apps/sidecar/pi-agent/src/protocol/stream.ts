/**
 * 流式事件：把 pi-agent-core 的 Agent 事件转换为 AI SDK UIMessageChunk，
 * 以 {"id":reqId,"chunk":...} 的 NDJSON 行写到 stdout。
 * 事件按线程路由：activeReqByThread 记录每个线程当前活跃 prompt 请求，
 * 多线程并行跑 turn 时事件互不串流（每线程一个 Agent 实例是天然边界）。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { logAt, logErr } from "../log";
import { buildHookPayload, fireHookEvent } from "../agent/hooks";
import { projectToolResult, type ProjectableContentBlock } from "../tools/image-parts";
import { persist } from "../sessions/transcript";
import { createTraceRunRecorder } from "./trace";
import {
  makeAutoContinueMessage,
  MAX_LENGTH_CONTINUES,
  needsLengthContinuation,
} from "../agent/context";
import type { Running, UIMessageChunk } from "../types";

export const send = (line: unknown) =>
  process.stdout.write(JSON.stringify(line) + "\n");

export const sendChunk = (id: string, chunk: UIMessageChunk) =>
  send({ id, chunk });

/** threadId -> 该线程当前活跃 prompt 请求 id（协议层在 turn 起止时设置） */
const activeReqByThread = new Map<string, string>();

/** 协议层在 prompt 开始/结束时设置，事件据此路由到该线程的当前请求 */
export function setActiveReqId(threadId: string, id: string | null) {
  if (id) {
    activeReqByThread.set(threadId, id);
  } else {
    activeReqByThread.delete(threadId);
    streamStates.delete(threadId);
  }
}

/** 该线程是否有 prompt 长任务在跑（compact 等按线程拒绝忙会话用） */
export function isPromptActive(threadId: string) {
  return activeReqByThread.has(threadId);
}

/** 线程内发一条额外 chunk（如 planning_state）；该线程无活跃请求时静默丢弃 */
export function sendEventChunk(threadId: string, chunk: UIMessageChunk) {
  const reqId = activeReqByThread.get(threadId);
  if (!reqId) return;
  sendChunk(reqId, chunk);
}

/** 每线程流式状态：runSeq（轮次序号）、contentIndex -> 内容 id、updateCount 计数 */
type ThreadStreamState = {
  runSeq: number;
  contentIds: Map<number, { text: string; reasoning: string }>;
  updateCount: number;
};

const streamStates = new Map<string, ThreadStreamState>();

function stateFor(threadId: string): ThreadStreamState {
  let s = streamStates.get(threadId);
  if (!s) {
    s = { runSeq: 0, contentIds: new Map(), updateCount: 0 };
    streamStates.set(threadId, s);
  }
  return s;
}

/** 开始新一轮流式输出：递增 runSeq 并重置内容 id 映射（每线程独立） */
export function beginRun(threadId: string) {
  const s = stateFor(threadId);
  s.runSeq += 1;
  s.contentIds = new Map();
  s.updateCount = 0;
}

function contentIdFor(threadId: string, index: number) {
  const s = stateFor(threadId);
  let ids = s.contentIds.get(index);
  if (!ids) {
    ids = { text: `text-${s.runSeq}-${index}`, reasoning: `reasoning-${s.runSeq}-${index}` };
    s.contentIds.set(index, ids);
  }
  return ids;
}

/** Agent 事件 -> UIMessageChunk 流（reqId 取该线程当前活跃请求） */
export async function onAgentEvent(event: AgentEvent, run: Running): Promise<void> {
  const reqId = run.threadId ? activeReqByThread.get(run.threadId) : undefined;
  const threadId = run.threadId;
  // 轨迹（trace.ts）：agent_start 开新 run（上一轮异常残留先按 error 强制落盘），
  // 其余事件喂给记录器；结算在 agent_end 的 persist 之后。旁路/automation run
  // 无协议 reqId，source 据此区分
  if (event.type === "agent_start") {
    run.trace?.settle("error");
    run.trace = createTraceRunRecorder(run.sessionId, reqId ? "ui" : "automation");
  }
  run.trace?.handle(event);
  // 迭代3（P3）：message_update 属 token 级噪音，计数不落日志（PI_LOG_LEVEL=delta
  // 可恢复逐条）；其余事件轮级低频，event 级日志。轮末在 agent_end 打一行摘要。
  if (event.type === "message_update") {
    stateFor(threadId).updateCount += 1;
    logAt(
      "delta",
      "event: message_update/",
      (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type,
    );
  } else {
    logAt("event", "event:", event.type);
  }
  switch (event.type) {
    case "message_end": {
      // 用户消息（含 steer/followUp）进入 state 的当场落盘（增量 persist 此刻
      // 只会补上这一条）：轮中刷新后 get_history 才带得出这条气泡；earlyUser
      // 模式只补录+touch、跳过智能标题，见 transcript.persist
      if ((event.message as { role?: string }).role === "user") {
        await persist(run, { earlyUser: true });
        break;
      }
      // assistant/toolResult 落定即持久化：agent_end 不再是唯一提交点，进程异常退出
      // （崩溃/dev 热重载进程组被杀）最多丢正在流式的那一条，不再丢整轮已完成消息。
      // 放在 reqId 短路之前：不带协议 reqId 的旁路/automation run 同样要落盘。
      // 时序前提：agent-core 在 await 监听器之前已把该消息 push 进 state.messages
      // （agent.js processEvents 先行），增量 persist 恰好收进这一条
      await persist(run);
      // 裸 Agent 的 stream 异常（网络/401 等）会合成 stopReason:"error" 的失败消息
      if (!reqId) break;
      const m = event.message as { stopReason?: string; errorMessage?: string };
      if (m?.stopReason === "error") {
        // 上下文溢出：不发 error chunk（会终结本条消息流），置位交给
        // dispatchPrompt 压缩后同文本重跑；非溢出错误照常上报
        const model = run.agent.state.model;
        if (isContextOverflow(event.message as AssistantMessage, model?.contextWindow)) {
          run.pendingOverflowRecovery = true;
          logErr("event: message_end context overflow, recovery deferred to protocol");
        } else {
          sendChunk(reqId, {
            type: "error",
            errorText: m.errorMessage || "pi agent error",
          });
        }
      }
      break;
    }
    case "turn_end": {
      // Claude Code 式 Stop 钩子：每回合收尾触发；不依赖 reqId（后台跑/刷新空窗
      // 同样触发）。放在长度续跑判定之前——续跑注入的额外 turn 各自收尾也会触发
      fireHookEvent(
        "Stop",
        buildHookPayload({
          event: "Stop",
          sessionId: run.sessionId,
          threadId: run.threadId,
        }),
      );
      // 长度截断且本轮零 toolCall：vendor 循环把这视为自然收尾（它只对"截断+带
      // tool call"的轮失败重试），任务会"到一半停下"。补一条续跑消息进 followUp
      // 队列——循环在 turn_end 监听 settle 之后、退出之前恰好轮询该队列，时序是
      // vendor 契约。不依赖 reqId：无前端旁路跑（远程触发/刷新空窗）同样要续。
      if (!needsLengthContinuation(event.message)) break;
      if ((run.lengthContinues ?? 0) >= MAX_LENGTH_CONTINUES) {
        logErr("length-truncated turn: auto-continue budget exhausted, ending run");
        break;
      }
      run.lengthContinues = (run.lengthContinues ?? 0) + 1;
      logAt("event", `length-truncated turn: injecting auto-continue #${run.lengthContinues}`);
      run.agent.followUp(makeAutoContinueMessage());
      break;
    }
    case "message_update": {
      if (!reqId) break;
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "text_start": {
          const { text } = contentIdFor(threadId, e.contentIndex);
          sendChunk(reqId, { type: "text-start", id: text });
          break;
        }
        case "text_delta": {
          const { text } = contentIdFor(threadId, e.contentIndex);
          sendChunk(reqId, { type: "text-delta", id: text, delta: e.delta });
          break;
        }
        case "text_end": {
          const { text } = contentIdFor(threadId, e.contentIndex);
          sendChunk(reqId, { type: "text-end", id: text });
          break;
        }
        case "thinking_start": {
          const { reasoning } = contentIdFor(threadId, e.contentIndex);
          sendChunk(reqId, { type: "reasoning-start", id: reasoning });
          break;
        }
        case "thinking_delta": {
          const { reasoning } = contentIdFor(threadId, e.contentIndex);
          sendChunk(reqId, { type: "reasoning-delta", id: reasoning, delta: e.delta });
          break;
        }
        case "thinking_end": {
          const { reasoning } = contentIdFor(threadId, e.contentIndex);
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
      // 图片投影与历史侧共用 projectToolResult（image-parts.ts），保证直播=刷新同构；
      // 顺序契约：tool-output-available → data-image×n，part 落进对应 tool part 之后
      const { output, images } = projectToolResult(
        (event.result as { content?: ProjectableContentBlock[] } | undefined)?.content,
        { toolCallId: event.toolCallId, toolName: event.toolName },
      );
      // 失败/被拒的结果走 AI SDK 标准 tool-output-error：前端据此把 part 的
      // isError 置真（工具行失败态、产物过滤、面板 failed 都依赖它——此前
      // 标记在映射时丢失，被拒的 write 也被当成成功产物渲染）
      if (event.isError) {
        sendChunk(reqId, {
          type: "tool-output-error",
          toolCallId: event.toolCallId,
          errorText: output,
        });
      } else {
        sendChunk(reqId, {
          type: "tool-output-available",
          toolCallId: event.toolCallId,
          output,
        });
      }
      for (const img of images) {
        sendChunk(reqId, { type: "data-image", id: img.id, data: img.data });
      }
      break;
    }
    case "agent_end": {
      logAt("event", `run summary: ${stateFor(threadId).updateCount} message_update events`);
      // persist 变 async（索引表经 hostdb 走宿主 RPC）；subscribe 会 await 监听器
      await persist(run);
      // 轨迹结算：handle(agent_end) 已记账完，这里落盘并清引用
      run.trace?.settle();
      run.trace = undefined;
      break;
    }
  }
}
