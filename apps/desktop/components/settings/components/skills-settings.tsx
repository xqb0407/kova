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
 * 版式（对齐插件市场的卡片网格）：整页滚动 + 居中定宽内容区 + 搜索/批量/新建
 * 工具行 + 按来源分区的卡片网格（生态兼容 / 工作区级 / 系统级）。三个来源同屏
 * 呈现，不再用页签把其中两类藏起来；每张卡 = 首字母色块 + 名称/来源徽标/描述 +
 * 底部路径与行内操作 + Switch。技能常几十个，搜索仍是第一交互；批量既有全局
 * 「全部技能」，每个分区标题右侧也有只作用于本区的「批量」。
 * 嵌入管理页（插件/专家/技能 → 管理）时页面身份在管理页页头，这里不再重复大标题。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  FolderGit2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  ToggleLeftIcon,
  ToggleRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/custom-ui/segmented";
import { LetterAvatar } from "@/components/custom-ui/letter-avatar";
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
import { isDesktop } from "@/lib/desktop-env";
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

/** 分区折叠状态：按分区标题持久化（本机 UI 偏好，不写技能文件） */
const SECTION_OPEN_KEY = "kova.skills.sections-open";

function readSectionOpen(title: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SECTION_OPEN_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return map[title] !== false;
  } catch {
    return true;
  }
}

function persistSectionOpen(title: string, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SECTION_OPEN_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[title] = open;
    window.localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式/配额满：折叠偏好不可用就不记忆
  }
}

/** 诊断原文形如 `<layer>: <message> (<file>)`：拆成主句与文件路径，列表更好读 */
function splitDiagnostic(text: string): { message: string; path: string | null } {
  const match = text.match(/^(.*?)\s+\((.*)\)$/);
  return match ? { message: match[1]!, path: match[2]! } : { message: text, path: null };
}

/** 预览弹窗的 Markdown 渲染是重依赖（Streamdown），点开预览时才拉取 */
const MarkdownText = dynamic(
  () =>
    import("@/components/assistant-ui/elements/markdown-text").then((m) => ({
      default: m.MarkdownText,
    })),
  {
    ssr: false,
    loading: () => <p className="text-muted-foreground text-sm">正文加载中…</p>,
  },
);

const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  system: "系统",
  workspace: "工作区",
  compat: "生态 · 用户",
  "compat-workspace": "生态 · 工作区",
  plugin: "插件",
};

