"use client";

/**
 * 插件/专家/技能（侧边栏「插件/专家/技能」主区视图；原名「插件市场」）。
 *
 * 标题「插件 / 专家 / 技能」本身即主区页签，三段各自记住自己的视图位置：
 * 市场目录 / 已装插件（仅插件段）/ 管理。三段目前共用同一份插件目录清单，
 * 专家市场与技能市场按组件分流是下一步。
 * - 市场目录：市场选择器（登记的市场间切换 + 刷新 + 行内移除）+ 插件卡片
 *   （安装/已装/有更新/卸载），右上角「本地安装」「＋ 添加市场」
 *   （本地目录 / Git 仓库）；
 * - 已装插件：独立视图（卡片/单行 + 批量启停/卸载），见 installed-plugins.tsx；
 * - 管理：进页时落到本段默认分段（专家→子智能体，技能→技能，插件→MCP），
 *   段内分段器可跨组件切换，应用授权暂为空态。
 *
 * 事实源在 sidecar plugins.ts；耗时操作（添加/刷新/安装）受理即返回，
 * 完成经 plugin_op_result 帧回流（lib/plugins.ts 整包并入镜像）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  BotIcon,
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
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useSubagents } from "@/lib/subagent/subagents";
import { useMcpServers } from "@/lib/mcp/mcp";
import {
  installPlugin,
  isPluginOpPending,
  refreshMarketplace,
  removeMarketplace,
  setPluginOpHandler,
  uninstallPluginsBatch,
  useMarketplaces,
  usePendingOps,
  usePlugins,
  type MarketplaceEntry,
  type PluginEntry,
} from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import {
  PluginPreviewDialog,
  type PluginPreviewData,
} from "@/components/marketplace/plugin-preview-dialog";

/**
 * 伪市场（「本地安装」「内置插件」）：不在登记表、随装随生成/随 app 分发——
 * 无移除/刷新/链接装；「内置插件」还不可安装与卸载（条目即已装项，
 * 启停在「已装插件」页做）。
 */
