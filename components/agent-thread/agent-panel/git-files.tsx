"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileCodeIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { FileDiffContentsLoader } from "@pierre/diffs/react";
import { scrollIntoScroller } from "@/lib/scroll";
import {
  gitDiff,
  gitShow,
  gitWorktreeRead,
  type GitDiffFile,
  type GitDiffResult,
} from "@/lib/git";
import { onGitChanged } from "@/lib/git-status";
import { pathMatches } from "@/lib/tool-panel";
import { cn } from "@/lib/utils";
import { PanelPatchDiff } from "@/components/code/panel-diff";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileTypeIcon } from "./file-type-icon";

/**
 * 审查标签的真 diff 视图（M1）：数据源从"agent 工具流水派生"换成
 * `git diff HEAD`（含工作区未暂存 + 已暂存 + 未跟踪合成），因此 bash/编辑器
 * 造成的改动同样可见。非 git 仓库时由 tab-registry 回退到派生视图。
 * 布局对齐 ZCode 审查面板：平铺文件行（无卡片间隙）、行头滚动吸顶、
 * diff 全高渲染随面板整体滚动。
 */

export function splitPath(path: string): { dir: string; base: string } {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

/**
 * git 状态 → 左缘彩色圆点（VS Code 文件装饰风格）：绿=新增/未跟踪、
 * 黄=修改、红=删除、紫=改名；checkpoint-bar 与 git-view 共用。
 */
const STATUS_DOT: Record<string, string> = {
  A: "bg-emerald-500",
  U: "bg-emerald-500",
  "?": "bg-emerald-500",
  M: "bg-amber-500",
  D: "bg-rose-500",
  R: "bg-violet-500",
  C: "bg-violet-500",
};

export const StatusDot: FC<{
  status: string;
  className?: string;
  title?: string;
}> = ({ status, className, title }) => (
  <span
    aria-hidden
    title={title}
    className={cn("inline-grid size-4 shrink-0 place-items-center", className)}
  >
    <span className={cn("size-1.5 rounded-full", STATUS_DOT[status] ?? "bg-muted-foreground")} />
  </span>
);

const GitFileCard: FC<{
  f: GitDiffFile;
  loadFiles?: FileDiffContentsLoader;
  focused?: boolean;
}> = ({ f, loadFiles, focused }) => {
  const [open, setOpen] = useState(false);
  // 展开态与 diff 挂载分两步：点击先即时反馈行头，重 DOM 放到下一帧的
  // transition 里建，避免"点了没反应 → 突然卡住"的观感
  const [diffMounted, setDiffMounted] = useState(false);
  const { dir, base } = splitPath(f.path);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      setDiffMounted(false);
      return;
    }
    setOpen(true);
    requestAnimationFrame(() => startTransition(() => setDiffMounted(true)));
  };

  // 消息里「编辑/写入」行点击定位进来：自动展开 diff 并滚到视野中央。
  // 吸顶行头会让出一行高度，block:"start" 比居中更贴目标位置。
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    // 只滚面板自身的滚动容器：scrollIntoView 会连 overflow-hidden 的外层壳
    // 一起滚，导致整个应用被抬起
    scrollIntoScroller(rootRef.current, "start");
    requestAnimationFrame(() => startTransition(() => setDiffMounted(true)));
  }, [focused]);

  return (
    <div ref={rootRef}>
      {/* 吸顶行头：滚动时钉在面板顶部，下一个文件的行头自然把它顶走 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "sticky top-0  z-10 flex w-full items-center gap-2 px-3 py-1.5 text-left",
          open ? "bg-muted " : "bg-background hover:bg-muted/40 ",
        )}
      >
        <FileTypeIcon path={f.path} />
        <span className="shrink-0 truncate text-[13px] font-medium text-foreground/90">
          {base}
        </span>
        {dir ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground/70">
            {dir}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
          {f.binary ? (
            <span className="text-muted-foreground">二进制</span>
          ) : (
            <>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{f.added}
              </span>
              <span className="text-rose-500 dark:text-rose-400">
                -{f.removed}
              </span>
            </>
          )}
          {open ? (
            <ChevronUpIcon className="text-muted-foreground size-4" />
          ) : (
            <ChevronDownIcon className="text-muted-foreground size-4" />
          )}
        </span>
      </button>
      {open ? (
        f.binary || f.patch.length === 0 ? (
          <div className="px-3 py-2  font-mono text-[11px] text-muted-foreground">
            {f.binary ? "（二进制文件，无文本 diff）" : "（diff 超出体积上限，未展开）"}
          </div>
        ) : diffMounted ? (
          <PanelPatchDiff patch={f.patch} loadFiles={loadFiles} />
        ) : null
      ) : null}
    </div>
  );
};

/** 头部暂存范围筛选（checkpoint 模式不适用） */
type DiffScope = "unstaged" | "staged" | "all";

const SCOPE_LABELS: Record<DiffScope, string> = {
  unstaged: "未暂存",
  staged: "已暂存",
  all: "全部改动",
};

export const GitReview: FC<{
  cwd: string;
  checkpoint?: string;
  /** 消息「编辑/写入」行定位进来的文件路径（绝对/仓库相对都认） */
  focusPath?: string;
}> = ({ cwd, checkpoint, focusPath }) => {
  // 带定位进来时默认「全部改动」，避免目标文件恰好不在未暂存过滤里
  const [scope, setScope] = useState<DiffScope>(
    focusPath && !checkpoint ? "all" : "unstaged",
  );
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    // checkpoint = 检查点卡片定向过来：显示"本回合改动 vs 运行前快照"
    gitDiff(cwd, checkpoint ? { checkpoint } : undefined)
      .then((d) => {
        if (alive) setDiff(d);
      })
      .catch(() => {
        if (alive) setDiff(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, checkpoint]);

  useEffect(() => {
    const off = load();
    const unsub = onGitChanged((changed) => {
      if (changed === cwd) load();
    });
    return () => {
      off();
      unsub();
    };
  }, [load, cwd]);

  // "N 行未改动"分隔条点击展开的水合来源：patch 只带 3 行上下文，
  // 展开到全文时才现取两侧内容——旧侧从 diff 基线（HEAD 或检查点快照），
  // 新侧从工作区文件。取不到/二进制/超限则抛错，库内部吞掉并保持折叠。
  const loadFiles = useCallback<FileDiffContentsLoader>(
    async (meta) => {
      const baseRef = checkpoint ?? "HEAD";
      const newPath = meta.name;
      const oldPath = meta.prevName ?? meta.name;
      const [oldRes, newRes] = await Promise.all([
        gitShow(cwd, baseRef, oldPath),
        gitWorktreeRead(cwd, newPath),
      ]);
      if (
        !oldRes ||
        !newRes ||
        oldRes.binary ||
        newRes.binary ||
        oldRes.truncated ||
        newRes.truncated
      ) {
        throw new Error("diff-files-unavailable");
      }
      return {
        oldFile: { name: oldPath, contents: oldRes.content },
        newFile: { name: newPath, contents: newRes.content },
      };
    },
    [cwd, checkpoint],
  );

  const all = diff?.files ?? [];
  const files = checkpoint
    ? all
    : scope === "all"
      ? all
      : all.filter((f) => (scope === "staged" ? f.staged : !f.staged));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：暂存范围筛选 / 刷新 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        {checkpoint ? (
          <span className="text-[13px] font-medium text-foreground/80">
            检查点改动
          </span>
        ) : (
          <Select
            value={scope}
            onValueChange={(v) => setScope(v as DiffScope)}
          >
            <SelectTrigger size="sm" className="w-auto min-w-[92px] gap-1.5 border-border/60 px-2 text-xs shadow-none">
              {/* Base UI 的 SelectValue 默认回显原始 value，显式渲染中文文案 */}
              <SelectValue>{SCOPE_LABELS[scope]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unstaged">未暂存</SelectItem>
              <SelectItem value="staged">已暂存</SelectItem>
              <SelectItem value="all">全部改动</SelectItem>
            </SelectContent>
          </Select>
        )}
        <button
          type="button"
          onClick={() => load()}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2 pt-0">
        {diff && diff.truncated ? (
          <div className="mb-1 flex items-center gap-1.5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            改动过多，diff 已部分截断
          </div>
        ) : null}
        {files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground/60">
            <FileCodeIcon className="size-6" />
            <p>
              {loading
                ? "读取 git diff…"
                : checkpoint
                  ? "该检查点已撤销或没有改动"
                  : all.length > 0
                    ? "该范围内没有文件"
                    : "工作区干净,没有未提交的改动"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {files.map((f) => (
              <GitFileCard
                key={f.path}
                f={f}
                loadFiles={loadFiles}
                focused={!!focusPath && pathMatches(focusPath, f.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
