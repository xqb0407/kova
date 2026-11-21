"use client";

/**
 * 已装插件页（与「市场」平级的主区页签）。
 *
 * 事实源在 sidecar plugins.ts：cache 物化目录 + 清单规范化 + kv 启用开关；
 * 本页渲染 usePlugins 镜像并发起变更命令。插件级开关/卸载触发 sidecar 四链
 * 热重载（skills 提示词重组 + MCP 连接池 diff + 子智能体重排，hooks 实时读）。
 *
 * 刻意不做组件级下钻：插件是原子交付单位，开/关只到插件粒度；技能与 MCP
 * 的常规管理在各自原位置（管理页）。组件以数量徽标摘要呈现，完整清单只在
 * 预览弹窗内展示（只读，不带独立开关）。
 *
 * 版式对齐市场目录卡片（panel-card 两层：灰壳标题行 + 内层反色面板，无描边，
 * 自然高，同行网格等高）：头部（壳上）= 图标 + 名称 + 版本徽标 + 元信息文本行
 * （生态/来源/开发模式降为纯文本，仅市场已移除/已停用保留徽标跟名）；
 * 面板 = 描述（clamp 两行）+ 页脚动作。构成徽标（技能/MCP/子智能体计数）已从
 * 卡面下架——明细本来就在预览弹窗里完整列出，卡面只留"是什么、要不要开"这一层；
 * 单行视图仍带徽标（密集列表那档才需要一眼扫构成）。
 * 版式与市场目录统一：按 category 分组的「两列扁平行」，行内 = 图标 +
 * 名称/版本/状态 + 来源 + 单行描述，行尾依次是更新 / 详情 / 卸载 / 启停开关。
 * 点行主体切换批量选中（内部按钮/开关不触发），点图标/名称/详情弹预览弹窗；
 * 选中走主色内描边；首次加载用同构骨架屏。工具条含搜索 + 检查更新 +
 * 全部更新，选中后变为批量条：批量启用 / 停用 / 卸载（卸载走确认弹窗）。
 */
import { useMemo, useState, type FC, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import {
  DownloadIcon,
  InfoIcon,
  Loader2Icon,
  PuzzleIcon,
  RefreshCwIcon,
  SquareCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  checkPluginUpdates,
  installPlugin,
  isPluginOpPending,
  PLUGIN_UPDATE_OP_TIMEOUT_MS,
  pluginUpdatesOf,
  setPluginsEnabledBatch,
  uninstallPluginsBatch,
  useMarketplaces,
  usePendingOps,
  usePlugins,
  waitForPluginOp,
  type PluginEntry,
} from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import {
  PluginPreviewDialog,
  type PluginPreviewMenuAction,
  type PluginPreviewPrimaryAction,
} from "@/components/marketplace/plugin-preview-dialog";
import { useT } from "@/lib/i18n";

/** 骨架行：与真实行同构（图标 + 名称/版本 + 单行描述 + 行尾动作） */
const PluginRowSkeleton = () => (
  <div className="border-border/50 flex items-center gap-3.5 rounded-xl border p-3">
    <Skeleton className="size-10 shrink-0 rounded-lg" />
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="h-3 w-4/5" />
    </div>
    <Skeleton className="size-7 shrink-0 rounded-md" />
  </div>
);

/** 首次加载占位：工具行 + 一屏骨架行 */
const PluginListSkeleton = () => (
  <div className="flex h-full min-h-0 flex-col gap-2 py-6 pt-2">
    <div className="flex items-center gap-2">
      <Skeleton className="h-9 w-64 max-w-xs rounded-lg" />
      <div className="flex-1" />
      <Skeleton className="h-8 w-24 rounded-lg" />
    </div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] content-start gap-x-6 gap-y-0.5">
      {Array.from({ length: 6 }, (_, i) => (
        <PluginRowSkeleton key={i} />
      ))}
    </div>
  </div>
);