const isPseudoMarket = (id: string) => id === "local" || id === "builtin";

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
const SubagentsSettings = dynamic(
  () =>
    import("@/components/settings/components/subagents-settings").then((m) => ({
      default: m.SubagentsSettings,
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
const UninstallDialog = dynamic(
  () =>
    import("@/components/marketplace/uninstall-dialog").then((m) => ({
      default: m.UninstallDialog,
    })),
  { ssr: false },
);

/** 管理页分段器选项（已装插件已上提为主区页签；子智能体排最前，插件/技能
 *  保持原位置） */
type ManageTab = "subagents" | "plugins" | "skills" | "apps";

/**
 * 三个主区：标题上的「插件 / 专家 / 技能」即页签。
 * 插件段 = 插件市场（市场目录 / 已装插件 + 市场来源动作）；专家段与技能段直接
 * 就是子智能体页与技能页，不套市场的分段器——市场/已装是插件独有的概念。
 */
type Section = "plugins" | "experts" | "skills";

/** 插件段内的两个列表视图 */
type SectionView = "market" | "installed";

/** 「管理」进管理页时落的分段：专家 → 子智能体，技能 → 技能，插件 → MCP */
const SECTION_MANAGE_TAB: Record<Section, ManageTab> = {
  plugins: "plugins",
  experts: "subagents",
  skills: "skills",
};

/** 标题页签与其副标题（副标题只说该段真有的能力，不预告未做的分流） */
const SECTION_META: { value: Section; label: string; desc: string }[] = [
  {
    value: "plugins",
    label: "插件",
    desc: "发现并安装插件、子智能体、技能等扩展，拓展 Agent 的能力。",
  },
  {
    value: "experts",
    label: "专家",
    desc: "子智能体：新建、编辑、启停专家，也可以从插件市场安装带专家的扩展。",
  },
  {
    value: "skills",
    label: "技能",
    desc: "技能：新建、编辑、启停技能，也可以从插件市场安装带技能的扩展。",
  },
];

/** 市场类型图标 */
function MarketplaceIcon({ market }: { market: MarketplaceEntry }) {
  return market.type === "git" ? (
    <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
  ) : (
    <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
  );
}

export const MarketplaceView: FC<{
  /** composer「+」菜单请求直落的分段；非空即打开管理页并落到该分段 */
  manageTab?: ManageTab | null;
}> = ({ manageTab: requestedTab }) => {
  const workspace = useWorkspace();
  // 管理页分段器的计数；清单数据由迁移进来的管理组件自取
  const skillsSnap = useSkills(workspace);
  const subagentsSnap = useSubagents(workspace);
  const mcpSnap = useMcpServers(workspace);
  const pluginsSnap = usePlugins(workspace);
  const marketplacesSnap = useMarketplaces();
  const pending = usePendingOps();

  // 主区页签：标题上的「插件 / 专家 / 技能」；插件段内再切市场目录 / 已装插件
  const [section, setSection] = useState<Section>("plugins");
  const [view, setView] = useState<SectionView>("market");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<ManageTab>("subagents");
  const [addOpen, setAddOpen] = useState(false);
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [activeMktId, setActiveMktId] = useState<string | null>(null);
  /** 预览弹窗目标：按 (市场 id, 插件名) 存，渲染期从最新快照推导（刷新/卸载自动跟随） */
  const [previewSel, setPreviewSel] = useState<{
    marketId: string;
    name: string;
  } | null>(null);
  /** 卸载确认（与已装页共用 UninstallDialog；卡片图标钮与预览弹窗页脚都进这里） */
  const [confirmUninstall, setConfirmUninstall] = useState<
    PluginEntry[] | null
  >(null);
  /** 市场下拉受控（行内移除钮点击后需手动收起菜单）+ 移除市场确认目标 */
  const [mktMenuOpen, setMktMenuOpen] = useState(false);
  const [confirmRemoveMkt, setConfirmRemoveMkt] =
    useState<MarketplaceEntry | null>(null);

  const marketplaces = marketplacesSnap.marketplaces;
  const activeMarket = useMemo(
    () => marketplaces.find((m) => m.id === activeMktId) ?? marketplaces[0],
    [marketplaces, activeMktId],
  );

  // 首个市场就绪后选中它
  useEffect(() => {
    if (!activeMktId && marketplaces.length > 0)
      setActiveMktId(marketplaces[0]!.id);
  }, [activeMktId, marketplaces]);

  // composer「+」菜单的「管理技能 / 管理连接器 / 管理子智能体」直落：切到
  // 对应主区（子智能体 → 专家段，技能 → 技能段，MCP → 插件段）并打开管理页
  useEffect(() => {
    if (!requestedTab) return;
    const target: Section =
      requestedTab === "subagents"
        ? "experts"
        : requestedTab === "skills"
          ? "skills"
          : "plugins";
    setSection(target);
    setManageOpen(true);
    setManageTab(requestedTab);
  }, [requestedTab]);

  // 耗时操作出错时 toast 提示（成功路径由帧数据整包并入，无需处理）。
  // 本地安装除外：其错误/成功由安装对话框内联呈现，避免重复。
  useEffect(() => {
    setPluginOpHandler((frame) => {
      if (!frame.ok && frame.op !== "install_plugin_local") {
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.error({
            title: `插件操作失败（${frame.op}）`,
            description: frame.errorText,
          });
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
      return {
        installed: false,
        linked: false,
        sourcePath: undefined,
        plugin: null,
        update: false,
        busy: false,
      } as const;
    const catalogEntry = mkt.plugins.find((e) => e.name === pluginName);
    const linked = installed.linked === true;
    const update =
      !linked &&
      Boolean(
        catalogEntry?.version && catalogEntry.version !== installed.version,
      );
    const busy = isPluginOpPending("install_plugin", `${mkt.id}:${pluginName}`);
    return {
      installed: true,
      linked,
      sourcePath: installed.sourcePath,
      plugin: installed,
      update,
      busy,
    } as const;
  };

  // 预览弹窗数据：渲染期从最新快照推导（市场被移除/目录刷新即自然收敛）
  const previewMarket = previewSel
    ? marketplaces.find((m) => m.id === previewSel.marketId)
    : undefined;
  const previewEntry = previewMarket?.plugins.find(
    (e) => e.name === previewSel?.name,
  );
  const previewInstalled =
    previewMarket && previewSel
      ? (pluginsSnap.plugins.find(
          (p) =>
            p.name === previewSel.name && p.marketplaceId === previewMarket.id,
        ) ?? null)
      : null;
  const previewData: PluginPreviewData | null =
    previewMarket && previewEntry
      ? {
          name: previewEntry.name,
          version: previewEntry.version,
          description: previewEntry.description,
          icon: previewEntry.icon,
          category: previewEntry.category,
          keywords: previewEntry.keywords,
          marketplaceName: previewMarket.name,
          installed: previewInstalled,
        }
      : null;
  const previewState =
    previewMarket && previewSel
      ? installStateOf(previewMarket, previewSel.name)
      : null;
  /** 预览弹窗条目（未装为 null）；弹窗页脚卸载按钮用 */
  const previewInstalledEntry = previewState?.installed
    ? previewState.plugin
    : null;
  // 内置插件不可卸载（可禁用）：预览弹窗页脚不给卸载按钮
  const dialogUninstallBtn =
    previewInstalledEntry &&
    previewInstalledEntry.marketplaceId !== "builtin" ? (
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive gap-1"
        disabled={pending.length > 0}
        onClick={() => setConfirmUninstall([previewInstalledEntry])}
      >
        <Trash2Icon className="size-3.5" />
        卸载
      </Button>
    ) : null;

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
              {
                value: "subagents",
                label: `子智能体 ${subagentsSnap.agents.length + subagentsSnap.pluginAgents.length}`,
              },
              { value: "plugins", label: `MCP ${mcpSnap.servers.length}` },
              { value: "skills", label: `技能 ${skillsSnap.skills.length}` },
              { value: "apps", label: "应用授权 0" },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1">
          <div className="mx-auto h-full max-w-6xl px-8">
            {manageTab === "subagents" && <SubagentsSettings />}
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

  // 三段共用同一份市场目录清单（专家/技能市场的按组件分流待做）
  const marketEntries = activeMarket?.plugins ?? [];

  return (
    <div className="h-full">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-8 py-8 lg:px-12">
        {/* 页头：标题即页签（插件 / 专家 / 技能），右上角「管理」进本段管理页 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
              {SECTION_META.map((s, i) => (
                <span key={s.value} className="flex items-baseline gap-2">
                  {i > 0 && (
                    <span className="text-muted-foreground/40 font-normal">
                      /
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSection(s.value)}
                    aria-current={section === s.value}
                    className={
                      section === s.value
                        ? "transition-colors"
                        : "text-muted-foreground/60 hover:text-foreground transition-colors"
                    }
                  >
                    {s.label}
                  </button>
                </span>
              ))}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {SECTION_META.find((s) => s.value === section)!.desc}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            title={`管理${SECTION_META.find((s) => s.value === section)!.label}`}
            onClick={() => {
              setManageTab(SECTION_MANAGE_TAB[section]);
              setManageOpen(true);
            }}
          >
            <SlidersHorizontalIcon className="size-3.5" />
            管理
          </Button>
        </div>

        {section !== "plugins" ? (
          /* 专家段 / 技能段：市场与已装是插件独有的概念，先占位；真正的
             子智能体 / 技能管理在页头右上角「管理」里 */
          <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-16">
            <div className="bg-muted/50 text-muted-foreground grid size-12 place-items-center rounded-2xl border">
              {section === "experts" ? (
                <BotIcon className="size-6" />
              ) : (
                <SparklesIcon className="size-6" />
              )}
            </div>
            <p className="text-sm font-medium">
              {section === "experts" ? "专家市场即将上线" : "技能市场即将上线"}
            </p>
            <p className="text-muted-foreground text-sm">
              先点右上角「管理」新建或调整；带这类能力的扩展，在插件段的市场目录里安装。
            </p>
          </div>
        ) : (
          <>
            {/* 插件段：市场目录 / 已装插件 —— 市场/已装是插件独有的概念 */}
            <div className="mt-5 flex items-center justify-between">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  {
                    value: "market",
                    label: `市场目录 ${marketEntries.length}`,
                  },
                  {
                    value: "installed",
                    label: `已装插件 ${pluginsSnap.plugins.length}`,
                  },
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
                  <DropdownMenu
                    open={mktMenuOpen}
                    onOpenChange={setMktMenuOpen}
                  >
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          className="hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm"
                        >
                          <MarketplaceIcon market={activeMarket!} />
                          <span className="max-w-64 truncate">
                            {activeMarket?.name}
                          </span>
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
                          <span className="min-w-0 flex-1 truncate">
                            {m.name}
                          </span>
                          {m.id === activeMarket?.id && (
                            <CheckIcon className="size-3.5" />
                          )}
                          {/* 移除入口（伪市场「本地安装」「内置插件」不可移除）。
                          用 span 而非 button：菜单项本身是 button，不允许嵌套 */}
                          {!isPseudoMarket(m.id) && (
                            <span
                              role="button"
                              aria-label={`移除市场 ${m.name}`}
                              title="移除该市场（不影响已安装插件）"
                              className="text-muted-foreground hover:text-destructive -my-0.5 -mr-1.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-destructive/10"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setMktMenuOpen(false);
                                setConfirmRemoveMkt(m);
                              }}
                            >
                              <Trash2Icon className="size-3.5" />
                            </span>
                          )}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setAddOpen(true)}>
                        + 添加市场…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* 伪市场无刷新概念（本地安装随装随生成；内置插件随应用更新） */}
                  {activeMarket && !isPseudoMarket(activeMarket.id) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-8 gap-1 text-xs"
                      disabled={refreshBusy}
                      onClick={() => void refreshMarketplace(activeMarket.id)}
                    >
                      <RefreshCwIcon
                        className={
                          refreshBusy ? "size-3.5 animate-spin" : "size-3.5"
                        }
                      />
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
                  ) : marketEntries.length === 0 ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                      <PackageOpenIcon className="size-8" />
                      该市场暂无插件。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {marketEntries.map((entry) => {
                        const state = installStateOf(activeMarket!, entry.name);
                        // 已装插件在市场页即可卸载：图标钮保持卡片版式不挤，确认弹窗与已装页共用；
                        // 内置插件不可卸载（随应用更新，启停在已装页）
                        const uninstallBtn =
                          state.installed &&
                          state.plugin &&
                          activeMarket!.id !== "builtin" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive h-7 w-7 shrink-0 p-0"
                              title="卸载该插件（保留市场条目，可随时重新安装）"
                              disabled={pending.length > 0}
                              onClick={() =>
                                setConfirmUninstall([state.plugin!])
                              }
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          ) : null;
                        return (
                          <div
                            key={entry.name}
                            title="点击查看插件详情"
                            onClick={(e) => {
                              // 卡内按钮（安装/更新/链接装）不触发预览
                              if (
                                (e.target as HTMLElement).closest("button, a")
                              )
                                return;
                              setPreviewSel({
                                marketId: activeMarket!.id,
                                name: entry.name,
                              });
                            }}
                            className="bg-white dark:bg-background hover:bg-muted/50 flex cursor-pointer flex-col rounded-2xl border p-4"
                          >
                            <div className="flex items-start gap-3">
                              <div className="bg-background grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl border">
                                <PluginIcon src={entry.icon} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-sm font-medium">
                                    {entry.name}
                                  </span>
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
                                  <p className="text-muted-foreground mt-0.5 text-xs">
                                    {entry.category}
                                  </p>
                                )}
                              </div>
                            </div>
                            {entry.description && (
                              <p className="text-muted-foreground mt-2 line-clamp-3 flex-1 text-sm">
                                {entry.description}
                              </p>
                            )}
                            <div className="mt-3 flex items-center justify-between">
                              <div className="flex min-w-0 flex-wrap gap-1">
                                {entry.keywords?.slice(0, 2).map((k) => (
                                  <Badge
                                    key={k}
                                    variant="secondary"
                                    className="font-normal"
                                  >
                                    {k}
                                  </Badge>
                                ))}
                              </div>
                              {state.installed && state.linked ? (
                                <div className="flex items-center gap-1">
                                  <Badge
                                    variant="outline"
                                    className="gap-1 font-normal"
                                    title={
                                      state.sourcePath
                                        ? `源目录：${state.sourcePath}`
                                        : undefined
                                    }
                                  >
                                    <Link2Icon className="size-3" />
                                    链接安装 · 开发
                                  </Badge>
                                  {uninstallBtn}
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  {state.installed ? (
                                    state.update ? (
                                      <Button
                                        size="sm"
                                        className="h-7 gap-1 text-xs"
                                        disabled={state.busy}
                                        onClick={() =>
                                          void installPlugin(
                                            activeMarket!.id,
                                            entry.name,
                                          )
                                        }
                                      >
                                        {state.busy ? (
                                          <Loader2Icon className="size-3 animate-spin" />
                                        ) : null}
                                        更新
                                      </Button>
                                    ) : (
                                      <Badge
                                        variant="outline"
                                        className="gap-1 font-normal"
                                        title={
                                          activeMarket!.id === "builtin"
                                            ? "首方插件随应用分发与更新，不可卸载，可禁用"
                                            : undefined
                                        }
                                      >
                                        <CheckIcon className="size-3" />
                                        {activeMarket!.id === "builtin"
                                          ? "内置"
                                          : "已安装"}
                                      </Badge>
                                    )
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 gap-1 text-xs"
                                      disabled={
                                        state.busy || pending.length > 0
                                      }
                                      onClick={() =>
                                        void installPlugin(
                                          activeMarket!.id,
                                          entry.name,
                                        )
                                      }
                                    >
                                      {state.busy ? (
                                        <Loader2Icon className="size-3 animate-spin" />
                                      ) : null}
                                      安装
                                    </Button>
                                  )}
                                  {uninstallBtn}
                                  {activeMarket!.type === "directory" &&
                                    !isPseudoMarket(activeMarket!.id) &&
                                    !state.update && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-muted-foreground h-7 gap-1 px-2 text-xs"
                                        disabled={
                                          state.busy || pending.length > 0
                                        }
                                        title="cache 条目链接到源目录：改插件源码后重建即生效，无需重复安装，面板自动重载（仅开发用）"
                                        onClick={() =>
                                          void installPlugin(
                                            activeMarket!.id,
                                            entry.name,
                                            { link: true },
                                          )
                                        }
                                      >
                                        {state.busy ? (
                                          <Loader2Icon className="size-3 animate-spin" />
                                        ) : (
                                          <Link2Icon className="size-3" />
                                        )}
                                        {state.installed
                                          ? "转链接装"
                                          : "链接装"}
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
          </>
        )}
      </div>

      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
      <InstallLocalDialog
        open={localInstallOpen}
        onOpenChange={setLocalInstallOpen}
      />

      {/* 预览弹窗：动作区与市场卡片同款（安装/更新/链接装/已装徽标 + 卸载） */}
      <PluginPreviewDialog
        preview={previewData}
        onClose={() => setPreviewSel(null)}
        footer={
          previewMarket && previewSel && previewState ? (
            previewState.installed && previewState.linked ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="gap-1 font-normal">
                  <Link2Icon className="size-3" />
                  链接安装 · 开发
                </Badge>
                {dialogUninstallBtn}
              </div>
            ) : previewState.installed && !previewState.update ? (
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="gap-1 font-normal"
                  title={
                    previewMarket.id === "builtin"
                      ? "首方插件随应用分发与更新，不可卸载，可禁用"
                      : undefined
                  }
                >
                  <CheckIcon className="size-3" />
                  {previewMarket.id === "builtin"
                    ? "内置 · 随应用更新"
                    : "已安装"}
                </Badge>
                {dialogUninstallBtn}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={previewState.busy || pending.length > 0}
                  onClick={() =>
                    void installPlugin(previewMarket.id, previewSel.name)
                  }
                >
                  {previewState.busy && (
                    <Loader2Icon className="size-3 animate-spin" />
                  )}
                  {previewState.installed ? "更新" : "安装"}
                </Button>
                {previewMarket.type === "directory" &&
                  !isPseudoMarket(previewMarket.id) &&
                  !previewState.update && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={previewState.busy || pending.length > 0}
                      title="cache 条目链接到源目录：改插件源码后重建即生效（仅开发用）"
                      onClick={() =>
                        void installPlugin(previewMarket.id, previewSel.name, {
                          link: true,
                        })
                      }
                    >
                      <Link2Icon className="size-3" />
                      {previewState.installed ? "转链接装" : "链接装"}
                    </Button>
                  )}
                {dialogUninstallBtn}
              </div>
            )
          ) : undefined
        }
      />

      {/* 移除市场确认：只撤登记不卸插件；移除后市场目录消失，
          从它装过的插件保留并标记「市场已移除」 */}
      <Dialog
        open={confirmRemoveMkt !== null}
        onOpenChange={(open) => !open && setConfirmRemoveMkt(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>移除市场</DialogTitle>
            <DialogDescription>
              将移除「
              <span className="text-foreground font-medium">
                {confirmRemoveMkt?.name}
              </span>
              」的登记，市场目录不再显示。已安装的插件不受影响
              （会标记「市场已移除」并保留可用），之后重新添加同一市场即可恢复更新通道。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemoveMkt(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={confirmRemoveMkt === null}
              onClick={() => {
                const target = confirmRemoveMkt;
                setConfirmRemoveMkt(null);
                if (!target) return;
                void removeMarketplace(target.id)
                  .then(() => {
                    // 移的正是当前选中市场：清空 id，由 effect 锚到剩余首个
                    if (activeMktId === target.id) setActiveMktId(null);
                  })
                  .catch((err) => {
                    void import("@/components/ui/toast").then(({ toast }) => {
                      toast.error({
                        title: "移除市场失败",
                        description: String(err),
                      });
                    });
                  });
              }}
            >
              <Trash2Icon className="size-3.5" />
              移除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 市场页卸载确认：与已装页同款（点名插件与后果） */}
      <UninstallDialog
        entries={confirmUninstall}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={(entries) => {
          void uninstallPluginsBatch(
            entries.map((e) => e.pluginId),
            workspace,
          );
          setConfirmUninstall(null);
        }}
      />
    </div>
  );
};