/** 生态兼容区的来源徽标（同一区里混排用户层与工作区层） */
const COMPAT_TAG: Partial<Record<SkillEntry["scope"], string>> = {
  compat: "用户目录",
  "compat-workspace": "工作区目录",
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

/** Markdown 内容区：编辑/预览共用同一块画布高度，切页签不跳版 */
const SkillMarkdownField: FC<{
  value: string;
  onChange: (value: string) => void;
  tab: "edit" | "preview";
  placeholder?: string;
}> = ({ value, onChange, tab, placeholder }) => (
  <div className="bg-background h-72 overflow-hidden rounded-xl border">
    {tab === "edit" ? (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-full w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
      />
    ) : (
      <div className="h-full overflow-y-auto p-4">
        {value.trim() ? (
          <MarkdownText text={value} />
        ) : (
          <p className="text-muted-foreground text-sm">暂无内容</p>
        )}
      </div>
    )}
  </div>
);

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
  /** 正文/原文的编辑-预览页签：打开弹窗时回到编辑 */
  const [contentTab, setContentTab] = useState<"edit" | "preview">("edit");

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
    setContentTab("edit");
  }, [open, target]);

  if (!target) return null;
  const scope = editorScope(target);
  const scopeNeedsCwd = scope === "workspace" && !workspaceCwd;
  const docBytes = byteLength(
    `---\nname: ${form.name}\ndescription: ${form.description}\n---\n\n${form.content}`,
  );
  const rawBytes = byteLength(raw);
  const byteCount = isImport ? rawBytes : docBytes;
  const headerName =
    target.mode === "edit"
      ? target.entry.name
      : isImport
        ? fallbackName.trim() || "导入"
        : form.name.trim() || "新";

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
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {/* 页头：与预览弹窗同款（图标 + 标题 + 保存位置），正文滚动时保持可见 */}
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="size-12 shrink-0 overflow-hidden rounded-2xl">
            <LetterAvatar name={headerName} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-md font-semibold tracking-tight">
              {target.mode === "create"
                ? "新建技能"
                : target.mode === "import"
                  ? "导入技能 Markdown"
                  : `编辑 ${target.entry.name}`}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {scope === "workspace"
                ? `保存到 ${workspaceCwd ?? ""}/.kova/skills/ · 随仓库共享`
                : "保存到应用数据目录 skills/ · 本机全局生效"}
            </DialogDescription>
          </div>
        </div>

        {/* 表单主体：可滚动；页脚固定，避免长正文把保存键推出视口 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-5">
            {isImport ? (
              <>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">SKILL.md 原文</Label>
                      <Segmented
                        value={contentTab}
                        onChange={setContentTab}
                        options={[
                          { value: "edit", label: "编辑" },
                          { value: "preview", label: "预览" },
                        ]}
                      />
                    </div>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        byteCount > MAX_SKILL_BYTES
                          ? "text-destructive"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {formatBytes(byteCount)} / 128 KB
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    frontmatter + 正文；生态目录的技能文件可直接粘贴，保存时由 sidecar
                    以与加载完全相同的规则解析校验。
                  </p>
                  <SkillMarkdownField
                    value={raw}
                    onChange={setRaw}
                    tab={contentTab}
                    placeholder={
                      "---\nname: my-skill\ndescription: 何时使用该技能（模型据此判断）\n---\n\n# 步骤\n1. ..."
                    }
                  />
                </div>
                <div className="flex w-64 max-w-full flex-col gap-1.5">
                  <Label className="text-sm font-medium">文件名兜底</Label>
                  <Input
                    value={fallbackName}
                    onChange={(e) => setFallbackName(e.target.value)}
                    placeholder="如 pdf-export"
                  />
                  <span className="text-muted-foreground text-xs">原文缺 name 时用</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">名称</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="如 code-review"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">描述</Label>
                  <Textarea
                    value={form.description}
                    onChange={(e) => setField("description", e.target.value)}
                    rows={3}
                    placeholder="如 Review pull request diffs and provide actionable feedback."
                  />
                  <span className="text-muted-foreground text-xs">
                    模型据此判断任务何时匹配该技能。
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">正文</Label>
                      <Segmented
                        value={contentTab}
                        onChange={setContentTab}
                        options={[
                          { value: "edit", label: "编辑" },
                          { value: "preview", label: "预览" },
                        ]}
                      />
                    </div>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        byteCount > MAX_SKILL_BYTES
                          ? "text-destructive"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {formatBytes(byteCount)} / 128 KB
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    模型匹配后按需读取的指令；不占常驻上下文。
                  </p>
                  <SkillMarkdownField
                    value={form.content}
                    onChange={(value) => setField("content", value)}
                    tab={contentTab}
                  />
                </div>
                <Label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={form.disableModelInvocation}
                    onCheckedChange={(checked) =>
                      setField("disableModelInvocation", checked === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    不出现在模型的技能目录（仅保留手动/工具触发路径）
                  </span>
                </Label>
              </>
            )}
          </div>
        </div>

        {/* 页脚：保存位置提示 + 取消/保存；错误就近显示在页脚上方 */}
        <div className="shrink-0  px-6 py-4">
          {error && (
            <p className="text-destructive mb-2 text-xs" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className={cn(
                "text-xs",
                scopeNeedsCwd
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {scopeNeedsCwd
                ? "未选择工作区：先关闭弹窗，在「工作区级」分区选择目录"
                : scope === "workspace"
                  ? "工作区级 · 保存后随仓库共享"
                  : "系统级 · 保存后本机全局生效"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                onClick={save}
                disabled={busy || scopeNeedsCwd || (isImport && !raw.trim())}
              >
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/** 技能预览弹窗（参考插件详情的版式）：描述信息条 + Markdown 正文 + 页脚操作。
 *  所有来源共用：生态层只读，页脚只剩启用/禁用与关闭；托管层多出编辑/删除。 */
const SkillViewDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: SkillEntry | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ open, onOpenChange, entry, onToggle, onEdit, onDelete }) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 换条目/重新打开时重置删除二次确认
  useEffect(() => {
    setConfirmingDelete(false);
  }, [entry?.scope, entry?.name, open]);
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
          {/* 头部：首字母色块 + 名称 + 来源/路径（关闭键由 DialogContent 提供） */}
          <div className="flex items-start gap-4 pr-8">
            <div className="size-12 shrink-0 overflow-hidden rounded-2xl">
              <LetterAvatar name={entry.name} className="text-xl" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-xl font-semibold tracking-tight">
                {entry.name}
              </DialogTitle>
              <DialogDescription className="mt-1 flex min-w-0 items-center gap-2">
                <span className="shrink-0">
                  {SCOPE_LABEL[entry.scope]}
                  {entry.editable ? "" : " · 只读"}
                </span>
                <span
                  className="text-muted-foreground/60 min-w-0 truncate font-mono text-xs"
                  title={entry.path}
                >
                  {entry.path}
                </span>
              </DialogDescription>
            </div>
          </div>

          {/* 描述：灰底信息条（过长时内部滚动，不挤正文） */}
          <div className="bg-muted/50 max-h-28 shrink-0 overflow-y-auto rounded-xl px-4 py-3 text-sm leading-relaxed">
            {entry.description || "未填写描述"}
          </div>

          {/* 正文：Markdown 预览，超长在卡片内滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border p-5">
            {entry.content.trim() ? (
              <MarkdownText text={entry.content} />
            ) : (
              <p className="text-muted-foreground text-sm">暂无正文</p>
            )}
          </div>
        </div>

        {/* 页脚：左侧启用/禁用与删除，右侧关闭与编辑（与参考图同层级） */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onToggle(!entry.enabled)}>
              {entry.enabled ? "禁用" : "启用"}
            </Button>
            {entry.editable &&
              (confirmingDelete ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    onDelete();
                    onOpenChange(false);
                  }}
                >
                  <CheckIcon className="size-3.5" />
                  确认删除
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2Icon className="size-3.5" />
                  删除
                </Button>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            {entry.editable && (
              <Button size="sm" onClick={onEdit}>
                <PencilIcon className="size-3.5" />
                编辑
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// 技能卡片（对齐插件市场：首字母色块 + 名称/徽标/描述 + Switch）
// ---------------------------------------------------------------------------

/** 名称行里的小徽标：来源/状态各有固定色，扫一眼即可区分 */
const TAG_CLASS = {
  compatUser: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  compatWorkspace: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  shadowed: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  hidden: "bg-muted text-muted-foreground",
} as const;

const SkillCard: FC<{
  entry: SkillEntry;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
}> = ({
  entry,
  confirmingDelete,
  onToggle,
  onView,
  onEdit,
  onDelete,
  onConfirmDelete,
}) => {
  const compatTag = COMPAT_TAG[entry.scope];
  return (
    <article
      className={cn(
        "group hover:bg-muted/50 relative flex min-w-0 items-start gap-4 rounded-xl px-3 py-4 transition-colors",
        entry.shadowed && "opacity-60",
      )}
    >
      {/* 直分隔线：画成 1px 元素而不是 border-bottom——圆角容器的 border 会把线段两端带弯 */}
      <span
        aria-hidden
        className="bg-border/50 pointer-events-none absolute inset-x-0 bottom-0 h-px transition-opacity group-hover:opacity-0"
      />
      {/* 图标 + 名称/描述整体可点：点卡片任意空白处即进预览 */}
      <div
        role="button"
        tabIndex={0}
        onClick={onView}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onView();
          }
        }}
        title={`预览 ${entry.name}`}
        aria-label={`预览 ${entry.name}`}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {/* 图标：直接用首字母色块（不再套白色底板/描边） */}
        <div className="mt-0.5 size-11 shrink-0 overflow-hidden rounded-xl">
          <LetterAvatar name={entry.name} className="text-lg" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-base font-medium">{entry.name}</span>
            {entry.enabled && !entry.shadowed && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                title="生效中"
                aria-label="生效中"
              />
            )}
            <span className="flex shrink-0 items-center gap-1">
              {compatTag && (
                <Badge
                  variant="secondary"
                  className={cn(
                    "px-1.5 py-0 text-[10px] font-medium",
                    entry.scope === "compat" ? TAG_CLASS.compatUser : TAG_CLASS.compatWorkspace,
                  )}
                >
                  {compatTag}
                </Badge>
              )}
              {entry.shadowed && (
                <Badge
                  variant="secondary"
                  className={cn("px-1.5 py-0 text-[10px] font-medium", TAG_CLASS.shadowed)}
                  title="被更高优先级的同名技能遮蔽，不注入模型"
                >
                  已遮蔽
                </Badge>
              )}
              {entry.disableModelInvocation && (
                <Badge
                  variant="secondary"
                  className={cn("px-1.5 py-0 text-[10px] font-medium", TAG_CLASS.hidden)}
                >
                  不进目录
                </Badge>
              )}
            </span>
          </div>
          <p
            className="text-muted-foreground mt-1 line-clamp-2 min-h-10 text-[13px] leading-5"
            title={entry.description || undefined}
          >
            {entry.description || "未填写描述"}
          </p>
        </div>
      </div>

      {/* 右侧：开关常驻，行内操作 hover/聚焦时提亮（不打断两行描述的节奏） */}
      <div className="flex shrink-0 items-center gap-1.5 self-center">
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
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
        </div>
        <Switch
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={`${entry.name} 启用`}
        />
      </div>
    </article>
  );
};

// ---------------------------------------------------------------------------
// 分区容器
// ---------------------------------------------------------------------------

const SkillSection: FC<{
  title: string;
  count: number;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}> = ({ title, count, hint, actions, children }) => {
  const [open, setOpen] = useState(() => readSectionOpen(title));
  const toggle = () =>
    setOpen((v) => {
      persistSectionOpen(title, !v);
      return !v;
    });
  return (
    <section className="flex flex-col gap-3">
      {/* 整行可点/整行高亮：左侧标题区铺满除操作簇以外的整行，右侧操作独立 */}
      <div className="hover:bg-muted/40 cursor-pointer -mx-2 flex items-center gap-2 rounded-xl px-2 py-1 transition-colors">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={open ? `折叠${title}` : `展开${title}`}
          className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span role="heading" aria-level={2} className="text-sm font-semibold tracking-tight">
            {title}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">({count})</span>
          {hint && (
            <span className="text-muted-foreground/80 hidden text-xs sm:inline">{hint}</span>
          )}
          <span className="text-muted-foreground/70 ml-1 grid size-5 shrink-0 place-items-center">
            {open ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {open && children}
    </section>
  );
};

/** 分区批量：只对当前分区（且经过搜索筛选）的条目生效，不碰其他来源 */
const SectionBatchMenu: FC<{
  label: string;
  entries: SkillEntry[];
  cwd: string | null;
}> = ({ label, entries, cwd }) => {
  const [busy, setBusy] = useState(false);
  const enabledCount = entries.filter((e) => e.enabled).length;
  const disabledCount = entries.length - enabledCount;
  const apply = (enabled: boolean) => {
    if (busy || entries.length === 0) return;
    setBusy(true);
    void setSkillsEnabled(
      entries.map((e) => ({ scope: e.scope, name: e.name })),
      enabled,
      cwd,
    )
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={busy || entries.length === 0}
            title={`只对「${label}」分区批量启停`}
          />
        }
      >
        {busy ? "处理中…" : "批量"}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <div className="text-muted-foreground px-2 py-1.5 text-xs font-normal">
          {label} · {entries.length} 个
        </div>
        <DropdownMenuItem onClick={() => apply(false)} disabled={enabledCount === 0}>
          <ToggleLeftIcon className="size-4" />
          全部关闭（{enabledCount}）
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => apply(true)} disabled={disabledCount === 0}>
          <ToggleRightIcon className="size-4" />
          全部启用（{disabledCount}）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

export const SkillsSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  // 工作区级区块允许浏览任意目录：overrideCwd 为 null 时跟随主界面当前工作区
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null);
  const viewingCwd = overrideCwd ?? workspace;
  const snap = useSkills(viewingCwd);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; target: EditorTarget | null }>({
    open: false,
    target: null,
  });
  // 预览目标只存 key，条目从最新快照推导：弹窗里切开关/删除后状态即时跟随
  const [viewingKey, setViewingKey] = useState<string | null>(null);
  const viewing = useMemo(
    () =>
      viewingKey
        ? snap.skills.find((e) => `${e.scope}:${e.name}` === viewingKey) ?? null
        : null,
    [snap.skills, viewingKey],
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  /** 按来源分区 + 搜索过滤（一次遍历；各分区内部按名称稳定排序） */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (e: SkillEntry) =>
      !q ||
      [e.name, e.description, e.path]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    const byName = (a: SkillEntry, b: SkillEntry) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const pick = (...scopes: SkillEntry["scope"][]) =>
      snap.skills.filter((e) => scopes.includes(e.scope) && matches(e)).sort(byName);
    return {
      system: pick("system"),
      workspace: pick("workspace"),
      compat: pick("compat", "compat-workspace"),
      all: snap.skills.filter(matches),
    };
  }, [snap.skills, query]);

  const hasQuery = query.trim().length > 0;
  const visible = groups.all;
  const enabledCount = snap.skills.filter((e) => e.enabled).length;
  // 批量快捷的计数口径 = 当前搜索筛选后的可见列表（所见即所得）
  const enabledVisible = visible.filter((e) => e.enabled).length;
  const disabledVisible = visible.length - enabledVisible;

  const toggle = (entry: SkillEntry, enabled: boolean) => {
    void setSkillEnabled(
      entry.scope,
      entry.name,
      enabled,
      entry.scope === "workspace" || entry.scope === "compat-workspace" ? viewingCwd : null,
    ).catch(() => {});
  };

  /** 批量开关：一次请求把当前筛选结果全部置为目标状态 */
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

  const openCreate = (scope: "system" | "workspace") =>
    setEditor({ open: true, target: { mode: "create", scope } });

  const openImport = (scope: "system" | "workspace") =>
    setEditor({ open: true, target: { mode: "import", scope } });

  /** 只读浏览：弹原生目录选择器，但不改主界面工作区（与 MCP/记忆页同款语义） */
  const pickBrowseDir = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "浏览工作区技能目录" });
      if (typeof dir === "string") setOverrideCwd(dir === workspace ? null : dir);
    } catch {
      // 非 桌面壳环境：无原生目录选择器
    }
  };

  const cwdCandidates = useMemo(
    () =>
      Array.from(
        new Set([overrideCwd, workspace, ...recents].filter((d): d is string => Boolean(d))),
      ),
    [overrideCwd, workspace, recents],
  );

  /** 每张卡片同一套开关/查看/编辑/删除回调 */
  const renderCards = (entries: SkillEntry[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-x-8 gap-y-1">
      {entries.map((entry) => (
        <SkillCard
          key={`${entry.scope}:${entry.name}`}
          entry={entry}
          confirmingDelete={confirmDelete === `${entry.scope}:${entry.name}`}
          onToggle={(enabled) => toggle(entry, enabled)}
          onView={() => setViewingKey(`${entry.scope}:${entry.name}`)}
          onEdit={() => setEditor({ open: true, target: { mode: "edit", entry } })}
          onDelete={() => setConfirmDelete(`${entry.scope}:${entry.name}`)}
          onConfirmDelete={() => remove(entry)}
        />
      ))}
    </div>
  );

  const emptyCard = (text: string) => (
    <div className="text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-sm">
      {text}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-x-hidden overflow-y-auto">
      <div
        className={cn(
          "flex w-full flex-col gap-6",
          embedded ? "px-0 py-0" : "max-w-7xl self-center px-8 py-8",
        )}
      >
        {/* 标题行：嵌入管理页时身份在应用顶栏，这里不再重复大标题（资料库同款） */}
        {!embedded && (
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight">技能</h1>
            <span
              className={cn("text-xs", snap.error ? "text-destructive" : "text-muted-foreground")}
            >
              {snap.error
                ? "清单加载失败，可刷新重试"
                : snap.loading && snap.skills.length === 0
                  ? "正在加载技能清单…"
                  : `${snap.skills.length} 个技能（${enabledCount} 个启用）`}
            </span>
          </div>
        )}

        <section className="flex flex-col gap-5">
          {/* 工具行：左侧计数，右侧搜索 + 批量/刷新/新建（参考图：搜索贴右） */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground text-sm">
              {visible.length} 个技能{visible.length > 0 ? ` · ${enabledVisible} 个启用` : ""}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-64 bg-muted/50"
                placeholder="搜索名称 / 描述 / 路径…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {/* 批量开关：免去几十个技能一个个点（作用于搜索后的全部可见条目） */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 gap-1 text-sm"
                      disabled={visible.length === 0 || batchBusy}
                      title="对当前筛选结果的全部技能批量启停"
                    />
                  }
                >
                  {batchBusy ? "处理中…" : "全部技能"}
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
                <DropdownMenuTrigger render={<Button className="h-8 shrink-0 gap-1.5" />}>
                  <PlusIcon className="size-4" />
                  新建
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onClick={() => openCreate("system")}>
                    新建系统级技能
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewingCwd}
                    onClick={() => openCreate("workspace")}
                  >
                    新建工作区级技能
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openImport("system")}>
                    导入到系统级
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewingCwd}
                    onClick={() => openImport("workspace")}
                  >
                    导入到工作区级
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {snap.error ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-sm">
              清单加载失败：{snap.error}
            </div>
          ) : (
            <>
              {hasQuery && visible.length === 0 && (
                <div className="text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-sm">
                  没有匹配「{query.trim()}」的技能。
                </div>
              )}

              {/* 生态兼容：用户层恒可见，工作区层跟随所选工作区 */}
              {(!hasQuery || groups.compat.length > 0) && (
                <SkillSection
                  title="生态兼容"
                  count={groups.compat.length}
                  hint="agentskills.io 标准 · 只读发现"
                  actions={
                    <SectionBatchMenu
                      label="生态兼容"
                      entries={groups.compat}
                      cwd={viewingCwd}
                    />
                  }
                >
                  {groups.compat.length > 0
                    ? renderCards(groups.compat)
                    : emptyCard(
                        viewingCwd
                          ? "该目录下暂无生态技能。把技能 .md 或 <技能>/SKILL.md 放进 ~/.agents/skills/ 或仓库 .agents/skills/ 即被自动发现（只读，可开关）。"
                          : "用户目录 ~/.agents/skills/ 下暂无生态技能；选择工作区后还会显示该仓库 .agents/skills/ 的技能。",
                      )}
                </SkillSection>
              )}

              {/* 工作区级：目录选择器常驻分区标题右侧；未选工作区也能直接挑最近目录或浏览 */}
              {(!hasQuery || groups.workspace.length > 0) && (
                <SkillSection
                  title="工作区级"
                  count={groups.workspace.length}
                  hint="保存到 .kova/skills/ · 随仓库共享"
                  actions={
                    <>
                      <WorkspaceCwdMenu
                        value={viewingCwd}
                        following={!overrideCwd}
                        followLabel={workspace ? pathBasename(workspace) : null}
                        candidates={cwdCandidates}
                        showBrowse={isDesktop()}
                        onChange={(dir) => setOverrideCwd(dir === workspace ? null : dir)}
                        onFollowCurrent={() => setOverrideCwd(null)}
                        onBrowse={() => void pickBrowseDir()}
                      />
                      <SectionBatchMenu
                        label="工作区级"
                        entries={groups.workspace}
                        cwd={viewingCwd}
                      />
                    </>
                  }
                >
                  {groups.workspace.length > 0
                    ? renderCards(groups.workspace)
                    : emptyCard(
                        viewingCwd
                          ? "该工作区还没有技能。点右上角「新建」添加（保存到 .kova/skills/，随仓库共享）。"
                          : "未选择工作区：点本分区右上角「选择工作区」挑选最近使用的仓库，或「浏览其他目录…」直接定位某个仓库。",
                      )}
                </SkillSection>
              )}

              {/* 系统级：应用数据目录，所有工作区可用 */}
              {(!hasQuery || groups.system.length > 0) && (
                <SkillSection
                  title="系统级"
                  count={groups.system.length}
                  hint="应用数据目录 · 本机全局生效"
                  actions={
                    <SectionBatchMenu
                      label="系统级"
                      entries={groups.system}
                      cwd={viewingCwd}
                    />
                  }
                >
                  {groups.system.length > 0
                    ? renderCards(groups.system)
                    : emptyCard("还没有系统级技能。点右上角「新建」添加，或把技能文件放进应用数据目录 skills/。")}
                </SkillSection>
              )}

              {/* 规则脚注：遮蔽顺序与只读语义（有内容时才占位置） */}
              {snap.skills.length > 0 && (
                <p className="text-muted-foreground text-xs leading-relaxed px-2">
                  同名遮蔽：工作区 &gt; 生态·工作区 &gt; 系统 &gt; 生态·用户；被遮蔽的技能不注入模型。
                  生态目录只读：修改请直接编辑对应文件，开关状态保存在本机。
                </p>
              )}
            </>
          )}

          {/* 加载诊断：琥珀色告警面板，折叠放置，不与清单争视觉（坏文件警告不致命） */}
          {snap.diagnostics.length > 0 && (
            <details className="group border-amber-500/20 bg-amber-500/5 overflow-hidden rounded-xl border text-xs">
              <summary className="hover:bg-amber-500/10 flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 transition-colors [&::-webkit-details-marker]:hidden">
                <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-foreground font-medium">加载诊断</span>
                <Badge
                  variant="secondary"
                  className="bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1.5 py-0 text-[10px] font-medium"
                >
                  {snap.diagnostics.length}
                </Badge>
                <span className="text-muted-foreground/70 hidden text-xs sm:inline">
                  部分技能文件未通过校验，已跳过
                </span>
                <ChevronRightIcon className="text-muted-foreground/70 ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-90" />
              </summary>
              <ul className="border-amber-500/15 flex flex-col gap-1.5 border-t px-3.5 py-3">
                {snap.diagnostics.map((d) => {
                  const { message, path } = splitDiagnostic(d);
                  return (
                    <li
                      key={d}
                      className="bg-background/70 border-amber-500/10 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2"
                    >
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500/70" />
                      <span className="min-w-0">
                        <span className="block text-xs leading-5 break-all">{message}</span>
                        {path && (
                          <span className="text-muted-foreground/70 mt-0.5 block font-mono text-[10px] leading-4 break-all">
                            {path}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
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
          if (!open) setViewingKey(null);
        }}
        entry={viewing}
        onToggle={(enabled) => {
          if (viewing) toggle(viewing, enabled);
        }}
        onEdit={() => {
          if (!viewing || !viewing.editable) return;
          setViewingKey(null);
          setEditor({ open: true, target: { mode: "edit", entry: viewing } });
        }}
        onDelete={() => {
          if (!viewing || !viewing.editable) return;
          remove(viewing);
          setViewingKey(null);
        }}
      />
    </div>
  );
};
