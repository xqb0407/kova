"use client";

/**
 * 右侧面板的「辅助会话」标签视图。
 *
 * 与主会话共享同一个 PiClient，但用 usePinnedPiRuntime 挂一个**单线程**嵌套
 * runtime：threadId 固定为副屏子会话，threadList adapter 把 mainThreadId 钉在
 * 子会话上，Thread 树里所有按会话取状态的消费点都解析到副屏。不能走
 * usePiRuntime——useRemoteThreadListRuntime 的嵌套分支会退化成 no-op 的
 * external-store runtime（无线程列表、不支持切换）。
 *
 * 选区引用经 pending-quote 传入：等线程加载完成后写入 composer 的 quote，
 * 并复核写入没有被随后的初始化覆盖；不自动发送。
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
} from "react";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { MessageCircleIcon } from "lucide-react";
import { Thread } from "@/components/agent-thread/thread";
import { piRuntimeAdapters } from "@/lib/attachments/pi-attachment-adapter";
import { piRequest, type PiResponse } from "@/lib/pi/pi-bridge";
import { usePiClient } from "@/lib/pi/pi-client-context";
import {
  PinnedPiAuiBridge,
  usePinnedPiRuntime,
} from "@/lib/pi/pi-runtime";
import { reportPiRuntimeError } from "@/lib/pi/pi-runtime-errors";
import { hydrateThreadModel } from "@/lib/pi/pi-session-model";
import { fetchPlanningState } from "@/lib/pi/pi-session-mode";
import { hydrateThreadThinking } from "@/lib/pi/pi-session-thinking";
import { applySessionSummaries } from "@/lib/pi/pi-thread-adapter";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import {
  clearPendingSideChatQuote,
  peekPendingSideChatQuote,
  subscribePendingSideChatQuote,
  type PendingSideChatQuote,
} from "@/lib/side-chat/pending-quote";
import { SideChatScopeProvider } from "@/lib/side-chat/scope";
import { TabEmpty } from "./tab-empty";

/**
 * 选区引用写入 composer：订阅本副屏的 pending 引用（追加语义下，同一条副屏
 * 会被多次投喂），应用时与 composer 既有引用**合并**（\n\n 连接）——
 * 连着划多段文字攒进同一个引用块；写入后读回校验，最多重试几次，通过才清。
 * 线程刚加载完时 composer 可能被初始化重置，所以保留重试；一段引用重试
 * 耗尽后丢弃该段（保留 pending 会让后续合并越积越旧）。
 */
const MAX_QUOTE_ATTEMPTS = 6;

const PendingQuoteApplicator: FC<{ childSessionId: string }> = ({
  childSessionId,
}) => {
  const aui = useAui();
  const loading = useAuiState((s) => s.thread.isLoading);
  const subscribe = useCallback(
    (cb: () => void) => subscribePendingSideChatQuote(childSessionId, cb),
    [childSessionId],
  );
  const getSnapshot = useCallback(
    () => peekPendingSideChatQuote(childSessionId),
    [childSessionId],
  );
  const pendingQuote = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [attempt, setAttempt] = useState(0);
  const lastPendingRef = useRef<PendingSideChatQuote | undefined>(undefined);
  // 合并目标按 pending 身份缓存：重试/effect 双跑时不重算、不再拼一次
  const appliedRef = useRef<{
    pending: PendingSideChatQuote;
    text: string;
    messageId: string;
  } | null>(null);

  useEffect(() => {
    // 新引用到来（含合并产生的新对象）：重置重试计数，**当拍即进入应用**——
    // 这里若 return，计数已为 0 时 setAttempt 是 no-op，应用分支永远走不到
    //（表现为点「辅助会话」引用不出现）
    if (pendingQuote !== lastPendingRef.current) {
      lastPendingRef.current = pendingQuote;
      setAttempt(0);
    }
    if (loading || !pendingQuote) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        if (cancelled) return;
        try {
          const composer = aui.thread.composer();
          const existing = composer.getState().quote;
          // 幂等：composer 里已经是这段引用（重试重入 / StrictMode 双跑 /
          // 重复投递）→ 不合并、直接清 pending。否则同一段文本会被再拼一遍，
          // 表现为引用块内容重复。
          if (
            existing?.text &&
            (existing.text === pendingQuote.text ||
              existing.text.endsWith(`\n\n${pendingQuote.text}`))
          ) {
            clearPendingSideChatQuote(childSessionId);
            return;
          }
          // 合并目标按 pending 身份缓存：同一段引用的重试复用首次算出的目标，
          // 不会把已写入的内容二次合并
          const target =
            appliedRef.current?.pending === pendingQuote
              ? appliedRef.current
              : {
                  pending: pendingQuote,
                  text: existing?.text
                    ? `${existing.text}\n\n${pendingQuote.text}`
                    : pendingQuote.text,
                  messageId:
                    existing?.messageId ?? pendingQuote.messageId ?? "selection",
                };
          appliedRef.current = target;
          composer.setQuote({ text: target.text, messageId: target.messageId });
          if (composer.getState().quote?.text === target.text) {
            clearPendingSideChatQuote(childSessionId);
            return;
          }
        } catch {
          /* composer 尚未就绪：下一拍重试 */
        }
        if (attempt < MAX_QUOTE_ATTEMPTS) {
          setAttempt((n) => n + 1);
        } else {
          // 重试耗尽：丢弃这一段，避免 pending 越积越旧
          clearPendingSideChatQuote(childSessionId);
        }
      },
      attempt === 0 ? 0 : 80,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [aui, attempt, childSessionId, loading, pendingQuote]);
  return null;
};

