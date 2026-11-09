"use client";

/**
 * 子智能体编辑：二级页面（不是弹窗）。
 *
 * 为什么从 Dialog 改成页面：能力维度加上技能/MCP/知识源之后，编辑器内容
 * 远超一个 `sm:max-w-2xl` 弹窗能从容承载的高度——表单页签被挤出视口、
 * 保存按钮要滚到底才够得着。改成整页后：
 * - 顶部「返回」与 MarketplaceView 的分段页同一套手势
 * - 内容区独立滚动，操作条常驻底部，不用滚到底才能保存
 * - 两列布局让「描述」和「工具」这类字段并排，页面高度回到一屏内
 *
 * 编辑器与列表共用同一容器（父组件切换渲染），所以返回即回到原处，
 * 滚动位置、已选分段都不丢。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { ChevronLeftIcon, FileTextIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSkills } from "@/lib/skills/skills";
import { useMcpServers } from "@/lib/mcp/mcp";
import {
  FALLBACK_GRANTABLE_TOOLS,
  saveSubagent,
  type PiKnowledgeSource,
} from "@/lib/subagent/subagents";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  addChipClass,
  EditorSection,
  FieldRow,
  MultiSelectField,
  ToggleChip,
} from "./subagent-editor";
import { SubagentAvatarPicker } from "./subagent-avatar-picker";
import { useT } from "@/lib/i18n";

// 纯逻辑（表单↔草稿↔YAML、作用域推导）在 lib/subagent/editor-form.ts，
// 单独成模块是为了能单测——那里出过"复制内置静默丢能力"的事故。
import {
  dirToWorkspaceGlob,
  editorScope,
  EMPTY_FORM,
  entryToForm,
  fileToWorkspaceRel,
  formToDraft,
  formToYaml,
  knowledgeNameFromPath,
  MEMORY_OPTIONS,
  uniqueNameOptions,
  type EditorTarget,
  type FormDraft,
} from "@/lib/subagent/editor-form";

const MEMORY_LABEL: Record<string, string> = {
  none: "settings.subagents.memoryNone",
  private: "settings.subagents.memoryPrivate",
  shared: "settings.subagents.memoryShared",
};
const MEMORY_HINT: Record<string, string> = {
  none: "settings.subagents.memoryNoneHint",
  private: "settings.subagents.memoryPrivateHint",
  shared: "settings.subagents.memorySharedHint",
};

export {
  editorScope,
  EMPTY_FORM,
  entryToForm,
  formToDraft,
  formToYaml,
  MEMORY_OPTIONS,
  type EditorScope,
  type EditorTarget,
  type FormDraft,
} from "@/lib/subagent/editor-form";

export const SubagentEditorPage: FC<{
  target: EditorTarget;
  /** 工作区层保存所需的 cwd */
  workspaceCwd: string | null;
  /** 可授予工具目录（sidecar 事实源；缺省回落旧 6 项） */
  grantableTools?: string[];
  /** 返回列表 */
  onBack: () => void;
  /** 父级已把返回键提到应用顶栏时，页内不再重复一个 */
  hideBack?: boolean;
  /** 保存中状态上抛：顶栏返回键据此禁用 */
  onBusyChange?: (busy: boolean) => void;
  /** 模型选择器由父组件注入（与列表行共用同一个控件） */
  renderModelControl: (value: string | undefined, onChange: (v: string) => void) => React.ReactNode;
}> = ({
  target,
  workspaceCwd,
  grantableTools,
  onBack,
  hideBack = false,
  onBusyChange,
  renderModelControl,
}) => {
  const t = useT();
  const isEdit = target.mode === "edit";
  const scope = editorScope(target);
  const scopeNeedsCwd = scope === "workspace" && !workspaceCwd;

  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [yaml, setYaml] = useState("");
  const [tab, setTab] = useState("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 知识源选目录的失败提示（越界等）——按行号记，免得一行出错全列表都带句错话 */
  const [pickError, setPickError] = useState<{ row: number; text: string } | null>(null);
  /**
   * 头像暂存：不在 FormDraft 里——它不进 YAML（两个页签共享同一份），随「保存」
   * 一起经 save_subagent 落 kv。空串 = 默认图标。
   */
  const [avatar, setAvatar] = useState("");

  const skillsSnapshot = useSkills(workspaceCwd);
  const mcpSnapshot = useMcpServers(workspaceCwd);

  // 保存中状态上抛：顶栏返回键与页内返回同一时刻禁用
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // 打开时回填（切换目标不随外部清单刷新重置）
  useEffect(() => {
    const seed =
      target.mode === "create"
        ? EMPTY_FORM
        : target.mode === "copy"
          ? { ...entryToForm(target.entry), name: `${target.entry.name}-copy` }
          : entryToForm(target.entry);
    setForm(seed);
    setYaml(formToYaml(seed));
    // 编辑沿用现头像；复制把源头像一起带走（复制内置时视觉身份也跟着来）
    setAvatar(target.mode === "create" ? "" : (target.entry.avatar ?? ""));
    setTab("form");
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const toolOptions = grantableTools?.length
    ? grantableTools
    : [...FALLBACK_GRANTABLE_TOOLS];

  const skillOptions = useMemo(
    () => uniqueNameOptions(skillsSnapshot.skills),
    [skillsSnapshot.skills],
  );

  const mcpOptions = useMemo(
    () => uniqueNameOptions(mcpSnapshot.servers),
    [mcpSnapshot.servers],
  );

  const setField = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggleTool = (tool: string) =>
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(tool)
        ? f.tools.filter((t) => t !== tool)
        : [...f.tools, tool],
    }));

  const patchKnowledge = (i: number, patch: Partial<PiKnowledgeSource>) =>
    setForm((f) => ({
      ...f,
      knowledge: f.knowledge.map((k, j) => (j === i ? { ...k, ...patch } : k)),
    }));

  // 知识源要靠 read 打开检索结果：提前提示，不等保存被拒
  const missingReadForKnowledge =
    form.knowledge.length > 0 && !form.tools.includes("read");

  /** 走原生目录选择器填 glob。手打文档 glob 需要知道通配语法，
   *  而那不该是"给 agent 一个知识库"的前置知识。 */
  const pickKnowledgeDir = async (row: number) => {
    setPickError(null);
    if (!workspaceCwd) {
      setPickError({ row, text: t("settings.subagents.pickNoWorkspace") });
      return;
    }
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: t("settings.subagents.pickDirDialogTitle") });
      if (typeof dir !== "string") return; // 用户取消
      const rel = dirToWorkspaceGlob(dir, workspaceCwd);
      if (!rel.ok) {
        setPickError({
          row,
          text:
            rel.reason === "outside"
              ? t("settings.subagents.pickOutsideDir")
              : t("settings.subagents.pickUnresolved"),
        });
        return;
      }
      patchKnowledge(row, { path: rel.glob });
    } catch {
      // 非 桌面壳环境没有原生选择器：保持输入框手填
      setPickError({ row, text: t("settings.subagents.pickNoDirPicker") });
    }
  };

  /** 多选散落文件：第一个填进当前行，其余按序追加成行（检索侧支持单文件 path） */
  const pickKnowledgeFiles = async (row: number) => {
    setPickError(null);
    if (!workspaceCwd) {
      setPickError({ row, text: t("settings.subagents.pickNoWorkspace") });
      return;
    }
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const picked = await open({ multiple: true, directory: false, title: t("settings.subagents.pickFilesDialogTitle") });
      if (!Array.isArray(picked) || picked.length === 0) return; // 用户取消
      const sources: PiKnowledgeSource[] = [];
      for (const file of picked) {
        const rel = fileToWorkspaceRel(file, workspaceCwd);
        if (!rel.ok) {
          setPickError({
            row,
            text:
              rel.reason === "outside"
                ? t("settings.subagents.pickOutsideFiles")
                : t("settings.subagents.pickUnresolved"),
          });
          return;
        }
        sources.push({ name: knowledgeNameFromPath(file), path: rel.glob });
      }
      setForm((f) => {
        const rows = f.knowledge.map((k, j) => (j === row ? { ...k, ...sources[0] } : k));
        const extra = sources
          .slice(1)
          .filter((s) => !f.knowledge.some((k) => k.path === s.path));
        return { ...f, knowledge: [...rows, ...extra] };
      });
    } catch {
      setPickError({ row, text: t("settings.subagents.pickNoFilePicker") });
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSubagent({
        scope,
        cwd: scope === "workspace" ? workspaceCwd : undefined,
        ...(isEdit ? { name: target.entry.name } : {}),
        ...(tab === "yaml" ? { raw: yaml } : { definition: formToDraft(form) }),
        // 头像总是随保存下发（空串=恢复默认）：两个页签共用同一份暂存
        avatar,
      });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title =
    target.mode === "create"
      ? t("settings.subagents.editorCreateTitle")
      : target.mode === "copy"
        ? t("settings.subagents.editorCopyTitle", { name: target.entry.name })
        : t("settings.subagents.editorEditTitle", { name: target.entry.name });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头：返回键默认在页内；父级接管顶栏时只留标题与作用域 */}
      <div className="flex shrink-0 items-center gap-3 pb-4">
        {!hideBack && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2 gap-1"
            onClick={onBack}
            disabled={busy}
          >
            <ChevronLeftIcon className="size-4" />
            {t("settings.subagents.editorBack")}
          </Button>
        )}
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <Badge variant="secondary" className="shrink-0">
          {scope === "workspace" ? t("settings.subagents.scopeWorkspace") : t("settings.subagents.scopeSystem")}
        </Badge>
      </div>

      {/* 内容区：独立滚动，操作条常驻底部 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <TabsList className="h-8 rounded-full p-[3px]">
            <TabsTrigger value="form" className="rounded-full px-3 py-0 text-[13px] leading-5">
               {t("settings.subagents.tabForm")}
            </TabsTrigger>
            <TabsTrigger value="yaml" className="rounded-full px-3 py-0 text-[13px] leading-5">
              {t("settings.subagents.tabYaml")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="form" className="flex max-w-3xl flex-col gap-6 pt-4">
            <EditorSection
              title={t("settings.subagents.sectionBasic")}
              hint={t("settings.subagents.sectionBasicHint")}
            >
              {/* 头像与名称同一行、各带标签：头像列按内容宽，名称占满余量但封顶——
                  1fr 在 6xl 容器里会把单行输入拉成八百多像素，表单需要可读的行宽 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_minmax(0,1fr)_7rem_13rem]">
                <div className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.subagents.avatar.label")}</span>
                  <SubagentAvatarPicker
                    variant="profile"
                    name={form.name.trim() || t("settings.subagents.avatarFallbackName")}
                    avatar={avatar || undefined}
                    onChange={setAvatar}
                  />
                </div>
                <Label className="flex min-w-0 flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.subagents.name")}</span>
                  <Input
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder={t("settings.subagents.namePlaceholder")}
                  />
                </Label>
                <Label className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.subagents.maxTurns")}</span>
                  <Input
                    value={form.maxTurns}
                    onChange={(e) => setField("maxTurns", e.target.value)}
                    placeholder={t("settings.subagents.maxTurnsPlaceholder")}
                    inputMode="numeric"
                  />
                </Label>
                <div className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.subagents.model")}</span>
                  {/* 下拉而非手输：provider/modelId 拼错要到委派时才报错，
                      那时代价是一次失败的委派 */}
                  {renderModelControl(
                    form.model || undefined,
                    (v) => setField("model", v),
                  )}
                </div>
              </div>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.subagents.descriptionLabel")}
                </span>
                <Textarea
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                  rows={2}
                />
              </Label>
            </EditorSection>

            <EditorSection
              title={t("settings.subagents.promptSection")}
              hint={t("settings.subagents.promptSectionHint")}
            >
              <Textarea
                value={form.prompt}
                onChange={(e) => setField("prompt", e.target.value)}
                rows={7}
                className="font-mono text-[13px] leading-5"
              />
            </EditorSection>

            <EditorSection
              title={t("settings.subagents.toolsSection")}
              hint={t("settings.subagents.toolsSectionHint")}
            >
              <div className="flex flex-wrap gap-1.5">
                {toolOptions.map((tool) => (
                  <ToggleChip
                    key={tool}
                    mono
                    active={form.tools.includes(tool)}
                    onClick={() => toggleTool(tool)}
                  >
                    {tool}
                  </ToggleChip>
                ))}
              </div>
            </EditorSection>

            <EditorSection
              title={t("settings.subagents.grantsSection")}
              hint={t("settings.subagents.grantsSectionHint")}
            >
              <MultiSelectField
                label={t("settings.subagents.skillLabel")}
                options={skillOptions}
                value={form.skills}
                onChange={(v) => setField("skills", v)}
                emptyHint={t("settings.subagents.skillsEmpty")}
                optionsReady={!skillsSnapshot.loading && !skillsSnapshot.error}
              />
              <MultiSelectField
                label={t("settings.subagents.mcpLabel")}
                hint={t("settings.subagents.mcpHint")}
                options={mcpOptions}
                value={form.mcpServers}
                onChange={(v) => setField("mcpServers", v)}
                emptyHint={t("settings.subagents.mcpEmpty")}
                optionsReady={!mcpSnapshot.loading && !mcpSnapshot.error}
              />
              <FieldRow label={t("settings.subagents.memoryField")} hint={t("settings.subagents.memoryFieldHint")}>
                {/* 三档互斥，用仓库的 Segmented 而不是又一套手写胶囊 */}
                <Segmented
                  value={form.memory}
                  onChange={(v) => setField("memory", v)}
                  options={MEMORY_OPTIONS.map((o) => ({
                    value: o.value,
                    label: t(MEMORY_LABEL[o.value] ?? MEMORY_LABEL.none),
                  }))}
                  className="w-fit"
                />
                <p className="text-muted-foreground text-[13px] leading-5">
                  {t(MEMORY_HINT[form.memory] ?? MEMORY_HINT.none)}
                </p>
              </FieldRow>
            </EditorSection>

            <EditorSection
              title={t("settings.subagents.knowledgeSection")}
              hint={t("settings.subagents.knowledgeSectionHint")}
            >
              {form.knowledge.length === 0 && (
                <p className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.subagents.knowledgeEmpty")}
                </p>
              )}
              {form.knowledge.map((k, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    value={k.name}
                    onChange={(e) => patchKnowledge(i, { name: e.target.value })}
                    placeholder={t("settings.subagents.knowledgeNamePlaceholder")}
                    className="h-9 w-48 shrink-0 text-[13px] leading-5"
                  />
                  <Input
                    value={k.path}
                    onChange={(e) => patchKnowledge(i, { path: e.target.value })}
                    placeholder={t("settings.subagents.knowledgePathPlaceholder")}
                    className="h-9 flex-1 font-mono text-[13px] leading-5"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1.5 text-[13px] leading-5"
                    onClick={() => void pickKnowledgeDir(i)}
                    title={t("settings.subagents.pickDirTitle")}
                  >
                    <FolderOpenIcon className="size-3.5" />
                    {t("settings.subagents.pickDir")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1.5 text-[13px] leading-5"
                    onClick={() => void pickKnowledgeFiles(i)}
                    title={t("settings.subagents.pickFilesTitle")}
                  >
                    <FileTextIcon className="size-3.5" />
                    {t("settings.subagents.pickFiles")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive h-9 shrink-0 px-2 text-[13px] leading-5"
                    onClick={() =>
                      setField(
                        "knowledge",
                        form.knowledge.filter((_, j) => j !== i),
                      )
                    }
                  >
                    {t("settings.subagents.remove")}
                  </Button>
                  {pickError?.row === i && (
                    <p className="text-destructive w-full text-[13px] leading-5">{pickError.text}</p>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={addChipClass}
                onClick={() =>
                  setField("knowledge", [...form.knowledge, { name: "", path: "" }])
                }
              >
                <PlusIcon className="size-3" />
                {t("settings.subagents.addKnowledge")}
              </Button>
              {missingReadForKnowledge && (
                <p className="text-destructive text-[13px] leading-5">
                  {t("settings.subagents.missingRead")}
                </p>
              )}
            </EditorSection>
          </TabsContent>

          <TabsContent value="yaml" className="max-w-4xl pt-4">
            <Textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={24}
              className="font-mono text-[13px] leading-5"
              spellCheck={false}
            />
            <p className="text-muted-foreground pt-1 text-[13px] leading-5">
              {t("settings.subagents.yamlHint")}
            </p>
          </TabsContent>
        </Tabs>

        {error && (
          <p className="text-destructive mt-3 text-[13px] leading-5" role="alert">
            {error}
          </p>
        )}
        {scopeNeedsCwd && (
          <p className="text-muted-foreground mt-3 text-[13px] leading-5">
            {t("settings.subagents.editorScopeNeedsCwd")}
          </p>
        )}
      </div>

      {/* 操作条常驻底部：内容再长也不用滚到底才能保存 */}
      <div className="border-border/60 flex shrink-0 items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          {t("settings.subagents.editorCancel")}
        </Button>
        <Button onClick={save} disabled={busy || scopeNeedsCwd}>
          {busy ? t("settings.subagents.editorSaving") : t("settings.subagents.editorSave")}
        </Button>
      </div>
    </div>
  );
};