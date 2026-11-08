"use client";

/**
 * 插件/技能（侧边栏「插件 / 技能」主区视图；原名「插件市场」）。
 *
 * 标题「插件 / 技能 / MCP」本身即主区页签，三段各自记住自己的视图位置：
 * 市场目录 / 已装插件（仅插件段）/ 管理。插件段沿用插件目录清单，
 * 技能段与 MCP 段分别由技能市场（GitHub 源）与 MCP 市场（官方 Registry）承载。
 * - 市场目录：市场选择器（登记的市场间切换 + 刷新 + 行内移除）+ 插件卡片
 *   （安装/已装/有更新/卸载），右上角「本地安装」「＋ 添加市场」
 *   （本地目录 / Git 仓库）；
 * - 已装插件：独立视图（卡片/单行 + 批量启停/卸载），见 installed-plugins.tsx；
 * - 管理：进页时落到本段默认分段（插件→MCP，技能→技能），段内分段器可跨
 *   组件切换，应用授权暂为空态；子智能体没有独立主区页签，也从这里进。
 *
 * 事实源在 sidecar plugins.ts；耗时操作（添加/刷新/安装）受理即返回，
 * 完成经 plugin_op_result 帧回流（lib/plugins.ts 整包并入镜像）。
 *
 * 版式（参考插件市场页）：内容区居中定宽（max-w-7xl），页头 = 大标题 +
 * 副标题 + 右侧管理入口；管理页把「返回」注入应用顶栏左上角，内容区页头只留
 * 标题/说明 + 分段器，子页只渲染工具行与列表，不重复大标题。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { createPortal } from "react-dom";
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
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useCustomCommands } from "@/lib/pi/pi-commands";
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
  type PluginPreviewMenuAction,
  type PluginPreviewPrimaryAction,
} from "@/components/marketplace/plugin-preview-dialog";
import { useT } from "@/lib/i18n";

/**
 * 伪市场（「本地安装」）：不在登记表、随装随生成——无移除/刷新/链接装，
 * 卸载可用（= 删本地物化目录）。
 */
