"use client";

import { useEffect, useState, type FC } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Button } from "@/components/ui/button";
import { useOnboardingGate } from "@/components/onboarding/onboarding-provider";
import {
  ATTACHMENT_RETENTION_OPTIONS,
  setAttachmentRetentionDays,
  useAttachmentRetentionDays,
} from "@/lib/attachments/attachment-retention";
import { setAppMode, useAppMode, useAppModeDegraded, type AppMode } from "@/lib/pi/app-mode";
import { useAnySessionRunning } from "@/lib/pi/pi-running";
import { setGpuAccelEnabled, useGpuAccelEnabled } from "@/lib/settings/gpu-accel";
import { SOUND_PACKS } from "@/lib/notify/sounds";
import { isDesktop, isWindowsPlatform } from "@/lib/desktop-env";
import { setUiPref, useUiPrefs, type SoundPackName } from "@/lib/settings/ui-prefs";
import {
  setLibraryAutoRecallEnabled,
  useLibraryAutoRecallEnabled,
} from "@/lib/settings/library-recall-pref";
import { FolderSearchIcon, Loader2Icon } from "lucide-react";
import { listen } from "@/desktop-bridge/event";
import { open as openDialog } from "@/desktop-bridge/plugin-dialog";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { setLocalePref, type LocalePref } from "@/lib/i18n";
import {
  changeLibraryRoot,
  useLibraryRoot,
} from "@/lib/workspace/library-root";
import {
  changeTaskWorkspaceRoot,
  TASK_WORKSPACE_PROGRESS_EVENT,
  useTaskWorkspaceRoot,
  type TaskWorkspaceMigrateProgress,
} from "@/lib/workspace/task-workspace";
import { fsErrorText, projectReveal } from "@/lib/workspace/fs";
import { FileManagerIcon } from "@/components/files/file-manager-icon";

/**
 * 通用设置页：提醒提示音与弹窗通知。统一开关 + 两套内置音色整体切换，
 * 音量（Slider）、仅后台提醒；另有渲染区块（Chrome 硬件加速，仅 Win 桌面端）。
 * 文生图配置在模型配置页（model-settings）；智能体本机能力（浏览器驱动等）与审查模型在智能体配置页（agent-config-settings）。
 * Webhook 推送与最近推送记录在独立页（webhooks-settings）。
 */
