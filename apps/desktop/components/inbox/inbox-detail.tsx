"use client";

import { useEffect, useState, type FC, type ReactNode } from "react";
import type { InboxDetail as InboxDetailData, InboxItem } from "pi-protocol";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCcwIcon,
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
import { Input } from "@/components/ui/input";
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
  onAction: (item: InboxItem, action: string, payload?: InboxActionPayload) => Promise<void>;
  onOpenSession: (item: InboxItem) => void;
  onArchive: (item: InboxItem, archived: boolean) => Promise<void> | void;
  onMarkUnread: (item: InboxItem) => Promise<void> | void;
  /** 删除统一走视图层确认框（列表行与详情共用一份） */
  onRequestDelete: (item: InboxItem) => void;
}> = ({ item, detail, loading, error, readOnly = false, onAction, onOpenSession, onArchive, onMarkUnread, onRequestDelete }) => {
  const t = useT();
  const [remember, setRemember] = useState(false);
  const [rememberScope, setRememberScope] = useState<"session" | "project" | "user">("project");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setRemember(false);
    setRememberScope("project");
    setReason("");
    setBusy(null);
  }, [item?.id]);

  if (!item) {
    return (
      <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 text-center text-sm">
        <DialogTitle className="sr-only">{t("inbox.title")}</DialogTitle>
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
          右侧留出浮层关闭按钮的位置 */}
      <div className="flex flex-col gap-2 pr-12">
        <DialogTitle className="cn-font-heading text-lg leading-6 font-medium break-words">
          {item.title}
        </DialogTitle>
        {item.summary ? (
          <p className="text-muted-foreground text-sm leading-5 break-words">
            {item.summary}
          </p>
        ) : null}
      </div>

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
          return (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.approvalTitle")}>
              <KeyValue label={t("inbox.detail.tool")} value={toolName} mono />
              {note ? (
                <p className="text-muted-foreground text-[13px] leading-5">{note}</p>
              ) : null}
            </Section>
            <Section title={t("inbox.detail.input")}>
              <pre className="bg-muted/40 border-border/60 text-foreground/90 max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
                {pretty(payload.input)}
              </pre>
            </Section>
            {actionable ? (
              <>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("inbox.detail.note")}
                  className="text-sm"
                  aria-label={t("inbox.detail.note")}
                />
                {payload.canRemember === true ? (
                  rememberScopes.length > 0 ? (
                    <label className="text-muted-foreground flex flex-wrap items-center gap-2 text-[13px] leading-5">
                      {t("inbox.detail.remember")}
                      <select
                        value={remember ? rememberScope : "once"}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "once") {
                            setRemember(false);
                            return;
                          }
                          setRemember(true);
                          setRememberScope(value as "session" | "project" | "user");
                        }}
                        className="border-border/60 bg-background rounded-md border px-2 py-1 text-sm"
                        aria-label={t("inbox.detail.rememberScope")}
                      >
                        <option value="once">{t("inbox.detail.rememberOnce")}</option>
                        {rememberScopes.includes("session") ? (
                          <option value="session">{t("inbox.detail.rememberSession")}</option>
                        ) : null}
                        {rememberScopes.includes("project") ? (
                          <option value="project">{t("inbox.detail.rememberProject")}</option>
                        ) : null}
                        {rememberScopes.includes("user") ? (
                          <option value="user">{t("inbox.detail.rememberUser")}</option>
                        ) : null}
                      </select>
                    </label>
                  ) : (
                    <label className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                        className="accent-primary size-4"
                      />
                      {t("inbox.detail.remember")}
                    </label>
                  )
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    className="gap-1.5"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("approve", {
                        remember,
                        ...(remember && rememberScopes.length > 0 ? { rememberScope } : {}),
                        ...(reason ? { reason } : {}),
                      })
                    }
                  >
                    {busy === "approve" ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
                    {t("inbox.detail.approve")}
                  </Button>
                  <Button
                    variant="destructive"
                    className="gap-1.5"
                    disabled={busy !== null}
                    onClick={() => void run("deny", { ...(reason ? { reason } : {}) })}
                  >
                    {busy === "deny" ? <Loader2Icon className="size-4 animate-spin" /> : <XIcon className="size-4" />}
                    {t("inbox.detail.deny")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-[13px] leading-5">{t("inbox.detail.handled")}</p>
            )}
          </div>
          );
        })() : null}

        {detail?.kind === "question" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.questionTitle")}>
              <p className="text-muted-foreground text-[13px] leading-5">
                {t("inbox.filter.question")}
              </p>
            </Section>
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
              <KeyValue label={t("inbox.detail.provider")} value={detail.external.provider} />
              {detail.external.type ? (
                <KeyValue label={t("inbox.detail.type")} value={detail.external.type} />
              ) : null}
              {detail.external.key ? (
                <KeyValue label={t("inbox.detail.key")} value={detail.external.key} mono />
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
