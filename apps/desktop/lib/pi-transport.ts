"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AssistantChatResumableOptions } from "@assistant-ui/ai-sdk";
import { getPiChannel } from "@/lib/pi-channel";
import { piEnsureThreadSession, piSessionRegistry } from "@/lib/pi-thread-adapter";
import { getWorkspace } from "@/lib/workspace-store";
import { applyPlanningChunk } from "@/lib/pi-session-mode";
import { applyToolApprovalChunk, clearToolApprovals } from "@/lib/pi-tool-approval";
import { applyQuestionChunk, clearQuestions } from "@/lib/pi-question";
import { applyTodoChunk } from "@/lib/pi-todo";
import {
  applyQueueStateChunk,
  getQueueSnapshot,
  notifyQueueStreamStart,
  optimisticallyRemoveQueuedMessage,
  refreshQueueSnapshot,
  registerQueuedMessage,
  unregisterQueuedMessage,
} from "@/lib/pi-queue";
import { consumeSteerIntent } from "@/lib/pi-steer-intent";
import { emitAgentEvent } from "@/lib/agent-events";
import { gitCheckpointCreate, gitCheckpointDiff } from "@/lib/git";
import { refreshGitStatus } from "@/lib/git-status";
import { refreshFileTree } from "@/lib/file-tree";
import {
  pushRunCheckpoint,
  saveRunHash,
  loadRunHash,
} from "@/lib/pi-checkpoints";
import { piResumableStorage } from "@/lib/pi-resume-storage";
import { recordLastThread } from "@/lib/pi-last-thread";
import { markThreadActivity } from "@/lib/pi-last-activity";
import { findRunningTurn, resyncPiRunning } from "@/lib/pi-running";
import { extractPromptAttachments } from "@/lib/prompt-attachments";
import { focusPanelTab } from "@/lib/panel-tabs";
import { applyDelegationChunk } from "@/lib/subagent-runs";

/** already-processing 内部错误的友好文案（sidecar 队列已消除触发条件，
 *  这里兜底极窄竞态窗口漏网的，绝不把内部错误原文抛给用户） */
const BUSY_ERROR_TEXT = "上一条消息还在处理中，请稍候再发送";

/** 收尾清登记：仅当 storage 里仍是本 requestId 时清除——连发排队/重挂竞态下
 *  后一轮可能已顶掉登记，不能按 chatId 盲清 */
function clearResumableIfOwn(chatId: string, requestId: string) {
  if (piResumableStorage.getStreamId(chatId) === requestId) {
    piResumableStorage.clear(chatId);
  }
}

