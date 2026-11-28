"use client";

import { useEffect, useState, type FC, type ReactNode } from "react";
import type {
  InboxConnectorConfig,
  InboxConnectorEvents,
  InboxConnectorProvider,
  InboxConnectorSaveInput,
  InboxConnectorStatus,
  InboxConnectorTestResult,
} from "pi-protocol";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ProviderMark,
  ProviderGlyph,
} from "@/components/custom-ui/provider-glyph";
import { AnimatedBadge } from "@/components/custom-ui/animated-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { toast } from "@/components/ui/toast";
import { isDesktop } from "@/lib/desktop-env";
import { openExternal } from "@/lib/external-link";
import {
  deleteInboxConnector,
  initInboxConnectors,
  saveInboxConnector,
  syncInboxConnector,
  testInboxConnector,
  updateInboxConnectorPrefs,
  useInboxConnectors,
} from "@/lib/inbox/connectors";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 设置 → 收件箱。
 *
 * 四个平台一张卡片，一个平台一个账号；Token 只写入主进程（加密落库），
 * 这里永远拿不到 Token 本体，只显示末四位提示。
 */

type EventKey = keyof InboxConnectorEvents;

type ProviderMeta = {
  id: InboxConnectorProvider;
  name: string;
  descriptionKey: string;
  tokenUrl: string;
  tokenScopeKey: string;
  needsBaseUrl: boolean;
  baseUrlPlaceholderKey?: string;
  isJira?: boolean;
  eventKeys?: EventKey[];
  defaultEvents: InboxConnectorEvents;
};

const PROVIDERS: ProviderMeta[] = [
  {
    id: "github",
    name: "GitHub",
    descriptionKey: "settings.inboxSources.providers.github.description",
    tokenUrl:
      "https://github.com/settings/tokens/new?scopes=notifications&description=Kova%20Inbox",
    tokenScopeKey: "settings.inboxSources.providers.github.scope",
    needsBaseUrl: true,
    baseUrlPlaceholderKey:
      "settings.inboxSources.providers.github.baseUrlPlaceholder",
    eventKeys: ["assigned", "reviewRequested", "mention"],
    defaultEvents: {
      assigned: true,
      reviewRequested: true,
      mention: true,
    },
  },
  {
    id: "gitlab",
    name: "GitLab",
    descriptionKey: "settings.inboxSources.providers.gitlab.description",
    tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    tokenScopeKey: "settings.inboxSources.providers.gitlab.scope",
    needsBaseUrl: true,
    baseUrlPlaceholderKey:
      "settings.inboxSources.providers.gitlab.baseUrlPlaceholder",
    eventKeys: [
      "assigned",
      "reviewRequested",
      "mention",
      "unmergeable",
      "buildFailed",
    ],
    defaultEvents: {
      assigned: true,
      reviewRequested: true,
      mention: true,
      unmergeable: true,
      buildFailed: false,
    },
  },
  {
    id: "jira",
    name: "Jira",
    descriptionKey: "settings.inboxSources.providers.jira.description",
    tokenUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    tokenScopeKey: "settings.inboxSources.providers.jira.scope",
    needsBaseUrl: true,
    baseUrlPlaceholderKey:
      "settings.inboxSources.providers.jira.baseUrlPlaceholder",
    isJira: true,
    defaultEvents: { assigned: true },
  },
  {
    id: "linear",
    name: "Linear",
    descriptionKey: "settings.inboxSources.providers.linear.description",
    tokenUrl: "https://linear.app/settings/account/security",
    tokenScopeKey: "settings.inboxSources.providers.linear.scope",
    needsBaseUrl: false,
    defaultEvents: { assigned: true },
  },
];

const POLL_OPTIONS = [60, 120, 300, 900] as const;

type MuteHours = 0 | 1 | 8 | 24;

type Draft = {
  baseUrl: string;
  account: string;
  authMode: "cloud" | "server";
  jql: string;
  token: string;
  events: InboxConnectorEvents;
  pollIntervalSec: number;
  desktopNotifications: boolean;
  notifyIssues: boolean;
  notifyPullRequests: boolean;
  /** 用户没动过静音选项时保留原 ISO，避免把 2 小时静音“取整”成 8/24 小时 */
  mutedUntil: string | null;
  muteTouched: boolean;
  muteHours: MuteHours;
};

