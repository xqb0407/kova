"use client";

/**
 * 子智能体设置页（设置 → 智能体 → 子智能体）。
 *
 * 事实源在 sidecar：三层定义（内置常量 / <app_data>/subagents / <cwd>/.xulux/subagents）
 * + kv 里的启用开关；本页只渲染 useSubagents 镜像并发起变更命令。
 * 能力边界与 sidecar 对齐：内置只读（可查看/开关/复制为系统级）；系统/工作区
 * 可编辑可删除，工作区层随所选目录呈现。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isTauri } from "@/lib/tauri";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace-store";
import {
  deleteSubagent,
  refreshSubagents,
  saveSubagent,
  setSubagentEnabled,
  useSubagents,
  type SubagentDraft,
  type SubagentEntry,
} from "@/lib/subagents";

/** 可声明的工具全集（与 sidecar KNOWN_TOOLS 对齐） */
const TOOL_OPTIONS = ["read", "glob", "grep", "bash", "edit", "write"] as const;

const SCOPE_LABEL: Record<SubagentEntry["scope"], string> = {
  builtin: "内置",
  system: "系统",
  workspace: "工作区",
};

/** 表单草稿（maxTurns 用字符串承载，空 = 不设置） */
type FormDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns: string;
  model: string;
  prompt: string;
};

const EMPTY_FORM: FormDraft = {
  name: "",
  description: "",
  tools: ["read", "glob", "grep"],
  maxTurns: "",
  model: "",
  prompt: "",
};

function entryToForm(entry: SubagentEntry): FormDraft {
  return {
    name: entry.name,
    description: entry.description,
    tools: entry.tools,
    maxTurns: entry.maxTurns !== undefined ? String(entry.maxTurns) : "",
    model: entry.model ?? "",
    prompt: entry.prompt,
  };
}

function formToDraft(form: FormDraft): SubagentDraft {
  const maxTurns = Number(form.maxTurns);
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    tools: form.tools,
    prompt: form.prompt,
    ...(form.maxTurns.trim() && Number.isFinite(maxTurns) && maxTurns > 0
      ? { maxTurns: Math.floor(maxTurns) }
      : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
  };
}

/** 表单 → YAML 文本（仅用于新建时的初始展示；合法性与回读以 sidecar 解析为准） */
function formToYaml(form: FormDraft): string {
  const lines = [
    "# Xulux subagent definition — managed via Settings → Subagents",
    `name: ${JSON.stringify(form.name.trim())}`,
    `description: ${JSON.stringify(form.description.trim())}`,
    `tools: [${form.tools.join(", ")}]`,
  ];
  const maxTurns = Number(form.maxTurns);
  if (form.maxTurns.trim() && Number.isFinite(maxTurns) && maxTurns > 0) {
    lines.push(`maxTurns: ${Math.floor(maxTurns)}`);
  }
  if (form.model.trim()) lines.push(`model: ${form.model.trim()}`);
  lines.push("prompt: |");
  const body = form.prompt.endsWith("\n") ? form.prompt : `${form.prompt}\n`;
  for (const line of body.split("\n")) lines.push(line ? `  ${line}` : "");
  return lines.join("\n");
}

/** 弹窗的目标：新建 / 编辑既有 / 把内置复制为系统级 */
type EditorTarget =
  | { mode: "create"; scope: "system" | "workspace" }
  | { mode: "edit"; entry: SubagentEntry }
  | { mode: "copy"; entry: SubagentEntry };

function editorScope(target: EditorTarget): "system" | "workspace" {
  if (target.mode === "create") return target.scope;
  return target.entry.scope === "workspace" ? "workspace" : "system";
}

// ---------------------------------------------------------------------------
// 编辑 / 查看弹窗
// ---------------------------------------------------------------------------

const SubagentEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  /** 工作区层保存所需的 cwd（当前选中工作区） */
  workspaceCwd: string | null;
}> = ({ open, onOpenChange, target, workspaceCwd }) => {
  const isEdit = target?.mode === "edit";
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [yaml, setYaml] = useState("");
  const [tab, setTab] = useState("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时回填（编辑途中不随外部清单刷新重置）
  useEffect(() => {
    if (!open || !target) return;
    const seed =
      target.mode === "create"
        ? EMPTY_FORM
        : target.mode === "copy"
          ? { ...entryToForm(target.entry), name: `${target.entry.name}-copy` }
          : entryToForm(target.entry);
    setForm(seed);
    setYaml(
      target.mode === "edit" && target.entry.raw
        ? target.entry.raw
        : target.mode === "copy" && target.entry.raw
          ? formToYaml(seed)
          : formToYaml(seed),
    );
    setTab("form");
    setError(null);
    setBusy(false);
  }, [open, target]);

  if (!target) return null;
  const scope = editorScope(target);
  const scopeNeedsCwd = scope === "workspace" && !workspaceCwd;

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleTool = (tool: string) =>
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(tool)
        ? f.tools.filter((t) => t !== tool)
        : [...f.tools, tool],
    }));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSubagent({
        scope,
        cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
        ...(isEdit ? { name: target.entry.name } : {}),
        ...(tab === "yaml"
          ? { raw: yaml }
          : { definition: formToDraft(form) }),
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
              ? "新建子智能体"
              : target.mode === "copy"
                ? "复制为系统级子智能体"
                : `编辑 ${target.entry.name}`}
          </DialogTitle>
          <DialogDescription>
            {scope === "workspace"
              ? `保存到所选工作区 ${workspaceCwd ?? ""}/.xulux/subagents/（随仓库共享）`
              : "保存到应用数据目录，对本机所有会话生效"}
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <TabsList className="h-8 rounded-full p-[3px]">
            <TabsTrigger value="form" className="rounded-full px-3 py-0 text-xs">
              表单
            </TabsTrigger>
            <TabsTrigger value="yaml" className="rounded-full px-3 py-0 text-xs">
              YAML 原文
            </TabsTrigger>
          </TabsList>
          <TabsContent value="form" className="flex flex-col gap-3 pt-2">
            <div className="flex gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">名称</span>
                <Input
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="如 api-auditor"
                />
              </label>
              <label className="flex w-28 shrink-0 flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">轮次上限</span>
                <Input
                  value={form.maxTurns}
                  onChange={(e) => setField("maxTurns", e.target.value)}
                  placeholder="如 40"
                  inputMode="numeric"
                />
              </label>
              <label className="flex w-48 shrink-0 flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">模型（留空继承会话）</span>
                <Input
                  value={form.model}
                  onChange={(e) => setField("model", e.target.value)}
                  placeholder="provider/modelId"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                描述（主代理据此决定何时委派）
              </span>
              <Textarea
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                rows={2}
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">可用工具</span>
              <div className="flex flex-wrap gap-1.5">
                {TOOL_OPTIONS.map((tool) => {
                  const active = form.tools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors",
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                系统提示词（delegate 的行为说明）
              </span>
              <Textarea
                value={form.prompt}
                onChange={(e) => setField("prompt", e.target.value)}
                rows={10}
                className="font-mono text-xs"
              />
            </label>
          </TabsContent>
          <TabsContent value="yaml" className="pt-2">
            <Textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={18}
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-muted-foreground pt-1 text-xs">
              保存时由 sidecar 以与加载定义文件完全相同的解析校验处理；表单页签的内容不会覆盖此处编辑。
            </p>
          </TabsContent>
        </Tabs>
        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {scopeNeedsCwd && (
          <p className="text-muted-foreground text-xs">
            未选择工作区：先在主界面选好工作目录，或改用"新建系统级"。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || scopeNeedsCwd}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** 内置定义的只读查看弹窗 */
const BuiltinViewDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: SubagentEntry | null;
  onCopy: (entry: SubagentEntry) => void;
}> = ({ open, onOpenChange, entry, onCopy }) => {
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry.name}
            <Badge variant="secondary" className="ml-2 align-middle">
              内置 · 只读
            </Badge>
          </DialogTitle>
          <DialogDescription>{entry.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {entry.tools.map((t) => (
            <span key={t} className="bg-muted rounded-full px-2 py-0.5 font-mono">
              {t}
            </span>
          ))}
          {entry.maxTurns !== undefined && (
            <span className="text-muted-foreground px-1">maxTurns: {entry.maxTurns}</span>
          )}
          {entry.model && (
            <span className="text-muted-foreground px-1 font-mono">{entry.model}</span>
          )}
        </div>
        <pre className="bg-muted/50 max-h-80 overflow-y-auto rounded-xl p-4 text-xs whitespace-pre-wrap">
          {entry.prompt}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onCopy(entry);
            }}
          >
            <CopyIcon className="size-3.5" />
            复制为系统级
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 列表行
// ---------------------------------------------------------------------------

const SubagentRow: FC<{
  entry: SubagentEntry;
  workspaceCwd: string | null;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  entry,
  workspaceCwd,
  confirmingDelete,
  onToggle,
  onView,
  onEdit,
  onCopy,
  onDelete,
  onConfirmDelete,
}) => (
  <div className="hover:bg-muted/40 flex items-center gap-3 rounded-xl px-3 py-2 transition-colors">
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{entry.name}</span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {SCOPE_LABEL[entry.scope]}
        </Badge>
        {entry.path && (
          <span className="text-muted-foreground hidden truncate font-mono text-[10px] lg:block">
            {entry.scope === "workspace" &&
            workspaceCwd &&
            entry.path.startsWith(workspaceCwd + "/")
              ? entry.path.slice(workspaceCwd.length + 1)
              : entry.path}
          </span>
        )}
      </div>
      <div className="text-muted-foreground truncate text-xs">{entry.description}</div>
    </div>
    <Switch
      size="sm"
      checked={entry.enabled}
      onCheckedChange={onToggle}
      aria-label={`${entry.name} 启用`}
    />
    <div className="flex shrink-0 items-center gap-1">
      {!entry.editable && (
        <Button variant="ghost" size="icon" className="size-7" onClick={onView} title="查看定义">
          <EyeIcon className="size-3.5" />
        </Button>
      )}
      {entry.editable ? (
        <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title="编辑">
          <PencilIcon className="size-3.5" />
        </Button>
      ) : (
        <Button variant="ghost" size="icon" className="size-7" onClick={onCopy} title="复制为系统级">
          <CopyIcon className="size-3.5" />
        </Button>
      )}
      {entry.editable &&
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

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区区块的目录切换器：候选 = 手动浏览的目录 + 当前工作区 + 最近使用。
 *  只切换本页查看的工作区级定义来源，不改动主界面的工作区选择。 */
const WorkspaceCwdMenu: FC<{
  value: string;
  following: boolean;
  followLabel: string | null;
  candidates: string[];
  showBrowse: boolean;
  onChange: (dir: string) => void;
  onFollowCurrent: () => void;
  onBrowse: () => void;
}> = ({
  value,
  following,
  followLabel,
  candidates,
  showBrowse,
  onChange,
  onFollowCurrent,
  onBrowse,
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <button
          type="button"
          title={value}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">{pathBasename(value)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      }
    />
    <DropdownMenuContent align="end" className="w-72">
      {candidates.map((dir) => (
        <DropdownMenuCheckboxItem
          key={dir}
          checked={dir === value}
          onCheckedChange={(checked) => {
            if (checked) onChange(dir);
          }}
          title={dir}
        >
          <span className="truncate">{pathBasename(dir)}</span>
        </DropdownMenuCheckboxItem>
      ))}
      {candidates.length === 0 && (
        <div className="text-muted-foreground px-2 py-3 text-center text-xs">
          暂无记录
        </div>
      )}
      {!following && followLabel && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFollowCurrent}>
            跟随当前工作区 · {followLabel}
          </DropdownMenuItem>
        </>
      )}
      {showBrowse && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onBrowse}>
            <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
            浏览其他目录…
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const SubagentsSettings: FC = () => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  // 工作区级区块允许浏览任意目录：overrideCwd 为 null 时跟随主界面当前工作区，
  // 手动切换/浏览仅改变本页查看与增删改的目标目录，不影响主界面选择。
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useSubagents(viewingCwd);
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget | null }>({
    open: false,
    target: null,
  });
  const [viewing, setViewing] = useState<SubagentEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const groups = useMemo(
    () => ({
      builtin: snap.agents.filter((e) => e.scope === "builtin"),
      system: snap.agents.filter((e) => e.scope === "system"),
      workspace: snap.agents.filter((e) => e.scope === "workspace"),
    }),
    [snap.agents],
  );

  const toggle = (entry: SubagentEntry, enabled: boolean) => {
    void setSubagentEnabled(entry.scope, entry.name, enabled, viewingCwd).catch(() => {});
  };

  const remove = (entry: SubagentEntry) => {
    const scope = entry.scope === "workspace" ? "workspace" : "system";
    void deleteSubagent(scope, entry.name, viewingCwd).catch(() => {});
    setConfirmDelete(null);
  };

  const workspaceCandidates = useMemo(() => {
    const list = [overrideCwd, workspace, ...recents].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    return Array.from(new Set(list));
  }, [overrideCwd, workspace, recents]);

  const switchWorkspaceView = (dir: string) =>
    setOverrideCwd(dir === workspace ? null : dir);

  /** 只读浏览：弹原生目录选择器，但不改主界面工作区（区别于 openWorkspacePicker） */
  const pickBrowseDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        directory: true,
        multiple: false,
        title: "浏览工作区的子智能体定义",
      });
      if (typeof dir === "string") switchWorkspaceView(dir);
    } catch {
      // 非 Tauri 环境：无原生目录选择器
    }
  };

  const openEditor = (target: EditorTarget) => setEditor({ open: true, target });

  const renderSection = (
    title: string,
    desc: string,
    entries: SubagentEntry[],
    actions?: ReactNode,
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
          <SubagentRow
            key={`${entry.scope}:${entry.name}`}
            entry={entry}
            workspaceCwd={snap.workspaceCwd}
            confirmingDelete={confirmDelete === `${entry.scope}:${entry.name}`}
            onToggle={(enabled) => toggle(entry, enabled)}
            onView={() => setViewing(entry)}
            onEdit={() => openEditor({ mode: "edit", entry })}
            onCopy={() => openEditor({ mode: "copy", entry })}
            onDelete={() => setConfirmDelete(`${entry.scope}:${entry.name}`)}
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
            <BotIcon className="size-5" />
            子智能体
          </h1>
          <p className="text-muted-foreground text-sm">
            管理主代理可委派的子智能体（Task 工具）。内置定义只读、可开关；
            自定义定义以 YAML 存储，改动即时生效，无需重启。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => openEditor({ mode: "create", scope: "system" })}>
            <PlusIcon className="size-3.5" />
            新建系统级
          </Button>
          <Button
            size="sm"
            onClick={() => openEditor({ mode: "create", scope: "workspace" })}
            disabled={!viewingCwd}
            title={
              viewingCwd ??
              "先在主界面选择工作区，或在下方「工作区」区块选择目录浏览"
            }
          >
            <PlusIcon className="size-3.5" />
            新建工作区级
          </Button>
        </div>
      </header>

      {/* 清单加载失败：镜像停留在旧值，明确提示并可重试 */}
      {snap.error && (
        <section className="border-amber-500/40 bg-amber-500/5 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5">
          <span className="text-sm">子智能体清单加载失败：{snap.error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshSubagents(viewingCwd)}
          >
            重试
          </Button>
        </section>
      )}

      {renderSection(
        "内置",
        "随应用发布的四个 delegate：只读，可关闭，可复制为系统级后定制。",
        groups.builtin,
      )}
      {renderSection(
        "系统级",
        "存于应用数据目录 subagents/，对本机所有工作区生效。",
        groups.system,
      )}
      {viewingCwd ? (
        renderSection(
          `工作区 · ${pathBasename(viewingCwd)}`,
          `存于 ${viewingCwd}/.xulux/subagents/，随仓库共享。`,
          groups.workspace,
          <WorkspaceCwdMenu
            value={viewingCwd}
            following={overrideCwd === null}
            followLabel={workspace ? pathBasename(workspace) : null}
            candidates={workspaceCandidates}
            showBrowse={isTauri()}
            onChange={switchWorkspaceView}
            onFollowCurrent={() => setOverrideCwd(null)}
            onBrowse={() => void pickBrowseDir()}
          />,
        )
      ) : (
        <section className="text-muted-foreground flex flex-col items-start gap-2 rounded-2xl border border-dashed p-4 text-xs">
          <span>
            未选择工作区：在主界面选好工作目录后即可管理该工作区的子智能体；
            也可以直接浏览某个仓库目录的 .xulux/subagents/ 定义。
          </span>
          {isTauri() && (
            <Button size="sm" variant="outline" onClick={() => void pickBrowseDir()}>
              <FolderOpenIcon className="size-3.5" />
              选择目录浏览…
            </Button>
          )}
        </section>
      )}

      {snap.diagnostics.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer px-3">
            加载诊断（{snap.diagnostics.length}）
          </summary>
          <ul className="text-muted-foreground mt-1 list-disc pl-8">
            {snap.diagnostics.map((d) => (
              <li key={d} className="font-mono text-[11px]">
                {d}
              </li>
            ))}
          </ul>
        </details>
      )}

      <SubagentEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        target={editor.target}
        workspaceCwd={viewingCwd}
      />
      <BuiltinViewDialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        entry={viewing}
        onCopy={(entry) => openEditor({ mode: "copy", entry })}
      />
    </div>
  );
};
