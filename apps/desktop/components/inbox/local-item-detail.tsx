"use client";

import type { FC, ReactNode } from "react";
import type { InboxDetail, InboxItem } from "pi-protocol";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpRightIcon,
  BotIcon,
  MailIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { relativeTime } from "@/lib/inbox/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { InboxDetailPanel } from "./inbox-detail";

/**
 * 右侧阅读窗：本地 agent 事件（审批/提问/自动化/子代理/后台/目标）。
 *
 * 与外部 issue 详情同一套版式：顶部来源/状态/标题/操作，正文按 kind 渲染；
 * 审批/提问的交互正文仍复用 InboxDetailPanel（hideHeader），避免重写权限逻辑。
 */

/** 审批图标：Heroicons 24/solid shield-check（MIT），比线性对勾更像“权限/批准” */
const ApprovalShieldIcon: FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    className={className}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12.516 2.17a.75.75 0 0 0-1.032 0 11.209 11.209 0 0 1-7.877 3.08.75.75 0 0 0-.722.515A12.74 12.74 0 0 0 2.25 9.75c0 5.942 4.064 10.933 9.563 12.348a.749.749 0 0 0 .374 0c5.499-1.415 9.563-6.406 9.563-12.348 0-1.39-.223-2.73-.635-3.985a.75.75 0 0 0-.722-.516l-.143.001c-2.996 0-5.717-1.17-7.734-3.08Zm3.094 8.016a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
    />
  </svg>
);

const KIND_ICONS: Record<InboxItem["kind"], LucideIcon> = {
  approval: ShieldCheckIcon,
  question: MessageSquareIcon,
  goal: TargetIcon,
  automation: ZapIcon,
  subagent: BotIcon,
  background_task: TerminalIcon,
  external: MessageSquareIcon,
};

const STATUS_KEYS: Record<string, string> = {
  failed: "inbox.local.status.failed",
  error: "inbox.local.status.failed",
  success: "inbox.local.status.success",
  completed: "inbox.local.status.success",
  done: "inbox.local.status.success",
  stopped: "inbox.local.status.stopped",
  aborted: "inbox.local.status.stopped",
  interrupted: "inbox.local.status.interrupted",
  truncated: "inbox.local.status.truncated",
  running: "inbox.local.status.running",
  waiting: "inbox.local.status.waiting",
  open: "inbox.local.status.waiting",
  active: "inbox.local.status.running",
  paused: "inbox.local.status.waiting",
  blocked: "inbox.local.status.failed",
};

function statusLabel(value: string | undefined, t: ReturnType<typeof useT>): string {
  if (!value) return "";
  const key = STATUS_KEYS[value];
  return key ? t(key) : value;
}

function statusTone(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (/failed|error|interrupted|truncated|blocked/.test(v)) {
    return "bg-destructive/10 text-destructive-strong";
  }
  if (/running|waiting|open|active|paused/.test(v)) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
  if (/success|completed|done/.test(v)) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
  return "bg-muted text-muted-foreground";
}

