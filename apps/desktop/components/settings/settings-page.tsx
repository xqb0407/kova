"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/lib/i18n";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { WindowControls } from "@/components/window-controls";
import {
  ArchiveIcon,
  BotIcon,
  BoxesIcon,
  BrainIcon,
  CatIcon,
  ChevronLeftIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  GlobeIcon,
  HardDriveDownloadIcon,
  InboxIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  // PaletteIcon, // 设计主题分区已随设计模式 UI 一起下线（恢复时取消注释）
  PackageIcon,
  PaintbrushIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SearchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { GeneralSettings } from "./components/general-settings";
import { AgentConfigSettings } from "./components/agent-config-settings";
import { WebSearchSettings } from "./components/websearch-settings";
import { AccessAccelSettings } from "./components/access-accel-settings";
import { NetworkProxySettings } from "./components/network-proxy-settings";
import { HooksSettings } from "./components/hooks-settings";
import { WebhooksSettings } from "./components/webhooks-settings";
import { ModelSettings } from "./components/model-settings";
import { AppearanceSettings } from "./components/appearance-settings";
import { AboutSettings } from "./components/about-settings";
import { ChangelogSettings } from "./components/changelog-settings";
import { ArchiveSettings } from "./components/archive-settings";
import { ProjectsSettings } from "./components/projects-settings";
import { WorktreesSettings } from "./components/worktrees-settings";
import { MemorySettings } from "./components/memory-settings";
import { BackupSettings } from "./components/backup-settings";
import { PersonalizationSettings } from "./components/personalization-settings";
import { ShortcutSettings } from "./components/shortcut-settings";
import { SecretsSettings } from "./components/secrets-settings";
// 设计主题分区已随设计模式 UI 一起下线（恢复时取消注释以下四处：import、
// SettingsSection 联合成员、导航条目、渲染分支）：
// import { DesignThemesSettings } from "./components/design-themes-settings";
import { SshHostsSettings } from "./components/ssh-hosts-settings";
import { PetSettings } from "./components/pet-settings";
import { ArtifactsSettings } from "./components/artifacts-settings";
import { UhpSettings } from "./components/uhp-settings";
import { InboxSourcesSettings } from "./components/inbox-sources-settings";
import {
  getSectionGroup,
  getSectionNavId,
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTION_LABEL_KEYS,
  type SettingsSection,
} from "@/lib/settings/settings-sections";
import { searchSettings, type SettingsSearchEntry } from "@/lib/settings/settings-search";
import { WorktreeIcon } from "@/components/icons/worktree-icons";

export type { SettingsSection } from "@/lib/settings/settings-sections";

/** 导航文案只存词典 key（语言切换即时生效），渲染点经 t 解析 */
const GROUPS: {
  labelKey: string;
  items: { id: SettingsSection; labelKey: string; icon: FC<{ className?: string }> }[];
}[] = [
  {
    labelKey: "settings.groups.prefs",
    items: [
      { id: "general", labelKey: "settings.sections.general", icon: SlidersHorizontalIcon },
      { id: "appearance", labelKey: "settings.sections.appearance", icon: PaintbrushIcon },
      { id: "personalization", labelKey: "settings.sections.personalization", icon: SparklesIcon },
      { id: "pet", labelKey: "settings.sections.pet", icon: CatIcon },
      { id: "archive", labelKey: "settings.sections.archive", icon: ArchiveIcon },
      { id: "projects", labelKey: "settings.sections.projects", icon: FolderKanbanIcon },
      { id: "worktrees", labelKey: "settings.sections.worktrees", icon: WorktreeIcon },
    ],
  },
  {
    labelKey: "settings.groups.agent",
    items: [
      // 模型：模型列表与网页搜索同页——搜索是 agent 默认联网后端，
      // 与模型配置同属「回答从哪里来」，页内用标签切换
      { id: "models", labelKey: "settings.sections.models", icon: BoxesIcon },
      // 智能体配置：电脑控制（能碰本机哪些能力）与 AI 审查（自动动手前谁判风险）
      // 合在一页——两件事都只在回答"我放开了多少"，分成两个入口要拼两次才看得全。
      // 归「智能体」组而不是「系统」——授权的对象是 agent，不是这台机器
      { id: "agent-config", labelKey: "settings.sections.agentConfig", icon: BotIcon },
      // UHP：把内置 pi-agent 暴露成标准 harness，也可接外部 harness
      { id: "memory", labelKey: "settings.sections.memory", icon: BrainIcon },
      // 产物：agent 在无目录任务里生成的交付文件（task-workspace），原在
      // 资料库页一棵树里，现在独立成设置分区管理
      { id: "artifacts", labelKey: "settings.sections.artifacts", icon: PackageIcon },
      { id: "hooks", labelKey: "settings.sections.hooks", icon: ZapIcon },
      { id: "secrets", labelKey: "settings.sections.secrets", icon: KeyRoundIcon },
      // 设计主题分区已随设计模式 UI 一起下线（恢复时取消注释）：
      // { id: "design-themes", labelKey: "settings.sections.designThemes", icon: PaletteIcon },
    ],
  },
  {
    labelKey: "settings.groups.system",
    items: [
      // 网络与 SSH：访问加速（镜像站）、网络代理、SSH 主机都是这台机器的
      // 出网路径，收进一个入口，页内用标签切换，避免菜单里三个近义条目
      { id: "access-accel", labelKey: "settings.sections.networkGroup", icon: GlobeIcon },
      // 收件箱与 Webhook：外部通知进入本机（收件箱来源）与离开本机
      // （Webhook 推送）同属一条通知链路；归「系统」是因为改的是本机通道
      { id: "inbox-sources", labelKey: "settings.sections.inboxGroup", icon: InboxIcon },
      { id: "uhp", labelKey: "settings.sections.uhp", icon: ServerIcon },
      { id: "shortcuts", labelKey: "settings.sections.shortcuts", icon: KeyboardIcon },
      { id: "backup", labelKey: "settings.sections.backup", icon: HardDriveDownloadIcon },
      { id: "about", labelKey: "settings.sections.about", icon: InfoIcon },
    ],
  },
];

/** 有页面但不出现在左侧导航的分区：只能经「关于」按钮或升级弹窗跳入。
 *  更新日志完整时间线较长，独立成页但不额外占一个常驻菜单项。 */
const HIDDEN_SECTIONS: SettingsSection[] = ["changelog"];

/** 事件详情等不可信来源 → section id 的收敛校验（composer 跳本页用）；
 *  集合从 GROUPS + 隐藏分区推导，加页即校验放开，两处不会漂移 */
const ALL_SECTIONS = new Set<SettingsSection>([
  ...GROUPS.flatMap((g) => g.items.map((i) => i.id)),
  // 合并分区的次级页不在菜单里，但深链接/搜索仍可直接跳入
  ...SETTINGS_SECTION_GROUPS.flatMap((g) => g.sections),
  ...HIDDEN_SECTIONS,
]);
export function isSettingsSection(raw: unknown): raw is SettingsSection {
  return typeof raw === "string" && ALL_SECTIONS.has(raw as SettingsSection);
}

/** 无跳转目标时落在菜单第一项（当前是「通用」），不要再硬编码 models */
const FIRST_SECTION: SettingsSection = GROUPS[0]?.items[0]?.id ?? "general";

// fluid hover 槽位：模块级常量保证注册序稳定，导航项按 GROUPS 顺序从 0 起；
// 分组标题不注册（高亮跳过，就近点亮条目）。「返回应用」已移到侧边栏底部的
// 固定页脚，不再占 0 号槽位——它脱离了滚动容器，也就脱离了这套按容器坐标
// 测量 rect 的悬浮高亮（见下方页脚注释）
const NAV_ITEM_INDEX = (() => {
  const map = new Map<SettingsSection, number>();
  let next = 0;
  for (const group of GROUPS) {
    for (const item of group.items) {
      // 合并分区的次级页共用 primary 条目的槽位，切标签时导航高亮不跳动
      const members = getSectionGroup(item.id)?.sections ?? [item.id];
      for (const member of members) map.set(member, next);
      next += 1;
    }
  }
  return map;
})();

/**
 * 搜索命中后滚到对应设置行：目标页可能刚切过去（异步挂载/数据加载），
 * 按短间隔重试；`data-setting-label` 由通用 SettingRow 提供。找不到就停在
 * 页面顶部——至少已经切到正确页面。
 */
function scrollToSettingLabel(label: string): void {
  let attempts = 0;
  const tick = () => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-setting-label]"),
    );
    const target = rows.find((row) => row.dataset.settingLabel === label);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("bg-muted");
      window.setTimeout(() => target.classList.remove("bg-muted"), 1200);
      return;
    }
    // 目标页可能要先拉配置再渲染行，留约 2.4s 重试窗口
    if (attempts++ < 30) window.setTimeout(tick, 80);
  };
  window.setTimeout(tick, 50);
}