// 引用（Quote）的模型侧注入：assistant-ui 发送时把引用存进 user 消息的
// metadata.custom.quote，渲染侧 MessagePrimitive.Quote 也从同一位置读回；
// 但官方把「引用文字喂给模型」放在服务端路由（injectQuoteContext），而本应用
// 的服务端是 pi-agent sidecar（协议只收 text），因此在传输层完成同样转换，
// 否则引用只在 UI 展示、模型上下文里根本没有这段文字。
// 历史侧代价：blockquote 随 text 落盘，重载后消息以 markdown blockquote 渲染，
// 与在飞消息的 QuoteBlock（metadata 驱动）样式略有差异——可接受。
function extractQuoteText(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const custom = (metadata as { custom?: unknown }).custom;
  if (!custom || typeof custom !== "object") return null;
  const text = (custom as { quote?: { text?: unknown } }).quote?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/**
 * pi-agent 的 ChatTransport：把 assistant-ui 的 sendMessages 请求转为
 * 当前 PiChannel（桌面 Tauri invoke / 远程 WebSocket）上的 prompt 流。
 *
 * 事件链路（桌面）：promptStream → invoke("pi_prompt") → 子进程 stdin → stdout 行
 *   → Rust ~20ms 合帧转发 "pi-chunk-batch" 事件（带 run 内 seq 的行对象数组）
 *   → TauriPiChannel 逐行按 requestId 过滤为 UIMessageChunk。
 * 事件链路（远程）：promptStream → WS {"type":"prompt"} → 网关 → sidecar →
 *   网关按 id 路由回本连接 → WsPiChannel 分流为 UIMessageChunk。
 *
 * 刷新恢复（桌面）：sendMessages 把 chatId → requestId 记入 sessionStorage 的
 * resumable storage（见 pi-resume-storage），Rust 侧同步缓冲该 run 的 chunk 行。
 * 页面刷新后框架在主线程挂载时自动走 chat.resumeStream() → reconnectToStream：
 * 经 channel.attachStream 重放本轮全部 chunk（含旁路 data-*）并续到收尾，
 * 旁路卡片/审批/检查点/通知与不刷新的收尾行为完全一致。通道不支持重挂
 * （远程 WS 待网关 resume；微信/app 推送型通道天然无流）则清记录回退历史加载。
 */
export class PiTransport implements ChatTransport<UIMessage> {
  /**
   * 本会话自行打开、尚未收尾的 prompt 流（requestId 集合）。排队消息激活前的
   * status 空窗（上一轮流收尾 → ready、新一轮首个内容 chunk 未到）里，框架的
   * 自动重挂 effect 会看到「storage 有在飞 id + chat 未在跑」而发起 resumeStream，
   * 把自己仍在消费的 run 再重放一遍——同一 run 双重消费：消息/分支成对出现
   * （2/2 分支选择器）、stop 只中止重挂流而原流继续。reconnectToStream 凭本
   * 集合拒绝这类重挂；真页面刷新后是新实例、集合为空，恢复不受影响。
   */
  private openRequestIds = new Set<string>();

  /** 线程真正在跑的 turn 集合（start chunk 到 finish/error 收尾）：镜像
   *  sidecar 的 isTurnBusy 忙位，供 sendMessages 判定「本条发送必然排队」
   *  并乐观摘除消息（消除快照往返窗口的闪现，见 pi-queue）。steer 退化流
   *  计入无妨（宿主轮本就忙），各自收尾时移除。 */
  private runningTurns = new Map<string, Set<string>>();

  private markTurnRunning(chatId: string, requestId: string, running: boolean): void {
    if (running) {
      let ids = this.runningTurns.get(chatId);
      if (!ids) {
        ids = new Set();
        this.runningTurns.set(chatId, ids);
      }
      ids.add(requestId);
    } else {
      const ids = this.runningTurns.get(chatId);
      if (!ids) return;
      ids.delete(requestId);
      if (ids.size === 0) this.runningTurns.delete(chatId);
    }
  }

  async sendMessages({
    chatId,
    messages,
    abortSignal,
    trigger,
  }: {
    chatId: string;
    messages: UIMessage[];
    abortSignal?: AbortSignal;
    trigger?: "submit-message" | "regenerate-message";
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = `pi-${crypto.randomUUID()}`;
    // 取最后一条用户消息（regenerate 场景同样复用最后一条用户输入）
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const bodyText =
      lastUser?.parts
        .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n") ?? "";
    // 有引用时（正文可为空，composer 允许仅引用发送）转 blockquote 前置，
    // 与 injectQuoteContext 同格式（逐行 "> " 前缀 + 空行分隔）
    const quoteText = extractQuoteText(lastUser?.metadata);
    const text = quoteText
      ? [
          quoteText.split(/\r?\n/).map((line) => `> ${line}`).join("\n"),
          bodyText,
        ]
          .filter(Boolean)
          .join("\n\n")
      : bodyText;

    // 排队条登记（requestId → 乐观 user 消息）+ 乐观摘除：放在 sendMessages
    // 首个 await 之前，与框架 pushMessage 同处一个微任务链——权威摘除要等
    // data-queue-state 快照往返（sidecar 回程 + ~20ms 合帧），期间乐观消息
    // 已被绘制，就是「闪一下」。忙镜像（在跑 turn / 快照非空，对应 sidecar
    // shouldQueue）判定必然排队时立刻同步摘除；摘早了（罕见竞态下 sidecar
    // 直接开跑）由 start chunk 的 notifyQueueStreamStart 回填，被拒绝由收尾
    // 回填，见 pi-queue 三条同步规则头注。
    // 重新生成（Reload）不登记：忙线程下 sidecar 照常排队（快照里无登记条目，
    // 不会触发摘除/回填），触发重跑的历史消息必须留在对话列表。
    // 「并入当前轮」意图（⌥/⌘⇧⌘）不摘：注入活跃轮，消息照常即时上列表
    const steerIntent = consumeSteerIntent(chatId);
    if (lastUser && trigger !== "regenerate-message") {
      registerQueuedMessage(requestId, chatId, lastUser);
      if (
        !steerIntent &&
        ((this.runningTurns.get(chatId)?.size ?? 0) > 0 ||
          getQueueSnapshot(chatId).items.length > 0)
      ) {
        optimisticallyRemoveQueuedMessage(requestId);
      }
    }

    // chatId 是 runtime 内部 thread id；registry 里存着它对应的 pi session 文件路径
    // （重启后点击历史会话时也由 adapter 的 unstable_useAdapters 补齐映射）。
    // 框架并不保证首条发送前先 await initialize（web.log 实证登记从来没带上
    // sessionId）——登记缺会话 id 则刷新后无人能认领、在飞流成孤儿，发送前主动 ensure。
    const cwd = getWorkspace() ?? undefined;
    const sessionId = piSessionRegistry.get(chatId) ?? (await piEnsureThreadSession(chatId, cwd));

    // 登记可恢复流：页面刷新后 reconnectToStream 凭此找回在飞 requestId；
    // finish/error 收尾时由 postTransform 清除。同线程连发时后一轮会顶掉
    // 前一轮的登记（requestId 一对一），收尾按 id 比对再清，防误删在飞登记。
    // sessionId 一并落盘：刷新后草稿 id 重随机认领不了登记，只有 id 即该会话
    // remoteId 的列表行能续流（见 pi-resume-storage）
    piResumableStorage.setStreamId(requestId, chatId, sessionId);
    // 刷新回切兜底：即使登记后续被清（收尾/降级），也记得回到这个会话
    recordLastThread(sessionId);
    // 本地活动时间戳：列表快照的 lastMessageAt 要等 reload 才更新，
    // 刚聊完的行凭它立刻显示「刚刚」（见 pi-last-activity）
    markThreadActivity(sessionId);
    // 新 turn 开始：上一轮未结算的持久 hash 桥作废。已结算的检查点卡
    // 按轮锚定在各消息尾部,不再被新 turn 清掉（见 pi-checkpoints 条目列表）
    saveRunHash(chatId, null);

    this.openRequestIds.add(requestId);
    // 检查点卡的轮次锚点：触发本轮的 user 消息下标（跨刷新稳定,见 pi-checkpoints）
    const anchorIndex = lastUser ? messages.indexOf(lastUser) : null;

    // 用户附件（多模态图片 + 文档中转）：user 消息的 file parts → 协议
    // attachments（data URL 解析 / blob fetch / 文档落盘中转，带线程 id 分目录）；
    // 无附件 = undefined，帧上不带字段
    const attachments = (await extractPromptAttachments(lastUser, chatId)) ?? undefined;

    // 流内状态：start chunk 是否已过（postTransform 置位）。holdOnFinish 凭它
    // 识别「从未开跑就被取消的排队项」——其流结束会把框架共享 status 打回
    // ready（宿主轮假停止、ActionBar 闪现、Stop 因 activeResponse 被清空而
    // 失灵），故保持流打开不结束
    const streamState = { started: false };

    return getPiChannel()
      .promptStream({
        requestId,
        text,
        threadId: chatId,
        sessionId,
        cwd,
        attachments,
        // 并入当前轮（⌥点击 / Shift+⌘+Enter 标记的意图，仅运行中会标记）：
        // sidecar 忙线程注入活跃轮，本请求走退化流收尾
        steer: steerIntent,
        abortSignal,
        holdOnFinish: () => !streamState.started,
      })
      .pipeThrough(
        this.postTransform(chatId, requestId, text, abortSignal, anchorIndex, streamState),
      );
  }

  /**
   * 刷新重挂（框架 resumable 流程调用）：storage 里有在飞 requestId 且通道
   * 支持 attach 时，返回重放 + 续传的统一 chunk 流；否则清记录返回 null，
   * 框架随即回落 ready 态（历史已由 adapter 正常加载）。
   */
  async reconnectToStream({
    chatId,
    abortSignal,
  }: {
    chatId: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    let requestId = piResumableStorage.getStreamId(chatId);
    // 本会话自己打开且仍在消费的流：自动重挂（排队激活空窗误触发，见
    // openRequestIds 注释）会重复消费同一 run，直接拒绝。不清登记——
    // 原流收尾前真页面刷新仍可凭它恢复
    if (requestId && this.openRequestIds.has(requestId)) {
      return null;
    }
    // 登记落空（storage 被清/配额连带）不直接放弃：查 sidecar 运行态真相，
    // chatId 恰为在跑会话的 remoteId 时重建登记（attach 靠 requestId，与
    // storage 无关）。查不到维持原语义：null → 框架回落 ready 态读历史。
    if (!requestId) {
      const turn = await findRunningTurn(chatId);
      requestId = turn?.requestId ?? null;
    }
    if (!requestId) return null;
    const channel = getPiChannel();
    if (!channel.attachStream) {
      clearResumableIfOwn(chatId, requestId);
      return null;
    }
    let attachId = requestId;
    // storage 命中的 requestId 是排队未跑项（忙时最后发送的排队消息）时，
    // attach 它只会挂起一条永不来数据的流（无重放、无直播可续——run 条目
    // 在 pi_prompt 建立即 active，但排队项派发前不会有任何 chunk 行）——
    // 聊天卡在假运行态：发送键变停止、列表空转、无输出，暂停的队列里
    // 尤其如此。先对齐一次队列快照再判别；命中则清登记，改续传运行态里
    // 真正正在跑的轮（暂停/空闲时没有 → 回落历史加载）
    await refreshQueueSnapshot(chatId, piSessionRegistry.get(chatId));
    if (getQueueSnapshot(chatId).items.some((item) => item.reqId === requestId)) {
      clearResumableIfOwn(chatId, requestId);
      const turn = await findRunningTurn(chatId);
      requestId = turn?.requestId ?? null;
      if (!requestId) return null;
    }
    let stream: ReadableStream<UIMessageChunk> | null = null;
    try {
      stream = await channel.attachStream({ requestId, threadId: chatId, abortSignal });
    } catch {
      stream = null;
    }
    if (!stream) {
      // 无缓冲（run 已结束且被清扫 / 超限截断 / 通道异常）：回退历史加载
      clearResumableIfOwn(chatId, requestId);
      return null;
    }
    // 重挂复用同一条后处理管线：旁路卡片、检查点结算、收尾通知全部补齐；
    // 原始 prompt 文本不跨刷新持久化，事件提醒的 prompt 预览留空
    return stream.pipeThrough(this.postTransform(chatId, requestId, "", abortSignal, null));
  }

  /**
   * 框架自动 resume 的挂钩（见 @assistant-ui/ai-sdk useChatThread）：主线程
   * 挂载后若 storage 有待恢复 streamId 且聊天未在跑，自动调 reconnectToStream。
   * resumeApi 仅内置 AssistantChatTransport 使用，自定义通道下留空占位。
   */
  getResumableAdapter(): AssistantChatResumableOptions {
    return { storage: piResumableStorage, resumeApi: "" };
  }

  /**
   * 新旧流共用的 chunk 后处理管线（sendMessages / reconnectToStream）：
   * 拦截 data-* 旁路 chunk 进各自 store、git 检查点（M2）创建与结算、
   * 排队条生命周期、事件提醒与 resumable 登记收尾。绝不把内部错误原文抛给用户。
   */
  private postTransform(
    chatId: string,
    requestId: string,
    text: string,
    abortSignal: AbortSignal | undefined,
    anchorIndex: number | null,
    streamState: { started: boolean } = { started: false },
  ): TransformStream<UIMessageChunk, UIMessageChunk> {
    // transform 回调里 this 指向 Transformer 而非 PiTransport，经闭包引用
    const transport = this;
    // git 检查点（M2）：在影子仓库打快照，快照时机是本 turn 真正开始（start chunk）。
    // 排队的 prompt 不能在 sendMessages 时打快照——快照会落在上一轮编辑之前，
    // 回滚会误伤上一轮改动。非 git 目录/无 git/网页端静默跳过，失败绝不阻断对话。
    const cwd = getWorkspace();
    let checkpointPromise: Promise<string | null> | null = null;
    let checkpointSettled = false;
    // 结算锚点：默认取本轮触发消息下标；刷新重挂时从持久化 hash 桥恢复
    let anchor = anchorIndex;
    // 事件提醒：error 置位后 finish 不再补发"任务完成"（同轮只提醒一次）
    let sawError = false;
    // Stop/promote 中止的 turn：sidecar 在 finish 前发 abort 标记——残缺回复
    // 按「被结束」结算，不弹完成提醒
    let sawAborted = false;
    // 并入当前轮（steer 退化流 data-queue(steered) → start → finish）：
    // 本请求没跑 turn，turn 级副作用全部跳过（活跃轮还 owns 它们——审批/
    // 提问卡片、检查点快照、完成提醒）
    let sawSteered = false;
    const createCheckpoint = () => {
      if (!cwd || checkpointPromise) return;
      // 刷新重挂路径：原页面已打过快照并把 hash 持久化（saveRunHash），
      // 复用而非重打——新快照会漏掉"原页面开始 → 刷新"之间的改动
      const persisted = loadRunHash(chatId);
      if (persisted && persisted.cwd === cwd) {
        anchor = persisted.anchorIndex ?? anchor;
        checkpointPromise = Promise.resolve(persisted.hash);
        return;
      }
      checkpointPromise = gitCheckpointCreate(cwd, requestId)
        .then((hash) => {
          if (hash) saveRunHash(chatId, { cwd, hash, anchorIndex: anchor });
          return hash;
        })
        .catch((err) => {
          console.warn("[checkpoint] create failed", String(err));
          return null;
        });
    };
    // 运行结束：diff 快照→当前，有改动才挂 keep/revert 操作条（fire-and-forget，
    // 不打断 chunk 流）；顺带失效 git 状态缓存（审查标签/分支徽标随之刷新）
    const settleCheckpoint = () => {
      if (checkpointSettled) return;
      checkpointSettled = true;
      saveRunHash(chatId, null);
      if (!cwd || !checkpointPromise) return;
      void checkpointPromise.then((hash) => {
        if (!hash) return;
        refreshGitStatus(cwd);
        return gitCheckpointDiff(cwd, hash)
          .then((d) => {
            if (!d || d.files.length === 0) return;
            let added = 0;
            let removed = 0;
            for (const f of d.files) {
              added += f.added;
              removed += f.removed;
            }
            pushRunCheckpoint(chatId, anchor, {
              cwd,
              hash,
              files: d.files.length,
              added,
              removed,
            });
          })
          // 结算失败不弹窗打断对话,但必须留痕:静默吞错会让"卡去哪了"无从排查
          .catch((err) => console.warn("[checkpoint] settle diff failed", String(err)));
      });
    };

    // 客户端中止（Stop 会 abort 最后一次请求的流，排队流的收尾 chunk 因此到不了
    // 消费端）：登记清理在此补齐。若该项确认排队且从未开跑，pi-queue 会经
    // onReveal 把摘除的消息回填恢复（Stop 后消息气泡回到列表、排队条同步消失）
    abortSignal?.addEventListener(
      "abort",
      () => {
        this.openRequestIds.delete(requestId);
        this.markTurnRunning(chatId, requestId, false);
        unregisterQueuedMessage(requestId, chatId);
      },
      { once: true },
    );

    return new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "data-planningState") {
          applyPlanningChunk(chatId, (chunk as { data?: unknown }).data);
          return;
        }
        if (chunk.type === "data-toolApproval") {
          applyToolApprovalChunk(chatId, (chunk as { data?: unknown }).data);
          return;
        }
        if (chunk.type === "data-question") {
          applyQuestionChunk(chatId, (chunk as { data?: unknown }).data);
          return;
        }
        if (chunk.type === "data-todo") {
          // 任务清单快照：走 per-thread store 刷新 composer 上方面板
          applyTodoChunk(chatId, (chunk as { data?: unknown }).data);
          return;
        }
        if (chunk.type === "data-subagentDelegation") {
          // Task 委派绑定（toolCallId ↔ delegationId）：进子智能体运行 store，
          // 消息行据此渲染状态并开面板 tab；刷新重放同 id 幂等覆盖
          applyDelegationChunk((chunk as { data?: unknown }).data);
          return;
        }
        if (chunk.type === "data-queue-state") {
          // 排队权威状态：全量快照，最后一条胜出（pi-queue 快照镜像）
          applyQueueStateChunk(chatId, chunk.data);
          return;
        }
        if (chunk.type === "data-queue") {
          // 流级信号（权威状态见 data-queue-state）：steered = 本请求已并入
          // 活跃轮（退化流标记，决定收尾分支）
          const phase = (chunk as { data?: { phase?: string } }).data?.phase;
          if (phase === "steered") sawSteered = true;
          return;
        }
        if (chunk.type === "data-panelOpen") {
          // agent 动作的面板唤起：目标 tab 推到前台并展开收起的面板
          // （browser_* / open_file 发起；focusPanelTab 复用既有 tab）
          const d = (chunk as {
            data?: { type?: unknown; url?: unknown; path?: unknown; cwd?: unknown };
          }).data;
          if (d && d.type === "browser") {
            const url = typeof d.url === "string" && d.url ? { url: d.url } : undefined;
            focusPanelTab("browser", url);
            window.dispatchEvent(new Event("agent-panel:open"));
            return;
          }
          // 文件唤起（sidecar open-file-tool.ts）：文件 tab 磁盘实时模式；
          // focus:undefined 清掉该 tab 可能残留的 read/plan 快照上下文（文件树同款）
          if (d && d.type === "file" && typeof d.path === "string" && d.path) {
            focusPanelTab("file", {
              cwd: typeof d.cwd === "string" && d.cwd ? d.cwd : undefined,
              path: d.path,
              focus: undefined,
            });
            window.dispatchEvent(new Event("agent-panel:open"));
          }
          return;
        }
        if (chunk.type === "abort") {
          // 中止标记（Stop/promote 的残缺收尾）：透传给 Chat 结算为 aborted
          sawAborted = true;
        }
        if (chunk.type === "start") {
          // turn 真正开始（排队项此刻才轮到）：打检查点快照。
          // steer 退化流的 start 不是 turn 开始：不打（活跃轮已有自己的快照）
          streamState.started = true;
          // 忙镜像置位 + 乐观摘除纠偏：若本请求曾被乐观摘除但从未入过快照
          // （sidecar 竞态下直接放行），此刻回填；真排队项出快照已回填，no-op
          transport.markTurnRunning(chatId, requestId, true);
          notifyQueueStreamStart(requestId);
          if (!sawSteered) createCheckpoint();
        }
        if (chunk.type === "finish") {
          // 流收尾：本会话打开流集合摘除（自动重挂去重依赖其准确性）
          transport.openRequestIds.delete(requestId);
          transport.markTurnRunning(chatId, requestId, false);
          if (sawSteered) {
            // steer 退化收尾：活跃轮还在跑，只清自己的登记（排队条隐藏项、
            // resumable 登记），不碰审批/提问卡片、不发完成提醒
            unregisterQueuedMessage(requestId, chatId);
            clearResumableIfOwn(chatId, requestId);
            controller.enqueue(chunk);
            return;
          }
          // turn 结束：清空残留审批/提问卡片（abort/异常路径的兜底出口）
          clearToolApprovals(chatId);
          clearQuestions(chatId);
          unregisterQueuedMessage(requestId, chatId);
          clearResumableIfOwn(chatId, requestId);
          // 本轮 turn 确定结束：趁势对齐一次侧边栏运行集合（纠偏缺了收尾的残留项）
          resyncPiRunning();
          // 文件树失效与检查点解耦：非 git 工作区 agent 也在改盘上文件
          refreshFileTree(cwd ?? null);
          settleCheckpoint();
          // 用户主动 abort 的收尾不算"完成"，不提醒（含 promote 对上一轮的
          // 强制结束——新 turn 的完成由它自己的流提醒）
          if (!sawError && !sawAborted && !abortSignal?.aborted) {
            emitAgentEvent("agent.turn.completed", {
              threadId: chatId,
              data: { prompt: text.slice(0, 120) },
            });
          }
        }
        if (chunk.type === "error") {
          // 异常收尾同样结算检查点：半途改动也需要 keep/revert 出口；
          // 挂起提问与 finish 同款清空（abort 拆流时 finish 可能到不了）
          transport.openRequestIds.delete(requestId);
          unregisterQueuedMessage(requestId, chatId);
          clearResumableIfOwn(chatId, requestId);
          resyncPiRunning();
          refreshFileTree(cwd ?? null);
          settleCheckpoint();
          clearQuestions(chatId);
          transport.markTurnRunning(chatId, requestId, false);
          sawError = true;
          if (!abortSignal?.aborted) {
            const raw = (chunk as { errorText?: unknown }).errorText;
            let message = typeof raw === "string" ? raw.slice(0, 200) : undefined;
            if (message?.includes("Agent is already processing")) {
              message = BUSY_ERROR_TEXT;
            }
            emitAgentEvent("agent.turn.error", {
              threadId: chatId,
              data: { message, prompt: text.slice(0, 120) },
            });
          }
        }
        if (chunk.type === "error" && typeof (chunk as { errorText?: unknown }).errorText === "string") {
          const errorText = (chunk as { errorText: string }).errorText;
          if (errorText.includes("Agent is already processing")) {
            chunk = { ...chunk, errorText: BUSY_ERROR_TEXT } as UIMessageChunk;
          }
        }
        controller.enqueue(chunk);
      },
    });
  }
}
