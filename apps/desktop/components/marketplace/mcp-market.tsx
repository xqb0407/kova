"use client";

/**
 * MCP 市场（插件/专家/技能 → MCP 段）。
 *
 * 数据来自官方 MCP Registry（见 lib/mcp/mcp-market.ts）：只列可远程连接的
 * 条目，且远程地址必须是 HTTPS。卡片点开详情后，可选择系统级 / 工作区级，
 * 填入必填请求头（密钥类用密码框），保存为 transport = "http" 的 MCP 服务器——
 * 与设置页「新建 → HTTP」走同一条 saveMcpServer 管道。
 *
 * 合规与安全：不展示第三方 logo、不缓存整库；安装前明确提示这是第三方
 * 服务器，会看到工具调用与数据；明文 HTTP 条目在取数阶段就已被过滤。
 *
 * 版式对齐技能/插件市场：搜索工具行 + 卡片网格 + 底部分页（Registry 用
 * cursor，翻页换成「加载更多」，避免伪造总页数）。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageOpenIcon,
  PlusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { cn } from "@/lib/utils";
import { setWorkspace } from "@/lib/workspace/workspace-store";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
  useProjectWorkspaceDir,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import { saveMcpServer, useMcpServers } from "@/lib/mcp/mcp";
import {
  fetchMcpMarketPage,
  type McpMarketHeader,
  type McpMarketRemote,
  type McpMarketServer,
} from "@/lib/mcp/mcp-market";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import { useT } from "@/lib/i18n";

const SEARCH_DEBOUNCE_MS = 450;

/** 上次安装 MCP 选的层级：记住它，避免每次打开详情都要重选 */
const INSTALL_SCOPE_KEY = "kova.mcpMarketInstallScope";

function readInstallScope(workspaceCwd: string | null): "system" | "workspace" {
  if (!workspaceCwd) return "system";
  try {
    return window.localStorage.getItem(INSTALL_SCOPE_KEY) === "workspace"
      ? "workspace"
      : "system";
  } catch {
    return "system";
  }
}

function toastSuccess(title: string, description: string): void {
  void import("@/components/ui/toast").then(({ toast }) => {
    toast.success({ title, description });
  });
}

function toastError(title: string, err: unknown): void {
  void import("@/components/ui/toast").then(({ toast }) => {
    toast.error({
      title,
      description: err instanceof Error ? err.message : String(err),
    });
  });
}

/** 服务器名：只保留字母数字/中文/._-，供配置文件 key 使用 */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
  return cleaned || "mcp";
}

