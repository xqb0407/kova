"use client";

/**
 * ClawHub 技能源的市场页（技能段 · 源 = ClawHub）。
 *
 * 目录由 ClawHub 公开读接口提供：搜索、按下载/星标/最新/推荐排序、游标分页。
 * 卡片上的描述直接来自列表响应，不需要逐条回源；只有打开详情和安装时才取
 * SKILL.md。安装仍走 saveSkill({ raw })，与 GitHub 源共用同一条落盘管道。
 *
 * 合规：ClawHub 全部技能为 MIT-0，可商用、可再分发；每张卡片和详情都回链
 * 官方页面，并标明来源与许可。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageOpenIcon,
  RefreshCwIcon,
  StarIcon,
  PlusIcon,
} from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/custom-ui/segmented";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { LoadMoreSentinel } from "@/components/marketplace/load-more-sentinel";
import { SkillDocPreview } from "@/components/marketplace/skill-doc-preview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import {
  setWorkspace,
  useWorkspaceProjectId,
} from "@/lib/workspace/workspace-store";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
  useProjectWorkspaceDir,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import {
  saveSkill,
  useSkills,
  SKILL_SCOPE_LABEL_KEY,
  SKILL_SCOPE_RANK,
  type SkillSaveScope,
  type SkillScope,
} from "@/lib/skills/skills";
import {
  fetchClawhubSkillIcon,
  fetchClawhubSkillMarkdown,
  fetchClawhubSkills,
  searchClawhubSkills,
  type ClawhubSkill,
  type ClawhubSort,
} from "@/lib/skills/clawhub-source";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import type { SkillSource } from "@/components/marketplace/skill-source-select";
import {
  parseSkillFrontmatter,
  recordGithubSkillInstall,
  useGithubSkillInstalls,
} from "@/lib/skills/github-skill-source";
import { getLocale, useT } from "@/lib/i18n";

const SEARCH_DEBOUNCE_MS = 300;

const SORT_OPTIONS: { value: ClawhubSort; labelKey: string }[] = [
  { value: "downloads", labelKey: "marketplace.clawhub.sort.downloads" },
  { value: "stars", labelKey: "marketplace.clawhub.sort.stars" },
  { value: "createdAt", labelKey: "marketplace.clawhub.sort.createdAt" },
  { value: "recommended", labelKey: "marketplace.clawhub.sort.recommended" },
];

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return new Intl.NumberFormat(
    getLocale() === "zh" ? "zh-CN" : "en-US",
    { notation: "compact", maximumFractionDigits: 1 },
  ).format(n);
}

/** `lucide:Brain` → `brain`；DynamicIcon 只认 kebab-case */
function toKebab(name: string): string {
  return name
    .replace(/^lucide:/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/** ClawHub 的图标有两类：https 图片或 lucide 图标名；都没有时回落到首字母色块 */
const ClawhubSkillIcon: FC<{ skill: ClawhubSkill; className?: string }> = ({
  skill,
  className,
}) => {
  if (skill.icon && /^https?:\/\//i.test(skill.icon)) {
    return <PluginIcon src={skill.icon} name={skill.name} className={className} />;
  }
  if (skill.icon) {
    return (
      <DynamicIcon
        name={toKebab(skill.icon) as IconName}
        className={cn("size-5", className)}
        fallback={() => <PluginIcon name={skill.name} className={className} />}
      />
    );
  }
  return <PluginIcon name={skill.name} className={className} />;
};

/** 安装记录键：与 GitHub 源的 id 区分开，避免同名的仓库条目串味 */
function installKey(skill: ClawhubSkill): string {
  return `clawhub:${skill.owner}/${skill.slug}`;
}

function toastError(title: string, err: unknown): void {
  void import("@/components/ui/toast").then(({ toast }) => {
    toast.error({
      title,
      description: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

const ClawhubSkillCard: FC<{
  skill: ClawhubSkill;
  installed: boolean;
  onOpen: () => void;
}> = ({ skill, installed, onOpen }) => {
  const t = useT();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("marketplace.skill.openAria", { name: skill.name })}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={t("marketplace.skill.clickOpen")}
      className="hover:bg-muted/40 flex cursor-pointer items-start gap-3.5 rounded-xl p-3 transition-colors outline-none focus-visible:bg-muted/40"
    >
      <div className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border">
        {/* text-lg：首字母回落在 40px 块里的字号；img 图标不受影响（size-full 铺满） */}
        <ClawhubSkillIcon skill={skill} className="text-lg" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {installed && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              {t("marketplace.common.installed")}
            </Badge>
          )}
        </div>
        <p
          className="text-muted-foreground mt-0.5 truncate text-xs leading-5"
          title={skill.summary}
        >
          {skill.summary || t("marketplace.skill.noDescription")}
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 详情弹窗
// ---------------------------------------------------------------------------

type DetailState =
  | { status: "loading" }
  | { status: "ready"; raw: string }
  | { status: "error"; text: string };

const ClawhubSkillDetailDialog: FC<{
  target: ClawhubSkill | null;
  onClose: () => void;
  installed: boolean;
  /** 本地同名技能的作用域集合：覆盖确认、跨层遮蔽提示按 frontmatter 真名比对 */
  localScopes: ReadonlyMap<string, SkillScope[]>;
  workspaceCwd: string | null;
}> = ({ target, onClose, installed, localScopes, workspaceCwd }) => {
  const t = useT();
  const [state, setState] = useState<DetailState | null>(null);
  const [busyScope, setBusyScope] = useState<SkillSaveScope | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<
    SkillSaveScope | null
  >(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setBusyScope(null);
    setConfirmOverwrite(null);
    if (!target) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchClawhubSkillMarkdown(target, controller.signal)
      .then((raw) => setState({ status: "ready", raw }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, [target, reloadTick]);

  /** 工作区选择（与 MCP 市场同机制）：没选项目时在弹窗里就地选/新建 */
  const registryProjects = useProjectRegistry();
  const activeProjects = useMemo(
    () =>
      registryProjects.filter(
        (project) => !project.archived && !project.hiddenFromSidebar,
      ),
    [registryProjects],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const currentProjectId = useWorkspaceProjectId();
  /** 选中工作区 = 选中项目主目录（同时写 projectId，后续会话/配置同源） */
  const applyProject = (project: ProjectRecord) => {
    const primary = projectPrimaryPath(project);
    if (!primary) return;
    setWorkspace(primary, "user", project.id);
  };
  const selectProjectById = (id: string) => {
    if (id === "__new__") {
      setCreateOpen(true);
      return;
    }
    const project = activeProjects.find((entry) => entry.id === id);
    if (project) applyProject(project);
  };
  const projectItems = useMemo(
    () => [
      ...activeProjects.map((project) => ({
        value: project.id,
        label: projectDisplayName(project),
      })),
      { value: "__new__", label: t("marketplace.mcp.newWorkspace") },
    ],
    [activeProjects, t],
  );

  if (!target) return null;

  const rawSkillMd = state?.status === "ready" ? state.raw : null;
  const frontmatter = rawSkillMd
    ? parseSkillFrontmatter(rawSkillMd)
    : { name: null, description: null };
  const description = frontmatter.description || target.summary;
  const effectiveName = frontmatter.name ?? target.name;
  const existingScopes = localScopes.get(effectiveName) ?? [];
  const nameTaken = existingScopes.length > 0;
  /** 目标层会被这些更高优先级的同名技能遮蔽（安装到低层时的提示） */
  const shadowedBy = (target: SkillSaveScope) =>
    existingScopes.filter(
      // 前端尚未列出的新层垫底，不参与遮蔽比较
      (s) => (SKILL_SCOPE_RANK[s] ?? Number.MAX_SAFE_INTEGER) < SKILL_SCOPE_RANK[target],
    );
  const scopeNames = (scopes: SkillScope[]) =>
    [...new Set(scopes.map((s) => t(SKILL_SCOPE_LABEL_KEY[s])))].join("、");
  /** 安装按钮 tooltip：缺工作区 > 跨层遮蔽 > 同名 > 缺省落点说明 */
  const installTitle = (target: SkillSaveScope, fallbackKey: string): string => {
    if (target === "workspace" && !workspaceCwd) {
      return t("marketplace.skill.notSelectedWorkspace");
    }
    const shadow = shadowedBy(target);
    if (shadow.length > 0) {
      return t("marketplace.skill.shadowedHint", { scopes: scopeNames(shadow) });
    }
    if (nameTaken) return t("marketplace.skill.nameTakenHint");
    return t(fallbackKey);
  };
  /** 已武装时的按钮文字：同层同名才是"覆盖"，跨层同名只是"安装（会被遮蔽）" */
  const confirmLabel = (target: SkillSaveScope, fallbackKey: string): string =>
    overwriteArmed(target)
      ? existingScopes.includes(target)
        ? t("marketplace.skill.confirmOverwrite")
        : t("marketplace.skill.confirmInstallAnyway")
      : t(fallbackKey);
  const overwriteArmed = (scope: SkillSaveScope) =>
    nameTaken && confirmOverwrite === scope;

  const install = (scope: SkillSaveScope) => {
    if (!rawSkillMd || busyScope) return;
    if (nameTaken && confirmOverwrite !== scope) {
      setConfirmOverwrite(scope);
      return;
    }
    setBusyScope(scope);
    saveSkill({
      scope,
      cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
      viewCwd: workspaceCwd ?? undefined,
      raw: rawSkillMd,
      fallbackName: target.name,
    })
      .then(() => {
        recordGithubSkillInstall(installKey(target), effectiveName, scope);
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: t("marketplace.skill.installSuccess", {
              name: effectiveName,
            }),
            description: t("marketplace.clawhub.installDesc", {
              repo: `${target.owner}/${target.slug}`,
            }),
          });
        });
      })
      .catch((err) => toastError(t("marketplace.skill.installFailed"), err))
      .finally(() => setBusyScope(null));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="bg-muted/40 grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl">
            <ClawhubSkillIcon skill={target} className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 truncate text-xl font-semibold tracking-tight">
              <span className="truncate">{target.name}</span>
              {installed && (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {t("marketplace.common.installed")}
                </Badge>
              )}
              {!installed && nameTaken && (
                <Badge
                  variant="outline"
                  className="text-amber-700 dark:text-amber-400 shrink-0 font-normal"
                  title={t("marketplace.skill.nameTakenHint")}
                >
                  {t("marketplace.skill.localTaken")}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate">
                {target.owner}/{target.slug}
              </span>
              {target.version && (
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  v{target.version}
                </span>
              )}
              <span
                className="text-muted-foreground flex items-center gap-1 tabular-nums"
                title={t("marketplace.skill.downloads")}
              >
                <DownloadIcon className="size-3" />
                {formatCount(target.downloads)}
              </span>
              <span
                className="text-muted-foreground flex items-center gap-1 tabular-nums"
                title={t("marketplace.skill.stars")}
              >
                <StarIcon className="size-3" />
                {formatCount(target.stars)}
              </span>
              <Badge variant="secondary" className="px-1.5 py-0 text-2xs font-normal">
                {target.license}
              </Badge>
              <a
                href={target.pageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLinkIcon className="size-3" />
                {t("marketplace.clawhub.pageLink")}
              </a>
            </DialogDescription>
          </div>
        </div>

        {/* 描述条固定在头部下方，不随正文滚动——滚到多深都能看到这个技能是
            干什么的；超长描述截断，完整文本走 title */}
        {description && (
          <div className="bg-muted/50 mx-6 mb-1 shrink-0 rounded-xl px-4 py-3 text-sm leading-relaxed">
            <p className="line-clamp-3" title={description}>
              {description}
            </p>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-6 pb-2">
          {state?.status === "loading" && (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("marketplace.skill.loadingDoc")}
            </p>
          )}
          {state?.status === "error" && (
            <div className="flex flex-col items-start gap-2 py-8 text-sm">
              <p className="text-destructive">{state.text}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadTick((t) => t + 1)}
              >
                <RefreshCwIcon className="size-3.5" />
                {t("marketplace.common.retry")}
              </Button>
            </div>
          )}
          {state?.status === "ready" && (
            <SkillDocPreview raw={state.raw} title={effectiveName} />
          )}
        </div>

        {/* 工作区选择常驻：显示当前工作区，随时可改选/新建——只在未选时出现
            的话，选过一次就再也改不了 */}
        <div className="mx-6 mb-1 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5">
          <Select
            value={currentProjectId}
            items={projectItems}
            onValueChange={(value) => {
              if (value) selectProjectById(value);
            }}
          >
            <SelectTrigger className="h-8 w-56">
              <SelectValue placeholder={t("marketplace.mcp.chooseWorkspace")} />
            </SelectTrigger>
            <SelectContent>
              {activeProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <FolderOpenIcon className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {projectDisplayName(project)}
                    </span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value="__new__">
                <span className="text-muted-foreground inline-flex items-center gap-1.5">
                  <PlusIcon className="size-3.5" />
                  {t("marketplace.mcp.newWorkspace")}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
            title={workspaceCwd ?? undefined}
          >
            {workspaceCwd ?? t("marketplace.mcp.noWorkspace")}
          </span>
          {!workspaceCwd && (
            <span className="text-muted-foreground w-full text-xs">
              {t("marketplace.skill.workspaceMissingHint")}
            </span>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            ClawHub · {target.topics.slice(0, 2).join(" / ") || "MIT-0"}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {confirmOverwrite && shadowedBy(confirmOverwrite).length > 0 ? (
              <span className="text-amber-700 dark:text-amber-400 mr-1 max-w-64 text-xs leading-tight">
                {t("marketplace.skill.shadowedHint", {
                  scopes: scopeNames(shadowedBy(confirmOverwrite)),
                })}
              </span>
            ) : null}
            <Button variant="outline" onClick={onClose}>
              {t("marketplace.common.close")}
            </Button>
            {rawSkillMd && (
              <>
                <Button
                  variant={
                    overwriteArmed("workspace")
                      ? "destructive"
                      : workspaceCwd
                        ? "default"
                        : "outline"
                  }

                  disabled={!workspaceCwd || busyScope !== null}
                  title={installTitle(
                    "workspace",
                    "marketplace.skill.workspaceSaveHint",
                  )}
                  onClick={() => install("workspace")}
                >
                  {busyScope === "workspace" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
                  {confirmLabel("workspace", "marketplace.skill.installToWorkspace")}
                </Button>
                <Button
                  variant={
                    overwriteArmed("system")
                      ? "destructive"
                      : workspaceCwd
                        ? "outline"
                        : "default"
                  }

                  disabled={busyScope !== null}
                  title={installTitle("system", "marketplace.skill.systemSaveHint")}
                  onClick={() => install("system")}
                >
                  {busyScope === "system" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
                  {confirmLabel("system", "marketplace.skill.installToSystem")}
                </Button>
                <Button
                  variant={overwriteArmed("compat") ? "destructive" : "outline"}

                  disabled={busyScope !== null}
                  title={installTitle("compat", "marketplace.skill.compatSaveHint")}
                  onClick={() => install("compat")}
                >
                  {busyScope === "compat" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
                  {confirmLabel("compat", "marketplace.skill.installToCompat")}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      {/* 工作区级安装没有项目时：直接在当前弹窗里新建（嵌套弹窗强制遮罩） */}
      <WorkspaceCreateDialog
        forceOverlay
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={applyProject}
      />
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 市场主区
// ---------------------------------------------------------------------------

export const ClawhubSkillMarket: FC<{
  source: SkillSource;
  onSourceChange: (source: SkillSource) => void;
}> = ({ source, onSourceChange }) => {
  const t = useT();
  // 工作区级技能/插件/MCP 配置写入项目主目录，附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
  const skillsSnap = useSkills(workspace);
  const installRecords = useGithubSkillInstalls();

  const [sort, setSort] = useState<ClawhubSort>("downloads");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<ClawhubSkill[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detailTarget, setDetailTarget] = useState<ClawhubSkill | null>(null);

  const localScopes = useMemo(() => {
    const map = new Map<string, SkillScope[]>();
    for (const s of skillsSnap.skills) {
      const scopes = map.get(s.name);
      if (scopes) scopes.push(s.scope);
      else map.set(s.name, [s.scope]);
    }
    return map;
  }, [skillsSnap.skills]);

  /**
   * 列表接口不返回图标，只有详情接口有：按 6 路并发补齐，单条失败就保留
   * 首字母色块。图标本身在 clawhub-source 里缓存 24 小时。
   */
  const hydrateIcons = async (list: ClawhubSkill[], signal: AbortSignal) => {
    const missing = list.filter((skill) => !skill.icon);
    for (let i = 0; i < missing.length; i += 6) {
      if (signal.aborted) return;
      await Promise.all(
        missing.slice(i, i + 6).map(async (skill) => {
          try {
            const icon = await fetchClawhubSkillIcon(skill.owner, skill.slug, signal);
            if (!icon || signal.aborted) return;
            setSkills((prev) =>
              prev.map((item) =>
                item.id === skill.id ? { ...item, icon } : item,
              ),
            );
          } catch {
            // 单条图标失败不影响其它卡片
          }
        }),
      );
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(queryInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // 首屏 / 排序 / 搜索 / 手动刷新
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (query) {
          const results = await searchClawhubSkills(query, controller.signal);
          if (controller.signal.aborted) return;
          setSkills(results);
          setCursor(null);
          void hydrateIcons(results, controller.signal);
        } else {
          const page = await fetchClawhubSkills({
            sort,
            signal: controller.signal,
            force: reloadKey > 0,
          });
          if (controller.signal.aborted) return;
          setSkills(page.skills);
          setCursor(page.nextCursor);
          void hydrateIcons(page.skills, controller.signal);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setSkills([]);
        setCursor(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [query, sort, reloadKey]);

  const loadMore = async () => {
    if (!cursor || loadingMore || query) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchClawhubSkills({ sort, cursor });
      setSkills((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...page.skills.filter((s) => !seen.has(s.id))];
      });
      setCursor(page.nextCursor);
      void hydrateIcons(page.skills, new AbortController().signal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const isInstalled = (skill: ClawhubSkill): boolean => {
    const record = installRecords[installKey(skill)];
    return Boolean(record && localScopes.has(record.name));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 排序 + 源切换/刷新 */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder={t("marketplace.clawhub.searchPlaceholder")}
        ariaLabel={t("marketplace.clawhub.searchAria")}
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        refreshTitle={t("marketplace.clawhub.refreshHint")}
        source={source}
        onSourceChange={onSourceChange}
      >
        <Segmented
          value={sort}
          onChange={(value) => setSort(value)}
          options={SORT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey),
          }))}
        />
      </SkillMarketToolbar>

      {error && (
        <div className="border-border/70 bg-muted/40 mt-3 rounded-xl border px-4 py-2 text-xs leading-relaxed">
          <span className="text-muted-foreground">{error}</span>
        </div>
      )}

      {/* 列表区 */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-6">
        {loading ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            {t("marketplace.clawhub.loadingCatalog")}
          </div>
        ) : skills.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <PackageOpenIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
              </div>
            </div>
            {query
              ? t("marketplace.skill.noMatch", { query })
              : t("marketplace.clawhub.empty")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-1">
              {skills.map((skill) => (
                <ClawhubSkillCard
                  key={skill.id}
                  skill={skill}
                  installed={isInstalled(skill)}
                  onOpen={() => setDetailTarget(skill)}
                />
              ))}
            </div>
            {cursor && !query && (
              <LoadMoreSentinel
                active={!loadingMore}
                loading={loadingMore}
                onVisible={() => void loadMore()}
              />
            )}
          </>
        )}
      </div>

      <ClawhubSkillDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        installed={detailTarget ? isInstalled(detailTarget) : false}
        localScopes={localScopes}
        workspaceCwd={workspace}
      />
    </div>
  );
};
