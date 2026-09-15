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

/** sessionId -> 最近一次列表快照（含会话级偏好 mode/approvalLevel/model）。
 *  mode/model picker 切回会话时据此水合，不依赖 sidecar 内存里的 Running 实例存活 */
export const piSessionPrefsMap = new Map<string, PiSessionSummary>();

/** 把 list_sessions 的快照落进内存映射（cwd 分组 + 偏好水合共用） */
export function applySessionSummaries(sessions: PiSessionSummary[]): void {
  for (const s of sessions) {
    if (s.cwd) piSessionCwdMap.set(s.sessionId, s.cwd);
    piSessionPrefsMap.set(s.sessionId, s);
  }
}

/** 重新拉一份会话列表快照（轻量单条 SQL）：set_model / set_mode 后校准偏好镜像 */
export async function refreshSessionPrefs(): Promise<void> {
  try {
    const res = await piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
      type: "list_sessions",
    });
    applySessionSummaries(res.sessions);
  } catch {
    // sidecar 不可用：保留现状
  }
}

/** threadId 对应的偏好查找键：registry 命中用映射值；否则 threadId 本身
 *  可能就是 sessionId（刷新后恢复的线程行 id=sessionId） */
export function prefsSessionIdFor(threadId: string): string | undefined {
  return piSessionRegistry.get(threadId) ?? (piSessionPrefsMap.has(threadId) ? threadId : undefined);
}

/** pi session -> 前端线程列表项 */
function toRemoteThread(s: PiSessionSummary) {
  return {
    remoteId: s.sessionId,
    externalId: undefined,
    status: (s.archived ? "archived" : "regular") as "archived" | "regular",
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

/**
 * 分支对话：sidecar 把源会话转录复制成一个全新 pi 会话（新 sessionId、
 * 标题加「（分支）」后缀），返回新 remoteId；调用方随后
 * threads.reload() + switchToThread(newRemoteId) 打开分支。
 * cwd 映射本地先登记，让列表刷新前分组归属就已正确。
 */
export async function forkPiSession(remoteId: string): Promise<string> {
  const res = await piRequest<{ type: "forked"; sessionId: string }>({
    type: "fork_session",
    sessionId: remoteId,
  });
  const cwd = piSessionCwdMap.get(remoteId);
  if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
  return res.sessionId;
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

/** 进行中的 ensure 请求（threadId → promise）：并发重入合一，防双 new_session */
const pendingThreadSession = new Map<string, Promise<string>>();

/**
 * 线程 local id → pi 会话绑定的显式确保（幂等 + 并发去重）。
 * 框架对"首条发送前一定先跑过 adapter.initialize"没有保证（web.log 实证：
 * 登记里 sessionId 从来没出现过），而 transport 的在飞流登记必须带上会话
 * id——否则刷新后没有任何列表行能认领登记，在飞流成孤儿。发送前主动 ensure。
 */
export function piEnsureThreadSession(threadId: string, cwd?: string): Promise<string> {
  const existing = piSessionRegistry.get(threadId);
  if (existing) return Promise.resolve(existing);
  let p = pendingThreadSession.get(threadId);
  if (!p) {
    p = piRequest<{ type: "session"; sessionId: string; threadId: string }>({
      type: "new_session",
      threadId,
      cwd,
    })
      .then((res) => {
        piSessionRegistry.set(threadId, res.sessionId);
        if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
        return res.sessionId;
      })
      .finally(() => {
        pendingThreadSession.delete(threadId);
      });
    pendingThreadSession.set(threadId, p);
  }
  return p;
}

export function createPiThreadListAdapter(): RemoteThreadListAdapter {
  return {
    async list() {
      const res = await piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
        type: "list_sessions",
      });
      applySessionSummaries(res.sessions);
      return { threads: toTitle(res.sessions) };
    },

    async initialize(threadId: string) {
      const remoteId = await piEnsureThreadSession(threadId, getWorkspace() ?? undefined);
      return { remoteId };
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

    async archive(remoteId: string) {
      // 归档 = 索引行打标（archived 列），正文与 JSONL 不动；运行时乐观更新列表
      await piRequest({ type: "archive_session", sessionId: remoteId, archived: true });
    },
    async unarchive(remoteId: string) {
      await piRequest({ type: "archive_session", sessionId: remoteId, archived: false });
    },

    async delete(remoteId: string) {
      await piRequest({ type: "delete_session", sessionId: remoteId });
      for (const [localId, sessionId] of piSessionRegistry) {
        if (sessionId === remoteId) piSessionRegistry.delete(localId);
      }
      // cwd 归属表同步清理：不留已删会话的陈旧条目
      piSessionCwdMap.delete(remoteId);
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
