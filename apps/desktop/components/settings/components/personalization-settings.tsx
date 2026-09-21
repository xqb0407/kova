"use client";

import { useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  useDebouncedCallback,
} from "@/hooks/use-debounced-callback";
import {
  useThrottledValue,
} from "@/hooks/use-throttled-callback";
import {
  BUILTIN_STYLE_PROMPTS,
  CUSTOM_STYLES_MAX,
  CUSTOM_STYLE_ID_PREFIX,
  CUSTOM_STYLE_NAME_MAX_CHARS,
  CUSTOM_STYLE_PROMPT_MAX_CHARS,
  CUSTOM_STYLE_UNNAMED,
  PERSONALIZATION_STYLE_OPTIONS,
  customStyleValue,
  effectiveBuiltinName,
  effectiveBuiltinPrompt,
  findStyleOverride,
  isBuiltinModified,
  makeCustomStyleId,
  savePersonalization,
  usePersonalization,
  usePersonalizationPaths,
  type Personalization,
  type PersonalizationBuiltinStyle,
  type PersonalizationCustomStyle,
} from "@/lib/settings/personalization";

/* 重依赖（CodeMirror / Streamdown）全部走异步分块：编辑弹窗首次点开才拉取，
 * 预览渲染仅在字段有内容时挂载，设置页首屏不背这些包 */
const MarkdownEditDialog = dynamic(() => import("./markdown-edit-dialog"), {
  ssr: false,
  loading: () => null,
});
const MarkdownView = dynamic(
  () =>
    import("@/components/assistant-ui/elements/markdown-text").then(
      (m) => m.MarkdownText,
    ),
  { ssr: false, loading: () => null },
);

/** Markdown 长文本字段的弹窗配置（file = 全局目录身份文件名，事实源在 sidecar 端） */
const MARKDOWN_FIELDS = {
  persona: {
    title: "编辑人设 / 人格描述",
    file: "soul.md",
    placeholder:
      "用 Markdown 描述 WorkBuddy 的身份与性格，例如：\n\n- 一位资深的全栈工程师搭档\n- 沟通简洁直接，喜欢用类比解释复杂概念",
  },
  customInstructions: {
    title: "编辑自定义指令",
    file: "rules.md",
    placeholder:
      "例如：\n- 默认使用 TypeScript，优先复用现有工具函数\n- 解释代码时先给要点列表\n- 不要重复我的问题原文",
  },
} as const;

type MarkdownFieldKey = keyof typeof MARKDOWN_FIELDS;

/** 自定义风格弹窗里风格描述的输入提示（其文本原样作为语气指令注入系统提示词） */
const STYLE_PROMPT_PLACEHOLDER =
  "用 Markdown 描述这种回复的语气与表达习惯，例如：\n\n- 文风偏文学，善用比喻\n- 多用短句，不用 emoji";

/** 自定义风格卡片的一行摘要：首个非空行（去行首 Markdown 标记）截断 */
function customStyleDesc(style: PersonalizationCustomStyle): string {
  const line = style.prompt
    .split("\n")
    .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean);
  return line ? `${line.slice(0, 30)}${line.length > 30 ? "…" : ""}` : "尚未填写风格描述";
}

/** 编辑弹窗的目标：自定义（id null = 新建）或内置档位（编辑 = 写覆盖记录） */
type StyleEditingTarget =
  | { kind: "custom"; id: string | null }
  | { kind: "builtin"; id: PersonalizationBuiltinStyle };

/** 折叠态默认可见的自定义风格卡片数（超出走「显示更多」，避免风格多时区块过长） */
const CUSTOM_STYLES_COLLAPSED_VISIBLE = 2;