const KV: FC<{ label: string; children: ReactNode; mono?: boolean }> = ({
  label,
  children,
  mono,
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-muted-foreground text-[11px]">{label}</span>
    <span className={cn("text-[12.5px]", mono && "font-mono text-xs")}>
      {children}
    </span>
  </div>
);

function itemStatus(
  item: InboxItem,
  detail: InboxDetail | null,
): string | undefined {
  if (item.kind === "approval" || item.kind === "question") {
    return item.requiresAction ? "waiting" : "done";
  }
  if (item.kind === "automation") {
    return item.outcome ?? (detail?.kind === "automation" ? detail.run.status : undefined);
  }
  if (item.kind === "subagent") {
    return detail?.kind === "subagent" ? detail.record.status : item.outcome;
  }
  if (item.kind === "goal") {
    return detail?.kind === "goal" ? detail.goal.goal?.status : undefined;
  }
  if (item.kind === "background_task") {
    if (detail?.kind === "background_task") {
      // Inbox 只收终态；exitCode=null 表示被信号杀死（非用户 Stop），按失败展示
      if (item.outcome === "stopped") return "stopped";
      return detail.task.exitCode === 0 ? "success" : "failed";
    }
    return item.outcome;
  }
  return item.outcome;
}

export const LocalItemDetail: FC<{
  item: InboxItem;
  detail: InboxDetail | null;
  loading: boolean;
  error: string | null;
  readOnly: boolean;
  onAction: (item: InboxItem, action: string, payload?: Record<string, unknown>) => Promise<void> | void;
  onOpenSession: (item: InboxItem) => void;
  onArchive: (item: InboxItem, archived: boolean) => Promise<void> | void;
  onMarkUnread: (item: InboxItem) => Promise<void> | void;
  onRequestDelete: (item: InboxItem) => void;
}> = ({
  item,
  detail,
  loading,
  error,
  readOnly,
  onAction,
  onOpenSession,
  onArchive,
  onMarkUnread,
  onRequestDelete,
}) => {
  const t = useT();
  const Icon =
    item.kind === "approval"
      ? ApprovalShieldIcon
      : (KIND_ICONS[item.kind] ?? MessageSquareIcon);
  const status = itemStatus(item, detail);
  const canArchive = !item.archivedAt && item.actions.includes("archive");
  const canUnarchive = Boolean(item.archivedAt);
  const canDelete = item.state !== "open";
  const canOpenSession = Boolean(item.sessionId || item.threadId);
  const canRetry = !readOnly && item.requiresAction && item.actions.includes("retry");
  const canResume = !readOnly && item.requiresAction && item.actions.includes("resume");

  const isApprovalOrQuestion =
    item.kind === "approval" || item.kind === "question";
  /** 审批项用带状态色的盾牌图标，避免「等待处理」却配一个灰色对勾 */
  const glyphTone =
    item.kind === "approval"
      ? status === "waiting"
        ? "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-400"
        : "bg-emerald-500/10 text-emerald-600 ring-emerald-500/25 dark:text-emerald-400"
      : "bg-background text-muted-foreground ring-border/60";
  const statusText = statusLabel(status, t);
  const summary = item.summary?.trim();
  /** 摘要与状态/标题重复时不再展示，避免详情头部出现同一句话三遍；
   *  后台任务的摘要是命令本身，正文会单独展示，头部不再重复 */
  const metaSummary =
    summary &&
    item.kind !== "background_task" &&
    summary !== statusText &&
    summary !== item.title.trim()
      ? summary
      : "";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-7 sm:px-8">
      <div className="relative flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg ring-1",
            glyphTone,
          )}
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1 pr-9">
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span className="text-foreground/70 font-medium">
              {t(`inbox.event.${item.kind}`)}
            </span>
            {status ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                  statusTone(status),
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {statusText}
              </span>
            ) : null}
          </div>
          <h1 className="cn-font-heading mt-1.5 text-[21px] leading-[1.4] font-semibold tracking-tight break-words">
            {item.title}
          </h1>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            {metaSummary ? (
              <>
                <span className="min-w-0 break-words">{metaSummary}</span>
                <span className="text-muted-foreground">·</span>
              </>
            ) : null}
            <span>{relativeTime(item.createdAt, t)}</span>
          </div>
        </div>
        <div className="absolute top-0 right-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={t("inbox.row.moreActions")}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void onMarkUnread(item)}>
                <MailIcon className="size-4" />
                {t("inbox.row.markUnread")}
              </DropdownMenuItem>
              {canUnarchive ? (
                <DropdownMenuItem onClick={() => void onArchive(item, false)}>
                  <ArchiveRestoreIcon className="size-4" />
                  {t("inbox.row.unarchive")}
                </DropdownMenuItem>
              ) : null}
              {canArchive ? (
                <DropdownMenuItem onClick={() => void onArchive(item, true)}>
                  <ArchiveIcon className="size-4" />
                  {t("inbox.row.archive")}
                </DropdownMenuItem>
              ) : null}
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onRequestDelete(item)}
                  >
                    <Trash2Icon className="size-4" />
                    {t("inbox.row.delete")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {canOpenSession || canResume || canRetry ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {canOpenSession ? (
            <Button className="gap-1.5" onClick={() => onOpenSession(item)}>
              <ArrowUpRightIcon className="size-4" />
              {t("inbox.detail.openSession")}
            </Button>
          ) : null}
          {canResume ? (
            <Button
              variant={canOpenSession ? "outline" : "default"}
              className="gap-1.5"
              onClick={() => void onAction(item, "resume")}
            >
              <RotateCcwIcon className="size-4" />
              {t("inbox.detail.resume")}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              variant={canOpenSession || canResume ? "outline" : "default"}
              className="gap-1.5"
              onClick={() => void onAction(item, "retry")}
            >
              <RotateCcwIcon className="size-4" />
              {t("inbox.detail.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="bg-border my-4 h-px" />

      {error ? (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/5 text-destructive-strong rounded-lg border px-3 py-2 text-xs leading-5"
        >
          {error}
        </div>
      ) : null}

      {isApprovalOrQuestion ? (
        <div className="flex flex-col gap-5">
          <InboxDetailPanel
            item={item}
            detail={detail}
            loading={loading}
            error={error}
            readOnly={readOnly}
            embedded
            hideHeader
            hideFooter
            onAction={async (entry, action, payload) => {
              await onAction(entry, action, payload);
            }}
            onOpenSession={onOpenSession}
            onArchive={onArchive}
            onMarkUnread={onMarkUnread}
            onRequestDelete={onRequestDelete}
          />
        </div>
      ) : loading && !detail ? (
        <div className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 text-xs">
          <span className="border-muted-foreground/30 border-t-foreground size-3.5 animate-spin rounded-full border" />
          {t("inbox.detail.loading")}
        </div>
      ) : item.kind === "automation" ? (
        <div className="flex flex-col gap-5">
          {detail?.kind === "automation" ? (
            <>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
                <KV label={t("inbox.detail.task")}>
                  {detail.task.name ?? item.title}
                </KV>
                <KV label={t("inbox.detail.run")} mono>
                  {detail.run.id}
                </KV>
                <KV label={t("inbox.local.time")}>
                  {relativeTime(detail.run.createdAt, t)}
                </KV>
                <KV label={t("inbox.detail.status")}>
                  {statusLabel(
                    item.outcome === "stopped" ? "stopped" : detail.run.status,
                    t,
                  )}
                </KV>
              </div>
              {detail.run.message && item.outcome !== "stopped" ? (
                <div className="border-destructive/20 bg-destructive/5 rounded-lg border p-4">
                  <p className="text-destructive-strong text-[11px] font-medium">
                    {t("inbox.local.errorMessage")}
                  </p>
                  <pre className="text-destructive-strong/90 mt-2 overflow-x-auto overscroll-contain font-mono text-xs leading-6 whitespace-pre-wrap">
                    {detail.run.message}
                  </pre>
                </div>
              ) : item.outcome === "stopped" ? (
                <p className="text-muted-foreground bg-muted/30 rounded-lg px-4 py-3 text-[13px]">
                  {t("inbox.local.stoppedHint")}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-[13px] leading-6">
              {item.summary || t("inbox.local.noDetail")}
            </p>
          )}
        </div>
      ) : item.kind === "subagent" ? (
        <div className="flex flex-col gap-5">
          {detail?.kind === "subagent" ? (
            <>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
                <KV label={t("inbox.detail.agent")}>{detail.record.agentName}</KV>
                <KV label={t("inbox.detail.status")}>
                  {statusLabel(detail.record.status, t)}
                </KV>
                <KV label={t("inbox.local.turns")}>{detail.record.turns}</KV>
                <KV label={t("inbox.local.toolCalls")}>
                  {detail.record.toolCalls}
                </KV>
              </div>
              <div className="bg-muted/20 border-border/50 max-h-72 overflow-auto overscroll-contain rounded-lg border p-4">
                <p className="text-muted-foreground mb-2 text-[11px] font-medium">
                  {t("inbox.detail.report")}
                </p>
                {detail.report ? (
                  <div className="max-w-[72ch] text-[14px] leading-7">
                    <MarkdownText text={detail.report} />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t("inbox.detail.reportEmpty")}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-[13px] leading-6">
              {item.summary || t("inbox.local.noDetail")}
            </p>
          )}
        </div>
      ) : item.kind === "background_task" ? (
        <div className="flex flex-col gap-5">
          {detail?.kind === "background_task" ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              <KV label={t("inbox.detail.source")}>{detail.task.source}</KV>
              <KV label={t("inbox.detail.exitCode")}>
                {detail.task.exitCode === null
                  ? t("inbox.detail.unknown")
                  : detail.task.exitCode}
              </KV>
            </div>
          ) : null}
          <div className="bg-muted/20 border-border/50 rounded-lg border p-4">
            <p className="text-muted-foreground mb-2 text-[11px] font-medium">
              {t("inbox.detail.command")}
            </p>
            <pre className="overflow-x-auto overscroll-contain font-mono text-xs leading-6 whitespace-pre-wrap">
              {detail?.kind === "background_task"
                ? detail.task.command
                : item.summary || t("inbox.local.noDetail")}
            </pre>
          </div>
        </div>
      ) : item.kind === "goal" ? (
        <div className="flex flex-col gap-5">
          {detail?.kind === "goal" && detail.goal.goal ? (
            <>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <KV label={t("inbox.detail.status")}>
                  {statusLabel(detail.goal.goal.status, t)}
                </KV>
                <KV label={t("inbox.local.pauseReason")}>
                  {detail.goal.goal.pauseReason ?? t("inbox.detail.unknown")}
                </KV>
              </div>
              <div className="bg-muted/20 border-border/50 rounded-lg border p-4">
                <p className="text-muted-foreground mb-2 text-[11px] font-medium">
                  {t("inbox.detail.objective")}
                </p>
                <p className="text-[13px] leading-7">
                  {detail.goal.goal.objective}
                </p>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-[13px] leading-6">
              {item.summary || t("inbox.local.noDetail")}
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-[13px] leading-6">
          {item.summary || t("inbox.local.noDetail")}
        </p>
      )}
    </div>
  );
};
