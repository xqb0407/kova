"use client";

/**
 * 已装插件管理页（插件市场 → 管理 → 已装插件）。
 *
 * 事实源在 sidecar plugins.ts：cache 物化目录 + 清单规范化 + kv 启用开关；
 * 本页渲染 usePlugins 镜像并发起变更命令。插件级开关/卸载触发 sidecar 四链
 * 热重载（skills 提示词重组 + MCP 连接池 diff + 子智能体重排，hooks 实时读）。
 * 组件级开关走 set_skill_enabled / set_mcp_server_enabled / set_subagent_enabled
 * 的 plugin scope（stateKey 带 pluginId 命名空间），只在本页出现——
 * 插件条目刻意不进技能/MCP/子智能体设置页清单（payload 侧过滤）。
 *
 * 版式与技能/MCP 页同款：搜索 + bg-muted/50 卡片列表，行 = 图标盒 +
 * 名称/徽标/描述 + 行内操作 + Switch。hooks 组件 v1 无单条开关（随插件整体
 * 生效），只展示数量。
 */
import { useMemo, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  BlocksIcon,
  ChevronDownIcon,
  DownloadIcon,
  PuzzleIcon,
  RefreshCwIcon,
  Trash2Icon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspace } from "@/lib/workspace-store";
import {
  installPlugin,
  isPluginOpPending,
  setPluginComponentEnabled,
  setPluginEnabled,
  uninstallPlugin,
  usePendingOps,
  usePlugins,
  type PluginEntry,
} from "@/lib/plugins";

const ViewSpinner = () => (
  <div className="text-muted-foreground flex items-center gap-2 text-sm">
    <RefreshCwIcon className="size-4 animate-spin" />
    正在刷新…
  </div>
);

/** 卸载确认弹窗（破坏性操作，文案点名插件名与后果） */
const UninstallDialog = dynamic(
  () => import("@/components/marketplace/uninstall-dialog").then((m) => ({ default: m.UninstallDialog })),
  { ssr: false },
);

const MANIFEST_KIND_LABEL: Record<PluginEntry["manifestKind"], string> = {
  xulux: "xulux",
  claude: "Claude 生态",
  codex: "Codex 生态",
};

/** 组件摘要行：图标 + 数量徽标（详情展开后逐条列出） */
function ComponentBadge({
  icon: Icon,
  label,
  count,
}: {
  icon: typeof BlocksIcon;
  label: string;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      <Icon className="size-3" />
      {label} {count}
    </Badge>
  );
}

