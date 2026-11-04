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
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { cn } from "@/lib/utils";
import {
  openWorkspacePicker,
  pathBasename,
  setWorkspace,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace/workspace-store";
import { saveMcpServer, useMcpServers } from "@/lib/mcp/mcp";
import {
  fetchMcpMarketPage,
  type McpMarketHeader,
  type McpMarketRemote,
  type McpMarketServer,
} from "@/lib/mcp/mcp-market";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";

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
  const publisher = server.name.split("/")[0] ?? server.name;
  const remoteCount = server.remotes.length;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看 MCP 服务器 ${server.title} 详情`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title="点击查看服务器详情"
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
          远程
        </Badge>
      </div>

      <p
        className="text-muted-foreground mt-2.5 line-clamp-2 min-h-8 flex-1 text-xs leading-5"
        title={server.description}
      >
        {server.description || "暂无描述"}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {publisher}
          {remoteCount > 1 ? ` · ${remoteCount} 个接入点` : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {installed && (
            <Badge variant="outline" className="gap-1 font-normal">
              已添加
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
            {installed ? "详情" : "添加"}
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
  /** 当前清单：按层判断同名、按 URL 判断是否已添加 */
  servers: { name: string; layer: "system" | "workspace" | "plugin"; transport: string; url?: string }[];
}> = ({ target, onClose, workspaceCwd, servers }) => {
  const [scope, setScope] = useState<"system" | "workspace">(
    () => readInstallScope(workspaceCwd),
  );
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const recents = useWorkspaceRecents();

  /** 记住安装层级：下次打开同一个（或其它）服务器不再每次重选 */
  const chooseScope = (next: "system" | "workspace") => {
    setScope(next);
    try {
      window.localStorage.setItem(INSTALL_SCOPE_KEY, next);
    } catch {
      // 隐私模式 / 配额满：仅本次会话生效
    }
  };

  /** 工作区级安装必须先有目录：直接召起系统目录选择框，选中即设为当前工作区 */
  const pickWorkspace = async () => {
    setPicking(true);
    try {
      const dir = await openWorkspacePicker();
      if (dir) {
        setError(null);
        chooseScope("workspace");
      }
    } finally {
      setPicking(false);
    }
  };

  const useRecentWorkspace = (dir: string) => {
    setWorkspace(dir);
    setError(null);
    chooseScope("workspace");
  };

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
        `请填写必填请求头：${missingHeaders.map((h) => h.name).join("、")}`,
      );
      return;
    }
    if (workspaceMissing) {
      setError("未选择工作区，无法安装到工作区级");
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
        cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
        definition: {
          name: finalName,
          transport: "http",
          url: remote.url,
          ...(target.description ? { description: target.description } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
      toastSuccess(
        `已添加「${finalName}」`,
        `保存到${scope === "workspace" ? "工作区 .kova/mcp.json" : "系统 ~/.kova/mcp.json"} · 可在管理页启停或编辑`,
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
                  已添加
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
                  仓库
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
            <span className="text-sm font-medium">远程接入点</span>
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
              <span className="text-sm font-medium">请求头</span>
              {remote!.headers.map((header) => (
                <label key={header.name} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="font-mono">{header.name}</span>
                    {header.isRequired && (
                      <span className="text-destructive">必填</span>
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
                          ? "在此填入密钥"
                          : "可留空"
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
            <span className="text-sm font-medium">安装到</span>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={scope}
                onChange={(value) => {
                  if (value === "workspace" && !workspaceCwd) {
                    void pickWorkspace();
                    return;
                  }
                  setError(null);
                  chooseScope(value);
                }}
                options={[
                  { value: "system", label: "系统级" },
                  {
                    value: "workspace",
                    label: "工作区级",
                    title: workspaceCwd
                      ? "保存到当前工作区"
                      : "选择一个项目目录后即可安装到工作区级",
                  },
                ]}
              />
              <span className="text-muted-foreground text-xs">
                {scope === "system"
                  ? "本机全局生效（~/.kova/mcp.json）"
                  : workspaceCwd
                    ? `${workspaceCwd}/.kova/mcp.json`
                    : "未选择工作区"}
              </span>
            </div>
            {!workspaceCwd && (
              <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
                <span className="text-muted-foreground text-xs">
                  工作区级会写入 &lt;项目&gt;/.kova/mcp.json。当前没有打开项目，先选一个目录：
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {recents.slice(0, 3).map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      title={dir}
                      onClick={() => useRecentWorkspace(dir)}
                      className="hover:bg-muted max-w-40 truncate rounded-full border px-2.5 py-1 text-xs transition-colors"
                    >
                      {pathBasename(dir)}
                    </button>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={picking}
                    onClick={() => void pickWorkspace()}
                  >
                    {picking && <Loader2Icon className="size-3.5 animate-spin" />}
                    选择目录…
                  </Button>
                </div>
              </div>
            )}
            <span className="text-muted-foreground text-xs">
              将以「{finalName}」保存
              {finalName !== baseName ? "（同名已存在，已自动加序号）" : ""}
            </span>
          </section>

          <div className="border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-relaxed">
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              第三方服务器：添加后它会看到你发送的工具调用与数据。仅添加你信任的服务；
              地址与请求头会原样写入本地 MCP 配置，可随时在管理页删除。
            </span>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-4 sm:justify-between">
          <span className="text-muted-foreground truncate text-xs">
            来自官方 MCP Registry · 仅支持 HTTPS 远程
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              关闭
            </Button>
            <Button
              size="sm"
              disabled={busy || Boolean(installedByUrl)}
              onClick={() => {
                if (workspaceMissing) {
                  void pickWorkspace();
                  return;
                }
                void install();
              }}
            >
              {busy && <Loader2Icon className="size-3.5 animate-spin" />}
              {installedByUrl ? "已添加" : "添加服务器"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 市场主区
// ---------------------------------------------------------------------------

export const McpMarket: FC = () => {
  const workspace = useWorkspace();
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
      if (seq === requestSeq.current) toastError("加载更多失败", err);
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
        placeholder="搜索 MCP 服务器…"
        ariaLabel="搜索 MCP 服务器"
        loading={loading}
        onRefresh={() => setReloadKey((k) => k + 1)}
        hint="官方 MCP Registry · 仅 HTTPS 远程"
        inputClassName="w-72"
      />

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {loading && servers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <Loader2Icon className="size-5 animate-spin" />
            正在读取 MCP Registry…
          </div>
        ) : error && servers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            目录加载失败：{error}
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
              ? `没有匹配「${query}」的远程 MCP 服务器。`
              : "暂无可远程连接的 MCP 服务器。"}
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
              加载更多
            </Button>
          </div>
        )}
      </div>

      <McpMarketDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        workspaceCwd={workspaceCwd}
        servers={mcpSnap.servers}
      />
    </div>
  );
};

