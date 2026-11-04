"use client";

/**
 * GitHub 技能源面板（技能段 · 源 = GitHub 仓库）。
 *
 * 目录来自 GitHub 精选仓库（lib/skills/github-skill-source.ts）：Trees API
 * 找 SKILL.md，raw 回源取正文并解析 frontmatter。安装仍走 saveSkill({ raw })，
 * 与设置页「导入 Markdown」同一条管道，因此安装后清单自动回流。
 *
 * 合规取向：不接入第三方聚合站、不镜像整库、不转存 logo；每个卡片都给出
 * 仓库来源与许可证，安装内容按 commit SHA 回源，仓库未声明许可证时明确提示。
 * 搜索与仓库筛选都在本地做（目录是若干精选仓库，不做服务端全文检索）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  ExternalLinkIcon,
  Loader2Icon,
  PackageOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  XIcon,
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
import { cn } from "@/lib/utils";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { SkillDocPreview } from "@/components/marketplace/skill-doc-preview";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import type { SkillSource } from "@/components/marketplace/skill-source-select";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { saveSkill, useSkills } from "@/lib/skills/skills";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import {
  addUserSkillRepo,
  fetchSkillCatalog,
  fetchSkillMarkdown,
  getAllSkillRepos,
  parseSkillFrontmatter,
  recordGithubSkillInstall,
  removeUserSkillRepo,
  useGithubSkillInstalls,
  type GithubSkill,
  type GithubSkillRepo,
} from "@/lib/skills/github-skill-source";

const SEARCH_DEBOUNCE_MS = 300;
/** 描述回源并发：29 个 SKILL.md 分 4 路拉取，避免瞬时打满 */
const HYDRATE_CONCURRENCY = 4;

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function repoKey(repo: { owner: string; repo: string }): string {
  return `${repo.owner}/${repo.repo}`;
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

const GithubSkillCard: FC<{
  skill: GithubSkill;
  installed: boolean;
  hydrating: boolean;
  onOpen: () => void;
}> = ({ skill, installed, hydrating, onOpen }) => {
  const description = skill.description;
  return (
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
          <PluginIcon name={skill.name} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {installed && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              已安装
            </Badge>
          )}
        </div>
      </div>

      <p
        className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5"
        title={description}
      >
        {description ||
          (hydrating ? "正在读取描述…" : "暂无描述，点击查看正文")}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {skill.owner}/{skill.repo}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 text-2xs font-normal",
              !skill.license && "text-amber-700 dark:text-amber-400",
            )}
            title={
              skill.license
                ? `仓库许可证：${skill.license}`
                : skill.metaLoaded
                  ? "仓库未声明许可证，安装前请确认授权范围"
                  : "GitHub 接口限流，暂时读不到许可证；请点开源文件确认授权"
            }
          >
            {skill.license ??
              (skill.metaLoaded ? "未声明许可" : "许可证未知")}
          </Badge>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 详情弹窗（取正文 + 预览 + 安装）
// ---------------------------------------------------------------------------

type DetailState =
  | { status: "loading" }
  | { status: "ready"; raw: string }
  | { status: "error"; text: string };

