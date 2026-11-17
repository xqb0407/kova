"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ChevronDownIcon,
  EyeIcon,
  GitCompareArrowsIcon,
  Loader2Icon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useScrollLock } from "@/hooks/use-scroll-lock";
import {
  gitCheckpointRestore,
  gitErrorCode,
  gitCheckpointDiff,
  type GitDiffFile,
  type GitDiffResult,
} from "@/lib/git/git";
import { refreshGitStatus } from "@/lib/git/git-status";
import { useMainSessionId } from "@/lib/pi/pi-interaction-session";
import { useThreadAppMode } from "@/lib/pi/pi-session-app-mode";
import {
  packTurnSlot,
  parseTurnSlot,
  turnAnchorUserId,
} from "@/lib/panels/message-turns";
import { focusPanelTab, openOrFocusFileTab } from "@/lib/panels/panel-tabs";
import {
  clearRunCheckpoint,
  useRunCheckpoints,
  type CheckpointEntry,
} from "@/lib/pi/pi-checkpoints";
import {
  fetchTurnEdits,
  isPrimaryTurnEdit,
  turnEditKey,
  turnEditUndoError,
  undoTurnEdit,
  type TurnEdit,
  type TurnEditMap,
} from "@/lib/pi/pi-edits";
import { DiffStats } from "@/components/agent-thread/agent-panel/section-shell";
import { splitPath, StatusDot } from "@/components/agent-thread/agent-panel/git-files";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { cn } from "@/lib/utils";

/**
 * 检查点卡（git 集成 M2）：和产物卡一样按轮渲染——每轮改了文件就在该轮
 * assistant 消息体内钉一张（挂载点见 assistant-message.tsx，产物卡之后、
 * 操作栏之上），历史轮次的卡各归各轮、互不覆盖。汇总"本回合改动了多少"，
 * 可展开逐文件列表
 * （+N -N / 审查 / 打开），只有 撤销 一个出口——改动默认就是保留的，
 * 卡片是"反悔入口"而非决策门。
 * 撤销是破坏性操作：两步式（先转成确认态再执行），且 Rust 侧对
 * "运行结束时刻"存档的 patch 做 --check 前置，用户事后手改过相关
 * 文件时以 apply-conflict 中止，绝不部分覆盖。
 */

/** 展开/收起动画：与轮次折叠（turn-summary）/reasoning/工具组同一套——
 *  globals.css 的 collapsible-down/up 高度关键帧 + 同款缓动，chevron 与
 *  内层 fade/slide/blur 同拍，动画期间钉住滚动位置 */
const CP_ANIMATION_MS = 200;
const CP_EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/** 加载本卡片的逐文件 diff。
 *  - paths 有值（结算刻定格清单）：只回本轮自己的文件，同工作区其它会话
 *    后来改/新增的文件不会混进来；
 *  - paths = []：本轮没有可归因文件，直接空列表（不调 git）；
 *  - undefined（老条目）：legacy 全仓 diff。 */
function loadCheckpointDiff(cp: CheckpointEntry): Promise<GitDiffResult | null> {
  if (!cp.hash) return Promise.resolve(null);
  if (cp.paths && cp.paths.length === 0) {
    return Promise.resolve({ files: [], truncated: false });
  }
  return gitCheckpointDiff(
    cp.cwd,
    cp.hash,
    cp.paths ? { paths: cp.paths } : undefined,
  ).catch(() => null);
}

