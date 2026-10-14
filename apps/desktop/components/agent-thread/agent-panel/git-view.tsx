"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import {
  CheckIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitGraphIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
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
} from "@/lib/git/git";
import { onGitChanged, refreshGitStatus, useGitStatus } from "@/lib/git/git-status";
import { cn } from "@/lib/utils";
import { PanelSection } from "./section-shell";
import { splitPath, StatusDot } from "./git-files";
import { FileTypeIcon } from "./file-type-icon";
import { GitGraph } from "./git-graph";

/**
 * Git 标签（git 集成 M3）：暂存勾选 → 提交 → IDEA 风格提交图谱 → 分支切换/新建。
 * 全部走 lib/git 的桌面端命令；Rust 写命令成功即回推 "git-changed"，
 * 状态缓存随之刷新（这里无需手动重拉 status）。
 */

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
              className="hover:bg-muted flex min-w-0 max-w-[10rem] items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-foreground/90 transition-colors"
              title={current ?? "未知分支"}
            >
              <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="block truncate">{current ?? "…"}</span>
              <ChevronDownIcon className="text-muted-foreground/60 size-3 shrink-0" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
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
                  className={cn("size-3.5 shrink-0", b.current ? "opacity-100" : "opacity-0")}
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
              if (e.key === "Enter" && name.trim()) void checkout(name.trim(), true);
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

export const GitView: FC<{ cwd: string }> = ({ cwd }) => {
  const { status } = useGitStatus(cwd);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // 本地刷新钮
  // 滚动容器 ref：PanelSection 的吸顶判定以它为 IntersectionObserver root
  const scrollerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    gitBranches(cwd)
      .then((b) => setBranches(b))
      .catch(() => {});
  }, [cwd]);

  useEffect(() => {
    load();
    return onGitChanged((changed) => {
      if (changed === cwd) load();
    });
  }, [load, tick, cwd]);

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

  const commit = async () => {
    const msg = message.trim();
    if (!msg) return;
    setBusy(true);
    setError(null);
    try {
      await gitCommit(cwd, msg);
      setMessage("");
      refreshGitStatus(cwd);
    } catch (err) {
      const s = String(err);
      setError(s.includes("nothing to commit") ? "没有已暂存的变更可提交" : `提交失败：${s}`);
    } finally {
      setBusy(false);
    }
  };

  const files = status?.files ?? [];
  const stagedCount = files.filter((f) => f.staged).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="min-w-0 truncate tabular-nums">
          {files.length > 0 ? `${files.length} 个未提交变更` : "工作区干净"}
        </span>
        {/* 分支切换收进顶栏：贴在刷新钮左侧，滚动区不再放独立分支卡片 */}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
          <BranchSwitcher
            cwd={cwd}
            current={status?.branch ?? branches?.current ?? null}
            branches={branches}
            onBusy={setBusy}
            onError={setError}
          />
          <button
            type="button"
            aria-label="刷新"
            title="刷新"
            onClick={() => {
              refreshGitStatus(cwd);
              setTick((t) => t + 1);
            }}
            className="hover:bg-muted hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors"
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* 滚动容器自身不带内边距：padding 放在随内容滚动的包裹层，
          sticky 头才能贴到滚动口上沿（容器带 pt 时那 12px 会永远隔在中间）。
          IO root / -mx-3 撑开宽度都以这层 px-3 = 12px 为约定。 */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 p-3">
          {error ? (
            <div className="text-destructive bg-destructive/5 flex items-start gap-1.5 rounded-xl border border-destructive/30 px-2.5 py-2 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-all">{error}</span>
            </div>
          ) : null}

          <PanelSection
            scrollRoot={scrollerRef}
            icon={<CheckSquareIcon className="size-4" />}
            title="变更"
            trailing={
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {stagedCount}/{files.length} 已暂存
              </span>
            }
          >
            {files.length === 0 ? (
              <div className="text-muted-foreground/60 px-1 py-3 text-center text-xs">
                没有未提交的变更
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 px-1 pb-0.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stageAll(true)}
                    className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    全部暂存
                  </button>
                  <span className="text-muted-foreground/40">·</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stageAll(false)}
                    className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    全部取消暂存
                  </button>
                </div>
                {files.map((f) => {
                  const { dir, base } = splitPath(f.path);
                  return (
                    <button
                      key={`${f.staged ? "s" : "u"}:${f.path}`}
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleStage(f.path, !f.staged)}
                      className="hover:bg-muted/40 group flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left"
                      title={f.staged ? "点击取消暂存" : "点击暂存"}
                    >
                      {f.staged ? (
                        <CheckSquareIcon className="text-foreground size-4 shrink-0" />
                      ) : (
                        <SquareIcon className="text-muted-foreground/60 group-hover:text-muted-foreground size-4 shrink-0" />
                      )}
                      <StatusDot status={f.status} title={f.staged ? "已暂存" : "未暂存"} />
                      <FileTypeIcon path={f.path} />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                        {base}
                        {dir ? (
                          <span className="text-muted-foreground/70"> {dir}/</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {/* 提交框紧跟变更清单：勾完即写即提 */}
                <div className="border-border/60 mt-1 flex flex-col gap-1.5 border-t pt-2">
                  <Textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="提交信息（首个动词短语即可）"
                    rows={2}
                    className="min-h-0 resize-none text-xs"
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void commit();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 self-end gap-1.5 px-3 text-xs"
                    disabled={busy || !message.trim() || stagedCount === 0}
                    title={stagedCount === 0 ? "先勾选要提交的文件" : "⌘/Ctrl+Enter"}
                    onClick={() => void commit()}
                  >
                    {busy ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <GitCommitHorizontalIcon className="size-3" />
                    )}
                    提交 {stagedCount > 0 ? `(${stagedCount})` : ""}
                  </Button>
                </div>
              </div>
            )}
          </PanelSection>

          <PanelSection
            scrollRoot={scrollerRef}
            icon={<GitGraphIcon className="size-4" />}
            title="Git 图谱"
            trailing={
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {status?.branch ?? "HEAD"}
              </span>
            }
          >
            <GitGraph cwd={cwd} tick={tick} />
          </PanelSection>
        </div>
      </div>
    </div>
  );
};