const GithubSkillDetailDialog: FC<{
  target: GithubSkill | null;
  onClose: () => void;
  /** 本机已通过市场安装过该条目（id 精确匹配） */
  installed: boolean;
  /** 本地技能名清单：覆盖确认按 frontmatter 真名比对 */
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
    fetchSkillMarkdown(target, controller.signal)
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
  const description = frontmatter.description || target.description;
  /** 实际落盘的技能名：frontmatter name 优先，缺失时用目录名兜底 */
  const effectiveName = frontmatter.name ?? target.name;
  const nameTaken = localNames.has(effectiveName);
  /** commit SHA 显示短哈希；jsDelivr 回退时是分支名，原样显示 */
  const versionLabel = /^[0-9a-f]{40}$/i.test(target.commitSha)
    ? target.commitSha.slice(0, 8)
    : target.commitSha;
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
        recordGithubSkillInstall(target.id, effectiveName, scope);
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: `已安装「${effectiveName}」`,
            description: `来源 ${target.owner}/${target.repo}${
              target.license
                ? ` · ${target.license}`
                : target.metaLoaded
                  ? " · 仓库未声明许可证"
                  : " · 许可证未知"
            }`,
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
            <PluginIcon name={target.name} className="text-xl" />
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
              <span className="min-w-0 truncate">{repoKey(target)}</span>
              {target.metaLoaded && (
                <span
                  className="text-muted-foreground flex items-center gap-1 tabular-nums"
                  title="仓库星标数"
                >
                  <StarIcon className="size-3" />
                  {formatCount(target.stars)}
                </span>
              )}
              <Badge variant="secondary" className="px-1.5 py-0 text-2xs font-normal">
                {target.license ??
                  (target.metaLoaded ? "未声明许可" : "许可证未知")}
              </Badge>
              <a
                href={target.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLinkIcon className="size-3" />
                源文件
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

          {!target.license && (
            <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-relaxed">
              <span>
                {target.metaLoaded
                  ? "该仓库未声明开源许可证。安装只把内容写入本地技能目录，但再次分发或商用前请先向作者确认授权范围。"
                  : "暂时无法读取仓库许可证（GitHub 接口限流或网络异常）。安装只把内容写入本地技能目录，分发或商用前请点开「源文件」确认授权。"}
              </span>
            </div>
          )}

          {target.extraFiles > 0 && (
            <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex flex-col gap-1 rounded-xl border px-4 py-3 text-xs leading-relaxed">
              <span>
                该技能目录还包含 {target.extraFiles} 个附属文件（脚本/资源等）。
                此处只安装 SKILL.md；正文若依赖这些文件，请前往仓库完整获取。
              </span>
              <a
                className="inline-flex items-center gap-1 self-start underline underline-offset-2"
                href={`${target.repoUrl}/tree/${target.commitSha}/${target.dir}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLinkIcon className="size-3" />
                查看技能目录
              </a>
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
            {target.path} · 版本 {versionLabel}
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
// 添加仓库
// ---------------------------------------------------------------------------

const AddRepoDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}> = ({ open, onOpenChange, onAdded }) => {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput("");
    setError(null);
    setBusy(false);
  }, [open]);

  const submit = async () => {
    if (busy || !input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addUserSkillRepo(input);
      onAdded();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加技能仓库</DialogTitle>
          <DialogDescription>
            填入 GitHub 仓库的 owner/repo。只会读取该仓库的 SKILL.md 路径，
            内容在打开详情或安装时才回源。
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          className="font-mono"
          placeholder="owner/repo，如 anthropics/skills"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy || !input.trim()}
            onClick={() => void submit()}
          >
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 市场主区
// ---------------------------------------------------------------------------

export const GithubSkillMarket: FC<{
  source: SkillSource;
  onSourceChange: (source: SkillSource) => void;
}> = ({ source, onSourceChange }) => {
  const workspace = useWorkspace();
  const skillsSnap = useSkills(workspace);
  const installRecords = useGithubSkillInstalls();

  const [repos, setRepos] = useState<GithubSkillRepo[]>(() => getAllSkillRepos());
  const [skills, setSkills] = useState<GithubSkill[]>([]);
  const [errors, setErrors] = useState<{ repo: string; message: string }[]>([]);
  const [hydratingIds, setHydratingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState<string>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [detailTarget, setDetailTarget] = useState<GithubSkill | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const localNames = useMemo(
    () => new Set(skillsSnap.skills.map((s) => s.name)),
    [skillsSnap.skills],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(queryInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // 目录：树请求 10 分钟缓存；手动刷新（reloadKey > 0）强制回源
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrors([]);
    void (async () => {
      try {
        const catalog = await fetchSkillCatalog(
          repos,
          controller.signal,
          reloadKey > 0,
        );
        if (controller.signal.aborted) return;
        setSkills(catalog.skills);
        setErrors(catalog.errors);
        setLoading(false);

        // 描述回源：分批并发，卡片随每批完成即时补全
        const pending = catalog.skills.filter((s) => !s.description);
        setHydratingIds(new Set(pending.map((s) => s.id)));
        for (let i = 0; i < pending.length; i += HYDRATE_CONCURRENCY) {
          if (controller.signal.aborted) return;
          await Promise.all(
            pending.slice(i, i + HYDRATE_CONCURRENCY).map(async (skill) => {
              try {
                const raw = await fetchSkillMarkdown(skill, controller.signal);
                if (controller.signal.aborted) return;
                const frontmatter = parseSkillFrontmatter(raw);
                setSkills((prev) =>
                  prev.map((s) =>
                    s.id === skill.id
                      ? {
                          ...s,
                          name: frontmatter.name ?? s.name,
                          description: frontmatter.description ?? s.description,
                        }
                      : s,
                  ),
                );
              } catch {
                // 单条描述失败不阻塞其它条目
              } finally {
                setHydratingIds((prev) => {
                  const next = new Set(prev);
                  next.delete(skill.id);
                  return next;
                });
              }
            }),
          );
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setErrors([
            {
              repo: "技能目录",
              message: err instanceof Error ? err.message : String(err),
            },
          ]);
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [repos, reloadKey]);

  const repoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) {
      const key = `${skill.owner}/${skill.repo}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return skills.filter((skill) => {
      if (repoFilter !== "all" && `${skill.owner}/${skill.repo}` !== repoFilter)
        return false;
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.repoLabel.toLowerCase().includes(q) ||
        skill.path.toLowerCase().includes(q)
      );
    });
  }, [skills, repoFilter, query]);

  const isInstalled = (skill: GithubSkill): boolean => {
    const record = installRecords[skill.id];
    return Boolean(record && localNames.has(record.name));
  };

  const removeRepo = (repo: GithubSkillRepo) => {
    removeUserSkillRepo(repoKey(repo));
    setRepos(getAllSkillRepos());
    setRepoFilter("all");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 添加仓库 + 源切换/刷新 */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder="搜索技能名称 / 描述…"
        ariaLabel="搜索 GitHub 技能"
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        refreshTitle="刷新目录（重新读取 GitHub 树）"
        source={source}
        onSourceChange={onSourceChange}
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon className="size-3.5" />
          添加仓库
        </Button>
      </SkillMarketToolbar>

      {/* 仓库筛选：内置精选 + 用户添加（用户仓库可移除） */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setRepoFilter("all")}
          aria-pressed={repoFilter === "all"}
          className={cn(
            "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors",
            repoFilter === "all"
              ? "bg-foreground text-background border-transparent"
              : "hover:bg-muted text-muted-foreground",
          )}
        >
          全部 {skills.length}
        </button>
        {repos.map((repo) => {
          const key = repoKey(repo);
          const active = repoFilter === key;
          return (
            <div key={key} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => setRepoFilter(key)}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  active
                    ? "bg-foreground text-background border-transparent"
                    : "hover:bg-muted text-muted-foreground",
                )}
              >
                {repo.label} {repoCounts.get(key) ?? 0}
              </button>
              {repo.addedByUser && (
                <button
                  type="button"
                  aria-label={`移除仓库 ${repo.label}`}
                  title="从列表移除该仓库（不影响已安装技能）"
                  className="text-muted-foreground hover:text-destructive ml-0.5 grid size-6 place-items-center rounded-full"
                  onClick={() => removeRepo(repo)}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {errors.length > 0 && (
        <div className="border-border/70 bg-muted/40 mt-3 rounded-xl border px-4 py-2 text-xs leading-relaxed">
          <span className="text-muted-foreground">
            部分仓库读取失败：
            {errors.map((e) => `${e.repo}（${e.message}）`).join("；")}
          </span>
        </div>
      )}

      {/* 列表区 */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            正在读取 GitHub 技能目录…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <PackageOpenIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
              </div>
            </div>
            {query
              ? `没有匹配「${query}」的技能。`
              : "该仓库下暂无 SKILL.md 技能。"}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
            {filtered.map((skill) => (
              <GithubSkillCard
                key={skill.id}
                skill={skill}
                installed={isInstalled(skill)}
                hydrating={hydratingIds.has(skill.id)}
                onOpen={() => setDetailTarget(skill)}
              />
            ))}
          </div>
        )}
      </div>

      <GithubSkillDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        installed={detailTarget ? isInstalled(detailTarget) : false}
        localNames={localNames}
        workspaceCwd={workspace}
      />

      <AddRepoDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setRepos(getAllSkillRepos());
          setRepoFilter("all");
        }}
      />
    </div>
  );
};
