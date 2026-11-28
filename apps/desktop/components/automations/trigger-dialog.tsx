"use client";

/**
 * 触发器管理（统一触发模型 P1）：内联进编辑器表单的「触发」一节。
 *
 * 排期（schedule）与事件（webhook/file/git/im）同列表管理。触发器是
 * "另一种到点方式"——fire 同一个任务；排期触发器是排期事实源（镜像到
 * task.schedule 驱动调度引擎），事件触发器与任务记录分开存储、各自即时
 * 落盘（不走表单的保存/全量覆盖）。本组件只做 CRUD + 展示 webhook
 * URL/secret（本地设置面，secret 不回显到模型/日志）。
 *
 * 排期触发器 P1 语义：启停 = 任务启停（与编辑器头部总开关同一状态，
 * onTaskEnabledChange 同步头部）；每任务至多一条（sidecar 按确定性 id
 * sched-<taskId> 幂等 upsert）。P2：排期触发器可删除 —— 删掉后任务转为
 * 纯事件任务（排期镜像成永不触发的哨兵 cron，事件触发器继续可用）。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  ClockIcon,
  CopyIcon,
  GitCommitHorizontalIcon,
  InboxIcon,
  Loader2Icon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WebhookIcon,
  FolderSearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Segmented } from "@/components/custom-ui/segmented";
import { invoke } from "@/desktop-bridge/core";
import {
  fetchTriggers,
  fetchWebhookPort,
  setTriggerEnabled,
  deleteTrigger,
  saveTrigger,
  scheduleConfig,
  connectorConfig,
  testTrigger,
  regenerateTriggerSecret,
  webhookUrl,
  type EventTrigger,
  type TriggerType,
} from "@/lib/automation/triggers";
import { describeSchedule, parseIntervalSeconds } from "@/lib/automation/automation-format";
import { refreshAutomations } from "@/lib/automation/automations";
import {
  ScheduleFields,
  SchedulePreviewBox,
  initScheduleState,
  useScheduleForm,
} from "./schedule-fields";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** connector 触发器的平台展示名 */
const CONNECTOR_PROVIDER_LABELS: Record<string, string> = {
  jira: "Jira",
  gitlab: "GitLab",
  github: "GitHub",
  linear: "Linear",
};



function typeIcon(type: TriggerType) {
  switch (type) {
    case "schedule":
      return ClockIcon;
    case "webhook":
      return WebhookIcon;
    case "file":
      return FolderSearchIcon;
    case "git":
      return GitCommitHorizontalIcon;
    case "im":
      return MessageSquareIcon;
    case "connector":
      return InboxIcon;
  }
}

function configSummary(
  trigger: EventTrigger,
  port: number | null,
  t: (key: string) => string,
): string {
  const c = trigger.config;
  switch (trigger.type) {
    case "webhook":
      return port === null ? "" : `127.0.0.1:${port}`;
    case "file":
      return Array.isArray(c.paths) ? (c.paths as string[]).join(", ") : "";
    case "git": {
      const branch = typeof c.branch === "string" ? c.branch : "";
      return `${String(c.cwd ?? "")}${branch ? ` @ ${branch}` : ""}`;
    }
    case "im":
      return `${String(c.platform ?? "")}${c.chatId ? ` @${String(c.chatId)}` : ""}${
        c.pattern ? ` /${String(c.pattern)}/` : ""
      }`;
    case "connector": {
      const cfg = connectorConfig(trigger);
      if (!cfg) return "";
      const label = CONNECTOR_PROVIDER_LABELS[cfg.provider] ?? cfg.provider;
      const itemType = cfg.itemType
        ? ` · ${t(
            cfg.itemType === "issue"
              ? "automation.trigger.connectorItemIssue"
              : "automation.trigger.connectorItemPr",
          )}`
        : "";
      return `${label}${cfg.sourceName ? ` @ ${cfg.sourceName}` : ""}${itemType}`;
    }
    default:
      return "";
  }
}

/** 新建任务时的触发器草稿：任务还没有 id，先在表单里攒着，保存任务时一并提交。
 *  与已有任务保持同一套交互：定时也在「添加触发器」里选，每任务至多一条。 */
export type DraftTrigger = {
  key: string;
  type: TriggerType;
  config: Record<string, unknown>;
};

