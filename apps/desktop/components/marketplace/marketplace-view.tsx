"use client";

/**
 * 插件/技能（侧边栏「插件 / 技能」主区视图；原名「插件市场」）。
 *
 * 标题「插件 / 技能 / MCP」本身即主区页签，三段各自记住自己的视图位置：
 * 市场目录 / 已装插件（仅插件段）/ 管理。插件段沿用插件目录清单，
 * 技能段与 MCP 段分别由技能市场（GitHub 源）与 MCP 市场（官方 Registry）承载。
 * - 市场目录：单行工具条（全部 / 已安装 / 可安装 chip + 市场选择器 + 刷新
 *   + 搜索）+ 按 category 分组的两列扁平行（参考集成目录）：
 *   行尾只留安装/已安装/更新一个主操作，详情、链接装与卸载进预览弹窗和
 *   行尾「⋯」；「已安装」落到已装管理视图；本地安装与添加市场收进市场
 *   选择器下拉（零市场时入口在空态里）；
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
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
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
  MoreHorizontalIcon,
  PackageOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import { useCustomCommands } from "@/lib/pi/pi-commands";
import { useSkills } from "@/lib/skills/skills";
import { useSubagents } from "@/lib/subagent/subagents";
import { useMcpServers } from "@/lib/mcp/mcp";
import {
  getMarketplacePluginPreview,
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
const ConnectorsMarket = dynamic(
  () =>
    import("@/components/marketplace/connectors-market").then((m) => ({
      default: m.ConnectorsMarket,
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
type Section = "connectors" | "plugins" | "skills";

/** 插件段的浏览筛选：全部目录 / 已安装（管理视图）/ 可安装 */
type CatalogFilter = "all" | "installed" | "available";

/** 「管理」进管理页时落的分段：技能 → 技能，Connector/插件 → 插件管理 */
const SECTION_MANAGE_TAB: Record<Section, ManageTab> = {
  connectors: "plugins",
  plugins: "plugins",
  skills: "skills",
};

