"use client";

/**
 * 子智能体管理页。唯一入口：「插件 / 专家 / 技能」→ 管理 → 子智能体（分段器
 * 首位）。文件仍在 settings/components/ 下——组件本身无设置页依赖，是就近
 * 归档，不是残留入口。
 *
 * 事实源在 sidecar：三层定义（内置常量 / <app_data>/subagents / <cwd>/.kova/subagents）
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
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import {
  buildModelOptions,
  groupModelOptions,
} from "@/lib/pi/pi-model-groups";
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
} from "@/lib/workspace/workspace-store";
import {
  deleteSubagent,
  FALLBACK_GRANTABLE_TOOLS,
  refreshSubagents,
  saveSubagent,
  setSubagentEnabled,
  setSubagentModel,
  useSubagents,
  type PiKnowledgeSource,
  type SubagentDraft,
  type SubagentEntry,
} from "@/lib/subagent/subagents";
import { useSkills } from "@/lib/skills/skills";
import { useMcpServers } from "@/lib/mcp/mcp";

const SCOPE_LABEL: Record<SubagentEntry["scope"], string> = {
  builtin: "内置",
  system: "系统",
  workspace: "工作区",
  plugin: "插件",
};

/** 记忆档位选项。缺省 none = 无记忆；这里的开关**独立于**设置 → 记忆的全局开关——
 *  子代理记忆落在自己的命名空间，注入的也是子代理的提示词，不该被主记忆总开关否决。 */
const MEMORY_OPTIONS: Array<{
  value: NonNullable<SubagentDraft["memory"]>;
  label: string;
  hint: string;
}> = [
  { value: "none", label: "无", hint: "不注入、不给工具。每次委派都是冷启动。" },
  {
    value: "private",
    label: "私有",
    hint: "存在本工作区的专属目录里，跨委派累积，只有它自己看得见。",
  },
  {
    value: "shared",
    label: "共享",
    hint: "与主代理的工作区记忆同一目录。它写的内容会出现在你后续的对话里。",
  },
];

/** 表单草稿（maxTurns 用字符串承载，空 = 不设置） */
type FormDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns: string;
  model: string;
  prompt: string;
  /** 能力授予维度 */
  skills: string[];
  mcpServers: string[];
  knowledge: PiKnowledgeSource[];
  memory: NonNullable<SubagentDraft["memory"]>;
};

const EMPTY_FORM: FormDraft = {
  name: "",
  description: "",
  tools: ["read", "glob", "grep"],
  maxTurns: "",
  model: "",
  prompt: "",
  skills: [],
  mcpServers: [],
  knowledge: [],
  memory: "none",
};

function entryToForm(entry: SubagentEntry): FormDraft {
  return {
    name: entry.name,
    description: entry.description,
    tools: entry.tools,
    maxTurns: entry.maxTurns !== undefined ? String(entry.maxTurns) : "",
    model: entry.model ?? "",
    prompt: entry.prompt,
    // 能力维度：未声明回落成"空"，而不是 undefined——表单控件统一按空数组/默认值渲染
    skills: entry.skills ?? [],
    mcpServers: entry.mcpServers ?? [],
    knowledge: entry.knowledge ?? [],
    memory: entry.memory ?? "none",
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
    // 空值一律不落到草稿上：sidecar 据此判定"该维度未声明"，
    // 落了空数组反而会让"复制内置"这类操作带上一堆空壳
    ...(form.skills.length ? { skills: form.skills } : {}),
    ...(form.mcpServers.length ? { mcpServers: form.mcpServers } : {}),
    ...(form.knowledge.length ? { knowledge: form.knowledge } : {}),
    ...(form.memory !== "none" ? { memory: form.memory } : {}),
  };
}

/** 表单 → YAML 文本（新建/复制时的初始展示；合法性与回读以 sidecar 解析为准）。
 *  能力维度必须一并写出——漏掉任一个，"复制内置"就会静默丢掉能力。 */
