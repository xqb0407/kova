"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import type {
  InboxConnectorProvider,
  InboxExternalCheck,
  InboxExternalChecks,
  InboxExternalDetail,
  InboxExternalDiff,
  InboxExternalPullRequest,
  InboxItem,
  InboxPullRequestAction,
} from "pi-protocol";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  GitCompareIcon,
  GitMergeIcon,
  Loader2Icon,
  MinusCircleIcon,
  RefreshCwIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { PanelPatchDiff } from "@/components/code/panel-diff";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { toast } from "@/components/ui/toast";
import {
  fetchInboxPullRequestChecks,
  fetchInboxPullRequestDiff,
  runInboxPullRequestAction,
} from "@/lib/inbox/connectors";
import { openExternal } from "@/lib/external-link";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Tab = "summary" | "code" | "checks";

const TABS: Tab[] = ["summary", "code", "checks"];

type ResourceState<T> = {
  loading: boolean;
  data: T | null;
  error: string | null;
};

const EMPTY_RESOURCE: ResourceState<never> = {
  loading: false,
  data: null,
  error: null,
};

function pullRequestInput(
  item: InboxItem,
  pr: InboxExternalPullRequest,
  force = false,
  includeHead = true,
) {
  const external = item.external;
  return {
    provider: (external?.provider ?? "github") as InboxConnectorProvider,
    key: external?.key ?? "",
    ...(external?.type ? { type: external.type } : {}),
    ...(external?.externalId ? { externalId: external.externalId } : {}),
    // 手动刷新或 checks 默认不传旧 headSha：让 provider 重新解析当前 head，
    // 避免 PR 刚 push 时一直看旧提交的检查项
    ...(includeHead && pr.headSha && !force ? { headSha: pr.headSha } : {}),
    ...(force ? { force: true } : {}),
  };
}

