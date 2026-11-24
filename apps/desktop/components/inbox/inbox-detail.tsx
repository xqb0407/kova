"use client";

import { useEffect, useState, type FC, type ReactNode } from "react";
import type { InboxDetail as InboxDetailData, InboxItem } from "pi-protocol";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCcwIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { openExternal } from "@/lib/external-link";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from "@/components/ui/ask-user-questions";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QuestionView } from "@/lib/pi/pi-question";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export type InboxActionPayload = Record<string, unknown>;

/** 线格式 → AskUserQuestions 形态（与 question-card.tsx 同一 q-/o- 下标约定） */
function toComponentQuestion(q: QuestionView, i: number): AskUserQuestion {
  return {
    id: `q-${i}`,
    title: q.title,
    options: q.options?.map((o, j) => ({
      id: `o-${j}`,
      title: o.title,
      description: o.description,
    })),
    multiSelect: q.multiSelect,
    allowOther: q.freeText ? false : (q.allowOther ?? true),
    otherPlaceholder: q.otherPlaceholder,
    freeText: q.freeText,
    freeTextPlaceholder: q.freeTextPlaceholder,
    nextLabel: "继续",
  };
}

/** 审批参数可能带整篇 write 内容；详情只做审阅，不让 DOM 吃下无限长文本 */
const MAX_DETAIL_TEXT = 8000;

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 外部来源显示名：已知 provider 用品牌名，未知 provider 原样展示 */
const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  linear: "Linear",
  azure_devops: "Azure DevOps",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/** 未知 reason 原样展示，不把 i18n key 抛给用户 */
function reasonText(reason: string, t: ReturnType<typeof useT>): string {
  const key = `inbox.reasons.${reason}`;
  const text = t(key);
  return text === key ? reason : text;
}

function pretty(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      const stringified = JSON.stringify(value, null, 2);
      text = typeof stringified === "string" ? stringified : String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_DETAIL_TEXT
    ? `${text.slice(0, MAX_DETAIL_TEXT)}\n…[truncated ${text.length - MAX_DETAIL_TEXT} chars]`
    : text;
}