/** 折叠取可见列表：正选中的风格顶进可见位保底，其余按列表顺序取前几 */
function visibleCustomStyles(
  styles: PersonalizationCustomStyle[],
  activeId: string | null,
  expanded: boolean,
): { list: PersonalizationCustomStyle[]; hiddenCount: number } {
  if (expanded || styles.length <= CUSTOM_STYLES_COLLAPSED_VISIBLE) {
    return { list: styles, hiddenCount: 0 };
  }
  const list = styles.slice(0, CUSTOM_STYLES_COLLAPSED_VISIBLE);
  const active = activeId ? styles.find((s) => s.id === activeId) : undefined;
  if (active && !list.some((s) => s.id === active.id)) {
    list[CUSTOM_STYLES_COLLAPSED_VISIBLE - 1] = active;
  }
  return { list, hiddenCount: styles.length - list.length };
}

/** Markdown 长文本字段小节：标题 + 编辑按钮 + 文件路径 + 预览卡片（点击卡片同样进入编辑） */
const MarkdownFieldSection: FC<{
  title: string;
  desc: string;
  emptyHint: string;
  /** 全局身份文件绝对路径（外部编辑入口；null 时回退默认位置展示） */
  filePath: string;
  value: string;
  onEdit: () => void;
}> = ({ title, desc, emptyHint, filePath, value, onEdit }) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onEdit}
      >
        <PencilIcon className="size-3.5 shrink-0" />
        编辑
      </Button>
    </div>
    <div
      onClick={onEdit}
      className="bg-muted/50 hover:bg-muted/70 max-h-64 w-full cursor-text overflow-y-auto rounded-2xl p-4 text-left transition-colors"
    >
      {value.trim() ? (
        <MarkdownView text={value} />
      ) : (
        <span className="text-muted-foreground text-sm">{emptyHint}</span>
      )}
    </div>
  </section>
);

type SaveState = "saved" | "pending" | "error";

/** 个性化配置页：回复风格 / 称呼与身份 / 人设 / 自定义指令。
 *  事实源在 sidecar——结构化字段存 SQLite kv；人设与自定义指令存全局身份文件
 *  (~/.xulux/soul.md、rules.md)，可外部编辑，页面上展示文件绝对路径。这里只镜像；
 *  文本改动防抖 600ms 自动保存，卸载时冲刷未保存的草稿。版式对齐外观页。 */
