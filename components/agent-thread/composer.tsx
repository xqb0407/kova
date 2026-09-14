"use client";

import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { ThinkingPicker } from "@/components/agent-thread/thinking-picker";
import { ModePicker } from "@/components/agent-thread/mode-picker";
import { ContextButton } from "@/components/agent-thread/context-button";
import { PromptQueueBar } from "@/components/agent-thread/prompt-queue-bar";
import { ToolApprovalCard } from "@/components/agent-thread/tool-approval-card";
import { QuestionCard } from "@/components/agent-thread/question-card";
import { usePendingQuestions } from "@/lib/pi-question";
import { Button } from "@/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { LexicalComposerInput, type DirectiveChipProps } from "@assistant-ui/react-lexical";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitGraphIcon,
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
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "../ui/input";
import { cn } from "cn";
import { useGitStatus } from "@/lib/git-status";
import { gitBranches, gitCheckout, type GitBranches } from "@/lib/git";
import { openPanelTab } from "@/lib/panel-tabs";

const ModelPicker: FC = () => {
  return <PiModelPicker />;
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

/**
 * 输入法回车守卫：WKWebView 下回车确认候选词的 keydown 常带
 * isComposing=false（或紧随 compositionend 之后送达），库内建的 composing
 * 检查拦不住，导致误发送。
 * 实现：display:contents 包装层上以捕获阶段监听——组合中（isComposing /
 * keyCode 229）或组合结束后 120ms 宽限窗口内的 Enter，直接 stopPropagation，
 * 让 Lexical 挂在 contenteditable 上的 keydown 根本收不到（不发送）；
 * 不调 preventDefault，候选词确认仍走浏览器默认行为。
 * 光标停在输入框、非输入法状态下按 Enter 才正常发送。
 * 用原生 DOM 而非 lexical 命令：app 与库解析到的 @lexical/react 是两份模块
 * 实例，useLexicalComposerContext 拿不到库内的 Composer 上下文。
 */
const ImeEnterGuard: FC<{ children: ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let compositionEndedAt = 0;
    const onCompositionEnd = () => {
      compositionEndedAt = performance.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const composing = event.isComposing || event.keyCode === 229;
      const inGrace = performance.now() - compositionEndedAt <= 120;
      if (!composing && !inGrace) return;
      event.stopPropagation();
    };
    el.addEventListener("keydown", onKeyDown, true);
    el.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, []);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

export const Composer: FC = () => {
  const mention = unstable_useMentionAdapter({ fallbackIcon: WrenchIcon });
  const slash = unstable_useSlashCommandAdapter({
    commands: slashCommands,
    iconMap: slashIconMap,
    fallbackIcon: SlashIcon,
  });
  // 提问卡片与输入框互斥：Question 工具挂起期间整条 composer 让位给卡片
  // （作答/跳过 → question_answer 结算 → finish chunk 清空，composer 复原）
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const questions = usePendingQuestions(threadId);
  if (threadId && questions.length > 0) return <QuestionCard />;

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
        <PromptQueueBar />
        <ToolApprovalCard />
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className="border-border/60  data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          >
            <ComposerQuotePreview />
            <ComposerAttachments />
            <ImeEnterGuard>
            <LexicalComposerInput
              directiveChip={DirectiveChip}
              placeholder="输入任务指令 @选择智能体，/打开指令菜单"
              className=" aui-composer-input text-sm [&_.aui-lexical-placeholder]:text-sm [&_.aui-lexical-placeholder]:text-muted-foreground/60 relative max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1"
            />
            </ImeEnterGuard>
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>

       <div className="my-1 flex w-full items-center gap-1 px-2">
         {/* workspace 选择：仅开始对话前显示，位于输入框下方；
             右侧为所选目录的 git 分支胶囊（非仓库静默隐藏） */}
        <WorkspacePill />
        <WorkspaceBranchPill />
       </div>

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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className="inline-flex items-center">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              data-slot="aui-composer-workspace"
              title={workspace ?? "选择工作目录"}
              aria-label="Select workspace directory"
              className={
                cn("group hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-sm transition-colors",
                  workspace ? "bg-muted/50 hover:bg-muted" : "hover:bg-muted",
                )
              }
            >
              {busy ? (
                <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              ) : workspace ? (
                // 已选目录：悬浮时文件夹图标原位变为关闭按钮（整体胶囊即清除入口）
                <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
                  <FolderOpenIcon className="size-3.5 group-hover:hidden" />
                  <span
                    role="button"
                    aria-label="Clear workspace"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      clearWorkspace();
                    }}
                    className="hover:text-destructive hidden size-3.5 shrink-0 items-center justify-center rounded-full group-hover:inline-flex"
                  >
                    <XIcon className="size-3.5" />
                  </span>
                </span>
              ) : (
                <FolderOpenIcon className="size-3.5 shrink-0" />
              )}
              <span className={cn("truncate", workspace ?? "font-medium")}>
                {workspace ? pathBasename(workspace) : "选择目录"}
              </span>
            </button>
          }
        />
      </div>
      <DropdownMenuContent align="start" sideOffset={0} className="w-64 p-0">
        <DropdownMenuGroup className={"p-0"}>
          {/* <DropdownMenuItem>最近使用</DropdownMenuItem> */}
          <Input className="border-0 ring-0 bg-transparent focus-visible:outline-none focus-visible:ring-0 " placeholder="搜索" />
          <DropdownMenuSeparator className={"mt-0"} />
          {/* <DropdownMenuLabel>最近使用</DropdownMenuLabel> */}
          <div className="px-1">
            {recents.length > 0 ? (
            recents.map((dir) => (
              <DropdownMenuCheckboxItem
                key={dir}
                checked={dir === workspace}
                onCheckedChange={(checked) => {
                  if (checked) setWorkspace(dir);
                }}
                onSelect={(e) => e.preventDefault()}
                title={dir}
              >
                <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{pathBasename(dir)}</span>
              </DropdownMenuCheckboxItem>
            ))
          ) : (
            <div className="text-muted-foreground px-2 py-3 text-center text-xs">
              暂无记录
            </div>
          )}
          </div>
        </DropdownMenuGroup>
         <DropdownMenuSeparator  />
       <div className="px-1 pb-1">
         {workspace && (
          <DropdownMenuItem onClick={clearWorkspace}>
            <XIcon className="text-muted-foreground size-3.5 shrink-0" />
            取消选择
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={add} disabled={busy}>
          {busy ? (
            <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
          ) : (
            <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          添加目录…
        </DropdownMenuItem>
       </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * 所选工作目录的 git 分支胶囊（目录选择后自动读取该目录的仓库/分支）：
 * 点开为分支菜单——搜索、分支列表（当前分支带勾选与"未提交的更改：N 个文件"）、
 * 切换/创建检出、Git 图谱（展开右侧面板的 Git 标签）。
 * 非 Tauri / 非 git 仓库 / 已开始对话时静默不渲染（与 WorkspacePill 同步让位）。
 */
const WorkspaceBranchPill: FC = () => {
  const workspace = useWorkspace();
  const { status } = useGitStatus(workspace);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时拉分支列表（菜单低频操作，惰性加载即可）
  useEffect(() => {
    if (!open || !workspace) return;
    let alive = true;
    gitBranches(workspace)
      .then((b) => {
        if (alive && b) setBranches(b);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, workspace]);

  if (!isTauri() || hasMessages || !workspace || !status) return null;

  const close = () => {
    setOpen(false);
    setCreating(false);
    setQuery("");
    setError(null);
  };

  const checkout = async (target: string, create: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await gitCheckout(workspace, target, create);
      close();
    } catch (err) {
      setError(`切换失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openGraph = () => {
    openPanelTab("git");
    // 面板开合是 Base 的本地态，经事件请求展开（见 base.tsx）
    window.dispatchEvent(new Event("agent-panel:open"));
    close();
  };

  const q = query.trim().toLowerCase();
  const list = (branches?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));

  return (
    <DropdownMenu open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-branch"
            title={`${workspace}\n${status.branch}${status.dirty > 0 ? ` · ${status.dirty} 个未提交变更` : ""}`}
            aria-label="Git 分支"
            className={cn(
              "bg-muted/50 hover:bg-muted hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm transition-colors",
            )}
          >
            <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="max-w-[10rem] truncate">{status.branch}</span>
            {status.dirty > 0 ? (
              <span className="bg-muted-foreground/15 shrink-0 rounded-full px-1.5 text-xs leading-4 tabular-nums">
                {status.dirty}
              </span>
            ) : null}
            <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-72 p-0">
        <div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索分支"
            className="border-0 bg-transparent text-sm focus-visible:outline-none focus-visible:ring-0"
          />
        </div>
        <DropdownMenuSeparator className={"mt-0"} />
        <DropdownMenuGroup className="p-0">
          <DropdownMenuLabel>分支</DropdownMenuLabel>
          <div className="h-52 overscroll-contain overflow-y-auto px-1">
            {list.length === 0 ? (
              <div className="text-muted-foreground px-2 py-2 text-xs">
                {branches && branches.branches.length === 0 ? "暂无分支" : "无匹配分支"}
              </div>
            ) : (
              list.map((b) => (
                <DropdownMenuItem
                  key={b.name}
                  disabled={busy || b.current}
                  onClick={() => void checkout(b.name, false)}
                  className="items-start"
                >
                  <GitBranchIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{b.name}</span>
                    {b.current && status.dirty > 0 ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        未提交的更改：{status.dirty} 个文件
                      </span>
                    ) : null}
                  </span>
                  {b.current ? (
                    <CheckIcon className="mt-1 size-3.5 shrink-0" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-1 pb-1">
          {creating ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="新分支名"
                className="h-7 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) void checkout(newName.trim(), true);
                  if (e.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={busy || !newName.trim()}
                onClick={() => void checkout(newName.trim(), true)}
              >
                检出
              </Button>
            </div>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setCreating(true);
                setError(null);
              }}
            >
              <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
              创建并检出新分支…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={openGraph}>
            <GitGraphIcon className="text-muted-foreground size-3.5 shrink-0" />
            Git 图谱
          </DropdownMenuItem>
          {error ? (
            <div className="text-destructive px-2.5 py-1.5 text-xs leading-relaxed">{error}</div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 运行中的排队发送按钮：点击 = 把输入内容加入 sidecar 排队队列（不中止当前回复） */
const QueueSendButton: FC = () => {
  const aui = useAui();
  const canSend = useAuiState((s) => s.composer.canSend);
  return (
    <TooltipIconButton
      tooltip="加入排队（当前回复完成后自动发送）"
      side="bottom"
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-queue-send size-7 rounded-full"
      aria-label="Queue message"
      disabled={!canSend}
      onClick={() => aui.composer.send()}
    >
      <ArrowUpIcon className="size-4" />
    </TooltipIconButton>
  );
};

const ComposerAction: FC = () => {  return (
    // flex-wrap：窄对话列（小窗口 + 右面板展开）时两组按钮各自成行，
    // 避免固有宽度撑破消息流（超长内容一律走截断，不靠横向滚动）
    <div className="aui-composer-action-wrapper relative flex flex-wrap items-center justify-between gap-y-1.5">
      <div className="flex items-center gap-1">
        <ComposerAddAttachment />
        <ModePicker />
      </div>
      <div className="flex items-center gap-1.5">
        <ModelPicker />
        {/* 深度思考档位选择：模型右侧、发送按钮左侧，点开下拉选强度 */}
        <ThinkingPicker />
        <ContextButton />
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
          {/* 运行中发送 = 排队：sidecar 上一轮结束后自动执行，composer 上方
              排队条（PromptQueueBar）可修改/删除/插队。走 aui.composer.send()
              绕开 ComposerPrimitive.Send 的 isRunning 禁用谓词 */}
          <QueueSendButton />
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