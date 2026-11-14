"use client";

/**
 * KovaHub 技能源面板（技能段 · 源 = KovaHub，默认）。
 *
 * 目录数据来自 KovaHub（search.openkova.site，见 lib/skills/skill-market.ts）：
 * 分类条走 /api/marketplace/meta（categories.skill），搜索/排序/分页走
 * /api/marketplace?kind=skill。卡片点开详情弹窗，详情里的 SKILL.md 原文经
 * saveSkill({ raw }) 落成系统级 / 工作区级技能——与设置页「导入 Markdown」
 * 同一条管道，安装后清单自动回流，同名条目即显示已安装。
 *
 * 版式对齐插件市场：搜索/排序工具行 + 分类 chips + 卡片网格 + 底部分页。
 * 分类与关键词变化都回到第 1 页；请求以自增序号作废旧响应，只采纳最后一次。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageOpenIcon,
  RefreshCwIcon,
  StarIcon,
  PlusIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
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
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { SkillDocPreview } from "@/components/marketplace/skill-doc-preview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import type { SkillSource } from "@/components/marketplace/skill-source-select";
import { getLocale, useT } from "@/lib/i18n";
import {
  categoryToParams,
  fetchSkillMarketFiles,
  fetchSkillMarketItem,
  fetchSkillMarketList,
  fetchSkillMarketMeta,
  recordSkillMarketInstall,
  useSkillMarketInstallRecords,
  type SkillMarketCategory,
  type SkillMarketItem,
  type SkillMarketItemResponse,
  type SkillMarketListParams,
  type SkillMarketListResponse,
  type SkillMarketMeta,
  type SkillMarketSort,
} from "@/lib/skills/skill-market";

/** 每页条数：24 能被 2/3/4 列整除，网格不留孤行 */
const PER_PAGE = 24;

/** 搜索防抖 */
const SEARCH_DEBOUNCE_MS = 350;

const SORT_OPTIONS: { value: SkillMarketSort; labelKey: string }[] = [
  { value: "hot", labelKey: "marketplace.kovahub.sort.hot" },
  { value: "new", labelKey: "marketplace.kovahub.sort.new" },
  { value: "stars", labelKey: "marketplace.kovahub.sort.stars" },
  { value: "name", labelKey: "marketplace.kovahub.sort.name" },
];

const SORT_LABEL_KEY: Record<SkillMarketSort, string> = Object.fromEntries(
  SORT_OPTIONS.map((s) => [s.value, s.labelKey]),
) as Record<SkillMarketSort, string>;

/** 分类条兜底：meta 拉不到（离线/接口抖动）时至少保留「全部」可搜索 */
const FALLBACK_CATEGORIES: SkillMarketCategory[] = [
  { id: "all", name: "All", count: 0, special: true },
];

/** 127630 → 12.8万；星数与条目计数共用 */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return new Intl.NumberFormat(
    getLocale() === "zh" ? "zh-CN" : "en-US",
    { notation: "compact", maximumFractionDigits: 1 },
  ).format(n);
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US");
}

