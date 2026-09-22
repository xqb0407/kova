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
import type { PendingInteraction } from "pi-protocol";
import { piRequest, type PiSessionSummary } from "@/lib/pi/pi-bridge";
import { applyHistoryPending } from "@/lib/pi/pi-interactions";
import { clearManualCompactionMarkerForRemote } from "@/lib/pi/pi-compaction-marker";
import { findRunningTurn } from "@/lib/pi/pi-running";
import { getWorkspace } from "@/lib/workspace/workspace-store";

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

/**
 * 剥掉 composer 指令芯片的序列化文本（`:type[标签]{name=id}`，如
 * `:skill[anxin-ppt]{name=skill:anxin-ppt}`），整段替换为其标签——标题路径
 * 不该带这串格式噪音（芯片原文随 prompt 进转录，气泡端渲染回芯片，但
 * generateTitle/列表兜底拿的是原文）。正则与 cm-composer-input 的
 * DIRECTIVE_RE、侧车 stripDirectiveTokens 同源。
 */
const DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
const stripDirectiveTokens = (text: string) =>
  text
    .replace(DIRECTIVE_RE, (_m, _type, label: string) => label)
    .replace(/[ \t]{2,}/g, " ");

/** pi session -> 前端线程列表项 */
function toRemoteThread(s: PiSessionSummary) {
  return {
    remoteId: s.sessionId,
    externalId: undefined,
    status: (s.archived ? "archived" : "regular") as "archived" | "regular",
    title: s.name || stripDirectiveTokens(s.firstMessage).slice(0, 50) || "新会话",
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
  // 用户附件回放：file part → ThreadMessageLike.attachments（活动面板「引用文件」
  // 与消息区附件 chip 的数据源；不带的话刷新后附件消失）
  const fileParts =
    msg.role === "user"
      ? msg.parts.filter((p): p is Extract<UIMessage["parts"][number], { type: "file" }> => p.type === "file")
      : [];
  return {
    role: msg.role === "user" ? "user" : "assistant",
    content,
    ...(fileParts.length
      ? {
          attachments: fileParts.map((p, i) => ({
            id: `${msg.id}-att-${i}`,
            type: p.mediaType?.startsWith("image/") ? "image" : "document",
            name: p.filename ?? "附件",
            contentType: p.mediaType,
            status: { type: "complete" } as const,
            content: [
              {
                type: "file",
                data: p.url,
                mimeType: p.mediaType,
                ...(p.filename != null && { filename: p.filename }),
              },
            ],
          })),
        }
      : {}),
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

/** 首屏历史窗的消息行上限（§6）：2000+ 行转录只取尾部这么多条，
 *  更早历史暂不提供翻页入口（hasMore 已在应答里，接口就绪即可加）。 */
const HISTORY_TAIL_ROWS = 800;

/** 从 pi session 拉取历史，返回 UIMessage 列表（含 id）。
 * 防御：定时任务会话可能在转录还没落盘时被点开（轮初只补录用户消息、
 * 其余在 agent_end 才写），或索引说会话有消息而首查为空/失败 —— 这种
 * "点进去空空如也"最难自查，这里重试一次并留 [pi-history] 日志进 web.log。
 * M2：应答带未结算挂起交互（pending），按会话反查线程并入交互 store——
 * 刷新/重启后挂起卡随历史一起回来（§4 验收「刷新后审批卡恢复」）。 */
async function loadPiHistory(
  remoteId: string | undefined,
): Promise<UIMessage[]> {
  if (!remoteId) return [];
  const fetchOnce = async (): Promise<UIMessage[]> => {
    const res = await piRequest<{
      type: "history";
      messages: UIMessage[];
      pending?: PendingInteraction[];
    }>({
      type: "get_history",
      sessionId: remoteId,
      tail: HISTORY_TAIL_ROWS,
    });
    if (res.pending?.length) {
      const threadId = [...piSessionRegistry].find(([, s]) => s === remoteId)?.[0];
      if (threadId) applyHistoryPending(threadId, res.pending);
    }
    return res.messages;
  };
  let messages: UIMessage[] = [];
  try {
    messages = await fetchOnce();
  } catch (err) {
    console.warn("[pi-history] load failed", remoteId, String(err));
    await new Promise((r) => setTimeout(r, 400));
    try {
      messages = await fetchOnce();
    } catch (err2) {
      console.warn("[pi-history] retry failed", remoteId, String(err2));
    }
  }
  if (
    messages.length === 0 &&
    (piSessionPrefsMap.get(remoteId)?.messageCount ?? 0) > 0
  ) {
    // 索引有消息但首查为空：多半撞在落盘窗口，稍后重查一次
    console.warn("[pi-history] empty despite indexed messages", remoteId);
    await new Promise((r) => setTimeout(r, 400));
    try {
      messages = await fetchOnce();
    } catch (err) {
      console.warn("[pi-history] gap-fill retry failed", remoteId, String(err));
    }
  }
  // 压缩分隔线已由检查点行重建进历史消息流 → 手动压缩的尾部 marker 退役
  clearManualCompactionMarkerForRemote(remoteId);
  return messages;
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
      const rawFirstUser = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ");
      const firstUserText = stripDirectiveTokens(rawFirstUser).slice(0, 50);
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
          // 挂载即认领在飞轮次：定时任务的 turn 由 sidecar 发起，前端没有
          // 发送动作、也就没有流登记 —— 运行中点进来只会看到空历史（转录
          // 要到 agent_end 才整体落盘）。这里探一次 list_running：真在跑就
          // 重建登记，框架的 resume 效果订阅登记库，登记落定即自动重挂
          // 实时流（Rust 重放缓冲补齐已产出的 chunk），不再空窗到跑完。
          void findRunningTurn(remoteId);
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
