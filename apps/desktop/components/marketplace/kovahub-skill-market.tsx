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
  Loader2Icon,
  PackageOpenIcon,
  RefreshCwIcon,
  StarIcon,
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
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { saveSkill, useSkills } from "@/lib/skills/skills";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
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

/** 展示用去掉 frontmatter（安装仍用原文，frontmatter 由 sidecar 解析） */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
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
      className="bg-background hover:bg-muted/40 hover:border-foreground/15 flex cursor-pointer flex-col rounded-2xl border p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {/* 标题行：图标 + 名称 + 星数 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="bg-muted/40 grid size-8 shrink-0 place-items-center overflow-hidden rounded-xl">
          <PluginIcon src={item.logo ?? undefined} name={item.name} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.featured && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              {t("marketplace.kovahub.featured")}
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs tabular-nums">
          <StarIcon className="size-3" />
          {formatCount(item.stars)}
        </span>
      </div>
      {/* 描述封顶两行；min-h 撑住短描述，网格行高不参差 */}
      <p className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5" title={description}>
        {description || t("marketplace.mcp.noDescription")}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground/70 min-w-0 truncate text-xs">
          {item.owner}/{item.repo}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {installed && (
            <Badge
              variant="outline"
              className="gap-1 font-normal"
              title={t("marketplace.skill.installedHint")}
            >
              {t("marketplace.common.installed")}
            </Badge>
          )}
          {item.categories.slice(0, 2).map((c) => (
            <Badge key={c} variant="secondary" className="px-1.5 text-2xs font-normal">
              {c}
            </Badge>
          ))}
        </div>
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

/** SKILL.md 正文预览：Streamdown 是重依赖，点开详情才异步拉取 */
const MarketSkillDocPreview: FC<{ raw: string }> = ({ raw }) => {
  const t = useT();
  const [view, setView] = useState<
    | { status: "loading" }
    | { status: "ready"; MarkdownText: FC<{ text: string }> }
    | { status: "error" }
  >({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void import("@/components/assistant-ui/elements/markdown-text")
      .then((m) => {
        if (!cancelled) setView({ status: "ready", MarkdownText: m.MarkdownText });
      })
      .catch(() => {
        if (!cancelled) setView({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const content = stripFrontmatter(raw);
  return (
    <div className="min-h-0 flex-1 rounded-2xl border p-5">
      {view.status === "loading" && (
        <p className="text-muted-foreground text-sm">
          {t("marketplace.doc.loading")}
        </p>
      )}
      {view.status === "error" && (
        <pre className="font-mono text-xs whitespace-pre-wrap">{content}</pre>
      )}
      {view.status === "ready" && <view.MarkdownText text={content} />}
    </div>
  );
};

const SkillMarketDetailDialog: FC<{
  target: SkillMarketItem | null;
  onClose: () => void;
  /** 本机已通过市场安装过该条目（source_id 精确匹配） */
  installed: boolean;
  /** 本地技能名清单：覆盖确认与「本地同名」徽标按 frontmatter 真名比对 */
  localNames: ReadonlySet<string>;
  workspaceCwd: string | null;
}> = ({ target, onClose, installed, localNames, workspaceCwd }) => {
  const t = useT();
  const [state, setState] = useState<DetailState | null>(null);
  const [busyScope, setBusyScope] = useState<"system" | "workspace" | null>(null);
  /** 同名覆盖的两步确认：第一次点击只武装对应按钮，再点才真正写盘 */
  const [confirmOverwrite, setConfirmOverwrite] = useState<"system" | "workspace" | null>(null);
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

  if (!target) return null;
  const description = target.description_zh || target.description_en || "";
  const detail = state?.status === "ready" ? state.item.detail : null;
  const rawSkillMd = detail?.skill_md?.content ?? null;
  /** 实际落盘的技能名：frontmatter name 优先，缺失时 sidecar 用 fallbackName（市场名）兜底 */
  const effectiveName =
    (rawSkillMd ? parseFrontmatterName(rawSkillMd) : null) ?? target.name;
  const nameTaken = localNames.has(effectiveName);
  /** SKILL.md 之外的附属文件：一键安装带不走，正文引用这些文件时技能会是坏的 */
  const auxFiles = (detail?.files ?? []).filter(
    (f) => f !== "SKILL.md" && !AUX_FILE_IGNORE.test(f),
  );
  const overwriteArmed = (scope: "system" | "workspace") =>
    nameTaken && confirmOverwrite === scope;

  const install = (scope: "system" | "workspace") => {
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
          raw: rawSkillMd,
          fallbackName: target.name,
          ...(bundle.files.length ? { files: bundle.files } : {}),
        });
        // 记录 source_id + 落盘真名：徽标精确匹配的依据（名字可能撞车，id 不会；
        // 名字用 frontmatter 解析值，市场条目名可能与真名不一致）
        recordSkillMarketInstall(target.id, effectiveName, scope);
        const notes = [
          scope === "workspace"
            ? t("marketplace.kovahub.noteWorkspace")
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

        {/* 正文：描述条 + SKILL.md 预览 */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-2">
          {description && (
            <div className="bg-muted/50 shrink-0 rounded-xl px-4 py-3 text-sm leading-relaxed">
              {description}
            </div>
          )}
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
                <MarketSkillDocPreview raw={rawSkillMd} />
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("marketplace.common.close")}
            </Button>
            {rawSkillMd && (
              <>
                <Button
                  variant={overwriteArmed("workspace") ? "destructive" : "outline"}
                  size="sm"
                  disabled={!workspaceCwd || busyScope !== null}
                  title={
                    !workspaceCwd
                      ? t("marketplace.skill.notSelectedWorkspace")
                      : nameTaken
                        ? t("marketplace.skill.nameTakenHint")
                        : t("marketplace.skill.workspaceSaveHint")
                  }
                  onClick={() => install("workspace")}
                >
                  {busyScope === "workspace" && <Loader2Icon className="size-3.5 animate-spin" />}
                  {overwriteArmed("workspace")
                    ? t("marketplace.skill.confirmOverwrite")
                    : t("marketplace.skill.installToWorkspace")}
                </Button>
                <Button
                  variant={overwriteArmed("system") ? "destructive" : "default"}
                  size="sm"
                  disabled={busyScope !== null}
                  title={
                    nameTaken
                      ? t("marketplace.skill.nameTakenHint")
                      : t("marketplace.skill.systemSaveHint")
                  }
                  onClick={() => install("system")}
                >
                  {busyScope === "system" && <Loader2Icon className="size-3.5 animate-spin" />}
                  {overwriteArmed("system")
                    ? t("marketplace.skill.confirmOverwrite")
                    : t("marketplace.skill.installToSystem")}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
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
  const workspace = useWorkspace();
  const skillsSnap = useSkills(workspace);
  const installedNames = useMemo(
    () => new Set(skillsSnap.skills.map((s) => s.name)),
    [skillsSnap.skills],
  );
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
                size="sm"
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
      <div ref={listScrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
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
              "grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3 transition-opacity",
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
        localNames={installedNames}
        workspaceCwd={workspace}
      />
    </div>
  );
};
