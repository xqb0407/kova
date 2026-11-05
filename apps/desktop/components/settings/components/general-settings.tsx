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
import { useEnsureUiDesignPlugin } from "@/components/design-mode-gate";
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
  const prefs = useUiPrefs();
  const gpuAccel = useGpuAccelEnabled();
  const retentionDays = useAttachmentRetentionDays();
  const appMode = useAppMode();
  const appModeDegraded = useAppModeDegraded();
  const { ensure: ensureUiDesign, dialog: uiDesignGateDialog } =
    useEnsureUiDesignPlugin();
  const { reopen: reopenOnboarding } = useOnboardingGate();
  const libraryRoot = useLibraryRoot();
  const autoRecall = useLibraryAutoRecallEnabled();

  /** 换资料库位置：选文件夹 → 落库；不搬移已有文件（文案已说明） */
  const pickLibraryRoot = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "选择资料库位置",
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
      toast.error("有会话正在运行，请等待当前对话完成后再切换");
      return;
    }
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "选择任务产物位置",
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
      toast.success(migrate ? "已迁移并切换任务产物位置" : "已切换任务产物位置");
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
        renaming: "准备位置",
        copying: "复制产物",
        verify: "校验副本",
        finalizing: "就位",
        cleanup: "完成",
      }[taskProgress.phase]
    : "";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {uiDesignGateDialog}
      <AlertDialog
        open={taskRootPending !== null}
        onOpenChange={(open) => {
          if (!open) setTaskRootPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换任务产物位置？</AlertDialogTitle>
            <AlertDialogDescription>
              新位置：
              <span className="mt-1 block font-mono text-[13px] leading-5 break-all">
                {taskRootPending ?? ""}
              </span>
              可以把现有产物一起迁移过去（旧会话的产物保持可见），也可以只切换——旧文件会留在原位置、
              应用内不再显示。迁移中途强制退出或断电是安全的：下次启动会续跑或回退，原数据不会丢。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void applyTaskWorkspaceRoot(false)}
            >
              仅切换，不迁移
            </Button>
            <Button size="sm" className="h-8" onClick={() => void applyTaskWorkspaceRoot(true)}>
              迁移并切换
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">通用</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">工作模式</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            默认模式：新对话，以及从未在顶栏单独切过档的会话跟随这里；单独切过档的会话保持自己的档。与输入框旁的权限模式（确认/自动/计划）互不影响。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="默认模式"
              desc={
                appModeDegraded
                  ? "当前 sidecar 版本不支持，切换仅影响界面，提示词不跟随"
                  : appMode === "work"
                    ? "面向日常办公：交付导向的回复风格，隐藏 Git 管理界面，消息里的工具步骤收敛为摘要"
                    : appMode === "design"
                      ? "面向 UI 设计：设计稿（ui-design 面板）与高保真原型优先，隐藏 Git 管理界面"
                      : "面向开发：完整工具与细节（Git 管理、可展开的工具输出）"
              }
            >
              <Select
                value={appMode}
                onValueChange={(v) => {
                  const mode = v as AppMode;
                  // 设计档前置门禁：ui-design 插件未装/禁用时弹窗引导，通过才切档
                  if (mode === "design") {
                    void (async () => {
                      if (await ensureUiDesign()) await setAppMode("design");
                    })();
                    return;
                  }
                  void setAppMode(mode);
                }}
                items={[
                  { value: "code", label: "编码（默认）" },
                  { value: "work", label: "工作" },
                  { value: "design", label: "设计" },
                ]}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">编码（默认）</SelectItem>
                  <SelectItem value="work">工作</SelectItem>
                  <SelectItem value="design">设计</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">提醒</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            任务完成、等待审批、出错等节点播放提示音，无需盯着窗口。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="提示音" desc="总开关，统一控制所有事件">
              <Switch
                checked={prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundEnabled", v)}
              />
            </SettingRow>
            <SettingRow label="音色" desc="内置两套音色，整体切换">
              <Select
                value={prefs.soundPack}
                onValueChange={(v) => setUiPref("soundPack", v as SoundPackName)}
                items={SOUND_PACKS}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_PACKS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="音量" desc="提示音大小">
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
            <SettingRow
              label="仅后台提醒"
              desc="窗口在前台时不播放——前台看得见，不必吵"
            >
              <Switch
                checked={prefs.soundOnlyUnfocused}
                disabled={!prefs.soundEnabled}
                onCheckedChange={(v) => setUiPref("soundOnlyUnfocused", v)}
              />
            </SettingRow>
            <SettingRow
              label="弹窗通知"
              desc="窗口不在前台时弹出系统桌面通知（Win/macOS，仅桌面端生效）"
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
            <h2 className="text-base font-semibold">附件</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              粘贴的文档会暂存到本地缓存目录供智能体读取，超期自动清理。
            </p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="粘贴文件保留期限"
                desc="超期后自动删除；选「不清理」则一直保留，需自行管理磁盘占用"
              >
                <Select
                  value={String(retentionDays)}
                  onValueChange={(v) => void setAttachmentRetentionDays(Number(v))}
                  items={ATTACHMENT_RETENTION_OPTIONS.map((o) => ({
                    value: String(o.value),
                    label: o.label,
                  }))}
                >
                  <SelectTrigger size="sm" className="w-44 border bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ATTACHMENT_RETENTION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {o.label}
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
            <h2 className="text-base font-semibold">资料库</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              侧边栏「资料库」页存放你自己文件的位置；笔记就是这里的 .md 文件，
              可以随手整理、也能随时用系统文件管理器打开。
            </p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="资料库位置"
                desc={
                  libraryRoot?.isDefault
                    ? "当前是缺省位置（应用数据目录内，跟随备份）。可改为任意文件夹，例如放进 iCloud / 网盘同步目录。"
                    : "当前是自定义位置，不随应用云备份走（请自行同步）。切换位置不会搬移已有文件。"
                }
              >
                <div className="flex min-w-0 max-w-md items-center gap-2">
                  <span
                    className="text-muted-foreground min-w-0 truncate font-mono text-[13px] leading-5"
                    title={libraryRoot?.root ?? ""}
                  >
                    {libraryRoot?.root ?? "解析中…"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void pickLibraryRoot()}
                  >
                    更改…
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    title="在系统中打开"
                    onClick={() => void openLibraryRoot()}
                  >
                    <FileManagerIcon className="size-4.5" />
                  </Button>
                </div>
              </SettingRow>
              <SettingRow
                label="自动召回"
                desc="输入时推荐相关笔记，发送时附带最多两条笔记标题线索；关闭后与旧版一致（不影响已保存的笔记）。"
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
            <h2 className="text-base font-semibold">任务产物</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              无目录任务的 agent 产物和「我的文件」页都放在这里，可按磁盘规划改到其它位置
              （例如从 C 盘换到数据盘）。
            </p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="任务产物位置"
                desc={
                  anySessionActive
                    ? "有会话正在运行：请等待当前对话完成后再切换，避免产物写进正在搬移的目录。"
                    : taskRoot?.isDefault
                      ? "当前是缺省位置（应用数据目录内，跟随备份的「包含任务工作区」）。切换时可选是否迁移已有产物。"
                      : "当前是自定义位置；备份与恢复会跟着这个位置走。切换时可选是否迁移已有产物。"
                }
              >
                <div className="flex min-w-0 max-w-md items-center gap-2">
                  <span
                    className="text-muted-foreground min-w-0 truncate font-mono text-[13px] leading-5"
                    title={taskRoot?.root ?? ""}
                  >
                    {taskRoot?.root ?? "解析中…"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5"
                    disabled={taskMigrating || anySessionActive}
                    onClick={() => void pickTaskWorkspaceRoot()}
                  >
                    {taskMigrating && <Loader2Icon className="size-3.5 animate-spin" />}
                    {taskMigrating ? "迁移中…" : "更改…"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    title="在系统中打开"
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
                      {taskPhaseLabel}：{taskProgress.message || "处理中…"}
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
            <h2 className="text-base font-semibold">渲染</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">桌面端渲染兼容性选项。</p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="Chrome 硬件加速"
                desc="关闭后可规避部分显卡或驱动导致的白屏、闪退、渲染异常。修改后需重启应用生效。"
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
            <h2 className="text-base font-semibold">入门</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="重新查看新手引导"
                desc="重走一遍首次启动的配置向导，不会覆盖已保存的设置"
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="w-44"
                  onClick={reopenOnboarding}
                >
                  查看引导
                </Button>
              </SettingRow>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

