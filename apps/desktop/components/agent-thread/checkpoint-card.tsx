"use client";

import { useCallback, useEffect, useState, type FC } from "react";
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
import {
  gitCheckpointRestore,
  gitErrorCode,
  gitCheckpointDiff,
  type GitDiffFile,
} from "@/lib/git/git";
import { refreshGitStatus } from "@/lib/git/git-status";
import { useAppMode } from "@/lib/pi/app-mode";
import { focusPanelTab, openPanelTab } from "@/lib/panels/panel-tabs";
import {
  clearRunCheckpoint,
  useRunCheckpoints,
  type CheckpointEntry,
} from "@/lib/pi/pi-checkpoints";
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

/** 展开区的逐文件行：状态徽标 + 路径 + 行数统计 + 审查/打开 */
const CheckpointFileRow: FC<{
  cwd: string;
  checkpoint: string;
  file: GitDiffFile;
}> = ({ cwd, checkpoint, file }) => {
  const { dir, base } = splitPath(file.path);
  const review = () => {
    // 定向打开审查标签：diff = 本回合改动 vs 运行前快照
    openPanelTab("review", { cwd, checkpoint });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openInPanel = () => {
    // 右侧「文件」标签磁盘实时模式打开（与文件树点击同构）；
    // focus:undefined 清掉复用标签可能残留的消息快照上下文
    focusPanelTab("file", { cwd, path: file.path, title: base, focus: undefined });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  return (
    <div className="group/row hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors">
      <StatusDot status={file.status} title={file.status} />
      <FileTypeIcon path={file.path} />
      <span className="min-w-0 shrink-0 font-medium text-foreground/90">
        {base}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {dir}
      </span>
      {file.binary ? (
        <span className="text-muted-foreground shrink-0 text-[11px]">
          二进制
        </span>
      ) : (
        <DiffStats added={file.added} removed={file.removed} />
      )}
      <span className="ml-1 flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-xs"
          onClick={review}
        >
          <EyeIcon className="size-3" />
          审查
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-xs"
          onClick={openInPanel}
        >
          <SquareArrowOutUpRightIcon className="size-3" />
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

  // 逐文件统计按需加载：折叠态只展示聚合数字，不额外 invoke
  const loadFiles = useCallback(async () => {
    if (files || filesLoading) return;
    setFilesLoading(true);
    try {
      const diff = await gitCheckpointDiff(cp.cwd, cp.hash);
      setFiles(diff?.files ?? []);
    } catch {
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, [cp, files, filesLoading]);

  useEffect(() => {
    if (expanded) void loadFiles();
  }, [expanded, loadFiles]);

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      await gitCheckpointRestore(cp.cwd, cp.hash);
      clearRunCheckpoint(threadId, cp.hash);
      // 撤销成功即消失；状态/审查视图经 git-changed 事件与这里的显式刷新收敛
      refreshGitStatus(cp.cwd);
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

  return (
    <div
      data-slot="aui_message-checkpoint"
      className={cn("animate-in fade-in-0 duration-200")}
    >
      <div className="bg-muted/40 border-border/60 rounded-xl border text-xs">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2.5">
          <button
            type="button"
            aria-expanded={expanded}
            className="text-muted-foreground hover:text-foreground -ml-0.5 grid size-5 shrink-0 place-items-center rounded transition-colors"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </button>
          <GitCompareArrowsIcon className="text-muted-foreground size-3.5 shrink-0" />
          <button
            type="button"
            className="text-foreground/90 hover:text-foreground shrink-0 font-medium"
            onClick={() => setExpanded((v) => !v)}
          >
            {cp.files} 个文件已更改
          </button>
          <DiffStats added={cp.added} removed={cp.removed} />

          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {confirming ? (
              <>
                <span className="text-muted-foreground">丢弃全部改动？</span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={revert}
                >
                  {busy ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : (
                    <Undo2Icon className="size-3" />
                  )}
                  确认撤销
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
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
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => setConfirming(true)}
              >
                <Undo2Icon className="size-3" />
                撤销
              </Button>
            )}
          </span>
        </div>

        {expanded ? (
          <div className="border-border/60 border-t px-1.5 py-1.5">
            {filesLoading ? (
              <div className="text-muted-foreground flex items-center gap-1.5 px-2 py-1.5">
                <Loader2Icon className="size-3 animate-spin" />
                读取文件变更…
              </div>
            ) : (files ?? []).length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5">
                读取不到逐文件变更（快照可能已过期）
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {(files ?? []).map((f) => (
                  <CheckpointFileRow
                    key={f.path}
                    cwd={cp.cwd}
                    checkpoint={cp.hash}
                    file={f}
                  />
                ))}
              </div>
            )}
            {error ? (
              <div className="text-destructive flex items-start gap-1.5 border-t border-border/60 px-2 pt-1.5 leading-relaxed">
                <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                {error}
              </div>
            ) : null}
          </div>
        ) : error ? (
          <div className="text-destructive flex items-start gap-1.5 border-t border-border/60 px-3 py-1.5 leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * 消息内挂载：渲染在 assistant-message.tsx 的产物卡之后、操作栏之上——
 * 卡片属于本轮消息本体。命中条件（与库内 MessageRoot 同款判定）：当前
 * 消息是 assistant，且前一条消息是 user（即本轮首条 assistant 回复）。
 * 工作模式下不渲染（Git 管理整体隐藏，见 general-settings「工作模式」）；
 * 影子仓库快照链路不动，切回编码模式时历史卡片可恢复。
 */
export const MessageCheckpoint: FC = () => {
  const appMode = useAppMode();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const entries = useRunCheckpoints(threadId ?? undefined);
  // 选择器只回 number|null（引用稳定）；命中判定放渲染后做
  const prevUserIndex = useAuiState((s) => {
    if (s.message.role !== "assistant") return null;
    const i = s.message.index;
    if (i <= 0) return null;
    return s.thread.messages[i - 1]?.role === "user" ? i - 1 : null;
  });
  if (appMode !== "code") return null;
  if (!threadId || prevUserIndex === null) return null;
  const mine = entries.filter((e) => e.anchorIndex === prevUserIndex);
  if (mine.length === 0) return null;
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
  const appMode = useAppMode();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const entries = useRunCheckpoints(threadId ?? undefined);
  if (appMode !== "code") return null;
  if (!threadId) return null;
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
