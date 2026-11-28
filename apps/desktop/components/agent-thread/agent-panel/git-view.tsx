"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitGraphIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitStage,
  type GitBranches,
  type GitFileEntry,
} from "@/lib/git/git";
import { refreshGitStatus, useGitStatus } from "@/lib/git/git-status";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { cn } from "@/lib/utils";
import { splitPath, StatusLetter } from "./git-files";
import { FileTypeIcon } from "./file-type-icon";
import { GitGraph } from "./git-graph";

/**
 * Git 标签：VS Code 源代码管理同构布局。
 * 顶部工具栏（分支/同步状态/刷新）→ 提交框 → 暂存的更改 / 更改 → 提交图形。
 * 文件行点击打开「审查」标签定位到该文件的 diff；行尾悬停按钮做单文件
 * 暂存/取消暂存，分组头做整组操作。写命令成功后主进程回推 "git-changed"，
 * 状态缓存自动刷新（这里只维护 busy 与错误提示）。
 */

/** 提交信息草稿按 cwd 缓存：点文件跳去审查标签再切回来不丢已输入的内容 */
const commitDrafts = new Map<string, string>();

/** 图形区高度（像素，localStorage 记忆）；未记忆时用 32% 面板高的默认值 */
const GRAPH_HEIGHT_KEY = "git-graph-height";
const GRAPH_MIN_HEIGHT = 140;
/** 拖拽时给上方文件列表至少留出的高度（行高 28 × 3 + 余量） */
const LIST_MIN_HEIGHT = 104;

