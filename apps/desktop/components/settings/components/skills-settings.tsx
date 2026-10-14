"use client";

/**
 * 技能设置页（设置 → 智能体 → 技能）。
 *
 * 事实源在 sidecar：托管层 .md 文档（<app_data>/skills / <cwd>/.kova/skills）
 * + 生态兼容层（.agents/skills，agentskills.io 标准，只读发现）+ kv 里的启用开关；
 * 本页只渲染 useSkills 镜像并发起变更命令。
 * 注入模型的是生效技能的目录元数据（name/description/location 三行），正文由
 * 模型按需 read；同名遮蔽 工作区 > 生态·工作区 > 系统 > 生态·用户。
 *
 * 版式与 MCP 页同款：作用域页签 + 搜索/刷新/创建工具行 + bg-muted/50 卡片列表，
 * 行 = 作用域图标盒 + 名称/徽标/描述 + 行内操作 + Switch。技能常几十个，
 * 页签隔离 + 搜索是第一交互，不做长页堆叠。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  BlocksIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  FolderGit2Icon,
  GlobeIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquarePenIcon,
  Trash2Icon,
  ToggleLeftIcon,
  ToggleRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isTauri } from "@/lib/tauri";
import {
  pathBasename,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace/workspace-store";
import {
  deleteSkill,
  refreshSkills,
  saveSkill,
  setSkillEnabled,
  setSkillsEnabled,
  skillTemplate,
  useSkills,
  type SkillDraft,
  type SkillEntry,
} from "@/lib/skills/skills";

/** 与 sidecar MAX_SKILL_BYTES 对齐（128 KB） */
const MAX_SKILL_BYTES = 128 * 1024;

/** 作用域页签：生态兼容页合并展示 用户/工作区 两个只读层（行内徽标区分） */
type ScopeTab = "system" | "workspace" | "compat";

const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  system: "系统",
  workspace: "工作区",
  compat: "生态 · 用户",
  "compat-workspace": "生态 · 工作区",
  plugin: "插件",
};

/** 表单草稿（正文承载用户编辑的 Markdown；字节数实时提示上限） */
type FormDraft = {
  name: string;
  description: string;
  content: string;
  disableModelInvocation: boolean;
};

function entryToForm(entry: SkillEntry): FormDraft {
  return {
    name: entry.name,
    description: entry.description,
    content: entry.content,
    disableModelInvocation: entry.disableModelInvocation === true,
  };
}