/** 已存静音换算成最接近的预设；过期/缺失 = 不静音。 */
function muteHoursOf(connector: InboxConnectorConfig | undefined): MuteHours {
  const until = connector?.mutedUntil ? Date.parse(connector.mutedUntil) : NaN;
  if (!Number.isFinite(until) || until <= Date.now()) return 0;
  const hours = (until - Date.now()) / 3_600_000;
  if (hours <= 1.5) return 1;
  if (hours <= 9) return 8;
  return 24;
}

function defaultDraft(
  meta: ProviderMeta,
  connector: InboxConnectorConfig | undefined,
): Draft {
  return {
    baseUrl: connector?.baseUrl ?? "",
    account: connector?.account ?? "",
    authMode: connector?.authMode ?? "cloud",
    jql: connector?.jql ?? "",
    token: "",
    events: { ...meta.defaultEvents, ...connector?.events },
    pollIntervalSec: connector?.pollIntervalSec ?? 120,
    desktopNotifications: connector?.desktopNotifications !== false,
    notifyIssues: connector?.notifyIssues !== false,
    notifyPullRequests: connector?.notifyPullRequests !== false,
    mutedUntil: connector?.mutedUntil ?? null,
    muteTouched: false,
    muteHours: muteHoursOf(connector),
  };
}

function configToInput(
  connector: InboxConnectorConfig,
  patch: Partial<InboxConnectorSaveInput> = {},
): InboxConnectorSaveInput {
  return {
    id: connector.id,
    provider: connector.provider,
    enabled: connector.enabled,
    baseUrl: connector.baseUrl,
    account: connector.account,
    authMode: connector.authMode,
    events: connector.events,
    jql: connector.jql,
    pollIntervalSec: connector.pollIntervalSec,
    desktopNotifications: connector.desktopNotifications,
    ...patch,
  };
}

