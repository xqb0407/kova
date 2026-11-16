"use client";

/**
 * MCP 任务进度条（M2.1）：composer 上方的常驻条（grid 折叠，同队列条范式）。
 *
 * 数据源是 pi-interactions 的 data-mcpTask 直播 store：task 发起→进度→终态，
 * 终态即移除（历史在工具行/转录）。只展示活跃任务的最新一行 + 计数；
 * 不承接取消（Stop 是统一的取消入口）。
 */
import { type FC } from "react";
import { Loader2Icon } from "lucide-react";
import { useMcpTaskProgress } from "@/lib/pi/pi-mcp-tasks";
import { useInteractionSessionId } from "@/lib/pi/pi-interaction-session";
import { useT } from "@/lib/i18n";

export const McpTaskStrip: FC = () => {
  const t = useT();
  const sessionId = useInteractionSessionId();
  const tasks = useMcpTaskProgress(sessionId ?? null);

  if (!sessionId || tasks.length === 0) return null;
  const latest = tasks[tasks.length - 1]!;

  return (
    <div
      data-slot="aui-mcp-task-strip"
      className="border-border/50 bg-muted/30 mb-2 flex items-center gap-2 overflow-hidden rounded-xl border px-3 py-2"
    >
      <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
      <span className="text-muted-foreground shrink-0 text-xs font-medium">
        {t("chat.mcpTask.title", { count: tasks.length })}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={latest.tool}>
        {latest.tool ?? latest.server}
        {latest.message ? ` · ${latest.message}` : ""}
        {tasks.length > 1 ? ` · ${latest.status}` : ""}
      </span>
    </div>
  );
};
