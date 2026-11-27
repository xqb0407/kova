"use client";

/**
 * 自动化弹窗的「执行指令」输入：**直接复用聊天 composer 的输入组件与触发菜单**，
 * 只是挂在弹窗自己的一个本地 runtime 上（不接当前会话）。
 *
 * 为什么要独立 runtime：`CmComposerInput` 读的是 assistant-ui 的 composer store
 * （`useComposerInput`）与触发弹层上下文，脱离 Provider 无法工作；而若挂到会话
 * runtime 上，弹窗里的编辑动作会串进当前会话的草稿与偏好（automation-editor-dialog
 * 头注记的正是这个坑）。这里用一个 noop 的 `useLocalRuntime` 提供上下文，
 * 会话侧完全不受影响。
 *
 * 差异只有三处，其余（芯片视觉、`@`/`/` 菜单、插入语义、输入法保护）与会话内一致：
 * - `standalone`：Enter 只换行、Escape 不取消本轮；提交交给弹窗的「创建任务」按钮；
 * - `/` 菜单去掉面板类命令（弹窗里没有可开的面板）；
 * - 文本经 TextBridge 与表单字段双向同步。
 */
import { useEffect, useRef, type FC, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { directiveChipVariants } from "@/components/assistant-ui/elements/directive-text.aui";
import { CmComposerInput } from "@/components/agent-thread/cm-composer-input";
import { GroupedTriggerPopover } from "@/components/agent-thread/composer-grouped-popover";
import {
  useComposerSlashMenu,
  useSubagentMention,
} from "@/components/agent-thread/composer-commands";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 不跑真实对话：这个 runtime 只用来承载 composer 的输入状态 */
const noopChatModel: ChatModelAdapter = {
  async *run() {},
};

/** 表单 ↔ composer 文本桥：挂载时用表单初值播种，之后把草稿推回表单 */
const TextBridge: FC<{ initial: string; onChange: (v: string) => void }> = ({
  initial,
  onChange,
}) => {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const seeded = useRef(false);
  // 首帧的 text 还是空串（播种尚未生效），推给表单会把初值冲掉——跳过第一轮
  const pushedOnce = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (initial) aui.composer.setText(initial);
  }, [aui, initial]);
  useEffect(() => {
    if (!pushedOnce.current) {
      pushedOnce.current = true;
      return;
    }
    onChange(text);
  }, [text, onChange]);
  return null;
};

export const AutomationPromptField: FC<{
  value: string;
  onChange: (v: string) => void;
  /** 外壳底部操作行（工作目录/权限/模型胶囊），与 composer 的动作行同位 */
  footer?: ReactNode;
  placeholder?: string;
  className?: string;
}> = ({ value, onChange, footer, placeholder, className }) => {
  const t = useT();
  const runtime = useLocalRuntime(noopChatModel);
  const mention = useSubagentMention();
  const slash = useComposerSlashMenu({ includeCommands: false });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TextBridge initial={value} onChange={onChange} />
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root
          // 与会话 composer 同一张皮：玻璃卡壳（--composer-bg/85 + 毛玻璃 + 圆角
          // token）。--composer-radius/padding 挂在会话根的内联变量，这里不在
          // 会话子树里，按 subagent-tab 同款给回退（1rem / 12px = composer 默认）
          className={cn(
            "relative rounded-lg  border border-border/40  flex w-full cursor-text flex-col gap-1.5   p-2 bg-muted/50",
            directiveChipVariants,
            className,
          )}
        >
          <CmComposerInput
            standalone
            submitMode="none"
            placeholder={placeholder}
            // 输入区与 composer 同规格：min-h-12 / text-base / placeholder
            // 0.9375rem；限高同 composer 的 cm-editor max-h-48
            className="aui-composer-input bord relative min-h-12 w-full px-2 py-1 text-sm leading-6 [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-editor]:max-h-48 [&_.cm-placeholder]:pointer-events-none [&_.cm-placeholder]:truncate [&_.cm-placeholder]:text-[0.9375rem] [&_.cm-placeholder]:text-muted-foreground [&_.cm-scroller]:overscroll-contain [&_.cm-scroller]:overflow-y-auto"
          />
          {footer ? (
            <div className="flex flex-wrap items-center gap-1">{footer}</div>
          ) : null}
          {/* 与会话 composer 的差异：会话里输入框贴屏幕底、弹层向上翻；弹窗里
              输入框上方只有名称栏一点空间，且外层是 overflow-y-auto 的滚动区，
              向上翻会被滚动容器顶边裁掉——这里改为向下弹出 */}
          <GroupedTriggerPopover
            char="@"
            {...mention}
            emptyLabel={t("automation.promptField.noSubagents")}
            placement="down"
            className="mb-0"
          />
          <GroupedTriggerPopover
            char="/"
            {...slash}
            emptyLabel={t("automation.promptField.noMatches")}
            placement="down"
            className="mb-0"
          />
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </AssistantRuntimeProvider>
  );
};