export const GeneralSettings: FC = () => {
  const t = useT();
  const prefs = useUiPrefs();
  const gpuAccel = useGpuAccelEnabled();
  const retentionDays = useAttachmentRetentionDays();
  const appMode = useAppMode();
  const appModeDegraded = useAppModeDegraded();
  const { reopen: reopenOnboarding } = useOnboardingGate();
  const libraryRoot = useLibraryRoot();
  const autoRecall = useLibraryAutoRecallEnabled();

  /** 换资料库位置：选文件夹 → 落库；不搬移已有文件（文案已说明） */
  const pickLibraryRoot = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("settings.general.pickLibraryTitle"),
      defaultPath: libraryRoot?.root,
    });
    if (typeof picked !== "string" || !picked) return;
    const err = await changeLibraryRoot(picked);
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    // 成功不弹提示：行里的路径即刻显示新位置
  };

  const openLibraryRoot = async () => {
    if (!libraryRoot?.root) return;
    const err = await projectReveal(libraryRoot.root);
    if (err) toast.error(fsErrorText(err));
  };

  // ---- 任务产物位置（Windows 上常从 C 盘挪到数据盘）----
  const taskRoot = useTaskWorkspaceRoot();
  const anySessionActive = useAnySessionRunning();
  const [taskRootPending, setTaskRootPending] = useState<string | null>(null);
  const [taskMigrating, setTaskMigrating] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskWorkspaceMigrateProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<TaskWorkspaceMigrateProgress>(TASK_WORKSPACE_PROGRESS_EVENT, (e) =>
      setTaskProgress(e.payload),
    ).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  /** 选完目录先弹确认：迁移（旧产物一起搬走）还是仅切换（旧文件留在原地） */
  const pickTaskWorkspaceRoot = async () => {
    if (anySessionActive) {
      toast.error(t("settings.general.busyToast"));
      return;
    }
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("settings.general.pickTaskTitle"),
      defaultPath: taskRoot?.root,
    });
    if (typeof picked !== "string" || !picked) return;
    if (taskRoot?.root && picked.replace(/[\\/]+$/, "") === taskRoot.root.replace(/[\\/]+$/, "")) {
      return;
    }
    setTaskRootPending(picked);
  };

  const applyTaskWorkspaceRoot = async (migrate: boolean) => {
    const dir = taskRootPending;
    if (!dir) return;
    setTaskRootPending(null);
    setTaskMigrating(true);
    setTaskProgress(null);
    try {
      const err = await changeTaskWorkspaceRoot(dir, migrate);
      if (err) {
        toast.error(err);
        return;
      }
      toast.success(
        migrate
          ? t("settings.general.toastMigrated")
          : t("settings.general.toastSwitched"),
      );
    } finally {
      setTaskMigrating(false);
      setTaskProgress(null);
    }
  };

  const openTaskWorkspaceRoot = async () => {
    if (!taskRoot?.root) return;
    const err = await projectReveal(taskRoot.root);
    if (err) toast.error(fsErrorText(err));
  };

  const taskProgressPct = taskProgress
    ? taskProgress.bytesTotal > 0
      ? Math.min(100, Math.round((taskProgress.bytesDone / taskProgress.bytesTotal) * 100))
      : taskProgress.total > 0
        ? Math.min(100, Math.round((taskProgress.done / taskProgress.total) * 100))
        : null
    : null;
  const taskPhaseLabel = taskProgress
    ? {
        renaming: t("settings.general.phaseRename"),
        copying: t("settings.general.phaseCopy"),
        verify: t("settings.general.phaseVerify"),
        finalizing: t("settings.general.phaseFinalize"),
        cleanup: t("settings.general.phaseCleanup"),
      }[taskProgress.phase]
    : "";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <AlertDialog
        open={taskRootPending !== null}
        onOpenChange={(open) => {
          if (!open) setTaskRootPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.general.switchDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.general.switchDialogPathLabel")}
              <span className="mt-1 block font-mono text-[13px] leading-5 break-all">
                {taskRootPending ?? ""}
              </span>
              {t("settings.general.switchDialogBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void applyTaskWorkspaceRoot(false)}
            >
              {t("settings.general.switchNoMigrate")}
            </Button>
            <Button size="sm" className="h-8" onClick={() => void applyTaskWorkspaceRoot(true)}>
              {t("settings.general.switchMigrate")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.sections.general")}</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.general.appModeTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.general.defaultMode")}
              desc={
                appModeDegraded
                  ? t("settings.general.defaultModeDegraded")
                  : appMode === "work"
                    ? t("settings.general.defaultModeWork")
                    : t("settings.general.defaultModeCode")
              }
            >
              <Select
                value={appMode}
                onValueChange={(v) => {
                  void setAppMode(v as AppMode);
                }}
                items={[
                  { value: "code", label: t("settings.general.modeCodeDefault") },
                  { value: "work", label: t("settings.general.modeWork") },
                ]}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">{t("settings.general.modeCodeDefault")}</SelectItem>
                  <SelectItem value="work">{t("settings.general.modeWork")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("common.lang.label")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("common.lang.label")}>
              <Select
                value={prefs.locale}
                onValueChange={(v) => setLocalePref(v as LocalePref)}
                items={[
                  { value: "system", label: t("common.lang.system") },
                  { value: "zh", label: t("common.lang.zh") },
                  { value: "en", label: t("common.lang.en") },
                ]}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("common.lang.system")}</SelectItem>
                  <SelectItem value="zh">{t("common.lang.zh")}</SelectItem>
                  <SelectItem value="en">{t("common.lang.en")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.general.remindersTitle")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.general.soundEnabled")}>
              <Switch
                checked={prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundEnabled", v)}
              />
            </SettingRow>
            <SettingRow label={t("settings.general.soundPack")}>
              <Select
                value={prefs.soundPack}
                onValueChange={(v) => setUiPref("soundPack", v as SoundPackName)}
                items={SOUND_PACKS.map((p) => ({
                  value: p.value,
                  label: t(`settings.general.${p.value === "crisp" ? "soundCrisp" : "soundCalm"}`),
                }))}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_PACKS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {t(`settings.general.${p.value === "crisp" ? "soundCrisp" : "soundCalm"}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label={t("settings.general.volume")}>
              <div className="flex w-44 items-center gap-3">
                <Slider
                  min={0}
                  max={100}
                  value={[Math.round(prefs.soundVolume * 100)]}
                  disabled={!prefs.soundEnabled}
                  onValueChange={(v) => {
                    const first = Array.isArray(v) ? v[0] : v;
                    setUiPref("soundVolume", Number(first ?? 60) / 100);
                  }}
                />
                <span className="text-muted-foreground w-8 text-right text-[13px] leading-5 tabular-nums">
                  {Math.round(prefs.soundVolume * 100)}
                </span>
              </div>
            </SettingRow>
            <SettingRow label={t("settings.general.onlyUnfocused")}>
              <Switch
                checked={prefs.soundOnlyUnfocused}
                disabled={!prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundOnlyUnfocused", v)}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.general.popup")}
              desc={t("settings.general.popupDesc")}
            >
              <Switch
                checked={prefs.popupEnabled}
                onCheckedChange={(v) => setUiPref("popupEnabled", v)}
              />
            </SettingRow>
          </div>
        </section>

        {/* 附件中转缓存仅桌面端存在（粘贴的文档中转落盘）；网页端无本地 FS */}
        {isDesktop() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.general.attachmentsTitle")}</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.general.retention")}
                desc={t("settings.general.retentionDesc")}
              >
                <Select
                  value={String(retentionDays)}
                  onValueChange={(v) => void setAttachmentRetentionDays(Number(v))}
                  items={ATTACHMENT_RETENTION_OPTIONS.map((o) => ({
                    value: String(o.value),
                    label: t(
                      o.value === 0
                        ? "settings.general.retNever"
                        : o.value === 1
                          ? "settings.general.ret1"
                          : o.value === 7
                            ? "settings.general.ret7"
                            : "settings.general.ret30",
                    ),
                  }))}
                >
                  <SelectTrigger size="sm" className="w-44 border bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ATTACHMENT_RETENTION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {t(
                          o.value === 0
                            ? "settings.general.retNever"
                            : o.value === 1
                              ? "settings.general.ret1"
                              : o.value === 7
                                ? "settings.general.ret7"
                                : "settings.general.ret30",
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>
          </section>
        )}

        {/* 资料库位置仅桌面端可调（本地磁盘目录）；网页端没有这条通道 */}
        {isDesktop() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.general.libraryTitle")}</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.general.libraryRoot")}
                desc={
                  libraryRoot?.isDefault
                    ? t("settings.general.libraryRootDefault")
                    : t("settings.general.libraryRootCustom")
                }
              >
                <div className="flex min-w-0 max-w-md items-center gap-2">
                  <span
                    className="text-muted-foreground min-w-0 truncate font-mono text-[13px] leading-5"
                    title={libraryRoot?.root ?? ""}
                  >
                    {libraryRoot?.root ?? t("settings.general.resolving")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void pickLibraryRoot()}
                  >
                    {t("settings.general.change")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    title={t("settings.general.openInSystem")}
                    onClick={() => void openLibraryRoot()}
                  >
                    <FileManagerIcon className="size-4.5" />
                  </Button>
                </div>
              </SettingRow>
              <SettingRow
                label={t("settings.general.autoRecall")}
                desc={t("settings.general.autoRecallDesc")}
              >
                <Switch
                  checked={autoRecall}
                  onCheckedChange={(value) =>
                    setLibraryAutoRecallEnabled(value)
                  }
                />
              </SettingRow>
            </div>
          </section>
        )}

        {/* 任务产物位置仅桌面端可调：Windows 用户常把它从 C 盘挪到数据盘 */}
        {isDesktop() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.general.taskTitle")}</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.general.taskRoot")}
                desc={
                  anySessionActive
                    ? t("settings.general.taskRootBusy")
                    : taskRoot?.isDefault
                      ? t("settings.general.taskRootDefault")
                      : t("settings.general.taskRootCustom")
                }
              >
                <div className="flex min-w-0 max-w-md items-center gap-2">
                  <span
                    className="text-muted-foreground min-w-0 truncate font-mono text-[13px] leading-5"
                    title={taskRoot?.root ?? ""}
                  >
                    {taskRoot?.root ?? t("settings.general.resolving")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5"
                    disabled={taskMigrating || anySessionActive}
                    onClick={() => void pickTaskWorkspaceRoot()}
                  >
                    {taskMigrating && <Loader2Icon className="size-3.5 animate-spin" />}
                    {taskMigrating ? t("settings.general.migrating") : t("settings.general.change")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    title={t("settings.general.openInSystem")}
                    onClick={() => void openTaskWorkspaceRoot()}
                  >
                    <FileManagerIcon className="size-4.5" />
                  </Button>
                </div>
              </SettingRow>
              {taskMigrating && taskProgress && (
                <div className="flex flex-col gap-1 px-3 py-2">
                  <div className="text-muted-foreground flex items-center justify-between text-[13px] leading-5">
                    <span>
                      {taskPhaseLabel}：{taskProgress.message || t("settings.general.processing")}
                    </span>
                    <span className="tabular-nums">
                      {taskProgressPct !== null ? `${taskProgressPct}%` : ""}
                    </span>
                  </div>
                  <div className="bg-background h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-foreground h-full rounded-full transition-[width]"
                      style={{ width: `${taskProgressPct ?? 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* WebView2 专属参数，远程网页端与 macOS 均无可调项，仅 Win 桌面端展示 */}
        {isDesktop() && isWindowsPlatform() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.general.renderTitle")}</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{t("settings.general.renderDesc")}</p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.general.gpuAccel")}
                desc={t("settings.general.gpuAccelDesc")}
              >
                <Switch
                  checked={gpuAccel}
                  onCheckedChange={(v) => void setGpuAccelEnabled(v)}
                />
              </SettingRow>
            </div>
          </section>
        )}

        {/* 新手引导是桌面首启流程（远程端 Provider 永不展开、reopen 也是空
            操作），入口只在桌面端呈现 */}
        {isDesktop() && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("settings.general.onboardingTitle")}</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.general.reopenOnboarding")}
                desc={t("settings.general.reopenOnboardingDesc")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="w-44"
                  onClick={reopenOnboarding}
                >
                  {t("settings.general.viewOnboarding")}
                </Button>
              </SettingRow>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

