/**
 * 流式事件：把 pi-agent-core 的 Agent 事件转换为 AI SDK UIMessageChunk，
 * 以 {"id":reqId,"chunk":...} 的 NDJSON 行写到 stdout。
 * 事件按线程路由：activeReqByThread 记录每个线程当前活跃 prompt 请求，
 * 多线程并行跑 turn 时事件互不串流（每线程一个 Agent 实例是天然边界）。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ErrorPayload } from "pi-protocol";
import { configCwdFor } from "../agent/projects";
import { logAt, logErr } from "../log";
import { buildHookPayload, fireHookEvent } from "../agent/hooks";
import { runTurnEndHooks } from "../agent/assembly";
import { classifyAgentError, toWireError } from "../agent/agent-errors";
import { maybeVerifyFollowUp } from "../agent/verify-run";
import { calibrateContextWindowFromError } from "../model/context-limit";
import { projectToolResult, type ProjectableContentBlock } from "../tools/image-parts";
import { normalizeToolResultImages } from "../tools/image-normalize";
import { persist } from "../sessions/transcript";
import { nextEventSeq } from "./event-seq";
import { createTraceRunRecorder } from "./trace";
import {
  makeAutoContinueMessage,
  messageUsageTokens,
  MAX_LENGTH_CONTINUES,
  needsLengthContinuation,
  needsStreamBreakContinuation,
  type ContinuationReason,
} from "../agent/context";
import { continueGoalTurn } from "../goal/goal";
import type { Running, UIMessageChunk } from "../types";

/**
 * 帧出口：默认写 stdout NDJSON（Electron 宿主协议）。
 * ACP 模式用 setFrameSink 接管，内部帧改由 ACP 适配层翻译，绝不污染
 * JSON-RPC 的 stdout。
 */
export type WireFrameSink = (frame: unknown) => void;
let frameSink: WireFrameSink | null = null;

export function setFrameSink(sink: WireFrameSink | null): void {
  frameSink = sink;
}

export const send = (line: unknown) => {
  if (frameSink) {
    frameSink(line);
    return;
  }
  process.stdout.write(JSON.stringify(line) + "\n");
};

export const sendChunk = (id: string, chunk: UIMessageChunk) =>
  send({ id, chunk });

/** 会话清单变更广播（sessions_changed 自发通知帧，契约见 pi-protocol notifications）：
 *  会话在索引表里的可见集合/标题/归档态发生变化时发（新建、首条消息落盘、分叉、
 *  删除、改名、归档、截断、换目录）。宿主原样转发给所有前端（桌面 webview +
 *  WS 网关白名单），前端据此防抖整表 reload——跨端（移动↔桌面↔网页）列表实时同步。 */
export const sendSessionsChanged = (
  op: "created" | "updated" | "deleted",
  sessionId: string,
) => send({ type: "sessions_changed", op, sessionId });

/** 项目实体变更广播：名称/外观/目录/归档态变化后发（无 id 自发行）。
 *  宿主原样转发给所有前端；各端据此 refresh 项目注册表，避免多窗口
 *  侧栏/胶囊停留在旧名称与旧图标。 */
export const sendProjectsChanged = (
  op: "saved" | "deleted",
  projectId: string,
) => send({ type: "projects_changed", op, projectId });

/**
 * error chunk + 结构化归因（设计文档 §8）：AI SDK 的 error chunk 类型只有
 * errorText，`error` 字段是加性扩展（线形 = JSON，两端 passthrough）；
 * 桌面 transport 读到后先入一个 data-errorAttribution part 再转发 error
 * chunk，让归因随消息 part 持久进 assistant-ui 状态、错误卡片据此渲染重试。
 * 不传 error 时退化为旧线形。
 */
export const sendErrorChunk = (
  id: string,
  errorText: string,
  error?: ErrorPayload,
) =>
  sendChunk(
    id,
    {
      type: "error",
      errorText,
      ...(error ? { error } : {}),
    } as unknown as UIMessageChunk,
  );

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

/**
 * 线程内发一条额外 chunk（如 planning_state）；该线程无活跃请求时静默丢弃。
 * 传 sessionId 时该行盖事件水印（设计文档 §3）：{id, chunk, sessionId, eventSeq}
 * 线形，供桌面 seq-guard 检缺口回拉；盖章发生在确认写出之后（丢弃不占号）。
 */
