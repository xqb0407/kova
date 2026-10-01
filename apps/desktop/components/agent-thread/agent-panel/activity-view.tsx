"use client";

import { useEffect, useRef, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ActivityIcon } from "lucide-react";
import { useThreadTodos } from "@/lib/pi/pi-todo";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import { PlanSection } from "./plan-section";
import { FilesSection } from "./files-section";
import { TerminalSection } from "./terminal-section";
import { ReferencesSection } from "./references-section";
import { AttachmentsSection } from "./attachments-section";
import { CompactionSection, useThreadCompactionSummaries } from "./compaction-section";
import { useThreadAttachments } from "@/lib/attachments/thread-attachments";

/**
 * "活动"标签:纵向汇总当前线程的 agent 工作——计划(todo 快照)/
 * 文件变更(edit/write 行级 diff)/ 终端(bash 流水)/ 引用资料(WebSearch 汇总)/
 * 引用文件(用户上传的附件汇总)/ 压缩摘要(上下文压缩的 summary 汇总,
 * 消息流里只留分隔线 marker)。
 * 数据全部派生自 runtime 消息(usePanelActivity)+ pi-todo store,
 * 实时流与历史重建同形,无 sidecar 改动。
 * focusToolCallId:bash 工具行点击定位（展开并滚到那条命令）——
 * 命令记录没有独立标签，汇总视图就是唯一出口。
 */
export const ActivityView: FC<{ focusToolCallId?: string }> = ({
  focusToolCallId,
}) => {
  const activity = usePanelActivity();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const attachments = useThreadAttachments();
  const compactions = useThreadCompactionSummaries();
  const feedRef = useRef<HTMLDivElement>(null);

  const hasPlan = snap.tasks.some((t) => t.status !== "deleted");
  const isEmpty =
    activity.terminal.length === 0 &&
    activity.files.length === 0 &&
    activity.citations.length === 0 &&
    attachments.length === 0 &&
    compactions.length === 0 &&
    !hasPlan;

  // 贴底跟脚:活动增量时若用户没上翻,滚动条跟随最新条目(同聊天区习惯)
  const activityCount =
    activity.terminal.length +
    activity.citations.length +
    activity.files.reduce((s, g) => s + g.entries.length, 0);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120)
      el.scrollTop = el.scrollHeight;
  }, [activityCount]);

  return (
    // 滚动容器自身不带内边距，p-3 放进随内容滚动的内层：
    // 容器带 pt 时那 12px 会永远隔在吸顶头与滚动口上沿之间（见 git-view 同款注释）
    <div
      ref={feedRef}
      className="min-h-0 h-full overflow-y-auto overscroll-contain"
    >
      <div className="flex flex-col gap-3 p-3">
        <PlanSection />
        <FilesSection groups={activity.files} scrollRoot={feedRef} />
        <TerminalSection
          entries={activity.terminal}
          focusToolCallId={focusToolCallId}
          scrollRoot={feedRef}
        />
        <ReferencesSection items={activity.citations} scrollRoot={feedRef} />
        <AttachmentsSection scrollRoot={feedRef} />
        <CompactionSection scrollRoot={feedRef} />
        {isEmpty ? (
          <div className="text-muted-foreground/60 flex flex-col items-center gap-2 px-4 py-16 text-center text-xs">
            <ActivityIcon className="size-6" />
            <p>暂无活动</p>
            <p className="text-muted-foreground/50">
              agent 执行任务后,计划、文件变更、终端输出与引用资料会汇总到这里
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
};
