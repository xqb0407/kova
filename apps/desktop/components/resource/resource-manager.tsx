"use client";

import { useEffect, useRef, type FC } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Segmented } from "@/components/custom-ui/segmented";
import { Button } from "@/components/ui/button";
import {
  diskUsedPct,
  formatBytes,
  formatClock,
  formatPct,
  shortenHome,
} from "@/lib/resource/format";
import type { Category, ResourceTab, Sample, Storage } from "@/lib/resource/types";
import { cn } from "@/lib/utils";
import { MetricTiles, type MetricTile } from "./metric-tiles";
import { ProcessTable } from "./process-table";
import { StorageTable } from "./storage-panel";

const TABS: { value: ResourceTab; label: string }[] = [
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "内存" },
  { value: "storage", label: "存储" },
];

/**
 * 资源管理器视图（纯展示）：数据、页签与所有回调都由调用方传入。
 *
 * 三页共用同一套层级：**顶部指标磁贴 → 一张平表 → 一行状态**。不做卡片套卡片、
 * 不用圆角面板包表格，颜色只出现在数据本身（占比条、走势）。取数与展示分开，
 * 所以同一份组件既给资源管理器窗口用，也给 dev-preview 预览页用。
 */
export const ResourceManagerView: FC<{
  desktop: boolean;
  /** 运行环境尚未判定（预渲染首帧）：不渲染任何会与预渲染 HTML 冲突的内容 */
  booting?: boolean;
  tab: ResourceTab;
  onTabChange: (tab: ResourceTab) => void;
  sample: Sample | null;
  sampleError: string | null;
  /** CPU 采样历史（百分比，末尾为最新）：顶部磁贴的走势 */
  history: { appCpu: number[]; sysCpu: number[] };
  storage: Storage | null;
  storageLoading: boolean;
  storageError: string | null;
  onRescan: () => void;
  onClean: (category: Category) => void;
  onReveal: (category: Category) => void;
  cleaningId: string | null;
  notice: string | null;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (id: string) => void;
}> = ({
  desktop,
  booting = false,
  tab,
  onTabChange,
  sample,
  sampleError,
  history,
  storage,
  storageLoading,
  storageError,
  onRescan,
  onClean,
  onReveal,
  cleaningId,
  notice,
  expandedGroups,
  onToggleGroup,
}) => {
  const appName = sample?.appName ?? storage?.appName ?? "Kova";
  const scrollRef = useRef<HTMLDivElement>(null);
  // 切页签把滚动位置归零：三页是并列视图，不共享滚动位置——否则从滚到一半的
  // 进程表切到存储页，会把该页顶部的工具栏顶出视野，看起来像页面缺了一块
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const subtitle =
    tab === "storage"
      ? storage
        ? shortenHome(storage.dataDir)
        : storageLoading
          ? "正在统计数据目录…"
          : "尚未统计"
      : sample
        ? `${sample.processCount} 个进程`
        : "正在采样…";

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">资源管理器</h1>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{subtitle}</p>
        </div>
        {desktop && <Segmented value={tab} options={TABS} onChange={onTabChange} size="lg" />}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {booting ? null : !desktop ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 pb-16 text-center">
            <p className="text-sm font-medium">资源管理器只在桌面应用中可用</p>
            <p className="text-muted-foreground max-w-sm text-xs">
              它读的是本机进程与应用数据目录，网页端拿不到这些信息。请打开桌面客户端查看。
            </p>
          </div>
        ) : tab === "storage" ? (
          <div className="flex flex-col gap-4">
            <MetricTiles tiles={storage ? storageTiles(storage) : []} />

            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" disabled={storageLoading} onClick={onRescan}>
                <RefreshCwIcon className={cn("size-4", storageLoading && "animate-spin")} />
                {storageLoading ? "统计中…" : "重新计算"}
              </Button>
              {storage && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  上次计算 {formatClock(storage.tsMs)}
                </span>
              )}
              {notice && <span className="text-muted-foreground text-xs">{notice}</span>}
              {storageError && <span className="text-destructive text-xs">{storageError}</span>}
            </div>

            {storage ? (
              <StorageTable
                storage={storage}
                onClean={onClean}
                onReveal={onReveal}
                cleaningId={cleaningId}
              />
            ) : (
              <div className="text-muted-foreground py-6 text-sm">
                {storageLoading ? "正在统计各目录占用…" : "点「重新计算」开始统计。"}
              </div>
            )}

            <p className="text-muted-foreground text-xs">
              大小为估算值
              {storage?.truncated ? "（已达本次扫描上限，实际更大）" : ""}
              ，硬链接与克隆文件可能重复计算；只有日志、浏览器渲染缓存与模型调用缓存提供清理。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <MetricTiles tiles={sample ? tilesFor(sample, tab, history) : []} />
            <ProcessTable
              groups={sample?.groups ?? []}
              metric={tab === "cpu" ? "cpu" : "mem"}
              expanded={expandedGroups}
              onToggle={onToggleGroup}
            />
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
              <span>
                {sample ? `${sample.processCount} 个进程` : "正在采样…"} · {sample?.cpuCount ?? "-"}{" "}
                核
              </span>
              <span aria-hidden>·</span>
              <span>只统计本应用自身及其拉起的进程；CPU 为占整机百分比，内存为常驻集估算</span>
              {sampleError && <span className="text-destructive">采样失败：{sampleError}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/** CPU / 内存页的磁贴：当前页签的主指标在前，另一项作为对照在后 */
function tilesFor(
  sample: Sample,
  tab: ResourceTab,
  history: { appCpu: number[]; sysCpu: number[] },
): MetricTile[] {
  const memShare = pct(sample.appMem, sample.sysMemTotal);
  const cpuTile: MetricTile = {
    id: "app-cpu",
    label: "本应用 CPU",
    value: formatPct(sample.appCpu),
    hint: `${sample.processCount} 个进程`,
    series: history.appCpu,
  };
  const sysCpuTile: MetricTile = {
    id: "sys-cpu",
    label: "整机 CPU",
    value: formatPct(sample.sysCpu),
    hint: `${sample.cpuCount} 核`,
    series: history.sysCpu,
  };
  const memTile: MetricTile = {
    id: "app-mem",
    label: "本应用 内存",
    value: formatBytes(sample.appMem),
    hint: `占整机 ${formatPct(memShare)}`,
    barPct: memShare,
  };
  const sysMemTile: MetricTile = {
    id: "sys-mem",
    label: "整机 内存",
    value: formatPct(pct(sample.sysMemUsed, sample.sysMemTotal)),
    hint: `${formatBytes(sample.sysMemUsed)} / ${formatBytes(sample.sysMemTotal)}`,
    barPct: pct(sample.sysMemUsed, sample.sysMemTotal),
  };
  return tab === "cpu"
    ? [
        cpuTile,
        sysCpuTile,
        {
          id: "mem-context",
          label: "本应用 内存",
          value: formatBytes(sample.appMem),
          hint: `整机 ${formatBytes(sample.sysMemUsed)} / ${formatBytes(sample.sysMemTotal)}`,
          barPct: memShare,
        },
      ]
    : [
        memTile,
        sysMemTile,
        { ...cpuTile, hint: `整机 ${formatPct(sample.sysCpu)}`, series: history.appCpu },
      ];
}

/** 存储页的磁贴：总占用 / 所在卷 / 可清理（可清理那一项直接对应表里的三个按钮） */
function storageTiles(storage: Storage): MetricTile[] {
  const used = diskUsedPct(storage.disk);
  const cleanable = storage.categories
    .filter((c) => c.cleanable)
    .reduce((sum, c) => sum + c.bytes, 0);
  return [
    {
      id: "total",
      label: `${storage.appName} 总占用`,
      value: formatBytes(storage.totalBytes),
      hint: `${storage.categories.length} 个类目`,
    },
    {
      id: "volume",
      label: `所在卷${storage.disk.mount ? ` ${storage.disk.mount}` : ""}`,
      value: storage.disk.total > 0 ? `${used.toFixed(1)}% 已用` : "未知容量",
      hint:
        storage.disk.total > 0
          ? `剩余 ${formatBytes(storage.disk.free)} / 共 ${formatBytes(storage.disk.total)}`
          : undefined,
      barPct: used,
    },
    {
      id: "cleanable",
      label: "可清理",
      value: formatBytes(cleanable),
      hint: "日志 / 浏览器缓存 / 模型缓存",
    },
  ];
}

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return (value / total) * 100;
}
