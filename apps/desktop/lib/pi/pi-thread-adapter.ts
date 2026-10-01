"use client";

import { useEffect, useMemo } from "react";
import {
  useAui,
  unstable_createMessageConverter as createMessageConverter,
} from "@assistant-ui/react";
import type {
  ExportedMessageRepository,
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
import { claimKnownSession, isLocalDraftThreadId } from "@/lib/pi/pi-thread-identity";
import {
  fetchHistoryWindow,
  getHistoryWindowMeta,
  HISTORY_PAGE_ROWS,
  HISTORY_TAIL_ROWS,
  seedHistoryTurnTimings,
} from "@/lib/pi/pi-history-window";
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
    // 空 cwd（set_session_cwd 解绑）必须删旧镜像条目：只 set 不 delete 的话，
    // WorkspaceThreadSync 会拿着镜像里的旧目录在切回会话时写回胶囊（幽灵写回）
    if (s.cwd) piSessionCwdMap.set(s.sessionId, s.cwd);
    else piSessionCwdMap.delete(s.sessionId);
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
 * 请求应携带的 sidecar sessionId。registry 命中优先（两条链路本会话内创建的
 * 线程都靠它）；未命中时分两种：
 * - 框架本地草稿（__LOCALID_ 前缀）且未发送 → 尚无会话，返回 undefined。
 *   调用方必须跳过请求：threadId-only 地发给 resolveSession 会懒建空白会话，
 *   污染 running 键——真实会话的键一旦被空白 run 占住，后续 prompt 全落空会话
 *   （转录在盘但对话失忆，2026-10-01 迁移核对确认的危险链）；
 * - 其余 id 本身就是 sessionId（react-pi 新链路刷新后的行 id、旧链路恢复的
 *   线程行 id，二者都 = pi sessionId），直接返回。
 */
export function piSessionIdForThread(threadId: string): string | undefined {
  return piSessionRegistry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId);
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
    // id 必须显式带上：不带的话转换器会发 fallback id（__external_store_fallback_N），
    // 而往上翻页是分窗并入的——两窗各自从 0 起编号会撞号，repository 按 id 去重时
    // 会把整页消息丢掉。历史消息 id 是转录行 seq 基准（msg-<seq>），会话内唯一。
    id: msg.id,
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

/** 从 pi session 拉取历史，返回 UIMessage 列表（含 id）。
 * 防御：定时任务会话可能在转录还没落盘时被点开（轮初只补录用户消息、
 * 其余在 agent_end 才写），或索引说会话有消息而首查为空/失败 —— 这种
 * "点进去空空如也"最难自查，这里重试一次并留 [pi-history] 日志进 web.log。
 * M2：应答带未结算挂起交互（pending），按会话反查线程并入交互 store——
 * 刷新/重启后挂起卡随历史一起回来（§4 验收「刷新后审批卡恢复」）。
 * 分页（§6）：只取尾部窗口（HISTORY_TAIL_ROWS），firstSeq/hasMore 记进
 * 窗口表；更早的历史由滚到顶触发 loadOlderPiHistory 再取一窗。
 * localThreadId 用于给折叠摘要头的每轮耗时播种时间戳（缺失则本轮不显示耗时）。 */
async function loadPiHistory(
  remoteId: string | undefined,
  localThreadId?: string,
): Promise<UIMessage[]> {
  if (!remoteId) return [];
  const fetchOnce = async (): Promise<UIMessage[]> => {
    const window = await fetchHistoryWindow(remoteId, { tail: HISTORY_TAIL_ROWS });
    const pending = window.pending as PendingInteraction[] | undefined;
    if (pending?.length) {
      const threadId =
        (localThreadId && piSessionRegistry.get(localThreadId) === remoteId
          ? localThreadId
          : undefined) ??
        [...piSessionRegistry].find(([, s]) => s === remoteId)?.[0];
      if (threadId) applyHistoryPending(threadId, pending);
    }
    return window.messages as UIMessage[];
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
  // 首窗含会话开头（hasMore=false）时，开场 assistant 段也是完整一轮，照常播种
  seedHistoryTurnTimings(localThreadId, messages, {
    startsAtBeginning: getHistoryWindowMeta(remoteId)?.hasMore !== true,
  });
  // 压缩分隔线已由检查点行重建进历史消息流 → 手动压缩的尾部 marker 退役
  clearManualCompactionMarkerForRemote(remoteId);
  return messages;
}

/**
 * 往上翻一窗更早的历史（滚到顶触发，§6 懒加载）：beforeSeq=当前窗口 firstSeq
 * 再取一窗，prepend 进运行时消息流。
 *
 * 合并走框架的 export/import 往返（repository 里的 ThreadMessage 仍绑定着
 * 各自的原始 UIMessage，import → onImport → chat.setMessages 即把旧消息并进
 * 事实源），不用手工改 Chat 状态。旧消息由本模块自己的 converter 转换，
 * 与首屏装载同一条路径。
 *
 * 返回真正并入的消息条数（0 = 没有更早历史/入参缺失，调用方据此决定要不要再
 * 触发）。prepend 会改变总高度，调用方负责滚动位置补偿；这个条数也是下标锚定
 * 旁路态（检查点卡/压缩线）该平移的量——不能用"前后消息总数相减"，那样会把
 * 加载期间恰好新到的消息也算进去（平移过头）。
 */
export async function loadOlderPiHistory(
  aui: { thread: { export: () => ExportedMessageRepository; import: (r: ExportedMessageRepository) => void } },
  remoteId: string | undefined,
  localThreadId: string | undefined,
): Promise<number> {
  if (!remoteId) return 0;
  const meta = getHistoryWindowMeta(remoteId);
  // 没有游标或没有更早的行：无处可翻
  if (!meta || !meta.hasMore || meta.firstSeq === null) return 0;

  const window = await fetchHistoryWindow(remoteId, {
    beforeSeq: meta.firstSeq,
    tail: HISTORY_PAGE_ROWS,
  });
  if (window.messages.length === 0) return 0;
  // 本窗起点未必是会话开头：首条在轮中（assistant）时不播种残段
  seedHistoryTurnTimings(localThreadId, window.messages, {
    startsAtBeginning: window.meta.hasMore !== true,
  });
  const older = messagesToRepository(window.messages);
  const current = aui.thread.export();
  const merged: ExportedMessageRepository = {
    headId: current.headId ?? older.headId,
    messages: [
      ...older.messages,
      ...current.messages.map((item, index) =>
        // 旧窗前插：当前首条挂在旧窗末条之下，链条不断
        index === 0 && older.headId !== null
          ? { ...item, parentId: older.headId }
          : item,
      ),
    ],
  };
  aui.thread.import(merged);
  return older.messages.length;
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
  // 先认领再新建：registry 未命中 ≠ 新草稿。重载后恢复线程的 id 本身就是
  // sessionId，盲 new_session 会把用户正所在的会话劫持成全新空会话——后续
  // 消息落进空会话、AI 无上下文、工作区目录跟着换空（2026-09-28 会话丢失事故）
  const claimed = claimKnownSession(threadId);
  if (claimed) {
    piSessionRegistry.set(threadId, claimed);
    // Map 不是响应式的：认领落地同样广播（与 new_session 绑定路径同款），
    // 让按 sessionId 解析产物目录的视图（usePanelCwd）重取兜底 cwd
    window.dispatchEvent(new Event("pi:session-bound"));
    return Promise.resolve(claimed);
  }
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
        // Map 不是响应式的：会话登记落地时广播一声，
        // 让按 sessionId 解析产物目录的视图（usePanelCwd）重取兜底 cwd
        window.dispatchEvent(new Event("pi:session-bound"));
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
          load: async () =>
            messagesToRepository(await loadPiHistory(remoteId, state?.id)),
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
                linkMessages<TMessage>(await loadPiHistory(remoteId, state?.id)),
              append: async () => {
                // 持久化由 pi session 文件负责
              },
            };
          },
        }),
        [remoteId, state?.id],
      );

      return { history };
    },
  };
}
