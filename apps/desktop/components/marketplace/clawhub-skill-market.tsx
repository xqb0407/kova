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
  Loader2Icon,
  PackageOpenIcon,
  RefreshCwIcon,
  StarIcon,
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
import { SkillDocPreview } from "@/components/marketplace/skill-doc-preview";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { saveSkill, useSkills } from "@/lib/skills/skills";
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

const SEARCH_DEBOUNCE_MS = 300;

const SORT_OPTIONS: { value: ClawhubSort; label: string }[] = [
  { value: "downloads", label: "下载最多" },
  { value: "stars", label: "星标最高" },
  { value: "createdAt", label: "最新" },
  { value: "recommended", label: "推荐" },
];

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
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
        className={cn("size-4", className)}
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
}> = ({ skill, installed, onOpen }) => (
  <div
    role="button"
    tabIndex={0}
    aria-label={`查看技能 ${skill.name} 详情`}
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
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="bg-muted/40 grid size-8 shrink-0 place-items-center overflow-hidden rounded-xl">
        <ClawhubSkillIcon skill={skill} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{skill.name}</span>
        {installed && (
          <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
            已安装
          </Badge>
        )}
      </div>
      {skill.version && (
        <span className="text-muted-foreground shrink-0 font-mono text-2xs tabular-nums">
          v{skill.version}
        </span>
      )}
    </div>

    <p
      className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5"
      title={skill.summary}
    >
      {skill.summary || "暂无描述，点击查看正文"}
    </p>

    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-muted-foreground min-w-0 truncate text-xs">
        {skill.owner}/{skill.slug}
      </span>
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums"
          title="下载量"
        >
          <DownloadIcon className="size-3" />
          {formatCount(skill.downloads)}
        </span>
        <span
          className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums"
          title="星标数"
        >
          <StarIcon className="size-3" />
          {formatCount(skill.stars)}
        </span>
        <Badge
          variant="outline"
          className="px-1.5 text-2xs font-normal"
          title="ClawHub 技能统一按 MIT-0 发布：可商用、可再分发"
        >
          {skill.license}
        </Badge>
      </div>
    </div>
  </div>
);

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
  localNames: ReadonlySet<string>;
  workspaceCwd: string | null;
}> = ({ target, onClose, installed, localNames, workspaceCwd }) => {
  const [state, setState] = useState<DetailState | null>(null);
  const [busyScope, setBusyScope] = useState<"system" | "workspace" | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<
    "system" | "workspace" | null
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

  if (!target) return null;

  const rawSkillMd = state?.status === "ready" ? state.raw : null;
  const frontmatter = rawSkillMd
    ? parseSkillFrontmatter(rawSkillMd)
    : { name: null, description: null };
  const description = frontmatter.description || target.summary;
  const effectiveName = frontmatter.name ?? target.name;
  const nameTaken = localNames.has(effectiveName);
  const overwriteArmed = (scope: "system" | "workspace") =>
    nameTaken && confirmOverwrite === scope;

  const install = (scope: "system" | "workspace") => {
    if (!rawSkillMd || busyScope) return;
    if (nameTaken && confirmOverwrite !== scope) {
      setConfirmOverwrite(scope);
      return;
    }
    setBusyScope(scope);
    saveSkill({
      scope,
      cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
      raw: rawSkillMd,
      fallbackName: target.name,
    })
      .then(() => {
        recordGithubSkillInstall(installKey(target), effectiveName, scope);
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: `已安装「${effectiveName}」`,
            description: `来源 ClawHub · ${target.owner}/${target.slug} · MIT-0`,
          });
        });
      })
      .catch((err) => toastError("安装技能失败", err))
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
                {target.owner}/{target.slug}
              </span>
              {target.version && (
                <span className="text-muted-foreground font-mono text-xs tabular-nums">
                  v{target.version}
                </span>
              )}
              <span
                className="text-muted-foreground flex items-center gap-1 tabular-nums"
                title="下载量"
              >
                <DownloadIcon className="size-3" />
                {formatCount(target.downloads)}
              </span>
              <span
                className="text-muted-foreground flex items-center gap-1 tabular-nums"
                title="星标数"
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
                ClawHub 页面
              </a>
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-2">
          {description && (
            <div className="bg-muted/50 shrink-0 rounded-xl px-4 py-3 text-sm leading-relaxed">
              {description}
            </div>
          )}

          {state?.status === "loading" && (
            <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              正在获取 SKILL.md…
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
          {state?.status === "ready" && <SkillDocPreview raw={state.raw} />}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            ClawHub · {target.topics.slice(0, 2).join(" / ") || "MIT-0"}
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
                  {busyScope === "workspace" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
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
                  {busyScope === "system" && (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  )}
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

export const ClawhubSkillMarket: FC<{
  source: SkillSource;
  onSourceChange: (source: SkillSource) => void;
}> = ({ source, onSourceChange }) => {
  const workspace = useWorkspace();
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

  const localNames = useMemo(
    () => new Set(skillsSnap.skills.map((s) => s.name)),
    [skillsSnap.skills],
  );

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
    return Boolean(record && localNames.has(record.name));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 排序 + 源切换/刷新 */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder="搜索 ClawHub 技能…"
        ariaLabel="搜索 ClawHub 技能"
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        refreshTitle="重新读取 ClawHub 目录"
        source={source}
        onSourceChange={onSourceChange}
      >
        <Segmented
          value={sort}
          onChange={(value) => setSort(value)}
          options={SORT_OPTIONS}
        />
      </SkillMarketToolbar>

      {error && (
        <div className="border-border/70 bg-muted/40 mt-3 rounded-xl border px-4 py-2 text-xs leading-relaxed">
          <span className="text-muted-foreground">{error}</span>
        </div>
      )}

      {/* 列表区 */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            正在读取 ClawHub 技能目录…
          </div>
        ) : skills.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <PackageOpenIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
              </div>
            </div>
            {query ? `没有匹配「${query}」的技能。` : "ClawHub 暂无可用技能。"}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
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
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore && <Loader2Icon className="size-3.5 animate-spin" />}
                  加载更多
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ClawhubSkillDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        installed={detailTarget ? isInstalled(detailTarget) : false}
        localNames={localNames}
        workspaceCwd={workspace}
      />
    </div>
  );
};
