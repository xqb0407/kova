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
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
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

// 纯逻辑（表单↔草稿↔YAML、作用域推导）在 lib/subagent/editor-form.ts，
// 单独成模块是为了能单测——那里出过"复制内置静默丢能力"的事故。
import {
  editorScope,
  EMPTY_FORM,
  entryToForm,
  formToDraft,
  formToYaml,
  MEMORY_OPTIONS,
  type EditorTarget,
  type FormDraft,
} from "@/lib/subagent/editor-form";

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
  /** 模型选择器由父组件注入（与列表行共用同一个控件） */
  renderModelControl: (value: string | undefined, onChange: (v: string) => void) => React.ReactNode;
}> = ({ target, workspaceCwd, grantableTools, onBack, renderModelControl }) => {
  const isEdit = target.mode === "edit";
  const scope = editorScope(target);
  const scopeNeedsCwd = scope === "workspace" && !workspaceCwd;

  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [yaml, setYaml] = useState("");
  const [tab, setTab] = useState("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skillsSnapshot = useSkills(workspaceCwd);
  const mcpSnapshot = useMcpServers(workspaceCwd);

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
    setTab("form");
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const toolOptions = grantableTools?.length
    ? grantableTools
    : [...FALLBACK_GRANTABLE_TOOLS];

  const skillOptions = useMemo(
    () =>
      skillsSnapshot.skills.map((s) => ({
        value: s.name,
        label: s.name,
        ...(s.description ? { hint: s.description } : {}),
      })),
    [skillsSnapshot.skills],
  );

  const mcpOptions = useMemo(
    () =>
      mcpSnapshot.servers.map((s) => ({
        value: s.name,
        label: s.name,
        ...(s.description ? { hint: s.description } : {}),
      })),
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
      });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title =
    target.mode === "create"
      ? "新建子智能体"
      : target.mode === "copy"
        ? `复制 ${target.entry.name}`
        : `编辑 ${target.entry.name}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头：与 MarketplaceView 顶栏同款，返回 + 标题 + 作用域 */}
      <div className="flex shrink-0 items-center gap-3 pb-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground -ml-2 gap-1"
          onClick={onBack}
          disabled={busy}
        >
          <ChevronLeftIcon className="size-4" />
          返回
        </Button>
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <Badge variant="secondary" className="shrink-0">
          {scope === "workspace" ? "工作区级" : "系统级"}
        </Badge>
      </div>

      {/* 内容区：独立滚动，操作条常驻底部 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <TabsList className="h-8 rounded-full p-[3px]">
            <TabsTrigger value="form" className="rounded-full px-3 py-0 text-xs">
              表单
            </TabsTrigger>
            <TabsTrigger value="yaml" className="rounded-full px-3 py-0 text-xs">
              YAML 原文
            </TabsTrigger>
          </TabsList>

          <TabsContent value="form" className="flex max-w-3xl flex-col gap-6 pt-4">
            <EditorSection title="基本信息">
              {/* 名称占满余量但封顶：1fr 在 6xl 容器里会把单行输入拉成八百多像素，
                  表单需要可读的行宽，不是把容器填满 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_13rem]">
                <Label className="flex min-w-0 flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-xs">名称</span>
                  <Input
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="如 customer-service"
                  />
                </Label>
                <Label className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-xs">轮次上限</span>
                  <Input
                    value={form.maxTurns}
                    onChange={(e) => setField("maxTurns", e.target.value)}
                    placeholder="如 40"
                    inputMode="numeric"
                  />
                </Label>
                <div className="flex flex-col items-start gap-1 text-sm">
                  <span className="text-muted-foreground text-xs">模型</span>
                  {/* 下拉而非手输：provider/modelId 拼错要到委派时才报错，
                      那时代价是一次失败的委派 */}
                  {renderModelControl(
                    form.model || undefined,
                    (v) => setField("model", v),
                  )}
                </div>
              </div>
              <Label className="flex flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  描述 —— 主代理据此决定何时委派给它
                </span>
                <Textarea
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                  rows={2}
                />
              </Label>
            </EditorSection>

            <EditorSection
              title="系统提示词"
              hint="这个子智能体自己的行为说明。定义正文排在能力目录之后，对「怎么干活」有最后发言权。"
            >
              <Textarea
                value={form.prompt}
                onChange={(e) => setField("prompt", e.target.value)}
                rows={7}
                className="font-mono text-xs"
              />
            </EditorSection>

            <EditorSection
              title="可用工具"
              hint="未勾选的工具它看不到——不是调用时被拒，是压根不在它的工具表里。"
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
              title="能力授予"
              hint="未选的能力对它不存在，而不是调用时被拒。"
            >
              <MultiSelectField
                label="技能"
                options={skillOptions}
                value={form.skills}
                onChange={(v) => setField("skills", v)}
                emptyHint="还没有技能。到设置 → 技能 里添加，或留空（它将看不到任何技能）。"
                optionsReady={!skillsSnapshot.loading && !skillsSnapshot.error}
              />
              <MultiSelectField
                label="MCP 服务器"
                hint="只能访问这里列出的"
                options={mcpOptions}
                value={form.mcpServers}
                onChange={(v) => setField("mcpServers", v)}
                emptyHint="还没有 MCP 服务器。到设置 → MCP 里添加，或留空（它将访问不到任何外部集成）。"
                optionsReady={!mcpSnapshot.loading && !mcpSnapshot.error}
              />
              <FieldRow label="记忆" hint="独立于设置 → 记忆的全局开关">
                {/* 三档互斥，用仓库的 Segmented 而不是又一套手写胶囊 */}
                <Segmented
                  value={form.memory}
                  onChange={(v) => setField("memory", v)}
                  options={MEMORY_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                  }))}
                  className="w-fit"
                />
                <p className="text-muted-foreground text-xs">
                  {MEMORY_OPTIONS.find((o) => o.value === form.memory)?.hint}
                </p>
              </FieldRow>
            </EditorSection>

            <EditorSection
              title="知识源"
              hint="按需检索，正文不预加载进提示词。"
            >
              {form.knowledge.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  没有知识源。它的回答只能来自模型自身与代码库。
                </p>
              )}
              {form.knowledge.map((k, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    value={k.name}
                    onChange={(e) => patchKnowledge(i, { name: e.target.value })}
                    placeholder="名称（它检索结果里看到的）"
                    className="h-9 w-48 shrink-0 text-xs"
                  />
                  <Input
                    value={k.path}
                    onChange={(e) => patchKnowledge(i, { path: e.target.value })}
                    placeholder="文档路径，如 ./docs/**/*.md"
                    className="h-9 flex-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive h-9 shrink-0 px-2 text-xs"
                    onClick={() =>
                      setField(
                        "knowledge",
                        form.knowledge.filter((_, j) => j !== i),
                      )
                    }
                  >
                    移除
                  </Button>
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
                添加知识源
              </Button>
              {missingReadForKnowledge && (
                <p className="text-destructive text-xs">
                  文件类知识源需要同时勾选 read 工具，否则它检索到的文件打不开。
                </p>
              )}
            </EditorSection>
          </TabsContent>

          <TabsContent value="yaml" className="max-w-4xl pt-4">
            <Textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={24}
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-muted-foreground pt-1 text-xs">
              保存时由 sidecar 以与加载定义文件完全相同的解析校验处理；表单页签的内容不会覆盖此处编辑。
            </p>
          </TabsContent>
        </Tabs>

        {error && (
          <p className="text-destructive mt-3 text-xs" role="alert">
            {error}
          </p>
        )}
        {scopeNeedsCwd && (
          <p className="text-muted-foreground mt-3 text-xs">
            未选择工作区：先在主界面选好工作目录，或改用「新建系统级」。
          </p>
        )}
      </div>

      {/* 操作条常驻底部：内容再长也不用滚到底才能保存 */}
      <div className="border-border/60 flex shrink-0 items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          取消
        </Button>
        <Button onClick={save} disabled={busy || scopeNeedsCwd}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
};