/** 展开区的逐文件行：状态徽标 + 路径 + 行数统计 + 审查/打开（+ 单文件回滚） */
const CheckpointFileRow: FC<{
  cwd: string;
  checkpoint: string;
  /** 结算刻定格的归属清单：审查视图同样只显示本轮自己的文件 */
  checkpointPaths?: string[];
  file: GitDiffFile;
  /** 条目所有权层该文件本轮记录（无 = 侧车没这条/非结构化编辑来源） */
  edit?: TurnEdit;
  /** 是否提供单文件回滚（sidecar 编辑记录或检查点快照两条通道任一可用） */
  canUndo?: boolean;
  /** 回滚按钮的说明文案（两条通道的语义不同） */
  undoTitle?: string;
  /** 该文件回滚请求在飞 */
  undoing?: boolean;
  onUndo?: (rel: string) => void;
}> = ({
  cwd,
  checkpoint,
  checkpointPaths,
  file,
  edit,
  canUndo = false,
  undoTitle,
  undoing,
  onUndo,
}) => {
  const { dir, base } = splitPath(file.path);
  const review = () => {
    // 定向打开审查标签：diff = 本回合改动 vs 运行前快照；focus 让右侧面板
    // 直接定位到本文件（ZCode 同款交互：审查 → 右侧 panel 看这个文件的改动）。
    // 走 focusPanelTab 复用同一个 review 标签，连点多个文件不堆一排审查页。
    focusPanelTab("review", {
      cwd,
      checkpoint,
      ...(checkpointPaths ? { checkpointPaths } : {}),
      focus: file.path,
    });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openInPanel = () => {
    // 右侧「文件」标签磁盘实时模式打开（与文件树点击同构）：按 (cwd, path)
    // 复用已有标签、没有才新开——不能按类型复用第一个，否则点另一个文件会
    // 把正在看的文件标签顶掉
    openOrFocusFileTab(cwd, file.path, base);
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  return (
    <div className="group/row hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors">
      <StatusDot status={file.status} title={file.status} />
      <FileTypeIcon path={file.path} />
      <span className="min-w-0 shrink-0 text-sm font-medium text-foreground/90">
        {base}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {dir}
      </span>
      {file.binary ? (
        <span className="text-muted-foreground shrink-0 text-xs">
          二进制
        </span>
      ) : (
        <DiffStats
          added={file.added}
          removed={file.removed}
          className="text-[13px]"
        />
      )}
      <span className="ml-1 flex shrink-0 items-center gap-1">
        {canUndo && onUndo ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-[13px]"
            disabled={undoing}
            onClick={() => onUndo(file.path)}
            title={
              undoTitle ??
              (edit?.exact
                ? "仅回滚此文件到本轮开始前的状态，其余改动保留"
                : "回滚此文件到本轮开始前；该文件还含非 agent 改动时会一并退回")
            }
          >
            {undoing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <Undo2Icon className="size-3.5" />
            )}
            回滚
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-[13px]"
          onClick={review}
        >
          <EyeIcon className="size-3.5" />
          审查
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-[13px]"
          onClick={openInPanel}
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
          打开
        </Button>
      </span>
    </div>
  );
};

/**
 * 项目附加根的逐文件行：影子仓库整轮 diff 只覆盖会话 cwd，附加根的文件
 * 来自条目所有权层（root + rel），因此这里只提供「打开」与「回滚」，
 * 不提供依赖影子仓库的「审查」。
 */
const ExternalCheckpointRow: FC<{
  edit: TurnEdit;
  undoing?: boolean;
  onUndo: (root: string, rel: string) => void;
}> = ({ edit, undoing, onUndo }) => {
  const { dir, base } = splitPath(edit.rel);
  const rootLabel =
    edit.root.split(/[\\/]/).filter(Boolean).at(-1) ?? edit.root;
  const openFile = () => {
    // 按 (cwd, rel) 复用/新开文件标签：附加根文件也要能在面板里持续打开
    openOrFocusFileTab(edit.root, edit.rel, base);
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  return (
    <div className="group/row hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors">
      <StatusDot status={edit.status} title={edit.status} />
      <FileTypeIcon path={edit.rel} />
      <span className="min-w-0 shrink-0 text-sm font-medium text-foreground/90">
        {base}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        <span className="bg-muted mr-1 rounded px-1 text-2xs leading-4">
          {rootLabel}
        </span>
        {dir}
      </span>
      {edit.additions >= 0 ? (
        <DiffStats
          added={edit.additions}
          removed={edit.deletions}
          className="text-[13px]"
        />
      ) : null}
      <span className="ml-1 flex shrink-0 items-center gap-1">
        {edit.undoable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-[13px]"
            disabled={undoing}
            onClick={() => onUndo(edit.root, edit.rel)}
            title={
              edit.exact
                ? "仅回滚此文件到本轮开始前的状态，其余改动保留"
                : "本轮该文件还含非 agent 改动；回滚将一并退回"
            }
          >
            {undoing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <Undo2Icon className="size-3.5" />
            )}
            回滚
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-[13px]"
          onClick={openFile}
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
          打开
        </Button>
      </span>
    </div>
  );
};

/** 单张检查点卡：一条结算条目对应一轮，产物卡同款外观 */
const CheckpointCardEntry: FC<{ entry: CheckpointEntry; threadId: string }> = ({
  entry: cp,
  threadId,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<GitDiffFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 整轮撤销后仍有附加根改动：卡片保留，提示逐文件回滚 */
  const [revertNote, setRevertNote] = useState<string | null>(null);
  /** 条目所有权层（sidecar checkpoint store）：rel → 本轮编辑资格；
   *  老条目无 turnId / sidecar 不可达时为空 Map——行不挂回滚钮，卡片照常 */
  const [edits, setEdits] = useState<TurnEditMap>(new Map());
  const [undoingRel, setUndoingRel] = useState<string | null>(null);

  /** 主根记录按 rel 索引（影子仓库 diff 行用 rel 匹配） */
  const primaryEdits = useMemo(() => {
    const map = new Map<string, TurnEdit>();
    for (const edit of edits.values()) {
      if (isPrimaryTurnEdit(edit, cp.cwd)) map.set(edit.rel, edit);
    }
    return map;
  }, [edits, cp.cwd]);

  /** 影子仓库 diff 覆盖不到的主根文件（gitignored / 主目录不是 git 仓库）：
   *  逐文件检查点仍有效，单独列出以便回滚。 */
  const detachedPrimaryEdits = useMemo(() => {
    const shadowPaths = new Set((files ?? []).map((f) => f.path));
    const out: TurnEdit[] = [];
    for (const edit of primaryEdits.values()) {
      if (!shadowPaths.has(edit.rel)) out.push(edit);
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }, [primaryEdits, files]);

  /** 附加根的逐文件记录（主根行仍与影子仓库 diff 按 rel 合并） */
  const externalEdits = useMemo(() => {
    const out: TurnEdit[] = [];
    const seen = new Set<string>();
    for (const edit of edits.values()) {
      if (isPrimaryTurnEdit(edit, cp.cwd)) continue;
      const key = turnEditKey(edit.root, edit.rel);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(edit);
    }
    return out.sort(
      (a, b) => a.root.localeCompare(b.root) || a.rel.localeCompare(b.rel),
    );
  }, [edits, cp.cwd]);

  // 逐文件统计按需加载：折叠态只展示聚合数字，不额外 invoke
  const loadAll = useCallback(
    async (force = false) => {
      if ((files || filesLoading) && !force) return;
      setFilesLoading(true);
      try {
        // hash 为空（主目录不是 git 仓库）时不去调影子仓库；附加根记录照常拉，
        // 不能因为整轮 diff 失败把逐文件回滚入口一起吞掉。
        const [diff, ed] = await Promise.all([
          loadCheckpointDiff(cp),
          fetchTurnEdits(threadId, cp.cwd, cp.turnId),
        ]);
        setFiles(diff?.files ?? []);
        setEdits(ed);
      } catch {
        setFiles([]);
        setEdits(new Map());
      } finally {
        setFilesLoading(false);
      }
    },
    [cp, files, filesLoading, threadId],
  );

  useEffect(() => {
    if (expanded) void loadAll();
  }, [expanded, loadAll]);

  /** 单文件回滚：优先走 sidecar 编辑记录（精确到该轮首次编辑前，且挡运行后
   *  手改）；没有记录（老条目 / 非结构化来源）时退化为检查点快照的单文件
   *  恢复。成功即重载两份数据（行可能整行消失——影子仓库 diff 里该文件不再
   *  有差异） */
  const undoFile = useCallback(
    async (rel: string, root?: string) => {
      if (undoingRel) return;
      const turnId = cp.turnId ?? null;
      const edit = primaryEdits.get(rel);
      const viaEdit =
        turnId !== null && edit?.undoable === true && (!root || root === cp.cwd);
      const viaSnapshot = !root && !!cp.hash && !cp.shared;
      if (!viaEdit && !viaSnapshot) return;
      const key = turnEditKey(root, rel);
      setUndoingRel(key);
      setError(null);
      if (viaEdit && turnId) {
        const res = await undoTurnEdit(threadId, cp.cwd, turnId, rel, root);
        if (!res.ok) {
          setUndoingRel(null);
          setError(turnEditUndoError(res.error));
          return;
        }
      } else {
        try {
          await gitCheckpointRestore(cp.cwd, cp.hash, [rel]);
        } catch (err) {
          setUndoingRel(null);
          const code = gitErrorCode(err);
          setError(
            code === "apply-conflict"
              ? "该文件在运行结束后又被手动改过，为避免误伤已中止回滚。请在审查标签中手动处理。"
              : `回滚失败：${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      setUndoingRel(null);
      // 主根有 git 状态面板；附加根不在影子仓库里，不需要刷
      if (!root || root === cp.cwd) refreshGitStatus(cp.cwd);
      const [diff, ed] = await Promise.all([
        loadCheckpointDiff(cp),
        fetchTurnEdits(threadId, cp.cwd, cp.turnId),
      ]);
      setFiles(diff?.files ?? []);
      setEdits(ed);
      // 本轮已无任何可撤销改动：卡片完成使命，直接收掉
      if ((diff?.files.length ?? 0) === 0 && ed.size === 0) {
        clearRunCheckpoint(threadId, cp.hash);
      }
    },
    [cp, primaryEdits, threadId, undoingRel],
  );

  // 高度动画期间钉住滚动位置（轮次折叠同款）：卡片在消息流中段，展开把下方
  // 内容整体推走时不钉住的话视口会跟着乱跳
  const panelRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(panelRef, CP_ANIMATION_MS);
  const prevExpanded = useRef(expanded);
  useLayoutEffect(() => {
    if (prevExpanded.current === expanded) return;
    prevExpanded.current = expanded;
    lockScroll();
  }, [expanded, lockScroll]);

  const revert = async () => {
    // 共享快照的整仓 diff 混着同工作区其它会话的改动，整轮撤销不可用
    // （按钮已隐藏，这里再挡一次程序化/键盘路径）。逐文件回滚仍可走条目层。
    if (cp.shared) return;
    setBusy(true);
    setError(null);
    setRevertNote(null);
    try {
      await gitCheckpointRestore(cp.cwd, cp.hash);
      refreshGitStatus(cp.cwd);
      // 整轮撤销只覆盖会话 cwd 的影子仓库；影子仓库没收录的文件（gitignored、
      // 主目录非 git、项目附加根）改动仍在时必须保留卡片，否则会连同逐文件
      // 回滚入口一起消失。sidecar 的编辑记录不会随 restore 删除，所以不能只看
      // 条数：undoable = 磁盘现值仍等于该轮 after（未被 restore 覆盖）。
      const allRemaining = await fetchTurnEdits(threadId, cp.cwd, cp.turnId);
      const remaining = new Map(
        [...allRemaining].filter(([, edit]) => edit.undoable),
      );
      if (remaining.size > 0) {
        setFiles([]);
        setEdits(remaining);
        setExpanded(true);
        setRevertNote(
          "整轮撤销只覆盖工作区仓库；未进入整轮快照的文件（gitignored / 附加根）改动仍在，请在下方逐文件回滚。",
        );
        setConfirming(false);
        return;
      }
      clearRunCheckpoint(threadId, cp.hash);
      // 撤销成功即消失；状态/审查视图经 git-changed 事件与这里的显式刷新收敛
    } catch (err) {
      const code = gitErrorCode(err);
      setError(
        code === "apply-conflict"
          ? "运行结束后相关文件又被手动改过，为避免误伤已中止撤销。请在审查标签中手动处理。"
          : `撤销失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  /** 整轮审查：折叠态也能直接跳到右侧 review 标签看本回合全部改动
   *  （与逐文件「审查」同一条路，只是不带 focus） */
  const reviewTurn = () => {
    focusPanelTab("review", {
      cwd: cp.cwd,
      checkpoint: cp.hash,
      ...(cp.paths ? { checkpointPaths: cp.paths } : {}),
    });
    window.dispatchEvent(new Event("agent-panel:open"));
  };

  return (
    <div
      data-slot="aui_message-checkpoint"
      className={cn("animate-in fade-in-0 duration-200")}
    >
      <div className="bg-muted/40 border-border/60 rounded-xl border text-[13px]">
        {/* 整行头部即折叠开关：hover 底色铺满整行（含撤销按钮一侧），
            按压时底色加深；右侧操作区 stopPropagation 不触发开合 */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className={cn(
            // 通栏底色块不做按压缩放：缩放会让行宽缩 1%，两侧露出卡片底色成缝，
            // 按压反馈只走底色加深
            "hover:bg-muted/60 active:bg-muted/80 flex cursor-pointer items-center gap-x-2.5 p-2 transition-colors focus-visible:ring-ring/40 focus-visible:ring-2 focus-visible:outline-none",
            // 展开时底色块下沿改直角，与逐文件面板连成一片；收起时四角全圆
            expanded ? "rounded-t-xl rounded-b-none" : "rounded-xl",
          )}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
        >
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-4 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
          <GitCompareArrowsIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="text-foreground/90 shrink-0 text-sm font-medium">
            {cp.files} 个文件已更改
          </span>
          <DiffStats
            added={cp.added}
            removed={cp.removed}
            className="text-sm"
          />
          {cp.shared ? (
            <span
              className="text-muted-foreground shrink-0 text-2xs"
              title="同一工作区有另一个会话在同时运行：整仓 diff 无法区分归属，这里只显示本会话编辑过的文件；整轮撤销已禁用，可用逐文件回滚。"
            >
              并发会话
            </span>
          ) : null}

          <span
            className="ml-auto flex shrink-0 cursor-default items-center gap-1.5 pr-1"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/* 整轮审查：不等展开，直接跳右侧 review 标签看本回合改动 */}
            {cp.hash ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[13px]"
                onClick={reviewTurn}
              >
                <EyeIcon className="size-3.5" />
                审查
              </Button>
            ) : null}
            {cp.hash && !cp.shared ? (
              confirming ? (
                <>
                  <span className="text-muted-foreground">丢弃全部改动？</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-[13px]"
                    disabled={busy}
                    onClick={revert}
                  >
                    {busy ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Undo2Icon className="size-3.5" />
                    )}
                    确认撤销
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[13px]"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-[13px]"
                  onClick={() => setConfirming(true)}
                >
                  <Undo2Icon className="size-3.5" />
                  撤销
                </Button>
              )
            ) : null}
          </span>
        </div>

        {/* 展开/收起动画：轮次折叠（turn-summary）同款——Base UI Collapsible 的
            collapsible-down/up 高度关键帧 + 内层 fade/slide/blur 同拍；收起态
            面板钉在高度 0 且不响应指针，逐文件列表照常按需加载。 */}
        <Collapsible
          ref={panelRef}
          open={expanded}
          style={{
            ["--animation-duration" as string]: `${CP_ANIMATION_MS}ms`,
          }}
        >
          <CollapsibleContent
            className={cn(
              "group/cp-content overflow-hidden outline-none",
              CP_EASE,
              "motion-reduce:animate-none",
              "data-closed:animate-collapsible-up",
              "data-open:animate-collapsible-down",
              "data-closed:fill-mode-forwards",
              "data-closed:pointer-events-none",
              "[--tw-duration:var(--animation-duration)]",
            )}
          >
            <div
              className={cn(
                "transform-gpu",
                CP_EASE,
                "motion-reduce:animate-none",
                "group-data-open/cp-content:animate-in",
                "group-data-closed/cp-content:animate-out",
                "group-data-open/cp-content:fade-in-0",
                "group-data-closed/cp-content:fade-out-0",
                "group-data-open/cp-content:slide-in-from-top-1",
                "group-data-closed/cp-content:slide-out-to-top-1",
                "group-data-open/cp-content:blur-in-[2px]",
                "group-data-closed/cp-content:blur-out-[2px]",
                "group-data-open/cp-content:animation-duration-(--animation-duration)",
                "group-data-closed/cp-content:animation-duration-(--animation-duration)",
              )}
            >
              <div className="border-border/60 border-t px-1.5 py-1.5">
                {filesLoading ? (
                  <div className="text-muted-foreground flex items-center gap-1.5 px-2 py-1.5">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    读取文件变更…
                  </div>
                ) : (files ?? []).length === 0 &&
                  detachedPrimaryEdits.length === 0 &&
                  externalEdits.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5">
                    读取不到逐文件变更（快照可能已过期）
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {(files ?? []).map((f) => {
                      const edit = primaryEdits.get(f.path);
                      // 两条回滚通道：sidecar 有该文件本轮记录且未手改（精确），
                      // 或检查点快照可恢复（老条目/记录缺失时的兜底）；共享轮次
                      // 不提供快照回滚（无法归因，可能退回别的会话改动）
                      const snapshotUndoable = !!cp.hash && !cp.shared;
                      return (
                        <CheckpointFileRow
                          key={f.path}
                          cwd={cp.cwd}
                          checkpoint={cp.hash}
                          checkpointPaths={cp.paths}
                          file={f}
                          edit={edit}
                          canUndo={edit?.undoable === true || snapshotUndoable}
                          undoTitle={
                            edit?.undoable
                              ? edit.exact
                                ? "仅回滚此文件到本轮开始前的状态，其余改动保留"
                                : "回滚此文件到本轮开始前；该文件还含非 agent 改动时会一并退回"
                              : snapshotUndoable
                                ? "按本轮检查点把该文件回滚到运行前（运行后的手改也会一并退回）"
                                : undefined
                          }
                          undoing={undoingRel === f.path}
                          onUndo={(rel) => void undoFile(rel)}
                        />
                      );
                    })}
                    {detachedPrimaryEdits.length > 0 ? (
                      <div
                        className={cn(
                          "flex flex-col gap-0.5",
                          (files ?? []).length > 0 &&
                            "border-border/60 mt-1 border-t pt-1.5",
                        )}
                      >
                        <div className="text-muted-foreground px-2 text-xs">
                          主目录（未进入整轮快照，可逐文件回滚）
                        </div>
                        {detachedPrimaryEdits.map((edit) => (
                          <ExternalCheckpointRow
                            key={edit.rel}
                            edit={edit}
                            undoing={undoingRel === edit.rel}
                            onUndo={(_root, rel) => void undoFile(rel)}
                          />
                        ))}
                      </div>
                    ) : null}
                    {externalEdits.length > 0 ? (
                      <div
                        className={cn(
                          "flex flex-col gap-0.5",
                          (files ?? []).length > 0 &&
                            "border-border/60 mt-1 border-t pt-1.5",
                        )}
                      >
                        <div className="text-muted-foreground px-2 text-xs">
                          项目附加根（整轮撤销不覆盖，可逐文件回滚）
                        </div>
                        {externalEdits.map((edit) => {
                          const key = turnEditKey(edit.root, edit.rel);
                          return (
                            <ExternalCheckpointRow
                              key={key}
                              edit={edit}
                              undoing={undoingRel === key}
                              onUndo={(root, rel) => void undoFile(rel, root)}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
                {revertNote ? (
                  <div className="text-muted-foreground flex items-start gap-1.5 border-t border-border/60 px-2 pt-1.5 text-[12px] leading-relaxed">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    {revertNote}
                  </div>
                ) : null}
                {error ? (
                  <div className="text-destructive flex items-start gap-1.5 border-t border-border/60 px-2 pt-1.5 leading-relaxed">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
        {/* 折叠态的撤销报错条：不进动画面板，常驻可见 */}
        {!expanded && error ? (
          <div className="text-destructive flex items-start gap-1.5 border-t border-border/60 px-3 py-1.5 leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * 消息内挂载：渲染在 assistant-message.tsx 的产物卡之后、操作栏之上——
 * 卡片属于本轮消息本体。命中判定：当前消息是本轮末条 assistant 消息，
 * 且本轮由 user 消息触发（锚点=该 user 消息下标）。挂轮末而不是「首条
 * assistant 回复」：折叠轮（Codex 风格）里轮中过程消息整体不挂载，挂首条
 * 会随过程一起被收起，撤销入口就没了。
 * 本会话工作模式为「工作」时不渲染（Git 管理整体隐藏，见顶栏模式切换器）；
 * 影子仓库快照链路不动，切回编码模式时历史卡片可恢复。
 */
export const MessageCheckpoint: FC = () => {
  // 会话键归一：mainThreadId 对新建线程是草稿 id，检查点条目按 sessionId 记账
  const threadId = useMainSessionId();
  const appMode = useThreadAppMode(threadId);
  const entries = useRunCheckpoints(threadId ?? undefined);
  // 选择器只回 "packed\u0000anchorUserId"（引用稳定）。非轮末/非 assistant 为
  // 空串；running 不在 selector 拦——running 轮是否渲染由下方「本轮是否已有
  // 检查点条目」判定。
  const anchorGate = useAuiState((s) => {
    if (s.message.role !== "assistant") return "";
    const packed = packTurnSlot(s.thread.messages, String(s.message.id));
    const slot = parseTurnSlot(packed);
    if (!slot || !slot.isTurnEnd) return "";
    return `${packed}\u0000${turnAnchorUserId(s.thread.messages, slot)}`;
  });
  const { slot, anchorUserId } = useMemo(() => {
    if (!anchorGate) return { slot: null, anchorUserId: "" };
    const sep = anchorGate.lastIndexOf("\u0000");
    // packed 不含 \u0000（id 是 pi-msg:N / flags），lastIndexOf 切分安全
    return {
      slot: parseTurnSlot(anchorGate.slice(0, sep)),
      anchorUserId: anchorGate.slice(sep + 1),
    };
  }, [anchorGate]);
  const anchorUserIndex = slot?.anchorUserIndex ?? -1;
  if (appMode !== "code") return null;
  if (!threadId || !slot || anchorUserIndex < 0) return null;
  // 锚点匹配：稳定 id（pi-msg:<seq>）优先，跨 compaction/截断等列表变化不漂移；
  // 任一侧没有 id（老条目/未落盘行）回落渲染下标
  const mine = entries.filter((e) =>
    anchorUserId && e.anchorMessageId
      ? e.anchorMessageId === anchorUserId
      : e.anchorIndex === anchorUserIndex,
  );
  if (mine.length === 0) return null;
  // 轮在跑时只认稳定 id 命中（= 本轮确实结算过至少一段 run）。这样 goal
  // 续跑等下一条 assistant 成为新轮末时卡片直接跟过去，不再收卡/重现（闪现）；
  // Question 挂起、委派收敛这类从未结算的轮没有条目，仍不渲染。legacy 下标
  // 条目在 running 轮上不可信（可能漂移命中），等轮结束再显示。
  if (
    slot.turnRunning &&
    !(anchorUserId && mine.some((e) => e.anchorMessageId === anchorUserId))
  ) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-col gap-2 my-3">
      {mine.map((e) => (
        <CheckpointCardEntry key={e.hash} entry={e} threadId={threadId} />
      ))}
    </div>
  );
};

/** 兜底尾：锚点未知的条目（刷新重挂后补结算等）渲染在消息列表末尾；工作模式下不渲染 */
export const CheckpointTail: FC = () => {
  // 会话键归一：mainThreadId 对新建线程是草稿 id，检查点条目按 sessionId 记账
  const threadId = useMainSessionId();
  const appMode = useThreadAppMode(threadId);
  const entries = useRunCheckpoints(threadId ?? undefined);
  // 轮次仍在跑（Question 挂起/委派收敛）时不渲染：与 MessageCheckpoint 同口径，
  // 防止运行中把兜底卡顶到流尾
  const isRunning = useAuiState((s) => s.thread.isRunning);
  if (appMode !== "code") return null;
  if (!threadId || isRunning) return null;
  const orphans = entries.filter((e) => e.anchorIndex === null);
  if (orphans.length === 0) return null;
  return (
    <div className="mx-auto mt-2 flex w-full max-w-(--thread-max-width) flex-col gap-2 px-2">
      {orphans.map((e) => (
        <CheckpointCardEntry key={e.hash} entry={e} threadId={threadId} />
      ))}
    </div>
  );
};