const TriggerManager: FC<{
  /** 有值 = 已有任务（联服务端增删改）；缺省 = 新建任务草稿模式 */
  taskId?: string;
  /** 任务暂停时事件不会执行（execute 按 enabled 闸门跳过），UI 先说明 */
  taskEnabled?: boolean;
  /** 排期触发器启停 = 任务启停（P1 语义）：同步编辑器头部的总开关 */
  onTaskEnabledChange?: (enabled: boolean) => void;
  /** 草稿模式：已添加的触发器（保存任务时才真正落库） */
  draftTriggers?: DraftTrigger[];
  onDraftTriggersChange?: (next: DraftTrigger[]) => void;
}> = ({
  taskId,
  taskEnabled = true,
  onTaskEnabledChange,
  draftTriggers,
  onDraftTriggersChange,
}) => {
  const isDraft = taskId === undefined;
  const t = useT();
  const [all, setAll] = useState<EventTrigger[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<TriggerType>("webhook");
  /** 排期触发器编辑态（trigger id；新建时 null）＋共享排期表单 */
  const [editingSchedule, setEditingSchedule] = useState<string | "new" | null>(null);
  const schedForm = useScheduleForm(null);
  /** 删除两段式确认（3 秒不点自动回退），避免误删丢掉 webhook 密钥 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [triggers, p] = await Promise.all([fetchTriggers(), fetchWebhookPort()]);
      setAll(triggers);
      setPort(p);
    } catch (err) {
      toast.error({ title: t("automation.trigger.loadFailed"), description: String(err) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 挂载/切换任务即加载（表单内嵌一节，没有弹窗的 open 时机了）；草稿模式不联服务端
  useEffect(() => {
    if (isDraft) return;
    void load();
  }, [load, taskId, isDraft]);

  const drafts = draftTriggers ?? [];
  const mine = useMemo(
    () => (isDraft ? [] : all.filter((x) => x.taskId === taskId)),
    [all, taskId, isDraft],
  );
  const scheduleTriggers = useMemo(() => mine.filter((x) => x.type === "schedule"), [mine]);
  /** 每任务至多一条排期触发器（sidecar 拒绝第二条）：已有（或草稿里已有）排期时不再给档位 */
  const canAddSchedule = isDraft
    ? !drafts.some((d) => d.type === "schedule")
    : scheduleTriggers.length === 0;

  /** 复制到剪贴板并如实提示（无权限/非安全上下文时不谎报"已复制"） */
  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {},
      () => toast.error({ title: t("automation.trigger.copyFailed") }),
    );
  };

  const run = async (fn: () => Promise<EventTrigger[]>): Promise<boolean> => {
    setBusy(true);
    try {
      setAll(await fn());
      return true;
    } catch (err) {
      toast.error({
        title: t("automation.trigger.actionFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (newType === "schedule") {
      if (isDraft) {
        // 新建任务：定时也是「添加触发器」里的一个选项，先攒草稿（每任务一条）
        const built = schedForm.built;
        if (!built) return;
        onDraftTriggersChange?.([
          ...drafts,
          {
            key: draftKey(),
            type: "schedule",
            config: { type: "schedule", scheduleType: built.type, schedule: built.schedule },
          },
        ]);
        setNewType("webhook");
        setCreating(false);
        return;
      }
      await saveScheduleTrigger(null);
      return;
    }
    // webhook 无表单字段：创建即生成 URL + HMAC 密钥
    const config = { type: "webhook", secret: "" };
    if (isDraft) {
      // 新建任务：任务还没有 id，先把草稿攒着，保存任务时一并提交
      onDraftTriggersChange?.([...drafts, { key: draftKey(), type: newType, config }]);
      setCreating(false);
      return;
    }
    if (!taskId) return;
    const ok = await run(() => saveTrigger({ type: newType, taskId, config }));
    if (ok) setCreating(false);
  };

  /** 打开排期编辑（trigger=null = 新建）：用触发器上的排期重置共享表单 */
  /** 草稿 key：仅本地列表用，落库后由 sidecar 生成真实 id */
  const draftKey = (): string =>
    `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /** 草稿模式下打开定时触发器的排期编辑（复用同一套排期表单） */
  const openDraftScheduleEditor = (d: DraftTrigger): void => {
    const c = d.config as { scheduleType?: string; schedule?: string };
    schedForm.setState(
      initScheduleState({
        type: (c.scheduleType ?? "cron") as "cron" | "once" | "interval",
        schedule: c.schedule ?? "",
      }),
    );
    setEditingSchedule(d.key);
  };

  /** 草稿模式下把排期表单写回草稿触发器（保存任务时才真正落库） */
  const applyDraftSchedule = (key: string): void => {
    const built = schedForm.built;
    if (!built) return;
    onDraftTriggersChange?.(
      drafts.map((d) =>
        d.key === key
          ? {
              ...d,
              config: { type: "schedule", scheduleType: built.type, schedule: built.schedule },
            }
          : d,
      ),
    );
    setEditingSchedule(null);
  };

  const openScheduleEditor = (trigger: EventTrigger | null): void => {
    const cfg = trigger ? scheduleConfig(trigger) : null;
    schedForm.setState(
      initScheduleState(cfg ? { type: cfg.scheduleType, schedule: cfg.schedule } : null),
    );
    setEditingSchedule(trigger ? trigger.id : "new");
  };

  /** 保存排期触发器（新建/编辑同一条确定性记录）：sidecar 镜像回写
   *  task.schedule；编辑沿用触发器当前启停，新建沿用任务当前启停
   *  （不给暂停中的任务加排期时顺手把它唤醒） */
  const saveScheduleTrigger = async (trigger: EventTrigger | null): Promise<void> => {
    const built = schedForm.built;
    if (!built || !taskId) return;
    const nextEnabled = trigger ? trigger.enabled : taskEnabled;
    const ok = await run(() =>
      saveTrigger({
        ...(trigger ? { id: trigger.id } : {}),
        type: "schedule",
        taskId,
        enabled: nextEnabled,
        config: { type: "schedule", scheduleType: built.type, schedule: built.schedule },
      }).then((triggers) => {
        // 镜像可能改了 task.schedule / task.enabled：清单刷新 + 头部开关同步
        void refreshAutomations();
        onTaskEnabledChange?.(nextEnabled);
        return triggers;
      }),
    );
    if (ok) {
      setEditingSchedule(null);
      setNewType("webhook");
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!taskEnabled && (
        <p className="text-muted-foreground text-2xs">
          {t("automation.trigger.pausedHint")}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {isDraft ? (
          drafts.length === 0 ? (
            <p className="text-muted-foreground py-1 text-xs">{t("automation.trigger.empty")}</p>
          ) : (
            drafts.map((d) => {
              const Icon = typeIcon(d.type);
              const cfg = d.config as { scheduleType?: string; schedule?: string };
              return (
                <div
                  key={d.key}
                  className="border-border/60 flex flex-col gap-1.5 rounded-xl border px-3 py-3"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
                      {t(`automation.trigger.type.${d.type}`)}
                    </Badge>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {d.type === "schedule"
                        ? describeSchedule({
                            type: (cfg.scheduleType ?? "cron") as "cron" | "once" | "interval",
                            schedule: cfg.schedule ?? "",
                            intervalSeconds: parseIntervalSeconds(cfg.schedule ?? "") ?? 0,
                          })
                        : configSummary(
                            {
                              id: d.key,
                              type: d.type,
                              taskId: "",
                              enabled: true,
                              createdAt: "",
                              config: d.config,
                            },
                            port,
                            t,
                          )}
                    </span>
                    {d.type === "schedule" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() => openDraftScheduleEditor(d)}
                      >
                        {t("automation.trigger.edit")}
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive size-7"
                      aria-label={t("automation.trigger.delete")}
                      title={t("automation.trigger.delete")}
                      onClick={() =>
                        onDraftTriggersChange?.(drafts.filter((x) => x.key !== d.key))
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                  {d.type === "schedule" && editingSchedule === d.key ? (
                    <div className="flex flex-col gap-2 pt-1">
                      <ScheduleFields
                        state={schedForm.state}
                        setState={schedForm.setState}
                        built={schedForm.built}
                      />
                      <SchedulePreviewBox
                        built={schedForm.built}
                        preview={schedForm.preview}
                        emptyKey={
                          schedForm.state.mode === "once"
                            ? "automation.editor.previewPickOnce"
                            : "automation.editor.previewNeedDay"
                        }
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingSchedule(null)}
                        >
                          {t("automation.trigger.cancel")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={schedForm.built === null}
                          onClick={() => applyDraftSchedule(d.key)}
                        >
                          {t("automation.editor.save")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )
        ) : loading ? (
          <p className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {t("automation.trigger.loading")}
          </p>
        ) : mine.length === 0 ? (
          <p className="text-muted-foreground py-1 text-xs">{t("automation.trigger.empty")}</p>
        ) : (
            mine.map((trigger) => {
              const Icon = typeIcon(trigger.type);
              if (trigger.type === "schedule") {
                // 排期触发器卡片：排期事实源（镜像 task.schedule）。
                // 启停 = 任务启停；不可删除（sidecar 拒绝），编辑走共享排期表单
                const cfg = scheduleConfig(trigger);
                return (
                  <div
                    key={trigger.id}
                    className="border-border/60 flex flex-col gap-1.5 rounded-xl border px-3 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="text-muted-foreground size-4 shrink-0" />
                      <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
                        {t("automation.trigger.type.schedule")}
                      </Badge>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                        {cfg
                          ? describeSchedule({
                              type: cfg.scheduleType,
                              schedule: cfg.schedule,
                              intervalSeconds: parseIntervalSeconds(cfg.schedule) ?? 0,
                            })
                          : ""}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const next = await testTrigger(trigger.id);
                            if (taskEnabled) {
                              toast.success({ title: t("automation.trigger.testFired") });
                            } else {
                              toast.warning({ title: t("automation.trigger.testSkipped") });
                            }
                            return next;
                          })
                        }
                      >
                        <PlayIcon className="size-3.5" />
                        {t("automation.trigger.test")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className={cn("gap-1", trigger.enabled ? "" : "text-muted-foreground")}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const next = await setTriggerEnabled(trigger.id, !trigger.enabled);
                            // 排期启停 = 任务启停（sidecar 镜像 task.enabled）：
                            // 同步编辑器头部开关，并刷新任务清单
                            onTaskEnabledChange?.(!trigger.enabled);
                            void refreshAutomations();
                            return next;
                          })
                        }
                      >
                        {trigger.enabled
                          ? t("automation.trigger.enabled")
                          : t("automation.trigger.disabled")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        disabled={busy}
                        onClick={() => openScheduleEditor(trigger)}
                      >
                        {t("automation.trigger.edit")}
                      </Button>
                      {/* P2：删掉定时 → 任务转为纯事件任务（sidecar 把排期镜像成
                          永不触发的哨兵，事件触发器继续可用） */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "size-7",
                          confirmDeleteId === trigger.id
                            ? "text-destructive ring-destructive/40 ring-1"
                            : "text-muted-foreground hover:text-destructive",
                        )}
                        disabled={busy}
                        aria-label={
                          confirmDeleteId === trigger.id
                            ? t("automation.trigger.deleteConfirm")
                            : t("automation.trigger.delete")
                        }
                        title={
                          confirmDeleteId === trigger.id
                            ? t("automation.trigger.deleteConfirm")
                            : t("automation.trigger.delete")
                        }
                        onClick={() => {
                          if (confirmDeleteId === trigger.id) {
                            setConfirmDeleteId(null);
                            void run(async () => {
                              const next = await deleteTrigger(trigger.id);
                              void refreshAutomations();
                              return next;
                            });
                            return;
                          }
                          setConfirmDeleteId(trigger.id);
                          setTimeout(() => {
                            setConfirmDeleteId((cur) => (cur === trigger.id ? null : cur));
                          }, 3000);
                        }}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                    {editingSchedule === trigger.id ? (
                      <div className="flex flex-col gap-2 pt-1">
                        <ScheduleFields
                          state={schedForm.state}
                          setState={schedForm.setState}
                          built={schedForm.built}
                        />
                        <SchedulePreviewBox
                          built={schedForm.built}
                          preview={schedForm.preview}
                          emptyKey={
                            schedForm.state.mode === "once"
                              ? "automation.editor.previewPickOnce"
                              : "automation.editor.previewNeedDay"
                          }
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingSchedule(null)}
                          >
                            {t("automation.trigger.cancel")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy || schedForm.built === null}
                            onClick={() => void saveScheduleTrigger(trigger)}
                          >
                            {t("automation.editor.save")}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              }
              return (
                <div
                  key={trigger.id}
                  className="border-border/60 flex flex-col gap-1.5 rounded-xl border px-3 py-3"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
                      {t(`automation.trigger.type.${trigger.type}`)}
                    </Badge>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {configSummary(trigger, port, t)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const next = await testTrigger(trigger.id);
                          // 暂停任务下 execute 会静默跳过：如实提示而不是假成功
                          if (taskEnabled) {
                            toast.success({ title: t("automation.trigger.testFired") });
                          } else {
                            toast.warning({ title: t("automation.trigger.testSkipped") });
                          }
                          return next;
                        })
                      }
                    >
                      <PlayIcon className="size-3.5" />
                      {t("automation.trigger.test")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn("gap-1", trigger.enabled ? "" : "text-muted-foreground")}
                      disabled={busy}
                      onClick={() =>
                        void run(() => setTriggerEnabled(trigger.id, !trigger.enabled))
                      }
                    >
                      {trigger.enabled
                        ? t("automation.trigger.enabled")
                        : t("automation.trigger.disabled")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "size-7",
                        confirmDeleteId === trigger.id
                          ? "text-destructive ring-destructive/40 ring-1"
                          : "text-muted-foreground hover:text-destructive",
                      )}
                      disabled={busy}
                      aria-label={
                        confirmDeleteId === trigger.id
                          ? t("automation.trigger.deleteConfirm")
                          : t("automation.trigger.delete")
                      }
                      onClick={() => {
                        if (confirmDeleteId === trigger.id) {
                          setConfirmDeleteId(null);
                          void run(() => deleteTrigger(trigger.id));
                          return;
                        }
                        setConfirmDeleteId(trigger.id);
                        setTimeout(() => {
                          setConfirmDeleteId((cur) => (cur === trigger.id ? null : cur));
                        }, 3000);
                      }}
                      title={
                        confirmDeleteId === trigger.id
                          ? t("automation.trigger.deleteConfirm")
                          : t("automation.trigger.delete")
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                  {trigger.type === "webhook" ? (
                    <div className="flex items-center gap-1.5">
                      {port === null ? (
                        <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                          {t("automation.trigger.webhookUnavailable")}
                        </span>
                      ) : (
                        <code className="bg-muted/50 min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-2xs">
                          {webhookUrl(port, trigger.id)}
                        </code>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0"
                        title={t("automation.trigger.copyUrl")}
                        disabled={port === null}
                        onClick={() => copyText(webhookUrl(port, trigger.id))}
                      >
                        <CopyIcon className="size-3.5" />
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="shrink-0 gap-1"
                        title={t("automation.trigger.regenerate")}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const res = await regenerateTriggerSecret(trigger.id);
                            let copied = true;
                            try {
                              await navigator.clipboard.writeText(res.secret);
                            } catch {
                              copied = false;
                            }
                            // toast.success({
                            //   title: t("automation.trigger.regenerated"),
                            //   description: copied
                            //     ? t("automation.trigger.secretCopied")
                            //     : t("automation.trigger.secretShown"),
                            // });
                            return res.triggers;
                          })
                        }
                      >
                        <RefreshCwIcon className="size-3.5" />
                        {t("automation.trigger.regenerate")}
                      </Button>
                    </div>
                  ) : null}
                  {trigger.type === "webhook" && typeof trigger.config.secret === "string" ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground shrink-0 text-2xs">
                        {t("automation.trigger.secret")}
                      </span>
                      <code className="bg-muted/50 min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-2xs">
                        {trigger.config.secret}
                      </code>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0"
                        title={t("automation.trigger.copySecret")}
                        onClick={() => copyText(String(trigger.config.secret))}
                      >
                        <CopyIcon className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
      </div>

      {creating ? (
        <div className="border-border/60 flex flex-col gap-2 rounded-xl border p-3">
          {canAddSchedule ? (
          <div>
            <Segmented
            value={newType}
            onChange={(v) => setNewType(v as TriggerType)}
            options={[
              // 创建入口只开「定时 / Webhook」两档：connector 的选择式表单待
              // 重新设计后再上（后端能力保留，已有触发器照常显示运行）。
              { value: "schedule", label: t("automation.trigger.type.schedule") },
              { value: "webhook", label: t("automation.trigger.type.webhook") },
            ]}
          />
          </div>
          ) : null}
          <p className="text-muted-foreground text-2xs">
            {t(`automation.trigger.when.${newType}`)}
          </p>
          {newType === "schedule" ? (
            <div className="flex flex-col gap-2">
              <ScheduleFields
                state={schedForm.state}
                setState={schedForm.setState}
                built={schedForm.built}
              />
              <SchedulePreviewBox
                built={schedForm.built}
                preview={schedForm.preview}
                emptyKey={
                  schedForm.state.mode === "once"
                    ? "automation.editor.previewPickOnce"
                    : "automation.editor.previewNeedDay"
                }
              />
            </div>
          ) : newType === "webhook" ? null : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t("automation.trigger.cancel")}
            </Button>
            <Button
              disabled={busy || (newType === "schedule" && schedForm.built === null)}
              onClick={() => void create()}
            >
              {t("automation.trigger.create")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="lg" className="w-full gap-2" onClick={() => setCreating(true)}>
          <PlusIcon className="size-3" />
          {t("automation.trigger.add")}
        </Button>
      )}
    </div>
  );
};

export default TriggerManager;
