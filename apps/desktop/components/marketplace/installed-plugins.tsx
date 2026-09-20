"use client";

/**
 * 已装插件页（与「市场」平级的主区页签）。
 *
 * 事实源在 sidecar plugins.ts：cache 物化目录 + 清单规范化 + kv 启用开关；
 * 本页渲染 usePlugins 镜像并发起变更命令。插件级开关/卸载触发 sidecar 四链
 * 热重载（skills 提示词重组 + MCP 连接池 diff + 子智能体重排，hooks 实时读）。
 *
 * 刻意不做组件级下钻：插件是原子交付单位，开/关只到插件粒度；技能与 MCP
 * 的常规管理在各自原位置（管理页）。组件以数量徽标摘要呈现。
 *
 * 版式对齐市场目录卡片（白底描边、扁平、固定高）：搜索 + 视图切换 + 批量条，
 * 双视图（卡片一行多个 / 单行列表）；点卡片主体切换选中（内部按钮/开关不
 * 触发），选中即常驻 hover 同款 bg-muted/50，无 checkbox/角标；首次加载用
 * 同构骨架屏；选中驱动批量条：批量启用 / 停用 / 卸载（卸载走确认弹窗，
 * 逐个走既有协议消息，N 次四链热重载——插件量小，正确性优先）。
 */
import { useMemo, useState, type FC, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import {
  DownloadIcon,
  LayoutGridIcon,
  ListIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SquareCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { BadgeOverflow } from "@/components/ui/badge-overflow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/lib/workspace-store";
import {
  installPlugin,
  isPluginOpPending,
  setPluginsEnabledBatch,
  uninstallPluginsBatch,
  usePendingOps,
  usePlugins,
  type PluginEntry,
} from "@/lib/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";

/** 骨架卡片：与真实卡片同构（头部图标行 + 描述两行 + 页脚徽标/按钮） */
const PluginCardSkeleton = () => (
  <div className="rounded-2xl border bg-white p-4 dark:bg-background">
    <div className="flex items-start gap-3">
      <Skeleton className="size-9 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
    </div>
    <div className="mt-2 space-y-1.5">
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-3/5" />
    </div>
    <div className="mt-3 flex items-center justify-between">
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-11 rounded-full" />
        <Skeleton className="h-5 w-11 rounded-full" />
      </div>
      <Skeleton className="h-7 w-14 rounded-md" />
    </div>
  </div>
);

/** 首次加载占位：工具行 + 一屏骨架卡片 */
const PluginListSkeleton = () => (
  <div className="flex h-full min-h-0 flex-col gap-2 py-6 pt-2">
    <div className="flex items-center gap-2">
      <Skeleton className="h-9 w-64 max-w-xs rounded-lg" />
      <div className="flex-1" />
      <Skeleton className="h-8 w-18 rounded-lg" />
    </div>
    <div className="grid grid-cols-1 content-start gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <PluginCardSkeleton key={i} />
      ))}
    </div>
  </div>
);

/** 卸载确认弹窗（单个/批量共用，文案点名插件名与后果） */
const UninstallDialog = dynamic(
  () => import("@/components/marketplace/uninstall-dialog").then((m) => ({ default: m.UninstallDialog })),
  { ssr: false },
);

const MANIFEST_KIND_LABEL: Record<PluginEntry["manifestKind"], string> = {
  xulux: "xulux",
  claude: "Claude 生态",
  codex: "Codex 生态",
};