/** 标题页签与其副标题（副标题只说该段真有的能力，不预告未做的分流） */
const SECTION_META: { value: Section; labelKey: string; descKey: string }[] = [
  {
    value: "connectors",
    labelKey: "marketplace.view.tab.connectors",
    descKey: "marketplace.view.desc.connectors",
  },
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

/** 目录条目的安装态（与 installStateOf 同形） */
type PluginCatalogState = {
  installed: boolean;
  linked: boolean;
  sourcePath: string | undefined;
  plugin: PluginEntry | null;
  update: boolean;
  busy: boolean;
};

/**
 * 市场目录行（参考集成目录的扁平行版式）：图标 + 名称/版本 + 单行描述 +
 * 行尾主操作。卡片壳全部去掉、按分类两列铺开，一屏能扫的条目数比卡片网格
 * 高得多；详情、链接装、卸载留在预览弹窗与行尾「⋯」里，行上只保留
 * 安装 / 已安装 / 更新这一个主操作。
 */
const PluginCatalogRow: FC<{
  entry: MarketplaceEntry["plugins"][number];
  state: PluginCatalogState;
  /** 目录市场（非伪市场）且当前不是链接装/有待更新时可转链接装 */
  canLink: boolean;
  /** 全局有挂起操作：与既有卡片一致，避免并发安装 */
  pending: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onLink: () => void;
  onUninstall: () => void;
}> = ({
  entry,
  state,
  canLink,
  pending,
  onOpen,
  onInstall,
  onLink,
  onUninstall,
}) => {
  const t = useT();
  const disabled = state.busy || pending;
  const hasMenu = state.installed || canLink;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("marketplace.view.cardOpen")}
      title={t("marketplace.view.cardOpen")}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group hover:bg-muted/40 focus-visible:bg-muted/40 border-border/50 flex cursor-pointer items-center gap-3.5 rounded-xl border p-3 transition-colors outline-none"
    >
      <div className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg">
        <PluginIcon
          src={entry.icon}
          name={entry.displayName ?? entry.name}
          className="text-lg"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {entry.displayName ?? entry.name}
          </span>
          {entry.version && (
            <span className="text-muted-foreground shrink-0 font-mono text-2xs">
              v{entry.version}
            </span>
          )}
          {state.linked && (
            <Badge
              variant="outline"
              className="shrink-0 gap-0.5 px-1.5 text-2xs font-normal"
              title={
                state.sourcePath
                  ? t("marketplace.view.sourcePath", { path: state.sourcePath })
                  : undefined
              }
            >
              <Link2Icon className="size-3" />
              {t("marketplace.view.linkedDev")}
            </Badge>
          )}
          {state.update && (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 text-2xs font-normal"
            >
              {t("marketplace.view.updateAvailable")}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs leading-5">
          {entry.description || t("marketplace.preview.noDescription")}
        </p>
      </div>
      {/* 动作区自己吞掉点击：行本体是「打开详情」，按钮/菜单不应触发它 */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  title={t("marketplace.view.moreActions")}
                  aria-label={t("marketplace.view.moreActions")}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              {canLink && (
                <DropdownMenuItem disabled={disabled} onClick={onLink}>
                  <Link2Icon className="size-3.5" />
                  {state.installed
                    ? t("marketplace.view.convertToLink")
                    : t("marketplace.view.linkToInstallDev")}
                </DropdownMenuItem>
              )}
              {state.installed && (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={disabled}
                  onClick={onUninstall}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("marketplace.common.uninstall")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {state.busy ? (
          // 行内的主操作位置直接换成「转圈 + 文字」：只把 + 置灰看不出在做什么，
          // 尤其 git 市场 clone 可能持续数十秒
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled
          >
            <Loader2Icon className="size-3.5 animate-spin" />
            {state.update
              ? t("marketplace.installed.updating")
              : t("marketplace.view.installing")}
          </Button>
        ) : state.installed ? (
          state.update ? (
            <Button
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={disabled}
              onClick={onInstall}
            >
              {t("marketplace.common.update")}
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="outline"
              disabled
              title={t("marketplace.view.installedAria", {
                name: entry.displayName ?? entry.name,
              })}
              aria-label={t("marketplace.view.installedAria", {
                name: entry.displayName ?? entry.name,
              })}
            >
              <CheckIcon className="size-3.5" />
            </Button>
          )
        ) : (
          <Button
            size="icon-sm"
            variant="outline"
            disabled={disabled}
            title={t("marketplace.view.installAria", {
              name: entry.displayName ?? entry.name,
            })}
            aria-label={t("marketplace.view.installAria", {
              name: entry.displayName ?? entry.name,
            })}
            onClick={onInstall}
          >
            <PlusIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
};

export const MarketplaceView: FC<{
  /** composer「+」菜单请求直落的分段；非空即打开管理页并落到该分段 */
  manageTab?: ManageTab | null;
  /** 请求已消费：宿主清掉一次性请求，避免再次进入市场时又落到管理页 */
  onManageTabConsumed?: () => void;
}> = ({ manageTab: requestedTab, onManageTabConsumed }) => {
  const t = useT();
  // 工作区级技能/插件/MCP 配置写入项目主目录，附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
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
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  /** 市场目录内的搜索（只作用于当前选中市场） */
  const [catalogQuery, setCatalogQuery] = useState("");
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
    // 一次性请求：落位后立即让宿主清空，否则下次从侧栏进入市场会再次
    // 触发本 effect，直接落在管理页
    onManageTabConsumed?.();
  }, [requestedTab, onManageTabConsumed]);

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

  /** 已装插件按「市场:名称」建索引：目录逐行取安装态，别每行线性扫一遍 */
  const installedByKey = useMemo(() => {
    const map = new Map<string, PluginEntry>();
    for (const p of pluginsSnap.plugins) {
      map.set(`${p.marketplaceId}:${p.name}`, p);
    }
    return map;
  }, [pluginsSnap.plugins]);

  /** 当前市场目录中，该插件是否已安装（版本不同 = 有更新；链接装常驻源目录，无更新概念） */
  const installStateOf = useCallback(
    (mkt: MarketplaceEntry, pluginName: string): PluginCatalogState => {
      const installed = installedByKey.get(`${mkt.id}:${pluginName}`);
      if (!installed)
        return {
          installed: false,
          linked: false,
          sourcePath: undefined,
          plugin: null,
          update: false,
          busy: false,
        };
      const catalogEntry = mkt.plugins.find((e) => e.name === pluginName);
      const linked = installed.linked === true;
      const update =
        !linked &&
        Boolean(
          catalogEntry?.version && catalogEntry.version !== installed.version,
        );
      const busy = isPluginOpPending(
        "install_plugin",
        `${mkt.id}:${pluginName}`,
      );
      return {
        installed: true,
        linked,
        sourcePath: installed.sourcePath,
        plugin: installed,
        update,
        busy,
      };
    },
    [installedByKey],
  );

  /** 市场目录的浏览模型：筛选 + 搜索 → 按 category 分组（保持目录原顺序）。
   *  「已安装」不在这里筛——它落到独立的已装管理视图（启停/批量/更新）。 */
  const catalogView = useMemo(() => {
    const entries = activeMarket?.plugins ?? [];
    const rows = entries.map((entry) => ({
      entry,
      state: activeMarket ? installStateOf(activeMarket, entry.name) : null,
    }));
    const q = catalogQuery.trim().toLowerCase();
    const visible = rows.filter(({ entry, state }) => {
      if (catalogFilter === "available" && state?.installed) return false;
      if (!q) return true;
      return [
        entry.name,
        entry.displayName,
        entry.description,
        entry.category,
        ...(entry.keywords ?? []),
      ].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
    });
    const sections: {
      category: string;
      rows: typeof rows;
    }[] = [];
    const byCategory = new Map<string, number>();
    for (const row of visible) {
      const category = row.entry.category?.trim() || "";
      const at = byCategory.get(category);
      if (at === undefined) {
        byCategory.set(category, sections.length);
        sections.push({ category, rows: [row] });
      } else {
        sections[at]!.rows.push(row);
      }
    }
    return sections;
    // pending 必须进依赖：isPluginOpPending 是命令式读取，挂起态变化不会改变
    // 两份清单快照；漏了它，行内 spinner/禁用会停在发起操作前的那一帧
  }, [activeMarket, catalogFilter, catalogQuery, installStateOf, pending]);

  /** 可安装 = 当前市场里还没装的条目（chip 计数，与搜索无关） */
  const availableCount = useMemo(() => {
    if (!activeMarket) return 0;
    return activeMarket.plugins.filter(
      (e) => !installedByKey.has(`${activeMarket.id}:${e.name}`),
    ).length;
  }, [activeMarket, installedByKey]);

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
  /** 未安装条目的组件清单：打开详情时从市场源现读（已装直接用快照） */
  const [previewSource, setPreviewSource] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        components: PluginEntry["components"];
        diagnostics: string[];
        manifestKind: PluginEntry["manifestKind"];
        displayName?: string;
      }
    | { status: "error"; error: string }
    | null
  >(null);
  const previewSourceMarketId = previewSel?.marketId ?? null;
  const previewSourceName = previewSel?.name ?? null;
  const previewHasEntry = Boolean(previewMarket && previewEntry);
  const previewSourceInstalled = previewInstalled !== null;
  useEffect(() => {
    // 已装条目用 list_plugins 快照；市场/条目已消失（换市场、移除市场）时
    // 弹窗本身会关闭，不再发无意义请求
    if (
      !previewSourceMarketId ||
      !previewSourceName ||
      previewSourceInstalled ||
      !previewHasEntry
    ) {
      setPreviewSource(null);
      return;
    }
    let cancelled = false;
    setPreviewSource({ status: "loading" });
    void getMarketplacePluginPreview(previewSourceMarketId, previewSourceName)
      .then((res) => {
        if (cancelled) return;
        setPreviewSource({
          status: "ready",
          components: res.components,
          diagnostics: res.diagnostics,
          manifestKind: res.manifestKind,
          ...(res.displayName ? { displayName: res.displayName } : {}),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewSource({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    previewSourceMarketId,
    previewSourceName,
    previewSourceInstalled,
    previewHasEntry,
  ]);
  /** 展示名：目录条目优先，其次市场源清单现读的结果 */
  const previewDisplayName =
    previewEntry?.displayName ??
    (previewSource?.status === "ready" ? previewSource.displayName : undefined);
  const previewData: PluginPreviewData | null =
    previewMarket && previewEntry
      ? {
          name: previewEntry.name,
          ...(previewDisplayName ? { displayName: previewDisplayName } : {}),
          version: previewEntry.version,
          description: previewEntry.description,
          icon: previewEntry.icon,
          category: previewEntry.category,
          keywords: previewEntry.keywords,
          marketplaceName: previewMarket.name,
          installed: previewInstalled,
          ...(previewInstalled
            ? {}
            : previewSource?.status === "ready"
              ? {
                  components: previewSource.components,
                  diagnostics: previewSource.diagnostics,
                  manifestKind: previewSource.manifestKind,
                }
              : previewSource?.status === "error"
                ? { componentsError: previewSource.error }
                : { componentsLoading: true }),
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
        ) : section === "connectors" ? (
          /* 连接器段：官方远程 Connector 目录（OAuth），与 MCP 管理页同一条管道 */
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <ConnectorsMarket />
          </div>
        ) : (
          <>
            {/* 插件段：参考集成目录的单行工具条——左侧 All / Connected /
                Available chip + 市场选择器 + 刷新，右侧搜索 + 添加。
                「已安装」落到已装管理视图（启停/批量/更新），其余两个筛目录 */}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                {(
                  [
                    {
                      value: "all",
                      label: t("marketplace.view.filter.all"),
                      count: marketEntries.length,
                    },
                    {
                      value: "installed",
                      label: t("marketplace.view.filter.installed"),
                      count: pluginsSnap.plugins.length,
                    },
                    {
                      value: "available",
                      label: t("marketplace.view.filter.available"),
                      count: availableCount,
                    },
                  ] as const
                ).map(({ value, label, count }) => {
                  const active = catalogFilter === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCatalogFilter(value)}
                      aria-pressed={active}
                      className={
                        "h-8 rounded-lg border px-3 text-sm transition-colors " +
                        (active
                          ? "bg-muted text-foreground border-transparent font-medium"
                          : "text-muted-foreground hover:bg-muted/50 border-border/60")
                      }
                    >
                      {label}
                      <span className="text-muted-foreground/70 ml-1 tabular-nums">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* 市场来源 + 刷新 + 搜索收成右侧一组：来源控件降为 ghost，
                  不再和筛选 chip 抢同一视觉层级 */}
              {catalogFilter !== "installed" && (
                <div className="ml-auto flex items-center gap-1.5">
                  {activeMarket && (
                    <>
                      {/* 市场选择器（登记的市场间切换 + 行内移除） */}
                      <DropdownMenu
                        open={mktMenuOpen}
                        onOpenChange={setMktMenuOpen}
                      >
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors"
                          >
                            <MarketplaceIcon market={activeMarket!} />
                            <span className="max-w-32 truncate">
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
                                  aria-label={t(
                                    "marketplace.view.removeMarketAria",
                                    {
                                      name: m.name,
                                    },
                                  )}
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
                        {/* 本地安装与添加市场收进市场下拉：工具栏不再单占一个
                            「添加」按钮，入口语义也归到「市场来源」这一层 */}
                        <DropdownMenuItem
                          title={t("marketplace.view.localInstallHint")}
                          onClick={() => setLocalInstallOpen(true)}
                        >
                          <FolderOpenIcon className="size-3.5" />
                          {t("marketplace.view.localInstall")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setAddOpen(true)}>
                          <GitBranchIcon className="size-3.5" />
                          {t("marketplace.view.addMarketplace")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                  {/* 伪市场无刷新概念（本地安装随装随生成）；git 市场的「刷新」
                      就是重新浅克隆拉取新提交，文案上直接说清楚 */}
                  {activeMarket && !isPseudoMarket(activeMarket.id) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground size-8"
                      disabled={refreshBusy}
                      onClick={() => void refreshMarketplace(activeMarket.id)}
                      title={
                        activeMarket.type === "git"
                          ? t("marketplace.view.refreshGitHint")
                          : t("marketplace.view.refreshHint")
                      }
                      aria-label={t("marketplace.view.refresh")}
                    >
                      <RefreshCwIcon
                        className={
                          refreshBusy ? "size-3.5 animate-spin" : "size-3.5"
                        }
                      />
                    </Button>
                  )}
                  {/* 全局进行中兜底：刷新/安装的挂起态可能发生在别处（批量、
                      另开的市场），这里始终能看到「有操作在跑」 */}
                  {pending.length > 0 && (
                    <span
                      className="text-muted-foreground flex items-center gap-1 text-xs"
                      aria-live="polite"
                    >
                      <Loader2Icon className="size-3.5 animate-spin" />
                      {t("marketplace.view.opRunning")}
                    </span>
                  )}
                  <div className="relative">
                    <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                    <Input
                      className="bg-muted/50 h-8 w-56 pl-8 lg:w-72"
                      placeholder={t("marketplace.view.searchPlaceholder")}
                      aria-label={t("marketplace.view.searchPlaceholder")}
                      value={catalogQuery}
                      onChange={(e) => setCatalogQuery(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {catalogFilter === "installed" ? (
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
                {/* 没有市场时下拉本身不可用：入口直接放在空态里，避免死路 */}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setLocalInstallOpen(true)}
                  >
                    <FolderOpenIcon className="size-3.5" />
                    {t("marketplace.view.localInstall")}
                  </Button>
                  <Button
                    className="gap-1.5"
                    onClick={() => setAddOpen(true)}
                  >
                    <PlusIcon className="size-3.5" />
                    {t("marketplace.view.addMarketplace")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* 目录列表：按 category 分组的两列扁平行（参考集成目录），
                    一屏能扫的条目比卡片网格多；空态区分「市场为空」与
                    「搜索无结果」 */}
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-8">
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
                  ) : catalogView.length === 0 ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
                      <PackageOpenIcon className="size-8" />
                      {catalogQuery.trim()
                        ? t("marketplace.view.noMatch", {
                            query: catalogQuery.trim(),
                          })
                        : catalogFilter === "available"
                          ? t("marketplace.view.allInstalledInMarket")
                          : t("marketplace.view.emptyMarket")}
                    </div>
                  ) : (
                    catalogView.map(({ category, rows }, index) => (
                      <section
                        key={category || "__other"}
                        className={index === 0 ? "mt-1" : "mt-6"}
                      >
                        <h3 className="text-foreground mb-0.5 px-3 text-sm font-semibold">
                          {category || t("marketplace.view.categoryOther")}
                        </h3>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-0.5">
                          {rows.map(({ entry, state }) => (
                            <PluginCatalogRow
                              key={entry.name}
                              entry={entry}
                              state={state!}
                              pending={pending.length > 0}
                              canLink={
                                activeMarket!.type === "directory" &&
                                !isPseudoMarket(activeMarket!.id) &&
                                !state!.update &&
                                !state!.linked
                              }
                              onOpen={() =>
                                setPreviewSel({
                                  marketId: activeMarket!.id,
                                  name: entry.name,
                                })
                              }
                              onInstall={() =>
                                void installPlugin(
                                  activeMarket!.id,
                                  entry.name,
                                )
                              }
                              onLink={() =>
                                void installPlugin(
                                  activeMarket!.id,
                                  entry.name,
                                  { link: true },
                                )
                              }
                              onUninstall={() =>
                                state!.plugin &&
                                setConfirmUninstall([state!.plugin])
                              }
                            />
                          ))}
                        </div>
                      </section>
                    ))
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
