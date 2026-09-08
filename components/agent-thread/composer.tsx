"use client";

import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector.aui";
import { docsModelOptions } from "@/components/docs/assistant/docs-model-options";
import { DEFAULT_MODEL_ID } from "@/lib/model";
import { Button } from "@/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAuiState,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { LexicalComposerInput, type DirectiveChipProps } from "@assistant-ui/react-lexical";
import {
  ArrowUpIcon,
  FolderOpenIcon,
  GlobeIcon,
  HelpCircleIcon,
  LanguagesIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  SlashIcon,
  SquareIcon,
  WrenchIcon,
  FileTextIcon,
  XIcon,
} from "lucide-react";
import { useState, type FC } from "react";
import { isTauri } from "@/lib/tauri";
import {
  clearWorkspace,
  openWorkspacePicker,
  pathBasename,
  setWorkspace,
  useWorkspace,
  useWorkspaceRecents,
} from "@/lib/workspace-store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const models = docsModelOptions();

const ModelPicker: FC = () => {
  return (
    <ModelSelector
      models={models}
      defaultValue={DEFAULT_MODEL_ID}
      variant="ghost"
      size="sm"
      className="h-7 rounded-full"
    />
  );
};

const slashCommands: readonly Unstable_SlashCommand[] = [
  {
    id: "summarize",
    description: "Summarize the conversation",
    icon: "FileText",
    execute: () => console.log("[base example] /summarize invoked"),
  },
  {
    id: "translate",
    description: "Translate text to another language",
    icon: "Languages",
    execute: () => console.log("[base example] /translate invoked"),
  },
  {
    id: "search",
    description: "Search the web for information",
    icon: "Globe",
    execute: () => console.log("[base example] /search invoked"),
  },
  {
    id: "help",
    description: "List available commands",
    icon: "HelpCircle",
    execute: () => console.log("[base example] /help invoked"),
  },
];

const slashIconMap: Record<string, FC<{ className?: string }>> = {
  FileText: FileTextIcon,
  Languages: LanguagesIcon,
  Globe: GlobeIcon,
  HelpCircle: HelpCircleIcon,
};

function DirectiveChip(props: DirectiveChipProps) {
  const { directiveId, directiveType, label } = props;
  const showWrench = directiveType !== "command";
  return (
    <span
      className="aui-directive-chip"
      data-directive-type={directiveType}
      data-directive-id={directiveId}
    >
      {showWrench && (
        <span className="aui-directive-chip-icon">
          <WrenchIcon className="size-3" />
        </span>
      )}
      <span className="aui-directive-chip-label">{label}</span>
    </span>
  );
}

export const Composer: FC = () => {
  const mention = unstable_useMentionAdapter({ fallbackIcon: WrenchIcon });
  const slash = unstable_useSlashCommandAdapter({
    commands: slashCommands,
    iconMap: slashIconMap,
    fallbackIcon: SlashIcon,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col ">
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60  data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          >
            <ComposerQuotePreview />
            <ComposerAttachments />
            <LexicalComposerInput
              directiveChip={DirectiveChip}
              placeholder="输入任务指令 @选择智能体，/打开指令菜单"
              className=" aui-composer-input text-sm [&_.aui-lexical-placeholder]:text-sm [&_.aui-lexical-placeholder]:text-muted-foreground/60 relative max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1"
            />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>

        {/* workspace 选择：仅开始对话前显示，位于输入框下方 */}
        <WorkspacePill />

        <ComposerTriggerPopover char="@" {...mention} />

        <ComposerTriggerPopover
          char="/"
          {...slash}
          emptyItemsLabel="No matching commands"
        />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/** Codex 风格 workspace 胶囊：显示当前工作目录。
 *  点击弹出最近选择列表（最多 5 个）+ 添加按钮；悬浮显示 × 取消选中。
 *  位于输入框下方外置；仅空会话（尚未产生消息）时显示。 */
const WorkspacePill: FC = () => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);

  if (!isTauri() || hasMessages) return null;

  const add = async () => {
    setBusy(true);
    try {
      await openWorkspacePicker();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-workspace"
            title={workspace ?? "选择工作目录"}
            aria-label="Select workspace directory"
            className="group text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors"
          >
            {busy ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <FolderOpenIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {workspace ? pathBasename(workspace) : "选择目录"}
            </span>
            {workspace && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Clear workspace"
                title="取消选择"
                onClick={(e) => {
                  e.stopPropagation();
                  clearWorkspace();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    clearWorkspace();
                  }
                }}
                className="hover:bg-background/80 -me-1 ml-0.5 hidden size-4 shrink-0 items-center justify-center rounded-full group-hover:flex"
              >
                <XIcon className="size-3" />
              </span>
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 p-1">
        <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
          最近使用
        </div>
        {recents.length > 0 ? (
          <div className="flex flex-col">
            {recents.map((dir) => (
              <button
                key={dir}
                type="button"
                title={dir}
                onClick={() => {
                  setWorkspace(dir);
                  setOpen(false);
                }}
                data-selected={dir === workspace}
                className="hover:bg-muted flex h-8 items-center gap-2 rounded-md px-2 text-start text-sm data-selected:bg-muted"
              >
                <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{pathBasename(dir)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground px-2 py-3 text-center text-xs">
            暂无记录
          </div>
        )}
        <div className="bg-border my-1 h-px" />
        <button
          type="button"
          onClick={add}
          disabled={busy}
          className="hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm disabled:opacity-50"
        >
          {busy ? (
            <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
          ) : (
            <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          添加目录…
        </button>
      </PopoverContent>
    </Popover>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerAddAttachment />
      </div>
      <div className="flex items-center gap-1.5">
        <ModelPicker />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

export const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2"
    >
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ml-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
          <LexicalComposerInput
            directiveChip={DirectiveChip}
            autoFocus
            className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none"
          />
          <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
            <ComposerPrimitive.Cancel asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              >
                Cancel
              </Button>
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send asChild>
              <Button size="sm" className="h-8 rounded-full px-3.5">
                Update
              </Button>
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </MessagePrimitive.Root>
  );
};