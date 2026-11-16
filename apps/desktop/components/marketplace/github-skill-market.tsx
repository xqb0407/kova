"use client";

/**
 * 技能市场面板（技能段 · 唯一源 = GitHub 精选仓库）。
 *
 * 目录来自 GitHub 精选仓库（lib/skills/github-skill-source.ts）：Trees API
 * 找 SKILL.md，raw 回源取正文并解析 frontmatter。安装仍走 saveSkill({ raw })，
 * 与设置页「导入 Markdown」同一条管道，因此安装后清单自动回流。
 *
 * 版式对齐插件市场的连接器：搜索工具行 + 带边框卡片网格 + 紧凑详情弹窗
 * （目标层分段选择 + 单一安装按钮）。
 *
 * 合规取向：不接入第三方聚合站、不镜像整库、不转存 logo；每个卡片都给出
 * 仓库来源与许可证，安装内容按 commit SHA 回源，仓库未声明许可证时明确提示。
 * 搜索在本地做（目录是若干精选仓库，不做服务端全文检索）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { Segmented } from "@/components/custom-ui/segmented";
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
import {
  fetchSkillCatalog,
  fetchSkillMarkdown,
  getAllSkillRepos,
  parseSkillFrontmatter,
  recordGithubSkillInstall,
  useGithubSkillInstalls,
  type GithubSkill,
} from "@/lib/skills/github-skill-source";
import { getLocale, useT } from "@/lib/i18n";

const SEARCH_DEBOUNCE_MS = 300;
/** 描述回源并发：目录扩大到多个仓库后分 8 路拉取，避免瞬时打满 */
const HYDRATE_CONCURRENCY = 8;

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
  /** 同名技能跨仓库出现时补充来源，避免卡片无法区分 */
  showSource: boolean;
  onOpen: () => void;
}> = ({ skill, installed, hydrating, showSource, onOpen }) => {
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
      className="hover:bg-muted/40 focus-visible:bg-muted/40 border-border/50 flex cursor-pointer items-center gap-3.5 rounded-xl border p-3 transition-colors outline-none"
    >
      <div className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg">
        <PluginIcon name={skill.name} className="text-lg" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {installed && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              {t("marketplace.common.installed")}
            </Badge>
          )}
          {showSource && (
            <span className="text-muted-foreground min-w-0 truncate text-2xs">
              {skill.owner}/{skill.repo}
            </span>
          )}
        </div>
        <p
          className="text-muted-foreground mt-0.5 truncate text-xs leading-5"
          title={description}
        >
          {description ||
            (hydrating
              ? t("marketplace.github.hydrating")
              : t("marketplace.skill.noDescription"))}
        </p>
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
  /** 安装目标层：有工作区时默认工作区，否则系统级 */
  const [scope, setScope] = useState<SkillSaveScope>("system");
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<
    SkillSaveScope | null
  >(null);
  const [reloadTick, setReloadTick] = useState(0);

  // 正文：换目标或重试时重新回源；AbortController 防快速切换时的竞态
  useEffect(() => {
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

  // 换目标/换工作区时复位安装态，并按当前工作区重新落点
  useEffect(() => {
    setBusy(false);
    setConfirmOverwrite(null);
    if (target) setScope(workspaceCwd ? "workspace" : "system");
  }, [target, workspaceCwd]);

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
  /** 各层的落点说明：工作区缺省时提示先选目录，其余给目录语义 */
  const scopeHint: Record<SkillSaveScope, string> = {
    workspace: workspaceCwd ?? t("marketplace.mcp.noWorkspace"),
    system: t("marketplace.skill.systemSaveHint"),
    compat: t("marketplace.skill.compatSaveHint"),
  };
  const workspaceMissing = scope === "workspace" && !workspaceCwd;
  const armed = nameTaken && confirmOverwrite === scope;
  /** 安装按钮 tooltip：缺工作区 > 跨层遮蔽 > 同名 > 落点说明 */
  const installTitle = workspaceMissing
    ? t("marketplace.skill.notSelectedWorkspace")
    : shadowedBy(scope).length > 0
      ? t("marketplace.skill.shadowedHint", {
          scopes: scopeNames(shadowedBy(scope)),
        })
      : nameTaken
        ? t("marketplace.skill.nameTakenHint")
        : scopeHint[scope];
  /** 已武装时的按钮文字：同层同名才是"覆盖"，跨层同名只是"安装（会被遮蔽）" */
  const installLabel = armed
    ? existingScopes.includes(scope)
      ? t("marketplace.skill.confirmOverwrite")
      : t("marketplace.skill.confirmInstallAnyway")
    : t("marketplace.common.install");
  /** commit SHA 显示短哈希；jsDelivr 回退时是分支名，原样显示 */
  const versionLabel = /^[0-9a-f]{40}$/i.test(target.commitSha)
    ? target.commitSha.slice(0, 8)
    : target.commitSha;

  const install = () => {
    if (!rawSkillMd || busy || workspaceMissing) return;
    if (nameTaken && confirmOverwrite !== scope) {
      setConfirmOverwrite(scope);
      return;
    }
    setBusy(true);
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
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="bg-muted/40 grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl">
            <PluginIcon name={target.name} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
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
            <DialogDescription className="mt-1 flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
              </span>
              {description && (
                <span className="line-clamp-3" title={description}>
                  {description}
                </span>
              )}
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
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
          {state?.status === "ready" && (
            <SkillDocPreview raw={state.raw} title={effectiveName} />
          )}
        </div>

        {/* 安装目标：分段选层（对齐连接器弹窗）；工作区层就地选项目/新建 */}
        <div className="flex shrink-0 flex-col gap-2 border-t px-6 pt-3 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground shrink-0 text-[13px]">
              {t("marketplace.skill.installTo")}
            </span>
            <Segmented
              value={scope}
              onChange={(next) => {
                setScope(next);
                setConfirmOverwrite(null);
              }}
              options={[
                { value: "workspace", label: t(SKILL_SCOPE_LABEL_KEY.workspace) },
                { value: "system", label: t(SKILL_SCOPE_LABEL_KEY.system) },
                { value: "compat", label: t(SKILL_SCOPE_LABEL_KEY.compat) },
              ]}
            />
            {scope === "workspace" ? (
              <Select
                value={currentProjectId}
                items={projectItems}
                onValueChange={(value) => {
                  if (value) selectProjectById(value);
                }}
              >
                <SelectTrigger className="h-7 w-44">
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
            ) : null}
            <span
              className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-3xs"
              title={scopeHint[scope]}
            >
              {scopeHint[scope]}
            </span>
          </div>
          {workspaceMissing ? (
            <p className="text-muted-foreground text-[13px] leading-5">
              {t("marketplace.skill.workspaceMissingHint")}
            </p>
          ) : null}
          {armed && shadowedBy(scope).length > 0 ? (
            <p className="text-amber-700 dark:text-amber-400 text-xs leading-tight">
              {t("marketplace.skill.shadowedHint", {
                scopes: scopeNames(shadowedBy(scope)),
              })}
            </p>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 pb-4 sm:justify-between">
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {target.path} · {t("marketplace.github.versionSuffix", { version: versionLabel })}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("marketplace.common.close")}
            </Button>
            {rawSkillMd && (
              <Button
                variant={armed ? "destructive" : "default"}
                disabled={workspaceMissing || busy}
                title={installTitle}
                onClick={install}
              >
                {busy && <Loader2Icon className="size-3.5 animate-spin" />}
                {installLabel}
              </Button>
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

export const GithubSkillMarket: FC = () => {
  const t = useT();
  // 工作区级技能/插件/MCP 配置写入项目主目录，附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
  const skillsSnap = useSkills(workspace);
  const installRecords = useGithubSkillInstalls();

  const [skills, setSkills] = useState<GithubSkill[]>([]);
  const [errors, setErrors] = useState<{ repo: string; message: string }[]>([]);
  const [hydratingIds, setHydratingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [detailTarget, setDetailTarget] = useState<GithubSkill | null>(null);

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
    setHydratingIds(new Set());
    void (async () => {
      try {
        const catalog = await fetchSkillCatalog(
          getAllSkillRepos(),
          controller.signal,
          reloadKey > 0,
        );
        if (controller.signal.aborted) return;
        setSkills(catalog.skills);
        setErrors(catalog.errors);
        setLoading(false);

        // 描述回源：按批并发，每批合并一次更新，避免逐条重渲染整页
        const pending = catalog.skills.filter((s) => !s.description);
        setHydratingIds(new Set(pending.map((s) => s.id)));
        for (let i = 0; i < pending.length; i += HYDRATE_CONCURRENCY) {
          if (controller.signal.aborted) return;
          const chunk = pending.slice(i, i + HYDRATE_CONCURRENCY);
          const patches = await Promise.all(
            chunk.map(async (skill) => {
              try {
                const raw = await fetchSkillMarkdown(skill, controller.signal);
                if (controller.signal.aborted) return null;
                const frontmatter = parseSkillFrontmatter(raw);
                return {
                  id: skill.id,
                  name: frontmatter.name ?? skill.name,
                  description: frontmatter.description ?? skill.description,
                };
              } catch {
                // 单条描述失败不阻塞其它条目
                return null;
              }
            }),
          );
          if (controller.signal.aborted) return;
          const byId = new Map<
            string,
            { name: string; description: string }
          >();
          for (const patch of patches) {
            if (patch) byId.set(patch.id, patch);
          }
          if (byId.size > 0) {
            setSkills((prev) =>
              prev.map((s) => {
                const patch = byId.get(s.id);
                return patch
                  ? { ...s, name: patch.name, description: patch.description }
                  : s;
              }),
            );
          }
          setHydratingIds((prev) => {
            const next = new Set(prev);
            for (const skill of chunk) next.delete(skill.id);
            return next;
          });
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
          setHydratingIds(new Set());
        }
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  /** 跨仓库同名技能：卡片上补来源仓库，避免无法区分 */
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) {
      counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    }
    return new Set(
      [...counts].filter(([, count]) => count > 1).map(([name]) => name),
    );
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.repoLabel.toLowerCase().includes(q) ||
        skill.path.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const isInstalled = (skill: GithubSkill): boolean => {
    const record = installRecords[skill.id];
    return Boolean(record && localScopes.has(record.name));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 说明 + 刷新（与连接器区块一致） */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder={t("marketplace.skill.searchPlaceholder")}
        ariaLabel={t("marketplace.github.searchAria")}
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        refreshTitle={t("marketplace.github.refreshHint")}
        hint={t("marketplace.github.hint")}
        inputClassName="w-72"
      />

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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-1">
            {filtered.map((skill) => (
              <GithubSkillCard
                key={skill.id}
                skill={skill}
                installed={isInstalled(skill)}
                hydrating={hydratingIds.has(skill.id)}
                showSource={duplicateNames.has(skill.name)}
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
    </div>
  );
};