function relativeTime(
  iso: string | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return t("inbox.time.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("inbox.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("inbox.time.hoursAgo", { n: hours });
  return t("inbox.time.daysAgo", { n: Math.floor(hours / 24) });
}

const Field: FC<{
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}> = ({ label, hint, children }) => (
  <div className="flex flex-col gap-1.5">
    <div className="text-sm font-medium">{label}</div>
    {children}
    {hint ? (
      <p className="text-muted-foreground text-ui leading-5">{hint}</p>
    ) : null}
  </div>
);

export const InboxSourcesSettings: FC = () => {
  const t = useT();
  const view = useInboxConnectors();
  const [editing, setEditing] = useState<{
    meta: ProviderMeta;
    connector?: InboxConnectorConfig;
  } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<InboxConnectorTestResult | null>(
    null,
  );
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InboxConnectorConfig | null>(
    null,
  );

  useEffect(() => {
    void initInboxConnectors();
  }, []);

  const statusOf = (id: string): InboxConnectorStatus | undefined =>
    view.statuses.find((status) => status.id === id);

  const openEditor = (
    meta: ProviderMeta,
    connector: InboxConnectorConfig | undefined,
  ) => {
    const next = defaultDraft(meta, connector);
    setEditing({ meta, connector });
    setDraft(next);
    setTestResult(null);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditing(null);
    setDraft(null);
    setTestResult(null);
  };

  const handleToggle = async (
    meta: ProviderMeta,
    connector: InboxConnectorConfig,
    enabled: boolean,
  ) => {
    setTogglingId(connector.id);
    try {
      await saveInboxConnector(configToInput(connector, { enabled }));
    } catch (error) {
      toast.error(
        t("settings.inboxSources.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setTogglingId(null);
    }
  };

  const handleSync = async (connector: InboxConnectorConfig) => {
    setSyncingId(connector.id);
    try {
      const result = await syncInboxConnector(connector.id);
      if (result.status.state === "needs_auth") {
        toast.error(
          result.status.lastError ??
            t("settings.inboxSources.status.needsAuth"),
        );
      } else if (result.status.state === "error") {
        toast.error(
          result.status.lastError ?? t("settings.inboxSources.status.error"),
        );
      } else {
        toast.success(
          t("settings.inboxSources.syncSuccess", {
            count: result.items,
            added: result.added,
          }),
        );
      }
    } catch (error) {
      toast.error(
        t("settings.inboxSources.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSyncingId(null);
    }
  };

  /** 已连接卡片的「检查」= 真的立即同步一轮：网络抖动/代理重启后点一下就恢复，
   *  状态（上次同步/错误）也由同步结果刷新；只读探测留给配置弹窗里的「测试连接」 */
  const handleCheck = async (connector: InboxConnectorConfig) => {
    setCheckingId(connector.id);
    try {
      const result = await syncInboxConnector(connector.id);
      if (result.status.state === "needs_auth") {
        toast.error(
          result.status.lastError ??
            t("settings.inboxSources.status.needsAuth"),
        );
      } else if (result.status.state === "error") {
        toast.error(
          result.status.lastError ?? t("settings.inboxSources.status.error"),
        );
      } else {
        toast.success(
          t("settings.inboxSources.syncSuccess", {
            count: result.items,
            added: result.added,
          }),
        );
      }
    } catch (error) {
      toast.error(
        t("settings.inboxSources.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setCheckingId(null);
    }
  };

  const handleTest = async () => {
    if (!editing || !draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testInboxConnector({
        id: editing.connector?.id,
        provider: editing.meta.id,
        baseUrl: draft.baseUrl.trim() || undefined,
        account: draft.account.trim() || undefined,
        authMode: editing.meta.isJira ? draft.authMode : undefined,
        jql: editing.meta.isJira ? draft.jql.trim() || undefined : undefined,
        token: draft.token.trim() || undefined,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!editing || !draft) return;
    setSaving(true);
    try {
      const token = draft.token.trim();
      const snapshot = await saveInboxConnector({
        id: editing.connector?.id,
        provider: editing.meta.id,
        enabled: editing.connector?.enabled ?? true,
        baseUrl: draft.baseUrl.trim() || undefined,
        account: draft.account.trim() || undefined,
        authMode: editing.meta.isJira ? draft.authMode : undefined,
        jql: editing.meta.isJira ? draft.jql.trim() || undefined : undefined,
        events: editing.meta.eventKeys ? draft.events : undefined,
        pollIntervalSec: draft.pollIntervalSec,
        desktopNotifications: draft.desktopNotifications,
        ...(token ? { token } : {}),
      });
      // 通知偏好独立保存：避免保存连接配置时把静音/分类开关重置
      const saved = snapshot.connectors.find(
        (connector) => connector.provider === editing.meta.id,
      );
      if (saved) {
        const mutedUntil = draft.muteTouched
          ? draft.muteHours > 0
            ? new Date(
                Date.now() + draft.muteHours * 3_600_000,
              ).toISOString()
            : null
          : draft.mutedUntil && Date.parse(draft.mutedUntil) > Date.now()
            ? draft.mutedUntil
            : null;
        await updateInboxConnectorPrefs({
          id: saved.id,
          notifyIssues: draft.notifyIssues,
          notifyPullRequests: draft.notifyPullRequests,
          mutedUntil,
        });
      }
      toast.success(
        t(
          editing.connector
            ? "settings.inboxSources.saved"
            : "settings.inboxSources.connected",
          { name: editing.meta.name },
        ),
      );
      setEditing(null);
      setDraft(null);
      setTestResult(null);
    } catch (error) {
      toast.error(
        t("settings.inboxSources.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await deleteInboxConnector(target.id);
      toast.success(
        t("settings.inboxSources.disconnected", {
          name:
            PROVIDERS.find((provider) => provider.id === target.provider)
              ?.name ?? target.provider,
        }),
      );
    } catch (error) {
      toast.error(
        t("settings.inboxSources.saveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  if (!isDesktop()) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="text-muted-foreground max-w-sm text-center text-sm leading-6">
          {t("settings.inboxSources.desktopOnly")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.inboxSources.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            {t("settings.inboxSources.subtitle")}
          </p>
        </div>

        {view.error ? (
          <p className="text-destructive text-xs leading-5">
            {t("settings.inboxSources.loadFailed", { message: view.error })}
          </p>
        ) : null}

        <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        {PROVIDERS.map((meta) => {
          const connector = view.connectors.find(
            (item) => item.provider === meta.id,
          );
          const status = connector ? statusOf(connector.id) : undefined;
          const state = connector
            ? !connector.enabled
              ? "disabled"
              : (status?.state ?? "idle")
            : "not_connected";
          const syncing = syncingId === connector?.id;
          const failed = state === "needs_auth" || state === "error";
          /** 已连接显示账号与最近同步；未连接 / 暂停 / 同步中显示平台用途 */
          const leftLine =
            !connector || state === "disabled" || state === "syncing" || syncing
              ? t(meta.descriptionKey)
              : failed
                ? (status?.lastError ??
                  t(
                    state === "needs_auth"
                      ? "settings.inboxSources.status.needsAuth"
                      : "settings.inboxSources.status.error",
                  ))
                : state === "ok"
                  ? [
                      status?.accountName ?? connector.account,
                      status?.lastSyncAt
                        ? t("settings.inboxSources.status.lastSync", {
                            time: relativeTime(status.lastSyncAt, t),
                          })
                        : null,
                      typeof status?.itemCount === "number"
                        ? t("settings.inboxSources.status.itemCount", {
                            count: status.itemCount,
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t(meta.descriptionKey);
          const stateLabel =
            state === "not_connected"
              ? t("settings.inboxSources.status.notConnected")
              : state === "ok"
                ? t("settings.inboxSources.stateConnected")
                : state === "disabled"
                  ? t("settings.inboxSources.status.disabled")
                  : state === "syncing" || syncing
                    ? t("settings.inboxSources.status.syncing")
                    : failed
                      ? t(
                          state === "needs_auth"
                            ? "settings.inboxSources.status.needsAuth"
                            : "settings.inboxSources.status.error",
                        )
                      : t("settings.inboxSources.status.idle");
          return (
            <div
              key={meta.id}
              className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <ProviderMark
                  provider={meta.id}
                  className="mt-0.5 size-4 shrink-0 text-foreground"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{meta.name}</span>
                    <AnimatedBadge
                      status={
                        failed
                          ? "danger"
                          : state === "ok"
                            ? "success"
                            : state === "syncing" || syncing
                              ? "loading"
                              : "neutral"
                      }
                      size="sm"
                      layout={false}
                    >
                      {stateLabel}
                    </AnimatedBadge>
                  </div>
                  <p
                    className={cn(
                      "mt-0.5 text-ui leading-5",
                      failed ? "text-destructive" : "text-muted-foreground",
                    )}
                    title={leftLine}
                  >
                    {leftLine}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {connector ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-busy={checkingId === connector.id}
                      disabled={checkingId === connector.id}
                      onClick={() => void handleCheck(connector)}
                    >
                      {checkingId === connector.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2Icon className="size-3.5" />
                      )}
                      {t("settings.inboxSources.checkAgain")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground size-7 shrink-0"
                            aria-label={t(
                              "settings.inboxSources.moreActions",
                            )}
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        <DropdownMenuItem
                          onClick={() => openEditor(meta, connector)}
                        >
                          <SettingsIcon className="size-4" />
                          {t("settings.inboxSources.configure")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={togglingId === connector.id}
                          onClick={() =>
                            void handleToggle(
                              meta,
                              connector,
                              !connector.enabled,
                            )
                          }
                        >
                          {connector.enabled ? (
                            <PauseIcon className="size-4" />
                          ) : (
                            <PlayIcon className="size-4" />
                          )}
                          {connector.enabled
                            ? t("settings.inboxSources.pause")
                            : t("settings.inboxSources.resume")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={syncing}
                          onClick={() => void handleSync(connector)}
                        >
                          <RefreshCwIcon className="size-4" />
                          {t("settings.inboxSources.syncNow")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(connector)}
                        >
                          <Trash2Icon className="size-4" />
                          {t("settings.inboxSources.disconnect")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditor(meta, undefined)}
                  >
                    {t("settings.inboxSources.connect")}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        </div>

        <p className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
          <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
          {t("settings.inboxSources.securityNote")}
        </p>
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
          {editing && draft ? (
            <>
              <div className="flex items-start gap-3 p-6 pb-4">
                <ProviderGlyph
                  provider={editing.meta.id}
                  className="size-9 rounded-xl"
                />
                <div className="min-w-0">
                  <DialogTitle className="text-lg">
                    {t(
                      editing.connector
                        ? "settings.inboxSources.dialog.editTitle"
                        : "settings.inboxSources.dialog.connectTitle",
                      { name: editing.meta.name },
                    )}
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-sm leading-5">
                    {t(editing.meta.descriptionKey)}
                  </DialogDescription>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-4">
                {editing.meta.needsBaseUrl ? (
                  <Field
                    label={t("settings.inboxSources.fields.baseUrl")}
                    hint={t("settings.inboxSources.fields.baseUrlHint")}
                  >
                    <Input
                      value={draft.baseUrl}
                      onChange={(event) =>
                        setDraft({ ...draft, baseUrl: event.target.value })
                      }
                      placeholder={
                        editing.meta.baseUrlPlaceholderKey
                          ? t(editing.meta.baseUrlPlaceholderKey)
                          : undefined
                      }
                      autoComplete="off"
                    />
                  </Field>
                ) : null}

                {editing.meta.isJira ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("settings.inboxSources.fields.authMode")}>
                      <Select
                        value={draft.authMode}
                        onValueChange={(value) => {
                          if (value === "cloud" || value === "server") {
                            setDraft({ ...draft, authMode: value });
                          }
                        }}
                        items={[
                          {
                            value: "cloud",
                            label: t("settings.inboxSources.fields.authModeCloud"),
                          },
                          {
                            value: "server",
                            label: t(
                              "settings.inboxSources.fields.authModeServer",
                            ),
                          },
                        ]}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cloud">
                            {t("settings.inboxSources.fields.authModeCloud")}
                          </SelectItem>
                          <SelectItem value="server">
                            {t("settings.inboxSources.fields.authModeServer")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {draft.authMode === "cloud" ? (
                      <Field label={t("settings.inboxSources.fields.email")}>
                        <Input
                          value={draft.account}
                          onChange={(event) =>
                            setDraft({ ...draft, account: event.target.value })
                          }
                          placeholder="you@company.com"
                          autoComplete="off"
                        />
                      </Field>
                    ) : null}
                  </div>
                ) : null}

                <Field
                  label={t("settings.inboxSources.fields.token")}
                  hint={
                    <span>
                      {t(editing.meta.tokenScopeKey)}{" "}
                      <button
                        type="button"
                        className="text-primary inline-flex items-center gap-0.5 hover:underline"
                        onClick={() => openExternal(editing.meta.tokenUrl)}
                      >
                        {t("settings.inboxSources.fields.getToken")}
                        <ExternalLinkIcon className="size-3" />
                      </button>
                    </span>
                  }
                >
                  <Input
                    type="password"
                    value={draft.token}
                    onChange={(event) =>
                      setDraft({ ...draft, token: event.target.value })
                    }
                    placeholder={
                      editing.connector?.hasToken
                        ? t("settings.inboxSources.fields.tokenSaved", {
                            hint: editing.connector.tokenHint ?? "****",
                          })
                        : t("settings.inboxSources.fields.tokenPlaceholder")
                    }
                    autoComplete="new-password"
                  />
                </Field>

                {editing.meta.eventKeys ? (
                  <Field
                    label={t("settings.inboxSources.fields.events")}
                    hint={t("settings.inboxSources.fields.eventsHint")}
                  >
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {editing.meta.eventKeys.map((key) => (
                        <label
                          key={key}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={draft.events[key] === true}
                            onCheckedChange={(checked) =>
                              setDraft({
                                ...draft,
                                events: {
                                  ...draft.events,
                                  [key]: checked === true,
                                },
                              })
                            }
                          />
                          {t(`settings.inboxSources.events.${key}`)}
                        </label>
                      ))}
                    </div>
                  </Field>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("settings.inboxSources.fields.pollInterval")}>
                    <Select
                      value={String(draft.pollIntervalSec)}
                      onValueChange={(value) =>
                        setDraft({
                          ...draft,
                          pollIntervalSec: Number(value) || 120,
                        })
                      }
                      items={POLL_OPTIONS.map((seconds) => ({
                        value: String(seconds),
                        label: t(
                          `settings.inboxSources.poll.${
                            seconds === 60
                              ? "min1"
                              : seconds === 120
                                ? "min2"
                                : seconds === 300
                                  ? "min5"
                                  : "min15"
                          }`,
                        ),
                      }))}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POLL_OPTIONS.map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>
                            {t(
                              `settings.inboxSources.poll.${
                                seconds === 60
                                  ? "min1"
                                  : seconds === 120
                                    ? "min2"
                                    : seconds === 300
                                      ? "min5"
                                      : "min15"
                              }`,
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">
                        {t("settings.inboxSources.fields.desktopNotifications")}
                      </span>
                      <Switch
                        checked={draft.desktopNotifications}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            desktopNotifications: checked,
                          })
                        }
                      />
                    </div>
                    <p className="text-muted-foreground text-ui leading-5">
                      {t(
                        "settings.inboxSources.fields.desktopNotificationsHint",
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">
                        {t("settings.inboxSources.fields.notifyIssues")}
                      </span>
                      <Switch
                        checked={draft.notifyIssues}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, notifyIssues: checked })
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">
                        {t("settings.inboxSources.fields.notifyPullRequests")}
                      </span>
                      <Switch
                        checked={draft.notifyPullRequests}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, notifyPullRequests: checked })
                        }
                      />
                    </div>
                    <p className="text-muted-foreground text-ui leading-5">
                      {t("settings.inboxSources.fields.notifyCategoriesHint")}
                    </p>
                  </div>
                  <Field
                    label={t("settings.inboxSources.fields.muteNotifications")}
                    hint={t(
                      "settings.inboxSources.fields.muteNotificationsHint",
                    )}
                  >
                    <Select
                      value={String(draft.muteHours)}
                      onValueChange={(value) =>
                        setDraft({
                          ...draft,
                          muteTouched: true,
                          muteHours: Number(value) as MuteHours,
                        })
                      }
                      items={[
                        {
                          value: "0",
                          label: t("settings.inboxSources.fields.muteOff"),
                        },
                        {
                          value: "1",
                          label: t("settings.inboxSources.fields.mute1h"),
                        },
                        {
                          value: "8",
                          label: t("settings.inboxSources.fields.mute8h"),
                        },
                        {
                          value: "24",
                          label: t("settings.inboxSources.fields.mute24h"),
                        },
                      ]}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">
                          {t("settings.inboxSources.fields.muteOff")}
                        </SelectItem>
                        <SelectItem value="1">
                          {t("settings.inboxSources.fields.mute1h")}
                        </SelectItem>
                        <SelectItem value="8">
                          {t("settings.inboxSources.fields.mute8h")}
                        </SelectItem>
                        <SelectItem value="24">
                          {t("settings.inboxSources.fields.mute24h")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                {editing.meta.isJira ? (
                  <details className="rounded-xl border px-3 py-2">
                    <summary className="text-muted-foreground cursor-pointer text-xs">
                      {t("settings.inboxSources.fields.advanced")}
                    </summary>
                    <div className="pt-3">
                      <Field
                        label={t("settings.inboxSources.fields.jql")}
                        hint={t("settings.inboxSources.fields.jqlHint")}
                      >
                        <Input
                          value={draft.jql}
                          onChange={(event) =>
                            setDraft({ ...draft, jql: event.target.value })
                          }
                          placeholder="assignee = currentUser() AND resolution = Unresolved"
                          autoComplete="off"
                        />
                      </Field>
                    </div>
                  </details>
                ) : null}
              </div>

              <DialogFooter className="flex-wrap items-center gap-3 border-t px-6 py-4 sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      testing ||
                      (!draft.token.trim() && !editing.connector?.hasToken)
                    }
                    onClick={() => void handleTest()}
                  >
                    {testing ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2Icon className="size-3.5" />
                    )}
                    {testing
                      ? t("settings.inboxSources.testing")
                      : t("settings.inboxSources.test")}
                  </Button>
                  {testResult ? (
                    <span
                      className={cn(
                        "min-w-0 truncate text-xs",
                        testResult.ok
                          ? "text-emerald-600"
                          : "text-destructive",
                      )}
                      title={testResult.message}
                    >
                      {testResult.ok
                        ? t("settings.inboxSources.testSuccess", {
                            account:
                              testResult.accountName ??
                              t("settings.inboxSources.unknownAccount"),
                            count: testResult.itemCount ?? 0,
                          })
                        : (testResult.message ??
                          t("settings.inboxSources.testFailed"))}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={closeEditor}
                  >
                    {t("settings.inboxSources.cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : null}
                    {t(
                      editing.connector
                        ? "settings.inboxSources.save"
                        : "settings.inboxSources.connect",
                    )}
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.inboxSources.dialog.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.inboxSources.dialog.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.inboxSources.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleDelete()}
            >
              {t("settings.inboxSources.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
