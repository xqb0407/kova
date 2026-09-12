"use client";

import { useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import { PencilIcon } from "lucide-react";
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
  PERSONALIZATION_STYLE_OPTIONS,
  savePersonalization,
  usePersonalization,
  type Personalization,
} from "@/lib/personalization";

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

/** Markdown 长文本字段的弹窗配置（maxLength 与 sidecar normalizePersonalization 的截断一致） */
const MARKDOWN_FIELDS = {
  persona: {
    title: "编辑人设 / 人格描述",
    maxLength: 4000,
    placeholder:
      "用 Markdown 描述 WorkBuddy 的身份与性格，例如：\n\n- 一位资深的全栈工程师搭档\n- 沟通简洁直接，喜欢用类比解释复杂概念",
  },
  customInstructions: {
    title: "编辑自定义指令",
    maxLength: 8000,
    placeholder:
      "例如：\n- 默认使用 TypeScript，优先复用现有工具函数\n- 解释代码时先给要点列表\n- 不要重复我的问题原文",
  },
} as const;

type MarkdownFieldKey = keyof typeof MARKDOWN_FIELDS;

/** Markdown 长文本字段小节：标题 + 编辑按钮 + 预览卡片（点击卡片同样进入编辑） */
const MarkdownFieldSection: FC<{
  title: string;
  desc: string;
  emptyHint: string;
  value: string;
  onEdit: () => void;
}> = ({ title, desc, emptyHint, value, onEdit }) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm">{desc}</p>
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
 *  事实源在 sidecar（SQLite kv 持久化 + 活动会话系统提示词热替换），这里只镜像；
 *  文本改动防抖 600ms 自动保存，卸载时冲刷未保存的草稿。版式对齐外观页。 */
export const PersonalizationSettings: FC = () => {
  const prefs = usePersonalization();
  const [draft, setDraft] = useState<Personalization>(prefs);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latest = useRef(draft);
  // 脏标记：保存往返期间用户继续输入时，不被 store 回发的旧值覆盖草稿
  const dirty = useRef(false);
  // Markdown 编辑弹窗：关闭时保留挂载（dialogField 不清空），退场动画不被切断
  const [dialogField, setDialogField] = useState<MarkdownFieldKey | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const statusText =
    saveState === "error" ? "保存失败，请重试" : saveState === "pending" ? "保存中…" : "已自动保存";

  const dialogMeta = dialogField ? MARKDOWN_FIELDS[dialogField] : null;

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

        {/* 回复风格：预设档位，提示词文案在 sidecar personalization.ts */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">回复风格</h2>
          <p className="text-muted-foreground text-sm">
            影响每次对话的语气与表达方式，改动对进行中的会话即时生效。
          </p>
          <div className="bg-muted/50 grid grid-cols-2 gap-2 rounded-2xl p-2 sm:grid-cols-3">
            {PERSONALIZATION_STYLE_OPTIONS.map((opt) => {
              const active = draft.style === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ style: opt.value })}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors",
                    active
                      ? "border-primary/60 bg-background ring-primary/40 ring-1"
                      : "border-transparent bg-background/60 hover:bg-background",
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-muted-foreground text-xs">{opt.desc}</span>
                </button>
              );
            })}
          </div>
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

        {/* 人设 / 自定义指令：Markdown 卡片预览，编辑走懒加载的弹窗编辑器 */}
        <MarkdownFieldSection
          title="人设 / 人格描述"
          desc="描述 AI 是谁、以什么身份与你协作，支持 Markdown 格式。"
          emptyHint="尚未设置。描述 AI 的背景、性格、沟通习惯，例如「一位资深的全栈工程师搭档，喜欢用类比解释复杂概念」。"
          value={personaPreview}
          onEdit={() => openMarkdownDialog("persona")}
        />

        <MarkdownFieldSection
          title="自定义指令"
          desc="每次对话都会携带的额外指示，例如技术栈偏好、输出格式要求、回复语言等，支持 Markdown 格式。"
          emptyHint="尚未设置。例如「默认使用 TypeScript；解释代码时先给要点列表；不要重复我的问题原文」。"
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
            maxLength={dialogMeta.maxLength}
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
      </div>
    </div>
  );
};
