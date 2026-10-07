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
 * 版式对齐市场目录卡片（白底描边、扁平、自然高，同行网格等高）：头部 =
 * 图标 + 名称 + 版本徽标 + 元信息文本行（生态/来源/开发模式/内置降为纯文本，
 * 仅市场已移除/已停用保留徽标跟名）；描述 clamp 三行，页脚放构成徽标与动作：
 * 搜索 + 视图切换 + 批量条（两态等高 h-9，切换不抖动），
 * 双视图（卡片一行多个 / 单行列表）；点卡片主体切换选中（内部按钮/开关不
 * 触发），点图标/名称/「详情」弹预览弹窗（页脚带启停/检查更新/卸载）；
 * 选中即常驻 hover 同款 bg-muted/50，无 checkbox/角标；首次加载用
 * 同构骨架屏；选中驱动批量条：批量启用 / 停用 / 卸载（卸载走确认弹窗，
 * 逐个走既有协议消息，N 次四链热重载——插件量小，正确性优先）。
 */
import { useMemo, useState, type FC, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import {
  DownloadIcon,
  InfoIcon,
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
import { ClampedText } from "@/components/ui/clamped-text";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import {
  installPlugin,
  isPluginOpPending,
  setPluginsEnabledBatch,
  uninstallPluginsBatch,
  usePendingOps,
  usePlugins,
  type PluginEntry,
} from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { PluginPreviewDialog } from "@/components/marketplace/plugin-preview-dialog";

/** 骨架卡片：与真实卡片同构（自然高 + 头部图标/名称行 + 三行描述区 + 页脚） */
const PluginCardSkeleton = () => (
  <div className="flex flex-col rounded-2xl border bg-white p-4 dark:bg-background">
    <div className="flex shrink-0 items-start gap-3">
      <Skeleton className="size-9 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
    </div>
    <div className="mt-2 flex-1 space-y-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/5" />
    </div>
    <div className="mt-3 flex shrink-0 items-center justify-between">
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-11 rounded-full" />
        <Skeleton className="h-5 w-11 rounded-full" />
      </div>
      {/* 与真实页脚同宽：「详情」文字按钮 + 两个图标按钮 */}
      <div className="flex items-center gap-1">
        <Skeleton className="h-7 w-14 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
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
  kova: "kova",
  claude: "Claude 生态",
  codex: "Codex 生态",
};

/**
 * 「内置插件」（marketplaceId "builtin"）：随 app 分发与更新——不可卸载、
 * 无"检查更新"概念（换安装包即升级），可禁用；批量卸载按此过滤（后端会拒绝，
 * 前端先不给入口）。
 */
const isBuiltinPlugin = (p: { marketplaceId: string }) => p.marketplaceId === "builtin";

export const InstalledPlugins: FC = () => {
  const workspace = useWorkspace();
  const snap = usePlugins(workspace);
  const pending = usePendingOps();
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "rows">("cards");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<PluginEntry[] | null>(null);
  /** 预览弹窗：存 pluginId，渲染期从最新快照推导（启停/更新后弹窗内容自动跟随） */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = previewId
    ? (snap.plugins.find((p) => p.pluginId === previewId) ?? null)
    : null;

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
  const selectAllFiltered = () =>
    setSelected(new Set(plugins.filter((p) => !isBuiltinPlugin(p)).map((p) => p.pluginId)));

  const busy = pending.length > 0;

  const runBatchEnable = () => {
    const ids = targets.map((p) => p.pluginId);
    void setPluginsEnabledBatch(ids, batchEnable, workspace).then(clearSelection);
  };
  // 内置插件不进卸载确认（可禁不可卸）；选中项全是内置时不开空弹窗
  const runBatchUninstall = () => {
    const uninstallable = targets.filter((p) => !isBuiltinPlugin(p));
    if (uninstallable.length > 0) setConfirmUninstall(uninstallable);
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
        <div className="flex h-9 items-center gap-2">
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
        <div className="flex h-9 items-center gap-2">
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
          const builtin = isBuiltinPlugin(p);
          const componentBadges = [
            p.components.skills.length > 0 ? `技能${p.components.skills.length}` : null,
            p.components.mcpServers.length > 0 ? `MCP${p.components.mcpServers.length}` : null,
            p.components.subagents.length > 0 ? `子智能体${p.components.subagents.length}` : null,
          ].filter(Boolean);

          // 版本徽标跟在名称后（同市场目录卡的 v 徽标）
          const versionBadge = (
            <Badge variant="outline" className="shrink-0 px-1.5 font-mono text-[11px] font-normal">
              v{p.version}
            </Badge>
          );
          // 异常态徽标跟在版本后：市场已移除（危险）、已停用（中性）——只有
          // 这两个需要不 hover 就能扫到。其余元信息降为纯文本：旧版六种徽标
          // 混排在名称后能折到三四行，被 max-h 拦腰裁切，是卡片最破相的地方。
          const statusBadges = (
            <span className="flex shrink-0 items-center gap-1.5">
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
            </span>
          );
          // 生态/来源/开发模式/内置是查阅型信息，降为名称行下方的单行 muted
          // 文本（对应市场卡的品类行）；title 兜底截断后的完整内容
          // （开发模式自带更细的悬浮说明）
          const metaTitle = [
            ...(p.manifestKind !== "kova" ? [MANIFEST_KIND_LABEL[p.manifestKind]] : []),
            `来自 ${p.marketplaceName}`,
            ...(p.linked ? ["开发模式"] : []),
            ...(builtin ? ["内置"] : []),
          ].join(" · ");
          const metaText = (
            <p className="text-muted-foreground mt-0.5 truncate text-xs" title={metaTitle}>
              {p.manifestKind !== "kova" && <>{MANIFEST_KIND_LABEL[p.manifestKind]}{" · "}</>}
              {`来自 ${p.marketplaceName}`}
              {p.linked && (
                <span
                  title={
                    p.sourcePath
                      ? `链接到源目录：${p.sourcePath}（改源码重建即生效）`
                      : "链接到源目录（开发模式）"
                  }
                >
                  {" · "}开发模式
                </span>
              )}
              {builtin && <>{" · "}内置</>}
            </p>
          );
          // 描述 clamp 三行（同市场目录卡片）：flex-1 吸收同行卡片的高低差，
          // 全文经「详情」弹窗查看；text-xs 与市场卡同步收紧
          const desc = p.description ? (
            <p className="text-muted-foreground mt-2 line-clamp-2 flex-1 text-xs">
              {p.description}
            </p>
          ) : null;
          // 徽标行不许换行：卡片三列网格下可用宽约 300px，一旦折行，页脚的
          // items-center 会把动作按钮垂到两行徽标的中间，整行看着就是散的
          const badges = componentBadges.length > 0 && (
            <BadgeOverflow items={componentBadges} className="flex-nowrap" />
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
          const openPreview = (e: MouseEvent) => {
            e.stopPropagation();
            setPreviewId(p.pluginId);
          };
          const iconBox = (
            <div
              onClick={openPreview}
              title="点击查看插件详情"
              className="bg-background grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl"
            >
              <PluginIcon src={p.icon} name={p.name} />
            </div>
          );
          const detailBtn = (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 text-xs"
              onClick={openPreview}
            >
              <InfoIcon className="size-3.5" />
              详情
            </Button>
          );
          // 卡片视图的紧凑动作：三个文字按钮（详情/检查更新/卸载）合计约 225px，
          // 三列网格下只剩约 80px 给徽标行，必然折行。次级动作收成图标按钮
          // （title + sr-only 兜底语义），腾出宽度让徽标与动作同处一行中线。
          const updateBtnIcon = builtin ? null : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => void installPlugin(p.marketplaceId, p.name)}
              title={installBusy ? "更新中…" : "检查更新"}
            >
              <DownloadIcon className={cn("size-3.5", installBusy && "animate-pulse")} />
              <span className="sr-only">检查更新</span>
            </Button>
          );
          const uninstallBtnIcon = builtin ? null : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => setConfirmUninstall([p])}
              title="卸载"
            >
              <Trash2Icon className="size-3.5" />
              <span className="sr-only">卸载</span>
            </Button>
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
                {/* 两行式：旧版把名称/版本/徽标/描述/构成/来源/动作全塞进一条
                    flex 行互抢宽度，名称最先被压成「ca…」「o…」。现在名称 +
                    异常态徽标 + 元信息文本独占首行（元信息降为文本后不再折行），
                    描述与构成独占次行，各有各的弹性。 */}
                <div className="min-w-0 flex-1">
                  {/* overflow-hidden 兜底：这一行不换行，压缩优先级 名称 >
                      异常徽标（shrink-0）> 元信息（flex-1 先让位），
                      万一内容多到本身就超行宽，裁掉而不是溢出到动作区上 */}
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                    <span className="cursor-pointer truncate text-sm font-medium" onClick={openPreview} title="点击查看插件详情">{p.name}</span>
                    {versionBadge}
                    {statusBadges}
                    <div className="min-w-0 flex-1">{metaText}</div>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <ClampedText
                      text={p.description ?? ""}
                      lines={1}
                      className="text-muted-foreground min-w-0 flex-1 text-xs"
                    />
                    {/* 窄窗口下让位的是构成徽标，描述区保留；来源已在首行元信息里 */}
                    {badges && <span className="hidden shrink-0 md:block">{badges}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* 定宽右对齐：内置项没有更新/卸载，动作区不封顶的话每行的开关
                      会横向错位，整列看着像没对齐 */}
                  <div className="flex min-w-32 items-center justify-end gap-1">
                    {detailBtn}
                    {updateBtnIcon}
                    {uninstallBtnIcon}
                  </div>
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
                // 自然高（对齐市场目录卡片）：同行网格内等高，长短差异由
                // 描述区 flex-1 吸收，页脚贴底
                "flex cursor-pointer flex-col rounded-2xl border bg-white p-4 transition-colors dark:bg-background",
                checked && "bg-muted/50",
                !checked && "hover:bg-muted/50",
              )}
            >
              <div className="flex shrink-0 items-start gap-3">
                {iconBox}
                <div className="min-w-0 flex-1">
                  {/* 名称 + 版本徽标（同市场目录），异常态徽标 shrink-0 跟在
                      后面（已停用/市场已移除需要扫视可见，极端窄时宁可裁名
                      不裁状态）；其余元信息降为下方纯文本行——旧版六种徽标
                      混排在名称后能折到三四行且被拦腰裁切 */}
                  <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <span className="cursor-pointer truncate text-sm font-medium" onClick={openPreview} title="点击查看插件详情">{p.name}</span>
                    {versionBadge}
                    {statusBadges}
                  </div>
                  {metaText}
                </div>
                <div className="shrink-0">{enableSwitch}</div>
              </div>
              {/* 无描述时用等价的空占位撑住剩余空间，页脚照样贴底 */}
              {desc ?? <div className="flex-1" />}
              <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
                {badges ? <div className="min-w-0">{badges}</div> : <span />}
                <div className="flex shrink-0 items-center gap-1">
                  {detailBtn}
                  {updateBtnIcon}
                  {uninstallBtnIcon}
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

      {/* 预览弹窗：内容随快照刷新（启停/更新即变）；卸载走既有确认弹窗，先关本弹窗 */}
      <PluginPreviewDialog
        preview={
          preview
            ? {
                name: preview.name,
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
        footer={
          preview ? (
            <div className="flex w-full items-center gap-2">
              <span className="text-sm">
                {preview.enabled ? "已启用" : "已停用"}
              </span>
              <Switch
                checked={preview.enabled}
                onCheckedChange={(v) =>
                  void setPluginsEnabledBatch([preview.pluginId], v, workspace)
                }
                aria-label={`启用插件 ${preview.name}`}
              />
              <div className="flex-1" />
              {!isBuiltinPlugin(preview) && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void installPlugin(preview.marketplaceId, preview.name)
                    }
                  >
                    <DownloadIcon
                      className={cn(
                        "size-3.5",
                        isPluginOpPending(
                          "install_plugin",
                          `${preview.marketplaceId}:${preview.name}`,
                        ) && "animate-pulse",
                      )}
                    />
                    检查更新
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmUninstall([preview]);
                      setPreviewId(null);
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                    卸载
                  </Button>
                </>
              )}
              {isBuiltinPlugin(preview) && (
                <span className="text-muted-foreground text-xs" title="随 app 分发的首方插件：不可卸载、随应用版本更新，可禁用">
                  内置 · 随应用更新
                </span>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
};