/** 同名已存在时自动加序号，避免一键添加覆盖掉用户已有的服务器 */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 跨页去重：同一 name 在 Registry 里可能有多个版本，只保留首见的最新版 */
function dedupeServers(list: McpMarketServer[]): McpMarketServer[] {
  const seen = new Set<string>();
  const out: McpMarketServer[] = [];
  for (const server of list) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    out.push(server);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

const McpMarketCard: FC<{
  server: McpMarketServer;
  installed: boolean;
  onOpen: () => void;
}> = ({ server, installed, onOpen }) => {
  const t = useT();
  const publisher = server.name.split("/")[0] ?? server.name;
  const remoteCount = server.remotes.length;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("marketplace.mcp.cardAria", { title: server.title })}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={t("marketplace.mcp.cardOpen")}
      className="bg-background hover:bg-muted/40 hover:border-foreground/15 flex cursor-pointer flex-col rounded-2xl border p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="bg-muted/40 grid size-8 shrink-0 place-items-center overflow-hidden rounded-xl">
          <PluginIcon src={server.iconUrl} name={server.title} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{server.title}</span>
          <Badge
            variant="outline"
            className="shrink-0 px-1.5 font-mono text-2xs font-normal"
          >
            v{server.version}
          </Badge>
        </div>
        <Badge variant="secondary" className="shrink-0 px-1.5 text-2xs font-normal">
          {t("marketplace.mcp.remote")}
        </Badge>
      </div>

      <p
        className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5"
        title={server.description}
      >
        {server.description || t("marketplace.mcp.noDescription")}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {publisher}
          {remoteCount > 1
            ? t("marketplace.mcp.endpoints", { count: remoteCount })
            : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {installed && (
            <Badge variant="outline" className="gap-1 font-normal">
              {t("marketplace.mcp.added")}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            <PlusIcon className="size-3" />
            {installed
              ? t("marketplace.mcp.detail")
              : t("marketplace.mcp.add")}
          </Button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 详情 / 安装弹窗
// ---------------------------------------------------------------------------

const McpMarketDetailDialog: FC<{
  target: McpMarketServer | null;
  onClose: () => void;
  workspaceCwd: string | null;
  /** 当前会话工作区：系统层安装也要带上它重调连接池，避免断开 workspace 服务器 */
  activeWorkspace: string | null;
  /** 当前清单：按层判断同名、按 URL 判断是否已添加 */
  servers: { name: string; layer: "system" | "workspace" | "plugin"; transport: string; url?: string }[];
}> = ({ target, onClose, workspaceCwd, activeWorkspace, servers }) => {
  const t = useT();
  const [scope, setScope] = useState<"system" | "workspace">(
    () => readInstallScope(workspaceCwd),
  );
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const registryProjects = useProjectRegistry();
  const activeProjects = useMemo(
    () =>
      registryProjects.filter(
        (project) => !project.archived && !project.hiddenFromSidebar,
      ),
    [registryProjects],
  );

  /** 记住安装层级：下次打开同一个（或其它）服务器不再每次重选 */
  const chooseScope = (next: "system" | "workspace") => {
    setScope(next);
    try {
      window.localStorage.setItem(INSTALL_SCOPE_KEY, next);
    } catch {
      // 隐私模式 / 配额满：仅本次会话生效
    }
  };

  /** 选中工作区 = 选中项目主目录（同时写 projectId，后续会话/配置同源） */
  const applyProject = (project: ProjectRecord) => {
    const primary = projectPrimaryPath(project);
    if (!primary) return;
    setWorkspace(primary, "user", project.id);
    setError(null);
    chooseScope("workspace");
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

  useEffect(() => {
    // 每次打开沿用上次选择的层级；没有工作区时回落系统级
    setScope(readInstallScope(workspaceCwd));
    setRemoteIndex(0);
    setBusy(false);
    setError(null);
  }, [target]);

  // 切换接入点时重置请求头输入（默认值预填，密钥留空）
  useEffect(() => {
    const remote = target?.remotes[remoteIndex];
    if (!remote) {
      setHeaderValues({});
      return;
    }
    const next: Record<string, string> = {};
    for (const header of remote.headers)
      next[header.name] = header.defaultValue ?? "";
    setHeaderValues(next);
  }, [target, remoteIndex]);

  if (!target) return null;

  const remote: McpMarketRemote | undefined = target.remotes[remoteIndex];
  const installedByUrl = remote
    ? servers.find(
        (s) =>
          s.layer !== "plugin" &&
          s.transport === "http" &&
          s.url === remote.url,
      )
    : undefined;
  const takenNames = new Set(
    servers
      .filter((s) => s.layer === scope)
      .map((s) => s.name),
  );
  const baseName = sanitizeName(target.title || target.name.split("/").pop() || target.name);
  const finalName = uniqueName(baseName, takenNames);
  const requiredHeaders: McpMarketHeader[] = (remote?.headers ?? []).filter(
    (h) => h.isRequired,
  );
  const missingHeaders = requiredHeaders.filter(
    (h) => !(headerValues[h.name] ?? "").trim(),
  );
  const workspaceMissing = scope === "workspace" && !workspaceCwd;

  const install = async () => {
    if (busy || !remote || installedByUrl) return;
    if (missingHeaders.length > 0) {
      setError(
        t("marketplace.mcp.requiredHeadersError", {
          names: missingHeaders
            .map((h) => h.name)
            .join(t("marketplace.mcp.headerSeparator")),
        }),
      );
      return;
    }
    if (workspaceMissing) {
      setError(t("marketplace.mcp.workspaceMissingError"));
      return;
    }
    const headers: Record<string, string> = {};
    for (const header of remote.headers) {
      const value = (headerValues[header.name] ?? "").trim();
      if (value) headers[header.name] = value;
    }
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer: scope,
        cwd:
          scope === "workspace"
            ? workspaceCwd ?? undefined
            : activeWorkspace ?? undefined,
        viewCwd: workspaceCwd,
        definition: {
          name: finalName,
          transport: "http",
          url: remote.url,
          ...(target.description ? { description: target.description } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
      toastSuccess(
        t("marketplace.mcp.installToastTitle", { name: finalName }),
        scope === "workspace"
          ? t("marketplace.mcp.installToastDescWorkspace")
          : t("marketplace.mcp.installToastDescSystem"),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="bg-muted/40 grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl">
            <PluginIcon src={target.iconUrl} name={target.title} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <span className="truncate">{target.title}</span>
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 font-mono text-2xs font-normal"
              >
                v{target.version}
              </Badge>
              {installedByUrl && (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {t("marketplace.mcp.added")}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate font-mono text-xs">
                {target.name}
              </span>
              {target.repositoryUrl && (
                <a
                  href={target.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  <ExternalLinkIcon className="size-3" />
                  {t("marketplace.mcp.repo")}
                </a>
              )}
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-2">
          {target.description && (
            <div className="bg-muted/50 shrink-0 rounded-xl px-4 py-3 text-sm leading-relaxed">
              {target.description}
            </div>
          )}

          <section className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("marketplace.mcp.remotes")}
            </span>
            {target.remotes.map((item, index) => (
              <button
                key={item.url}
                type="button"
                onClick={() => setRemoteIndex(index)}
                aria-pressed={index === remoteIndex}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition-colors",
                  index === remoteIndex
                    ? "border-foreground/25 bg-muted/50"
                    : "hover:bg-muted/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="px-1.5 text-2xs font-normal">
                    {item.type === "sse" ? "SSE" : "HTTP"}
                  </Badge>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                    {item.url}
                  </span>
                </div>
              </button>
            ))}
          </section>

          {(remote?.headers.length ?? 0) > 0 && (
            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {t("marketplace.mcp.headers")}
              </span>
              {remote!.headers.map((header) => (
                <label key={header.name} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="font-mono">{header.name}</span>
                    {header.isRequired && (
                      <span className="text-destructive">
                        {t("marketplace.mcp.required")}
                      </span>
                    )}
                    {header.description && (
                      <span className="text-muted-foreground min-w-0 truncate">
                        {header.description}
                      </span>
                    )}
                  </span>
                  <Input
                    type={header.isSecret ? "password" : "text"}
                    className="h-8 font-mono text-xs"
                    placeholder={
                      header.defaultValue
                        ? header.defaultValue
                        : header.isSecret
                          ? t("marketplace.mcp.secretPlaceholder")
                          : t("marketplace.mcp.optionalPlaceholder")
                    }
                    value={headerValues[header.name] ?? ""}
                    onChange={(e) =>
                      setHeaderValues((prev) => ({
                        ...prev,
                        [header.name]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("marketplace.mcp.installTo")}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={scope}
                onChange={(value) => {
                  // 还没有工作区时也允许切到工作区层级：下方直接选项目/新建
                  if (value === "workspace" && !workspaceCwd) {
                    chooseScope("workspace");
                    return;
                  }
                  setError(null);
                  chooseScope(value);
                }}
                options={[
                  {
                    value: "system",
                    label: t("marketplace.mcp.systemScope"),
                  },
                  {
                    value: "workspace",
                    label: t("marketplace.mcp.workspaceScope"),
                    title: workspaceCwd
                      ? t("marketplace.mcp.workspaceTitleCurrent")
                      : t("marketplace.mcp.workspaceTitlePick"),
                  },
                ]}
              />
              <span className="text-muted-foreground text-xs">
                {scope === "system"
                  ? t("marketplace.mcp.systemPath")
                  : workspaceCwd
                    ? `${workspaceCwd}/.kova/mcp.json`
                    : t("marketplace.mcp.noWorkspace")}
              </span>
            </div>
            {!workspaceCwd && (
              <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
                <span className="text-muted-foreground text-xs">
                  {t("marketplace.mcp.workspaceHelp")}
                </span>
                {activeProjects.length > 0 ? (
                  <Select
                    value={undefined}
                    items={projectItems}
                    onValueChange={(value) => {
                      if (value) selectProjectById(value);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full max-w-72">
                      <SelectValue
                        placeholder={t("marketplace.mcp.chooseWorkspace")}
                      />
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
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => setCreateOpen(true)}
                  >
                    <PlusIcon className="size-3.5" />
                    {t("marketplace.mcp.newWorkspace")}
                  </Button>
                )}
              </div>
            )}
            <span className="text-muted-foreground text-xs">
              {t("marketplace.mcp.saveAs", { name: finalName })}
              {finalName !== baseName
                ? t("marketplace.mcp.saveAsRenamed")
                : ""}
            </span>
          </section>

          <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-relaxed">
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("marketplace.mcp.warning")}</span>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            {t("marketplace.mcp.footerHint")}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("marketplace.common.close")}
            </Button>
            <Button
              size="sm"
              disabled={busy || Boolean(installedByUrl)}
              onClick={() => {
                if (workspaceMissing) {
                  setError(t("marketplace.mcp.workspaceMissingError"));
                  return;
                }
                void install();
              }}
            >
              {busy && <Loader2Icon className="size-3.5 animate-spin" />}
              {installedByUrl
                ? t("marketplace.mcp.added")
                : t("marketplace.mcp.addServer")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      {/* 工作区级安装没有项目时：直接在当前弹窗里新建（嵌套弹窗强制遮罩） */}
      <WorkspaceCreateDialog
        forceOverlay
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={applyProject}
      />
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 市场主区
// ---------------------------------------------------------------------------

export const McpMarket: FC = () => {
  const t = useT();
  // 工作区级安装写入项目主目录；附加目录不单独成为作用域
  const workspace = useProjectWorkspaceDir();
  const mcpSnap = useMcpServers(workspace);
  const workspaceCwd = mcpSnap.workspaceCwd ?? workspace;

  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [servers, setServers] = useState<McpMarketServer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<McpMarketServer | null>(null);
  /** 查询代次：搜索/刷新/首屏取数自增，用来作废「加载更多」这类无 abort 的旧响应 */
  const requestSeq = useRef(0);

  // 搜索防抖
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(queryInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // 首屏：连续取最多 3 页，避免过滤后一页全是不可远程条目而空屏
  useEffect(() => {
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let collected: McpMarketServer[] = [];
        let next: string | null = null;
        for (let page = 0; page < 3; page += 1) {
          const res = await fetchMcpMarketPage(
            { search: query || undefined, cursor: next ?? undefined },
            controller.signal,
          );
          collected = dedupeServers([...collected, ...res.servers]);
          next = res.nextCursor;
          if (res.servers.length > 0 || !next) break;
        }
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setServers(collected);
        setCursor(next);
      } catch (err) {
        if (!controller.signal.aborted && seq === requestSeq.current)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted && seq === requestSeq.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [query, reloadKey]);

  const installedUrls = useMemo(() => {
    const set = new Set<string>();
    for (const server of mcpSnap.servers) {
      if (server.transport === "http" && server.url) set.add(server.url);
    }
    return set;
  }, [mcpSnap.servers]);

  const isInstalled = (server: McpMarketServer) =>
    server.remotes.some((r) => installedUrls.has(r.url));

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    // 记下发起时的代次：期间若改了搜索词/点了刷新，这批结果与游标都已过期
    const seq = requestSeq.current;
    const cursorAtStart = cursor;
    setLoadingMore(true);
    try {
      let collected: McpMarketServer[] = [];
      let next: string | null = cursorAtStart;
      for (let page = 0; page < 3; page += 1) {
        const res = await fetchMcpMarketPage(
          { search: query || undefined, cursor: next ?? undefined },
        );
        if (seq !== requestSeq.current) return;
        collected = dedupeServers([...collected, ...res.servers]);
        next = res.nextCursor;
        if (res.servers.length > 0 || !next) break;
      }
      setServers((prev) => dedupeServers([...prev, ...collected]));
      setCursor(next);
    } catch (err) {
      if (seq === requestSeq.current)
        toastError(t("marketplace.mcp.loadMoreFailed"), err);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：搜索 + 来源说明 + 刷新 */}
      <SkillMarketToolbar
        query={queryInput}
        onQueryChange={setQueryInput}
        placeholder={t("marketplace.mcp.searchPlaceholder")}
        ariaLabel={t("marketplace.mcp.searchAria")}
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        hint={t("marketplace.mcp.hint")}
        inputClassName="w-72"
      />

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading && servers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            {t("marketplace.mcp.loading")}
          </div>
        ) : error && servers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            {t("marketplace.mcp.loadFailed", { error })}
          </div>
        ) : servers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <div className="relative mb-1 grid place-items-center">
              <DotCloud />
              <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
                <PackageOpenIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
              </div>
            </div>
            {query
              ? t("marketplace.mcp.noMatch", { query })
              : t("marketplace.mcp.empty")}
          </div>
        ) : (
          <div
            className={cn(
              "grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3 transition-opacity",
              loading && "pointer-events-none opacity-50",
            )}
          >
            {servers.map((server) => (
              <McpMarketCard
                key={server.id}
                server={server}
                installed={isInstalled(server)}
                onOpen={() => setDetailTarget(server)}
              />
            ))}
          </div>
        )}

        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && <Loader2Icon className="size-3.5 animate-spin" />}
              {t("marketplace.mcp.loadMore")}
            </Button>
          </div>
        )}
      </div>

      <McpMarketDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        workspaceCwd={workspaceCwd}
        activeWorkspace={workspace}
        servers={mcpSnap.servers}
      />
    </div>
  );
};