export function sendEventChunk(threadId: string, chunk: UIMessageChunk, sessionId?: string) {
  const reqId = activeReqByThread.get(threadId);
  if (!reqId) return;
  if (sessionId) {
    send({ id: reqId, chunk, sessionId, eventSeq: nextEventSeq(sessionId) });
    return;
  }
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
  // 首响应打点：大折叠耗时从 AI 真正开始回复起算（不含「连接中」等待）。
  // message_update 是首个内容增量；非流式响应在 message_start/end 时内容已就绪。
  if (run.turnFirstResponseAt === undefined) {
    if (event.type === "message_update") {
      const role = (event as { message?: { role?: string } }).message?.role;
      if (role === undefined || role === "assistant") {
        run.turnFirstResponseAt = Date.now();
      }
    } else if (event.type === "message_start" || event.type === "message_end") {
      const message = event.message as {
        role?: string;
        content?: unknown;
        timestamp?: number;
      };
      if (
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.length > 0
      ) {
        run.turnFirstResponseAt =
          typeof message.timestamp === "number" ? message.timestamp : Date.now();
      }
    }
  }
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
      // 目标 token 账：现累而不是事后从转录重算（理由见 Running.usagePending）。
      // 放在这里是因为 message_end 是 usage 唯一的到达点，且早于 turn_end 的结算
      run.usagePending += messageUsageTokens(event.message);
      // 缓存保活的健康门控数据源：最近几次真实请求的命中率。错误/中止轮的
      // usage 是虚账，不喂（与 usage 统计同口径，见 agent/cache-warmer.ts）
      const endedMessage = event.message as {
        stopReason?: string;
        usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
      };
      if (endedMessage.stopReason !== "error" && endedMessage.stopReason !== "aborted") {
        run.cacheWarmer?.observeUsage(endedMessage.usage);
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
      // 用户 Stop 与模型错误在 trace 里必须分开：前者不是错误，混进去污染错误率
      if (m?.stopReason === "aborted") {
        run.trace?.noteOutcome({ reason: "user-stop", detail: "用户按 Stop 中断" });
      }
      if (m?.stopReason === "error") {
        // 上下文溢出：不发 error chunk（会终结本条消息流），置位交给
        // dispatchPrompt 压缩后同文本重跑；非溢出错误照常上报
        const model = run.agent.state.model;
        if (isContextOverflow(event.message as AssistantMessage, model?.contextWindow)) {
          // 服务端报了真实上限就顺手校准模型窗口；后续压缩/重试用新预算，
          // 自定义模型不再永远停在 128K 默认值。校准失败绝不能盖掉溢出恢复。
          try {
            await calibrateContextWindowFromError(run, m.errorMessage);
          } catch (err) {
            logErr("context-window calibration failed:", err);
          }
          run.pendingOverflowRecovery = true;
          run.trace?.noteOutcome({
            reason: "context-overflow",
            detail: "上下文溢出，协议层压缩后重跑本轮",
          });
          logErr("event: message_end context overflow, recovery deferred to protocol");
        } else {
          // provider 流出路：含糊串按最可能来源（供应商）归因
          const errorText = m.errorMessage || "pi agent error";
          sendErrorChunk(reqId, errorText, toWireError(classifyAgentError(errorText)));
        }
      }
      break;
    }
    case "turn_end": {
      // 能力收尾钩子：只观察/至多注入一条提醒，失败由 helper 吞掉；
      // 必须在 goal 续跑判定与 Stop 钩子之前，保证本轮工具结果已经可见。
      if (run.turnCapabilities && run.turnCapabilities.hooks.turnEnd.length > 0) {
        // 本回合 assistant 可见文本：行为纠偏能力（silent-turn 等）判定
        // 「模型是否连续闷头干活」用；text 块拼接，无文本回合为空串。
        // content 按协议恒为块数组，string 形状（provider 畸形输出）也兜住
        const messageContent: unknown = event.message?.content;
        const assistantParts = (
          Array.isArray(messageContent) ? messageContent : []
        ) as ReadonlyArray<{ type: string; text?: string }>;
        await runTurnEndHooks(run.turnCapabilities, {
          stopRequested: run.stopRequested,
          assistantText: assistantParts
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n"),
          toolResults: (event.toolResults ?? []).map((result) => ({
            toolName: result.toolName,
            isError: result.isError,
            text: result.content
              .filter((part): part is { type: "text"; text: string } => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          })),
          queueReminder: (text) => {
            // 只排队，不直接 steer：最终轮的提醒不能留到下一次用户 prompt
            // （pi 的 steeringQueue 在 run 结束后不会被清空）。
            (run.capabilityReminders ??= []).push(text);
          },
        });
      }
      // Claude Code 式 Stop 钩子：每回合收尾触发；不依赖 reqId（后台跑/刷新空窗
      // 同样触发）。放在长度续跑判定之前——续跑注入的额外 turn 各自收尾也会触发
      fireHookEvent(
        "Stop",
        buildHookPayload({
          event: "Stop",
          sessionId: run.sessionId,
          threadId: run.threadId,
        }),
        { workspace: configCwdFor(run.cwd, run.projectId) },
      );
      // 长度截断且本轮零 toolCall：vendor 循环把这视为自然收尾（它只对"截断+带
      // tool call"的轮失败重试），任务会"到一半停下"。补一条续跑消息进 followUp
      // 队列——循环在 turn_end 监听 settle 之后、退出之前恰好轮询该队列，时序是
      // vendor 契约。不依赖 reqId：无前端旁路跑（远程触发/刷新空窗）同样要续。
      //
      // goal 档不走这条路：目标续跑注入的那条消息本身会把目标原文重述一遍，
      // 严格强于长度续跑的「继续」；而且 lengthContinues 是按用户轮重置的
      // （dispatchPrompt 每轮清零），一个跑 25 轮的目标会在第 4 轮左右撞上
      // MAX_LENGTH_CONTINUES 被误杀。两条路都是「本轮自然收尾 → 补一条续跑」，
      // 目标档选信息量更大的那条。
      if (run.mode === "goal") {
        run.trace?.noteOutcome({
          reason: "completed",
          detail: "goal 档：目标续跑中",
        });
        continueGoalTurn(run, event.message, event.toolResults);
        break;
      }
      // 两种中断都走这条注入路径：
      //  - length 截断（预算烧在思考/正文上，vendor 当自然收尾）；
      //  - provider 流中断（可重试类错误，如 Stream ended without finish_reason）
      //    ——线上实测的"回答到一半"，此前只能手动点重试。
      // 两者都要求本轮零 toolCall：带工具调用的轮重发可能重复执行已跑过的工具。
      const contReason: ContinuationReason | null = needsLengthContinuation(
        event.message,
      )
        ? "length"
        : needsStreamBreakContinuation(event.message)
          ? "stream"
          : null;
      if (!contReason) break;
      if ((run.lengthContinues ?? 0) >= MAX_LENGTH_CONTINUES) {
        // 续跑预算烧完：这是编排层的决定，记录器只能靠这里知道
        run.trace?.noteOutcome({
          reason: "length-budget-exhausted",
          detail: `连续 ${MAX_LENGTH_CONTINUES} 次长度续跑仍未收尾，本轮中止`,
        });
        logErr(
          `${contReason}-interrupted turn: auto-continue budget exhausted, ending run ` +
            "(length 反复撞顶就调大该模型 maxTokens——自定义端点默认 8192；" +
            "流中断多为 free 中转/代理超时)",
        );
        // 静默中止补信号：桌面据此渲染「连续输出截断，任务已中止」分隔线
        //（data-stopped 同款机制；快照/历史侧由 thread_snapshot 标注与
        // historyToUiMessages 同构重建，见 transcript.isTruncationStoppedRow）
        if (reqId) {
          sendChunk(reqId, {
            type: "data-truncation-stopped",
            id: "truncation-stopped",
            data: {},
          });
        }
        break;
      }
      run.lengthContinues = (run.lengthContinues ?? 0) + 1;
      logAt(
        "event",
        `${contReason}-interrupted turn: injecting auto-continue #${run.lengthContinues}`,
      );
      run.agent.followUp(makeAutoContinueMessage(run.lengthContinues, contReason));
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
          const detail = String(
            (e as { error?: { errorMessage?: string } }).error?.errorMessage ?? "pi agent error",
          );
          sendErrorChunk(reqId, detail, toWireError(classifyAgentError(detail)));
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
      // 先"处理到合规"再投影/落盘：超限图按当前模型 inputLimits.images.resize
      // 缩放/转码到内联闸门内，处理不了才折成 text 说明。必须放在 reqId 短路
      // 之前——旁路/automation run 没有协议流，但模型上下文同样要拿到合规图。
      // 时序保证：agent-core 在 await 本监听器之后才用 event.result.content
      // 构造 toolResult 消息（agent-loop.js createToolResultMessage），原地改
      // result.content 对模型与持久化同时生效。
      const result = event.result as { content?: ProjectableContentBlock[] } | undefined;
      if (result?.content) {
        const normalized = await normalizeToolResultImages(
          result.content,
          run.agent.state.model,
        );
        if (normalized) {
          try {
            result.content = normalized as ProjectableContentBlock[];
          } catch (err) {
            // 扩展返回的 frozen 结果：改不动就退回投影闸门，别让事件处理崩掉
            logErr("tool result image normalize: content is not writable:", err);
          }
        }
      }
      if (!reqId) break;
      // 图片投影与历史侧共用 projectToolResult（image-parts.ts），保证直播=刷新同构；
      // 顺序契约：tool-output-available → data-image×n，part 落进对应 tool part 之后
      const { output, images } = projectToolResult(
        result?.content,
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
      // autoVerify：本轮改了文件且开关开启 → 注入只读验证 followUp（fail-open：
      // 判定异常绝不影响已完成的 run 结算）。用户 Stop（stopRequested）与
      // 失败/中止轮（尾部 assistant stopReason ≠ stop）不注入——Stop 后残留
      // followUp 会插队在新用户消息之前执行，违背中断意图
      const lastAssistant = [...run.agent.state.messages]
        .reverse()
        .find((m) => (m as { role?: string }).role === "assistant") as
        | { stopReason?: string }
        | undefined;
      const settledOk =
        run.mode !== "goal" &&
        !run.stopRequested &&
        (lastAssistant === undefined ||
          lastAssistant.stopReason === undefined ||
          lastAssistant.stopReason === "stop");
      if (settledOk) {
        try {
          const verifyMsg = maybeVerifyFollowUp(run, run.agent.state.messages);
          if (verifyMsg) run.agent.followUp(verifyMsg);
        } catch (error) {
          logErr("auto-verify inject failed (ignored):", error);
        }
      }
      // 轨迹结算：handle(agent_end) 已记账完，这里落盘并清引用
      run.trace?.settle();
      run.trace = undefined;
      break;
    }
  }
}
