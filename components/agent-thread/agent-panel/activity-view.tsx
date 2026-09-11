"use client";

import { useEffect, useRef, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ActivityIcon } from "lucide-react";
import { useThreadTodos } from "@/lib/pi-todo";
import { usePanelActivity } from "@/lib/panel-activity";
import { PlanSection } from "./plan-section";
import { FilesSection } from "./files-section";
import { TerminalSection } from "./terminal-section";

/**
 * "活动"标签:纵向汇总当前线程的 agent 工作——计划(todo 快照)/
 * 文件变更(edit/write 行级 diff)/ 终端(bash 流水)。
 * 数据全部派生自 runtime 消息(usePanelActivity)+ pi-todo store,
 * 实时流与历史重建同形,无 sidecar 改动。
 */
export const ActivityView: FC = () => {
  const activity = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const feedRef = useRef<HTMLDivElement>(null);

  const hasPlan = snap.tasks.some((t) => t.status !== "deleted");
  const isEmpty =
    activity.terminal.length === 0 && activity.files.length === 0 && !hasPlan;

  // 贴底跟脚:活动增量时若用户没上翻,滚动条跟随最新条目(同聊天区习惯)
  const activityCount =
    activity.terminal.length +
    activity.files.reduce((s, g) => s + g.entries.length, 0);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120)
      el.scrollTop = el.scrollHeight;
  }, [activityCount]);

  return (
    <div
      ref={feedRef}
      className="min-h-0 h-full overflow-y-auto overscroll-contain p-3"
    >
      <div className="flex flex-col gap-3">
        <PlanSection />
        <FilesSection groups={activity.files} />
        <TerminalSection entries={activity.terminal} />
        {isEmpty ? (
          <div className="text-muted-foreground/60 flex flex-col items-center gap-2 px-4 py-16 text-center text-xs">
            <ActivityIcon className="size-6" />
            <p>暂无活动</p>
            <p className="text-muted-foreground/50">
              agent 执行任务后,计划、文件变更与终端输出会汇总到这里
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
};