const SideChatRuntime: FC<{
  childSessionId: string;
  parentSessionId: string;
  client: NonNullable<ReturnType<typeof usePiClient>>;
}> = ({ childSessionId, parentSessionId, client }) => {
  // 副屏隐藏了模型/思考选择器，水合入口（原本在 Picker 里）由这里补上：
  // 不水合的话发送闸门会回落到全局默认模型，而不是创建时继承的父会话选择。
  useEffect(() => {
    hydrateThreadModel(childSessionId);
    hydrateThreadThinking(childSessionId);
    // 模式胶囊也按子会话真值水合（读刚种进镜像的偏好 + 向 sidecar 拉权威态），
    // 否则显示全局默认档、与副屏实际的 agent 档不一致
    void fetchPlanningState(childSessionId);
  }, [childSessionId]);
  const { runtime, auiRef } = usePinnedPiRuntime({
    client,
    threadId: childSessionId,
    adapters: piRuntimeAdapters,
    onError: reportPiRuntimeError,
  });
  // 流式期间本组件高频重渲：scope value 必须稳定，否则副屏内的
  // SideChatScope 消费者（composer 收敛判断、划词入口隐藏）跟着全量重渲
  const scopeValue = useMemo(
    () => ({ parentSessionId, childSessionId }),
    [parentSessionId, childSessionId],
  );
  return (
    <SideChatScopeProvider value={scopeValue}>
      <AssistantRuntimeProvider runtime={runtime}>
        <PinnedPiAuiBridge auiRef={auiRef} />
        <PendingQuoteApplicator childSessionId={childSessionId} />
        <div className="flex h-full min-h-0 flex-col">
          {/* 副屏形态：无欢迎页/推荐，空会话即「引用预填 + 输入框」贴底 */}
          <Thread hideWelcome />
        </div>
      </AssistantRuntimeProvider>
    </SideChatScopeProvider>
  );
};

const SideChatAvailability: FC<{
  childSessionId: string;
  parentSessionId: string;
  client: NonNullable<ReturnType<typeof usePiClient>>;
}> = ({ childSessionId, parentSessionId, client }) => {
  const [missing, setMissing] = useState(false);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    let alive = true;
    // 轻量预检（单条 SQL）：子会话已被删除/清理时不要挂一个空 runtime 让用户
    // 对着空白面板猜；失败保持挂载，由嵌套 runtime 的 onError 正常呈现。
    // 摘要同时喂进前端偏好镜像：副屏不在 list_sessions 里，模型/思考档位的
    // 水合（hydrateThreadModel/Thinking）只能靠这里落库。
    void piRequest<Extract<PiResponse, { type: "session_summary" }>>(
      { type: "session_summary", sessionId: childSessionId },
      15_000,
    )
      .then((res) => {
        if (!alive) return;
        if (!res.summary) {
          setMissing(true);
          return;
        }
        applySessionSummaries([res.summary]);
        setSeeded(true);
      })
      .catch(() => {
        /* sidecar 不可用：照常挂载，交给运行时错误通道 */
        if (alive) setSeeded(true);
      });
    return () => {
      alive = false;
    };
  }, [childSessionId]);
  if (missing) {
    return (
      <TabEmpty
        icon={MessageCircleIcon}
        text="该辅助会话已不存在，请关闭此标签后重新划词"
      />
    );
  }
  if (!seeded) return null;
  return (
    <SideChatRuntime
      childSessionId={childSessionId}
      parentSessionId={parentSessionId}
      client={client}
    />
  );
};

const SideChatTabImpl: FC<{ tab: PanelTab }> = ({ tab }) => {
  const client = usePiClient();
  const childSessionId = tab.childSessionId;
  const parentSessionId = tab.parentSessionId;
  if (!client) {
    return (
      <TabEmpty
        icon={MessageCircleIcon}
        text="辅助会话需要主会话运行时，请先打开一个任务"
      />
    );
  }
  if (!childSessionId || !parentSessionId) {
    return (
      <TabEmpty
        icon={MessageCircleIcon}
        text="辅助会话缺少会话目标，请关闭此标签后重新划词"
      />
    );
  }
  return (
    <SideChatAvailability
      childSessionId={childSessionId}
      parentSessionId={parentSessionId}
      client={client}
    />
  );
};

export const SideChatTab = memo(SideChatTabImpl);
