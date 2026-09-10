"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isTauri } from "@/lib/tauri";
import { FolderOpenIcon, SquareArrowOutUpRightIcon, Trash2Icon } from "lucide-react";

/** 问题反馈：gitee 仓库 issue 页（origin remote） */
const FEEDBACK_URL = "https://gitee.com/herther/pi-desktop/issues";

type AppInfo = { name: string; version: string; tauri: string };

/** 关于页：应用信息、日志目录、问题反馈、开发者模式（DevTools，仅桌面端） */
export const AboutSettings: FC = () => {
  const desktop = isTauri();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    (async () => {
      try {
        const [name, version, tauri] = await Promise.all([
          getName(),
          getVersion(),
          getTauriVersion(),
        ]);
        setInfo({ name, version, tauri });
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
      if (desktop) await invoke("open_external", { url: FEEDBACK_URL });
      else window.open(FEEDBACK_URL, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [desktop]);

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

        {/* 应用信息：桌面端取 Tauri 元数据，网页端为静态降级 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">应用信息</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {desktop ? (
              <>
                <SettingRow label="应用名称">
                  <span className="text-muted-foreground text-sm">
                    {info?.name ?? "Xulux Assistant"}
                  </span>
                </SettingRow>
                <SettingRow label="应用版本">
                  <span className="text-muted-foreground font-mono text-sm tabular-nums">
                    {info?.version ?? "-"}
                  </span>
                </SettingRow>
              </>
            ) : (
              <SettingRow label="Xulux Assistant（网页版）">
                <span className="text-muted-foreground text-sm">远程访问</span>
              </SettingRow>
            )}
          </div>
        </section>

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
            <SettingRow label="问题反馈" desc={FEEDBACK_URL}>
              <Button size="sm" variant="outline" onClick={() => void openFeedback()}>
                <SquareArrowOutUpRightIcon className="size-4" />
                去反馈
              </Button>
            </SettingRow>
          </div>
        </section>

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
