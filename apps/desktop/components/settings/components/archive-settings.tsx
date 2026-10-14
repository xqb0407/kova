"use client";

import { useMemo, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ArchiveRestoreIcon,
  ArchiveIcon,
  FolderIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { piSessionCwdMap } from "@/lib/pi/pi-thread-adapter";
import { pathBasename } from "@/lib/workspace/workspace-store";

type ArchivedItem = {
  id: string;
  title: string;
  /** 有 cwd = 项目会话；空 = 任务会话 */
  cwd: string;
  lastMessageAt: number;
};

/** 归档管理页：列出全部归档会话，恢复后侧栏列表实时同步（同一 aui 状态源）。
 *  支持多选批量删除：逐条顺序删（N 次 delete_session），带进度与失败保留选中。 */
export const ArchiveSettings: FC = () => {
  const aui = useAui();
  const archivedThreadIds = useAuiState((s) => s.threads.archivedThreadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 批量模式：默认不显示勾选框，点「批量操作」才进入（退出时清空选择） */
  const [selectMode, setSelectMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const items = useMemo<ArchivedItem[]>(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    return archivedThreadIds
      .map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        const cwd =
          (item.remoteId && piSessionCwdMap.get(item.remoteId)) || "";
        return {
          id,
          title: item.title || "新会话",
          cwd,
          lastMessageAt: item.lastMessageAt?.getTime() ?? 0,
        };
      })
      .filter((v): v is ArchivedItem => v !== null)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [archivedThreadIds, threadItems]);

  const busy = progress !== null;
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  /** 批量删除：顺序执行（每条都是一次 delete_session），失败项保留选中便于重试 */
  const deleteSelected = async () => {
    const targets = selectedItems;
    if (targets.length === 0 || busy) return;
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    const failed = new Set<string>();
    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      try {
        await aui.threads.item({ id: item.id }).delete();
        ok += 1;
      } catch {
        failed.add(item.id);
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    if (failed.size === 0) {
      toast.success(`已删除 ${ok} 个会话`);
      exitSelectMode();
    } else {
      // 失败项留在选中态，还在批量模式里，方便直接重试
      setSelected(failed);
      toast.error(`成功 ${ok}/${targets.length}，失败 ${failed.size} 个（已保留选中）`);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">归档</h1>
          <p className="text-muted-foreground text-sm">
            归档的会话（含整个项目批量归档）不在侧栏展示，这里集中查看、恢复或删除。
          </p>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold">
              已归档会话{items.length > 0 ? ` · ${items.length}` : ""}
            </h2>
            {items.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                {selectMode ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={toggleAll}
                    >
                      {allSelected ? "取消全选" : "全选"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={exitSelectMode}
                    >
                      退出批量
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 px-2 text-xs"
                      disabled={busy || selectedItems.length === 0}
                      onClick={() => setConfirmOpen(true)}
                    >
                      {busy ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                      {busy
                        ? `删除中 ${progress?.done ?? 0}/${progress?.total ?? 0}`
                        : `删除选中${selectedItems.length > 0 ? ` (${selectedItems.length})` : ""}`}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setSelectMode(true)}
                  >
                    <ListChecksIcon className="size-3.5" />
                    批量操作
                  </Button>
                )}
              </div>
            )}
          </div>

          {items.length === 0 ? (
            <div className="bg-muted/50 text-muted-foreground flex min-h-24 items-center justify-center gap-2 rounded-2xl text-sm">
              <ArchiveIcon className="size-4" />
              暂无归档会话，侧栏会话/项目菜单的「Archive / 归档项目」可移到这里
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {items.map((item) => (
                <ArchivedRow
                  key={item.id}
                  item={item}
                  selectMode={selectMode}
                  selected={selected.has(item.id)}
                  disabled={busy}
                  onToggle={() => toggleOne(item.id)}
                  onRestore={() =>
                    aui.threads.item({ id: item.id }).unarchive()
                  }
                  onDelete={() => aui.threads.item({ id: item.id }).delete()}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 批量删除确认：不可恢复，用弹窗而不是行内的两步确认 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {selectedItems.length} 个已归档会话？</AlertDialogTitle>
            <AlertDialogDescription>
              会话记录与转录文件会被一并删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                setConfirmOpen(false);
                void deleteSelected();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const ArchivedRow: FC<{
  item: ArchivedItem;
  /** 批量模式才渲染勾选框；点行身也能勾（批量模式下） */
  selectMode: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onDelete: () => void;
}> = ({ item, selectMode, selected, disabled, onToggle, onRestore, onDelete }) => {
  const [confirming, setConfirming] = useState(false);

  const del = () => {
    // 两步确认：首次点击进入确认态，3 秒不点自动退出
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onDelete();
  };

  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2",
        selectMode && "cursor-pointer hover:bg-muted/60",
        selectMode && selected && "bg-muted/60",
      )}
      onClick={selectMode && !disabled ? onToggle : undefined}
    >
      {selectMode && (
        // 勾选框自己也要响应点击；包一层挡住冒泡，否则会连着行身 onClick 再 toggle 一次
        // （两次抵消 = 点勾选框没反应，只有点行身才有反应）
        <span
          className="flex shrink-0 items-center"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            disabled={disabled}
            onCheckedChange={onToggle}
            aria-label={`选择 ${item.title}`}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {item.cwd ? (
            <>
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate" title={item.cwd}>
                {pathBasename(item.cwd)}
              </span>
            </>
          ) : (
            <>
              <MessageSquareIcon className="size-3 shrink-0" />
              <span>任务</span>
            </>
          )}
          {item.lastMessageAt > 0 && (
            <span className="shrink-0">· {formatTime(item.lastMessageAt)}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          <ArchiveRestoreIcon className="size-3.5" />
          恢复
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={confirming
            ? "h-7 gap-1.5 bg-destructive/10 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:text-destructive h-7 gap-1.5 px-2 text-xs hover:bg-destructive/10"}
          onClick={(e) => {
            e.stopPropagation();
            del();
          }}
        >
          <Trash2Icon className="size-3.5" />
          {confirming ? "确认删除" : "删除"}
        </Button>
      </div>
    </div>
  );
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
  });
  return `${date} ${d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};
