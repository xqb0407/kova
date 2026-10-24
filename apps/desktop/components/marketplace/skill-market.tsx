"use client";

/**
 * 技能市场（插件/专家/技能 → 技能段主区）。
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
  SearchIcon,
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { saveSkill, useSkills } from "@/lib/skills/skills";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
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

const SORT_OPTIONS: { value: SkillMarketSort; label: string }[] = [
  { value: "hot", label: "最热" },
  { value: "new", label: "最新" },
  { value: "stars", label: "星标最多" },
  { value: "name", label: "名称" },
];

const SORT_LABEL: Record<SkillMarketSort, string> = Object.fromEntries(
  SORT_OPTIONS.map((s) => [s.value, s.label]),
) as Record<SkillMarketSort, string>;

/** 分类条兜底：meta 拉不到（离线/接口抖动）时至少保留「全部」可搜索 */
const FALLBACK_CATEGORIES: SkillMarketCategory[] = [
  { id: "all", name: "全部", count: 0, special: true },
];

/** 127630 → 12.8万；星数与条目计数共用 */
function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
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
  const description = item.description_zh || item.description_en || "";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看技能 ${item.name} 详情`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title="点击查看技能详情"
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
            <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] font-normal">
              精选
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
        {description || "暂无描述"}
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
              title="已通过技能市场安装（本机记录）"
            >
              已安装
            </Badge>
          )}
          {item.categories.slice(0, 2).map((c) => (
            <Badge key={c} variant="secondary" className="px-1.5 text-[10px] font-normal">
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
        <p className="text-muted-foreground text-sm">正文加载中…</p>
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
          scope === "workspace" ? "保存到工作区 .kova/skills/" : "保存到系统技能目录",
        ];
        if (bundle.files.length) notes.push(`含 ${bundle.files.length} 个附属文件`);
        if (bundle.skipped.length)
          notes.push(`${bundle.skipped.length} 个文件被跳过（二进制/超限）`);
        if (filesFailed) notes.push("附属文件获取失败，仅安装了 SKILL.md");
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: `已安装「${effectiveName}」`,
            description: notes.join(" · "),
          });
        });
      })
      .catch((err) => toastError("安装技能失败", err))
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
                  title="已通过技能市场安装（本机记录）"
                >
                  已安装
                </Badge>
              )}
              {!installed && nameTaken && (
                <Badge
                  variant="outline"
                  className="text-amber-700 dark:text-amber-400 shrink-0 font-normal"
                  title="本地已有同名技能，安装将覆盖同名文件"
                >
                  本地同名
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate">
                {target.owner}/{target.repo}
              </span>
              <span className="text-muted-foreground/60 flex items-center gap-1 tabular-nums">
                <StarIcon className="size-3" />
                {formatCount(target.stars)}
              </span>
              {target.categories.map((c) => (
                <Badge key={c} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
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
              正在获取技能详情…
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
                重试
              </Button>
            </div>
          )}
          {state?.status === "ready" && (
            <>
              {auxFiles.length > 0 && (
                <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex flex-col gap-1 rounded-xl border px-4 py-3 text-xs leading-relaxed">
                  <span>
                    该技能还包含 {auxFiles.length} 个附属文件（
                    {auxFiles.slice(0, 3).join("、")}
                    {auxFiles.length > 3 ? " 等" : ""}）。安装时会从仓库一并获取，
                    与 SKILL.md 同目录落盘（目录式技能）；二进制或超限文件会跳过并在安装通知中说明。
                  </span>
                  <a
                    className="inline-flex items-center gap-1 self-start underline underline-offset-2"
                    href={target.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLinkIcon className="size-3" />
                    打开仓库
                  </a>
                </div>
              )}
              {rawSkillMd ? (
                <MarketSkillDocPreview raw={rawSkillMd} />
              ) : (
                <div className="text-muted-foreground flex flex-col items-start gap-2 py-8 text-sm">
                  <p>未能获取 SKILL.md 内容，暂时无法一键安装。</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    render={
                      <a href={target.url} target="_blank" rel="noreferrer" />
                    }
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    前往仓库查看
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 页脚：更新时间 + 关闭/安装（安装写入与导入同一条 saveSkill 管道） */}
        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            更新于 {formatDate(target.source_updated_at)}
            {detail?.token_count ? ` · 约 ${formatCount(detail.token_count)} tokens` : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              关闭
            </Button>
            {rawSkillMd && (
              <>
                <Button
                  variant={overwriteArmed("workspace") ? "destructive" : "outline"}
                  size="sm"
                  disabled={!workspaceCwd || busyScope !== null}
                  title={
                    !workspaceCwd
                      ? "未选择工作区"
                      : nameTaken
                        ? "本地已有同名技能，安装将覆盖同名文件"
                        : "保存到当前工作区 .kova/skills/，随仓库共享"
                  }
                  onClick={() => install("workspace")}
                >
                  {busyScope === "workspace" && <Loader2Icon className="size-3.5 animate-spin" />}
                  {overwriteArmed("workspace") ? "确认覆盖同名" : "安装到工作区"}
                </Button>
                <Button
                  variant={overwriteArmed("system") ? "destructive" : "default"}
                  size="sm"
                  disabled={busyScope !== null}
                  title={
                    nameTaken
                      ? "本地已有同名技能，安装将覆盖同名文件"
                      : "保存到应用数据目录 skills/，本机全局生效"
                  }
                  onClick={() => install("system")}
                >
                  {busyScope === "system" && <Loader2Icon className="size-3.5 animate-spin" />}
                  {overwriteArmed("system") ? "确认覆盖同名" : "安装到系统"}
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

export const SkillMarket: FC = () => {
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
      {/* 工具行：搜索 + 计数 + 排序/刷新（对齐插件段「市场目录」工具行位置） */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            className="bg-muted/50 h-8 w-64 pl-8"
            placeholder="搜索技能名称 / 描述…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1 text-xs"
                  title="排序方式"
                />
              }
            >
              {SORT_LABEL[sort]}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                排序
              </DropdownMenuLabel>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setSort(option.value)}>
                  {option.label}
                  {sort === option.value && <span className="ml-auto text-xs">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8"
            disabled={loading}
            onClick={() => setReloadKey((k) => k + 1)}
            aria-label="刷新"
            title="刷新目录"
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

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
              {c.name}
            </button>
          );
        })}
        {metaError && (
          <span className="text-muted-foreground/70 ml-1 shrink-0 text-xs">
            分类加载失败，仅可搜索
          </span>
        )}
      </div>

      {/* 列表区：底部留出余量，末行卡片不与分页条贴面 */}
      <div ref={listScrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading && items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            正在加载技能目录…
          </div>
        ) : error && items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            目录加载失败：{error}
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            {query ? `没有匹配「${query}」的技能。` : "该分类下暂无技能。"}
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
            上一页
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
            下一页
            <ChevronRightIcon className="size-3.5" />
          </Button>
          {/* 跳页：输入页码回车直达；失焦未提交则还原为当前页 */}
          <div className="text-muted-foreground ml-3 flex items-center gap-1.5 text-xs">
            <span>跳至</span>
            <Input
              className="bg-muted/50 h-7 w-14 px-2 text-center text-xs tabular-nums"
              inputMode="numeric"
              value={jumpDraft ?? String(page)}
              onChange={(e) => setJumpDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
              onBlur={commitJump}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitJump();
              }}
              aria-label="跳转页码"
            />
            <span>/ {formatCount(totalPages)} 页</span>
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