/** 卸载确认弹窗（单个/批量共用，文案点名插件名与后果） */
const UninstallDialog = dynamic(
  () => import("@/components/marketplace/uninstall-dialog").then((m) => ({ default: m.UninstallDialog })),
  { ssr: false },
);

/** 装后配置弹窗（⋯ 菜单「配置」入口 + 卡片徽章共用） */
const PluginConfigDialog = dynamic(
  () => import("@/components/marketplace/plugin-config-dialog").then((m) => ({ default: m.PluginConfigDialog })),
  { ssr: false },
);
type PluginConfigTarget = import("@/components/marketplace/plugin-config-dialog").PluginConfigTarget;

const MANIFEST_KIND_LABEL_KEY: Record<PluginEntry["manifestKind"], string> = {
  kova: "kova",
  claude: "marketplace.plugins.manifest.claude",
  codex: "marketplace.plugins.manifest.codex",
};

export const InstalledPlugins: FC = () => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
  const snap = usePlugins(workspace);
  /** 目录侧版本用于「可更新」比对；进页先读缓存，点「检查更新」再刷新源 */
  const marketplacesSnap = useMarketplaces();
  const pending = usePendingOps();
  const [checking, setChecking] = useState(false);
  /** 批量更新的本地互斥：首次 op 受理前还有一个渲染窗口，单靠 pending 挡不住连点 */
  const [updatingAll, setUpdatingAll] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<PluginEntry[] | null>(null);
  /** 预览弹窗：存 pluginId，渲染期从最新快照推导（启停/更新后弹窗内容自动跟随） */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = previewId
    ? (snap.plugins.find((p) => p.pluginId === previewId) ?? null)
    : null;
  // 装后配置弹窗（⋯ 菜单「配置」入口）
  const [configTarget, setConfigTarget] = useState<PluginConfigTarget | null>(null);

  const plugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = snap.plugins;
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.displayName ?? "").toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.marketplaceName.toLowerCase().includes(q),
    );
  }, [snap.plugins, query]);

  /** 已装列表按 category 分组（与市场目录同一套分组版式；无品类归「其他」） */
  const grouped = useMemo(() => {
    const byCategory = new Map<string, typeof plugins>();
    for (const p of plugins) {
      const key = p.category?.trim() || "";
      const list = byCategory.get(key) ?? [];
      list.push(p);
      byCategory.set(key, list);
    }
    return [...byCategory.entries()];
  }, [plugins]);

  /** 可更新：目录版本 ≠ 已装版本（链接装、市场已移除在 helper 里排除） */
  const updates = useMemo(
    () => pluginUpdatesOf(snap.plugins, marketplacesSnap.marketplaces),
    [snap.plugins, marketplacesSnap.marketplaces],
  );
  const updatesById = useMemo(
    () => new Map(updates.map((u) => [u.pluginId, u])),
    [updates],
  );

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
  const selectAllFiltered = () =>
    setSelected(new Set(plugins.map((p) => p.pluginId)));

  const busy = pending.length > 0;

  const runBatchEnable = () => {
    const ids = targets.map((p) => p.pluginId);
    void setPluginsEnabledBatch(ids, batchEnable, workspace).then(clearSelection);
  };
  const runBatchUninstall = () => {
    if (targets.length > 0) setConfirmUninstall(targets);
  };

  /** 检查更新：逐个刷新登记市场（单市场失败不影响其余），版本差随快照回流 */
  const runCheck = () => {
    if (checking) return;
    setChecking(true);
    void checkPluginUpdates()
      .then(({ failed }) => {
        if (failed.length === 0) return;
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.error({
            title: t("marketplace.installed.checkUpdateFailed"),
            description: failed.join("\n"),
          });
        });
      })
      .finally(() => setChecking(false));
  };

  /** 全部更新：串行装（同一市场共用一份工作副本，并发刷新会互相覆盖） */
  const runUpdateAll = () => {
    if (updatingAll || updates.length === 0) return;
    const targets = updates;
    setUpdatingAll(true);
    void (async () => {
      for (const u of targets) {
        try {
          await waitForPluginOp(
            await installPlugin(u.marketplaceId, u.name),
            PLUGIN_UPDATE_OP_TIMEOUT_MS,
          );
        } catch {
          // 单个失败不阻断其余：失败项保持「可更新」，用户可单独重试
        }
      }
    })().finally(() => setUpdatingAll(false));
  };

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
        {/* 缺省页与搜索/资料库同一套点阵云 + 图标瓷片 */}
        <div className="relative mb-1 grid place-items-center">
          <DotCloud />
          <div className="bg-muted/50 absolute grid size-14 place-items-center rounded-2xl border backdrop-blur-sm">
            <PuzzleIcon className="text-muted-foreground size-6" />
          </div>
        </div>
        <p className="text-sm font-medium">
          {t("marketplace.installed.emptyTitle")}
        </p>
        <p className="text-sm">{t("marketplace.installed.emptyDesc")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-6 pt-2">
      {/* 工具行：搜索 + 视图切换；选中后变为批量操作条 */}
      {selectionActive ? (
        <div className="flex h-9 items-center gap-2">
          <Badge variant="secondary" className="gap-1 px-2">
            <SquareCheckIcon className="size-3.5" />
            {t("marketplace.installed.selected", { count: selected.size })}
          </Badge>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={selectAllFiltered}>
            {t("marketplace.installed.selectAll")}
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={clearSelection}>
            {t("marketplace.installed.clear")}
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={runBatchEnable}
          >
            {batchEnable
              ? t("marketplace.installed.batchEnable")
              : t("marketplace.installed.batchDisable")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={runBatchUninstall}
          >
            <Trash2Icon className="size-3.5" />
            {t("marketplace.installed.batchUninstall")}
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 text-xs" onClick={clearSelection}>
            {t("marketplace.common.cancel")}
          </Button>
        </div>
      ) : (
        <div className="flex h-9 items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("marketplace.installed.searchPlaceholder")}
            className="max-w-xs"
          />
          {snap.loading && <RefreshCwIcon className="text-muted-foreground size-4 animate-spin" />}
          <div className="flex-1" />
          {updates.length > 0 && (
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={busy || updatingAll}
              onClick={runUpdateAll}
            >
              <DownloadIcon className="size-3.5" />
              {t("marketplace.installed.updateAll", { count: updates.length })}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={checking || busy || updatingAll}
            onClick={runCheck}
            title={t("marketplace.installed.checkUpdateHint")}
          >
            <RefreshCwIcon
              className={cn("size-3.5", checking && "animate-spin")}
            />
            {t("marketplace.installed.checkUpdate")}
          </Button>
        </div>
      )}

      {/* 已装列表：与市场目录同一套「分类 + 两列扁平行」版式。
          行内保留管理动作（更新 / 详情 / 卸载 / 启停），点行主体切换批量选中 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {grouped.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PuzzleIcon className="size-8" />
            {query.trim()
              ? t("marketplace.view.noMatch", { query: query.trim() })
              : t("marketplace.installed.emptyTitle")}
          </div>
        ) : (
          grouped.map(([category, rows], index) => (
            <section
              key={category || "__other"}
              className={index === 0 ? "mt-1" : "mt-6"}
            >
              <h3 className="text-foreground mb-0.5 px-3 text-sm font-semibold">
                {category || t("marketplace.view.categoryOther")}
              </h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-0.5">
                {rows.map((p) => {
                  const installBusy = isPluginOpPending(
                    "install_plugin",
                    `${p.marketplaceId}:${p.name}`,
                  );
                  const updateInfo = updatesById.get(p.pluginId);
                  const checked = selected.has(p.pluginId);

                  const versionBadge = (
                    <Badge
                      variant="outline"
                      className="shrink-0 px-1.5 font-mono text-xs font-normal"
                    >
                      v{p.version}
                    </Badge>
                  );
                  const statusBadges = (
                    <span className="flex shrink-0 items-center gap-1.5">
                      {updateInfo && (
                        <Badge
                          variant="secondary"
                          className="font-normal"
                          title={t("marketplace.installed.updateHint", {
                            current: updateInfo.currentVersion,
                            latest: updateInfo.latestVersion,
                          })}
                        >
                          {t("marketplace.installed.updateAvailable")}
                        </Badge>
                      )}
                      {p.sourceMissing && (
                        <Badge variant="destructive" className="font-normal">
                          {t("marketplace.installed.sourceMissing")}
                        </Badge>
                      )}
                      {!p.enabled && (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground font-normal"
                        >
                          {t("marketplace.installed.disabled")}
                        </Badge>
                      )}
                      {p.configState && p.configState.state !== "configured" && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 font-normal text-amber-700 dark:text-amber-400"
                        >
                          {p.configState.state === "stale"
                            ? t("marketplace.installed.needsRebind")
                            : t("marketplace.installed.needsConfig")}
                        </Badge>
                      )}
                    </span>
                  );
                  // 生态 / 来源 / 开发模式压成标题行尾的 muted 文本，
                  // 缩略后 hover 看全量（开发模式另有更细的源目录说明）
                  const metaTitle = [
                    ...(p.manifestKind !== "kova"
                      ? [t(MANIFEST_KIND_LABEL_KEY[p.manifestKind])]
                      : []),
                    t("marketplace.installed.from", {
                      name: p.marketplaceName,
                    }),
                    ...(p.linked ? [t("marketplace.installed.devMode")] : []),
                  ].join(" · ");
                  const enableSwitch = (
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(v) => {
                        setSelected(new Set([p.pluginId]));
                        void setPluginsEnabledBatch([p.pluginId], v, workspace);
                      }}
                      aria-label={t("marketplace.installed.enableAria", {
                        name: p.displayName ?? p.name,
                      })}
                    />
                  );
                  const openPreview = (e: MouseEvent) => {
                    e.stopPropagation();
                    setPreviewId(p.pluginId);
                  };
                  const iconBox = (
                    <div
                      onClick={openPreview}
                      title={t("marketplace.installed.detailAria")}
                      className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg"
                    >
                      <PluginIcon
                        src={p.icon}
                        name={p.displayName ?? p.name}
                        className="text-lg"
                      />
                    </div>
                  );
                  const detailBtn = (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      onClick={openPreview}
                      title={t("marketplace.installed.detailAria")}
                    >
                      <InfoIcon className="size-3.5" />
                      <span className="sr-only">
                        {t("marketplace.common.detail")}
                      </span>
                    </Button>
                  );
                  const updateBtn = updateInfo ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-primary"
                      disabled={busy || updatingAll}
                      onClick={() => void installPlugin(p.marketplaceId, p.name)}
                      title={
                        installBusy
                          ? t("marketplace.installed.updating")
                          : t("marketplace.installed.updateTo", {
                              version: updateInfo.latestVersion,
                            })
                      }
                    >
                      {installBusy ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <DownloadIcon className="size-3.5" />
                      )}
                      <span className="sr-only">
                        {t("marketplace.installed.updateTo", {
                          version: updateInfo.latestVersion,
                        })}
                      </span>
                    </Button>
                  ) : null;
                  const uninstallBtn = (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => setConfirmUninstall([p])}
                      title={t("marketplace.common.uninstall")}
                    >
                      <Trash2Icon className="size-3.5" />
                      <span className="sr-only">
                        {t("marketplace.common.uninstall")}
                      </span>
                    </Button>
                  );

                  return (
                    <div
                      key={p.pluginId}
                      onClick={handleCardClick(p.pluginId)}
                      className={cn(
                        "group border-border/50 flex cursor-pointer items-center gap-3.5 rounded-xl border p-3 transition-colors",
                        checked
                          ? "bg-muted/50 ring-1 ring-inset ring-primary/50"
                          : "hover:bg-muted/40",
                      )}
                    >
                      {iconBox}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <span
                            className="cursor-pointer truncate text-sm font-medium"
                            onClick={openPreview}
                            title={t("marketplace.installed.detailAria")}
                          >
                            {p.displayName ?? p.name}
                          </span>
                          {versionBadge}
                          {statusBadges}
                          <span
                            className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
                            title={metaTitle}
                          >
                            {p.manifestKind !== "kova" && (
                              <>
                                {t(MANIFEST_KIND_LABEL_KEY[p.manifestKind])}
                                {" · "}
                              </>
                            )}
                            {t("marketplace.installed.from", {
                              name: p.marketplaceName,
                            })}
                            {p.linked && (
                              <span
                                title={
                                  p.sourcePath
                                    ? t(
                                        "marketplace.installed.linkedToSource",
                                        { path: p.sourcePath },
                                      )
                                    : t(
                                        "marketplace.installed.linkedToSourceNoPath",
                                      )
                                }
                              >
                                {" · "}
                                {t("marketplace.installed.devMode")}
                              </span>
                            )}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-0.5 truncate text-xs leading-5">
                          {p.description ||
                            t("marketplace.preview.noDescription")}
                        </p>
                      </div>
                      {/* 动作区吞掉点击：行主体是批量选中，开关/按钮不触发它 */}
                      <div
                        className="flex shrink-0 items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {updateBtn}
                        {detailBtn}
                        {uninstallBtn}
                        {enableSwitch}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
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

      {/* 预览弹窗：内容随快照刷新（启停/更新即变）；卸载走既有确认弹窗，先关本弹窗 */}
      <PluginPreviewDialog
        preview={
          preview
            ? {
                name: preview.name,
                ...(preview.displayName
                  ? { displayName: preview.displayName }
                  : {}),
                version: preview.version,
                description: preview.description,
                icon: preview.icon,
                category: preview.category,
                keywords: undefined,
                marketplaceName: preview.marketplaceName,
                installed: preview,
              }
            : null
        }
        onClose={() => setPreviewId(null)}
        primaryAction={
          preview
            ? {
                label: preview.enabled
                  ? t("marketplace.common.disable")
                  : t("marketplace.common.enable"),
                disabled: busy,
                onClick: () =>
                  void setPluginsEnabledBatch(
                    [preview.pluginId],
                    !preview.enabled,
                    workspace,
                  ),
              }
            : undefined
        }
        menuActions={
          preview
            ? [
                // 链接装常驻源目录、市场已移除的没有更新通道，不给「更新」入口
                ...(preview.linked || preview.sourceMissing
                  ? []
                  : [
                      {
                        label: t("marketplace.installed.updateNow"),
                        disabled: busy,
                        onSelect: () =>
                          void installPlugin(
                            preview.marketplaceId,
                            preview.name,
                          ),
                      },
                    ]),
                ...(preview.configSchema?.length
                  ? [
                      {
                        label: t("marketplace.view.configure"),
                        onSelect: () =>
                          setConfigTarget({
                            pluginId: preview.pluginId,
                            name: preview.name,
                            ...(preview.displayName
                              ? { displayName: preview.displayName }
                              : {}),
                          }),
                      },
                    ]
                  : []),
                {
                  label: t("marketplace.common.uninstall"),
                  destructive: true,
                  disabled: busy,
                  onSelect: () => {
                    setConfirmUninstall([preview]);
                    setPreviewId(null);
                  },
                },
              ]
            : []
        }
      />

      {/* 装后配置弹窗 */}
      <PluginConfigDialog
        target={configTarget}
        onClose={() => setConfigTarget(null)}
      />
    </div>
  );
};