/** 顶栏紧凑分支切换器:下拉列分支 + 新建分支(内联输入跟在触发器右侧) */
const BranchSwitcher: FC<{
  cwd: string;
  current: string | null;
  branches: GitBranches | null;
  onBusy: (b: boolean) => void;
  onError: (e: string | null) => void;
}> = ({ cwd, current, branches, onBusy, onError }) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const checkout = async (target: string, create: boolean) => {
    onBusy(true);
    onError(null);
    try {
      await gitCheckout(cwd, target, create);
      setCreating(false);
      setName("");
    } catch (err) {
      onError(`切换分支失败：${String(err)}`);
    } finally {
      onBusy(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="hover:bg-muted flex min-w-0 max-w-[11rem] items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-foreground/90 transition-colors"
              title={current ?? "未知分支"}
            >
              <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="block truncate">{current ?? "…"}</span>
              <ChevronDownIcon className="text-muted-foreground/60 size-3 shrink-0" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          {/* Base UI：DropdownMenuLabel 必须处于 DropdownMenuGroup 内 */}
          <DropdownMenuGroup className="w-full">
            <DropdownMenuLabel>切换分支</DropdownMenuLabel>
            {(branches?.branches ?? []).map((b) => (
              <DropdownMenuItem
                key={b.name}
                disabled={b.current}
                onClick={() => checkout(b.name, false)}
              >
                <span className="min-w-0 truncate">{b.name}</span>
                {b.upstream ? (
                  <span className="text-muted-foreground ml-auto shrink-0 truncate text-xs">
                    {b.upstream}
                  </span>
                ) : null}
                <CheckIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    b.current ? "opacity-100" : "opacity-0",
                  )}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5 shrink-0" />
            新建分支…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 新建分支：菜单收起后焦点落到这行的输入框（autoFocus） */}
      {creating ? (
        <>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="分支名"
            className="h-6 w-24 shrink-0 text-xs"
            onKeyDown={(e) => {
              // IME 组合中：回车是确认候选词，不是建分支
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter" && name.trim())
                void checkout(name.trim(), true);
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={!name.trim()}
            onClick={() => void checkout(name.trim(), true)}
          >
            创建
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label="取消"
            onClick={() => setCreating(false)}
          >
            <XIcon className="size-3" />
          </Button>
        </>
      ) : null}
    </>
  );
};

/** 单文件行（VS Code SCM 同款）：整行点击看 diff，行尾悬停做暂存/取消暂存 */
const ChangeRow: FC<{
  f: GitFileEntry;
  busy: boolean;
  onToggle: (path: string, on: boolean) => void;
  onOpen: (path: string) => void;
}> = ({ f, busy, onToggle, onOpen }) => {
  const { dir, base } = splitPath(f.path);
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${f.path}\n点击查看 diff`}
      onClick={() => onOpen(f.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(f.path);
        }
      }}
      className="group hover:bg-muted/60 focus-visible:bg-muted/60 flex h-7 cursor-pointer items-center gap-1.5 rounded-xs pr-1.5 pl-4 outline-none transition-colors"
    >
      <FileTypeIcon path={f.path} />
      <span className="max-w-[58%] min-w-0 shrink-0 truncate text-ui text-foreground/90">
        {base}
      </span>
      {dir ? (
        <span className="text-muted-foreground/55 min-w-0 flex-1 truncate text-xs">
          {dir}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <button
        type="button"
        disabled={busy}
        title={f.staged ? "取消暂存" : "暂存更改"}
        aria-label={f.staged ? `取消暂存 ${f.path}` : `暂存 ${f.path}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(f.path, !f.staged);
        }}
        className="text-muted-foreground hover:text-foreground hover:bg-foreground/10 focus-visible:bg-foreground/10 grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-0"
      >
        {f.staged ? (
          <MinusIcon className="size-3.5" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
      </button>
      <StatusLetter
        status={f.status}
        title={f.staged ? "待提交（已暂存）" : "更改（未暂存）"}
      />
    </div>
  );
};

/** 可折叠分组（暂存的更改 / 更改）：扁平头 + 计数 + 整组暂存动作 */
const ChangeSection: FC<{
  title: string;
  files: GitFileEntry[];
  staged: boolean;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onStageAll: (on: boolean) => void;
  onToggleFile: (path: string, on: boolean) => void;
  onOpenFile: (path: string) => void;
}> = ({
  title,
  files,
  staged,
  open,
  busy,
  onToggleOpen,
  onStageAll,
  onToggleFile,
  onOpenFile,
}) => {
  const GroupActionIcon = staged ? MinusIcon : PlusIcon;
  const groupAction = staged ? "全部取消暂存" : "全部暂存";
  return (
    <section className="flex flex-col">
      <div className="flex h-8 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggleOpen}
          className="hover:bg-muted/50 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors"
        >
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span className="min-w-0 truncate text-ui font-semibold text-foreground/85">
            {title}
          </span>
          <span className="text-muted-foreground bg-muted/70 shrink-0 rounded-full px-1.5 text-3xs leading-4 font-medium tabular-nums">
            {files.length}
          </span>
        </button>
        <button
          type="button"
          title={groupAction}
          aria-label={groupAction}
          disabled={busy || files.length === 0}
          onClick={() => onStageAll(!staged)}
          className="text-muted-foreground hover:text-foreground hover:bg-muted/70 grid size-6 shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40"
        >
          <GroupActionIcon className="size-3.5" />
        </button>
      </div>
      {open ? (
        files.length === 0 ? (
          <div className="text-muted-foreground px-2 pb-1 pl-7 text-xs">
            没有更改
          </div>
        ) : (
          <div className="flex flex-col">
            {files.map((f) => (
              <ChangeRow
                key={f.path}
                f={f}
                busy={busy}
                onToggle={onToggleFile}
                onOpen={onOpenFile}
              />
            ))}
          </div>
        )
      ) : null}
    </section>
  );
};

export const GitView: FC<{ cwd: string }> = ({ cwd }) => {
  const { status } = useGitStatus(cwd);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [message, setMessageState] = useState(
    () => commitDrafts.get(cwd) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // 本地刷新钮
  // 分组折叠状态：暂存组默认展开；更改组常显（空态给「没有更改」）
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  // 图形区高度拖拽：null = 默认 32% 面板高；拖动后落成像素并记忆
  const [graphHeight, setGraphHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const graphHeightRef = useRef<number | null>(null);
  const dragRef = useRef<{
    startY: number;
    startHeight: number;
    maxHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const commitRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLElement>(null);

  const applyGraphHeight = useCallback((h: number | null) => {
    graphHeightRef.current = h;
    setGraphHeight(h);
  }, []);

  const persistGraphHeight = useCallback((h: number | null) => {
    try {
      if (h === null) localStorage.removeItem(GRAPH_HEIGHT_KEY);
      else localStorage.setItem(GRAPH_HEIGHT_KEY, String(Math.round(h)));
    } catch {
      // localStorage 不可用：本次会话内仍可拖，只是不记忆
    }
  }, []);

  // 恢复上次高度（首帧用默认高度，避免 SSR 水合不一致）
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(GRAPH_HEIGHT_KEY));
      if (Number.isFinite(saved) && saved >= GRAPH_MIN_HEIGHT) {
        applyGraphHeight(saved);
      }
    } catch {
      /* ignore */
    }
  }, [applyGraphHeight]);

  /** 图形区最大高度：不挤压提交区，并给文件列表留出至少 3 行 */
  const maxGraphHeight = useCallback(() => {
    const root = rootRef.current;
    const rootRect = root?.getBoundingClientRect();
    if (!rootRect) return 320;
    const commitBottom = commitRef.current
      ? commitRef.current.getBoundingClientRect().bottom - rootRect.top
      : 220;
    return Math.max(
      GRAPH_MIN_HEIGHT,
      Math.min(
        rootRect.height * 0.68,
        rootRect.height - commitBottom - LIST_MIN_HEIGHT,
      ),
    );
  }, []);

  const beginGraphResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!graphOpen || !graphRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startHeight: graphRef.current.getBoundingClientRect().height,
      maxHeight: maxGraphHeight(),
    };
    setResizing(true);
  };

  const moveGraphResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 往上拖 = 变高；夹在最小高度与上方列表的可用空间之间
    applyGraphHeight(
      Math.min(
        drag.maxHeight,
        Math.max(
          GRAPH_MIN_HEIGHT,
          drag.startHeight + (drag.startY - e.clientY),
        ),
      ),
    );
  };

  const endGraphResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    persistGraphHeight(graphHeightRef.current);
  };

  const resetGraphHeight = () => {
    applyGraphHeight(null);
    persistGraphHeight(null);
  };

  const onGraphResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const current =
      graphHeightRef.current ??
      graphRef.current?.getBoundingClientRect().height ??
      220;
    const delta = e.key === "ArrowUp" ? 16 : -16;
    const next = Math.min(
      maxGraphHeight(),
      Math.max(GRAPH_MIN_HEIGHT, current + delta),
    );
    applyGraphHeight(next);
    persistGraphHeight(next);
  };

  const load = useCallback(() => {
    gitBranches(cwd)
      .then((b) => setBranches(b))
      .catch(() => {});
  }, [cwd]);

  // 挂载 / 手动刷新（tick）/ 切目录：拉分支列表
  useEffect(() => {
    load();
  }, [load, tick, cwd]);

  // 分支列表只在**status 报的分支名发生迁移**时重拉（含 agent 在后台 checkout：
  // status 由 git-status store 的 git-changed 全局刷新带回）。
  // 不许写成"branches.current !== status.branch 就 load()"：两侧口径不一定相等
  // （detached 时 status.branch 是短哈希、branches.current 是 null），不等的判据
  // 会永久成立 → load → setBranches 新对象 → effect 再跑 → 无限 IPC 拉分支，
  // 主进程被 for-each-ref 刷爆、界面假死。改为与"上一次 status 报的分支"比较，
  // 任何口径差异都只影响首次对齐，不构成循环。
  const prevStatusBranchRef = useRef<string | null>(null);
  useEffect(() => {
    const current = status?.branch ?? null;
    const prev = prevStatusBranchRef.current;
    if (prev === null) {
      prevStatusBranchRef.current = current;
      return; // 首次只登记基线（挂载 effect 已拉过一次列表）
    }
    if (current !== null && current !== prev) {
      prevStatusBranchRef.current = current;
      load();
    }
  }, [status?.branch, load]);

  // cwd 变化时恢复该目录的提交草稿
  useEffect(() => {
    setMessageState(commitDrafts.get(cwd) ?? "");
  }, [cwd]);

  const setMessage = useCallback(
    (value: string) => {
      setMessageState(value);
      commitDrafts.set(cwd, value);
    },
    [cwd],
  );

  const toggleStage = async (path: string, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await gitStage(cwd, [path], on);
    } catch (err) {
      setError(`暂存操作失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const stageAll = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await gitStage(cwd, [], on);
    } catch (err) {
      setError(`暂存操作失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const files = status?.files ?? [];
  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => !f.staged);
  const stagedCount = stagedFiles.length;

  const commit = async (all = false) => {
    const msg = message.trim();
    if (!msg) return;
    setBusy(true);
    setError(null);
    try {
      if (all) await gitStage(cwd, [], true);
      await gitCommit(cwd, msg);
      commitDrafts.delete(cwd);
      setMessageState("");
      refreshGitStatus(cwd);
    } catch (err) {
      const s = String(err);
      setError(
        s.includes("nothing to commit")
          ? "没有已暂存的变更可提交"
          : `提交失败：${s}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /** 点击文件：聚焦到「审查」标签并定位该文件（已有审查标签则复用） */
  const openFileDiff = useCallback(
    (path: string) => {
      focusPanelTab("review", { cwd, focus: path, checkpoint: undefined });
    },
    [cwd],
  );

  // 没有已暂存内容时主按钮退化为「全部提交」（VS Code 对无暂存改动的
  // 二次确认在这里变成显式文案：点了就是先全暂存再提交）
  const commitAll = stagedCount === 0;
  const canCommit = !busy && message.trim().length > 0 && files.length > 0;
  const commitShortcut = "⌘/Ctrl+↵";

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex h-full min-h-0 flex-col",
        resizing && "cursor-row-resize select-none",
      )}
    >
      {/* 顶栏：分支 / 同步状态 / 变更计数 / 刷新 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <BranchSwitcher
          cwd={cwd}
          current={status?.branch ?? branches?.current ?? null}
          branches={branches}
          onBusy={setBusy}
          onError={setError}
        />
        {status?.ahead ? (
          <span
            title={`领先上游 ${status.ahead} 个提交`}
            className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
          >
            <ArrowUpIcon className="size-3" />
            {status.ahead}
          </span>
        ) : null}
        {status?.behind ? (
          <span
            title={`落后上游 ${status.behind} 个提交`}
            className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
          >
            <ArrowDownIcon className="size-3" />
            {status.behind}
          </span>
        ) : null}
        <span className="text-muted-foreground/70 ml-auto min-w-0 truncate pl-2 text-xs tabular-nums">
          {files.length > 0 ? `${files.length} 个更改` : "工作区干净"}
        </span>
        <button
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={() => {
            refreshGitStatus(cwd);
            setTick((t) => t + 1);
          }}
          className="hover:bg-muted hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors"
        >
          <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
        </button>
      </div>

      {/* 提交区固定在顶部（VS Code 同款：长列表滚动时提交按钮不消失） */}
      <div
        ref={commitRef}
        className="flex shrink-0 flex-col gap-2 px-2 pt-2.5 pb-2"
      >
        {error ? (
          <div className="text-destructive bg-destructive/5 flex items-start gap-1.5 rounded-xl border border-destructive/30 px-2.5 py-2 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-all">{error}</span>
          </div>
        ) : null}

        {/* 提交框：输入区 + 整宽提交钮 + 更多提交动作（对齐 VS Code 提交区） */}
        <div className="bg-card/40 focus-within:border-ring/40 overflow-hidden rounded-xl border border-border/70 transition-colors">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`提交信息（${commitShortcut} 在 "${
              status?.branch || "HEAD"
            }" 提交）`}
            rows={3}
            className="bg-transparent focus-visible:bg-transparent min-h-[68px] resize-none rounded-none border-0 px-3 py-2 text-ui shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                // ⇧ 强制全部提交；否则与主按钮同口径（已有暂存就只提暂存）
                void commit(e.shiftKey || commitAll);
              }
            }}
          />
          <div className="flex items-stretch gap-1 border-t border-border/50 p-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 min-w-0 flex-1 gap-1.5 text-xs"
              disabled={!canCommit}
              title={
                !message.trim()
                  ? "请输入提交信息"
                  : commitAll
                    ? `没有已暂存的更改，将暂存全部 ${files.length} 个文件并提交`
                    : `${commitShortcut}（提交已暂存的 ${stagedCount} 个文件）`
              }
              onClick={() => void commit(commitAll)}
            >
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
              <span className="truncate">
                {commitAll
                  ? `全部提交${files.length > 0 ? ` (${files.length})` : ""}`
                  : `提交 (${stagedCount})`}
              </span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    className="h-7 w-6 shrink-0"
                    aria-label="更多提交操作"
                    title="更多提交操作"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>提交</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={!canCommit || stagedCount === 0}
                    onClick={() => void commit()}
                  >
                    <CheckIcon />
                    提交已暂存的更改
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canCommit}
                    onClick={() => void commit(true)}
                  >
                    <GitCommitHorizontalIcon />
                    暂存全部并提交
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={busy || unstagedFiles.length === 0}
                  onClick={() => void stageAll(true)}
                >
                  <PlusIcon />
                  全部暂存
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || stagedFiles.length === 0}
                  onClick={() => void stageAll(false)}
                >
                  <MinusIcon />
                  全部取消暂存
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* 文件列表：只有暂存/更改分组滚动，提交区与图形常驻 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="flex flex-col gap-0.5">
          {stagedFiles.length > 0 ? (
            <ChangeSection
              title="暂存的更改"
              files={stagedFiles}
              staged
              open={stagedOpen}
              busy={busy}
              onToggleOpen={() => setStagedOpen((o) => !o)}
              onStageAll={stageAll}
              onToggleFile={toggleStage}
              onOpenFile={openFileDiff}
            />
          ) : null}
          <ChangeSection
            title="更改"
            files={unstagedFiles}
            staged={false}
            open={changesOpen}
            busy={busy}
            onToggleOpen={() => setChangesOpen((o) => !o)}
            onStageAll={stageAll}
            onToggleFile={toggleStage}
            onOpenFile={openFileDiff}
          />
        </div>
      </div>

      {/* 图形区上缘拖拽条：上下拖动调高（双击复位），聚焦后 ↑↓ 也能调 */}
      {graphOpen ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整图形高度"
          tabIndex={0}
          title="拖动调整图形高度（双击复位）"
          onPointerDown={beginGraphResize}
          onPointerMove={moveGraphResize}
          onPointerUp={endGraphResize}
          onPointerCancel={endGraphResize}
          onLostPointerCapture={endGraphResize}
          onDoubleClick={resetGraphHeight}
          onKeyDown={onGraphResizeKeyDown}
          className="group/handle relative flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
        >
          <div className="bg-border/60 pointer-events-none h-px w-full transition-colors group-hover/handle:bg-foreground/30 group-active/handle:bg-foreground/45 group-focus-visible/handle:bg-foreground/45" />
        </div>
      ) : null}

      {/* 底部固定图形：高度可拖拽；内容在自身区域内滚动 */}
      <section
        ref={graphRef}
        className={cn(
          "flex shrink-0 flex-col overflow-hidden",
          graphOpen
            ? graphHeight === null && "h-[clamp(140px,32%,320px)]"
            : "h-8 border-t border-border/60",
        )}
        style={
          graphOpen && graphHeight !== null
            ? {
                height: graphHeight,
                minHeight: GRAPH_MIN_HEIGHT,
                maxHeight: "68%",
              }
            : undefined
        }
      >
        <div className="flex h-8 shrink-0 items-center px-2">
          <button
            type="button"
            aria-expanded={graphOpen}
            onClick={() => setGraphOpen((o) => !o)}
            className="hover:bg-muted/50 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors"
          >
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                !graphOpen && "-rotate-90",
              )}
            />
            <GitGraphIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 truncate text-ui font-semibold text-foreground/85">
              图形
            </span>
          </button>
          <span className="text-muted-foreground/70 max-w-[9rem] shrink-0 truncate px-1.5 text-xs">
            {status?.branch ?? "HEAD"}
          </span>
        </div>
        {graphOpen ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <GitGraph cwd={cwd} tick={tick} />
          </div>
        ) : null}
      </section>
    </div>
  );
};
