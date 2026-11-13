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
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  saveSkill,
  useSkills,
  SKILL_SCOPE_LABEL_KEY,
  SKILL_SCOPE_RANK,
  type SkillSaveScope,
  type SkillScope,
} from "@/lib/skills/skills";
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
import { getLocale, useT } from "@/lib/i18n";

const SEARCH_DEBOUNCE_MS = 300;
/** 描述回源并发：29 个 SKILL.md 分 4 路拉取，避免瞬时打满 */
const HYDRATE_CONCURRENCY = 4;

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return new Intl.NumberFormat(
    getLocale() === "zh" ? "zh-CN" : "en-US",
    { notation: "compact", maximumFractionDigits: 1 },
  ).format(n);
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
  const t = useT();
  const description = skill.description;
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
              {t("marketplace.common.installed")}
            </Badge>
          )}
        </div>
      </div>

      <p
        className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5"
        title={description}
      >
        {description ||
          (hydrating
            ? t("marketplace.github.hydrating")
            : t("marketplace.skill.noDescription"))}
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
                ? t("marketplace.github.licenseTitle", {
                    license: skill.license,
                  })
                : skill.metaLoaded
                  ? t("marketplace.github.licenseHintMissing")
                  : t("marketplace.github.licenseHintUnknown")
            }
          >
            {skill.license ??
              (skill.metaLoaded
                ? t("marketplace.github.licenseMissing")
                : t("marketplace.github.licenseUnknown"))}
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
  /** commit SHA 显示短哈希；jsDelivr 回退时是分支名，原样显示 */
  const versionLabel = /^[0-9a-f]{40}$/i.test(target.commitSha)
    ? target.commitSha.slice(0, 8)
    : target.commitSha;
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
        recordGithubSkillInstall(target.id, effectiveName, scope);
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: t("marketplace.skill.installSuccess", {
              name: effectiveName,
            }),
            description: `${t("marketplace.github.installDescSource", {
              repo: `${target.owner}/${target.repo}`,
            })}${
              target.license
                ? t("marketplace.github.installDescLicense", {
                    license: target.license,
                  })
                : target.metaLoaded
                  ? t("marketplace.github.installDescMissing")
                  : t("marketplace.github.installDescUnknown")
            }`,
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
            <PluginIcon name={target.name} className="text-xl" />
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
              <span className="min-w-0 truncate">{repoKey(target)}</span>
              {target.metaLoaded && (
                <span
                  className="text-muted-foreground flex items-center gap-1 tabular-nums"
                  title={t("marketplace.github.starsTitle")}
                >
                  <StarIcon className="size-3" />
                  {formatCount(target.stars)}
                </span>
              )}
              <Badge variant="secondary" className="px-1.5 py-0 text-2xs font-normal">
                {target.license ??
                  (target.metaLoaded
                    ? t("marketplace.github.licenseMissing")
                    : t("marketplace.github.licenseUnknown"))}
              </Badge>
              <a
                href={target.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLinkIcon className="size-3" />
                {t("marketplace.github.sourceFile")}
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
                  ? t("marketplace.github.licenseWarnMissing")
                  : t("marketplace.github.licenseWarnUnknown")}
              </span>
            </div>
          )}

          {target.extraFiles > 0 && (
            <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex flex-col gap-1 rounded-xl border px-4 py-3 text-xs leading-relaxed">
              <span>
                {t("marketplace.github.extraFiles", {
                  count: target.extraFiles,
                })}
              </span>
              <a
                className="inline-flex items-center gap-1 self-start underline underline-offset-2"
                href={`${target.repoUrl}/tree/${target.commitSha}/${target.dir}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLinkIcon className="size-3" />
                {t("marketplace.github.viewSkillDir")}
              </a>
            </div>
          )}

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
          {state?.status === "ready" && <SkillDocPreview raw={state.raw} />}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            {target.path} · {t("marketplace.github.versionSuffix", { version: versionLabel })}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {rawSkillMd && !workspaceCwd ? (
              <span className="text-muted-foreground mr-1 hidden text-xs sm:inline">
                {t("marketplace.skill.workspaceMissingHint")}
              </span>
            ) : null}
            {confirmOverwrite && shadowedBy(confirmOverwrite).length > 0 ? (
              <span className="text-amber-700 dark:text-amber-400 mr-1 max-w-64 text-xs leading-tight">
                {t("marketplace.skill.shadowedHint", {
                  scopes: scopeNames(shadowedBy(confirmOverwrite)),
                })}
              </span>
            ) : null}
            <Button variant="outline" size="sm" onClick={onClose}>
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
                  size="sm"
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
                  size="sm"
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
                  size="sm"
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
  const t = useT();
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
          <DialogTitle>{t("marketplace.github.addRepoTitle")}</DialogTitle>
          <DialogDescription>
            {t("marketplace.github.addRepoDesc")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          className="font-mono"
          placeholder={t("marketplace.github.addRepoPlaceholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // IME 组合中：回车是确认候选词，不是提交
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter") void submit();
          }}
        />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("marketplace.common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || !input.trim()}
            onClick={() => void submit()}
          >
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            {t("marketplace.common.add")}
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
  const t = useT();
  // 工作区级技能/插件/MCP 配置写入项目主目录，附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
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

  const localScopes = useMemo(() => {
    const map = new Map<string, SkillScope[]>();
    for (const s of skillsSnap.skills) {
      const scopes = map.get(s.name);
      if (scopes) scopes.push(s.scope);
      else map.set(s.name, [s.scope]);
    }
    return map;
  }, [skillsSnap.skills]);

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
              repo: t("marketplace.github.catalogLabel"),
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
    return Boolean(record && localScopes.has(record.name));
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
        placeholder={t("marketplace.skill.searchPlaceholder")}
        ariaLabel={t("marketplace.github.searchAria")}
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        refreshTitle={t("marketplace.github.refreshHint")}
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
          {t("marketplace.github.addRepo")}
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
          {t("marketplace.github.allRepos", { count: skills.length })}
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
                {t(repo.labelKey ?? repo.label)} {repoCounts.get(key) ?? 0}
              </button>
              {repo.addedByUser && (
                <button
                  type="button"
                  aria-label={t("marketplace.github.removeRepoAria", {
                    label: t(repo.labelKey ?? repo.label),
                  })}
                  title={t("marketplace.github.removeRepoHint")}
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
            {t("marketplace.github.partialFailure")}
            {errors
              .map((e) =>
                t("marketplace.github.errorItem", {
                  repo: e.repo,
                  message: e.message,
                }),
              )
              .join(t("marketplace.github.errorSeparator"))}
          </span>
        </div>
      )}

      {/* 列表区 */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            {t("marketplace.github.loadingCatalog")}
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
              ? t("marketplace.skill.noMatch", { query })
              : t("marketplace.github.emptyRepo")}
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
        localScopes={localScopes}
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