function formToDraft(form: FormDraft): SkillDraft {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    content: form.content,
    ...(form.disableModelInvocation ? { disableModelInvocation: true } : {}),
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 弹窗的目标：新建 / 编辑既有 / 导入 Markdown 文档 */
type EditorTarget =
  | { mode: "create"; scope: "system" | "workspace" }
  | { mode: "edit"; entry: SkillEntry }
  | { mode: "import"; scope: "system" | "workspace" };

function editorScope(target: EditorTarget): "system" | "workspace" {
  if (target.mode === "edit") return target.entry.scope === "workspace" ? "workspace" : "system";
  return target.scope;
}

// ---------------------------------------------------------------------------
// 编辑 / 导入弹窗
// ---------------------------------------------------------------------------

const SkillEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  /** 工作区层保存所需的 cwd（当前选中工作区） */
  workspaceCwd: string | null;
}> = ({ open, onOpenChange, target, workspaceCwd }) => {
  const isEdit = target?.mode === "edit";
  const isImport = target?.mode === "import";
  const [form, setForm] = useState<FormDraft>({
    name: "",
    description: "",
    content: skillTemplate(""),
    disableModelInvocation: false,
  });
  const [raw, setRaw] = useState("");
  const [fallbackName, setFallbackName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时回填（编辑途中不随外部清单刷新重置）
  useEffect(() => {
    if (!open || !target) return;
    setForm(
      target.mode === "edit"
        ? entryToForm(target.entry)
        : {
            name: "",
            description: "",
            content: skillTemplate(""),
            disableModelInvocation: false,
          },
    );
    setRaw("");
    setFallbackName("");
    setError(null);
    setBusy(false);
  }, [open, target]);

  if (!target) return null;
  const scope = editorScope(target);
  const scopeNeedsCwd = scope === "workspace" && !workspaceCwd;
  const docBytes = byteLength(
    `---\nname: ${form.name}\ndescription: ${form.description}\n---\n\n${form.content}`,
  );

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSkill({
        scope,
        cwd: scope === "workspace" ? workspaceCwd ?? undefined : undefined,
        ...(isEdit ? { name: target.entry.name } : {}),
        ...(isImport
          ? { raw, ...(fallbackName.trim() ? { fallbackName: fallbackName.trim() } : {}) }
          : { draft: formToDraft(form) }),
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
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target.mode === "create"
              ? "新建技能"
              : target.mode === "import"
                ? "导入技能 Markdown"
                : `编辑 ${target.entry.name}`}
          </DialogTitle>
          <DialogDescription>
            {scope === "workspace"
              ? `保存到 ${workspaceCwd ?? ""}/.kova/skills/（随仓库共享）`
              : "保存到应用数据目录 skills/，对本机所有会话生效"}
          </DialogDescription>
        </DialogHeader>
        {isImport ? (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                SKILL.md 原文（frontmatter + 正文；生态目录的技能文件可直接粘贴，保存时由
                sidecar 以与加载完全相同的规则解析校验）
              </span>
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                rows={14}
                className="font-mono text-xs"
                spellCheck={false}
                placeholder={
                  "---\nname: my-skill\ndescription: 何时使用该技能（模型据此判断）\n---\n\n# 步骤\n1. ..."
                }
              />
            </Label>
            <Label className="flex w-64 flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">文件名兜底（原文缺 name 时用）</span>
              <Input
                value={fallbackName}
                onChange={(e) => setFallbackName(e.target.value)}
                placeholder="如 pdf-export"
              />
            </Label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">名称</span>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="如 code-review"
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                描述（模型据此判断任务何时匹配该技能）
              </span>
              <Textarea
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                rows={2}
                placeholder="如 Review pull request diffs and provide actionable feedback."
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground flex w-full items-center justify-between text-xs">
                <span>正文（模型匹配后按需读取的指令；不占常驻上下文）</span>
                <span
                  className={cn(
                    "font-mono",
                    docBytes > MAX_SKILL_BYTES ? "text-destructive" : "text-muted-foreground/70",
                  )}
                >
                  {formatBytes(docBytes)} / 128 KB
                </span>
              </span>
              <Textarea
                value={form.content}
                onChange={(e) => setField("content", e.target.value)}
                rows={12}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </Label>
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.disableModelInvocation}
                onCheckedChange={(checked) => setField("disableModelInvocation", checked === true)}
              />
              <span className="text-muted-foreground">
                不出现在模型的技能目录（仅保留手动/工具触发路径）
              </span>
            </Label>
          </div>
        )}
        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        {scopeNeedsCwd && (
          <p className="text-muted-foreground text-xs">
            未选择工作区：先在主界面选好工作目录，或切到「系统级」页签。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy || scopeNeedsCwd || (isImport && !raw.trim())}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** 生态层技能的只读查看弹窗 */
const SkillViewDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: SkillEntry | null;
}> = ({ open, onOpenChange, entry }) => {
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry.name}
            <Badge variant="secondary" className="ml-2 align-middle">
              {SCOPE_LABEL[entry.scope]} · 只读
            </Badge>
          </DialogTitle>
          <DialogDescription>{entry.description}</DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground truncate font-mono text-xs" title={entry.path}>
          {entry.path}
        </p>
        <pre className="bg-muted/50 max-h-80 overflow-y-auto rounded-xl p-4 text-xs whitespace-pre-wrap">
          {entry.content}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 列表行（MCP 行同款：图标盒 + 名称/徽标/描述 + 行内操作 + Switch）
// ---------------------------------------------------------------------------

const SCOPE_ICON: Record<SkillEntry["scope"], FC<{ className?: string }>> = {
  system: BlocksIcon,
  workspace: FolderGit2Icon,
  compat: GlobeIcon,
  "compat-workspace": GlobeIcon,
  plugin: BlocksIcon,
};

const SkillRow: FC<{
  entry: SkillEntry;
  workspaceCwd: string | null;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  entry,
  workspaceCwd,
  confirmingDelete,
  onToggle,
  onView,
  onEdit,
  onDelete,
  onConfirmDelete,
}) => {
  const Icon = SCOPE_ICON[entry.scope];
  const relPath =
    (entry.scope === "workspace" || entry.scope === "compat-workspace") &&
    workspaceCwd &&
    entry.path.startsWith(workspaceCwd + "/")
      ? entry.path.slice(workspaceCwd.length + 1)
      : entry.path;
  return (
    <div
      className={cn(
        "hover:bg-muted/70 flex items-center gap-3 rounded-xl px-3 py-2 transition-colors",
        entry.shadowed && "opacity-60",
      )}
    >
      {/* 作用域图标盒（记忆/MCP 行同款 size-9 边框盒） */}
      <div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <Badge variant="outline" className="shrink-0 text-xs">
            {SCOPE_LABEL[entry.scope]}
          </Badge>
          {entry.shadowed && (
            <Badge variant="outline" className="text-muted-foreground shrink-0 text-xs">
              被同名技能遮蔽
            </Badge>
          )}
          {entry.disableModelInvocation && (
            <Badge variant="outline" className="text-muted-foreground shrink-0 text-xs">
              不进目录
            </Badge>
          )}
          {entry.enabled && !entry.shadowed && (
            <span className="text-emerald-600 dark:text-emerald-400 shrink-0 text-xs">生效中</span>
          )}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate">{entry.description}</span>
          <span className="hidden shrink-0 font-mono text-xs lg:block">{formatBytes(entry.sizeBytes)}</span>
          <span className="hidden truncate font-mono text-xs xl:block" title={entry.path}>
            {relPath}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!entry.editable && (
          <Button variant="ghost" size="icon" className="size-7" onClick={onView} title="查看正文">
            <EyeIcon className="size-3.5" />
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
            <>
              <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title="编辑">
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-7"
                onClick={onDelete}
                title="删除"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </>
          ))}
        <Switch
          size="sm"
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={`${entry.name} 启用`}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区目录切换器（与 MCP/记忆/子智能体页同款）：候选 = 手动浏览 + 当前工作区 + 最近使用。
 *  value 为 null（未选工作区）时以「选择工作区」占位，下拉里仍可挑最近目录或浏览——
 *  不必先回主界面选好工作区才能管理。 */
const WorkspaceCwdMenu: FC<{
  value: string | null;
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
          title={value ?? "选择工作区"}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
        >
          <FolderGit2Icon className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">{value ? pathBasename(value) : "选择工作区"}</span>
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
        <div className="text-muted-foreground px-2 py-3 text-center text-xs">暂无记录</div>
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
            <FolderGit2Icon className="text-muted-foreground size-3.5 shrink-0" />
            浏览其他目录…
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const SkillsSettings: FC = () => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  // 工作区级区块允许浏览任意目录：overrideCwd 为 null 时跟随主界面当前工作区
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useSkills(viewingCwd);
  const [scopeTab, setScopeTab] = useState<ScopeTab>("system");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget | null }>({
    open: false,
    target: null,
  });
  const [viewing, setViewing] = useState<SkillEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const scopeSkills = useMemo(
    () =>
      snap.skills.filter((e) =>
        scopeTab === "compat"
          ? e.scope === "compat" || e.scope === "compat-workspace"
          : e.scope === scopeTab,
      ),
    [snap.skills, scopeTab],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopeSkills;
    return scopeSkills.filter((e) =>
      [e.name, e.description, e.path].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [scopeSkills, query]);

  const enabledCount = snap.skills.filter((e) => e.enabled).length;
  // 批量快捷的计数口径 = 当前页签 + 搜索筛选后的可见列表（所见即所得）
  const enabledVisible = visible.filter((e) => e.enabled).length;
  const disabledVisible = visible.length - enabledVisible;
  // 只有托管工作区层依赖所选目录；生态兼容页的用户层（~/.agents/skills）恒可见
  const tabNeedsCwd = scopeTab === "workspace" && !viewingCwd;

  const toggle = (entry: SkillEntry, enabled: boolean) => {
    void setSkillEnabled(
      entry.scope,
      entry.name,
      enabled,
      entry.scope === "workspace" || entry.scope === "compat-workspace" ? viewingCwd : null,
    ).catch(() => {});
  };

  /** 批量开关：一次请求把当前可见列表（页签 + 搜索筛选）全部置为目标状态 */
  const batchToggle = (enabled: boolean) => {
    const targets = visible.map((e) => ({ scope: e.scope, name: e.name }));
    if (targets.length === 0 || batchBusy) return;
    setBatchBusy(true);
    void setSkillsEnabled(targets, enabled, viewingCwd)
      .catch(() => {})
      .finally(() => setBatchBusy(false));
  };

  const remove = (entry: SkillEntry) => {
    void deleteSkill(
      entry.scope === "workspace" ? "workspace" : "system",
      entry.name,
      entry.scope === "workspace" ? viewingCwd : null,
    ).catch(() => {});
    setConfirmDelete(null);
  };

  const refresh = () => {
    setRefreshing(true);
    void refreshSkills(viewingCwd).finally(() => setRefreshing(false));
  };

  const openCreate = () =>
    setEditor({
      open: true,
      target: { mode: "create", scope: scopeTab === "workspace" ? "workspace" : "system" },
    });

  const openImport = () =>
    setEditor({
      open: true,
      target: { mode: "import", scope: scopeTab === "workspace" ? "workspace" : "system" },
    });

  /** 只读浏览：弹原生目录选择器，但不改主界面工作区（与 MCP/记忆页同款语义） */
  const pickBrowseDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "浏览工作区技能目录" });
      if (typeof dir === "string") setOverrideCwd(dir === workspace ? null : dir);
    } catch {
      // 非 Tauri 环境：无原生目录选择器
    }
  };

  const cwdCandidates = useMemo(
    () =>
      Array.from(
        new Set([overrideCwd, workspace, ...recents].filter((d): d is string => Boolean(d))),
      ),
    [overrideCwd, workspace, recents],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-7xl flex-col gap-8 self-center px-8 py-8">
        {/* 标题行：状态文字在右（MCP/记忆页同款） */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">技能</h1>
          <span
            className={cn("text-xs", snap.error ? "text-destructive" : "text-muted-foreground")}
          >
            {snap.error
              ? "清单加载失败，可刷新重试"
              : `${snap.skills.length} 个技能（${enabledCount} 个启用）`}
          </span>
        </div>

        <section className="flex flex-col gap-3">
          {/* 工具行：作用域页签 + 工作区切换 + 计数 + 搜索/刷新/创建 */}
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as ScopeTab)}>
              <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
                <TabsTrigger value="system" className="rounded-full px-3 py-1 text-sm">
                  系统级
                </TabsTrigger>
                <TabsTrigger value="workspace" className="rounded-full px-3 py-1 text-sm">
                  工作区级
                </TabsTrigger>
                <TabsTrigger value="compat" className="rounded-full px-3 py-1 text-sm">
                  生态兼容
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {/* 工作区/生态兼容页签常驻目录选择器：未选工作区也能直接挑最近目录或浏览 */}
            {scopeTab !== "system" && (
              <WorkspaceCwdMenu
                value={viewingCwd}
                following={!overrideCwd}
                followLabel={workspace ? pathBasename(workspace) : null}
                candidates={cwdCandidates}
                showBrowse={isTauri()}
                onChange={(dir) => setOverrideCwd(dir === workspace ? null : dir)}
                onFollowCurrent={() => setOverrideCwd(null)}
                onBrowse={() => void pickBrowseDir()}
              />
            )}
            <span className="text-muted-foreground text-sm">{visible.length} 个技能</span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-56 bg-muted/50"
                placeholder="搜索名称 / 描述 / 路径…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {/* 批量开关：免去几十个技能一个个点（作用于当前页签可见列表，含搜索筛选） */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 gap-1 text-sm"
                      disabled={tabNeedsCwd || visible.length === 0 || batchBusy}
                      title="把当前列表的技能一键全部启用 / 关闭（含搜索筛选）"
                    />
                  }
                >
                  {batchBusy ? "处理中…" : "批量"}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={() => batchToggle(false)} disabled={enabledVisible === 0}>
                    <ToggleLeftIcon className="size-4" />
                    全部关闭（{enabledVisible}）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => batchToggle(true)} disabled={disabledVisible === 0}>
                    <ToggleRightIcon className="size-4" />
                    全部启用（{disabledVisible}）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label="刷新"
              >
                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button className="h-8 shrink-0 gap-1.5" disabled={tabNeedsCwd} />}
                >
                  <PlusIcon className="size-4" />
                  新建
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={openCreate}>
                    <SquarePenIcon className="size-4" />
                    表单创建
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openImport}>
                    <PencilIcon className="size-4" />
                    导入 Markdown
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* 技能列表卡片（MCP/记忆文件列表同款容器） */}
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {snap.error ? (
              <div className="text-muted-foreground px-3 py-3 text-sm">清单加载失败：{snap.error}</div>
            ) : tabNeedsCwd ? (
              // 目录选择器已常驻工具行（见上方 WorkspaceCwdMenu），这里只提示用途
              <div className="text-muted-foreground px-3 py-3 text-sm">
                未选择工作区：点上方「选择工作区」挑选最近使用的仓库，或「浏览其他目录…」
                直接定位某个仓库的 .kova/skills/。
              </div>
            ) : visible.length === 0 ? (
              <div className="text-muted-foreground flex flex-col gap-1 px-3 py-3 text-sm">
                <span>
                  {query.trim()
                    ? `没有匹配「${query.trim()}」的技能。`
                    : scopeTab === "system"
                      ? "还没有系统级技能。点右上角「新建」添加，或把技能文件放进应用数据目录 skills/。"
                      : scopeTab === "workspace"
                        ? "该工作区还没有技能。点右上角「新建」添加（保存到 .kova/skills/，随仓库共享）。"
                        : "该目录下暂无生态技能。把技能 .md 或 <技能>/SKILL.md 放进 .agents/skills/ 即被自动发现（只读，可开关）。"}
                </span>
              </div>
            ) : (
              visible.map((entry) => (
                <SkillRow
                  key={`${entry.scope}:${entry.name}`}
                  entry={entry}
                  workspaceCwd={snap.workspaceCwd}
                  confirmingDelete={confirmDelete === `${entry.scope}:${entry.name}`}
                  onToggle={(enabled) => toggle(entry, enabled)}
                  onView={() => setViewing(entry)}
                  onEdit={() => setEditor({ open: true, target: { mode: "edit", entry } })}
                  onDelete={() => setConfirmDelete(`${entry.scope}:${entry.name}`)}
                  onConfirmDelete={() => remove(entry)}
                />
              ))
            )}
            {/* 遮蔽规则脚注（MCP 页兼容性脚注同款位置） */}
            {!snap.error && !tabNeedsCwd && visible.length > 0 && (
              <div className="text-muted-foreground px-3 py-1.5 text-xs">
                {scopeTab === "compat"
                  ? "生态目录只读：修改请直接编辑仓库/用户目录里的技能文件，开关状态保存在本机。"
                  : "同名遮蔽：工作区 > 生态·工作区 > 系统 > 生态·用户；被遮蔽的技能不注入模型。"}
              </div>
            )}
          </div>

          {/* 加载诊断：折叠放置，不与清单争视觉（坏文件警告不致命） */}
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
        </section>
      </div>

      <SkillEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        target={editor.target}
        workspaceCwd={viewingCwd}
      />
      <SkillViewDialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        entry={viewing}
      />
    </div>
  );
};
