"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UIMessageChunk } from "ai";
import type { PiResponse } from "@/lib/pi-bridge";

/**
 * pi-agent 通道抽象：把"管理类请求-响应 + prompt 流式输出 + 全局中断"收口成接口。
 * - TauriPiChannel：桌面端，走 Tauri invoke/event（原 pi-bridge/pi-transport 逻辑平移）
 * - WsPiChannel：远程网页端，走 WebSocket（见 pi-ws-channel.ts）
 *
 * piRequest / createPiThreadListAdapter 通过模块级注册表（setPiChannel/getPiChannel）
 * 与具体通道解耦：运行时 provider 挂载前 set，之后所有调用原样工作在任一通道上。
 */

/** prompt 附件（用户图片 + 文档，随 prompt 下发 sidecar）。
 *  闸门在 sidecar（prompt-attachments.ts），前端在 addAttachment 时做同款前置校验 */
export type PiPromptAttachment = {
  name: string;
  mimeType: string;
  /** 图片与网页端文档：裸 base64 内联（注意请求体体积） */
  data?: string;
  /** 桌面端文档：经 Rust attachment_stage 落盘中转后的绝对路径（帧不带字节） */
  path?: string;
};

export type PromptStreamArgs = {
  /** 调用方生成（pi-${uuid}），sidecar 按 id 回发 chunk */
  requestId: string;
  text: string;
  threadId: string;
  sessionId?: string | null;
  cwd?: string | null;
  /** 用户消息里的图片附件（无附件省略；sidecar 闸门兜底） */
  attachments?: PiPromptAttachment[];
  /** 并入当前轮（steer）：sidecar 忙线程把消息注入活跃轮，本请求走退化流 */
  steer?: boolean;
  abortSignal?: AbortSignal;
  /**
   * finish chunk 到达时调用：返回 true 则本流保持打开（close 交由调用方择机
   * 触发，框架 status 不被打回 ready），返回 false/缺省立即关流。
   * 用于「被取消的排队项」：其流结束会把框架共享 status 打回 ready——正在跑
   * 的宿主轮在 UI 上假停止（ActionBar 闪现、Stop 因 activeResponse 被清空
   * 而失灵）。流保持挂起直到页面刷新；每取消一项泄漏一条挂起流（KB 级）。
   */
  holdOnFinish?: (close: () => void) => boolean;
};

export type AttachStreamArgs = {
  /** 发起时生成、由 resumable storage 记下的在飞 requestId */
  requestId: string;
  /** abort（用户在重挂后的流上点停止）时按线程中断 */
  threadId: string;
  abortSignal?: AbortSignal;
};

export type PiChannelStatus = {
  connected: boolean;
  error?: string;
};

/** 子代理运行状态（与 sidecar types.ts SubagentRunStatus 同构） */
export type SubagentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "truncated"
  | "aborted"
  | "stopped";

/**
 * 子代理运行活动条目（sidecar subagent_activity 通知行的 item 字段，
 * 与 sidecar/pi-agent/src/types.ts SubagentActivityItem 同构）。
 */
export type SubagentActivityItem =
  | { kind: "turn"; n: number; at: number }
  | { kind: "thinking"; op: "start" | "delta" | "end"; id: string; delta?: string; at: number }
  | { kind: "text"; op: "start" | "delta" | "end"; id: string; delta?: string; at: number }
  | {
      kind: "tool";
      op: "start" | "end";
      toolCallId: string;
      toolName: string;
      argsSummary?: string;
      resultSummary?: string;
      failed?: boolean;
      at: number;
    }
  | {
      kind: "status";
      status: SubagentRunStatus;
      turns: number;
      toolCalls: number;
      report?: string;
      at: number;
    };

/** list_running turns 明细项：一个确定在跑的轮次（会话 + 其 prompt requestId） */
export type PiRunningTurn = { sessionId: string; requestId: string };

/**
 * 定时任务自发通知帧（sidecar automation 调度器钩子发出，无 id；
 * 帧格式契约见 sidecar/pi-agent/src/protocol.ts 头注释"自发通知"节）。
 */
export type PiAutomationFrame =
  | {
      type: "automation_fired";
      taskId: string;
      taskName: string;
      taskType: string;
      runId: string;
      firedAt: string;
    }
  | {
      type: "automation_run_done";
      taskId: string;
      taskName: string;
      runId: string;
      ok: boolean;
      /** 本次运行新建的真实 agent 会话 id（调度错误路径可能缺省） */
      sessionId?: string;
      error?: string;
      finishedAt: string;
    };

