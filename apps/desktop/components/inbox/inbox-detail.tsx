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
  XIcon,
} from "lucide-react";
import { openExternal } from "@/lib/external-link";
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from "@/components/ui/ask-user-questions";
import { Button } from "@/components/ui/button";
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
}> = ({ item, detail, loading, error, readOnly = false, onAction, onOpenSession, onArchive, onMarkUnread }) => {
  const t = useT();
  const [remember, setRemember] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setRemember(false);
    setReason("");
    setBusy(null);
  }, [item?.id]);

  if (!item) {
    return (
      <div className="text-muted-foreground flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
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
  const actionable = !readOnly && item.requiresAction;
  const canArchive =
    !readOnly && item.state !== "open" && item.actions.includes("archive");
  const canResume = actionable && item.actions.includes("resume");
  const canRetry = actionable && item.actions.includes("retry");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-snug">{item.title}</h2>
          {item.summary ? (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {item.summary}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {sessionId ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.detail.openSession")}
              title={t("inbox.detail.openSession")}
              onClick={() => onOpenSession(item)}
            >
              <ArrowUpRightIcon className="size-4" />
            </Button>
          ) : null}
          {item.archivedAt ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.detail.unarchive")}
              title={t("inbox.detail.unarchive")}
              onClick={() => void onArchive(item, false)}
            >
              <ArchiveIcon className="size-4" />
            </Button>
          ) : canArchive ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.detail.archive")}
              title={t("inbox.detail.archive")}
              onClick={() => void onArchive(item, true)}
            >
              <ArchiveIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <div className="border-destructive/20 bg-destructive/5 text-destructive mb-3 rounded-lg border px-3 py-2 text-xs">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            {t("inbox.detail.loading")}
          </div>
        ) : null}

        {detail?.kind === "approval" ? (() => {
          const payload = detail.interaction.payload as {
            toolName?: unknown;
            input?: unknown;
            note?: unknown;
            canRemember?: unknown;
          };
          const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
          const note = typeof payload.note === "string" ? payload.note : undefined;
          return (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.approvalTitle")}>
              <KeyValue label={t("inbox.detail.tool")} value={toolName} mono />
              {note ? (
                <p className="text-muted-foreground text-xs leading-relaxed">{note}</p>
              ) : null}
            </Section>
            <Section title={t("inbox.detail.input")}>
              <pre className="bg-muted/50 text-foreground/90 max-h-56 overflow-auto rounded-lg p-3 text-[11px] leading-relaxed">
                {pretty(payload.input)}
              </pre>
            </Section>
            {actionable ? (
              <>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("inbox.detail.note")}
                  className="h-8 text-xs"
                  aria-label={t("inbox.detail.note")}
                />
                {payload.canRemember === true ? (
                  <label className="text-muted-foreground flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                      className="accent-primary size-3.5"
                    />
                    {t("inbox.detail.remember")}
                  </label>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={busy !== null}
                    onClick={() => void run("approve", { remember, ...(reason ? { reason } : {}) })}
                  >
                    {busy === "approve" ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                    {t("inbox.detail.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1"
                    disabled={busy !== null}
                    onClick={() => void run("deny", { ...(reason ? { reason } : {}) })}
                  >
                    {busy === "deny" ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                    {t("inbox.detail.deny")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-xs">{t("inbox.detail.handled")}</p>
            )}
          </div>
          );
        })() : null}

        {detail?.kind === "question" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.questionTitle")}>
              <p className="text-muted-foreground text-xs leading-relaxed">
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
              <p className="text-muted-foreground text-xs">{t("inbox.detail.handled")}</p>
            )}
          </div>
        ) : null}

        {detail?.kind === "goal" && detail.goal.goal ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.goalTitle")}>
              <KeyValue label={t("inbox.detail.objective")} value={detail.goal.goal.objective} />
              <KeyValue label={t("inbox.detail.status")} value={detail.goal.goal.statusLine} />
              {detail.goal.goal.pauseReason ? (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {detail.goal.goal.pauseReason}
                </p>
              ) : null}
            </Section>
            {canResume ? (
              <Button
                size="sm"
                className="w-fit gap-1"
                disabled={busy !== null}
                onClick={() => void run("resume")}
              >
                <RotateCcwIcon className="size-3.5" />
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
                <p className="text-muted-foreground text-xs leading-relaxed">{detail.run.message}</p>
              ) : null}
            </Section>
            <div className="flex items-center gap-2">
              {sessionId ? (
                <Button size="sm" variant="outline" className="gap-1" onClick={() => onOpenSession(item)}>
                  <ArrowUpRightIcon className="size-3.5" />
                  {t("inbox.detail.openSession")}
                </Button>
              ) : null}
              {canRetry ? (
                <Button
                  size="sm"
                  className="gap-1"
                  disabled={busy !== null}
                  onClick={() => void run("retry")}
                >
                  <RotateCcwIcon className="size-3.5" />
                  {t("inbox.detail.retry")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {detail?.kind === "subagent" ? (
          <div className="flex flex-col gap-3">
            <Section title={t("inbox.detail.subagentTitle")}>
              <KeyValue label={t("inbox.detail.agent")} value={detail.record.agentName} />
              <KeyValue label={t("inbox.detail.status")} value={detail.record.status} />
              {sessionId ? (
                <Button size="sm" variant="outline" className="mt-1 w-fit gap-1" onClick={() => onOpenSession(item)}>
                  <ArrowUpRightIcon className="size-3.5" />
                  {t("inbox.detail.openSession")}
                </Button>
              ) : null}
            </Section>
            <Section title={t("inbox.detail.report")}>
              <pre className="bg-muted/50 text-foreground/90 max-h-80 overflow-auto rounded-lg p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
                {detail.report || t("inbox.detail.reportEmpty")}
              </pre>
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
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {detail.description}
                </p>
              ) : null}
            </Section>
            {safeHttpUrl(detail.external.url) ? (
              <Button
                size="sm"
                variant="outline"
                className="w-fit gap-1"
                onClick={() => openExternal(safeHttpUrl(detail.external.url)!)}
              >
                <ExternalLinkIcon className="size-3.5" />
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
            {sessionId ? (
              <Button size="sm" variant="outline" className="w-fit gap-1" onClick={() => onOpenSession(item)}>
                <ArrowUpRightIcon className="size-3.5" />
                {t("inbox.detail.openSession")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {!loading && !detail && !error ? (
          <p className="text-muted-foreground text-xs">{t("inbox.detail.stale")}</p>
        ) : null}
      </div>

      <div className="border-border/60 flex items-center justify-between gap-2 border-t px-4 py-2">
        <span className="text-muted-foreground truncate text-[11px]">
          {t("inbox.detail.source")}: {item.kind}
        </span>
        {readOnly ? null : (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => void onMarkUnread(item)}
          >
            {t("inbox.detail.markUnread")}
          </Button>
        )}
      </div>
    </div>
  );
};

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
      {title}
    </h3>
    {children}
  </section>
);

const KeyValue: FC<{ label: string; value?: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="flex items-start gap-2 text-xs">
    <span className="text-muted-foreground w-16 shrink-0">{label}</span>
    <span className={cn("min-w-0 flex-1 break-words", mono && "font-mono text-[11px]")}>
      {value || "—"}
    </span>
  </div>
);