function formToYaml(form: FormDraft): string {
  const lines = [
    "# Kova subagent definition — managed via Settings → Subagents",
    `name: ${JSON.stringify(form.name.trim())}`,
    `description: ${JSON.stringify(form.description.trim())}`,
    `tools: [${form.tools.join(", ")}]`,
  ];
  const maxTurns = Number(form.maxTurns);
  if (form.maxTurns.trim() && Number.isFinite(maxTurns) && maxTurns > 0) {
    lines.push(`maxTurns: ${Math.floor(maxTurns)}`);
  }
  if (form.model.trim()) lines.push(`model: ${form.model.trim()}`);
  if (form.skills.length) {
    lines.push(`skills: [${form.skills.join(", ")}]`);
  }
  if (form.mcpServers.length) {
    lines.push("mcp:");
    lines.push(`  servers: [${form.mcpServers.join(", ")}]`);
  }
  for (const k of form.knowledge) {
    lines.push("knowledge:");
    lines.push(`  - name: ${JSON.stringify(k.name)}`);
    lines.push(`    type: ${k.type}`);
    if (k.type === "files") lines.push(`    path: ${JSON.stringify(k.path ?? "")}`);
    else {
      lines.push(`    server: ${JSON.stringify(k.server ?? "")}`);
      lines.push(`    tool: ${JSON.stringify(k.tool ?? "")}`);
    }
  }
  if (form.memory !== "none") lines.push(`memory: ${form.memory}`);
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
  /** 可授予工具目录（sidecar 事实源；缺省回落旧 6 项） */
  grantableTools?: string[];
}> = ({ open, onOpenChange, target, workspaceCwd, grantableTools }) => {
  const isEdit = target?.mode === "edit";
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [yaml, setYaml] = useState("");
  const [tab, setTab] = useState("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 能力选择器的候选来源：与主代理同一份数据，不另建通道。
  // 声明的是"引用既有实体"，给自由文本框只会让人写出不存在的名字。
  const skillsSnapshot = useSkills(workspaceCwd);
  const mcpServersSnapshot = useMcpServers(workspaceCwd);

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

  const toggleInList = (key: "skills" | "mcpServers", value: string) =>
    setForm((f) => {
      const list = f[key];
      return {
        ...f,
        [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
      };
    });

  // 可授予工具目录：sidecar 给什么就渲染什么；旧 sidecar 走回落值，
  // 不在前端另留一份会漂移的硬编码副本
  const toolOptions = grantableTools?.length
    ? grantableTools
    : [...FALLBACK_GRANTABLE_TOOLS];

  // files 知识源要靠 read 打开检索结果：缺 read 时提前提示，不等保存被拒
  const hasFilesKnowledge = form.knowledge.some((k) => k.type === "files");
  const missingReadForKnowledge = hasFilesKnowledge && !form.tools.includes("read");

  // 未命中当前作用域的声明（技能被删/服务器改名）：显式警示而非静默丢弃，
  // 否则用户会以为声明生效了
  const availableSkillNames = new Set(skillsSnapshot.skills.map((s) => s.name));
  const missingSkills = form.skills.filter((s) => !availableSkillNames.has(s));
  const availableMcpNames = new Set(mcpServersSnapshot.servers.map((s) => s.name));
  const missingMcp = form.mcpServers.filter((s) => !availableMcpNames.has(s));

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
              ? `保存到所选工作区 ${workspaceCwd ?? ""}/.kova/subagents/（随仓库共享）`
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
              <Label className="flex min-w-0 flex-1 flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">名称</span>
                <Input
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="如 api-auditor"
                />
              </Label>
              <Label className="flex w-28 shrink-0 flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">轮次上限</span>
                <Input
                  value={form.maxTurns}
                  onChange={(e) => setField("maxTurns", e.target.value)}
                  placeholder="如 40"
                  inputMode="numeric"
                />
              </Label>
              <div className="flex w-48 shrink-0 flex-col items-start gap-1 text-sm">
                <span className="text-muted-foreground text-xs">模型</span>
                {/* 下拉而非手输：provider/modelId 拼错在委派时才报错，
                    而那时代价是一次失败的委派。选择器直接给出可用模型。 */}
                <SubagentModelControl
                  value={form.model || undefined}
                  onChange={(v) => setField("model", v)}
                />
              </div>
            </div>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                描述（主代理据此决定何时委派）
              </span>
              <Textarea
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                rows={2}
              />
            </Label>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground text-xs">可用工具</span>
              <div className="flex flex-wrap gap-1.5">
                {toolOptions.map((tool) => {
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
              <p className="text-muted-foreground text-xs">
                未勾选的工具这个子代理看不到——不是调用时被拒，是压根不在它的工具表里。
              </p>
            </div>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">
                系统提示词（delegate 的行为说明）
              </span>
              <Textarea
                value={form.prompt}
                onChange={(e) => setField("prompt", e.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
            </Label>

            {/* ---------------- 能力授予 ---------------- */}
            <div className="border-border/60 mt-1 flex flex-col gap-3 border-t pt-3">
              <div className="text-muted-foreground text-xs">
                能力授予 —— 未选的能力对它不存在，而不是调用时被拒
              </div>

              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">技能</span>
                {skillsSnapshot.skills.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    当前工作区没有可用技能。到设置 → 技能 里添加，或留空（它将看不到任何技能）。
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {skillsSnapshot.skills.map((s) => {
                    const active = form.skills.includes(s.name);
                    return (
                      <button
                        key={s.name}
                        type="button"
                        onClick={() => toggleInList("skills", s.name)}
                        title={s.description}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
                {missingSkills.length > 0 && (
                  <p className="text-destructive text-xs">
                    当前工作区不存在：{missingSkills.join("、")} —— 保存后这些声明不会生效。
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  MCP 服务器 —— 只能访问这里列出的
                </span>
                {mcpServersSnapshot.servers.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    还没有配置 MCP 服务器。到设置 → MCP 里添加，或留空（它将访问不到任何外部集成）。
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {mcpServersSnapshot.servers.map((s) => {
                    const active = form.mcpServers.includes(s.name);
                    return (
                      <button
                        key={s.name}
                        type="button"
                        onClick={() => toggleInList("mcpServers", s.name)}
                        title={s.description}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
                {missingMcp.length > 0 && (
                  <p className="text-destructive text-xs">
                    未配置或已禁用：{missingMcp.join("、")} —— 保存后这些声明不会生效。
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  记忆 —— 独立于设置 → 记忆的全局开关
                </span>
                <div className="flex gap-1.5">
                  {MEMORY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setField("memory", opt.value)}
                      title={opt.hint}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                        form.memory === opt.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {MEMORY_OPTIONS.find((o) => o.value === form.memory)?.hint}
                </p>
              </div>
            </div>

            {/* ---------------- 知识源 ---------------- */}
            <div className="border-border/60 mt-1 flex flex-col gap-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">
                  知识源 —— 按需检索，不预加载进提示词
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full text-xs"
                  onClick={() =>
                    setField("knowledge", [
                      ...form.knowledge,
                      { name: "", type: "files", path: "" },
                    ])
                  }
                >
                  添加
                </Button>
              </div>
              {form.knowledge.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  没有知识源。它的回答只能来自模型自身与代码库。
                </p>
              )}
              {form.knowledge.map((k, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1.5 rounded-md border p-2 text-xs"
                >
                  <div className="flex gap-1.5">
                    <Input
                      value={k.name}
                      onChange={(e) =>
                        setField(
                          "knowledge",
                          form.knowledge.map((x, j) =>
                            j === i ? { ...x, name: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="名称（它检索结果里看到的）"
                      className="h-7 text-xs"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive h-7 shrink-0 rounded-full px-2 text-xs"
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
                  <div className="flex gap-1.5">
                    <select
                      value={k.type}
                      onChange={(e) =>
                        setField(
                          "knowledge",
                          form.knowledge.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  type: e.target.value as "files" | "mcp",
                                  ...(e.target.value === "files"
                                    ? { path: x.path ?? "", server: undefined, tool: undefined }
                                    : { server: x.server ?? "", tool: x.tool ?? "", path: undefined }),
                                }
                              : x,
                          ),
                        )
                      }
                      className="border-input bg-background h-7 rounded-md border px-2 text-xs"
                    >
                      <option value="files">工作区文件</option>
                      <option value="mcp">MCP 服务器</option>
                    </select>
                    {k.type === "files" ? (
                      <Input
                        value={k.path ?? ""}
                        onChange={(e) =>
                          setField(
                            "knowledge",
                            form.knowledge.map((x, j) =>
                              j === i ? { ...x, path: e.target.value } : x,
                            ),
                          )
                        }
                        placeholder="如 ./docs/**/*.md"
                        className="h-7 flex-1 font-mono text-xs"
                      />
                    ) : (
                      <>
                        <Input
                          value={k.server ?? ""}
                          onChange={(e) =>
                            setField(
                              "knowledge",
                              form.knowledge.map((x, j) =>
                                j === i ? { ...x, server: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="服务器名"
                          className="h-7 w-28 font-mono text-xs"
                        />
                        <Input
                          value={k.tool ?? ""}
                          onChange={(e) =>
                            setField(
                              "knowledge",
                              form.knowledge.map((x, j) =>
                                j === i ? { ...x, tool: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="工具名"
                          className="h-7 flex-1 font-mono text-xs"
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
              {missingReadForKnowledge && (
                <p className="text-destructive text-xs">
                  文件类知识源需要同时勾选 read 工具，否则它检索到的文件打不开。
                </p>
              )}
            </div>
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
          {/* 内置定义自身不带 model，能出现在这里的只可能是 kv 里的本机覆盖 */}
          {entry.model && (
            <span className="text-muted-foreground px-1">
              模型 <span className="font-mono">{entry.model}</span>（本机设定）
            </span>
          )}
          {entry.memory && entry.memory !== "none" && (
            <span className="text-muted-foreground px-1">
              记忆 {MEMORY_OPTIONS.find((o) => o.value === entry.memory)?.label ?? entry.memory}
            </span>
          )}
        </div>
        {/* 能力授予维度只读展示：内置不可编辑，但必须看得见自己有哪些能力——
            否则"为什么这个 agent 够不到我的 Notion"无从排查 */}
        {(entry.skills?.length || entry.mcpServers?.length || entry.knowledge?.length) && (
          <div className="flex flex-col gap-1.5 text-xs">
            {entry.skills?.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">技能</span>
                {entry.skills.map((s) => (
                  <span key={s} className="bg-muted rounded-full px-2 py-0.5">
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.mcpServers?.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">MCP</span>
                {entry.mcpServers.map((s) => (
                  <span key={s} className="bg-muted rounded-full px-2 py-0.5 font-mono">
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.knowledge?.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">知识源</span>
                {entry.knowledge.map((k, i) => (
                  <span key={i} className="bg-muted rounded-full px-2 py-0.5">
                    {k.name}
                    <span className="text-muted-foreground ml-1 font-mono">
                      {k.type === "files" ? k.path : `${k.server}__${k.tool}`}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
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
// 行内模型控件
// ---------------------------------------------------------------------------

/** 「跟随会话」的哨兵 id：空串在 cmdk 里语义不干净，用一个不会撞上 provider/modelId 的值 */
const FOLLOW_SESSION_ID = "__follow_session__";
const FOLLOW_SESSION_LABEL = "跟随会话模型";

/**
 * 子智能体的模型选择器。只读层（内置/插件）唯一的改模型入口——它们的定义永不落盘，
 * 选中的值存进 sidecar kv 的覆盖层；可编辑层的模型在编辑弹窗的输入框里改，
 * 不在这里给第二套持久化路径。
 *
 * 交互与同行的启用开关同款：改即存，不进弹窗。
 */
const SubagentModelControl: FC<{
  /** 当前生效的 "provider/modelId"；空 = 跟随会话模型 */
  value: string | undefined;
  onChange: (model: string) => void;
}> = ({ value, onChange }) => {
  const allModels = usePiModels();
  // 与对话页选择器同口径：没配凭据的服务不出现，被过滤隐藏的模型也不出现
  const models = useMemo(
    () => allModels.filter((m) => m.authed && m.enabled !== false),
    [allModels],
  );
  const options = useMemo(() => buildModelOptions(models), [models]);
  const groups = useMemo(
    () => groupModelOptions(models, options),
    [models, options],
  );

  const followSession: ModelOption = {
    id: FOLLOW_SESSION_ID,
    name: FOLLOW_SESSION_LABEL,
    description: "不固定，用会话当前的模型",
  };
  const selectedId = value || FOLLOW_SESSION_ID;
  // 覆盖的模型可能已从目录里删掉（服务被移除），回落显示原始键而不是空占位
  const selectedLabel =
    selectedId === FOLLOW_SESSION_ID
      ? FOLLOW_SESSION_LABEL
      : (options.find((o) => o.id === selectedId)?.name ?? selectedId);

  return (
    <ModelSelectorRoot
      models={[followSession, ...options]}
      value={selectedId}
      onValueChange={(v) => onChange(v === FOLLOW_SESSION_ID ? "" : v)}
      onOpenChange={(open) => open && refreshPiModels()}
    >
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 max-w-56 rounded-full text-xs max-2xl:px-2"
        title={selectedLabel}
      >
        <span className="truncate">{selectedLabel}</span>
      </ModelSelectorTrigger>
      <ModelSelectorContent searchable className="w-80">
        <ModelSelectorSearch placeholder="搜索模型..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>
            没有可用模型，请在设置 → 模型里添加服务
          </ModelSelectorEmpty>
          <ModelSelectorGroup>
            <ModelSelectorItem model={followSession} />
          </ModelSelectorGroup>
          {groups.map((group) => (
            <ModelSelectorGroup
              key={group.title}
              heading={group.title}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
            >
              {group.options.map((o) => (
                <ModelSelectorItem key={o.id} model={o} />
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
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
  onModelChange: (model: string) => void;
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
  onModelChange,
}) => {
  const relPath = entry.path
    ? entry.scope === "workspace" &&
      workspaceCwd &&
      entry.path.startsWith(workspaceCwd + "/")
      ? entry.path.slice(workspaceCwd.length + 1)
      : entry.path
    : null;
  return (
  <div className="hover:bg-muted/70 flex items-center gap-3 rounded-xl px-3 py-2 transition-colors">
    {/* 作用域图标盒（技能/MCP 行同款 size-9 边框盒） */}
    <div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border">
      <BotIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{entry.name}</span>
        <Badge variant="outline" className="shrink-0">
          {SCOPE_LABEL[entry.scope]}
        </Badge>
      </div>
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
        <span className="truncate">{entry.description}</span>
        {relPath && (
          <span
            className="hidden max-w-64 shrink-0 truncate font-mono lg:block"
            title={entry.path ?? undefined}
          >
            {relPath}
          </span>
        )}
      </div>
    </div>
    <Switch
      size="sm"
      checked={entry.enabled}
      onCheckedChange={onToggle}
      aria-label={`${entry.name} 启用`}
    />
    {/* 只读层直接在这里改模型（改即存）；可编辑层的模型归编辑弹窗管，行内只读展示 */}
    {entry.editable ? (
      <span
        className="text-muted-foreground hidden w-56 shrink-0 truncate text-right text-xs lg:block"
        title={entry.model ?? "跟随会话模型"}
      >
        {entry.model ?? "跟随会话模型"}
      </span>
    ) : (
      <SubagentModelControl value={entry.model} onChange={onModelChange} />
    )}
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
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 工作区区块的目录切换器：候选 = 手动浏览的目录 + 当前工作区 + 最近使用。
 *  只切换本页查看的工作区级定义来源，不改动主界面的工作区选择。 */
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
          title={value ?? undefined}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs transition-colors"
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {value ? pathBasename(value) : "未选择工作区"}
          </span>
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

  /** 模型覆盖落 kv；失败已由 mutate 记到 snap.error，这里不重复处理 */
  const changeModel = (entry: SubagentEntry, model: string) => {
    void setSubagentModel(entry.scope, entry.name, model, viewingCwd, entry.pluginId).catch(
      () => {},
    );
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
    empty?: ReactNode,
  ) => (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
          <span className="text-muted-foreground truncate text-xs">{desc}</span>
        </div>
        {actions}
      </div>
      {/* 列表卡片（技能/MCP 列表同款容器） */}
      <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        {entries.length === 0 ? (
          empty ?? (
            <div className="text-muted-foreground px-3 py-3 text-sm">暂无</div>
          )
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
              onModelChange={(model) => changeModel(entry, model)}
            />
          ))
        )}
      </div>
    </section>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-0 py-8">
        {/* 标题行：状态文字在右（MCP/技能页同款） */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">子智能体</h1>
          <span
            className={cn("text-xs", snap.error ? "text-destructive" : "text-muted-foreground")}
          >
            {snap.error
              ? "清单加载失败，可刷新重试"
              : `${snap.agents.length} 个子智能体（${snap.agents.filter((e) => e.enabled).length} 个启用）`}
          </span>
        </div>

        {/* 工具行：说明文字 + 刷新/新建（技能/MCP 工具行同款位置） */}
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">
            管理主代理可委派的子智能体（Task 工具）。内置定义只读、可开关；
            自定义定义以 YAML 存储，改动即时生效，无需重启。
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => void refreshSubagents(viewingCwd)}
              aria-label="刷新"
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 shrink-0 gap-1.5"
              onClick={() => openEditor({ mode: "create", scope: "system" })}
            >
              <PlusIcon className="size-4" />
              新建系统级
            </Button>
            <Button
              className="h-8 shrink-0 gap-1.5"
              onClick={() => openEditor({ mode: "create", scope: "workspace" })}
              disabled={!viewingCwd}
              title={
                viewingCwd ??
                "先在主界面选择工作区，或在下方「工作区」区块选择目录浏览"
              }
            >
              <PlusIcon className="size-4" />
              新建工作区级
            </Button>
          </div>
        </div>

        {/* 清单加载失败：镜像停留在旧值，明确提示并可重试（MCP 错误块同款样式） */}
        {snap.error && (
          <div className="text-destructive bg-destructive/5 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 px-3 py-2.5 text-sm">
            <span>子智能体清单加载失败：{snap.error}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshSubagents(viewingCwd)}
            >
              重试
            </Button>
          </div>
        )}

        {renderSection(
          "内置",
          "随应用发布的四个 delegate：可开关、可在行内指定模型（存在本机，不随版本走）；正文只读，需要改行为请复制为系统级。",
          groups.builtin,
        )}
        {renderSection(
          "系统级",
          "存于应用数据目录 subagents/，对本机所有工作区生效。",
          groups.system,
        )}
        {renderSection(
          viewingCwd ? `工作区 · ${pathBasename(viewingCwd)}` : "工作区",
          viewingCwd
            ? `存于 ${viewingCwd}/.kova/subagents/，随仓库共享。`
            : "未选择工作区：可点右侧目录切换器选择历史目录，或「浏览其他目录…」直接查看某个仓库。",
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
          viewingCwd ? undefined : (
            <div className="text-muted-foreground px-3 py-3 text-sm">
              选择目录后，这里会显示该仓库 .kova/subagents/ 下的子智能体。
            </div>
          ),
        )}

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

        <SubagentEditorDialog
          open={editor.open}
          onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
          target={editor.target}
          workspaceCwd={viewingCwd}
          grantableTools={snap.grantableTools}
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
    </div>
  );
};