const isPseudoMarket = (id: string) => id === "local";

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
const CommandsSettings = dynamic(
  () =>
    import("@/components/settings/components/commands-settings").then((m) => ({
      default: m.CommandsSettings,
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
const SkillMarket = dynamic(
  () =>
    import("@/components/marketplace/skill-market").then((m) => ({
      default: m.SkillMarket,
    })),
  { ssr: false, loading: () => <ViewSpinner /> },
);
const McpMarket = dynamic(
  () =>
    import("@/components/marketplace/mcp-market").then((m) => ({
      default: m.McpMarket,
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
type ManageTab = "subagents" | "plugins" | "skills" | "commands" | "apps";

/**
 * 三个主区：标题上的「插件 / 技能 / MCP」即页签。
 * 插件段 = 插件市场（市场目录 / 已装插件 + 市场来源动作）；技能段直接就是
 * 技能页，不套市场的分段器——市场/已装是插件独有的概念；MCP 段是官方
 * Registry 的远程服务器市场。子智能体不占主区页签，收在「管理」里。
 */
type Section = "plugins" | "skills" | "mcp";

/** 插件段内的两个列表视图 */
type SectionView = "market" | "installed";

/** 「管理」进管理页时落的分段：技能 → 技能，插件/MCP → MCP */
const SECTION_MANAGE_TAB: Record<Section, ManageTab> = {
  plugins: "plugins",
  skills: "skills",
  mcp: "plugins",
};

/** 标题页签与其副标题（副标题只说该段真有的能力，不预告未做的分流） */
const SECTION_META: { value: Section; labelKey: string; descKey: string }[] = [
  {
    value: "plugins",
    labelKey: "marketplace.view.tab.plugins",
    descKey: "marketplace.view.desc.plugins",
  },
  {
    value: "skills",
    labelKey: "marketplace.view.tab.skills",
    descKey: "marketplace.view.desc.skills",
  },
  {
    value: "mcp",
    labelKey: "marketplace.view.tab.mcp",
    descKey: "marketplace.view.desc.mcp",
  },
];

/** 管理页各分段的标题/说明：页头身份与下方内容解耦（子页不再重复大标题） */
const MANAGE_META: Record<ManageTab, { labelKey: string; descKey: string }> = {
  subagents: {
    labelKey: "marketplace.view.manageMeta.subagents.label",
    descKey: "marketplace.view.manageMeta.subagents.desc",
  },
  plugins: {
    labelKey: "marketplace.view.manageMeta.plugins.label",
    descKey: "marketplace.view.manageMeta.plugins.desc",
  },
  skills: {
    labelKey: "marketplace.view.manageMeta.skills.label",
    descKey: "marketplace.view.manageMeta.skills.desc",
  },
  commands: {
    labelKey: "marketplace.view.manageMeta.commands.label",
    descKey: "marketplace.view.manageMeta.commands.desc",
  },
  apps: {
    labelKey: "marketplace.view.manageMeta.apps.label",
    descKey: "marketplace.view.manageMeta.apps.desc",
  },
};

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
  const t = useT();
  const workspace = useWorkspace();
  // 管理页分段器的计数；清单数据由迁移进来的管理组件自取
  const skillsSnap = useSkills(workspace);
  const cmdsSnap = useCustomCommands(workspace);
  const subagentsSnap = useSubagents(workspace);
  const mcpSnap = useMcpServers(workspace);
  const pluginsSnap = usePlugins(workspace);
  const marketplacesSnap = useMarketplaces();
  const pending = usePendingOps();

  // 主区页签：标题上的「插件 / 技能 / MCP」；插件段内再切市场目录 / 已装插件
  const [section, setSection] = useState<Section>("plugins");
  const [view, setView] = useState<SectionView>("market");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<ManageTab>("subagents");
  /** 子智能体编辑器占用了内容区：顶栏让位给它（编辑器自带返回 + 标题） */
  const [subagentEditing, setSubagentEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [activeMktId, setActiveMktId] = useState<string | null>(null);
  /** 预览弹窗目标：按 (市场 id, 插件名) 存，渲染期从最新快照推导（刷新/卸载自动跟随） */
  const [previewSel, setPreviewSel] = useState<{
    marketId: string;
    name: string;
  } | null>(null);
  /** 卸载确认（与已装页共用 UninstallDialog；卡片图标钮与预览弹窗「⋯」都进这里） */
  const [confirmUninstall, setConfirmUninstall] = useState<
    PluginEntry[] | null
  >(null);
  /** 市场下拉受控（行内移除钮点击后需手动收起菜单）+ 移除市场确认目标 */
  const [mktMenuOpen, setMktMenuOpen] = useState(false);
  const [confirmRemoveMkt, setConfirmRemoveMkt] =
    useState<MarketplaceEntry | null>(null);
  /** 应用 Header 的页面槽位：管理页把「返回」放到顶栏左上角
   *  （与资料库同一入口，但只承载导航键，内容仍是本页自己的居中页头） */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

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
  // 对应主区（技能 → 技能段，其余 → 插件段）并打开管理页；子智能体没有
  // 独立主区页签，落插件段后由管理分段器选中
  useEffect(() => {
    if (!requestedTab) return;
    const target: Section = requestedTab === "skills" ? "skills" : "plugins";
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
            title: t("marketplace.view.pluginOpFailed", { op: frame.op }),
            description: frame.errorText,
          });
        });
      }
    });
    return () => setPluginOpHandler(null);
  }, [t]);

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
  /** 预览弹窗条目（未装为 null）；「⋯」菜单的卸载动作与页脚状态共用 */
  const previewInstalledEntry = previewState?.installed
    ? previewState.plugin
    : null;

  /** 页脚主操作：安装 / 更新；不可再操作的状态（已装、链接装）置灰作状态位 */
  const previewPrimaryAction: PluginPreviewPrimaryAction | undefined =
    previewMarket && previewSel && previewState
      ? previewState.installed && previewState.linked
        ? {
            label: t("marketplace.view.linkedInstalled"),
            variant: "outline",
            disabled: true,
          }
        : previewState.installed && !previewState.update
          ? {
              label: t("marketplace.common.installed"),
              icon: <CheckIcon className="size-4" />,
              variant: "outline",
              disabled: true,
            }
          : {
              label: previewState.installed
                ? t("marketplace.common.update")
                : t("marketplace.common.install"),
              busy: previewState.busy,
              disabled: previewState.busy || pending.length > 0,
              onClick: () =>
                void installPlugin(previewMarket.id, previewSel.name),
            }
      : undefined;

  /** 「⋯」次要动作：链接装（仅目录市场；有更新时不给）、卸载 */
  const previewMenuActions: PluginPreviewMenuAction[] =
    previewMarket && previewSel && previewState
      ? [
          ...(previewMarket.type === "directory" &&
          !isPseudoMarket(previewMarket.id) &&
          !previewState.update &&
          !previewState.linked
            ? [
                {
                  label: previewState.installed
                    ? t("marketplace.view.convertToLink")
                    : t("marketplace.view.linkToInstallDev"),
                  disabled: previewState.busy || pending.length > 0,
                  onSelect: () =>
                    void installPlugin(previewMarket.id, previewSel.name, {
                      link: true,
                    }),
                },
              ]
            : []),
          ...(previewInstalledEntry
            ? [
                {
                  label: t("marketplace.common.uninstall"),
                  destructive: true,
                  disabled: pending.length > 0,
                  onSelect: () => setConfirmUninstall([previewInstalledEntry]),
                },
              ]
            : []),
        ]
      : [];

  if (manageOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* 返回键注入应用顶栏左上角（页面本身的标题/说明仍在下方居中页头里）；
            子智能体编辑器自带返回与标题，此时让位，避免两个「返回」叠在一起。 */}
        {headerSlot && !subagentEditing
          ? createPortal(
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground shrink-0 gap-1"
                onClick={() => setManageOpen(false)}
              >
                <ChevronLeftIcon className="size-4" />
                {t("marketplace.common.back")}
              </Button>,
              headerSlot,
            )
          : null}
        {/* 页头：与内容同宽同轴（参考图：标题/说明在左、分段器在右） */}
        {!subagentEditing && (
          <div className="mx-auto flex w-full max-w-7xl shrink-0 flex-wrap items-end justify-between gap-4 px-8 pt-8">
            <div className="min-w-0">
              {/* 顶栏槽位不可用（非桌面壳/预览）时的兜底返回，避免管理页没有出口 */}
              {!headerSlot && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground -ml-2 mb-1 shrink-0 gap-1"
                  onClick={() => setManageOpen(false)}
                >
                  <ChevronLeftIcon className="size-4" />
                  {t("marketplace.common.back")}
                </Button>
              )}
              <h1 className="truncate text-2xl font-bold tracking-tight">
                {t(MANAGE_META[manageTab].labelKey)}
              </h1>
              <p className="text-muted-foreground mt-1 truncate text-sm">
                {t(MANAGE_META[manageTab].descKey)}
              </p>
            </div>
            <Segmented
              value={manageTab}
              onChange={setManageTab}
              options={[
                {
                  value: "subagents",
                  label: t("marketplace.view.manageTab.subagents", {
                    count:
                      subagentsSnap.agents.length +
                      subagentsSnap.pluginAgents.length,
                  }),
                },
                {
                  value: "plugins",
                  label: t("marketplace.view.manageTab.plugins", {
                    count: mcpSnap.servers.length,
                  }),
                },
                {
                  value: "skills",
                  label: t("marketplace.view.manageTab.skills", {
                    count: skillsSnap.skills.length,
                  }),
                },
                {
                  value: "commands",
                  label: t("marketplace.view.manageTab.commands", {
                    count: cmdsSnap.length,
                  }),
                },
                { value: "apps", label: t("marketplace.view.manageTab.apps") },
              ]}
            />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <div className="mx-auto h-full w-full max-w-7xl px-8 pt-6 pb-8">
            {manageTab === "subagents" && (
              <SubagentsSettings embedded onEditingChange={setSubagentEditing} />
            )}
            {manageTab === "plugins" && <McpSettings embedded />}
            {manageTab === "skills" && <SkillsSettings embedded />}
            {manageTab === "commands" && <CommandsSettings embedded />}
            {manageTab === "apps" && (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
                {/* 缺省页与搜索/资料库同一套点阵云 */}
                <div className="relative mb-1 grid place-items-center">
                  <DotCloud />
                  <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                    <Link2Icon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
                  </div>
                </div>
                {t("marketplace.view.noAppAccess")}
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

  // 三段共用同一份市场目录清单（技能市场的按组件分流待做）
  const marketEntries = activeMarket?.plugins ?? [];

  return (
    <div className="h-full">
      <div className="mx-auto flex h-full w-full max-w-7xl flex-col px-8 py-8">
        {/* 页头：标题即页签（插件 / 技能 / MCP），右侧「管理」进本段管理页 */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-baseline gap-2 text-2xl font-bold tracking-tight">
              {SECTION_META.map((s, i) => (
                <span key={s.value} className="flex items-baseline gap-2">
                  {i > 0 && (
                    <span className="text-muted-foreground font-normal">
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
                        : "text-muted-foreground hover:text-foreground transition-colors"
                    }
                  >
                    {t(s.labelKey)}
                  </button>
                </span>
              ))}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t(SECTION_META.find((s) => s.value === section)!.descKey)}
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0 gap-1.5"
            title={t("marketplace.view.manageTitle", {
              label: t(SECTION_META.find((s) => s.value === section)!.labelKey),
            })}
            onClick={() => {
              setManageTab(SECTION_MANAGE_TAB[section]);
              setManageOpen(true);
            }}
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {t("marketplace.view.manage")}
          </Button>
        </div>

        {section === "skills" ? (
          /* 技能段：技能市场（精选 GitHub 仓库，安装落地为本地技能）；
             本地技能管理仍在页头右上角「管理」里 */
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <SkillMarket />
          </div>
        ) : section === "mcp" ? (
          /* MCP 段：官方 Registry 远程服务器市场（仅 HTTPS，安装为 HTTP 连接器）；
             已添加服务器的启停/鉴权仍在页头右上角「管理」里 */
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <McpMarket />
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
                    label: t("marketplace.view.marketTab", {
                      count: marketEntries.length,
                    }),
                  },
                  {
                    value: "installed",
                    label: t("marketplace.view.installedTab", {
                      count: pluginsSnap.plugins.length,
                    }),
                  },
                ]}
              />
              {view === "market" && (
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    title={t("marketplace.view.localInstallHint")}
                    onClick={() => setLocalInstallOpen(true)}
                  >
                    {t("marketplace.view.localInstall")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setAddOpen(true)}
                  >
                    {t("marketplace.view.addMarketplace")}
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
                <p className="text-sm font-medium">
                  {t("marketplace.view.emptyTitle")}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t("marketplace.view.emptyDesc")}
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
                          {/* 移除入口（伪市场「本地安装」不可移除）。
                          用 span 而非 button：菜单项本身是 button，不允许嵌套 */}
                          {!isPseudoMarket(m.id) && (
                            <span
                              role="button"
                              aria-label={t("marketplace.view.removeMarketAria", {
                                name: m.name,
                              })}
                              title={t("marketplace.view.removeMarketHint")}
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
                        {t("marketplace.view.addMarketplaceMenu")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* 伪市场无刷新概念（本地安装随装随生成） */}
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
                      {t("marketplace.view.refresh")}
                    </Button>
                  )}
                </div>

                {/* 插件卡片网格 */}
                <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-8">
                  {activeMarket!.needsRefresh ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                      <PackageOpenIcon className="size-8" />
                      {t("marketplace.view.catalogNotLoaded")}
                    </div>
                  ) : marketEntries.length === 0 ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                      <PackageOpenIcon className="size-8" />
                      {t("marketplace.view.emptyMarket")}
                    </div>
                  ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                      {marketEntries.map((entry) => {
                        const state = installStateOf(activeMarket!, entry.name);
                        // 已装插件在市场页即可卸载：图标钮保持卡片版式不挤，确认弹窗与已装页共用
                        const uninstallBtn =
                          state.installed &&
                          state.plugin ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive h-7 w-7 shrink-0 p-0"
                              title={t("marketplace.view.cardUninstallHint")}
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
                            title={t("marketplace.view.cardOpen")}
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
                            className="bg-accent hover:bg-[color-mix(in_oklab,var(--color-accent)_92%,var(--color-foreground))] flex cursor-pointer flex-col rounded-2xl p-2 transition-colors"
                          >
                            {/* 标题行（图标 + 名称/版本 + 品类）坐在灰壳上、不落白面板：
                                panel-card 分层（与自动化任务卡同一套皮），无描边；px-4 让它与
                                面板内文字的左右缘对齐同一竖线。
                                品类从第二行并进名称行：灰罩收成一行（图标 + 12px 内距），
                                两行罩子在小卡上灰面占比近半，是"外面显脏"的根 */}
                            <div className="flex min-w-0 items-center gap-3 px-4 py-1.5">
                              <div className="bg-background grid size-6 shrink-0 place-items-center overflow-hidden rounded-xl">
                                <PluginIcon src={entry.icon} name={entry.name} />
                              </div>
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span className="truncate text-sm font-medium">
                                  {entry.name}
                                </span>
                                {entry.version && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 px-1.5 font-mono text-xs font-normal"
                                  >
                                    v{entry.version}
                                  </Badge>
                                )}
                                {entry.category && (
                                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                                    {entry.category}
                                  </span>
                                )}
                              </div>
                            </div>
                            {/* 内层反色面板：一句话描述 + 安装动作。卡片只留"能不能用、
                                要不要装"这一层，描述封顶两行，关键词/组件构成等明细全在
                                预览弹窗里（点卡片打开），卡面不再堆徽标 */}
                            <div className="flex flex-1 flex-col rounded-lg bg-background p-4">
                              {entry.description && (
                                <p className="text-muted-foreground line-clamp-2 flex-1 text-xs">
                                  {entry.description}
                                </p>
                              )}
                              <div className="mt-3 flex items-center justify-end">
                                {state.installed && state.linked ? (
                                  <div className="flex items-center gap-1">
                                    <Badge
                                      variant="outline"
                                      className="gap-1 font-normal"
                                      title={
                                        state.sourcePath
                                          ? t("marketplace.view.sourcePath", {
                                              path: state.sourcePath,
                                            })
                                          : undefined
                                      }
                                    >
                                      <Link2Icon className="size-3" />
                                      {t("marketplace.view.linkedDev")}
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
                                          {t("marketplace.common.update")}
                                        </Button>
                                      ) : (
                                        <Badge
                                          variant="outline"
                                          className="gap-1 font-normal"
                                        >
                                          <CheckIcon className="size-3" />
                                          {t("marketplace.common.installed")}
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
                                        {t("marketplace.common.install")}
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
                                          title={t("marketplace.view.linkHint")}
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
                                            ? t("marketplace.view.convertLinkShort")
                                            : t("marketplace.view.linkShort")}
                                        </Button>
                                      )}
                                  </div>
                                )}
                              </div>
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

      {/* 预览弹窗：页脚一条整宽主操作（安装/更新/已装状态位），
          链接装与卸载收进右上「⋯」 */}
      <PluginPreviewDialog
        preview={previewData}
        onClose={() => setPreviewSel(null)}
        primaryAction={previewPrimaryAction}
        menuActions={previewMenuActions}
      />

      {/* 移除市场确认：只撤登记不卸插件；移除后市场目录消失，
          从它装过的插件保留并标记「市场已移除」 */}
      <AlertDialog
        open={confirmRemoveMkt !== null}
        onOpenChange={(open) => !open && setConfirmRemoveMkt(null)}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("marketplace.view.removeDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("marketplace.view.removeDialog.descPrefix")}
              <span className="text-foreground font-medium">
                {confirmRemoveMkt?.name}
              </span>
              {t("marketplace.view.removeDialog.descSuffix")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              size="sm"
              onClick={() => setConfirmRemoveMkt(null)}
            >
              {t("marketplace.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
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
                        title: t("marketplace.view.removeFailed"),
                        description: String(err),
                      });
                    });
                  });
              }}
            >
              <Trash2Icon className="size-3.5" />
              {t("marketplace.view.removeDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
