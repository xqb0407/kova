"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { BotIcon, LoaderCircleIcon, SendHorizontalIcon } from "lucide-react";
import {
  sendSubagentMessage,
  subagentElapsedSeconds,
  useSubagentRun,
  type SubagentRunState,
} from "@/lib/subagent/subagent-runs";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import { SubagentConversation } from "./subagent-conversation";
import { TabEmpty } from "./tab-empty";

/**
 * 子智能体运行过程 tab：Task 委派行唤起的专属视图。
 * 顶部 RunHeader（agent 名/状态/用时/轮次）+ 对话列表（subagent-conversation
 * 按主会话语义把派活说明与插入消息排成 user 气泡、子智能体输出排成 AI 消息）
 * + 底部消息输入行（running=插话、finished=resume 续聊）。
 * 数据全在 lib/subagent-runs store，tab 只做投影。
 */

/** 委派终态中文短标签（与消息行 TaskToolUI 同一套词） */
const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  truncated: "轮次超限",
  aborted: "已中止",
  stopped: "已停止",
  interrupted: "已中断",
};

const RunHeader: FC<{ run: SubagentRunState }> = ({ run }) => {
  // 快照查无记录（sidecar 离线/记录被清）时不能装作还在跑：显示不可用，
  // 也不再起每秒计时器（defaultState 的 status 仍是 running）。
  const running = run.status === "running" && !run.expired;
  // 运行中每秒一拍刷新用时
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = subagentElapsedSeconds(run);
  const statusSuffix = run.expired
    ? "记录不可用"
    : running
      ? `工作中 ${elapsed} 秒`
      : [
          STATUS_LABEL[run.status] ?? run.status,
          run.startedAt && run.completedAt
            ? `${Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000))} 秒`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <div className="px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <BotIcon className="size-4 shrink-0" />
        <span className="truncate font-mono text-sm">{run.agentName || "子智能体"}</span>
        {running ? (
          <LoaderCircleIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : null}
        <span className="text-muted-foreground ml-auto shrink-0 text-xs">{statusSuffix}</span>
      </div>
      <p className="text-muted-foreground/70 mt-1 text-[11px] tabular-nums">
        {run.turns} 轮 · {run.toolCalls} 工具调用
      </p>
    </div>
  );
};

/** 对话页底部输入行：running=插话（下个边界消费），finished=resume 续聊 */
const MessageInputRow: FC<{ run: SubagentRunState }> = ({ run }) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const expired = run.expired;
  const running = run.status === "running";
  // 终态但没留下历史 = 续聊只会凭空重开（模型看不到之前做过什么），
  // 输入行禁用并说清原因，而不是发出去才在下面报错。
  const cannotResume = !running && !run.canResume;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await sendSubagentMessage(run.delegationId, body);
      setText("");
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const hint = running
    ? "发送后将在子智能体下一步送达"
    : "发送将以此会话的上下文继续运行";

  // 终态但无存档 / 记录已过期：不摆一个发不出去的输入框，直接说明无法续聊
  if (expired || (!running && cannotResume)) {
    return (
      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
        {expired
          ? "运行记录已过期，无法继续对话"
          : run.status === "interrupted"
            ? "运行被中断且上下文未存档，无法续聊；请重新派发子任务"
            : "此委派没有可续聊的存档历史；请重新派发子任务"}
      </div>
    );
  }

  return (
    <div className="border-t px-3 py-2">
      <div className="bg-muted/50 flex items-end gap-2 rounded-xl p-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
          rows={1}
          placeholder={hint}
          className="placeholder:text-muted-foreground/60 max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !text.trim()}
          title={hint}
          className="hover:bg-muted disabled:opacity-40 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed"
        >
          {sending ? (
            <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
          ) : (
            <SendHorizontalIcon className="text-muted-foreground size-4" />
          )}
        </button>
      </div>
      {error ? <p className="text-destructive mt-1 text-xs">{error}</p> : null}
    </div>
  );
};

export const SubagentTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const run = useSubagentRun(tab.delegationId);
  if (!run)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        载入运行过程…
      </div>
    );
  if (run.expired)
    return (
      <TabEmpty
        icon={BotIcon}
        text="运行记录已过期（sidecar 重启或超出保留上限），最终结果见会话中的任务输出"
      />
    );
  return (
    <div className="flex h-full flex-col">
      <RunHeader run={run} />
      <SubagentConversation run={run} />
      <MessageInputRow run={run} />
    </div>
  );
};