/** 从 SKILL.md 原文解析 frontmatter 的 name：这才是落盘技能的真名，可能与市场条目名不同 */
function parseFrontmatterName(raw: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  if (!block) return null;
  const line = block.split(/\r?\n/).find((l) => /^name:\s*/.test(l));
  if (!line) return null;
  const value = line
    .replace(/^name:\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
  return value || null;
}

/** 无功能性的附属文件：为它们提示「一键安装带不走」只是噪音 */
const AUX_FILE_IGNORE =
  /^(LICENSE|README|NOTICE|CONTRIBUTING)(\..*)?$|\.gitignore$|\.md$/i;

/**
 * 页码窗口：首尾页恒在，当前页 ±1，边角补齐，缺口画省略号。
 * 「全部」分类下有 8k+ 页，必须折叠；7 页以内直接全排。
 */
function pageWindow(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const wanted = new Set<number>(
    [1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages),
  );
  // 贴边时多铺两格，避免出现 1 … 3 这类只有两格间隙的双省略号
  for (let p = Math.max(1, page - 3); p <= Math.min(totalPages, page + 3); p += 1) {
    if (page <= 3 || page >= totalPages - 2) wanted.add(p);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

function toastError(title: string, err: unknown): void {
  void import("@/components/ui/toast").then(({ toast }) => {
    toast.error({ title, description: err instanceof Error ? err.message : String(err) });
  });
}

// ---------------------------------------------------------------------------
// 技能卡片
// ---------------------------------------------------------------------------

const SkillMarketCard: FC<{
  item: SkillMarketItem;
  installed: boolean;
  onOpen: () => void;
}> = ({ item, installed, onOpen }) => {
  const t = useT();
  const description = item.description_zh || item.description_en || "";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("marketplace.skill.openAria", { name: item.name })}
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
        <PluginIcon src={item.logo ?? undefined} name={item.name} className="text-lg" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.featured && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              {t("marketplace.kovahub.featured")}
            </Badge>
          )}
          {installed && (
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 text-2xs font-normal"
              title={t("marketplace.skill.installedHint")}
            >
              {t("marketplace.common.installed")}
            </Badge>
          )}
        </div>
        <p
          className="text-muted-foreground mt-0.5 truncate text-xs leading-5"
          title={description}
        >
          {description || t("marketplace.mcp.noDescription")}
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 详情弹窗（取详情 + 预览 + 安装）
// ---------------------------------------------------------------------------

type DetailState =
  | { status: "loading" }
  | { status: "ready"; item: SkillMarketItemResponse }
  | { status: "error"; text: string };

const SkillMarketDetailDialog: FC<{
  target: SkillMarketItem | null;
  onClose: () => void;
  /** 本机已通过市场安装过该条目（source_id 精确匹配） */
  installed: boolean;
  /** 本地同名技能的作用域集合：覆盖确认、跨层遮蔽提示按 frontmatter 真名比对 */
  localScopes: ReadonlyMap<string, SkillScope[]>;
  workspaceCwd: string | null;
}> = ({ target, onClose, installed, localScopes, workspaceCwd }) => {
  const t = useT();
  const [state, setState] = useState<DetailState | null>(null);
  const [busyScope, setBusyScope] = useState<SkillSaveScope | null>(null);
  /** 同名覆盖的两步确认：第一次点击只武装对应按钮，再点才真正写盘 */
  const [confirmOverwrite, setConfirmOverwrite] = useState<SkillSaveScope | null>(null);
  /** 详情拉取失败后的重试键 */
  const [reloadTick, setReloadTick] = useState(0);

  // 换目标重置并取详情；AbortController 防快速切换时的竞态
  useEffect(() => {
    setBusyScope(null);
    setConfirmOverwrite(null);
    if (!target) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchSkillMarketItem(target.id, controller.signal)
      .then((item) => setState({ status: "ready", item }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", text: err instanceof Error ? err.message : String(err) });
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
  const description = target.description_zh || target.description_en || "";
  const detail = state?.status === "ready" ? state.item.detail : null;
  const rawSkillMd = detail?.skill_md?.content ?? null;
  /** 实际落盘的技能名：frontmatter name 优先，缺失时 sidecar 用 fallbackName（市场名）兜底 */
  const effectiveName =
    (rawSkillMd ? parseFrontmatterName(rawSkillMd) : null) ?? target.name;
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
  /** SKILL.md 之外的附属文件：一键安装带不走，正文引用这些文件时技能会是坏的 */
  const auxFiles = (detail?.files ?? []).filter(
    (f) => f !== "SKILL.md" && !AUX_FILE_IGNORE.test(f),
  );
  const overwriteArmed = (scope: SkillSaveScope) =>
    nameTaken && confirmOverwrite === scope;

  const install = (scope: SkillSaveScope) => {
    if (!rawSkillMd || busyScope) return;
    // 本地已有同名技能：第一次点击只确认覆盖意图，再点才写
    if (nameTaken && confirmOverwrite !== scope) {
      setConfirmOverwrite(scope);
      return;
    }
    setBusyScope(scope);
    // 有附属文件时先取文件包（Worker 抓仓库直链）；接口失败不挡安装——回落单文件并在通知里说明
    const withFiles: Promise<{ files: { path: string; content: string }[]; skipped: { path: string; reason: string }[] } | null> =
      auxFiles.length ? fetchSkillMarketFiles(target.id).catch(() => null) : Promise.resolve({ files: [], skipped: [] });
    withFiles
      .then(async (bundleOrNull) => {
        const bundle = bundleOrNull ?? { files: [], skipped: [] };
        const filesFailed = bundleOrNull === null;
        await saveSkill({
          scope,
          cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
          viewCwd: workspaceCwd ?? undefined,
          raw: rawSkillMd,
          fallbackName: target.name,
          ...(bundle.files.length ? { files: bundle.files } : {}),
        });
        // 记录 source_id + 落盘真名：徽标精确匹配的依据（名字可能撞车，id 不会；
        // 名字用 frontmatter 解析值，市场条目名可能与真名不一致）
        recordSkillMarketInstall(target.id, effectiveName, scope);
        const notes = [
          scope === "workspace"
            ? t("marketplace.kovahub.noteWorkspace", {
                cwd: workspaceCwd ?? "",
              })
            : scope === "compat"
              ? t("marketplace.kovahub.noteCompat")
              : t("marketplace.kovahub.noteSystem"),
        ];
        if (bundle.files.length)
          notes.push(
            t("marketplace.kovahub.noteFiles", { count: bundle.files.length }),
          );
        if (bundle.skipped.length)
          notes.push(
            t("marketplace.kovahub.noteSkipped", {
              count: bundle.skipped.length,
            }),
          );
        if (filesFailed) notes.push(t("marketplace.kovahub.noteFilesFailed"));
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: t("marketplace.skill.installSuccess", {
              name: effectiveName,
            }),
            description: notes.join(" · "),
          });
        });
      })
      .catch((err) => toastError(t("marketplace.skill.installFailed"), err))
      .finally(() => setBusyScope(null));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {/* 头部：图标 + 名称 + 来源行 */}
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="bg-background grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl">
            <PluginIcon src={target.logo ?? undefined} name={target.name} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 truncate text-xl font-semibold tracking-tight">
              <span className="truncate">{target.name}</span>
              {installed && (
                <Badge
                  variant="outline"
                  className="shrink-0 font-normal"
                  title={t("marketplace.skill.installedHint")}
                >
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
                {target.owner}/{target.repo}
              </span>
              <span className="text-muted-foreground flex items-center gap-1 tabular-nums">
                <StarIcon className="size-3" />
                {formatCount(target.stars)}
              </span>
              {target.categories.map((c) => (
                <Badge key={c} variant="secondary" className="px-1.5 py-0 text-2xs font-normal">
                  {c}
                </Badge>
              ))}
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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-6 pb-2">
          {state?.status === "loading" && (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("marketplace.kovahub.detailLoading")}
            </p>
          )}
          {state?.status === "error" && (
            <div className="flex flex-col items-start gap-2 py-8 text-sm">
              <p className="text-destructive">{state.text}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadTick((tick) => tick + 1)}
              >
                <RefreshCwIcon className="size-3.5" />
                {t("marketplace.common.retry")}
              </Button>
            </div>
          )}
          {state?.status === "ready" && (
            <>
              {auxFiles.length > 0 && (
                <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex flex-col gap-1 rounded-xl border px-4 py-3 text-xs leading-relaxed">
                  <span>
                    {t("marketplace.kovahub.auxFiles", {
                      count: auxFiles.length,
                      files: auxFiles.slice(0, 3).join(
                        t("marketplace.mcp.headerSeparator"),
                      ),
                      more:
                        auxFiles.length > 3
                          ? t("marketplace.kovahub.auxMore")
                          : "",
                    })}
                  </span>
                  <a
                    className="inline-flex items-center gap-1 self-start underline underline-offset-2"
                    href={target.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLinkIcon className="size-3" />
                    {t("marketplace.kovahub.openRepo")}
                  </a>
                </div>
              )}
              {rawSkillMd ? (
                <SkillDocPreview raw={rawSkillMd} title={effectiveName} />
              ) : (
                <div className="text-muted-foreground flex flex-col items-start gap-2 py-8 text-sm">
                  <p>{t("marketplace.kovahub.noSkillMd")}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    render={
                      <a href={target.url} target="_blank" rel="noreferrer" />
                    }
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    {t("marketplace.kovahub.goRepo")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 页脚：更新时间 + 关闭/安装（安装写入与导入同一条 saveSkill 管道） */}
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
            {t("marketplace.kovahub.updatedAt", {
              date: formatDate(target.source_updated_at),
            })}
            {detail?.token_count
              ? t("marketplace.kovahub.tokenCount", {
                  count: formatCount(detail.token_count),
                })
              : ""}
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
                  {busyScope === "workspace" && <Loader2Icon className="size-3.5 animate-spin" />}
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
                  {busyScope === "system" && <Loader2Icon className="size-3.5 animate-spin" />}
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

export const KovahubSkillMarket: FC<{
  source: SkillSource;
  onSourceChange: (next: SkillSource) => void;
}> = ({ source, onSourceChange }) => {
  const t = useT();
  // 工作区级技能/插件/MCP 配置写入项目主目录，附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
  const skillsSnap = useSkills(workspace);
  const localScopes = useMemo(() => {
    const map = new Map<string, SkillScope[]>();
    for (const s of skillsSnap.skills) {
      const scopes = map.get(s.name);
      if (scopes) scopes.push(s.scope);
      else map.set(s.name, [s.scope]);
    }
    return map;
  }, [skillsSnap.skills]);
  const installRecords = useSkillMarketInstallRecords();
  /** 市场口径的「已安装」：本机装过该 source_id，且本地仍存在同名技能
   *  （记录按名称比对存在性，设置页删掉后徽标自然消失） */
  const isMarketInstalled = (item: SkillMarketItem): boolean => {
    const record = installRecords[item.id];
    if (!record) return false;
    return skillsSnap.skills.some((s) => s.name === record.name);
  };

  // 分类字典（挂载时取一次；失败回落「全部」，搜索仍可用）
  const [meta, setMeta] = useState<SkillMarketMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const categories = meta?.categories.skill?.length
    ? meta.categories.skill
    : FALLBACK_CATEGORIES;

  // 列表筛选态
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SkillMarketSort>("hot");
  const [page, setPage] = useState(1);
  /** 刷新键：自增即重发当前筛选（避免把取数逻辑复制进 refresh 回调） */
  const [reloadKey, setReloadKey] = useState(0);

  // 列表数据 + 在途/错误态
  const [list, setList] = useState<SkillMarketListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 详情弹窗目标：存列表条目（详情按需另取） */
  const [detailTarget, setDetailTarget] = useState<SkillMarketItem | null>(null);
  /** 跳页输入的草稿（null = 未在编辑，显示当前页码） */
  const [jumpDraft, setJumpDraft] = useState<string | null>(null);
  const requestSeq = useRef(0);
  /** 列表滚动容器：翻页/切分类后回到顶部，避免停在上一次的滚动位置 */
  const listScrollRef = useRef<HTMLDivElement | null>(null);

  // 搜索防抖：输入停止后才真正发请求
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // 筛选变化回到第 1 页（query 经防抖后再触发）
  useEffect(() => {
    setPage(1);
  }, [query, category, sort]);

  // 翻页/换筛选后列表回到顶部
  useEffect(() => {
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [page, query, category, sort]);

  // 分类字典：挂载取一次（计数随上游同步漂移，刷新键也顺带重取）
  useEffect(() => {
    const controller = new AbortController();
    fetchSkillMarketMeta(controller.signal)
      .then((m) => {
        setMeta(m);
        setMetaError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setMetaError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  // 列表：筛选或页码变化即取（序号作废旧响应，只采纳最后一次）
  useEffect(() => {
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setLoading(true);
    // 分类 id → API 参数（全部=无参，精选=featured，其余=真实标签）；
    // 分类字典本身不进依赖：id 未变时不因 meta 到手而重发
    const cat = categories.find((c) => c.id === category) ?? null;
    const params: SkillMarketListParams = {
      q: query || undefined,
      ...categoryToParams(cat),
      sort,
      page,
      per_page: PER_PAGE,
    };
    fetchSkillMarketList(params, controller.signal)
      .then((res) => {
        if (seq !== requestSeq.current) return;
        setList(res);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categories 只按 id 消费，见上
  }, [query, category, sort, page, reloadKey]);

  const items = list?.items ?? [];
  const totalPages = list?.total_pages ?? 1;

  /** 跳页提交：非法输入静默还原为当前页（totalPages 声明在其上，闭包取当帧值） */
  const commitJump = () => {
    if (jumpDraft === null) return;
    const n = parseInt(jumpDraft, 10);
    setJumpDraft(null);
    if (!Number.isNaN(n) && n >= 1 && n <= totalPages) setPage(n);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 排序 + 源切换/刷新（对齐插件段「市场目录」工具行位置） */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder={t("marketplace.skill.searchPlaceholder")}
        ariaLabel={t("marketplace.kovahub.searchAria")}
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        source={source}
        onSourceChange={onSourceChange}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"

                className="text-muted-foreground h-8 gap-1 text-xs"
                title={t("marketplace.kovahub.sortMenu")}
              />
            }
          >
            {t(SORT_LABEL_KEY[sort])}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-32">
            {/* Base UI：MenuGroupLabel 必须在 Menu.Group 内，否则渲染即抛 error #31 */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                {t("marketplace.kovahub.sortLabel")}
              </DropdownMenuLabel>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setSort(option.value)}>
                  {t(option.labelKey)}
                  {sort === option.value && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SkillMarketToolbar>

      {/* 分类条：横向滚动 chips；meta 失败时只留「全部」 */}
      <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
        {categories.map((c) => {
          const active = c.id === category;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={active}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors",
                active
                  ? "bg-foreground text-background border-transparent"
                  : "hover:bg-muted text-muted-foreground",
              )}
            >
              {c.id === "all" ? t("marketplace.kovahub.allCategory") : c.name}
            </button>
          );
        })}
        {metaError && (
          <span className="text-muted-foreground/70 ml-1 shrink-0 text-xs">
            {t("marketplace.kovahub.metaFailed")}
          </span>
        )}
      </div>

      {/* 列表区：底部留出余量，末行卡片不与分页条贴面 */}
      <div ref={listScrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-6">
        {loading && items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            {t("marketplace.kovahub.loadingCatalog")}
          </div>
        ) : error && items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            {t("marketplace.kovahub.catalogFailed", { error })}
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            {/* 无结果/空分类与搜索页同一套点阵云 */}
            <div className="relative mb-1 grid place-items-center">
              <DotCloud />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <PackageOpenIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
              </div>
            </div>
            {query
              ? t("marketplace.skill.noMatch", { query })
              : t("marketplace.kovahub.emptyCategory")}
          </div>
        ) : (
          <div
            className={cn(
              "grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-1 transition-opacity",
              loading && "pointer-events-none opacity-50",
            )}
          >
            {items.map((item) => (
              <SkillMarketCard
                key={item.id}
                item={item}
                installed={isMarketInstalled(item)}
                onOpen={() => setDetailTarget(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 分页：页脚条 —— 发丝线与列表区分隔，上下留白，不再贴着卡片和窗口边。
          页码窗口（首尾页恒在 + 当前页 ±1，缺口省略号）+ 跳页输入；
          「全部」分类下 8k+ 页，只有上一页/下一页没法用，跳页输入是主路径 */}
      {items.length > 0 && totalPages > 1 && (
        <div className="border-border/70 flex shrink-0 flex-wrap items-center justify-center gap-x-1 gap-y-2 border-t px-2 pt-3 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeftIcon className="size-3.5" />
            {t("marketplace.kovahub.prevPage")}
          </Button>
          <div className="mx-1 flex items-center gap-0.5">
            {pageWindow(page, totalPages).map((p, i) =>
              p === "…" ? (
                <span key={`gap-${i}`} className="text-muted-foreground px-1 text-xs select-none">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  aria-current={p === page ? "page" : undefined}
                  className={cn(
                    "grid h-7 min-w-7 cursor-pointer place-items-center rounded-lg px-1.5 text-xs tabular-nums transition-colors",
                    p === page
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ),
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t("marketplace.kovahub.nextPage")}
            <ChevronRightIcon className="size-3.5" />
          </Button>
          {/* 跳页：输入页码回车直达；失焦未提交则还原为当前页 */}
          <div className="text-muted-foreground ml-3 flex items-center gap-1.5 text-xs">
            <span>{t("marketplace.kovahub.jumpTo")}</span>
            <Input
              className="bg-muted/50 h-7 w-14 px-2 text-center text-xs tabular-nums"
              inputMode="numeric"
              value={jumpDraft ?? String(page)}
              onChange={(e) => setJumpDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
              onBlur={commitJump}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitJump();
              }}
              aria-label={t("marketplace.kovahub.jumpAria")}
            />
            <span>{t("marketplace.kovahub.totalPages", { count: formatCount(totalPages) })}</span>
          </div>
        </div>
      )}

      <SkillMarketDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        installed={detailTarget ? isMarketInstalled(detailTarget) : false}
        localScopes={localScopes}
        workspaceCwd={workspace}
      />
    </div>
  );
};
