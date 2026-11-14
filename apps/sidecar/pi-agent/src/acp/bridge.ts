/**
 * ACP ↔ 内部协议桥：把 ACP 请求翻译成现有内部命令，并从帧 sink 里收回响应/
 * 流式 chunk。
 *
 * 设计要点：
 * - 不复制命令分发：所有管理命令仍走 protocol.ts 的 handleLine，排队/闸门/
 *   错误归因与桌面路径完全一致；
 * - prompt 是长任务：handleLine 的 prompt 分支 fire-and-forget，本层按 reqId
 *   跟踪 chunk 流，finish/error/abort 三个终止点收口；
 * - 每个 prompt 的 update 处理串行化，保证权限卡/工具调用/文本的先后顺序；
 * - stdout 由 ACP SDK 独占：安装 frame sink 后内部帧只进本层，不再写 NDJSON。
 */
import { randomUUID } from "node:crypto";
import { handleLine } from "../protocol/protocol";
import { setFrameSink } from "../protocol/stream";
import { logErr } from "../log";

export type WireFrame = {
  id?: string;
  type?: string;
  chunk?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AcpChunkHandler = (chunk: Record<string, unknown>) => void | Promise<void>;

export type PromptStartInput = {
  threadId: string;
  sessionId: string;
  text: string;
  cwd?: string;
  attachments?: Record<string, unknown>[];
  onChunk: AcpChunkHandler;
};

export type PromptResult = {
  stopReason: "end_turn" | "cancelled";
};

export class AcpInternalError extends Error {
  errorText: string;
  payload?: Record<string, unknown>;

  constructor(errorText: string, payload?: Record<string, unknown>) {
    super(errorText);
    this.name = "AcpInternalError";
    this.errorText = errorText;
    if (payload) this.payload = payload;
  }
}

type PendingCommand = {
  resolve: (frame: WireFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

type PromptStream = {
  reqId: string;
  threadId: string;
  sessionId: string;
  chain: Promise<void>;
  finished: boolean;
  /** 是否已收到内部 start chunk：启动前错误（排队上限/准备失败）不会再有 finish */
  started: boolean;
  cancelled: boolean;
  error: AcpInternalError | null;
  onChunk: AcpChunkHandler;
  resolve: (result: PromptResult) => void;
  reject: (error: Error) => void;
  done: Promise<PromptResult>;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

let seq = 0;
const nextId = () => `acp-${++seq}-${randomUUID().slice(0, 8)}`;

/** 轮收尾的上下文读数（context_changed 自发帧）→ usage_update 的数据源 */
export type SessionContextUsage = { used: number; size: number };

export class AcpBridge {
  private pending = new Map<string, PendingCommand>();
  private prompts = new Map<string, PromptStream>();
  private installed = false;
  private contextUsage = new Map<string, SessionContextUsage>();
  private contextUsageListener: ((sessionId: string, usage: SessionContextUsage) => void) | null =
    null;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    setFrameSink((frame) => this.onFrame(frame as WireFrame));
  }

  /** 发一条内部管理命令并等它的同 id 响应帧 */
  async request(
    msg: Record<string, unknown>,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<WireFrame> {
    const reqId = nextId();
    const method = String(msg.type ?? "?");
    const framePromise = new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new AcpInternalError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(reqId, { resolve, reject, timer, method });
    });
    try {
      handleLine(JSON.stringify({ ...msg, id: reqId }));
    } catch (err) {
      const pending = this.pending.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(reqId);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return framePromise;
  }

  /** 发起一轮 prompt；返回的 promise 在 finish/error 时结算 */
  startPrompt(input: PromptStartInput): { reqId: string; done: Promise<PromptResult> } {
    const reqId = nextId();
    let resolve!: (result: PromptResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<PromptResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const stream: PromptStream = {
      reqId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      chain: Promise.resolve(),
      finished: false,
      started: false,
      cancelled: false,
      error: null,
      onChunk: input.onChunk,
      resolve,
      reject,
      done,
    };
    this.prompts.set(reqId, stream);

    try {
      handleLine(
        JSON.stringify({
          type: "prompt",
          id: reqId,
          threadId: input.threadId,
          sessionId: input.sessionId,
          text: input.text,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        }),
      );
    } catch (err) {
      this.prompts.delete(reqId);
      const error = err instanceof Error ? err : new Error(String(err));
      reject(error);
    }

    return { reqId, done };
  }

  /** 用户 Stop：内部 abort 不排队，立即生效 */
  abort(threadId: string): void {
    try {
      handleLine(JSON.stringify({ type: "abort", threadId }));
    } catch (err) {
      logErr("[acp] abort dispatch failed:", err);
    }
  }

  abortAll(): void {
    try {
      handleLine(JSON.stringify({ type: "abort" }));
    } catch (err) {
      logErr("[acp] global abort dispatch failed:", err);
    }
  }

  /** 注册上下文读数监听（context_changed 帧到达时回调；每次覆盖） */
  setContextUsageListener(
    listener: ((sessionId: string, usage: SessionContextUsage) => void) | null,
  ): void {
    this.contextUsageListener = listener;
  }

  /** 最近一次上下文读数（没跑过轮 = undefined） */
  lastContextUsage(sessionId: string): SessionContextUsage | undefined {
    return this.contextUsage.get(sessionId);
  }

  /** 是否存在该线程在飞的 prompt 流（ACP 层并发判定用） */
  hasPrompt(threadId: string): boolean {
    for (const stream of this.prompts.values()) {
      if (stream.threadId === threadId && !stream.finished) return true;
    }
    return false;
  }

  /** 等待所有 prompt 的 update 链排空（退出前调用） */
  async drain(): Promise<void> {
    const chains = [...this.prompts.values()].map((s) => s.chain);
    await Promise.allSettled(chains);
  }

  dispose(): void {
    this.installed = false;
    // 退出窗口内可能还有异步 persist/abort 收尾的 send：留一个丢弃 sink，
    // 不能恢复 stdout NDJSON（会把内部帧写进正在结束的 JSON-RPC 通道）。
    setFrameSink(() => {});
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AcpInternalError("ACP bridge disposed"));
    }
    this.pending.clear();
    for (const stream of this.prompts.values()) {
      if (!stream.finished) {
        stream.finished = true;
        stream.reject(new AcpInternalError("ACP bridge disposed"));
      }
    }
    this.prompts.clear();
  }

  private onFrame(frame: WireFrame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (id) {
      const pending = this.pending.get(id);
      if (pending && frame.chunk === undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (frame.type === "error") {
          pending.reject(
            new AcpInternalError(
              typeof frame.errorText === "string" ? frame.errorText : `${pending.method} failed`,
              isRecord(frame.error) ? frame.error : undefined,
            ),
          );
        } else {
          pending.resolve(frame);
        }
        return;
      }
      const stream = this.prompts.get(id);
      if (stream) {
        this.onPromptFrame(stream, frame);
        return;
      }
    }
    // 轮收尾的上下文读数（prompt-pipeline 的 context_changed 自发帧）：缓存并
    // 通知监听者，用于 usage_update 推送
    if (frame.type === "context_changed" && typeof frame.sessionId === "string") {
      const used = typeof frame.usedTokens === "number" ? frame.usedTokens : 0;
      const size = typeof frame.contextWindow === "number" ? frame.contextWindow : 0;
      if (used > 0 && size > 0) {
        const usage = { used, size };
        this.contextUsage.set(frame.sessionId, usage);
        try {
          this.contextUsageListener?.(frame.sessionId, usage);
        } catch (err) {
          logErr("[acp] context usage listener failed:", err);
        }
      }
      return;
    }
    // 无 id 自发帧 / thread_event / sessions_changed 等：ACP 层不消费，忽略
  }

  private onPromptFrame(stream: PromptStream, frame: WireFrame): void {
    const chunk = frame.chunk;
    if (!chunk || typeof chunk !== "object") return;
    if (stream.finished) return;

    const type = typeof chunk.type === "string" ? chunk.type : "";
    if (type === "start") {
      stream.started = true;
    }
    if (type === "finish") {
      stream.finished = true;
      stream.chain = stream.chain
        .catch((err) => {
          logErr("[acp] prompt chunk handler failed:", err);
        })
        .then(() => {
          this.prompts.delete(stream.reqId);
          if (stream.error) stream.reject(stream.error);
          else stream.resolve({ stopReason: stream.cancelled ? "cancelled" : "end_turn" });
        });
      return;
    }
    if (type === "error") {
      const errorText =
        typeof chunk.errorText === "string" ? chunk.errorText : "pi agent error";
      stream.error = new AcpInternalError(
        errorText,
        isRecord(chunk.error) ? chunk.error : undefined,
      );
      // error chunk 之后可能还有 finish（runPromptTurn 兜底路径）；这里不立刻
      // 结束，等 finish 统一排空链后再 reject。启动前的错误（排队上限/准备失败）
      // 不会有 finish，才走 fallback 收尾。
      if (!stream.started) this.settlePromptIfNoFinishExpected(stream);
      return;
    }
    if (type === "abort") {
      stream.cancelled = true;
      return;
    }

    stream.chain = stream.chain
      .then(() => stream.onChunk(chunk))
      .catch((err) => {
        logErr("[acp] prompt chunk handler failed:", err);
      });
  }

  /**
   * 内部错误路径分两种：
   * - runPromptTurn 兜底：error chunk 后还会发 finish；
   * - dispatchPrompt 的队列上限拒绝：只发 error，不发 finish。
   * 后者如果一直等 finish 会挂住 ACP 请求。这里延迟一个微任务，若没有
   * finish 把流标记为结束并 reject；有 finish 时由 finish 分支接管。
   */
  private settlePromptIfNoFinishExpected(stream: PromptStream): void {
    const error = stream.error;
    if (!error) return;
    void Promise.resolve().then(() => {
      if (stream.finished) return;
      // 再等一个宏任务：finish 是同步紧跟 error 写的（同一事件循环）
      setTimeout(() => {
        if (stream.finished) return;
        stream.finished = true;
        stream.chain = stream.chain
          .catch(() => {})
          .then(() => {
            this.prompts.delete(stream.reqId);
            stream.reject(error);
          });
      }, 50).unref?.();
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