/**
 * 插件耗时操作结果自发通知帧（sidecar plugins 分发 case 发出，无 id；
 * 受理 → plugin_op_accepted，完成 → plugin_op_result）。
 * 成功时携带刷新后的 plugins + marketplaces 双清单，前端 store 整包并入。
 */
export type PiPluginOpFrame = {
  type: "plugin_op_result";
  opId: string;
  op: "add_marketplace" | "refresh_marketplace" | "install_plugin";
  ok: boolean;
  errorText?: string;
  plugins?: import("@/lib/pi-bridge").PiPluginEntry[];
  marketplaces?: import("@/lib/pi-bridge").PiMarketplaceEntry[];
  workspaceCwd?: string | null;
};

export interface PiChannel {
  readonly kind: "tauri" | "ws";
  /** 管理类请求-响应；id 注入由实现负责（Tauri 侧 Rust 注入，WS 侧 JS 注入） */
  request(payload: Record<string, unknown>, timeoutMs?: number): Promise<PiResponse>;
  /** 发起 prompt，返回按 requestId 分流的 chunk 流（finish/error 关流） */
  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk>;
  /**
   * 能力可选：重挂进行中的 prompt 流（页面刷新恢复）。实现方负责重放
   * 本轮已产出的全部 chunk（含旁路 data-*）并继续直播到 finish/error。
   * 返回 null = 无在飞 run 或通道不支持（无可回放的服务端流）。
   *
   * 通道契约：凡是"webview/浏览器可长时间断开的本地常驻后端"都应实现它
   * （Tauri 经 Rust 重放缓冲；远程 WS 待网关 resume 路由后实现）。
   * 天然无法回放流式输出的推送型通道（微信/系统 app 通知等）不实现，
   * transport 自动降级为"轮不到重连 → 清记录回退历史加载"。
   */
  attachStream?(args: AttachStreamArgs): Promise<ReadableStream<UIMessageChunk> | null>;
  /**
   * 能力可选（与 listRunning 成对）：订阅"会话 turn 起止"事件流。
   * cb(sessionId, active)；sessionId = null 表示事件源失效（后端重启等），
   * 订阅方应清空集合并用 listRunning 重新水合。返回退订函数。
   * 时序契约：监听登记本身可能是异步的（Tauri listen 返回 Promise）。注册
   * 窗口里广播的 turn_changed 会永久丢失，而种子无法替它兜底（种子早于事件
   * 时就看不到），所以订阅方必须先 await 返回的退订函数就绪、再发起 listRunning
   * 种子——sidecar 对 turn_changed 与 list_running 响应按 stdout 全序写出，
   * "先订阅、后种子、种子只并入不清除"即可无漏合并。
   * 微信/系统 app 等推送型通道不实现，侧边栏运行指示降级为框架自带的
   * 仅挂载线程 isRunning。
   */
  subscribeTurns?(
    cb: (sessionId: string | null, active: boolean) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（与 subscribeTurns 同款无 id 通道）：订阅子代理活动通知行
   * （subagent_activity：delegate 的思考/正文增量、工具起止、轮次、结算终态）。
   * cb(delegationId, item)。WS 通道暂缺（网关不转发无 id 自发行）→ 缺省即降级：
   * 消息行绑定走 prompt 流 data-subagentDelegation、面板 tab 走快照补水合。
   */
  subscribeSubagentActivity?(
    cb: (delegationId: string, item: SubagentActivityItem) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅定时任务通知帧
   * （automation_fired / automation_run_done，见 PiAutomationFrame）。
   * WS 通道经网关白名单转发（remote.rs broadcast_notification）。
   */
  subscribeAutomationEvents?(
    cb: (frame: PiAutomationFrame) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅插件耗时操作结果帧
   * （plugin_op_result，见 PiPluginOpFrame）。
   * WS 通道经网关白名单转发（remote.rs broadcast_notification）。
   */
  subscribePluginOps?(
    cb: (frame: PiPluginOpFrame) => void,
  ): (() => void) | Promise<() => void>;
  /** 能力可选（与 subscribeTurns 成对）：当前正在跑 turn 的会话 id 种子清单 */
  listRunning?(): Promise<string[]>;
  /**
   * 能力可选（随 listRunning）：在跑轮次的 {sessionId, requestId} 明细。
   * 运行态事实源（sidecar activeTurns）经此透出请求 id——webview 存储被清/
   * 配额连带导致在飞流登记丢失时，前端据此重建登记并按 requestId attach，
   * 刷新续流不再依赖 sessionStorage 存活。旧后端应答缺 turns 时返回空清单
   * （登记重建降级为仅 localStorage 镜像/最近会话兜底）。
   */
  listRunningTurns?(): Promise<PiRunningTurn[]>;
  /** 中断指定线程的活跃 turn 与其排队消息（缺省 = 全局兜底，停掉一切） */
  abort(threadId?: string): Promise<void>;
  close?(): void;
  /** WS 通道连接状态回调；Tauri 通道恒连接，可不实现 */
  onStatusChange?(cb: (s: PiChannelStatus) => void): () => void;
}

// ---------- 模块级注册表 ----------

let current: PiChannel | null = null;

export function setPiChannel(ch: PiChannel | null) {
  current = ch;
}

/** 只读探测当前注册通道（无兜底副作用）：供卸载延迟销毁判断"注册表还是不是我" */
export function peekPiChannel(): PiChannel | null {
  return current;
}

export function getPiChannel(): PiChannel {
  // 兜底：未注册时惰性创建 Tauri 通道（保持桌面端现网行为）
  return (current ??= new TauriPiChannel());
}

// ---------- Tauri 通道 ----------

/** pi-chunk-batch 载荷的一行（见 pi_agent.rs ChunkLine）：i = run 内序号（非 chunk 行为 null），l = 原始 NDJSON 行 */
type ChunkWireLine = { i: number | null; l: string };

/** pi_attach 应答：重放快照 + 该 run 的存活/截断状态 */
type AttachReply = { active: boolean; truncated: boolean; lines: ChunkWireLine[] };

export class TauriPiChannel implements PiChannel {
  readonly kind = "tauri" as const;

  async request(
    payload: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<PiResponse> {
    const invokePromise = invoke<string>("pi_request", { payload }).then(
      (line) => JSON.parse(line) as PiResponse,
    );
    return Promise.race([
      invokePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pi-agent request timed out")), timeoutMs),
      ),
    ]);
  }

  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk> {
    const { requestId, text, threadId, sessionId, cwd, abortSignal } = args;

    let unlisten: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let closed = false;
    const cleanup = () => {
      unlisten?.();
      unlisten = null;
      unlistenExit?.();
      unlistenExit = null;
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        // 统一错误收尾：宿主级错误行与 sidecar 退出都以此终结本流
        const settleError = (errorText: string) => {
          if (closed) return;
          closed = true;
          controller.enqueue({ type: "error", errorText } as UIMessageChunk);
          cleanup();
          controller.close();
        };
        const handleLine = (raw: string) => {
          if (closed) return;
          let parsed: { id?: string | null; chunk?: UIMessageChunk };
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }
          if (!parsed.chunk) return;
          // 宿主级错误行（Rust CommandEvent::Error 发 id:null）：不属于任何
          // requestId，但 sidecar 管道出错后本流等不到收尾行——广播进所有
          // 打开的流，否则 UI 永久卡在运行态
          if (parsed.id === null) {
            if (parsed.chunk.type === "error") {
              const t = (parsed.chunk as { errorText?: unknown }).errorText;
              settleError(typeof t === "string" ? t : "pi-agent pipe error");
            }
            return;
          }
          if (parsed.id !== requestId) return;
          controller.enqueue(parsed.chunk);
          if (parsed.chunk.type === "finish" || parsed.chunk.type === "error") {
            // holdOnFinish：finish 可被调用方决定保持流打开（close 交还调用方），
            // 保证流结束不再把共享 status 打回 ready
            if (parsed.chunk.type === "finish" && args.holdOnFinish) {
              const close = () => {
                closed = true;
                cleanup();
                controller.close();
              };
              if (args.holdOnFinish(close)) return;
            }
            closed = true;
            cleanup();
            controller.close();
          }
        };

        // 先挂监听再发起 prompt，避免漏掉最早的 chunk。
        // 迭代 3：Rust 侧 ~20ms 合帧后以 pi-chunk-batch（带 i 序号的行对象数组）
        // 转发，逐行走原有过滤逻辑；收尾行之后的批次残余由 closed 挡板忽略。
        unlisten = await listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
          for (const wire of event.payload) handleLine(wire.l);
        });
        // sidecar 崩溃/退出：收尾行永远不会再来，pi-exit 是唯一真相——
        // 以错误终结本流，UI 从运行态解锁（subscribeTurns 只管侧边栏指示）
        unlistenExit = await listen("pi-exit", () =>
          settleError("pi-agent exited"),
        );
        // cancel 先于监听登记完成（快速点停止/切线程）：撤销刚挂上的监听、
        // 不再发起 prompt，防监听泄漏
        if (closed) {
          cleanup();
          return;
        }

        try {
          await invoke("pi_prompt", {
            requestId,
            text,
            threadId,
            sessionId,
            cwd,
            attachments: args.attachments ?? null,
            steer: args.steer === true,
          });
        } catch (err) {
          settleError(err instanceof Error ? err.message : String(err));
        }
      },
      cancel() {
        closed = true;
        cleanup();
      },
    });

    abortSignal?.addEventListener(
      "abort",
      () => {
        void invoke("pi_abort", { threadId }).catch(() => {});
      },
      { once: true },
    );

    return stream;
  }

  /**
   * 刷新重挂：Rust stdout 循环为每个在飞/刚收尾的 run 维护带 seq 的缓冲。
   * 时序——先挂监听（此后的直播行只暂存不消费），再 pi_attach 取快照，
   * 两路都按 seq 单调合并：监听与快照在时间上重叠的行天然幂等去重，
   * 快照覆盖不到、监听又错过的行不可能存在（监听先于快照建立）。
   * 快照含收尾行即刻关流（tombstone 场景：run 在页面关闭期间已结束，
   * 重放完整一轮后正常 finish，消息落定，不留"假流式"）。
   */
  async attachStream({
    requestId,
    threadId,
    abortSignal,
  }: AttachStreamArgs): Promise<ReadableStream<UIMessageChunk> | null> {
    let unlisten: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let closed = false;
    let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
    const cleanup = () => {
      unlisten?.();
      unlisten = null;
      unlistenExit?.();
      unlistenExit = null;
    };
    // 关流让消息落定（tombstone/sidecar 退出/异常兜底共用；闭包内引用避开
    // 外层 CFA 对 controller 的 null 收窄）
    const forceClose = () => {
      if (closed) return;
      closed = true;
      cleanup();
      controller?.close();
    };

    let lastSeq = 0;
    const future = new Map<number, UIMessageChunk>();
    const feed = (seq: number, raw: string) => {
      if (closed || seq <= lastSeq) return;
      let parsed: { id?: string | null; chunk?: UIMessageChunk };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      // 其他 run 的行不参与本流的 seq 空间（seq 按 requestId 独立递增）
      if (parsed.id !== requestId || !parsed.chunk) return;
      future.set(seq, parsed.chunk);
      let next = future.get(lastSeq + 1);
      while (next !== undefined && !closed) {
        future.delete(lastSeq + 1);
        lastSeq += 1;
        controller?.enqueue(next);
        if (next.type === "finish" || next.type === "error") {
          closed = true;
          cleanup();
          controller?.close();
          return;
        }
        next = future.get(lastSeq + 1);
      }
    };

    // 流先于监听与快照构造：controller 就绪后两路来源都可直接消费
    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        controller = c;
      },
      cancel() {
        closed = true;
        cleanup();
      },
    });

    unlisten = await listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        if (wire.i !== null && wire.i !== undefined) feed(wire.i, wire.l);
      }
    });
    // sidecar 退出：重放缓冲随进程作废、收尾行永不再来——关流让已重放
    // 的部分落定，不留永久挂起的假流
    unlistenExit = await listen("pi-exit", () => forceClose());
    // cancel 先于监听登记完成：撤销刚挂上的监听并放弃 attach
    if (closed) {
      cleanup();
      return null;
    }

    let reply: AttachReply;
    try {
      reply = await invoke<AttachReply>("pi_attach", { requestId });
    } catch {
      cleanup();
      return null;
    }
    // 无缓冲（run 不存在/超上限截断）：交回 transport 走"清记录回退历史"
    if (reply.truncated || (!reply.active && reply.lines.length === 0)) {
      cleanup();
      return null;
    }
    for (const wire of reply.lines) {
      if (wire.i !== null && wire.i !== undefined) feed(wire.i, wire.l);
    }
    // tombstone 但未见收尾行（sidecar 异常终止等理论竞态）：关流让消息落定
    if (!reply.active && !closed) forceClose();
    abortSignal?.addEventListener(
      "abort",
      () => {
        void invoke("pi_abort", { threadId }).catch(() => {});
      },
      { once: true },
    );
    return stream;
  }

  async abort(threadId?: string) {
    await invoke("pi_abort", { threadId }).catch(() => {});
  }

  async listRunning(): Promise<string[]> {
    const res = await this.request({ type: "list_running" });
    return res.type === "running" ? res.sessionIds : [];
  }

  async listRunningTurns(): Promise<PiRunningTurn[]> {
    const res = await this.request({ type: "list_running" });
    // 旧 sidecar 应答无 turns 字段：空清单 = 登记重建能力自动缺位
    const turns = res.type === "running" ? (res as { turns?: unknown }).turns : undefined;
    if (!Array.isArray(turns)) return [];
    return turns.filter(
      (t): t is PiRunningTurn =>
        !!t &&
        typeof (t as PiRunningTurn).sessionId === "string" &&
        typeof (t as PiRunningTurn).requestId === "string",
    );
  }

  /**
   * turn_changed 是 sidecar 自发通知行（无 id，不进请求配对/重放缓冲，
   * Rust 原样广播）；pi-exit 转成 (null,false)"事件源失效"信号，
   * 订阅方清空并重新水合（sidecar 重启后活跃轮次必然为空）。
   * async：两个 listen() 登记都就绪后才 resolve 退订函数——订阅方据此
   * "await 订阅 → 发种子"，杜绝登记窗口丢事件（见 PiChannel.subscribeTurns）。
   */
  async subscribeTurns(
    cb: (sessionId: string | null, active: boolean) => void,
  ): Promise<() => void> {
    const [unlistenBatch, unlistenExit] = await Promise.all([
      listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
        for (const wire of event.payload) {
          // 前缀预筛：热路径全是 {id,chunk} 行，免去逐行 JSON.parse
          if (!wire.l.startsWith('{"type":"turn_changed"')) continue;
          let parsed: { sessionId?: string; active?: boolean };
          try {
            parsed = JSON.parse(wire.l);
          } catch {
            continue;
          }
          if (typeof parsed.sessionId === "string") {
            cb(parsed.sessionId, parsed.active === true);
          }
        }
      }),
      listen("pi-exit", () => cb(null, false)),
    ]);
    return () => {
      unlistenBatch();
      unlistenExit();
    };
  }

  /**
   * subagent_activity 自发通知行（无 id，Rust 原样广播）：前缀预筛 + 逐行解析，
   * 与 subscribeTurns 同款热路径优化（token 级增量频率高，非活动行不 JSON.parse）。
   */
  async subscribeSubagentActivity(
    cb: (delegationId: string, item: SubagentActivityItem) => void,
  ): Promise<() => void> {
    return listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        if (!wire.l.startsWith('{"type":"subagent_activity"')) continue;
        let parsed: { delegationId?: string; item?: SubagentActivityItem };
        try {
          parsed = JSON.parse(wire.l);
        } catch {
          continue;
        }
        if (typeof parsed.delegationId === "string" && parsed.item) {
          cb(parsed.delegationId, parsed.item);
        }
      }
    });
  }

  /**
   * automation_fired / automation_run_done 自发通知帧（无 id，Rust 原样广播）：
   * 与 subscribeSubagentActivity 同款前缀预筛（触发频率低，但热路径原则一致）。
   */
  async subscribeAutomationEvents(
    cb: (frame: PiAutomationFrame) => void,
  ): Promise<() => void> {
    return listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        if (
          !wire.l.startsWith('{"type":"automation_fired"') &&
          !wire.l.startsWith('{"type":"automation_run_done"')
        ) {
          continue;
        }
        let parsed: PiAutomationFrame;
        try {
          parsed = JSON.parse(wire.l);
        } catch {
          continue;
        }
        if (
          (parsed?.type === "automation_fired" || parsed?.type === "automation_run_done") &&
          typeof parsed.taskId === "string"
        ) {
          cb(parsed);
        }
      }
    });
  }

  /**
   * plugin_op_result 自发通知帧（无 id，Rust 原样广播）：同款前缀预筛。
   * 插件市场的添加/刷新/安装均为耗时操作，受理后据此收敛。
   */
  async subscribePluginOps(cb: (frame: PiPluginOpFrame) => void): Promise<() => void> {
    return listen<ChunkWireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        if (!wire.l.startsWith('{"type":"plugin_op_result"')) continue;
        let parsed: PiPluginOpFrame;
        try {
          parsed = JSON.parse(wire.l);
        } catch {
          continue;
        }
        if (parsed?.type === "plugin_op_result" && typeof parsed.opId === "string") {
          cb(parsed);
        }
      }
    });
  }
}
