"use client";

import { useEffect, useMemo } from "react";
import {
  useAui,
  unstable_createMessageConverter as createMessageConverter,
} from "@assistant-ui/react";
import type {
  RemoteThreadListAdapter,
  RuntimeAdapters,
  ThreadHistoryAdapter,
  ThreadMessage,
  MessageFormatAdapter,
  MessageFormatItem,
} from "@assistant-ui/core";
import type { UIMessage } from "ai";
import { piRequest, type PiSessionSummary } from "@/lib/pi-bridge";
import { clearManualCompactionMarkerForRemote } from "@/lib/pi-compaction-marker";
import { getWorkspace } from "@/lib/workspace-store";

/** local thread id -> pi sessionId（remoteId）。transport 发 prompt 时靠它找会话 */
export const piSessionRegistry = new Map<string, string>();

/** remoteId(pi session 文件路径) -> cwd。会话列表按 workspace 分组用 */
export const piSessionCwdMap = new Map<string, string>();

/** pi session -> 前端线程列表项 */
function toRemoteThread(s: PiSessionSummary) {
  return {
    remoteId: s.sessionId,
    externalId: undefined,
    status: "regular" as const,
    title: s.name || s.firstMessage.slice(0, 50) || "新会话",
    lastMessageAt: new Date(s.modified),
  };
}

const toTitle = (sessions: PiSessionSummary[]) =>
  sessions.map(toRemoteThread);

/** pi UIMessage -> assistant-ui ThreadMessage（text + data part 透传；reasoning/工具暂不回放） */
type ConverterPart =
  | { type: "text"; text: string }
  | { type: "data"; name: string; data: unknown };
const converter = createMessageConverter((msg: UIMessage) => {
  const content = msg.parts.flatMap((p): ConverterPart[] => {
    if (p.type === "text") return [{ type: "text", text: p.text }];
    // data-* part（压缩分隔线等）原样透传，交给 makeAssistantDataUI 注册的渲染器
    if (p.type.startsWith("data-")) {
      return [
        {
          type: "data",
          name: p.type.slice(5),
          data: (p as { data?: unknown }).data,
        },
      ];
    }
    return [];
  });
  return {
    role: msg.role === "user" ? "user" : "assistant",
    content,
  };
});

function messagesToRepository(uiMessages: unknown[]): {
  headId: string | null;
  messages: { parentId: string | null; message: ThreadMessage }[];
} {
  const threadMessages = converter.toThreadMessages(
    uiMessages as UIMessage[],
    false,
  );
  return {
    headId: threadMessages.at(-1)?.id ?? null,
    messages: threadMessages.map((message, i) => ({
      parentId: i === 0 ? null : threadMessages[i - 1].id,
      message,
    })),
  };
}

/** 从 pi session 拉取历史，返回 UIMessage 列表（含 id） */
async function loadPiHistory(
  remoteId: string | undefined,
): Promise<UIMessage[]> {
  if (!remoteId) return [];
  const res = await piRequest<{ type: "history"; messages: UIMessage[] }>({
    type: "get_history",
    sessionId: remoteId,
  });
  // 压缩分隔线已由检查点行重建进历史消息流 → 手动压缩的尾部 marker 退役
  clearManualCompactionMarkerForRemote(remoteId);
  return res.messages;
}

/** 把 sidecar 的 UIMessage[] 链成 { parentId, message } 仓库结构 */
function linkMessages<T>(messages: { id: string }[]): {
  headId: string | null;
  messages: MessageFormatItem<T>[];
} {
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message, i) => ({
      parentId: i === 0 ? null : messages[i - 1].id,
      message: message as T,
    })),
  };
}

export function createPiThreadListAdapter(): RemoteThreadListAdapter {
  return {
    async list() {
      const res = await piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
        type: "list_sessions",
      });
      for (const s of res.sessions) {
        if (s.cwd) piSessionCwdMap.set(s.sessionId, s.cwd);
      }
      return { threads: toTitle(res.sessions) };
    },

    async initialize(threadId: string) {
      const cwd = getWorkspace() ?? undefined;
      const res = await piRequest<{
        type: "session";
        sessionId: string;
        threadId: string;
      }>({ type: "new_session", threadId, cwd });
      piSessionRegistry.set(threadId, res.sessionId);
      if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
      return { remoteId: res.sessionId };
    },

    async fetch(threadId: string) {
      // threadId 可能是 local id（registry 里有映射）或直接的 remoteId
      const remoteId = piSessionRegistry.get(threadId) ?? threadId;
      return {
        remoteId,
        status: "regular" as const,
      };
    },

    async rename(remoteId: string, newTitle: string) {
      await piRequest({
        type: "rename_session",
        sessionId: remoteId,
        name: newTitle,
      });
    },

    async archive() {
      // pi 没有归档概念，空实现
    },
    async unarchive() {},

    async delete(remoteId: string) {
      await piRequest({ type: "delete_session", sessionId: remoteId });
      for (const [localId, sessionId] of piSessionRegistry) {
        if (sessionId === remoteId) piSessionRegistry.delete(localId);
      }
    },

    async generateTitle(remoteId, messages) {
      // MVP：用第一条用户消息做标题（pi 侧 firstMessage 已兜底，这里保持列表项同步）
      const { createAssistantStream } = await import("assistant-stream");
      void remoteId;
      const firstUserText = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .slice(0, 50);
      return createAssistantStream((controller) => {
        if (firstUserText) controller.appendText(firstUserText);
      });
    },

    /**
     * 每个挂载的线程调用一次；负责建立 localId -> remoteId 映射（供 transport 使用）
     * 并提供历史加载 adapter（切换/重启后回放 pi session 内容）。
     */
    unstable_useAdapters: (): RuntimeAdapters | null => {
      const item = useAui().threadListItem;
      const state = item?.getState?.() as
        | { id: string; remoteId?: string }
        | undefined;

      const remoteId = state?.remoteId;

      useEffect(() => {
        if (state?.id && remoteId) {
          piSessionRegistry.set(state.id, remoteId);
        }
      }, [state?.id, remoteId]);

      const history = useMemo<ThreadHistoryAdapter>(
        () => ({
          load: async () => messagesToRepository(await loadPiHistory(remoteId)),
          append: async () => {
            // 消息持久化由 pi session 文件负责，前端不重复存储
          },
          /**
           * useChatRuntime（内部 useAISDKRuntime）要求 withFormat：
           * 用调用方注入的 formatAdapter 处理 UIMessage 格式。
           */
          withFormat: <TMessage, TStorageFormat extends Record<string, unknown>>(
            formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
          ) => {
            void formatAdapter;
            return {
              load: async () =>
                linkMessages<TMessage>(await loadPiHistory(remoteId)),
              append: async () => {
                // 持久化由 pi session 文件负责
              },
            };
          },
        }),
        [remoteId],
      );

      return { history };
    },
  };
}
