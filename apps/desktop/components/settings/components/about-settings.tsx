"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { invoke } from "@/desktop-bridge/core";
import { getName, getRuntimeVersion, getVersion } from "@/desktop-bridge/app";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isDesktop } from "@/lib/desktop-env";
import { FEEDBACK_ISSUES_URL } from "@/lib/feedback";
import {
  installUpdate,
  progressPct,
  UPDATE_PHASE_LABEL,
  updateSummary,
  type UpdateInfo,
  type UpdateProgress,
} from "@/lib/update";
import { cn } from "@/lib/utils";
import { openResourceManager } from "@/lib/resource/api";
import { Switch } from "@/components/ui/switch";
import {
  CpuIcon,
  DownloadIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from "lucide-react";
import { ObservabilitySection } from "./observability-settings";

type AppInfo = { name: string; version: string; runtime: string };

/** 关于页：应用信息、日志目录、问题反馈、开发者模式（DevTools，仅桌面端） */
export const AboutSettings: FC = () => {
  const desktop = isDesktop();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 升级检查：状态在 Rust（节流/忽略/开关都持久化），这里只展示与触发
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // 应用内升级：下载/安装进度与失败原因（失败退回"去网页下载"）
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    (async () => {
      try {
        const [name, version, runtime] = await Promise.all([
          getName(),
          getVersion(),
          getRuntimeVersion(),
        ]);
        setInfo({ name, version, runtime });
        const dev = await invoke<string | null>("kv_get", { key: "dev.mode" });
        setDevMode(dev === "1");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [desktop]);

  const openLogs = useCallback(async () => {
    setError(null);
    try {
      setLogPath(await invoke<string>("open_logs_dir"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cleanLogs = useCallback(async (beforeDays: number, label: string) => {
    setError(null);
    setCleanMsg(null);
    setCleanBusy(true);
    try {
      const removed = await invoke<number>("cleanup_logs", { beforeDays });
      setCleanMsg(`已清理${label}（${removed} 个日期目录）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleanBusy(false);
    }
  }, []);

  const openFeedback = useCallback(async () => {
    setError(null);
    try {
      if (desktop) await invoke("open_external", { url: FEEDBACK_ISSUES_URL });
      else window.open(FEEDBACK_ISSUES_URL, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [desktop]);

  /** 升级检查：force=true（手动点）绕过节流并把错误显示出来；自动检查失败静默 */
  const checkUpdate = useCallback(async (force: boolean) => {
    setUpdateChecking(true);
    setUpdateError(null);
    try {
      setUpdate(await invoke<UpdateInfo>("update_check", { force }));
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateChecking(false);
    }
  }, []);

  // 进「关于」页顺手取一次当前状态（Rust 侧有 12h 节流，命中则不发请求）
  useEffect(() => {
    if (!desktop) return;
    void checkUpdate(false);
  }, [desktop, checkUpdate]);

  /** 去下载：优先当前平台直链（R2），退回 Release 页 */
  const openUpdate = useCallback(async () => {
    const url = update?.downloadUrl ?? update?.pageUrl;
    if (!url) return;
    try {
      await invoke("open_external", { url });
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, [update]);

  /** 应用内升级：下载 → 签名校验 → 原地替换 → 自动重启（成功不会 resolve） */
  const installInApp = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    setInstallProgress({ phase: "download", done: 0, total: 0, message: "准备下载…" });
    try {
      await installUpdate(setInstallProgress);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
      setInstallProgress(null);
    }
  }, []);

  /** 忽略/取消忽略某版本：只影响提示，不影响检查本身 */
  const toggleSkipVersion = useCallback(
    async (skip: boolean) => {
      try {
        await invoke("update_skip_version", {
          version: skip ? (update?.latest ?? null) : null,
        });
        setUpdate(await invoke<UpdateInfo>("update_check", { force: false }));
      } catch (err) {
        setUpdateError(err instanceof Error ? err.message : String(err));
      }
    },
    [update?.latest],
  );

  const setAutoCheck = useCallback(async (enabled: boolean) => {
    setUpdate((u) => (u ? { ...u, autoCheck: enabled } : u));
    try {
      await invoke("update_set_auto_check", { enabled });
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pickDevMode = useCallback(
    async (value: "on" | "off") => {
      const enabled = value === "on";
      if (enabled === devMode || busy) return;
      setBusy(true);
      setError(null);
      try {
        await invoke("set_dev_mode", { enabled });
        setDevMode(enabled);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [devMode, busy],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">关于</h1>

        {/* 应用信息：桌面端取 桌面壳元数据，网页端为静态降级 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">应用信息</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {desktop ? (
              <>
                <SettingRow label="应用名称">
                  <span className="text-muted-foreground text-sm">
                    {info?.name ?? "扣瓦"}
                  </span>
                </SettingRow>
                <SettingRow label="应用版本">
                  <span className="text-muted-foreground font-mono text-sm tabular-nums">
                    {info?.version ?? "-"}
                  </span>
                </SettingRow>
                <SettingRow label="Electron 版本">
                  <span className="text-muted-foreground font-mono text-sm tabular-nums">
                    {info?.runtime ?? "-"}
                  </span>
                </SettingRow>
              </>
            ) : (
              <SettingRow label="扣瓦（网页版）">
                <span className="text-muted-foreground text-sm">远程访问</span>
              </SettingRow>
            )}
          </div>
        </section>

        {/* 应用更新：通知清单走 dl.openkova.site（Rust 侧节流/忽略）；升级包由 桌面壳升级器 安装 */}
        {desktop && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">更新</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow label="应用更新" desc={updateSummary(update)}>
                {installing ? (
                  // 下载/安装进度：装完由 Rust 侧 app.restart() 自动重启，这里不会走到"完成"
                  <div className="flex w-56 flex-col gap-1.5">
                    <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">
                        {UPDATE_PHASE_LABEL[installProgress?.phase ?? ""] ?? "更新"}
                        {installProgress?.message ? `：${installProgress.message}` : "…"}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {progressPct(installProgress) !== null
                          ? `${progressPct(installProgress)}%`
                          : ""}
                      </span>
                    </div>
                    <div className="bg-background h-1.5 overflow-hidden rounded-full">
                      <div
                        className="bg-foreground h-full rounded-full transition-all duration-200"
                        style={{ width: `${progressPct(installProgress) ?? 0}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {update?.hasUpdate && !update.skipped ? (
                      <>
                        <Button size="sm" onClick={() => void installInApp()}>
                          <DownloadIcon className="size-4" />
                          下载并安装
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void openUpdate()}
                        >
                          <SquareArrowOutUpRightIcon className="size-4" />
                          网页下载
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateChecking}
                      onClick={() => void checkUpdate(true)}
                    >
                      <RefreshCwIcon
                        className={cn("size-4", updateChecking && "animate-spin")}
                      />
                      {updateChecking ? "检查中…" : "检查更新"}
                    </Button>
                    {update?.hasUpdate && !update.skipped ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void toggleSkipVersion(true)}
                      >
                        忽略此版本
                      </Button>
                    ) : null}
                    {update?.skipped ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void toggleSkipVersion(false)}
                      >
                        取消忽略
                      </Button>
                    ) : null}
                  </div>
                )}
              </SettingRow>
              <SettingRow
                label="自动检查更新"
                desc="启动后静默检查（每 12 小时最多一次）；只有发现新版本时才提示"
              >
                <Switch
                  checked={update?.autoCheck ?? true}
                  onCheckedChange={(v) => void setAutoCheck(v)}
                />
              </SettingRow>
            </div>
            {updateError && (
              <div className="text-destructive text-xs">
                检查更新失败：{updateError}
              </div>
            )}
            {installError && (
              <div className="text-destructive text-xs">
                自动更新失败：{installError}（可点「网页下载」手动安装）
              </div>
            )}
          </section>
        )}

        {/* 日志与反馈 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">支持与反馈</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {desktop && (
              <SettingRow
                label="日志目录"
                desc={
                  cleanMsg ??
                  logPath ??
                  "按天分目录存放应用（app）、pi-agent（pi-agent）、网页（web）三类日志，排查问题时可提供"
                }
              >
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button size="sm" variant="outline" disabled={cleanBusy}>
                          <Trash2Icon className="size-4" />
                          {cleanBusy ? "清理中..." : "清理"}
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem
                        onClick={() => void cleanLogs(7, "7 天前的日志")}
                        className="gap-2.5 py-2"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium">7 天前</span>
                          <span className="text-muted-foreground truncate text-xs">
                            删除 7 天前的日志目录
                          </span>
                        </div>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void cleanLogs(30, "30 天前的日志")}
                        className="gap-2.5 py-2"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium">30 天前</span>
                          <span className="text-muted-foreground truncate text-xs">
                            删除 30 天前的日志目录
                          </span>
                        </div>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void cleanLogs(0, "全部日志")}
                        className="gap-2.5 py-2"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="text-destructive text-sm font-medium">更久以前</span>
                          <span className="text-muted-foreground truncate text-xs">
                            清空今天以前的全部日志（当天保留）
                          </span>
                        </div>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button size="sm" variant="outline" onClick={() => void openLogs()}>
                    <FolderOpenIcon className="size-4" />
                    打开
                  </Button>
                </div>
              </SettingRow>
            )}
            <SettingRow label="问题反馈" desc={FEEDBACK_ISSUES_URL}>
              <Button size="sm" variant="outline" onClick={() => void openFeedback()}>
                <SquareArrowOutUpRightIcon className="size-4" />
                去反馈
              </Button>
            </SettingRow>
            {/* 资源管理器：独立窗口，看本应用自己的进程/内存占用与数据目录占用 */}
            <SettingRow
              label="资源管理器"
              desc="独立窗口：本应用的进程与内存占用、数据目录占用与缓存清理（也可从窗口菜单打开）"
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  void openResourceManager().catch((err) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
                }}
              >
                <CpuIcon className="size-4" />
                打开
              </Button>
            </SettingRow>
          </div>
        </section>

        {/* 追踪：OTLP 导出配置（原独立「追踪」页并入） */}
        <ObservabilitySection />

        {/* 开发者：DevTools 依赖桌面端 WebView 能力，网页端隐藏 */}
        {desktop && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">开发者</h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label="开发者模式"
                desc="打开 WebView DevTools 调试控制台，开启后重启应用自动恢复"
              >
                <Segmented
                  value={devMode ? "on" : "off"}
                  options={[
                    { value: "off", label: "关闭" },
                    { value: "on", label: "开启" },
                  ]}
                  onChange={(v) => void pickDevMode(v)}
                  disabled={busy}
                />
              </SettingRow>
            </div>
          </section>
        )}

        {error && <div className="text-destructive text-sm">{error}</div>}
      </div>
    </div>
  );
};