/** 设置页：全窗口视图，左侧二级侧边栏导航，"返回应用"回到聊天 */
export const SettingsPage: FC<{
  onBack: () => void;
  /** 设置页内“打开项目”：切回聊天并新建该项目下的对话 */
  onOpenProject?: () => void;
  /** 设置页内打开某个会话（worktree 新建会话等）：切回聊天落到该会话 */
  onOpenSession?: () => void;
  /** 跳转目标分区 id（base.tsx 自 window 事件转来，不可信字符串，本模块校验） */
  jumpSection?: string;
  /** 单调递增序号：已挂载状态下同分区重复跳转也要生效，靠它触发 effect */
  jumpSeq?: number;
  /** 本次跳转已消费：base 清掉一次性 jump，避免下次正常进入设置继承旧目标 */
  onJumpConsumed?: () => void;
}> = ({
  onBack,
  onOpenProject,
  onOpenSession,
  jumpSection,
  jumpSeq,
  onJumpConsumed,
}) => {
  const t = useT();
  const [section, setSection] = useState<SettingsSection>(() =>
    isSettingsSection(jumpSection) ? jumpSection : FIRST_SECTION,
  );
  // 更新日志页的「返回」回到进入它之前的分区（通常是从「关于」点进来），
  // 而不是直接退出整个设置页。直接经弹窗跳入时没有上一页，退回「关于」。
  const previousSectionRef = useRef<SettingsSection>(
    isSettingsSection(jumpSection) && jumpSection !== "changelog"
      ? jumpSection
      : "about",
  );
  useEffect(() => {
    if (section !== "changelog") previousSectionRef.current = section;
  }, [section]);
  useEffect(() => {
    if (!jumpSeq) return;
    // 跳转是一次性的：消费后让 base 清空 jump，否则下次从侧栏正常进入设置
    // 会拿上一次的「更新日志」等目标做初始分区（Windows 上表现为默认进更新日志）。
    if (isSettingsSection(jumpSection)) setSection(jumpSection);
    onJumpConsumed?.();
  }, [jumpSeq, jumpSection, onJumpConsumed]);
  // 左侧导航与侧边栏列表同款 fluid hover：导航容器即滚动容器，
  // 高亮 rect 随 content 滚动（容器内 position:absolute 子元素随之滚动）
  const navRef = useRef<HTMLDivElement>(null);
  const navHover = useFluidHover(navRef);
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；macOS 红绿灯悬浮于侧边栏顶栏，
  // Windows 隐藏系统标题栏后由 WindowControls 接管，网页端无窗口 chrome
  const desktop = isDesktop();
  const winControls = desktop && !isMacPlatform();
  // macOS 桌面端的红绿灯悬浮在侧栏顶栏左缘；其他平台这一行没有系统 chrome，
  // 放「设置」标题，避免 Windows 上出现一整条空白
  const macDesktop = desktop && isMacPlatform();
  // 隐藏分区（更新日志）不在导航里：此时不点亮任何一项，而不是错亮第一项
  const activeNavIndex = NAV_ITEM_INDEX.get(section);
  // 合并分区（模型+网页搜索等）：内容区顶部出页内标签
  const sectionGroup = getSectionGroup(section);
  const sectionTabs =
    sectionGroup && sectionGroup.sections.length > 1 ? sectionGroup.sections : null;

  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 搜索命中行的 label：切页后等目标页挂载再滚过去 */
  const pendingSearchLabel = useRef<string | null>(null);
  const searchResults = useMemo(() => searchSettings(query), [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const label = pendingSearchLabel.current;
    if (!label) return;
    pendingSearchLabel.current = null;
    scrollToSettingLabel(label);
  }, [section]);

  const goToSearchHit = (hit: SettingsSearchEntry) => {
    setQuery("");
    if (hit.isPage) {
      setSection(hit.section);
      return;
    }
    const label = t(hit.labelKey);
    if (hit.section === section) {
      scrollToSettingLabel(label);
      return;
    }
    pendingSearchLabel.current = label;
    setSection(hit.section);
  };

  return (
    <div className="bg-muted/55 flex h-full w-full">
      {/* 二级侧边栏 */}
      <nav
        data-slot="settings-nav"
        className="bg-transparent flex w-65 shrink-0  flex-col border-r border-border/50"
      >
        {/* 顶栏拖拽区：macOS 红绿灯悬浮于此行；Windows/Linux/网页放「设置」
            标题，避免左侧一整条空白 */}
        <div
          data-drag-region={desktop ? "deep" : undefined}
          className="flex h-12 shrink-0 items-center pl-5"
        >
          {macDesktop ? null : (
            <span className="text-foreground/90 text-md pt-4 font-bold">{t("settings.page.title")}</span>
          )}
        </div>

        {/* 设置搜索：页面 + 设置行；⌘K / Ctrl+K 聚焦 */}
        <div className="px-3 pt-1 pb-2">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // 中文输入法回车确认候选词时不触发跳转
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  setQuery("");
                  event.currentTarget.blur();
                } else if (event.key === "Enter" && searchResults[0]) {
                  event.preventDefault();
                  goToSearchHit(searchResults[0]);
                }
              }}
              placeholder={t("settings.page.searchPlaceholder")}
              aria-label={t("settings.page.searchPlaceholder")}
              className="bg-background h-8 pr-8 pl-8 text-sm"
            />
            {query && (
              <button
                type="button"
                aria-label={t("settings.page.searchClear")}
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <div
          ref={navRef}
          className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 pt-1"
          {...navHover.handlers}
        >
          {query.trim() ? (
            <div className="flex flex-col gap-0.5">
              {searchResults.length === 0 ? (
                <p className="text-muted-foreground px-2 py-3 text-[13px] leading-5">
                  {t("settings.page.searchEmpty")}
                </p>
              ) : (
                searchResults.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => goToSearchHit(hit)}
                    className="hover:bg-muted flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left"
                  >
                    <SearchIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{t(hit.labelKey)}</span>
                      {!hit.isPage && (
                        <span className="text-muted-foreground block truncate text-[11px] leading-4">
                          {t(hit.pageLabelKey)}
                        </span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <>
              {/* 选中项常驻高亮：复用同一套 itemRects 测量，切换 section 时
                  弹簧滑到目标行。session 恒为 0 → 不随鼠标进出重新淡入淡出，
                  只在首挂载淡入、此后只滑位置。渲染在 hover 高亮之前：同层
                  绝对定位，鼠标悬停高亮叠在选中高亮之上。 */}
              <FluidHoverHighlight
                rect={
                  navHover.isMeasured && activeNavIndex !== undefined
                    ? (navHover.itemRects[activeNavIndex] ?? null)
                    : null
                }
                session={0}
                className="bg-muted rounded-md"
                // 跨行位移比悬停跟随远得多，用与 ui/tabs 指示器同款的
                // no-overshoot spring（beui 参考曲线），而非 80ms 的 spring.fast。
                transition={{ type: "spring", stiffness: 170, damping: 30, mass: 1.2 }}
              />
              <FluidHoverHighlight hover={navHover} className="rounded-md" />
              {GROUPS.map((group) => (
                <div key={group.labelKey} className="flex flex-col gap-1">
                  <div className="text-muted-foreground px-2 pt-3 pb-1 text-[13px] leading-5 font-medium">
                    {t(group.labelKey)}
                  </div>
                  {group.items.map(({ id, labelKey, icon: Icon }) => (
                    <FluidHoverRow
                      key={id}
                      registerItem={navHover.registerItem}
                      index={NAV_ITEM_INDEX.get(id) ?? 0}
                    >
                      <button
                        type="button"
                        onClick={() => setSection(id)}
                        data-active={getSectionNavId(section) === id}
                        className={cn(
                          "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-sm font-normal",
                          "data-active:text-foreground text-muted-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {t(labelKey)}
                      </button>
                    </FluidHoverRow>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* "返回应用"固定在侧边栏底部：脱离上面的滚动容器，导航滚到底它也不会
            被滚走。代价是它不再参与 fluid hover（高亮按容器坐标测量，移出容器
            后 rect 会对不上），因此这里用 Button ghost 自带的 hover 底色兜底 */}
        <div className="shrink-0 px-3 pt-1 pb-3">
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-1.5 rounded-md px-2.5 text-sm font-normal text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            {t("settings.page.backToApp")}
          </Button>
        </div>
      </nav>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <div
          data-drag-region={desktop ? "deep" : undefined}
          className="flex h-12 shrink-0 items-center pr-4"
        >
          {/* 顶栏动作槽位：产物详情等全高视图把返回/标题/搜索 portal 进来
              （与资料库页 page-header-actions 槽位同款做法）；空槽时保持
              原样——仅作拖拽区，Windows/Linux 放窗口控制 */}
          <div
            data-slot="settings-top-actions"
            className="flex min-w-0 flex-1 items-center"
          />
          {/* 窗口控制固定在窗口右上角；仅 Windows/Linux 渲染 */}
          {winControls && <WindowControls />}
        </div>
        {/* 合并分区的页内标签：菜单只留一个入口，具体配置放在内容区顶部，
            跟随内容左边缘，保证一眼能看到；标签下方再进入各页标题。 */}
        {sectionTabs && (
          <div className="shrink-0">
            <div className="mx-auto w-full max-w-5xl px-8">
              {/* 下划线画在 px-8 内层：左右边缘与标签文字/下方卡片对齐，
                  不再把 padding 也画进线里 */}
              <div className="border-b border-border/40">
                <Tabs
                  value={section}
                  onValueChange={(value) => setSection(value as SettingsSection)}
                >
                  <TabsList variant="line" className="h-11 gap-4">
                    {sectionTabs.map((id) => (
                      <TabsTrigger
                        key={id}
                        value={id}
                        className="flex-none px-0.5 text-sm"
                      >
                        {t(SETTINGS_SECTION_LABEL_KEYS[id])}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </div>
        )}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {section === "models" && <ModelSettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "personalization" && <PersonalizationSettings />}
          {section === "pet" && <PetSettings />}
          {section === "memory" && <MemorySettings />}
          {section === "artifacts" && <ArtifactsSettings />}
          {section === "backup" && <BackupSettings />}
          {section === "shortcuts" && <ShortcutSettings />}
          {section === "archive" && <ArchiveSettings />}
          {section === "projects" && (
            <ProjectsSettings onOpen={onOpenProject} />
          )}
          {section === "worktrees" && (
            <WorktreesSettings onOpenSession={onOpenSession} />
          )}
          {section === "webhooks" && <WebhooksSettings />}
          {section === "inbox-sources" && <InboxSourcesSettings />}
          {section === "hooks" && <HooksSettings />}
          {section === "agent-config" && <AgentConfigSettings />}
          {section === "uhp" && <UhpSettings />}
          {section === "websearch" && <WebSearchSettings />}
          {section === "secrets" && <SecretsSettings />}
          {/* 设计主题分区已随设计模式 UI 一起下线（恢复时取消注释）：
              {section === "design-themes" && <DesignThemesSettings />} */}
          {section === "about" && <AboutSettings />}
          {section === "changelog" && (
            <ChangelogSettings
              onBack={() => setSection(previousSectionRef.current)}
            />
          )}
          {section === "general" && <GeneralSettings />}
          {section === "access-accel" && <AccessAccelSettings />}
          {section === "network-proxy" && <NetworkProxySettings />}
          {section === "ssh-hosts" && <SshHostsSettings />}
        </div>
      </div>
    </div>
  );
};