/** PR/MR 只读评审面：概要 / 代码 / 检查。非 PR 不渲染（调用方先判断）。 */
export const ExternalPrReview: FC<{
  item: InboxItem;
  detail: InboxExternalDetail;
  /** Summary tab 里的正文 + 评论（沿用现有只读渲染） */
  summary: ReactNode;
  /** 失败 checks 交给本地 Agent；不传则隐藏按钮 */
  onFixChecks?: (checks: InboxExternalChecks) => void;
  /** 历史/已归档只读：隐藏写操作 */
  readOnly?: boolean;
  /** 评论/PR 动作成功后刷新详情 */
  onActionDone?: () => void;
}> = ({ item, detail, summary, onFixChecks, readOnly, onActionDone }) => {
  const t = useT();
  const pr = detail.pullRequest;
  const [tab, setTab] = useState<Tab>("summary");
  const [diffReload, setDiffReload] = useState(0);
  const [checksReload, setChecksReload] = useState(0);
  /** 手动刷新标志：只对紧随其后的那次请求生效，普通切 tab 仍走 60s 缓存。 */
  const diffForceRef = useRef(false);
  const checksForceRef = useRef(false);
  const [diff, setDiff] = useState<ResourceState<InboxExternalDiff>>(
    EMPTY_RESOURCE as ResourceState<InboxExternalDiff>,
  );
  const [checks, setChecks] = useState<ResourceState<InboxExternalChecks>>(
    EMPTY_RESOURCE as ResourceState<InboxExternalChecks>,
  );
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    setTab("summary");
    setDiff(EMPTY_RESOURCE as ResourceState<InboxExternalDiff>);
    setChecks(EMPTY_RESOURCE as ResourceState<InboxExternalChecks>);
    diffForceRef.current = false;
    checksForceRef.current = false;
  }, [item.id]);

  useEffect(() => {
    if (tab !== "code" || !pr) return;
    const force = diffForceRef.current;
    diffForceRef.current = false;
    const input = pullRequestInput(item, pr, force);
    if (!input.key) {
      setDiff({
        loading: false,
        data: null,
        error: t("inbox.issue.noSource"),
      });
      return;
    }
    let alive = true;
    setDiff((prev) => ({ loading: true, data: prev.data, error: null }));
    void fetchInboxPullRequestDiff(input)
      .then((result) => {
        if (!alive) return;
        setDiff(
          result.ok
            ? { loading: false, data: result.diff, error: null }
            : { loading: false, data: null, error: result.message },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setDiff({
          loading: false,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      alive = false;
    };
    // pr 随详情刷新可能有新 headSha；item.id 保证切条目时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, item.id, pr?.headSha, diffReload]);

  useEffect(() => {
    if (tab !== "checks" || !pr) return;
    const force = checksForceRef.current;
    checksForceRef.current = false;
    // checks 不带旧 headSha：provider 每次按当前 head 解析，避免手动刷新后
    // 再切回 checks 时又用详情里的旧 headSha 拉回旧提交的检查项。
    const input = pullRequestInput(item, pr, force, false);
    if (!input.key) {
      setChecks({
        loading: false,
        data: null,
        error: t("inbox.issue.noSource"),
      });
      return;
    }
    let alive = true;
    setChecks((prev) => ({ loading: true, data: prev.data, error: null }));
    void fetchInboxPullRequestChecks(input)
      .then((result) => {
        if (!alive) return;
        setChecks(
          result.ok
            ? { loading: false, data: result.checks, error: null }
            : { loading: false, data: null, error: result.message },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setChecks({
          loading: false,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, item.id, pr?.headSha, checksReload]);

  if (!pr) return <>{summary}</>;

  const failedCount =
    checks.data?.checks.filter((check) => check.state === "fail").length ?? 0;

  return (
    <div className="flex flex-col">
      <div
        role="tablist"
        aria-label={t("inbox.pr.tabs.label")}
        className="border-border/60 flex items-stretch gap-5 border-b"
      >
        {TABS.map((entry) => {
          const active = tab === entry;
          return (
            <button
              key={entry}
              type="button"
              role="tab"
              id={`inbox-pr-tab-${entry}`}
              aria-selected={active}
              aria-controls={`inbox-pr-panel-${entry}`}
              tabIndex={active ? 0 : -1}
              ref={(node) => {
                tabRefs.current[entry] = node;
              }}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey) return;
                if (event.key === "Escape") return;
                const index = TABS.indexOf(entry);
                let next: Tab | null = null;
                if (event.key === "ArrowRight") {
                  next = TABS[(index + 1) % TABS.length] ?? null;
                } else if (event.key === "ArrowLeft") {
                  next = TABS[(index - 1 + TABS.length) % TABS.length] ?? null;
                } else if (event.key === "Home") {
                  next = TABS[0] ?? null;
                } else if (event.key === "End") {
                  next = TABS[TABS.length - 1] ?? null;
                }
                if (!next) return;
                event.preventDefault();
                setTab(next);
                requestAnimationFrame(() => tabRefs.current[next]?.focus());
              }}
              onClick={() => setTab(entry)}
              className={cn(
                "relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 text-sm font-medium transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
            >
              {t(`inbox.pr.tabs.${entry}`)}
              {entry === "checks" && failedCount > 0 ? (
                <span className="bg-destructive text-background grid min-w-4 place-items-center rounded-full px-1 text-3xs leading-4 font-semibold">
                  {failedCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <PrActions
        item={item}
        detail={detail}
        readOnly={readOnly}
        onDone={onActionDone}
      />

      <div
        role="tabpanel"
        id="inbox-pr-panel-summary"
        aria-labelledby="inbox-pr-tab-summary"
        style={tab === "summary" ? undefined : { display: "none" }}
        className="flex flex-col gap-5 pt-4"
      >
        <PullRequestFacts pr={pr} />
        {summary}
      </div>

      <div
        role="tabpanel"
        id="inbox-pr-panel-code"
        aria-labelledby="inbox-pr-tab-code"
        hidden={tab !== "code"}
        className="pt-4"
      >
        {tab === "code" ? (
          <DiffPanel
            state={diff}
            onRetry={() => {
              diffForceRef.current = true;
              setDiffReload((value) => value + 1);
            }}
          />
        ) : null}
      </div>

      <div
        role="tabpanel"
        id="inbox-pr-panel-checks"
        aria-labelledby="inbox-pr-tab-checks"
        hidden={tab !== "checks"}
        className="pt-4"
      >
        {tab === "checks" ? (
          <ChecksPanel
            state={checks}
            onRetry={() => {
              checksForceRef.current = true;
              setChecksReload((value) => value + 1);
            }}
            onFixChecks={onFixChecks}
          />
        ) : null}
      </div>
    </div>
  );
};

type PendingAction = {
  action: InboxPullRequestAction;
  title: string;
  description: string;
  confirm: string;
  done: string;
};

/** PR/MR 写操作：合并下拉 + close/reopen/ready，统一走确认框。 */
const PrActions: FC<{
  item: InboxItem;
  detail: InboxExternalDetail;
  readOnly?: boolean;
  onDone?: () => void;
}> = ({ item, detail, readOnly, onDone }) => {
  const t = useT();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const pr = detail.pullRequest;
  const provider = item.external?.provider;
  if (
    readOnly ||
    !pr ||
    (provider !== "github" && provider !== "gitlab")
  ) {
    return null;
  }
  const state = (detail.state ?? "").toLowerCase();
  const merged = pr.merged === true || state === "merged";
  const closed = !merged && (state === "closed" || state === "locked");
  const open = !merged && !closed;
  const draft = pr.draft === true;
  const mergeBlocked =
    pr.mergeable === false ||
    /^(dirty|conflict|conflicting|cannot_be_merged)$/.test(
      (pr.mergeableState ?? "").toLowerCase(),
    );
  const base = pr.baseRef ?? t("inbox.pr.actions.defaultBase");

  const ask = (action: InboxPullRequestAction): void => {
    const method =
      action === "squash"
        ? t("inbox.pr.actions.squash")
        : action === "rebase"
          ? t("inbox.pr.actions.rebase")
          : t("inbox.pr.actions.mergeCommit");
    if (action === "merge" || action === "squash" || action === "rebase") {
      setPending({
        action,
        title: t("inbox.pr.actions.mergeTitle"),
        description: t("inbox.pr.actions.mergeDescription", {
          method,
          base,
        }),
        confirm: t("inbox.pr.actions.confirmMerge"),
        done: t("inbox.pr.actions.mergeDone"),
      });
      return;
    }
    if (action === "close") {
      setPending({
        action,
        title: t("inbox.pr.actions.closeTitle"),
        description: t("inbox.pr.actions.closeDescription"),
        confirm: t("inbox.pr.actions.confirmClose"),
        done: t("inbox.pr.actions.closeDone"),
      });
      return;
    }
    if (action === "reopen") {
      setPending({
        action,
        title: t("inbox.pr.actions.reopenTitle"),
        description: t("inbox.pr.actions.reopenDescription"),
        confirm: t("inbox.pr.actions.confirmReopen"),
        done: t("inbox.pr.actions.reopenDone"),
      });
      return;
    }
    setPending({
      action,
      title: t("inbox.pr.actions.readyTitle"),
      description: t("inbox.pr.actions.readyDescription"),
      confirm: t("inbox.pr.actions.confirmReady"),
      done: t("inbox.pr.actions.readyDone"),
    });
  };

  const run = async (): Promise<void> => {
    if (!pending || busy) return;
    const key = item.external?.key ?? "";
    if (!key) {
      toast.error(t("inbox.issue.noSource"));
      return;
    }
    setBusy(true);
    try {
      const result = await runInboxPullRequestAction({
        provider: provider as InboxConnectorProvider,
        key,
        ...(item.external?.type ? { type: item.external.type } : {}),
        ...(item.external?.externalId
          ? { externalId: item.external.externalId }
          : {}),
        ...(detail.pullRequest?.headSha
          ? { headSha: detail.pullRequest.headSha }
          : {}),
        action: pending.action,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(pending.done);
      setPending(null);
      onDone?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {open && !draft ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busy || mergeBlocked}
                title={
                  mergeBlocked ? t("inbox.pr.actions.mergeBlocked") : undefined
                }
              />
            }
          >
            <GitMergeIcon className="size-3.5" />
            {t("inbox.pr.actions.merge")}
            <ChevronDownIcon className="size-3 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => ask("merge")}>
              {t("inbox.pr.actions.mergeCommit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => ask("squash")}>
              {t("inbox.pr.actions.squash")}
            </DropdownMenuItem>
            {provider === "github" ? (
              <DropdownMenuItem onClick={() => ask("rebase")}>
                {t("inbox.pr.actions.rebase")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {open && draft ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => ask("ready_for_review")}
        >
          {t("inbox.pr.actions.ready")}
        </Button>
      ) : null}
      {open ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() => ask("close")}
        >
          {t("inbox.pr.actions.close")}
        </Button>
      ) : null}
      {closed ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => ask("reopen")}
        >
          {t("inbox.pr.actions.reopen")}
        </Button>
      ) : null}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("inbox.issue.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {busy
                ? t("inbox.pr.actions.working")
                : pending?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const PullRequestFacts: FC<{ pr: InboxExternalPullRequest }> = ({ pr }) => {
  const t = useT();
  const review: { label: string; tone: PillTone } | null =
    pr.reviewDecision === "approved"
      ? { label: t("inbox.pr.review.approved"), tone: "ok" }
      : pr.reviewDecision === "changes_requested"
        ? { label: t("inbox.pr.review.changesRequested"), tone: "bad" }
        : pr.reviewDecision === "review_required"
          ? { label: t("inbox.pr.review.required"), tone: "warn" }
          : null;
  const mergeable = mergeableLabel(pr, t);
  const changes =
    pr.additions !== undefined || pr.deletions !== undefined
      ? t("inbox.pr.changes", {
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          files: pr.changedFiles ?? 0,
        })
      : pr.changedFiles !== undefined
        ? t("inbox.pr.filesOnly", { files: pr.changedFiles })
        : null;

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      {pr.baseRef && pr.headRef ? (
        <span className="bg-muted/50 text-foreground/80 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 font-mono text-2xs">
          <GitCompareIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">
            {pr.baseRef} ← {pr.headRef}
          </span>
        </span>
      ) : null}
      {pr.draft ? <Pill tone="muted">{t("inbox.pr.draft")}</Pill> : null}
      {pr.merged ? <Pill tone="ok">{t("inbox.pr.merged")}</Pill> : null}
      {review ? <Pill tone={review.tone}>{review.label}</Pill> : null}
      {mergeable ? <Pill tone={mergeable.tone}>{mergeable.label}</Pill> : null}
      {changes ? <span>{changes}</span> : null}
    </div>
  );
};

type PillTone = "ok" | "warn" | "bad" | "muted";

const Pill: FC<{ tone: PillTone; children: ReactNode }> = ({
  tone,
  children,
}) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium",
      tone === "ok" &&
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      tone === "bad" &&
        "bg-destructive/10 text-destructive-strong dark:text-destructive",
      tone === "muted" && "bg-muted text-muted-foreground",
    )}
  >
    {children}
  </span>
);

function mergeableLabel(
  pr: InboxExternalPullRequest,
  t: ReturnType<typeof useT>,
): { label: string; tone: PillTone } | null {
  if (pr.merged) return null;
  const state = (pr.mergeableState ?? "").toLowerCase();
  if (
    state === "dirty" ||
    state === "conflict" ||
    state === "conflicting" ||
    state === "cannot_be_merged" ||
    pr.mergeable === false
  ) {
    return { label: t("inbox.pr.mergeable.conflict"), tone: "bad" };
  }
  if (
    state === "blocked" ||
    state === "blocked_status" ||
    state === "not_approved" ||
    state === "discussions_not_resolved"
  ) {
    return { label: t("inbox.pr.mergeable.blocked"), tone: "warn" };
  }
  if (
    state === "unstable" ||
    state === "behind" ||
    state === "has_hooks" ||
    state === "ci_still_running" ||
    state === "checking" ||
    state === "unchecked" ||
    state === "need_rebase" ||
    state === "draft" ||
    state === "preparing" ||
    state === "approvals_syncing"
  ) {
    return { label: t("inbox.pr.mergeable.pending"), tone: "warn" };
  }
  if (
    state === "clean" ||
    state === "mergeable" ||
    state === "can_be_merged" ||
    pr.mergeable === true
  ) {
    return { label: t("inbox.pr.mergeable.clean"), tone: "ok" };
  }
  return null;
}

const DiffPanel: FC<{
  state: ResourceState<InboxExternalDiff>;
  onRetry: () => void;
}> = ({ state, onRetry }) => {
  const t = useT();
  const { loading, data, error } = state;

  if (loading && !data) {
    return (
      <div className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 text-xs">
        <Loader2Icon className="size-4 animate-spin" />
        {t("inbox.pr.diff.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="border-destructive/20 bg-destructive/5 text-destructive-strong flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5"
      >
        <span className="min-w-0 flex-1">
          {t("inbox.pr.diff.failed", { message: error })}
        </span>
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onRetry}>
          {t("inbox.issue.retry")}
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const textual = data.files.filter((file) => !file.binary);
  const binary = data.files.length - textual.length;
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = data.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
        <span>
          {t("inbox.pr.diff.files", { count: data.files.length })}
        </span>
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
        <span className="text-destructive-strong dark:text-destructive">
          −{deletions}
        </span>
        {binary > 0 ? (
          <span>{t("inbox.pr.diff.binary", { count: binary })}</span>
        ) : null}
        {loading ? (
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
        ) : null}
      </div>
      {data.patch.trim() ? (
        <ErrorBoundary
          key={data.patch.length}
          label={t("inbox.pr.diff.viewLabel")}
          fallback={() => (
            <p className="text-muted-foreground text-xs">
              {t("inbox.pr.diff.renderFailed")}
            </p>
          )}
        >
          <PanelPatchDiff
            patch={data.patch}
            fileHeaders
            className="border-border/60 max-h-[70vh] overflow-auto rounded-lg border"
          />
        </ErrorBoundary>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("inbox.pr.diff.empty")}
        </p>
      )}
      {data.truncated ? (
        <p className="text-muted-foreground text-2xs">
          {t("inbox.pr.diff.truncated")}
        </p>
      ) : null}
    </div>
  );
};

const CHECK_ORDER: InboxExternalCheck["state"][] = [
  "fail",
  "pending",
  "cancel",
  "unknown",
  "pass",
  "skipping",
];

const ATTENTION_STATES = new Set<InboxExternalCheck["state"]>([
  "fail",
  "pending",
  "cancel",
  "unknown",
]);

const ChecksPanel: FC<{
  state: ResourceState<InboxExternalChecks>;
  onRetry: () => void;
  onFixChecks?: (checks: InboxExternalChecks) => void;
}> = ({ state, onRetry, onFixChecks }) => {
  const t = useT();
  const { loading, data, error } = state;
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const checks = data?.checks ?? [];
    const sorted = [...checks].sort(
      (a, b) =>
        CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) ||
        a.name.localeCompare(b.name),
    );
    const hasAttention = sorted.some((check) =>
      ATTENTION_STATES.has(check.state),
    );
    // 全部通过/跳过时没有「需要关注」可过滤，直接展示全部，避免误报「没有检查项」
    return showAll || !hasAttention
      ? sorted
      : sorted.filter((check) => ATTENTION_STATES.has(check.state));
  }, [data, showAll]);

  if (loading && !data) {
    return (
      <div className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 text-xs">
        <Loader2Icon className="size-4 animate-spin" />
        {t("inbox.pr.checks.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="border-destructive/20 bg-destructive/5 text-destructive-strong flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5"
      >
        <span className="min-w-0 flex-1">
          {t("inbox.pr.checks.failed", { message: error })}
        </span>
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onRetry}>
          {t("inbox.issue.retry")}
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const counts = { fail: 0, pending: 0, pass: 0, skipping: 0, cancel: 0, unknown: 0 };
  for (const check of data.checks) counts[check.state] += 1;
  const attention =
    counts.fail + counts.pending + counts.cancel + counts.unknown;
  const headline = counts.fail
    ? t("inbox.pr.checks.headlineFail", { count: counts.fail })
    : counts.pending
      ? t("inbox.pr.checks.headlinePending", { count: counts.pending })
      : attention
        ? t("inbox.pr.checks.headlineAttention", { count: attention })
        : counts.pass
          ? t("inbox.pr.checks.headlinePass")
          : data.checks.length > 0
            ? t("inbox.pr.checks.headlineSkipped")
            : t("inbox.pr.checks.headlineEmpty");
  const failedChecks = data.checks.filter((check) => check.state === "fail");

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{headline}</h3>
          {data.checks.length > 0 ? (
            <p className="text-muted-foreground mt-0.5 text-2xs">
              {t("inbox.pr.checks.summary", {
                pass: counts.pass,
                pending: counts.pending,
                fail: counts.fail,
                skipped: counts.skipping + counts.cancel,
              })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onFixChecks && failedChecks.length > 0 ? (
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              onClick={() => onFixChecks({ ...data, checks: failedChecks })}
            >
              <SparklesIcon className="size-3" />
              {t("inbox.pr.checks.fixWithAgent", { count: failedChecks.length })}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("inbox.pr.checks.refresh")}
            title={t("inbox.pr.checks.refresh")}
            disabled={loading}
            onClick={onRetry}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {attention > 0 ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={!showAll}
            onClick={() => setShowAll(false)}
            className={cn(
              "rounded-md px-2 py-0.5 text-2xs",
              showAll
                ? "text-muted-foreground hover:text-foreground"
                : "bg-muted text-foreground",
            )}
          >
            {t("inbox.pr.checks.attention")}
          </button>
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setShowAll(true)}
            className={cn(
              "rounded-md px-2 py-0.5 text-2xs",
              showAll
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t("inbox.pr.checks.all")}
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("inbox.pr.checks.noChecks")}
        </p>
      ) : (
        <ul className="divide-border/50 flex flex-col divide-y">
          {rows.map((check, index) => {
            const key = `${check.name}:${check.workflow ?? ""}:${index}`;
            const open = expanded.has(key);
            const hasOutput = Boolean(check.output?.trim());
            return (
              <li key={key} className="py-2">
                <div className="flex items-start gap-2">
                  <CheckStateIcon state={check.state} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium break-words">
                        {check.name}
                      </span>
                      {check.workflow ? (
                        <span className="text-muted-foreground text-2xs">
                          {check.workflow}
                        </span>
                      ) : null}
                      <span className="text-muted-foreground text-2xs">
                        {t(`inbox.pr.checks.state.${check.state}`)}
                      </span>
                    </div>
                    {check.description ? (
                      <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                        {check.description}
                      </p>
                    ) : null}
                    {hasOutput && open ? (
                      <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded-md px-2.5 py-2 text-xs leading-5 whitespace-pre-wrap">
                        {check.output}
                      </pre>
                    ) : null}
                    <div className="mt-1 flex items-center gap-3">
                      {hasOutput ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-2xs"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {open ? (
                            <ChevronDownIcon className="size-3" />
                          ) : (
                            <ChevronRightIcon className="size-3" />
                          )}
                          {open
                            ? t("inbox.pr.checks.hideOutput")
                            : t("inbox.pr.checks.showOutput")}
                        </button>
                      ) : null}
                      {check.detailsUrl ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-2xs"
                          onClick={() =>
                            check.detailsUrl &&
                            openExternal(check.detailsUrl)
                          }
                        >
                          <ExternalLinkIcon className="size-3" />
                          {t("inbox.pr.checks.openDetails")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data.truncated ? (
        <p className="text-muted-foreground text-2xs">
          {t("inbox.pr.checks.truncated")}
        </p>
      ) : null}
    </div>
  );
};

const CheckStateIcon: FC<{ state: InboxExternalCheck["state"] }> = ({
  state,
}) => {
  const className = "mt-0.5 size-4 shrink-0";
  switch (state) {
    case "pass":
      return (
        <CheckCircle2Icon
          className={cn(className, "text-emerald-600 dark:text-emerald-400")}
        />
      );
    case "fail":
      return <XCircleIcon className={cn(className, "text-destructive")} />;
    case "pending":
      return (
        <CircleDashedIcon
          className={cn(className, "text-amber-600 dark:text-amber-400")}
        />
      );
    case "cancel":
    case "skipping":
      return <MinusCircleIcon className={cn(className, "text-muted-foreground")} />;
    default:
      return <AlertCircleIcon className={cn(className, "text-muted-foreground")} />;
  }
};
