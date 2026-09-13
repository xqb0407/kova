"use client";

/**
 * MCP 设置页（设置 → 智能体 → MCP）。
 *
 * 事实源在 sidecar：三层配置（系统 ~/.xulux/mcp.json / 工作区 .mcp.json / 工作区
 * 覆盖 .xulux/mcp.json）+ kv 里的启停开关；本页只渲染 useMcpServers 镜像并发起
 * 变更命令（清单应答自带连接状态）。工作区标准层 .mcp.json 是共享文件：
 * 条目可被覆盖层接管编辑，但不从设置页直接改写（sidecar 拒绝并解释）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderOpenIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  ServerIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/custom-ui/segmented";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTauri } from "@/lib/tauri";
import { pathBasename, useWorkspace, useWorkspaceRecents } from "@/lib/workspace-store";
import {
  deleteMcpServer,
  refreshMcpServers,
  saveMcpServer,
  setMcpServerEnabled,
  testMcpServer,
  useMcpServers,
  type McpServerDraft,
  type McpServerEntry,
} from "@/lib/mcp";

const LAYER_LABEL: Record<McpServerEntry["layer"], string> = {
  system: "系统",
  workspace: "工作区",
};

const STATE_LABEL: Record<McpServerEntry["status"]["state"], string> = {
  idle: "未连接",
  connecting: "连接中",
  ready: "已连接",
  backoff: "失败退避",
};

const LIFECYCLE_LABEL: Record<"lazy" | "eager" | "keep-alive", string> = {
  lazy: "lazy（默认：空闲断开）",
  eager: "eager（保持连接）",
  "keep-alive": "keep-alive（保持连接）",
};

const STATE_DOT: Record<McpServerEntry["status"]["state"], string> = {
  idle: "bg-muted-foreground/40",
  connecting: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
  backoff: "bg-destructive",
};

/** 非 loopback 明文 HTTP 检测（与 sidecar 校验口径一致：允许但强制警示） */
export function isNonLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
    return !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

type FormDraft = {
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  description: string;
  lifecycle: "lazy" | "eager" | "keep-alive";
  approveToolsText: string;
};

const EMPTY_FORM: FormDraft = {
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  url: "",
  headersText: "",
  description: "",
  lifecycle: "lazy",
  approveToolsText: "",
};

/** "A=1\nB=2" → Record（忽略空行与无 = 的行） */
function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function keyValuesToText(map: Record<string, string> | undefined): string {
  if (!map) return "";
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function entryToForm(entry: McpServerEntry): FormDraft {
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command ?? "",
    argsText: (entry.args ?? []).join("\n"),
    envText: keyValuesToText(entry.env),
    url: entry.url ?? "",
    headersText: keyValuesToText(entry.headers),
    description: entry.description ?? "",
    lifecycle: entry.lifecycle ?? "lazy",
    approveToolsText: (entry.approveTools ?? []).join(", "),
  };
}

function formToDraft(form: FormDraft): McpServerDraft {
  const args = form.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const approve = form.approveToolsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: form.name.trim(),
    transport: form.transport,
    ...(form.transport === "stdio"
      ? {
          command: form.command.trim(),
          ...(args.length ? { args } : {}),
        }
      : {
          url: form.url.trim(),
        }),
    description: form.description.trim() || undefined,
    lifecycle: form.lifecycle,
    ...(approve.length ? { approveTools: approve } : {}),
  };
}

type EditorTarget =
  | { mode: "create"; layer: "system" | "workspace" }
  | { mode: "edit"; entry: McpServerEntry };

const McpEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  workspaceCwd: string | null;
}> = ({ open, onOpenChange, target, workspaceCwd }) => {
  const isEdit = target?.mode === "edit";
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setForm(target.mode === "edit" ? entryToForm(target.entry) : EMPTY_FORM);
    setError(null);
    setBusy(false);
  }, [open, target]);

  if (!target) return null;
  const layer = target.mode === "create" ? target.layer : target.entry.layer;
  const layerNeedsCwd = layer === "workspace" && !workspaceCwd;
  const insecureHttp =
    form.transport === "http" && isNonLoopbackHttpUrl(form.url);

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer,
        cwd: layer === "workspace" ? workspaceCwd ?? undefined : undefined,
        ...(isEdit && target.mode === "edit" ? { name: target.entry.name } : {}),
        definition: formToDraft(form),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target.mode === "create"
              ? layer === "workspace"
                ? "新建工作区 MCP 服务器"
                : "新建系统 MCP 服务器"
              : `编辑 ${target.entry.name}`}
          </DialogTitle>
          <DialogDescription>
            {layer === "workspace"
              ? `保存到 ${workspaceCwd ?? ""}/.xulux/mcp.json（随仓库共享；不改写 .mcp.json）`
              : "保存到 ~/.xulux/mcp.json，对本机所有工作区生效"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">名称</span>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="如 github（字母/数字/_/-，≤64）"
                className="font-mono"
              />
            </label>
            <div className="flex shrink-0 flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">传输</span>
              <Segmented
                value={form.transport}
                options={[
                  { value: "stdio", label: "本地进程" },
                  { value: "http", label: "HTTP" },
                ]}
                onChange={(t) => setField("transport", t)}
              />
            </div>
          </div>

          {form.transport === "stdio" ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">启动命令</span>
                <Input
                  value={form.command}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder="如 npx（不含 .. 的命令名或绝对路径）"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">参数（每行一个）</span>
                <Textarea
                  value={form.argsText}
                  onChange={(e) => setField("argsText", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={"-y\n@modelcontextprotocol/server-xxx"}
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">端点 URL</span>
                <Input
                  value={form.url}
                  onChange={(e) => setField("url", e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">请求头（每行 Key=Value）</span>
                <Textarea
                  value={form.headersText}
                  onChange={(e) => setField("headersText", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={"Authorization=Bearer ..."}
                  spellCheck={false}
                />
              </label>
            </>
          )}

          {form.transport === "stdio" && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                环境变量（每行 KEY=value；只有这里声明的变量会传给子进程）
              </span>
              <Textarea
                value={form.envText}
                onChange={(e) => setField("envText", e.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder={"GITHUB_TOKEN=..."}
                spellCheck={false}
              />
            </label>
          )}

          {insecureHttp && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>
                这是非环回的明文 HTTP 端点：凭证与工具调用内容可能被网络截获。保存即表示你知晓并接受该风险。
              </span>
            </div>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">描述（注入系统提示词，帮助模型选择）</span>
            <Input
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="如 GitHub API：仓库、issue、PR 操作"
            />
          </label>

          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs transition-colors">
              高级选项
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-3">
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-muted-foreground text-xs">生命周期</span>
                  <select
                    value={form.lifecycle}
                    onChange={(e) =>
                      setField("lifecycle", e.target.value as FormDraft["lifecycle"])
                    }
                    className="border-input bg-background h-8 rounded-lg border px-2 text-xs"
                  >
                    <option value="">lazy（默认：空闲断开）</option>
                    <option value="keep-alive">keep-alive（保持连接）</option>
                    <option value="eager">eager（保持连接）</option>
                  </select>
                </label>
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    免审批工具（逗号分隔 glob，如 get_*, list_*）
                  </span>
                  <Input
                    value={form.approveToolsText}
                    onChange={(e) => setField("approveToolsText", e.target.value)}
                    placeholder="留空 = 每次调用都需确认"
                    className="font-mono text-xs"
                  />
                </label>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {layerNeedsCwd && (
          <p className="text-muted-foreground text-xs">
            未选择工作区：先在主界面选好工作目录，或改用"新建系统级"。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || layerNeedsCwd}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const McpRow: FC<{
  entry: McpServerEntry;
  workspaceCwd: string | null;
  testing: boolean;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  entry,
  workspaceCwd,
  testing,
  confirmingDelete,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onConfirmDelete,
}) => {
  const status = entry.status;
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-xl px-3 py-2 transition-colors">
      <div className="relative shrink-0">
        {entry.transport === "http" ? (
          <ServerIcon className="text-muted-foreground size-4" />
        ) : (
          <SquareTerminalIcon className="text-muted-foreground size-4" />
        )}
        <span
          className={cn(
            "absolute -right-1 -bottom-1 size-2 rounded-full ring-2 ring-background",
            STATE_DOT[status.state],
          )}
          title={STATE_LABEL[status.state]}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {LAYER_LABEL[entry.layer]}
          </Badge>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {entry.transport}
          </Badge>
          {status.state === "ready" && (
            <span className="text-emerald-600 dark:text-emerald-400 shrink-0 text-[10px]">
              {status.toolCount} 个工具
            </span>
          )}
          {(status.state === "backoff" || status.state === "connecting") && (
            <span className="text-muted-foreground max-w-48 truncate text-[10px]">
              {status.message ?? STATE_LABEL[status.state]}
            </span>
          )}
          {entry.source && (
            <span className="text-muted-foreground hidden truncate font-mono text-[10px] lg:block">
              {entry.layer === "workspace" && workspaceCwd && entry.source.startsWith(workspaceCwd + "/")
                ? entry.source.slice(workspaceCwd.length + 1)
                : entry.source}
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {entry.description || entry.transport === "http"
            ? (entry.url ?? entry.command ?? "")
            : (entry.command ?? "")}
        </div>
      </div>
      <Switch
        size="sm"
        checked={entry.enabled}
        onCheckedChange={onToggle}
        aria-label={`${entry.name} 启用`}
      />
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onTest}
          disabled={testing}
          title="强制重新握手并统计工具"
        >
          {testing ? "测试中…" : "测试"}
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title="编辑">
          <PencilIcon className="size-3.5" />
        </Button>
        {!entry.fromStandard &&
          (confirmingDelete ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onConfirmDelete}
            >
              <CheckIcon className="size-3.5" />
              确认删除
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive size-7"
              onClick={onDelete}
              title="删除"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ))}
      </div>
    </div>
  );
};

export const McpSettings: FC = () => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useMcpServers(viewingCwd);
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget | null }>({
    open: false,
    target: null,
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testingName, setTestingName] = useState<string | null>(null);

  const groups = useMemo(
    () => ({
      system: snap.servers.filter((e) => e.layer === "system"),
      workspace: snap.servers.filter((e) => e.layer === "workspace"),
    }),
    [snap.servers],
  );

  const toggle = (entry: McpServerEntry, enabled: boolean) => {
    void setMcpServerEnabled(
      entry.layer,
      entry.name,
      enabled,
      entry.layer === "workspace" ? viewingCwd : undefined,
    ).catch(() => {});
  };

  const remove = (entry: McpServerEntry) => {
    void deleteMcpServer(
      entry.layer,
      entry.name,
      entry.layer === "workspace" ? viewingCwd : undefined,
    ).catch(() => {});
    setConfirmDelete(null);
  };

  const test = async (entry: McpServerEntry) => {
    if (testingName) return;
    setTestingName(entry.name);
    try {
      await testMcpServer(
        entry.layer,
        entry.name,
        entry.layer === "workspace" ? viewingCwd : undefined,
      );
    } catch {
      // 状态徽章已反映失败；这里无需额外动作
    } finally {
      setTestingName(null);
    }
  };

  const workspaceCandidates = useMemo(() => {
    const list = [overrideCwd, workspace, ...recents].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    return Array.from(new Set(list));
  }, [overrideCwd, workspace, recents]);

  const renderSection = (
    title: string,
    desc: string,
    entries: McpServerEntry[],
    actions?: React.ReactNode,
  ) => (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4 px-3 pt-2 pb-1">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground text-xs">{desc}</p>
        </div>
        {actions}
      </div>
      {entries.length === 0 ? (
        <div className="text-muted-foreground px-3 py-2 text-xs">暂无</div>
      ) : (
        entries.map((entry) => (
          <McpRow
            key={`${entry.layer}:${entry.name}`}
            entry={entry}
            workspaceCwd={snap.workspaceCwd}
            testing={testingName === entry.name}
            confirmingDelete={confirmDelete === `${entry.layer}:${entry.name}`}
            onToggle={(enabled) => toggle(entry, enabled)}
            onTest={() => void test(entry)}
            onEdit={() => setEditor({ open: true, target: { mode: "edit", entry } })}
            onDelete={() => setConfirmDelete(`${entry.layer}:${entry.name}`)}
            onConfirmDelete={() => remove(entry)}
          />
        ))
      )}
    </section>
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <PlugIcon className="size-5" />
            MCP 服务器
          </h1>
          <p className="text-muted-foreground text-sm">
            配置 Model Context Protocol 服务器，agent 通过 <code className="bg-muted rounded px-1 font-mono text-xs">mcp</code>{" "}
            网关工具按需发现并调用其能力（默认空闲断开；每次调用需确认，可用免审批名单放行只读工具）。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditor({ open: true, target: { mode: "create", layer: "system" } })}
          >
            <PlusIcon className="size-3.5" />
            新建系统级
          </Button>
          <Button
            size="sm"
            onClick={() => setEditor({ open: true, target: { mode: "create", layer: "workspace" } })}
            disabled={!viewingCwd}
            title={viewingCwd ?? "先在主界面选择工作区"}
          >
            <PlusIcon className="size-3.5" />
            新建工作区级
          </Button>
        </div>
      </header>

      {snap.error && (
        <section className="border-amber-500/40 bg-amber-500/5 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5">
          <span className="text-sm">MCP 清单加载失败：{snap.error}</span>
          <Button size="sm" variant="outline" onClick={() => void refreshMcpServers(viewingCwd)}>
            重试
          </Button>
        </section>
      )}

      {renderSection(
        "系统级",
        "存于 ~/.xulux/mcp.json，对本机所有工作区生效。",
        groups.system,
      )}
      {viewingCwd ? (
        renderSection(
          `工作区 · ${pathBasename(viewingCwd)}`,
          `合并 ${viewingCwd}/.mcp.json（共享）与 .xulux/mcp.json（覆盖层）；设置页只写覆盖层。`,
          groups.workspace,
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  title={viewingCwd ?? undefined}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0" />
                  <span className="max-w-44 truncate">{pathBasename(viewingCwd)}</span>
                  <ChevronDownIcon className="size-3 shrink-0" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-72">
              {workspaceCandidates.map((dir) => (
                <DropdownMenuCheckboxItem
                  key={dir}
                  checked={dir === viewingCwd}
                  onCheckedChange={(checked) => {
                    if (checked) setOverrideCwd(dir === workspace ? null : dir);
                  }}
                  title={dir}
                >
                  <span className="truncate">{pathBasename(dir)}</span>
                </DropdownMenuCheckboxItem>
              ))}
              {workspaceCandidates.length === 0 && (
                <div className="text-muted-foreground px-2 py-3 text-center text-xs">暂无记录</div>
              )}
              {overrideCwd !== null && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setOverrideCwd(null)}>
                    跟随当前工作区{workspace ? ` · ${pathBasename(workspace)}` : ""}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>,
        )
      ) : (
        <section className="text-muted-foreground flex flex-col items-start gap-2 rounded-2xl border border-dashed p-4 text-xs">
          <span>
            未选择工作区：在主界面选好工作目录后即可管理该工作区的 MCP 配置（.mcp.json /
            .xulux/mcp.json）。
          </span>
        </section>
      )}

      {snap.diagnostics.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer px-3">
            加载诊断（{snap.diagnostics.length}）
          </summary>
          <ul className="text-muted-foreground mt-1 list-disc pl-8">
            {snap.diagnostics.map((d, i) => (
              <li key={i} className="font-mono text-[11px]">
                {d}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-muted-foreground flex items-center gap-1.5 px-3 text-xs">
        <CopyIcon className="size-3" />
        工作区共享文件 .mcp.json 兼容生态标准格式（mcpServers map），Claude Code / Cursor
        等工具可直接复用同一份配置。
      </p>

      <McpEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        target={editor.target}
        workspaceCwd={viewingCwd}
      />
    </div>
  );
};
