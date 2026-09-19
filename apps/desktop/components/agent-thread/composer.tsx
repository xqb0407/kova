"use client";

import { ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { GroupedTriggerPopover } from "@/components/agent-thread/composer-grouped-popover";
import {
  useComposerSlashMenu,
  useSubagentMention,
} from "@/components/agent-thread/composer-commands";
import { CmComposerInput } from "@/components/agent-thread/cm-composer-input";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { PiModelPicker } from "@/components/agent-thread/model-picker";
import { ThinkingPicker } from "@/components/agent-thread/thinking-picker";
import { ModePicker } from "@/components/agent-thread/mode-picker";
import { ContextButton } from "@/components/agent-thread/context-button";
import { PromptQueueBar } from "@/components/agent-thread/prompt-queue-bar";
import { markSteerNextSend } from "@/lib/pi-steer-intent";
import { ToolApprovalCard } from "@/components/agent-thread/tool-approval-card";
import { QuestionCard } from "@/components/agent-thread/question-card";
import { usePendingQuestions } from "@/lib/pi-question";
import { Button } from "@/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  matchesShortcut,
  resolveComposerSubmitMode,
  useShortcuts,
  type ShortcutConfig,
} from "@/lib/shortcuts";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitGraphIcon,
  Loader2Icon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FC, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import {
  PROMPT_IMAGE_MAX_COUNT,
  promptFileKind,
  validatePromptFile,
} from "@/lib/prompt-attachments";
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

/**
 * 输入框键盘守卫：
 * 1) 输入法回车守卫——WKWebView 下回车确认候选词的 keydown 常带 isComposing=false
 *    （或紧随 compositionend 之后送达），库内建的 composing 检查拦不住，导致误发送。
 *    display:contents 包装层上以捕获阶段监听：组合中（isComposing / keyCode 229）
 *    或组合结束后 120ms 宽限窗口内的 Enter，直接 stopPropagation，让 Lexical 挂在
 *    contenteditable 上的 keydown 根本收不到；不 preventDefault，候选词确认仍走默认。
 * 2) 自定义发送——「发送消息」被绑成非 Enter 组合时（submitMode="none"），库不会在
 *    Enter 提交，这里捕获命中绑定即 aui.composer.send()；Enter 落回库默认→换行。
 * 用原生 DOM 而非 lexical 命令：app 与库解析到的 @lexical/react 是两份模块实例，
 * useLexicalComposerContext 拿不到库内的 Composer 上下文。
 */
const ImeEnterGuard: FC<{
  children: ReactNode;
  send: ShortcutConfig;
  interceptSend: boolean;
}> = ({ children, send, interceptSend }) => {
  const ref = useRef<HTMLDivElement>(null);
  const aui = useAui();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let compositionEndedAt = 0;
    const onCompositionEnd = () => {
      compositionEndedAt = performance.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const composing = event.isComposing || event.keyCode === 229;
      const inGrace = performance.now() - compositionEndedAt <= 120;
      if (event.key === "Enter" && (composing || inGrace)) {
        event.stopPropagation();
        return;
      }
      // 自定义发送组合（如 ⌘Enter 之外的绑定）：组合态不劫持，交由 IME 逻辑处理
      if (interceptSend && !composing && matchesShortcut(event, send)) {
        event.preventDefault();
        event.stopPropagation();
        aui.composer.send();
      }
    };
    el.addEventListener("keydown", onKeyDown, true);
    el.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, [aui, interceptSend, send]);
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