export const InstalledPlugins: FC = () => {
  const workspace = useWorkspace();
  const snap = usePlugins(workspace);
  const pending = usePendingOps();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<PluginEntry | null>(null);

  const plugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = snap.plugins;
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.marketplaceName.toLowerCase().includes(q),
    );
  }, [snap.plugins, query]);

  const toggleExpanded = (pluginId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });
  };

  const busy = pending.some((p) => p.op === "install_plugin");

  if (snap.loading && snap.plugins.length === 0) return <ViewSpinner />;

  if (snap.error) {
    return (
      <div className="text-destructive flex h-full items-center justify-center text-sm">
        {snap.error}
      </div>
    );
  }

  if (snap.plugins.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2">
        <div className="bg-muted/50 grid size-12 place-items-center rounded-2xl border">
          <PuzzleIcon className="text-muted-foreground size-6" />
        </div>
        <p className="text-sm font-medium">还没有已安装的插件</p>
        <p className="text-sm">回到「市场」页添加插件市场并安装。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 py-6">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索插件…"
          className="max-w-xs"
        />
        {snap.loading && (
          <RefreshCwIcon className="text-muted-foreground size-4 animate-spin" />
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
        {plugins.map((p) => {
          const installBusy = isPluginOpPending("install_plugin", `${p.marketplaceId}:${p.name}`);
          const isOpen = expanded.has(p.pluginId);
          const totalComponents =
            p.components.skills.length +
            p.components.mcpServers.length +
            p.components.subagents.length;
          return (
            <div key={p.pluginId} className="bg-muted/50 rounded-2xl border">
              <div className="flex items-start gap-3 p-4">
                <div className="bg-background grid size-9 shrink-0 place-items-center rounded-xl border">
                  <PuzzleIcon className="text-muted-foreground size-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <Badge variant="outline" className="px-1.5 font-mono text-[11px] font-normal">
                      v{p.version}
                    </Badge>
                    {p.manifestKind !== "xulux" && (
                      <Badge variant="secondary" className="font-normal">
                        {MANIFEST_KIND_LABEL[p.manifestKind]}
                      </Badge>
                    )}
                    {p.sourceMissing && (
                      <Badge variant="destructive" className="font-normal">
                        市场已移除
                      </Badge>
                    )}
                    {!p.enabled && (
                      <Badge variant="outline" className="text-muted-foreground font-normal">
                        已停用
                      </Badge>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-sm">
                      {p.description}
                    </p>
                  )}
                  <p className="text-muted-foreground/70 mt-1 truncate text-xs">
                    {p.pluginId} · 来自 {p.marketplaceName}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <ComponentBadge icon={BlocksIcon} label="技能" count={p.components.skills.length} />
                    <ComponentBadge icon={WrenchIcon} label="MCP" count={p.components.mcpServers.length} />
                    <ComponentBadge icon={UsersIcon} label="子智能体" count={p.components.subagents.length} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(totalComponents > 0 || p.diagnostics.length > 0) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => toggleExpanded(p.pluginId)}
                      aria-label={isOpen ? "收起详情" : "展开详情"}
                    >
                      <ChevronDownIcon
                        className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                      />
                    </Button>
                  )}
                  <Switch
                    checked={p.enabled}
                    onCheckedChange={(v) => void setPluginEnabled(p.pluginId, v, workspace)}
                    aria-label={`启用插件 ${p.name}`}
                  />
                </div>
              </div>

              {isOpen && (
                <div className="border-t px-4 py-3">
                  {/* 组件清单：v1 hooks 无单条开关，随插件整体生效，只计入摘要徽标 */}
                  {(["skills", "mcpServers", "subagents"] as const).map((kind) => {
                    const entries = p.components[kind];
                    if (entries.length === 0) return null;
                    const kindLabel =
                      kind === "skills" ? "技能" : kind === "mcpServers" ? "MCP 服务器" : "子智能体";
                    return (
                      <div key={kind} className="mb-3 last:mb-0">
                        <p className="text-muted-foreground mb-1.5 text-xs font-medium">{kindLabel}</p>
                        <div className="space-y-1.5">
                          {entries.map((c) => (
                            <div
                              key={`${kind}:${c.name}`}
                              className="bg-background flex items-center gap-3 rounded-xl border px-3 py-2"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">{c.name}</p>
                                {c.description && (
                                  <p className="text-muted-foreground line-clamp-1 text-xs">
                                    {c.description}
                                  </p>
                                )}
                              </div>
                              <Switch
                                checked={c.enabled}
                                onCheckedChange={(v) =>
                                  void setPluginComponentEnabled(
                                    kind === "skills" ? "skill" : kind === "mcpServers" ? "mcp" : "subagent",
                                    p.pluginId,
                                    c.name,
                                    v,
                                    workspace,
                                  )
                                }
                                aria-label={`启用 ${kindLabel} ${c.name}`}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {p.diagnostics.length > 0 && (
                    <div className="text-destructive space-y-1 text-xs">
                      {p.diagnostics.map((d, i) => (
                        <p key={i}>{d}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-1.5 border-t px-4 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-7 gap-1 text-xs"
                  disabled={busy}
                  onClick={() => void installPlugin(p.marketplaceId, p.name)}
                >
                  <DownloadIcon className="size-3.5" />
                  {installBusy ? "更新中…" : "检查更新"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-7 gap-1 text-xs"
                  onClick={() => setConfirmUninstall(p)}
                >
                  <Trash2Icon className="size-3.5" />
                  卸载
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <UninstallDialog
        entry={confirmUninstall}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={(entry) => {
          void uninstallPlugin(entry.pluginId, workspace);
          setConfirmUninstall(null);
        }}
      />
    </div>
  );
};
