"use client";

import type { FC } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { InboxItem } from "pi-protocol";
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  EyeIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
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
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { formatDateTime } from "@/lib/automation/automation-format";
import { EASE_OUT } from "@/lib/motion/ease";
import type { InboxGroup } from "@/lib/inbox/inbox-groups";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const KIND_ICON: Record<InboxItem["kind"], LucideIcon> = {
  approval: CheckIcon,
  question: MessageSquareIcon,
  goal: TargetIcon,
  automation: ZapIcon,
  subagent: BotIcon,
  background_task: TerminalIcon,
  external: CircleDotIcon,
};

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  linear: "Linear",
  azure_devops: "Azure DevOps",
};

function groupIcon(group: InboxGroup): LucideIcon {
  if (group.label === "task") return MessageSquareIcon;
  return KIND_ICON[group.latest.kind] ?? MessageSquareIcon;
}

function providerText(provider: string): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABEL, provider)
    ? PROVIDER_LABEL[provider]!
    : provider;
}

function groupLabel(group: InboxGroup, t: ReturnType<typeof useT>): string {
  if (group.label === "task") return t("inbox.row.task");
  if (group.label.startsWith("external:")) {
    return providerText(group.label.slice("external:".length));
  }
  return t(`inbox.event.${group.label}`);
}