export const InstalledPlugins: FC = () => {
  const workspace = useWorkspace();
  const snap = usePlugins(workspace);
  const pending = usePendingOps();
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "rows">("cards");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<PluginEntry[] | null>(null);

  const plugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = snap.plugins;
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.marketplaceName.toLowerCase().includes(q),
    );
  }, [snap.plugins, query]);

  const selectionActive = selected.size > 0;
  const targets = useMemo(
    () => plugins.filter((p) => selected.has(p.pluginId)),
    [plugins, selected],
  );
  const targetsEnabledCount = targets.filter((p) => p.enabled).length;
  /** 批量启停后的期望状态：有停用项 → 批量启用；全启用 → 批量停用 */
  const batchEnable = targetsEnabledCount < targets.length;

  const toggleSelect = (pluginId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });
  };
  /** 点卡片主体切换选中；内部按钮/开关等交互元素不触发 */
  const handleCardClick = (pluginId: string) => (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, [role='switch'], [role='checkbox'], input, a")) return;
    toggleSelect(pluginId);
  };
  const clearSelection = () => setSelected(new Set());
  const selectAllFiltered = () => setSelected(new Set(plugins.map((p) => p.pluginId)));

  const busy = pending.length > 0;

  const runBatchEnable = () => {
    const ids = targets.map((p) => p.pluginId);
    void setPluginsEnabledBatch(ids, batchEnable, workspace).then(clearSelection);
  };
  const runBatchUninstall = () => setConfirmUninstall(targets);

  if (snap.loading && snap.plugins.length === 0) return <PluginListSkeleton />;

  if (snap.error) {
    return (
      <div className="text-destructive flex h-full items-center justify-center text-sm">
        {snap.error}
      </div>
    );
  }

  if (snap.plugins.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2">
        <div className="bg-muted/50 grid size-12 place-items-center rounded-2xl border">
          <PuzzleIcon className="text-muted-foreground size-6" />
        </div>
        <p className="text-sm font-medium">还没有已安装的插件</p>
        <p className="text-sm">切到「市场」页签添加插件市场并安装。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-6 pt-2">
      {/* 工具行：搜索 + 视图切换；选中后变为批量操作条 */}
      {selectionActive ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1 px-2">
            <SquareCheckIcon className="size-3.5" />
            已选 {selected.size}
          </Badge>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={selectAllFiltered}>
            全选
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={clearSelection}>
            清除
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={runBatchEnable}
          >
            {batchEnable ? "批量启用" : "批量停用"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={runBatchUninstall}
          >
            <Trash2Icon className="size-3.5" />
            批量卸载
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={clearSelection}>
            取消
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件…"
            className="max-w-xs"
          />
          {snap.loading && <RefreshCwIcon className="text-muted-foreground size-4 animate-spin" />}
          <div className="flex-1" />
          <div className="border-input flex items-center rounded-lg border p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7 rounded-md", viewMode === "cards" && "bg-muted")}
              onClick={() => setViewMode("cards")}
              aria-label="卡片视图"
              title="卡片视图"
            >
              <LayoutGridIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7 rounded-md", viewMode === "rows" && "bg-muted")}
              onClick={() => setViewMode("rows")}
              aria-label="单行视图"
              title="单行视图"
            >
              <ListIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* 双视图列表 */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto pb-4",
          viewMode === "cards" ? "grid grid-cols-1 content-start gap-3 md:grid-cols-2 xl:grid-cols-3" : "space-y-2",
        )}
      >
        {plugins.map((p) => {
          const installBusy = isPluginOpPending("install_plugin", `${p.marketplaceId}:${p.name}`);
          const checked = selected.has(p.pluginId);
          const componentBadges = [
            p.components.skills.length > 0 ? `技能${p.components.skills.length}` : null,
            p.components.mcpServers.length > 0 ? `MCP${p.components.mcpServers.length}` : null,
            p.components.subagents.length > 0 ? `子智能体${p.components.subagents.length}` : null,
          ].filter(Boolean);

          const meta = (
            <>
              <Badge variant="outline" className="px-1.5 font-mono text-[11px] font-normal">
                v{p.version}
              </Badge>
              {p.manifestKind !== "xulux" && (
                <Badge variant="secondary" className="font-normal">
                  {MANIFEST_KIND_LABEL[p.manifestKind]}
                </Badge>
              )}
              {p.sourceMissing && (
                <Badge variant="destructive" className="font-normal">
                  市场已移除
                </Badge>
              )}
              {!p.enabled && (
                <Badge variant="outline" className="text-muted-foreground font-normal">
                  已停用
                </Badge>
              )}
            </>
          );
          const desc = p.description ? (
            <p className="text-muted-foreground mt-2 line-clamp-2 text-sm">{p.description}</p>
          ) : null;
          const badges = componentBadges.length > 0 && (
            <BadgeOverflow items={componentBadges} />
          );
          const enableSwitch = (
            <Switch
              checked={p.enabled}
              onCheckedChange={(v) => {
                setSelected(new Set([p.pluginId]));
                void setPluginsEnabledBatch([p.pluginId], v, workspace);
              }}
              aria-label={`启用插件 ${p.name}`}
            />
          );
          const uninstallBtn = (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => setConfirmUninstall([p])}
            >
              <Trash2Icon className="size-3.5" />
              卸载
            </Button>
          );
          const updateBtn = (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => void installPlugin(p.marketplaceId, p.name)}
            >
              <DownloadIcon className={cn("size-3.5", installBusy && "animate-pulse")} />
              {installBusy ? "更新中…" : "检查更新"}
            </Button>
          );
          const iconBox = (
            <div className="bg-background grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl border">
              <PluginIcon src={p.icon} />
            </div>
          );

          if (viewMode === "rows") {
            return (
              <div
                key={`${viewMode}-${p.pluginId}`}
                onClick={handleCardClick(p.pluginId)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-2xl border bg-white px-4 py-2.5 transition-colors dark:bg-background",
                  checked && "bg-muted/50",
                  !checked && "hover:bg-muted/50",
                )}
              >
                {iconBox}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {meta}
                  {desc && (
                    <span className="text-muted-foreground hidden truncate text-sm lg:block">
                      {p.description}
                    </span>
                  )}
                  {badges && <span className="hidden shrink-0 xl:flex">{badges}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-muted-foreground/70 mr-1 hidden truncate text-xs sm:block">
                    {p.marketplaceName}
                  </span>
                  {updateBtn}
                  {uninstallBtn}
                  {enableSwitch}
                </div>
              </div>
            );
          }

          return (
            <div
              key={`${viewMode}-${p.pluginId}`}
              onClick={handleCardClick(p.pluginId)}
              className={cn(
                "flex h-40 cursor-pointer flex-col overflow-hidden rounded-2xl border bg-white p-4 transition-colors dark:bg-background",
                checked && "bg-muted/50",
                !checked && "hover:bg-muted/50",
              )}
            >
              <div className="flex items-start gap-3">
                {iconBox}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {meta}
                  </div>
                  <p className="text-muted-foreground/70 mt-0.5 truncate text-xs">
                    来自 {p.marketplaceName}
                  </p>
                </div>
                <div className="shrink-0">{enableSwitch}</div>
              </div>
              {desc}
              <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                {badges && <div className="min-w-0">{badges}</div>}
                <div className="flex shrink-0 items-center gap-1">
                  {updateBtn}
                  {uninstallBtn}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <UninstallDialog
        entries={confirmUninstall}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={(entries) => {
          void uninstallPluginsBatch(
            entries.map((e) => e.pluginId),
            workspace,
          ).then(clearSelection);
          setConfirmUninstall(null);
        }}
      />
    </div>
  );
};
