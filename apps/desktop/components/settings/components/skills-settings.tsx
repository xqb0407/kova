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
import { ProjectScopeMenu } from "@/components/settings/components/project-scope-menu";
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
import { pathBasename } from "@/lib/workspace/workspace-store";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  deleteSkill,
  refreshSkills,
  saveSkill,
  setSkillEnabled,
  setSkillsEnabled,
  skillTemplate,
  useSkills,
  SKILL_SCOPE_LABEL_KEY,
  type SkillDraft,
  type SkillEntry,
} from "@/lib/skills/skills";
import { t, useT } from "@/lib/i18n";

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
    loading: () => <p className="text-muted-foreground text-sm leading-relaxed">{t("settings.skills.markdownLoading")}</p>,
  },
);

const SCOPE_LABEL = SKILL_SCOPE_LABEL_KEY;

/** 生态兼容区的来源徽标（同一区里混排用户层与工作区层） */
const COMPAT_TAG: Partial<Record<SkillEntry["scope"], string>> = {
  compat: "settings.skills.tagCompatUser",
  "compat-workspace": "settings.skills.tagCompatWorkspace",
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
}> = ({ value, onChange, tab, placeholder }) => {
  const t = useT();
  return (
  <div className="bg-background h-72 overflow-hidden rounded-xl border">
    {tab === "edit" ? (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none"
      />
    ) : (
      <div className="h-full overflow-y-auto p-4">
        {value.trim() ? (
          <MarkdownText text={value} />
        ) : (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.skills.noContentPreview")}
          </p>
        )}
      </div>
    )}
  </div>
  );
};

const SkillEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  /** 工作区层保存所需的 cwd（当前选中工作区） */
  workspaceCwd: string | null;
}> = ({ open, onOpenChange, target, workspaceCwd }) => {
  const t = useT();
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
        ? fallbackName.trim() || t("settings.skills.importFallback")
        : form.name.trim() || t("settings.skills.newFallback");

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
        // 系统层保存后补拉正在浏览的工作区视图（按 cwd 分桶，否则列表不刷新）
        viewCwd: workspaceCwd ?? undefined,
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
                ? t("settings.skills.createTitle")
                : target.mode === "import"
                  ? t("settings.skills.importTitle")
                  : t("settings.skills.editTitle", { name: target.entry.name })}
            </DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm">
              {scope === "workspace"
                ? t("settings.skills.saveWorkspaceDesc", { cwd: workspaceCwd ?? "" })
                : t("settings.skills.saveSystemDesc")}
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
                      <Label className="text-sm font-medium">{t("settings.skills.rawLabel")}</Label>
                      <Segmented
                        value={contentTab}
                        onChange={setContentTab}
                        options={[
                          { value: "edit", label: t("settings.skills.editTab") },
                          { value: "preview", label: t("settings.skills.previewTab") },
                        ]}
                      />
                    </div>
                    <span
                      className={cn(
                        "font-mono text-[13px] leading-5",
                        byteCount > MAX_SKILL_BYTES
                          ? "text-destructive"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {t("settings.skills.sizeLimit", { size: formatBytes(byteCount) })}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.skills.importHint")}
                  </p>
                  <SkillMarkdownField
                    value={raw}
                    onChange={setRaw}
                    tab={contentTab}
                    placeholder={t("settings.skills.importPlaceholder")}
                  />
                </div>
                <div className="flex w-64 max-w-full flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t("settings.skills.fallbackName")}</Label>
                  <Input
                    value={fallbackName}
                    onChange={(e) => setFallbackName(e.target.value)}
                    placeholder={t("settings.skills.fallbackPlaceholder")}
                  />
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.skills.fallbackHint")}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t("settings.skills.nameLabel")}</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder={t("settings.skills.namePlaceholder")}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t("settings.skills.descriptionLabel")}</Label>
                  <Textarea
                    value={form.description}
                    onChange={(e) => setField("description", e.target.value)}
                    rows={3}
                    placeholder={t("settings.skills.descriptionPlaceholder")}
                  />
                  <span className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.skills.descriptionHint")}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">{t("settings.skills.contentLabel")}</Label>
                      <Segmented
                        value={contentTab}
                        onChange={setContentTab}
                        options={[
                          { value: "edit", label: t("settings.skills.editTab") },
                          { value: "preview", label: t("settings.skills.previewTab") },
                        ]}
                      />
                    </div>
                    <span
                      className={cn(
                        "font-mono text-[13px] leading-5",
                        byteCount > MAX_SKILL_BYTES
                          ? "text-destructive"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {t("settings.skills.sizeLimit", { size: formatBytes(byteCount) })}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-[13px] leading-5">
                    {t("settings.skills.contentHint")}
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
                    {t("settings.skills.disableInvocation")}
                  </span>
                </Label>
              </>
            )}
          </div>
        </div>

        {/* 页脚：保存位置提示 + 取消/保存；错误就近显示在页脚上方 */}
        <div className="shrink-0  px-6 py-4">
          {error && (
            <p className="text-destructive mb-2 text-[13px] leading-5" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className={cn(
                "text-[13px] leading-5",
                scopeNeedsCwd
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {scopeNeedsCwd
                ? t("settings.skills.scopeNeedsCwd")
                : scope === "workspace"
                  ? t("settings.skills.layerWorkspace")
                  : t("settings.skills.layerSystem")}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("settings.skills.cancel")}
              </Button>
              <Button
                onClick={save}
                disabled={busy || scopeNeedsCwd || (isImport && !raw.trim())}
              >
                {busy ? t("settings.skills.saving") : t("settings.skills.save")}
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
  const t = useT();
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
                  {t(SCOPE_LABEL[entry.scope])}
                  {entry.editable
                    ? ""
                    : entry.managed
                      ? ` · ${t("settings.skills.managed")}`
                      : ` · ${t("settings.skills.readonly")}`}
                </span>
                <span
                  className="text-muted-foreground min-w-0 truncate font-mono text-[13px] leading-5"
                  title={entry.path}
                >
                  {entry.path}
                </span>
              </DialogDescription>
            </div>
          </div>

          {/* 描述：灰底信息条（过长时内部滚动，不挤正文） */}
          <div className="bg-muted/50 max-h-28 shrink-0 overflow-y-auto rounded-xl px-4 py-3 text-sm leading-relaxed">
            {entry.description || t("settings.skills.noDescription")}
          </div>

          {/* 正文：Markdown 预览，超长在卡片内滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border p-5">
            {entry.content.trim() ? (
              <MarkdownText text={entry.content} />
            ) : (
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("settings.skills.noContent")}
              </p>
            )}
          </div>
        </div>

        {/* 页脚：左侧启用/禁用与删除，右侧关闭与编辑（与参考图同层级） */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onToggle(!entry.enabled)}>
              {entry.enabled ? t("settings.skills.disable") : t("settings.skills.enable")}
            </Button>
            {(entry.editable || entry.managed) &&
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
                  {t("settings.skills.confirmDelete")}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("settings.skills.delete")}
                </Button>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings.skills.close")}
            </Button>
            {entry.editable && (
              <Button size="sm" onClick={onEdit}>
                <PencilIcon className="size-3.5" />
                {t("settings.skills.edit")}
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
  const t = useT();
  const compatTag = COMPAT_TAG[entry.scope];
  return (
    <article
      className={cn(
        "group border-border/50 hover:bg-muted/40 relative flex min-w-0 items-center gap-3.5 rounded-xl border p-3 transition-colors",
        entry.shadowed && "opacity-60",
      )}
    >
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
        title={t("settings.skills.preview", { name: entry.name })}
        aria-label={t("settings.skills.preview", { name: entry.name })}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <div className="size-10 shrink-0 overflow-hidden rounded-lg">
          <LetterAvatar name={entry.name} className="text-lg" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{entry.name}</span>
            {entry.enabled && !entry.shadowed && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                title={t("settings.skills.active")}
                aria-label={t("settings.skills.active")}
              />
            )}
            <span className="flex shrink-0 items-center gap-1">
              {compatTag && (
                <Badge
                  variant="secondary"
                  className={cn(
                    "px-1.5 py-0 text-2xs font-medium",
                    entry.scope === "compat" ? TAG_CLASS.compatUser : TAG_CLASS.compatWorkspace,
                  )}
                >
                  {compatTag ? t(compatTag) : null}
                </Badge>
              )}
              {entry.shadowed && (
                <Badge
                  variant="secondary"
                  className={cn("px-1.5 py-0 text-2xs font-medium", TAG_CLASS.shadowed)}
                  title={t("settings.skills.shadowedTip")}
                >
                  {t("settings.skills.shadowed")}
                </Badge>
              )}
              {entry.disableModelInvocation && (
                <Badge
                  variant="secondary"
                  className={cn("px-1.5 py-0 text-2xs font-medium", TAG_CLASS.hidden)}
                >
                  {t("settings.skills.notInCatalog")}
                </Badge>
              )}
            </span>
          </div>
          <p
            className="text-muted-foreground mt-0.5 truncate text-xs leading-5"
            title={entry.description || undefined}
          >
            {entry.description || t("settings.skills.noDescription")}
          </p>
        </div>
      </div>

      {/* 右侧：开关常驻，行内操作 hover/聚焦时提亮（不打断两行描述的节奏） */}
      <div className="flex shrink-0 items-center gap-1.5 self-center">
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {!entry.editable && (
            <Button variant="ghost" size="icon" className="size-7" onClick={onView} title={t("settings.skills.viewContent")}>
              <EyeIcon className="size-3.5" />
            </Button>
          )}
          {entry.editable &&
            (confirmingDelete ? (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-[13px] leading-5"
                onClick={onConfirmDelete}
              >
                <CheckIcon className="size-3.5" />
                {t("settings.skills.confirmDelete")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="icon" className="size-7" onClick={onEdit} title={t("settings.skills.edit")}>
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive size-7"
                  onClick={onDelete}
                  title={t("settings.skills.delete")}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </>
            ))}
        </div>
        <Switch
          checked={entry.enabled}
          onCheckedChange={onToggle}
          aria-label={t("settings.skills.enableAria", { name: entry.name })}
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
  const t = useT();
  const [open, setOpen] = useState(() => readSectionOpen(title));
  const toggle = () =>
    setOpen((v) => {
      persistSectionOpen(title, !v);
      return !v;
    });
  return (
    <section className="flex flex-col gap-2">
      {/* Codex 风格分区头：小字号标题 + 计数 + 灰色说明，整行可折叠 */}
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={
            open
              ? t("settings.skills.collapseSection", { title })
              : t("settings.skills.expandSection", { title })
          }
          className="hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="text-muted-foreground/70 grid size-4 shrink-0 place-items-center">
            {open ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </span>
          <span role="heading" aria-level={2} className="text-[13px] leading-5 font-semibold">
            {title}
          </span>
          <span className="text-muted-foreground text-xs leading-5 tabular-nums">{count}</span>
          {hint && (
            <span className="text-muted-foreground/60 hidden min-w-0 truncate text-xs leading-5 sm:inline">
              · {hint}
            </span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
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
  const t = useT();
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
            className="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-[13px] leading-5"
            disabled={busy || entries.length === 0}
            title={t("settings.skills.sectionBatchTitle", { label })}
          />
        }
      >
        {busy ? t("settings.skills.processing") : t("settings.skills.batch")}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <div className="text-muted-foreground px-2 py-1.5 text-[13px] leading-5 font-normal">
          {t("settings.skills.sectionCount", { label, count: entries.length })}
        </div>
        <DropdownMenuItem onClick={() => apply(false)} disabled={enabledCount === 0}>
          <ToggleLeftIcon className="size-4" />
          {t("settings.skills.disableAll", { count: enabledCount })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => apply(true)} disabled={disabledCount === 0}>
          <ToggleRightIcon className="size-4" />
          {t("settings.skills.enableAll", { count: disabledCount })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区范围选择器（与 MCP/记忆/子智能体页同款）：只列项目/工作区。 */
export const SkillsSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const t = useT();
  const workspace = useProjectWorkspaceDir();
  // 工作区级区块只选项目：overrideCwd 为 null 时跟随主界面当前工作区
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
      // 外部目录层（多目录项目的附加目录）在本页没有对应分区：不进 visible，
      // 否则批量开关会把不可见的 scope 一起提交，命中 sidecar 的 scope 校验
      all: snap.skills.filter((e) => e.scope !== "external" && matches(e)),
    };
  }, [snap.skills, query]);

  const hasQuery = query.trim().length > 0;
  const visible = groups.all;
  const enabledCount = snap.skills.filter((e) => e.enabled).length;
  // 批量快捷的计数口径 = 当前搜索筛选后的可见列表（所见即所得）
  const enabledVisible = visible.filter((e) => e.enabled).length;
  const disabledVisible = visible.length - enabledVisible;

  const toggle = (entry: SkillEntry, enabled: boolean) => {
    // cwd 带上当前浏览的工作区：应答即是该视图的完整清单（按 cwd 分桶后，
    // 系统层开关也要写回正在看的这个桶，否则列表不刷新）
    void setSkillEnabled(
      entry.scope,
      entry.name,
      enabled,
      viewingCwd,
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
      entry.scope === "workspace"
        ? "workspace"
        : entry.scope === "compat"
          ? "compat"
          : "system",
      entry.name,
      viewingCwd,
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

  /** 每张卡片同一套开关/查看/编辑/删除回调 */
  const renderCards = (entries: SkillEntry[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-2">
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
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.skills.title")}</h1>
            <span
              className={cn("text-[13px] leading-5", snap.error ? "text-destructive" : "text-muted-foreground")}
            >
              {snap.error
                ? t("settings.skills.loadFailedShort")
                : snap.loading && snap.skills.length === 0
                  ? t("settings.skills.loading")
                  : t("settings.skills.countEnabled", {
                      count: snap.skills.length,
                      enabled: enabledCount,
                    })}
            </span>
          </div>
        )}

        <section className="flex flex-col gap-5">
          {/* 工具行：左侧计数，右侧搜索 + 批量/刷新/新建（参考图：搜索贴右） */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground text-[13px] leading-relaxed">
              {visible.length > 0
                ? t("settings.skills.visibleEnabled", {
                    count: visible.length,
                    enabled: enabledVisible,
                  })
                : t("settings.skills.visibleCount", { count: visible.length })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-64 bg-muted/50"
                placeholder={t("settings.skills.searchPlaceholder")}
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
                      title={t("settings.skills.batchAllTitle")}
                    />
                  }
                >
                  {batchBusy ? t("settings.skills.processing") : t("settings.skills.batchAll")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={() => batchToggle(false)} disabled={enabledVisible === 0}>
                    <ToggleLeftIcon className="size-4" />
                    {t("settings.skills.disableAll", { count: enabledVisible })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => batchToggle(true)} disabled={disabledVisible === 0}>
                    <ToggleRightIcon className="size-4" />
                    {t("settings.skills.enableAll", { count: disabledVisible })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label={t("settings.skills.refresh")}
              >
                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button className="h-8 shrink-0 gap-1.5" />}>
                  <PlusIcon className="size-4" />
                  {t("settings.skills.new")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onClick={() => openCreate("system")}>
                    {t("settings.skills.newSystem")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewingCwd}
                    onClick={() => openCreate("workspace")}
                  >
                    {t("settings.skills.newWorkspace")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openImport("system")}>
                    {t("settings.skills.importSystem")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewingCwd}
                    onClick={() => openImport("workspace")}
                  >
                    {t("settings.skills.importWorkspace")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {snap.error ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-sm">
              {t("settings.skills.loadFailed", { error: snap.error })}
            </div>
          ) : (
            <>
              {hasQuery && visible.length === 0 && (
                <div className="text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-sm">
                  {t("settings.skills.noMatch", { query: query.trim() })}
                </div>
              )}

              {/* 生态兼容：用户层恒可见，工作区层跟随所选工作区 */}
              {(!hasQuery || groups.compat.length > 0) && (
                <SkillSection
                  title={t("settings.skills.sectionCompat")}
                  count={groups.compat.length}
                  hint={t("settings.skills.sectionCompatHint")}
                  actions={
                    <SectionBatchMenu
                      label={t("settings.skills.sectionCompat")}
                      entries={groups.compat}
                      cwd={viewingCwd}
                    />
                  }
                >
                  {groups.compat.length > 0
                    ? renderCards(groups.compat)
                    : emptyCard(
                        viewingCwd
                          ? t("settings.skills.compatEmptyWithCwd")
                          : t("settings.skills.compatEmptyNoCwd"),
                      )}
                </SkillSection>
              )}

              {/* 工作区级：目录选择器常驻分区标题右侧；未选工作区也能直接挑最近目录或浏览 */}
              {(!hasQuery || groups.workspace.length > 0) && (
                <SkillSection
                  title={t("settings.skills.sectionWorkspace")}
                  count={groups.workspace.length}
                  hint={t("settings.skills.sectionWorkspaceHint")}
                  actions={
                    <>
                      <ProjectScopeMenu
                        value={viewingCwd}
                        following={!overrideCwd}
                        onChange={(dir) =>
                          setOverrideCwd(dir === workspace ? null : dir)
                        }
                        onFollowCurrent={() => setOverrideCwd(null)}
                      />
                      <SectionBatchMenu
                        label={t("settings.skills.sectionWorkspace")}
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
                          ? t("settings.skills.workspaceEmpty")
                          : t("settings.skills.workspaceEmptyNoCwd"),
                      )}
                </SkillSection>
              )}

              {/* 系统级：应用数据目录，所有工作区可用 */}
              {(!hasQuery || groups.system.length > 0) && (
                <SkillSection
                  title={t("settings.skills.sectionSystem")}
                  count={groups.system.length}
                  hint={t("settings.skills.sectionSystemHint")}
                  actions={
                    <SectionBatchMenu
                      label={t("settings.skills.sectionSystem")}
                      entries={groups.system}
                      cwd={viewingCwd}
                    />
                  }
                >
                  {groups.system.length > 0
                    ? renderCards(groups.system)
                    : emptyCard(t("settings.skills.systemEmpty"))}
                </SkillSection>
              )}

              {/* 规则脚注：遮蔽顺序与只读语义（有内容时才占位置） */}
              {snap.skills.length > 0 && (
                <p className="text-muted-foreground/70 px-1 text-xs leading-5">
                  {t("settings.skills.shadowHint")}
                </p>
              )}
            </>
          )}

          {/* 加载诊断：琥珀色告警面板，折叠放置，不与清单争视觉（坏文件警告不致命） */}
          {snap.diagnostics.length > 0 && (
            <details className="group border-amber-500/20 bg-amber-500/5 overflow-hidden rounded-xl border text-[13px] leading-5">
              <summary className="hover:bg-amber-500/10 flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 transition-colors [&::-webkit-details-marker]:hidden">
                <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-foreground font-medium">{t("settings.skills.diagnostics")}</span>
                <Badge
                  variant="secondary"
                  className="bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1.5 py-0 text-3xs font-medium"
                >
                  {snap.diagnostics.length}
                </Badge>
                <span className="text-muted-foreground/70 hidden text-[13px] leading-5 sm:inline">
                  {t("settings.skills.diagnosticsHint")}
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
                        <span className="block text-[13px] leading-5 break-all">{message}</span>
                        {path && (
                          <span className="text-muted-foreground/70 mt-0.5 block font-mono text-3xs leading-4 break-all">
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
          if (!viewing || !(viewing.editable || viewing.managed)) return;
          remove(viewing);
          setViewingKey(null);
        }}
      />
    </div>
  );
};