export const InboxTaskRow: FC<{
  group: InboxGroup;
  expanded: boolean;
  /** 历史 Tab：隐藏批准/回答/恢复/重跑等会在历史里失败的写入动作；
   *  归档/删除是收尾动作，仍然保留 */
  readOnly: boolean;
  onToggle: (group: InboxGroup) => void;
  onViewTask: (group: InboxGroup) => void;
  onAction: (item: InboxItem, action: string) => Promise<void> | void;
  onOpenDetail: (item: InboxItem) => void;
  onRequestDelete: (item: InboxItem) => void;
  /** 分组头批量动作：历史组归档/删除，已归档组恢复/删除 */
  onBulkAction: (
    group: InboxGroup,
    action: "archive" | "unarchive" | "delete",
  ) => void;
}> = ({
  group,
  expanded,
  readOnly,
  onToggle,
  onViewTask,
  onAction,
  onOpenDetail,
  onRequestDelete,
  onBulkAction,
}) => {
  const t = useT();
  const Icon = groupIcon(group);
  // 「有更新」只表示未读；需要动作但已读的条目仍留在待关注，但不再标更新
  const updated = group.hasUnread;
  // 没有 sessionId 时无法走 requestOpenSession，不渲染会必失败的行动按钮
  const canView = Boolean(group.sessionId);
  // 分组头批量动作只在「历史」与「已归档」两个收尾视图出现：
  // 待关注/待处理里还有需要逐条决策的事件，不给一键清空入口
  const archivedGroup =
    group.items.length > 0 && group.items.every((item) => Boolean(item.archivedAt));
  const bulkMode = readOnly || archivedGroup;
  const canBulkArchive = group.items.some(
    (item) =>
      item.state !== "open" &&
      !item.archivedAt &&
      item.actions.includes("archive"),
  );
  const canBulkRestore = group.items.some((item) => Boolean(item.archivedAt));
  const canBulkDelete = group.items.some((item) => item.state !== "open");

  return (
    <div
      data-inbox-group={group.key}
      className={cn(
        "rounded-xl transition-colors",
        expanded ? "bg-muted/35" : "hover:bg-muted/45",
      )}
    >
      {/* 展开热区与「查看任务」是两个独立按钮：避免 role=button 内嵌交互元素 */}
      <div className="flex items-center gap-1 rounded-xl px-3 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggle(group)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1 py-0 text-left outline-none focus-visible:ring-ring/40 focus-visible:ring-1"
        >
          <span
            className="bg-background text-muted-foreground ring-border/60 grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset"
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-muted-foreground shrink-0 text-sm">{groupLabel(group, t)}</span>
            <span className="text-border shrink-0 text-xs">·</span>
            <span className="text-foreground truncate text-sm font-medium">{group.title}</span>
            {updated ? (
              <span className="text-muted-foreground ml-1 flex shrink-0 items-center gap-1 text-xs">
                <span className="bg-primary size-1.5 rounded-full" />
                {t("inbox.row.updated")}
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground ml-0.5 size-3.5 shrink-0 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>
        {/* 生命周期动作统一收进 ⋯ 菜单：每行恒定一个入口，不再按可用性挤
            2~3 个按钮（有的行有「查看任务」有的没有，看着参差） */}
        <div className="flex shrink-0 items-center gap-1">
          {canView || ((bulkMode && canBulkArchive) || (bulkMode && canBulkRestore) || (bulkMode && canBulkDelete)) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-7 shrink-0"
                    aria-label={t("inbox.row.moreActions")}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {canView ? (
                  <DropdownMenuItem onClick={() => onViewTask(group)}>
                    <EyeIcon className="size-4" />
                    {t("inbox.row.viewTask")}
                  </DropdownMenuItem>
                ) : null}
                {canView && bulkMode && (canBulkArchive || canBulkRestore || canBulkDelete) ? (
                  <DropdownMenuSeparator />
                ) : null}
                {bulkMode && canBulkArchive ? (
                  <DropdownMenuItem onClick={() => onBulkAction(group, "archive")}>
                    <ArchiveIcon className="size-4" />
                    {t("inbox.row.archive")}
                  </DropdownMenuItem>
                ) : null}
                {bulkMode && canBulkRestore ? (
                  <DropdownMenuItem onClick={() => onBulkAction(group, "unarchive")}>
                    <ArchiveIcon className="size-4" />
                    {t("inbox.row.unarchive")}
                  </DropdownMenuItem>
                ) : null}
                {bulkMode && canBulkDelete ? (
                  <DropdownMenuItem variant="destructive" onClick={() => onBulkAction(group, "delete")}>
                    <Trash2Icon className="size-4" />
                    {t("inbox.row.delete")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
              {group.items.map((item, index) => (
                <EventCard
                  key={item.id}
                  item={item}
                  latest={index === 0}
                  readOnly={readOnly}
                  onAction={onAction}
                  onOpenDetail={onOpenDetail}
                  onRequestDelete={onRequestDelete}
                />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

const EventCard: FC<{
  item: InboxItem;
  latest: boolean;
  readOnly: boolean;
  onAction: (item: InboxItem, action: string) => Promise<void> | void;
  onOpenDetail: (item: InboxItem) => void;
  onRequestDelete: (item: InboxItem) => void;
}> = ({ item, latest, readOnly, onAction, onOpenDetail, onRequestDelete }) => {
  const t = useT();
  const provider = item.external?.provider;
  const eventLabel =
    item.kind === "external"
      ? (provider ? providerText(provider) : t("inbox.event.external"))
      : t(`inbox.event.${item.kind}`);
  // requiresAction 覆盖两类：open 的审批/提问/目标，以及 done 的失败自动化
  // （失败运行仍是 done，但需要人决定是否重跑）。历史 Tab 一律只读。
  const actionable = !readOnly && item.requiresAction;
  const canResume = actionable && item.actions.includes("resume");
  const canRetry = actionable && item.actions.includes("retry");
  // 生命周期收尾动作（归档/恢复/删除）统一收进 ⋯ 菜单，只在收尾场景出现：
  // 历史 Tab、已归档条目、以及已结束的后台任务。上下文主操作（批准/回答/
  // 重跑等）保持内联——那是这张卡此刻最需要被按到的东西
  const canArchive = item.state !== "open" && item.actions.includes("archive");
  const canUnarchive = Boolean(item.archivedAt);
  const canDelete = item.state !== "open";
  const showLifecycleMenu =
    (canArchive || canUnarchive || canDelete) &&
    (readOnly || Boolean(item.archivedAt) || item.kind === "background_task");
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        latest ? "border-border/70 bg-background" : "border-border/50 bg-background/60",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {formatDateTime(item.createdAt)}
        </span>
        <span className="text-muted-foreground/70 text-[11px]">·</span>
        <span className="text-muted-foreground text-[11px]">{eventLabel}</span>
        {!item.readAt ? <span className="bg-primary size-1.5 rounded-full" /> : null}
        <div className="ml-auto flex items-center gap-1">
          {actionable && item.kind === "approval" ? (
            <>
              <Button size="xs" className="gap-1" onClick={() => void onAction(item, "approve")}>
                <CheckIcon className="size-3" />
                {t("inbox.row.approve")}
              </Button>
              <Button size="xs" variant="destructive" className="gap-1" onClick={() => void onAction(item, "deny")}>
                <XIcon className="size-3" />
                {t("inbox.row.deny")}
              </Button>
            </>
          ) : actionable && item.kind === "question" ? (
            <Button size="xs" className="gap-1" onClick={() => onOpenDetail(item)}>
              <MessageSquareIcon className="size-3" />
              {t("inbox.row.answer")}
            </Button>
          ) : canResume ? (
            <Button size="xs" className="gap-1" onClick={() => void onAction(item, "resume")}>
              <RotateCcwIcon className="size-3" />
              {t("inbox.row.resume")}
            </Button>
          ) : canRetry ? (
            <Button size="xs" className="gap-1" onClick={() => void onAction(item, "retry")}>
              <RotateCcwIcon className="size-3" />
              {t("inbox.row.retry")}
            </Button>
          ) : item.kind === "subagent" ? (
            <Button size="xs" variant="ghost" className="gap-1" onClick={() => onOpenDetail(item)}>
              <EyeIcon className="size-3" />
              {t("inbox.row.viewReport")}
            </Button>
          ) : item.kind === "external" && item.deepLink?.url ? (
            <Button
              size="xs"
              variant="ghost"
              className="gap-1"
              onClick={() => void onAction(item, "open")}
            >
              <ExternalLinkIcon className="size-3" />
              {t("inbox.row.open")}
            </Button>
          ) : null}
          {showLifecycleMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground size-7"
                    aria-label={t("inbox.row.moreActions")}
                  />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {canArchive ? (
                  <DropdownMenuItem onClick={() => void onAction(item, "archive")}>
                    <ArchiveIcon className="size-4" />
                    {t("inbox.row.archive")}
                  </DropdownMenuItem>
                ) : null}
                {canUnarchive ? (
                  <DropdownMenuItem onClick={() => void onAction(item, "unarchive")}>
                    <ArchiveIcon className="size-4" />
                    {t("inbox.row.unarchive")}
                  </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem variant="destructive" onClick={() => onRequestDelete(item)}>
                    <Trash2Icon className="size-4" />
                    {t("inbox.row.delete")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpenDetail(item)}
        className="text-foreground/90 block w-full cursor-pointer rounded-sm text-left text-sm leading-relaxed whitespace-pre-wrap outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {item.summary || item.title}
      </button>
      {latest || readOnly ? null : (
        <TooltipIconButton
          tooltip={t("inbox.row.markRead")}
          side="left"
          className="mt-1 size-6"
          onClick={() => void onAction(item, "mark_read")}
        >
          <CheckIcon className="size-3" />
        </TooltipIconButton>
      )}
    </div>
  );
};
