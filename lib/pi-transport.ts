"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { getPiChannel } from "@/lib/pi-channel";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";
import { getWorkspace } from "@/lib/workspace-store";
import { applyPlanningChunk } from "@/lib/pi-session-mode";
import { applyToolApprovalChunk, clearToolApprovals } from "@/lib/pi-tool-approval";
import { applyQuestionChunk, clearQuestions } from "@/lib/pi-question";
import { applyTodoChunk } from "@/lib/pi-todo";
import {
  applyQueueChunk,
  registerQueuedPrompt,
  unregisterQueuedPrompt,
} from "@/lib/pi-queue";
import { gitCheckpointCreate, gitCheckpointDiff } from "@/lib/git";
import { refreshGitStatus } from "@/lib/git-status";
import { clearRunCheckpoint, setRunCheckpoint } from "@/lib/pi-checkpoints";

/** already-processing 内部错误的友好文案（sidecar 队列已消除触发条件，
 *  这里兜底极窄竞态窗口漏网的，绝不把内部错误原文抛给用户） */
const BUSY_ERROR_TEXT = "上一条消息还在处理中，请稍候再发送";

/**
 * pi-agent 的 ChatTransport：把 assistant-ui 的 sendMessages 请求转为
 * 当前 PiChannel（桌面 Tauri invoke / 远程 WebSocket）上的 prompt 流。
 *
 * 事件链路（桌面）：promptStream → invoke("pi_prompt") → 子进程 stdin → stdout 行
 *   → Rust ~20ms 合帧转发 "pi-chunk-batch" 事件（行数组）
 *   → TauriPiChannel 逐行按 requestId 过滤为 UIMessageChunk。
 * 事件链路（远程）：promptStream → WS {"type":"prompt"} → 网关 → sidecar →
 *   网关按 id 路由回本连接 → WsPiChannel 分流为 UIMessageChunk。
 */
export class PiTransport implements ChatTransport<UIMessage> {
  async sendMessages({
    chatId,
    messages,
    abortSignal,
  }: {
    chatId: string;
    messages: UIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = `pi-${crypto.randomUUID()}`;
    // 取最后一条用户消息（regenerate 场景同样复用最后一条用户输入）
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text =
      lastUser?.parts
        .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n") ?? "";

    // chatId 是 runtime 内部 thread id；registry 里存着它对应的 pi session 文件路径
    // （重启后点击历史会话时也由 adapter 的 unstable_useAdapters 补齐映射）
    const sessionId = piSessionRegistry.get(chatId);

    // 排队条登记（requestId → 线程消息 id 映射）：sidecar 上一轮未结束时会把本请求
    // 排队并回 data-queue chunk；是否可见由 pi-queue 的确认态决定
    const messageId = lastUser?.id ?? "";
    registerQueuedPrompt({ requestId, threadId: chatId, messageId, text });

    // git 检查点（M2）：在影子仓库打快照，快照时机是本 turn 真正开始（start chunk）。
    // 排队的 prompt 不能在 sendMessages 时打快照——快照会落在上一轮编辑之前，
    // 回滚会误伤上一轮改动。非 git 目录/无 git/网页端静默跳过，失败绝不阻断对话。
    const cwd = getWorkspace();
    clearRunCheckpoint(chatId);
    let checkpointPromise: Promise<string | null> | null = null;
    let checkpointSettled = false;
    const createCheckpoint = () => {
      if (!cwd || checkpointPromise) return;
      // [checkpoint-debug] 临时日志，定位检查点条不出现的问题后删除
      console.warn("[checkpoint] create", JSON.stringify({ chatId, cwd }));
      checkpointPromise = gitCheckpointCreate(cwd, requestId).catch((err) => {
        console.warn("[checkpoint] create failed", String(err));
        return null;
      });
    };
    // 运行结束：diff 快照→当前，有改动才挂 keep/revert 操作条（fire-and-forget，
    // 不打断 chunk 流）；顺带失效 git 状态缓存（审查标签/分支徽标随之刷新）
    const settleCheckpoint = () => {
      if (checkpointSettled) return;
      checkpointSettled = true;
      if (!cwd || !checkpointPromise) return;
      void checkpointPromise.then((hash) => {
        if (!hash) return;
        // [checkpoint-debug] 临时日志，定位后删除
        console.warn("[checkpoint] settle", JSON.stringify({ chatId, hash }));
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
            setRunCheckpoint(chatId, {
              cwd,
              hash,
              files: d.files.length,
              added,
              removed,
            });
          })
          .catch(() => {});
      });
    };

    // 拦截 data-* 旁路 chunk 与检查点/收尾信号：模式/审批/提问/任务清单/排队
    // 走各自 store，不进消息流
    return getPiChannel()
      .promptStream({
        requestId,
        text,
        threadId: chatId,
        sessionId,
        cwd: getWorkspace() ?? undefined,
        abortSignal,
      })
      .pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
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
            if (chunk.type === "data-queue") {
              // 排队生命周期：queued（进排队条）→ active（开跑，移出排队条）
              applyQueueChunk(requestId, chatId, (chunk as { data?: unknown }).data);
              return;
            }
            if (chunk.type === "start") {
              // turn 真正开始（排队项此刻才轮到）：打检查点快照
              createCheckpoint();
            }
            if (chunk.type === "finish") {
              // turn 结束：清空残留审批/提问卡片（abort/异常路径的兜底出口）
              clearToolApprovals(chatId);
              clearQuestions(chatId);
              unregisterQueuedPrompt(requestId, chatId);
              settleCheckpoint();
            }
            if (chunk.type === "error") {
              // 异常收尾同样结算检查点：半途改动也需要 keep/revert 出口
              unregisterQueuedPrompt(requestId, chatId);
              settleCheckpoint();
            }
            if (chunk.type === "error" && typeof (chunk as { errorText?: unknown }).errorText === "string") {
              const errorText = (chunk as { errorText: string }).errorText;
              if (errorText.includes("Agent is already processing")) {
                chunk = { ...chunk, errorText: BUSY_ERROR_TEXT } as UIMessageChunk;
              }
            }
            controller.enqueue(chunk);
          },
        }),
      );
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // sidecar 场景没有可恢复的 HTTP 流
    return null;
  }
}
