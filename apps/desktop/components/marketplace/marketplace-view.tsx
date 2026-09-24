"use client";

/**
 * 插件市场（侧边栏「插件市场」主区视图）。
 *
 * 主区页签：市场目录 / 已装插件 平级切换（管理页不再收已装插件，也不下钻
 * 组件——技能与 MCP 的常规管理留在「管理」原位置）。
 * - 市场目录：市场选择器（登记的市场间切换 + 刷新）+ 插件卡片（安装/已装/
 *   有更新），右上角「＋ 添加市场」（本地目录 / Git 仓库）；
 * - 已装插件：独立视图（卡片/单行 + 批量启停/卸载），见 installed-plugins.tsx；
 * - 管理：MCP 管理、技能管理（完整能力，原位置），应用授权暂为空态。
 *
 * 事实源在 sidecar plugins.ts；耗时操作（添加/刷新/安装）受理即返回，
 * 完成经 plugin_op_result 帧回流（lib/plugins.ts 整包并入镜像）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Link2Icon,
  Loader2Icon,
  PackageOpenIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useSkills } from "@/lib/skills/skills";
import { useMcpServers } from "@/lib/mcp/mcp";
import {
  installPlugin,
  isPluginOpPending,
  refreshMarketplace,
  setPluginOpHandler,
  useMarketplaces,
  usePendingOps,
  usePlugins,
  type MarketplaceEntry,
} from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";

function ViewSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
    </div>
  );
}

// 重依赖随 chunk 按需拉取
const McpSettings = dynamic(
  () =>
    import("@/components/settings/components/mcp-settings").then((m) => ({
      default: m.McpSettings,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);
const SkillsSettings = dynamic(
  () =>
    import("@/components/settings/components/skills-settings").then((m) => ({
      default: m.SkillsSettings,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);
const InstalledPlugins = dynamic(
  () =>
    import("@/components/marketplace/installed-plugins").then((m) => ({
      default: m.InstalledPlugins,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);
const AddMarketplaceDialog = dynamic(
  () =>
    import("@/components/marketplace/add-marketplace-dialog").then((m) => ({
      default: m.AddMarketplaceDialog,
    })),
  { ssr: false },
);
const InstallLocalDialog = dynamic(
  () =>
    import("@/components/marketplace/install-local-dialog").then((m) => ({
      default: m.InstallLocalDialog,
    })),
  { ssr: false },
);

/** 管理页分段器选项（已装插件已上提为主区页签，这里保持技能/MCP 原位置） */
type ManageTab = "plugins" | "skills" | "apps";

/** 市场类型图标 */
function MarketplaceIcon({ market }: { market: MarketplaceEntry }) {
  return market.type === "git" ? (
    <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
  ) : (
    <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
  );
}

