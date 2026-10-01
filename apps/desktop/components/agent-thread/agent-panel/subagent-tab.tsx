"use client";

import { useEffect, useState, type FC } from "react";
import { BotIcon, LoaderCircleIcon } from "lucide-react";
import {
  subagentElapsedSeconds,
  useSubagentRun,
  type SubagentRunState,
} from "@/lib/subagent/subagent-runs";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import { SubagentConversation } from "./subagent-conversation";
import { TabEmpty } from "./tab-empty";

/**
 * 子智能体运行过程 tab：Task 委派行唤起的专属视图。
 * 顶部 RunHeader（agent 名/状态/用时/轮次）+ 下方对话列表（subagent-conversation
 * 按主会话语义把派活说明排成 user 气泡、子智能体输出排成 AI 消息）。
 * 数据全在 lib/subagent-runs store，tab 只做投影。
 */

/** 委派终态中文短标签（与消息行 TaskToolUI 同一套词） */
const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  truncated: "轮次超限",
  aborted: "已中止",
  stopped: "已停止",
};

const RunHeader: FC<{ run: SubagentRunState }> = ({ run }) => {
  const running = run.status === "running";
  // 运行中每秒一拍刷新用时
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = subagentElapsedSeconds(run);
  const statusSuffix = running
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
    <div className="border-b px-3 py-2.5">
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
    </div>
  );
};