export const Composer: FC = () => {
  // / 指令菜单（命令/技能/MCP 工具三分类）与 @ 子智能体提及，数据聚合见 composer-commands.ts
  const mention = useSubagentMention();
  const slash = useComposerSlashMenu();
  // 提问卡片与输入框互斥：Question 工具挂起期间整条 composer 让位给卡片
  // （作答/跳过 → question_answer 结算 → finish chunk 清空，composer 复原）
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const questions = usePendingQuestions(threadId);
  // 发送键：Enter / ⌘Enter 交库原生提交；其余组合 submitMode="none"，由守卫拦截
  const { sendMessage } = useShortcuts();
  const submitMode = resolveComposerSubmitMode(sendMessage);
  const interceptSend = submitMode === "none";
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
            <ImeEnterGuard send={sendMessage} interceptSend={interceptSend}>
            <CmComposerInput
              submitMode={submitMode}
              placeholder="输入任务指令 @选择智能体，/打开指令菜单"
              className="aui-composer-input relative min-h-10 w-full px-2.5 py-1 text-base leading-6 [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-editor]:max-h-48 [&_.cm-scroller]:overscroll-contain [&_.cm-scroller]:overflow-y-auto [&_.cm-placeholder]:text-sm [&_.cm-placeholder]:text-muted-foreground/60 [&_.cm-placeholder]:pointer-events-none [&_.cm-placeholder]:truncate [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center"
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

        <GroupedTriggerPopover
          char="@"
          {...mention}
          emptyLabel="暂无子智能体"
        />

        <GroupedTriggerPopover
          char="/"
          {...slash}
          emptyLabel="无匹配项"
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
                // base-ui 条目只认 onClick（无 Radix 的 onSelect），选中后保持
                // 菜单展开要靠 closeOnClick=false——目录是多选式速切，收起反打断
                closeOnClick={false}
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
              // 点开后菜单要留在原地（就地切换到分支名输入行）：base-ui 用
              // closeOnClick=false，onSelect+preventDefault 的 Radix 写法无效
              closeOnClick={false}
              onClick={() => {
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

/** 发送/停止共用按钮（单按钮三态，同一槽位，方块⇄箭头随输入切换）：
 *  - 空闲：↑ 发送（库原生 Send，沿用其禁用谓词）；
 *  - 运行中输入为空：■ 停止生成；
 *  - 运行中输入有内容：↑ 点击=进发送队列（sidecar 当前轮结束后自动执行），
 *    ⌥/Alt+点击=并入当前轮（steer：注入活跃轮，不排队不中止）；
 *    键盘 Enter/⌘Enter 同提交语义，Shift+⌘/Ctrl+Enter=并入。
 *  运行中走手动 aui.composer.send() 绕开 ComposerPrimitive.Send 的
 *  isRunning 禁用谓词 */
const AdaptiveSendButton: FC = () => {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const canSend = useAuiState((s) => s.composer.canSend);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  if (isRunning && !canSend) {
    return (
      <ComposerPrimitive.Cancel asChild>
        <TooltipIconButton
          tooltip="停止生成"
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="aui-composer-cancel size-7 bg-primary rounded-full hover:bg-primary/80"
          aria-label="Stop generating"
        >
          <div className="size-3 fill-current bg-white " />
        </TooltipIconButton>
      </ComposerPrimitive.Cancel>
    );
  }
  if (isRunning) {
    return (
      <TooltipIconButton
        tooltip="发送（当前回复完成后自动排队）· ⌥/Alt 点击并入当前回复"
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full bg-primary!"
        aria-label="Send message"
        onClick={(e) => {
          if (e.altKey && threadId) markSteerNextSend(threadId);
          aui.composer.send();
        }}
      >
        <ArrowUpIcon className="size-4 text-white!" />
      </TooltipIconButton>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton
        tooltip="发送消息"
        side="bottom"
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-send size-7 rounded-full bg-primary!"
        aria-label="Send message"
      >
        <ArrowUpIcon className="aui-composer-send-icon size-4 text-white!" />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
  );
};

/**
 * 附件按钮（composer 动作区最左）：选文件经 validatePromptFile 前置校验
 * （图片/文档白名单与大小上限，不合格 toast 拒收）。图片沿用单条 4 张的
 * 添加时闸门；文档不拦添加（数量/总体积由 sidecar 落盘裁决，拒收折算说明行）。
 * 不按模型能力隐藏——纯文本模型发图由 sidecar 硬门折算占位说明，UI 恒可用；
 * 粘贴路径同款校验见 cm-composer-input。
 */
const AddAttachmentButton: FC = () => {
  const aui = useAui();
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    for (const file of files) {
      const err = validatePromptFile(file);
      if (err) toast.error(err);
    }
    const accepted = files.filter((file) => !validatePromptFile(file));
    const imageCount = (aui.composer.getState().attachments ?? []).filter(
      (a) => a.type === "image",
    ).length;
    let imageTaken = 0;
    for (const file of accepted) {
      const isImage = promptFileKind(file.name, file.type) === "image";
      if (isImage) {
        if (imageTaken >= Math.max(0, PROMPT_IMAGE_MAX_COUNT - imageCount)) {
          toast.error(`单条消息最多 ${PROMPT_IMAGE_MAX_COUNT} 张图片`);
          continue;
        }
        imageTaken += 1;
      }
      await aui.composer.addAttachment(file).catch(() => {});
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.rtf"
        multiple
        hidden
        onChange={(e) => void onChange(e)}
      />
      <TooltipIconButton
        tooltip="添加附件"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none"
        aria-label="Add Attachment"
        onClick={() => inputRef.current?.click()}
      >
        <PlusIcon className="aui-attachment-add-icon size-4" />
      </TooltipIconButton>
    </>
  );
};

const ComposerAction: FC = () => {  return (
    // flex-wrap：窄对话列（小窗口 + 右面板展开）时两组按钮各自成行，
    // 避免固有宽度撑破消息流（超长内容一律走截断，不靠横向滚动）
    <div className="aui-composer-action-wrapper relative flex flex-wrap items-center justify-between gap-y-1.5">
      <div className="flex items-center gap-1">
        <AddAttachmentButton />
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
        <AdaptiveSendButton />
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
          <CmComposerInput
            autoFocus
            className="aui-edit-composer-input min-h-14 w-full px-4 pt-3 pb-1 text-foreground text-base outline-none [&_.cm-editor]:bg-transparent [&_.cm-editor]:outline-none [&_.cm-scroller]:overscroll-contain [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center"
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