export const PersonalizationSettings: FC = () => {
  const prefs = usePersonalization();
  const paths = usePersonalizationPaths();
  const [draft, setDraft] = useState<Personalization>(prefs);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latest = useRef(draft);
  // 脏标记：保存往返期间用户继续输入时，不被 store 回发的旧值覆盖草稿
  const dirty = useRef(false);
  // Markdown 编辑弹窗：关闭时保留挂载（dialogField 不清空），退场动画不被切断
  const [dialogField, setDialogField] = useState<MarkdownFieldKey | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // 风格弹窗（自定义 + 内置档位共用）：同款关闭保挂载守卫；名称输入与正文分开
  // （正文复用 MarkdownEditDialog 的编辑/预览页签），保存时组装进 draft.styles /
  // draft.styleOverrides 走统一防抖自动保存
  const [styleEditing, setStyleEditing] = useState<StyleEditingTarget | null>(null);
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [styleNameDraft, setStyleNameDraft] = useState("");
  // 自定义风格列表折叠（仅页面态，不落库）：新建成功后自动展开保证新卡片可见
  const [stylesExpanded, setStylesExpanded] = useState(false);

  // 预览卡片值节流：Markdown 重解析至多每 250ms 一次（leading 跟首次、trailing 保最终值）；
  // 弹窗回填仍用 draft 原值（打开即最新，不经节流）
  const personaPreview = useThrottledValue(draft.persona, 250);
  const instructionsPreview = useThrottledValue(draft.customInstructions, 250);

  // sidecar 水合（或他端改动）到达且本地无未保存改动时同步草稿
  useEffect(() => {
    if (!dirty.current) setDraft(prefs);
  }, [prefs]);

  // 防抖自动保存：连续改动折叠为最后一次，600ms 静默后落 sidecar
  const saveRunner = useDebouncedCallback(() => {
    setSaveState("pending");
    savePersonalization(latest.current)
      .then(() => {
        dirty.current = false;
        setSaveState("saved");
      })
      .catch(() => setSaveState("error"));
  }, 600);

  const update = (patch: Partial<Personalization>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    setSaveState("pending");
    saveRunner.run();
  };

  // 卸载兜底：防抖 runner 卸载时会丢弃挂起保存，这里绕过它直发最后一次（fire-and-forget）
  useEffect(
    () => () => {
      if (dirty.current) void savePersonalization(latest.current).catch(() => {});
    },
    [],
  );

  const openMarkdownDialog = (field: MarkdownFieldKey) => {
    setDialogField(field);
    setDialogOpen(true);
  };

  const openStyleDialog = (id: string | null) => {
    setStyleEditing({ kind: "custom", id });
    setStyleNameDraft(
      id ? (latest.current.styles.find((s) => s.id === id)?.name ?? "") : "",
    );
    setStyleDialogOpen(true);
  };

  /** 编辑内置档位：回填当前有效名称与提示词（覆盖记录优先，否则内置基线） */
  const openBuiltinStyleDialog = (id: PersonalizationBuiltinStyle) => {
    setStyleEditing({ kind: "builtin", id });
    setStyleNameDraft(effectiveBuiltinName(id, findStyleOverride(latest.current.styleOverrides, id)));
    setStyleDialogOpen(true);
  };

  /** 弹窗保存：自定义——名称空白回落占位名、新建超上限静默丢弃（网格加号同时禁用）；
   *  内置——稀疏覆盖记录：与基线相同的字段存空串，两字段皆空则删记录（= 恢复默认） */
  const saveStyleDialog = (prompt: string) => {
    const editing = styleEditing;
    if (!editing) return;
    const trimmedName = styleNameDraft.trim().slice(0, CUSTOM_STYLE_NAME_MAX_CHARS);
    if (editing.kind === "builtin") {
      const id = editing.id;
      const label = PERSONALIZATION_STYLE_OPTIONS.find((o) => o.value === id)!.label;
      const name = trimmedName && trimmedName !== label ? trimmedName : "";
      const overridePrompt = prompt === BUILTIN_STYLE_PROMPTS[id] ? "" : prompt;
      const rest = latest.current.styleOverrides.filter((o) => o.id !== id);
      update({
        styleOverrides:
          name || overridePrompt.trim()
            ? [...rest, { id, name, prompt: overridePrompt, hidden: false }]
            : rest,
      });
      return;
    }
    const name = trimmedName || CUSTOM_STYLE_UNNAMED;
    const styles = editing.id
      ? latest.current.styles.map((s) =>
          s.id === editing.id ? { ...s, name, prompt } : s,
        )
      : latest.current.styles.length >= CUSTOM_STYLES_MAX
        ? latest.current.styles
        : [...latest.current.styles, { id: makeCustomStyleId(), name, prompt }];
    const created = styles.length > latest.current.styles.length;
    update({ styles });
    // 新条目追加在列表末尾：自动展开，避免折叠态下"保存了却看不到"
    if (created) setStylesExpanded(true);
  };

  /** 删除自定义风格：正选中它则同时回落默认档（sidecar normalize 同款兜底） */
  const removeCustomStyle = (id: string) => {
    const patch: Partial<Personalization> = {
      styles: latest.current.styles.filter((s) => s.id !== id),
    };
    if (latest.current.style === customStyleValue(id)) patch.style = "default";
    update(patch);
  };

  /** 隐藏内置档位：保留已有内容覆盖 + hidden 标记；正选中则回落默认档（不留隐形选中态） */
  const hideBuiltinStyle = (id: PersonalizationBuiltinStyle) => {
    const prev = findStyleOverride(latest.current.styleOverrides, id);
    const rest = latest.current.styleOverrides.filter((o) => o.id !== id);
    const patch: Partial<Personalization> = {
      styleOverrides: [
        ...rest,
        { id, name: prev?.name ?? "", prompt: prev?.prompt ?? "", hidden: true },
      ],
    };
    if (latest.current.style === id) patch.style = "default";
    update(patch);
  };

  /** 恢复内置档位：删除覆盖记录（改名/文案/隐藏一并回落基线） */
  const restoreBuiltinStyle = (id: PersonalizationBuiltinStyle) => {
    update({
      styleOverrides: latest.current.styleOverrides.filter((o) => o.id !== id),
    });
  };

  /** 一键恢复所有已隐藏的内置档位 */
  const restoreAllHiddenBuiltins = () => {
    update({
      styleOverrides: latest.current.styleOverrides.filter((o) => !o.hidden),
    });
  };

  const statusText =
    saveState === "error" ? "保存失败，请重试" : saveState === "pending" ? "保存中…" : "已自动保存";

  const dialogMeta = dialogField ? MARKDOWN_FIELDS[dialogField] : null;

  // 自定义风格卡片折叠可见集：选中风格保底可见，超出部分收进「显示更多」
  const activeCustomId = draft.style.startsWith(CUSTOM_STYLE_ID_PREFIX)
    ? draft.style.slice(CUSTOM_STYLE_ID_PREFIX.length)
    : null;
  const { list: visibleCustoms } = visibleCustomStyles(
    draft.styles,
    activeCustomId,
    stylesExpanded,
  );
  const showCollapseToggle =
    draft.styles.length > CUSTOM_STYLES_COLLAPSED_VISIBLE;
  // 已隐藏的内置档位（卡片收进网格下方的一行恢复条）
  const hiddenBuiltinOptions = PERSONALIZATION_STYLE_OPTIONS.filter(
    (opt) => findStyleOverride(draft.styleOverrides, opt.value)?.hidden,
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">个性化</h1>
          <span
            className={cn(
              "text-xs",
              saveState === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {statusText}
          </span>
        </div>

        {/* 回复风格：内置档位（可改名/改写/隐藏，覆盖记录落 kv，删记录即恢复默认）+
            自定义风格（名称与描述随整包落 kv，选中即注入提示词）+ 新建入口 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">回复风格</h2>
          <p className="text-muted-foreground text-sm">
            影响每次对话的语气与表达方式，改动对进行中的会话即时生效；预设可编辑、隐藏（随时恢复默认），也可新建自定义风格。
          </p>
          <div className="bg-muted/50 grid grid-cols-2 gap-2 rounded-2xl p-2 sm:grid-cols-3">
            {PERSONALIZATION_STYLE_OPTIONS.map((opt) => {
              const ov = findStyleOverride(draft.styleOverrides, opt.value);
              if (ov?.hidden) return null; // 隐藏的收进网格下方恢复条
              const active = draft.style === opt.value;
              const name = effectiveBuiltinName(opt.value, ov);
              const desc = ov?.prompt.trim()
                ? customStyleDesc({ id: opt.value, name, prompt: ov.prompt })
                : opt.desc;
              return (
                <div key={opt.value} className="group relative">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => update({ style: opt.value })}
                    className={cn(
                      "flex h-full w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2 pr-14 text-left transition-colors",
                      active
                        ? "border-primary/60 bg-background ring-primary/40 ring-1"
                        : "border-transparent bg-background/60 hover:bg-background",
                    )}
                  >
                    <span className="text-sm font-medium">{name}</span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">{desc}</span>
                  </button>
                  <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`编辑风格 ${name}`}
                      title="改名 / 改写提示词"
                      onClick={() => openBuiltinStyleDialog(opt.value)}
                      className="hover:bg-muted rounded-md p-1 transition-colors"
                    >
                      <PencilIcon className="text-muted-foreground size-3.5" />
                    </button>
                    {isBuiltinModified(ov) ? (
                      <button
                        type="button"
                        aria-label={`恢复默认 ${name}`}
                        title="恢复默认文案"
                        onClick={() => restoreBuiltinStyle(opt.value)}
                        className="hover:bg-muted rounded-md p-1 transition-colors"
                      >
                        <RotateCcwIcon className="text-muted-foreground size-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`隐藏风格 ${name}`}
                        title="隐藏此预设"
                        onClick={() => hideBuiltinStyle(opt.value)}
                        className="hover:bg-muted rounded-md p-1 transition-colors"
                      >
                        <Trash2Icon className="text-muted-foreground size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {visibleCustoms.map((s) => {
              const value = customStyleValue(s.id);
              const active = draft.style === value;
              return (
                <div key={s.id} className="group relative">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => update({ style: value })}
                    className={cn(
                      "flex h-full w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2 pr-14 text-left transition-colors",
                      active
                        ? "border-primary/60 bg-background ring-primary/40 ring-1"
                        : "border-transparent bg-background/60 hover:bg-background",
                    )}
                  >
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">
                      {customStyleDesc(s)}
                    </span>
                  </button>
                  <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`编辑风格 ${s.name}`}
                      onClick={() => openStyleDialog(s.id)}
                      className="hover:bg-muted rounded-md p-1 transition-colors"
                    >
                      <PencilIcon className="text-muted-foreground size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除风格 ${s.name}`}
                      onClick={() => removeCustomStyle(s.id)}
                      className="hover:bg-muted rounded-md p-1 transition-colors"
                    >
                      <Trash2Icon className="text-muted-foreground size-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => openStyleDialog(null)}
              disabled={draft.styles.length >= CUSTOM_STYLES_MAX}
              title={
                draft.styles.length >= CUSTOM_STYLES_MAX
                  ? `最多 ${CUSTOM_STYLES_MAX} 个自定义风格`
                  : "新建自定义回复风格"
              }
              className="border-dashed! text-muted-foreground hover:bg-background! hover:text-foreground! flex min-h-[3.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-input bg-transparent px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="size-4 shrink-0" />
              <span className="text-xs">新建风格</span>
            </button>
            {/* 折叠切换：仅自定义风格超出可见数时出现 */}
            {showCollapseToggle && (
              <button
                type="button"
                aria-expanded={stylesExpanded}
                onClick={() => setStylesExpanded((v) => !v)}
                className="text-muted-foreground hover:bg-background! hover:text-foreground! flex min-h-[3.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-transparent bg-transparent px-3 py-2 transition-colors"
              >
                {stylesExpanded ? (
                  <ChevronUpIcon className="size-4 shrink-0" />
                ) : (
                  <ChevronDownIcon className="size-4 shrink-0" />
                )}
                <span className="text-xs">
                  {stylesExpanded
                    ? "收起"
                    : `显示更多（${draft.styles.length - CUSTOM_STYLES_COLLAPSED_VISIBLE}）`}
                </span>
              </button>
            )}
          </div>
          {hiddenBuiltinOptions.length > 0 && (
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 px-2 text-xs">
              <span>
                已隐藏内置风格：
                {hiddenBuiltinOptions
                  .map((opt) =>
                    effectiveBuiltinName(
                      opt.value,
                      findStyleOverride(draft.styleOverrides, opt.value),
                    ),
                  )
                  .join("、")}
              </span>
              <button
                type="button"
                onClick={restoreAllHiddenBuiltins}
                className="hover:text-foreground underline underline-offset-2"
              >
                全部恢复
              </button>
            </p>
          )}
        </section>

        {/* 称呼与身份：双向称呼注入系统提示词 */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">称呼与身份</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="怎么称呼你" desc="AI 在对话中如何称呼你，如昵称或英文名">
              <Input
                className="w-44 bg-background"
                placeholder="留空则不指定"
                value={draft.userName}
                onChange={(e) => update({ userName: e.target.value })}
              />
            </SettingRow>
            <SettingRow label="AI 的名称" desc="AI 在对话中使用的名字">
              <Input
                className="w-44 bg-background"
                placeholder="留空则不指定"
                value={draft.assistantName}
                onChange={(e) => update({ assistantName: e.target.value })}
              />
            </SettingRow>
          </div>
        </section>

        {/* 人设 / 自定义指令：Markdown 卡片预览，编辑走懒加载的弹窗编辑器；
            内容存全局身份文件，可外部编辑 */}
        <MarkdownFieldSection
          title="人设 / 人格描述"
          desc="描述 AI 是谁、以什么身份与你协作"
          emptyHint="尚未设置。描述 AI 的背景、性格、沟通习惯，例如「一位资深的全栈工程师搭档，喜欢用类比解释复杂概念」。"
          filePath={paths?.soul ?? "~/.xulux/soul.md"}
          value={personaPreview}
          onEdit={() => openMarkdownDialog("persona")}
        />

        <MarkdownFieldSection
          title="自定义指令"
          desc="每次对话都会携带的额外指示，例如技术栈偏好、输出格式要求、回复语言等，支持 Markdown 格式。"
          emptyHint="尚未设置。例如「默认使用 TypeScript；解释代码时先给要点列表；不要重复我的问题原文」。"
          filePath={paths?.rules ?? "~/.xulux/rules.md"}
          value={instructionsPreview}
          onEdit={() => openMarkdownDialog("customInstructions")}
        />

        {dialogMeta && dialogField && (
          <MarkdownEditDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title={dialogMeta.title}
            value={
              dialogField === "persona"
                ? draft.persona
                : draft.customInstructions
            }
            placeholder={dialogMeta.placeholder}
            onSave={(next) =>
              update(
                dialogField === "persona"
                  ? { persona: next }
                  : { customInstructions: next },
              )
            }
          />
        )}

        {/* 风格编辑弹窗（自定义 + 内置档位共用）：名称输入附加在标题下方，正文走
            Markdown 编辑/预览页签；内置档已覆盖时左下出现「恢复默认」 */}
        {styleEditing && (
          <MarkdownEditDialog
            open={styleDialogOpen}
            onOpenChange={setStyleDialogOpen}
            title={
              styleEditing.kind === "builtin"
                ? `编辑内置风格「${effectiveBuiltinName(
                    styleEditing.id,
                    findStyleOverride(draft.styleOverrides, styleEditing.id),
                  )}」`
                : styleEditing.id
                  ? "编辑回复风格"
                  : "新建回复风格"
            }
            value={
              styleEditing.kind === "builtin"
                ? effectiveBuiltinPrompt(
                    styleEditing.id,
                    findStyleOverride(draft.styleOverrides, styleEditing.id),
                  )
                : styleEditing.id
                  ? (draft.styles.find((s) => s.id === styleEditing.id)?.prompt ?? "")
                  : ""
            }
            placeholder={
              styleEditing.kind === "builtin"
                ? "用 Markdown 覆写这个档位的完整提示词；清空则回落内置默认文案"
                : STYLE_PROMPT_PLACEHOLDER
            }
            maxLength={CUSTOM_STYLE_PROMPT_MAX_CHARS}
            onSave={saveStyleDialog}
            onRestore={
              styleEditing.kind === "builtin" &&
              isBuiltinModified(findStyleOverride(draft.styleOverrides, styleEditing.id))
                ? () => restoreBuiltinStyle(styleEditing.id)
                : undefined
            }
            extraContent={
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium whitespace-nowrap">风格名称</span>
                <Input
                  value={styleNameDraft}
                  maxLength={CUSTOM_STYLE_NAME_MAX_CHARS}
                  onChange={(e) => setStyleNameDraft(e.target.value)}
                  placeholder="如：文艺、赛博黑客、苏格拉底"
                />
              </div>
            }
          />
        )}
      </div>
    </div>
  );
};
