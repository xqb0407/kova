"use client";

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import type {
  InboxConnectorProvider,
  InboxExternalChecks,
  InboxExternalComment,
  InboxExternalDetail,
  InboxItem,
} from "pi-protocol";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  BotIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MailIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  PROVIDER_META,
  ProviderMark,
} from "@/components/custom-ui/provider-glyph";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { requestSettingsSection } from "@/lib/connector-nav";
import { openExternal } from "@/lib/external-link";
import { fetchInboxExternalDetail, postInboxExternalComment, updateInboxConnectorPrefs, useInboxConnectors } from "@/lib/inbox/connectors";
import { relativeTime } from "@/lib/inbox/format";
import {
  matchProject,
  relatedSessionsForProject,
} from "@/lib/inbox/related-projects";
import type { SnoozePreset } from "@/lib/inbox/snooze";
import {
  piSessionCwdMap,
  piSessionIdForThread,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import {
  sentAgentLinkOf,
  subscribeSentAgent,
} from "@/lib/inbox/sent-agent";
import { requestOpenChat } from "@/lib/pi/open-chat";
import { requestOpenSession } from "@/lib/pi/open-session";
import {
  projectDisplayName,
  useProjectRegistry,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { emojify } from "node-emoji";
import { ExternalPrReview } from "./external-pr-review";

/** GitHub 常见短代码别名，node-emoji 未收录的部分补在这里 */
const GITHUB_EMOJI_FALLBACK: Record<string, string> = {
  book: "📖",
  thumbsup: "👍",
  thumbsdown: "👎",
};

/** 把 GitHub 正文/评论里的 :shortcode: 转成 emoji，跳过代码块和行内代码 */
const emojifyGithubMarkdown = (text: string): string =>
  text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : emojify(
            part.replace(
              /:([a-z0-9_+-]+):/gi,
              (match, name: string) =>
                GITHUB_EMOJI_FALLBACK[name.toLowerCase()] ?? match,
            ),
          ),
    )
    .join("");

/** 作者头像；加载失败或没有 URL 时退回首字母圆片 */
const AuthorAvatar: FC<{
  url?: string;
  name?: string;
  className?: string;
}> = ({ url, name, className }) => {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn(
          "bg-muted size-5 shrink-0 rounded-full object-cover",
          className,
        )}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={cn(
        "bg-background text-foreground/70 border-border/60 grid size-5 shrink-0 place-items-center rounded-full border text-3xs font-semibold",
        className,
      )}
    >
      {(name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
};

/** GitHub 未返回头像 URL 时，用 github.com 的用户头像端点兜底（仅限公共 GitHub） */
const githubAvatarUrl = (
  sourceUrl: string | undefined,
  author?: string,
  explicit?: string,
): string | undefined => {
  if (explicit) return explicit;
  if (!sourceUrl || !author) return undefined;
  try {
    const host = new URL(sourceUrl).hostname;
    if (host === "github.com" || host === "www.github.com") {
      return `https://github.com/${encodeURIComponent(author)}.png?size=96`;
    }
  } catch {
    // sourceUrl 不是合法 URL 时不兜底
  }
  return undefined;
};

/**
 * 右侧阅读窗：外部 issue 详情。
 *
 * 只读事实源在 provider；这里选中条目时按需拉正文/评论（主进程缓存 60s）。
 * 「交给 Agent」把 issue 上下文交给新会话，项目下拉决定新会话的工作区。
 */

export type SendToAgentMode = "send" | "ask" | "repair";

type Props = {
  item: InboxItem;
  readOnly: boolean;
  onArchive: (item: InboxItem, archived: boolean) => Promise<void> | void;
  onMarkUnread: (item: InboxItem) => Promise<void> | void;
  /** 打开链接/交给 Agent 也算查看：显式动作时清组内未读 */
  onMarkRead: (item: InboxItem) => Promise<void> | void;
  onRequestDelete: (item: InboxItem) => void;
  /** 稍后提醒；null = 取消。只在可写视图传入 */
  onSnooze?: (item: InboxItem, preset: SnoozePreset | null) => void;
  onSendToAgent: (
    item: InboxItem,
    detail: InboxExternalDetail | null,
    mode: SendToAgentMode,
    project: ProjectRecord | null,
    checks?: InboxExternalChecks,
  ) => Promise<void> | void;
};

const TYPE_KEYS: Record<string, string> = {
  issue: "issue",
  pull_request: "pullRequest",
  merge_request: "mergeRequest",
  ticket: "ticket",
  discussion: "discussion",
  release: "release",
  commit: "commit",
};

function typeLabel(
  type: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!type) return "";
  const key = TYPE_KEYS[type];
  if (!key) return type;
  const full = `inbox.issue.types.${key}`;
  const text = t(full);
  return text === full ? type : text;
}

function reasonLabel(
  reason: string | undefined,
  t: ReturnType<typeof useT>,
): string | undefined {
  if (!reason) return undefined;
  const full = `inbox.reasons.${reason}`;
  const text = t(full);
  return text === full ? reason : text;
}

function statusTone(state: string | undefined): string {
  const value = (state ?? "").toLowerCase();
  if (/done|closed|completed|merged|resolved/.test(value)) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
  if (/progress|started|review|in review|todo/.test(value)) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
  if (/open|backlog|unresolved/.test(value)) {
    return "bg-sky-500/10 text-sky-700 dark:text-sky-400";
  }
  return "bg-muted text-muted-foreground";
}

const KV: FC<{ label: string; children: ReactNode; mono?: boolean }> = ({
  label,
  children,
  mono,
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-muted-foreground text-2xs">{label}</span>
    <span className={cn("text-sm", mono && "font-mono text-xs")}>
      {children}
    </span>
  </div>
);

export const ExternalIssueDetail: FC<Props> = ({
  item,
  readOnly,
  onArchive,
  onMarkUnread,
  onMarkRead,
  onRequestDelete,
  onSnooze,
  onSendToAgent,
}) => {
  const t = useT();
  const external = item.external;
  const provider = (external?.provider ?? "external") as InboxConnectorProvider;
  const providerLabel = PROVIDER_META[provider]?.label ?? provider;
  const projects = useProjectRegistry();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentPosting, setCommentPosting] = useState(false);
  const [replyToComment, setReplyToComment] = useState<{
    id: string;
    author?: string;
    nativeReplyId?: string;
  } | null>(null);
  const [state, setState] = useState<{
    loading: boolean;
    detail: InboxExternalDetail | null;
    error: string | null;
  }>({ loading: true, detail: null, error: null });

  const defaultProject = useMemo(
    () => matchProject(item, projects),
    [item, projects],
  );
  useEffect(() => {
    setProjectId(defaultProject?.id ?? null);
  }, [item.id, defaultProject?.id]);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const threadItems = useThreadItems();
  // cwd 来自 piSessionCwdMap（普通 Map，不在 threadItems 里）：摘要/cwd 更新
  // 需要这个版本号参与依赖，否则相关会话会一直停在空列表。
  const sessionPrefsVersion = useSessionPrefsVersion();
  const relatedSessions = useMemo(
    () =>
      relatedSessionsForProject(defaultProject, threadItems, piSessionCwdMap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultProject, threadItems, sessionPrefsVersion],
  );

  useEffect(() => {
    const key = external?.key;
    if (!key) {
      setState({
        loading: false,
        detail: null,
        error: t("inbox.issue.noSource"),
      });
      return;
    }
    let alive = true;
    /** 详情请求可能卡在网络上；超时后转错误态，避免一直停在空加载 */
    const timer = setTimeout(() => {
      if (!alive) return;
      alive = false;
      setState({
        loading: false,
        detail: null,
        error: t("inbox.issue.detailTimeout"),
      });
    }, 15_000);
    setState((prev) => ({ loading: true, detail: prev.detail, error: null }));
    void fetchInboxExternalDetail({
      provider,
      key,
      ...(external?.type ? { type: external.type } : {}),
      ...(external?.externalId ? { externalId: external.externalId } : {}),
    })
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setState({ loading: false, detail: result.detail, error: null });
        } else {
          setState({
            loading: false,
            detail: null,
            error: result.message,
          });
        }
      })
      .catch((error) => {
        if (!alive) return;
        setState({
          loading: false,
          detail: null,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timer);
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    item.id,
    provider,
    external?.key,
    external?.type,
    external?.externalId,
    reload,
    t,
  ]);

  const detail = state.detail;
  const title = detail?.title ?? item.title;
  const status = detail?.state ?? external?.status;
  const reason = reasonLabel(
    external?.reason ??
      (typeof item.meta?.reason === "string" ? item.meta.reason : undefined),
    t,
  );
  const url = detail?.url ?? external?.url ?? item.deepLink?.url;
  const updatedAt = detail?.updatedAt ?? item.updatedAt;
  const canArchive = !item.archivedAt && item.actions.includes("archive");
  const canUnarchive = Boolean(item.archivedAt);
  const canDelete = item.state !== "open";
  /** 「交给 Agent」的回链：能换出 sessionId 就开对应会话，否则按线程 id 切。
   *  localStorage 不是响应式源，挂一条订阅让发送侧的写入能刷出「查看会话」 */
  const [sentLink, setSentLink] = useState(() => sentAgentLinkOf(item.id));
  useEffect(() => {
    setSentLink(sentAgentLinkOf(item.id));
    return subscribeSentAgent(() => setSentLink(sentAgentLinkOf(item.id)));
  }, [item.id]);
  const aui = useAui();
  const connectors = useInboxConnectors();
  const connectorId =
    typeof item.meta?.connectorId === "string"
      ? item.meta.connectorId
      : provider;
  const connector =
    connectors.connectors.find((entry) => entry.id === connectorId) ??
    connectors.connectors.find((entry) => entry.provider === provider);
  const sourceName = external?.sourceName?.trim() ?? "";
  const sourceMuted = Boolean(
    sourceName &&
      connector?.mutedSources?.some(
        (entry) => entry.toLowerCase() === sourceName.toLowerCase(),
      ),
  );

  const toggleSourceMute = async () => {
    if (!connector || !sourceName) return;
    const current = connector.mutedSources ?? [];
    const next = sourceMuted
      ? current.filter(
          (entry) => entry.toLowerCase() !== sourceName.toLowerCase(),
        )
      : [...current, sourceName];
    try {
      await updateInboxConnectorPrefs({
        id: connector.id,
        mutedSources: next,
      });
      toast.success(
        t(
          sourceMuted
            ? "inbox.issue.unmuteSourceDone"
            : "inbox.issue.muteSourceDone",
        ),
      );
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const openAgentThread = () => {
    if (!sentLink) {
      toast.info(t("inbox.issue.agentThreadMissing"));
      return;
    }
    const sessionId = piSessionIdForThread(sentLink.threadId);
    if (sessionId) {
      requestOpenSession(sessionId, { unarchive: false });
      return;
    }
    requestOpenChat();
    Promise.resolve(aui.threads.switchToThread(sentLink.threadId)).catch(() =>
      toast.info(t("inbox.issue.agentThreadMissing")),
    );
  };

  const doOpen = () => {
    if (!url) {
      toast.info(t("inbox.issue.noLink"));
      return;
    }
    void onMarkRead(item);
    openExternal(url);
  };

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("inbox.issue.linkCopied"));
    } catch {
      toast.error(t("inbox.issue.copyFailed"));
    }
  };

  const send = (mode: SendToAgentMode) => {
    void onMarkRead(item);
    void onSendToAgent(item, detail, mode, project);
  };

  /** checks 面板的「交给 Agent 修复」：只创建本地会话，不写回 PR */
  const fixChecks = (checks: InboxExternalChecks) => {
    void onMarkRead(item);
    void onSendToAgent(item, detail, "repair", project, checks);
  };

  const replyTarget = (comment: InboxExternalComment): void => {
    setReplyToComment({
      id: comment.id,
      author: comment.author,
      ...(comment.replyToId ? { nativeReplyId: comment.replyToId } : {}),
    });
    setCommentDraft((current) => {
      if (current.trim()) return current;
      // 有平台原生父评论 id 时走线程回复；否则用引用行保证上下文不丢。
      return comment.replyToId ? "" : `> @${comment.author ?? ""}\n\n`;
    });
  };

  const submitComment = async (): Promise<void> => {
    const body = commentDraft.trim();
    if (!body || commentPosting) return;
    const key = external?.key;
    if (!key) {
      toast.info(t("inbox.issue.noSource"));
      return;
    }
    setCommentPosting(true);
    try {
      const result = await postInboxExternalComment({
        provider,
        key,
        ...(external?.type ? { type: external.type } : {}),
        ...(external?.externalId
          ? { externalId: external.externalId }
          : {}),
        body,
        ...(replyToComment?.nativeReplyId
          ? { replyToId: replyToComment.nativeReplyId }
          : {}),
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setCommentDraft("");
      setReplyToComment(null);
      void onMarkRead(item);
      toast.success(t("inbox.issue.commentPosted"));
      setReload((value) => value + 1);
    } catch (error) {
      toast.error(
        t("inbox.error.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setCommentPosting(false);
    }
  };

  const bodySection = detail?.body ? (
    <div className="max-w-[72ch] text-[length:var(--chat-font-size)] leading-7">
      <MarkdownText text={emojifyGithubMarkdown(detail.body)} />
    </div>
  ) : !state.loading && !state.error ? (
    <div className="text-muted-foreground text-sm leading-6">
      {item.summary || t("inbox.issue.noBody")}
    </div>
  ) : null;

  const truncatedNote = detail?.truncated ? (
    <p className="text-muted-foreground mt-4 text-2xs">
      {t("inbox.issue.truncated")}
    </p>
  ) : null;

  /** Discussion/Release/Commit 没有走当前的 issue comment 端点，隐藏输入框 */
  const canComment =
    provider !== "github" ||
    !external?.type ||
    external.type === "issue" ||
    external.type === "pull_request";

  const commentsSection = detail && !state.loading ? (
    <section className="mt-7 border-t pt-4">
      <h3 className="text-sm font-semibold">
        {t("inbox.issue.comments", {
          count: detail.comments?.length ?? 0,
        })}
      </h3>
      {detail.comments && detail.comments.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-2">
          {detail.comments.map((comment) => (
            <div
              key={comment.id}
              className="bg-muted/20 border-border/50 rounded-lg border px-3 py-2.5"
            >
              <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
                <AuthorAvatar
                  url={githubAvatarUrl(
                    comment.url ?? detail?.url,
                    comment.author,
                    comment.avatarUrl,
                  )}
                  name={comment.author}
                />
                <span className="text-foreground/80 font-medium">
                  {comment.author ?? t("inbox.issue.unknownAuthor")}
                </span>
                {comment.createdAt ? (
                  <>
                    <span>·</span>
                    <span>{relativeTime(comment.createdAt, t)}</span>
                  </>
                ) : null}
                {!readOnly && canComment ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground ml-auto text-2xs"
                    onClick={() => replyTarget(comment)}
                  >
                    {t("inbox.issue.reply")}
                  </button>
                ) : null}
              </div>
              <div className="mt-1.5 max-w-[72ch] text-sm leading-6">
                <MarkdownText text={emojifyGithubMarkdown(comment.body)} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("inbox.issue.noComments")}
        </p>
      )}
      {!readOnly && canComment && external?.key ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitComment();
          }}
        >
          {replyToComment ? (
            <div className="text-muted-foreground flex items-center gap-2 text-2xs">
              <span className="min-w-0 truncate">
                {t("inbox.issue.replyingTo", {
                  author:
                    replyToComment.author ?? t("inbox.issue.unknownAuthor"),
                })}
              </span>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => {
                  const quote = `> @${replyToComment.author ?? ""}\n\n`;
                  setReplyToComment(null);
                  setCommentDraft((current) =>
                    current === quote ? "" : current,
                  );
                }}
              >
                {t("inbox.issue.cancelReply")}
              </button>
            </div>
          ) : null}
          <Textarea
            value={commentDraft}
            rows={3}
            disabled={commentPosting}
            placeholder={t("inbox.issue.commentPlaceholder")}
            aria-label={t("inbox.issue.commentPlaceholder")}
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                void submitComment();
              }
            }}
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={commentPosting || !commentDraft.trim()}
            >
              {commentPosting
                ? t("inbox.issue.commentPosting")
                : t("inbox.issue.commentSubmit")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  ) : null;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col gap-0 px-4 py-7 sm:px-8">
      <div className="relative flex items-start gap-3">
        <ProviderMark provider={provider} className="mt-0.5 size-[18px]" />
        <div className="min-w-0 flex-1 pr-9">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-foreground/70 font-medium">
              {typeLabel(external?.type, t) || providerLabel}
            </span>
            {external?.key ? <span>{external.key}</span> : null}
            {status ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium",
                  statusTone(status),
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {status}
              </span>
            ) : null}
            {detail?.assignee ? (
              <span className="inline-flex items-center gap-1">
                <span className="bg-muted text-muted-foreground grid size-4 place-items-center rounded-full text-3xs font-bold">
                  {detail.assignee.slice(0, 1).toUpperCase()}
                </span>
                {detail.assignee}
              </span>
            ) : null}
          </div>

          <h1 className="cn-font-heading mt-1.5 text-xl leading-[1.4] font-semibold tracking-tight break-words">
            {title}
          </h1>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            {reason ? <span>{reason}</span> : null}
            {reason && detail?.author ? (
              <span className="text-muted-foreground">·</span>
            ) : null}
            {detail?.author ? (
              <span className="flex items-center gap-1.5">
                <AuthorAvatar
                  url={githubAvatarUrl(
                    detail.url,
                    detail.author,
                    detail.avatarUrl,
                  )}
                  name={detail.author}
                  className="size-4 text-3xs"
                />
                <span>{detail.author}</span>
              </span>
            ) : null}
            {reason || detail?.author ? (
              <span className="text-muted-foreground">·</span>
            ) : null}
            <span>{relativeTime(updatedAt, t)}</span>
            {sentLink ? (
              <>
                <span className="text-muted-foreground">·</span>
                <span>{t("inbox.issue.sentBadge")}</span>
              </>
            ) : null}
          </div>
          {detail?.labels?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {detail.labels.map((label) => (
                <span
                  key={label}
                  className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-2xs"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          {relatedSessions.length > 0 ? (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground shrink-0 text-2xs">
                {t("inbox.issue.relatedSessions")}
              </span>
              {relatedSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  title={session.title}
                  onClick={() =>
                    requestOpenSession(session.id, { unarchive: false })
                  }
                  className="bg-muted/60 text-foreground/75 hover:bg-muted hover:text-foreground inline-flex max-w-56 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs"
                >
                  <MessageSquareIcon className="size-3 shrink-0" />
                  <span className="truncate">{session.title}</span>
                </button>
              ))}
            </div>
          ) : null}
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
              {sentLink ? (
                <DropdownMenuItem onClick={openAgentThread}>
                  <BotIcon className="size-4" />
                  {t("inbox.issue.openAgentThread")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => void onMarkUnread(item)}>
                <MailIcon className="size-4" />
                {t("inbox.row.markUnread")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copyLink()} disabled={!url}>
                <CopyIcon className="size-4" />
                {t("inbox.issue.copyLink")}
              </DropdownMenuItem>
              {connector && sourceName ? (
                <DropdownMenuItem onClick={() => void toggleSourceMute()}>
                  {sourceMuted ? (
                    <BellIcon className="size-4" />
                  ) : (
                    <BellOffIcon className="size-4" />
                  )}
                  {t(
                    sourceMuted
                      ? "inbox.issue.unmuteSource"
                      : "inbox.issue.muteSource",
                  )}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {onSnooze && !readOnly ? (
                <>
                  <DropdownMenuItem onClick={() => onSnooze(item, "1h")}>
                    <ClockIcon className="size-4" />
                    {t("inbox.row.snooze1h")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onSnooze(item, "tomorrow")}>
                    <ClockIcon className="size-4" />
                    {t("inbox.row.snoozeTomorrow")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onSnooze(item, "1w")}>
                    <ClockIcon className="size-4" />
                    {t("inbox.row.snooze1w")}
                  </DropdownMenuItem>
                  {item.snoozedUntil ? (
                    <DropdownMenuItem onClick={() => onSnooze(item, null)}>
                      <ClockIcon className="size-4" />
                      {t("inbox.row.unsnooze")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                </>
              ) : null}
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
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onRequestDelete(item)}
                >
                  <Trash2Icon className="size-4" />
                  {t("inbox.row.delete")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <Button className="gap-1.5" onClick={() => send("send")}>
            <SparklesIcon className="size-4" />
            {t("inbox.issue.sendToAgent")}
          </Button>
        ) : null}
        {!readOnly && projects.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  className="w-44 min-w-0 justify-between gap-1.5"
                  title={
                    project
                      ? projectDisplayName(project)
                      : t("inbox.issue.currentWorkspace")
                  }
                />
              }
            >
              <span className="truncate">
                {project
                  ? projectDisplayName(project)
                  : t("inbox.issue.currentWorkspace")}
              </span>
              <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
              <DropdownMenuItem onClick={() => setProjectId(null)}>
                {t("inbox.issue.currentWorkspace")}
                {!project ? <span className="ml-auto">✓</span> : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {projects.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onClick={() => setProjectId(entry.id)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {projectDisplayName(entry)}
                  </span>
                  {entry.id === projectId ? <span>✓</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {!readOnly ? (
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => send("ask")}
          >
            <MessageSquareIcon className="size-4" />
            {t("inbox.issue.ask")}
          </Button>
        ) : null}
        <Button
          variant="link"
          className="text-muted-foreground gap-1.5"
          onClick={doOpen}
          disabled={!url}
        >
          <ExternalLinkIcon className="size-4" />
          {t("inbox.issue.openIn", { provider: providerLabel })}
        </Button>
      </div>

      <div className="bg-border my-4 h-px" />

      {state.loading && !detail ? (
        <div
          className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-2 text-xs"
          role="status"
          aria-label={t("inbox.detail.loading")}
        >
          <Loader2Icon className="size-4 animate-spin" />
          <span>{t("inbox.detail.loading")}</span>
        </div>
      ) : null}

      {state.error ? (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/5 text-destructive-strong flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5"
        >
          <span className="min-w-0 flex-1">
            {t("inbox.issue.detailFailed", { message: state.error })}
          </span>
          {/接入|连接|Token|token|auth|权限|凭证/.test(state.error) ? (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 gap-1"
              onClick={() => requestSettingsSection("inbox-sources")}
            >
              <ExternalLinkIcon className="size-3" />
              {t("inbox.issue.connectSource")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 gap-1"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCwIcon className="size-3" />
            {t("inbox.issue.retry")}
          </Button>
        </div>
      ) : null}

      {detail?.pullRequest ? (
        <ExternalPrReview
          item={item}
          detail={detail}
          summary={
            <>
              {bodySection}
              {truncatedNote}
              {commentsSection}
            </>
          }
          onFixChecks={readOnly ? undefined : fixChecks}
          readOnly={readOnly}
          onActionDone={() => {
            void onMarkRead(item);
            setReload((value) => value + 1);
          }}
        />
      ) : (
        <>
          {bodySection}
          {truncatedNote}
          {commentsSection}
        </>
      )}
    </div>
  );
};