export const InboxDetailPanel: FC<{
  item: InboxItem | null;
  detail: InboxDetailData | null;
  loading: boolean;
  error: string | null;
  /** 历史 Tab：只读，不渲染归档/标未读等写入动作 */
  readOnly?: boolean;
  /** 嵌在右侧阅读窗（非 Dialog）时，标题用普通 h1/h2，避免 Base UI DialogContext 缺失 */
  embedded?: boolean;
  /** 阅读窗自己渲染标题时，隐藏面板内置标题块（审批/提问仍复用面板正文） */
  hideHeader?: boolean;
  /** 阅读窗自己渲染底部动作时，隐藏面板内置页脚，避免归档/删除出现两份 */
  hideFooter?: boolean;
  onAction: (item: InboxItem, action: string, payload?: InboxActionPayload) => Promise<void>;
  onOpenSession: (item: InboxItem) => void;
  onArchive: (item: InboxItem, archived: boolean) => Promise<void> | void;
  onMarkUnread: (item: InboxItem) => Promise<void> | void;
  /** 删除统一走视图层确认框（列表行与详情共用一份） */
  onRequestDelete: (item: InboxItem) => void;
}> = ({ item, detail, loading, error, readOnly = false, embedded = false, hideHeader = false, hideFooter = false, onAction, onOpenSession, onArchive, onMarkUnread, onRequestDelete }) => {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setBusy(null);
  }, [item?.id]);

  if (!item) {
    return (
      <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 text-center text-sm">
        {embedded ? (
          <h2 className="sr-only">{t("inbox.title")}</h2>
        ) : (
          <DialogTitle className="sr-only">{t("inbox.title")}</DialogTitle>
        )}
        <span className="bg-muted/60 grid size-10 place-items-center rounded-xl">
          <ArchiveIcon className="size-4" />
        </span>
        <p>{t("inbox.detail.placeholder")}</p>
      </div>
    );
  }

  const run = async (action: string, payload?: InboxActionPayload) => {
    setBusy(action);
    try {
      await onAction(item, action, payload);
    } finally {
      setBusy(null);
    }
  };

  const sessionId = item.deepLink?.sessionId ?? item.sessionId;
  /** 页脚来源：与列表行同一套事件标签，不把协议枚举（background_task）直接抛给用户 */
  const kindLabel =
    item.kind === "external"
      ? t("inbox.event.external")
      : t(`inbox.event.${item.kind}`);
  const actionable = !readOnly && item.requiresAction;
  // 历史 Tab 也允许归档（把已读已结束的记录收进「已归档」）；只挡仍在等处理的
  const canArchive =
    item.state !== "open" && item.actions.includes("archive");
  const canDelete = item.state !== "open";
  const canResume = actionable && item.actions.includes("resume");
  const canRetry = actionable && item.actions.includes("retry");

  return (
    <div className="flex flex-col gap-6">
      {/* 标题块：与 Dialog 其他弹窗同一套节奏（18px 标题 + 14px 说明），
          右侧留出浮层关闭按钮的位置；阅读窗自渲染标题时跳过 */}
      {!hideHeader ? (
        <div className={cn("flex flex-col gap-2", !embedded && "pr-12")}>
          {embedded ? (
            <h1 className="cn-font-heading text-lg leading-6 font-medium break-words">
              {item.title}
            </h1>
          ) : (
            <DialogTitle className="cn-font-heading text-lg leading-6 font-medium break-words">
              {item.title}
            </DialogTitle>
          )}
          {item.summary ? (
            <p className="text-muted-foreground text-sm leading-5 break-words">
              {item.summary}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        {error ? (
          <div className="border-destructive/20 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-[13px] leading-5">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
            <Loader2Icon className="size-4 animate-spin" />
            {t("inbox.detail.loading")}
          </div>
        ) : null}

        {detail?.kind === "approval" ? (() => {
          const payload = detail.interaction.payload as {
            toolName?: unknown;
            input?: unknown;
            note?: unknown;
            canRemember?: unknown;
            rememberScopes?: unknown;
          };
          const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
          const note = typeof payload.note === "string" ? payload.note : undefined;
          const rememberScopes = Array.isArray(payload.rememberScopes)
            ? payload.rememberScopes.filter(
                (scope): scope is "session" | "project" | "user" =>
                  scope === "session" || scope === "project" || scope === "user",
              )
            : [];
          // 非程序员只需要看到“要执行的命令”，原始 JSON 收进技术参数
          const command =
            typeof payload.input === "object" &&
            payload.input !== null &&
            "command" in payload.input &&
            typeof (payload.input as Record<string, unknown>).command === "string"
              ? ((payload.input as Record<string, unknown>).command as string)
              : null;
          const inputSummary =
            command ??
            (payload.input === undefined
              ? null
              : JSON.stringify(payload.input).replace(/\s+/g, " ").trim());
          return (
          <div className="border-border/60 bg-card overflow-hidden rounded-2xl border">
            <div className="flex flex-wrap items-start gap-x-2.5 gap-y-2 px-4 py-3">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1 basis-52">
                <p className="text-sm font-medium">
                  {t("inbox.detail.approvalTitle")}
                  {toolName ? <span className="font-mono"> {toolName}</span> : null}
                </p>
                {note ? (
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {note}
                  </p>
                ) : null}
                {inputSummary ? (
                  <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                    {inputSummary}
                  </p>
                ) : null}
                <details className="group mt-1.5">
                  <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                    {t("inbox.detail.technicalDetails")}
                  </summary>
                  <pre className="border-border/60 bg-muted/40 text-foreground/90 mt-2 max-h-56 overflow-auto rounded-lg border p-2.5 font-mono text-xs leading-relaxed">
                    {pretty(payload.input)}
                  </pre>
                </details>
              </div>
              {actionable ? (
                <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void run("deny", {})}
                    className="h-8 rounded-full px-3.5"
                  >
                    {busy === "deny" ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                    {t("inbox.detail.deny")}
                  </Button>
                  {payload.canRemember === true ? (
                    rememberScopes.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              className="h-8 rounded-full px-3.5"
                            />
                          }
                        >
                          <BookmarkPlusIcon className="size-3.5" />
                          {t("inbox.detail.remember")}
                          <ChevronDownIcon className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuLabel>
                            {t("inbox.detail.rememberScope")}
                          </DropdownMenuLabel>
                          {rememberScopes.includes("session") ? (
                            <DropdownMenuItem
                              onClick={() =>
                                void run("approve", { remember: true, rememberScope: "session" })
                              }
                            >
                              {t("inbox.detail.rememberSession")}
                            </DropdownMenuItem>
                          ) : null}
                          {rememberScopes.includes("project") ? (
                            <DropdownMenuItem
                              onClick={() =>
                                void run("approve", { remember: true, rememberScope: "project" })
                              }
                            >
                              {t("inbox.detail.rememberProject")}
                            </DropdownMenuItem>
                          ) : null}
                          {rememberScopes.includes("user") ? (
                            <DropdownMenuItem
                              onClick={() =>
                                void run("approve", { remember: true, rememberScope: "user" })
                              }
                            >
                              {t("inbox.detail.rememberUser")}
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void run("approve", { remember: true })}
                        className="h-8 rounded-full px-3.5"
                      >
                        <BookmarkPlusIcon className="size-3.5" />
                        {t("inbox.detail.remember")}
                      </Button>
                    )
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void run("approve", {})}
                    className="h-8 rounded-full px-3.5"
                  >
                    {busy === "approve" ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                    {t("inbox.detail.approve")}
                  </Button>
                </div>
              ) : (
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {t("inbox.detail.handled")}
                </span>
              )}
            </div>
          </div>
          );
        })() : null}

        {detail?.kind === "question" ? (
          <div className="flex flex-col gap-3">
            {actionable ? (
              <AskUserQuestions
                questions={(Array.isArray(detail.interaction.payload.questions)
                  ? (detail.interaction.payload.questions as QuestionView[])
                  : []
                ).map(toComponentQuestion)}
                skipLabel={t("inbox.detail.cancel")}
                dismissLabel={t("inbox.detail.cancel")}
                onDismiss={() => void run("cancel")}
                onComplete={(answers: Record<string, AskUserAnswer>) => {
                  void run("answer", {
                    answers: Object.values(answers).map((a) => ({
                      questionId: a.questionId,
                      selectedIds: a.selectedIds ?? [],
                      ...(a.otherText ? { otherText: a.otherText } : {}),
                      ...(a.skipped ? { skipped: true } : {}),
                    })),
                  });
                }}
              />
            ) : (
              <p className="text-muted-foreground text-[13px] leading-5">{t("inbox.detail.handled")}</p>
            )}
          </div>
        ) : null}

        {detail?.kind === "goal" && detail.goal.goal ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.goalTitle")}>
              <KeyValue label={t("inbox.detail.objective")} value={detail.goal.goal.objective} />
              <KeyValue label={t("inbox.detail.status")} value={detail.goal.goal.statusLine} />
              {detail.goal.goal.pauseReason ? (
                <p className="text-muted-foreground text-[13px] leading-5">
                  {detail.goal.goal.pauseReason}
                </p>
              ) : null}
            </Section>
            {canResume ? (
              <Button
                className="w-fit gap-1.5"
                disabled={busy !== null}
                onClick={() => void run("resume")}
              >
                <RotateCcwIcon className="size-4" />
                {t("inbox.detail.resume")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {detail?.kind === "automation" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.automationTitle")}>
              <KeyValue label={t("inbox.detail.task")} value={detail.task.name ?? detail.task.id} />
              <KeyValue label={t("inbox.detail.run")} value={detail.run.status} />
              {detail.run.message ? (
                <p className="text-muted-foreground text-[13px] leading-5">{detail.run.message}</p>
              ) : null}
            </Section>
            {canRetry ? (
              <Button
                className="w-fit gap-1.5"
                disabled={busy !== null}
                onClick={() => void run("retry")}
              >
                <RotateCcwIcon className="size-4" />
                {t("inbox.detail.retry")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {detail?.kind === "subagent" ? (
          <div className="flex flex-col gap-4">
            {/* 头部已经写着「子代理报告」，这里不再重复标题，只列元信息 */}
            <div className="flex flex-col gap-2">
              <KeyValue label={t("inbox.detail.agent")} value={detail.record.agentName} />
              <KeyValue label={t("inbox.detail.status")} value={detail.record.status} />
            </div>
            <Section title={t("inbox.detail.report")}>
              {detail.report ? (
                // 报告是子智能体的最终 Markdown 产出（标题/列表/代码块），
                // 与「子智能体」面板同源渲染；纯文本报告 Streamdown 也照常显示
                <div className="bg-muted/40 border-border/60 max-h-72 overflow-auto rounded-lg border p-3">
                  <MarkdownText text={detail.report} />
                </div>
              ) : (
                <p className="text-muted-foreground text-[13px] leading-5">
                  {t("inbox.detail.reportEmpty")}
                </p>
              )}
            </Section>
          </div>
        ) : null}

        {detail?.kind === "external" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.externalTitle")}>
              <KeyValue
                label={t("inbox.detail.provider")}
                value={providerLabel(detail.external.provider)}
              />
              {detail.external.type ? (
                <KeyValue label={t("inbox.detail.type")} value={detail.external.type} />
              ) : null}
              {detail.external.key ? (
                <KeyValue label={t("inbox.detail.key")} value={detail.external.key} mono />
              ) : null}
              {detail.external.reason ? (
                <KeyValue
                  label={t("inbox.detail.reason")}
                  value={reasonText(detail.external.reason, t)}
                />
              ) : null}
              {detail.external.status ? (
                <KeyValue label={t("inbox.detail.status")} value={detail.external.status} />
              ) : null}
              {detail.external.sourceName ? (
                <KeyValue label={t("inbox.detail.source")} value={detail.external.sourceName} />
              ) : null}
              {detail.description ? (
                <p className="text-muted-foreground text-[13px] leading-5">
                  {detail.description}
                </p>
              ) : null}
            </Section>
            {safeHttpUrl(detail.external.url) ? (
              <Button
                variant="outline"
                className="w-fit gap-1.5"
                onClick={() => openExternal(safeHttpUrl(detail.external.url)!)}
              >
                <ExternalLinkIcon className="size-4" />
                {t("inbox.detail.openExternal")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {detail?.kind === "background_task" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.backgroundTitle")}>
              <KeyValue label={t("inbox.detail.command")} value={detail.task.command} mono />
              <KeyValue
                label={t("inbox.detail.exitCode")}
                value={detail.task.exitCode === null ? t("inbox.detail.unknown") : String(detail.task.exitCode)}
              />
            </Section>
          </div>
        ) : null}

        {!loading && !detail && !error ? (
          <p className="text-muted-foreground text-[13px] leading-5">{t("inbox.detail.stale")}</p>
        ) : null}
      </div>

      {!hideFooter ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground min-w-0 truncate text-[13px] leading-5">
            {t("inbox.detail.source")}: {kindLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {sessionId ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                onClick={() => onOpenSession(item)}
              >
                <ArrowUpRightIcon className="size-4" />
                {t("inbox.detail.openSession")}
              </Button>
            ) : null}
            {item.archivedAt ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                onClick={() => void onArchive(item, false)}
              >
                <ArchiveIcon className="size-4" />
                {t("inbox.detail.unarchive")}
              </Button>
            ) : canArchive ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                onClick={() => void onArchive(item, true)}
              >
                <ArchiveIcon className="size-4" />
                {t("inbox.detail.archive")}
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive gap-1.5"
                onClick={() => onRequestDelete(item)}
              >
                <Trash2Icon className="size-4" />
                {t("inbox.detail.delete")}
              </Button>
            ) : null}
            {readOnly ? null : (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void onMarkUnread(item)}
              >
                {t("inbox.detail.markUnread")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-sm leading-5 font-medium">{title}</h3>
    {children}
  </section>
);

const KeyValue: FC<{ label: string; value?: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="flex items-start gap-3 text-sm leading-6">
    <span className="text-muted-foreground w-16 shrink-0 leading-6">{label}</span>
    <span className={cn("min-w-0 flex-1 break-words", mono && "font-mono text-xs leading-5")}>
      {value || "—"}
    </span>
  </div>
);