export const MarketplaceView: FC = () => {
  const workspace = useWorkspace();
  // 管理页分段器的计数；清单数据由迁移进来的管理组件自取
  const skillsSnap = useSkills(workspace);
  const mcpSnap = useMcpServers(workspace);
  const pluginsSnap = usePlugins(workspace);
  const marketplacesSnap = useMarketplaces();
  const pending = usePendingOps();

  // 主区页签：市场目录 / 已装插件 平级；「管理」仍为下钻页（技能/MCP 原位置）
  const [view, setView] = useState<"market" | "installed">("market");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<ManageTab>("plugins");
  const [addOpen, setAddOpen] = useState(false);
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [activeMktId, setActiveMktId] = useState<string | null>(null);

  const marketplaces = marketplacesSnap.marketplaces;
  const activeMarket = useMemo(
    () => marketplaces.find((m) => m.id === activeMktId) ?? marketplaces[0],
    [marketplaces, activeMktId],
  );

  // 首个市场就绪后选中它
  useEffect(() => {
    if (!activeMktId && marketplaces.length > 0) setActiveMktId(marketplaces[0]!.id);
  }, [activeMktId, marketplaces]);

  // 耗时操作出错时 toast 提示（成功路径由帧数据整包并入，无需处理）。
  // 本地安装除外：其错误/成功由安装对话框内联呈现，避免重复。
  useEffect(() => {
    setPluginOpHandler((frame) => {
      if (!frame.ok && frame.op !== "install_plugin_local") {
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.error({ title: `插件操作失败（${frame.op}）`, description: frame.errorText });
        });
      }
    });
    return () => setPluginOpHandler(null);
  }, []);

  /** 当前市场目录中，该插件是否已安装（版本不同 = 有更新；链接装常驻源目录，无更新概念） */
  const installStateOf = (mkt: MarketplaceEntry, pluginName: string) => {
    const installed = pluginsSnap.plugins.find(
      (p) => p.name === pluginName && p.marketplaceId === mkt.id,
    );
    if (!installed)
      return { installed: false, linked: false, sourcePath: undefined, update: false, busy: false } as const;
    const catalogEntry = mkt.plugins.find((e) => e.name === pluginName);
    const linked = installed.linked === true;
    const update = !linked && Boolean(catalogEntry?.version && catalogEntry.version !== installed.version);
    const busy = isPluginOpPending("install_plugin", `${mkt.id}:${pluginName}`);
    return { installed: true, linked, sourcePath: installed.sourcePath, update, busy } as const;
  };

  if (manageOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* 顶部条：与下方设置内容同宽同轴，返回 + 分段器（带计数） */}
        <div className="mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between px-8 pt-6">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2 gap-1"
            onClick={() => setManageOpen(false)}
          >
            <ChevronLeftIcon className="size-4" />
            返回
          </Button>
          <Segmented
            value={manageTab}
            onChange={setManageTab}
            options={[
              { value: "plugins", label: `插件 ${mcpSnap.servers.length}` },
              { value: "skills", label: `技能 ${skillsSnap.skills.length}` },
              { value: "apps", label: "应用授权 0" },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1">
          <div className="mx-auto h-full max-w-6xl px-8">
            {manageTab === "plugins" && <McpSettings />}
            {manageTab === "skills" && <SkillsSettings />}
            {manageTab === "apps" && (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                暂无应用授权
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const refreshBusy = activeMarket
    ? isPluginOpPending("refresh_marketplace", activeMarket.id)
    : false;

  return (
    <div className="h-full">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-8 py-8 lg:px-12">
        {/* 页头：标题 + 管理；主区页签在标题下 */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">插件市场</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              发现并安装插件、技能等扩展，拓展 Agent 的能力。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setManageOpen(true)}
          >
            <SlidersHorizontalIcon className="size-3.5" />
            管理
          </Button>
        </div>

        {/* 主区页签：市场目录 / 已装插件 */}
        <div className="mt-5 flex items-center justify-between">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "market", label: "市场目录" },
              { value: "installed", label: `已装插件 ${pluginsSnap.plugins.length}` },
            ]}
          />
          {view === "market" && (
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                title="直接选择一个本地插件目录安装（不经市场）"
                onClick={() => setLocalInstallOpen(true)}
              >
                本地安装
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setAddOpen(true)}
              >
                + 添加市场
              </Button>
            </div>
          )}
        </div>

        {view === "installed" ? (
          <div className="mt-2 min-h-0 flex-1">
            <InstalledPlugins />
          </div>
        ) : marketplaces.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-16">
            <div className="bg-muted/50 text-muted-foreground grid size-12 place-items-center rounded-2xl border">
              <PackageOpenIcon className="size-6" />
            </div>
            <p className="text-sm font-medium">还没有添加插件市场</p>
            <p className="text-muted-foreground text-sm">
              点右上角「添加市场」，选择本地目录或 Git 仓库；
              或点「本地安装」直接装一个下载好的插件目录。
            </p>
          </div>
        ) : (
          <>
            {/* 市场选择器 */}
            <div className="mt-4 flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className="hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm"
                    >
                      <MarketplaceIcon market={activeMarket!} />
                      <span className="max-w-64 truncate">{activeMarket?.name}</span>
                      <ChevronDownIcon className="text-muted-foreground size-3.5" />
                    </button>
                  }
                />
                <DropdownMenuContent align="start" className="w-80">
                  {marketplaces.map((m) => (
                    <DropdownMenuItem
                      key={m.id}
                      onClick={() => setActiveMktId(m.id)}
                      className="gap-2"
                    >
                      <MarketplaceIcon market={m} />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      {m.id === activeMarket?.id && <CheckIcon className="size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setAddOpen(true)}>+ 添加市场…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 「本地安装」伪市场目录随装随生成，无刷新概念 */}
              {activeMarket && activeMarket.id !== "local" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1 text-xs"
                  disabled={refreshBusy}
                  onClick={() => void refreshMarketplace(activeMarket.id)}
                >
                  <RefreshCwIcon className={refreshBusy ? "size-3.5 animate-spin" : "size-3.5"} />
                  刷新
                </Button>
              )}
            </div>

            {/* 插件卡片网格 */}
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-8">
              {activeMarket!.needsRefresh ? (
                <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                  <PackageOpenIcon className="size-8" />
                  市场目录尚未加载，点「刷新」获取。
                </div>
              ) : activeMarket!.plugins.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                  <PackageOpenIcon className="size-8" />
                  该市场暂无插件。
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {activeMarket!.plugins.map((entry) => {
                    const state = installStateOf(activeMarket!, entry.name);
                    return (
                      <div
                        key={entry.name}
                        className="bg-white dark:bg-background hover:bg-muted/50 flex flex-col rounded-2xl border p-4"
                      >
                        <div className="flex items-start gap-3">
                          <div className="bg-background grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl border">
                            <PluginIcon src={entry.icon} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{entry.name}</span>
                              {entry.version && (
                                <Badge
                                  variant="outline"
                                  className="px-1.5 font-mono text-[11px] font-normal"
                                >
                                  v{entry.version}
                                </Badge>
                              )}
                            </div>
                            {entry.category && (
                              <p className="text-muted-foreground mt-0.5 text-xs">{entry.category}</p>
                            )}
                          </div>
                        </div>
                        {entry.description && (
                          <p className="text-muted-foreground mt-2 line-clamp-3 flex-1 text-sm">
                            {entry.description}
                          </p>
                        )}
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex gap-1">
                            {entry.keywords?.slice(0, 2).map((k) => (
                              <Badge key={k} variant="secondary" className="font-normal">
                                {k}
                              </Badge>
                            ))}
                          </div>
                          {state.installed && state.linked ? (
                            <Badge
                              variant="outline"
                              className="gap-1 font-normal"
                              title={state.sourcePath ? `源目录：${state.sourcePath}` : undefined}
                            >
                              <Link2Icon className="size-3" />
                              链接安装 · 开发
                            </Badge>
                          ) : (
                            <div className="flex items-center gap-1">
                              {state.installed ? (
                                state.update ? (
                                  <Button
                                    size="sm"
                                    className="h-7 gap-1 text-xs"
                                    disabled={state.busy}
                                    onClick={() => void installPlugin(activeMarket!.id, entry.name)}
                                  >
                                    {state.busy ? (
                                      <Loader2Icon className="size-3 animate-spin" />
                                    ) : null}
                                    更新
                                  </Button>
                                ) : (
                                  <Badge variant="outline" className="gap-1 font-normal">
                                    <CheckIcon className="size-3" />
                                    已安装
                                  </Badge>
                                )
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1 text-xs"
                                  disabled={state.busy || pending.length > 0}
                                  onClick={() => void installPlugin(activeMarket!.id, entry.name)}
                                >
                                  {state.busy ? (
                                    <Loader2Icon className="size-3 animate-spin" />
                                  ) : null}
                                  安装
                                </Button>
                              )}
                              {activeMarket!.type === "directory" &&
                                activeMarket!.id !== "local" &&
                                !state.update && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-muted-foreground h-7 gap-1 px-2 text-xs"
                                  disabled={state.busy || pending.length > 0}
                                  title="cache 条目链接到源目录：改插件源码后重建即生效，无需重复安装，面板自动重载（仅开发用）"
                                  onClick={() =>
                                    void installPlugin(activeMarket!.id, entry.name, { link: true })
                                  }
                                >
                                  {state.busy ? (
                                    <Loader2Icon className="size-3 animate-spin" />
                                  ) : (
                                    <Link2Icon className="size-3" />
                                  )}
                                  {state.installed ? "转链接装" : "链接装"}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
      <InstallLocalDialog open={localInstallOpen} onOpenChange={setLocalInstallOpen} />
    </div>
  );
};
