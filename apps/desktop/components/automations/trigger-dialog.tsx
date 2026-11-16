"use client";

/**
 * 触发器管理弹窗（L1b）：挂在某个自动化任务下。
 *
 * 触发器是"另一种到点方式"——它们 fire 同一个任务。本弹窗只做 CRUD + 展示
 * webhook URL/secret（本地设置面，secret 不回显到模型/日志）。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  CopyIcon,
  GitCommitHorizontalIcon,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  fetchTriggers,
  fetchWebhookPort,
  setTriggerEnabled,
  deleteTrigger,
  saveTrigger,
  testTrigger,
  regenerateTriggerSecret,
  webhookUrl,
  type EventTrigger,
  type TriggerType,
} from "@/lib/automation/triggers";
import { toast } from "@/components/ui/toast";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function typeIcon(type: TriggerType) {
  switch (type) {
    case "webhook":
      return WebhookIcon;
    case "file":
      return FolderSearchIcon;
    case "git":
      return GitCommitHorizontalIcon;
    case "im":
      return MessageSquareIcon;
  }
}

function configSummary(trigger: EventTrigger): string {
  const c = trigger.config;
  switch (trigger.type) {
    case "webhook":
      return "HMAC";
    case "file":
      return Array.isArray(c.paths) ? (c.paths as string[]).join(", ") : "";
    case "git": {
      const branch = typeof c.branch === "string" ? c.branch : "";
      return `${String(c.cwd ?? "")}${branch ? ` @ ${branch}` : ""}`;
    }
    case "im":
      return `${String(c.platform ?? "")}${c.pattern ? ` /${String(c.pattern)}/` : ""}`;
    default:
      return "";
  }
}

const TriggerDialog: FC<{
  taskId: string;
  taskName: string;
  /** 任务暂停时事件不会执行（execute 按 enabled 闸门跳过），UI 先说明 */
  taskEnabled: boolean;
  open: boolean;
  onClose: () => void;
}> = ({ taskId, taskName, taskEnabled, open, onClose }) => {
  const t = useT();
  const workspaceDir = useProjectWorkspaceDir();
  const [all, setAll] = useState<EventTrigger[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<TriggerType>("webhook");
  const [filePaths, setFilePaths] = useState("src/**");
  const [gitCwd, setGitCwd] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [imPlatform, setImPlatform] = useState("feishu");
  const [imPattern, setImPattern] = useState("");

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

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const mine = useMemo(() => all.filter((x) => x.taskId === taskId), [all, taskId]);

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
    const config =
      newType === "webhook"
        ? { type: "webhook", secret: "" }
        : newType === "file"
          ? { type: "file", paths: filePaths.split(",").map((s) => s.trim()).filter(Boolean) }
          : newType === "git"
            ? {
                // 留空 = 当前工作区（与 watcher 的 workspace 同源）
                cwd: gitCwd.trim() || workspaceDir || "",
                ...(gitBranch.trim() ? { branch: gitBranch.trim() } : {}),
              }
            : {
                type: "im",
                platform: imPlatform.trim(),
                ...(imPattern.trim() ? { pattern: imPattern.trim() } : {}),
              };
    const ok = await run(() => saveTrigger({ type: newType, taskId, config }));
    if (ok) setCreating(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>{t("automation.trigger.title")}</DialogTitle>
        <DialogDescription>
          {t("automation.trigger.desc", { name: taskName })}
          {!taskEnabled ? ` ${t("automation.trigger.pausedHint")}` : ""}
        </DialogDescription>

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto py-1">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("automation.trigger.loading")}
            </p>
          ) : mine.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">{t("automation.trigger.empty")}</p>
          ) : (
            mine.map((trigger) => {
              const Icon = typeIcon(trigger.type);
              return (
                <div
                  key={trigger.id}
                  className="border-border/60 flex flex-col gap-1.5 rounded-xl border px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
                      {t(`automation.trigger.type.${trigger.type}`)}
                    </Badge>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {configSummary(trigger)}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="gap-1"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const next = await testTrigger(trigger.id);
                          toast.success({ title: t("automation.trigger.testFired") });
                          return next;
                        })
                      }
                    >
                      <PlayIcon className="size-3" />
                      {t("automation.trigger.test")}
                    </Button>
                    <Button
                      size="xs"
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
                      className="text-muted-foreground hover:text-destructive size-7"
                      disabled={busy}
                      onClick={() => void run(() => deleteTrigger(trigger.id))}
                      title={t("automation.trigger.delete")}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                  {trigger.type === "webhook" ? (
                    <div className="flex items-center gap-1.5">
                      {port === null ? (
                        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                          {t("automation.trigger.webhookUnavailable")}
                        </span>
                      ) : (
                        <code className="bg-muted/50 min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-3xs">
                          {webhookUrl(port, trigger.id)}
                        </code>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0"
                        title={t("automation.trigger.copyUrl")}
                        disabled={port === null}
                        onClick={() => {
                          void navigator.clipboard.writeText(webhookUrl(port, trigger.id));
                          toast.success({ title: t("automation.trigger.copied") });
                        }}
                      >
                        <CopyIcon className="size-3" />
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
                            toast.success({
                              title: t("automation.trigger.regenerated"),
                              description: copied
                                ? t("automation.trigger.secretCopied")
                                : t("automation.trigger.secretShown"),
                            });
                            return res.triggers;
                          })
                        }
                      >
                        <RefreshCwIcon className="size-3" />
                        {t("automation.trigger.regenerate")}
                      </Button>
                    </div>
                  ) : null}
                  {trigger.type === "webhook" && typeof trigger.config.secret === "string" ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground shrink-0 text-2xs">
                        {t("automation.trigger.secret")}
                      </span>
                      <code className="bg-muted/50 min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-3xs">
                        {trigger.config.secret}
                      </code>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0"
                        title={t("automation.trigger.copySecret")}
                        onClick={() => {
                          void navigator.clipboard.writeText(String(trigger.config.secret));
                          toast.success({ title: t("automation.trigger.copied") });
                        }}
                      >
                        <CopyIcon className="size-3" />
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
            <Segmented
              value={newType}
              onChange={(v) => setNewType(v as TriggerType)}
              options={[
                { value: "webhook", label: t("automation.trigger.type.webhook") },
                { value: "file", label: t("automation.trigger.type.file") },
                { value: "git", label: t("automation.trigger.type.git") },
                { value: "im", label: t("automation.trigger.type.im") },
              ]}
            />
            {newType === "webhook" ? (
              <p className="text-muted-foreground text-xs">
                {t("automation.trigger.webhookHint")}
              </p>
            ) : newType === "file" ? (
              <div className="flex flex-col gap-2">
                <Input
                  value={filePaths}
                  onChange={(e) => setFilePaths(e.target.value)}
                  placeholder="src/**/*.ts, docs/**"
                />
                <p className="text-muted-foreground text-2xs">
                  {t("automation.trigger.fileHint")}
                </p>
              </div>
            ) : newType === "git" ? (
              <div className="flex flex-col gap-2">
                <Input
                  value={gitCwd}
                  onChange={(e) => setGitCwd(e.target.value)}
                  placeholder={t("automation.trigger.gitCwdPlaceholder")}
                />
                <Input
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                  placeholder={t("automation.trigger.gitBranchPlaceholder")}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Input
                  value={imPlatform}
                  onChange={(e) => setImPlatform(e.target.value)}
                  placeholder="feishu / wechat / dingtalk"
                />
                <Input
                  value={imPattern}
                  onChange={(e) => setImPattern(e.target.value)}
                  placeholder="^/run"
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                {t("automation.trigger.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  (newType === "file" && filePaths.trim().length === 0) ||
                  (newType === "git" && !(gitCwd.trim() || workspaceDir)) ||
                  (newType === "im" && imPlatform.trim().length === 0)
                }
                onClick={() => void create()}
              >
                {t("automation.trigger.create")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full gap-1.5"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-3.5" />
            {t("automation.trigger.add")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default TriggerDialog;
