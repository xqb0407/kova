"use client";

import { useMemo, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ArchiveRestoreIcon,
  ArchiveIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/custom-ui/setting-row";
import {
  AUTO_ARCHIVE_RETENTION_OPTIONS,
  recordSessionRestored,
  setAutoArchiveEnabled,
  setAutoArchiveRetentionDays,
  useAutoArchivePrefs,
} from "@/lib/pi/pi-auto-archive";
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
import {
  piSessionCwdMap,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { pathBasename } from "@/lib/workspace/workspace-store";

type ArchivedItem = {
  id: string;
  /** pi sessionId；恢复登记（保留期重置）以此为准，未落盘会话不存在 */
  remoteId: string | undefined;
  title: string;
  /** 有 cwd = 项目会话；空 = 任务会话 */
  cwd: string;
  lastMessageAt: number;
};

/** 归档列表分页：每页条数。列表另有固定上限高度 + 内部滚动（表头吸顶），
 *  归档再多页面也不无限变长 */
const ARCHIVE_PAGE_SIZE = 20;

/** 归档管理页：上方是自动归档设置卡片；下方表格列出全部归档会话
 *  （固定上限高度 + 内部滚动 + 表头吸顶 + 分页，防归档条目无限增长撑爆
 *  页面），恢复后侧栏列表实时同步（同一 aui 状态源）。
 *  支持多选批量删除：逐条顺序删（N 次 delete_session），带进度与失败保留选中。 */
export const ArchiveSettings: FC = () => {
  const aui = useAui();
  const archivedThreadIds = useAuiState((s) => s.threads.archivedThreadIds);
  // 内容稳定切片：数组身份随发布重建时不让本页跟着重算/重渲
  const threadItems = useThreadItems();
  // cwd 来自 piSessionCwdMap（不在 threadItems 内容里）：摘要落库的版本号
  // 参与重算，cwd 更新后归档行才会跟着变
  const summariesVersion = useSessionPrefsVersion();
  const autoArchive = useAutoArchivePrefs();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 批量模式：默认不显示勾选框，点「批量操作」才进入（退出时清空选择） */
  const [selectMode, setSelectMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  /** 归档列表当前页（0 起）。items 收缩后越界由 safePage 钳制，无需手动重置 */
  const [page, setPage] = useState(0);

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
          remoteId: item.remoteId,
          title: item.title || "新会话",
          cwd,
          lastMessageAt: item.lastMessageAt?.getTime() ?? 0,
        };
      })
      .filter((v): v is ArchivedItem => v !== null)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [archivedThreadIds, summariesVersion, threadItems]);

  const busy = progress !== null;
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  const pageCount = Math.max(1, Math.ceil(items.length / ARCHIVE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = items.slice(
    safePage * ARCHIVE_PAGE_SIZE,
    (safePage + 1) * ARCHIVE_PAGE_SIZE,
  );

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
          <p className="text-muted-foreground text-sm leading-relaxed">
            归档的会话（含整个项目批量归档）不在侧栏展示，这里集中查看、恢复或删除。
          </p>
        </div>

        {/* 自动归档：偏好存 localStorage（lib/pi/pi-auto-archive），执行器是
            侧栏常驻的 ThreadAutoArchiver（启动后 + 每 24h 静默一轮） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">自动归档</h2>
          <div className="bg-muted/50 mt-1 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="自动归档旧任务"
              desc="定时扫描全部会话，将已完成、无未读、未置顶且超过保留期的任务自动归档。"
            >
              <Switch
                checked={autoArchive.enabled}
                onCheckedChange={setAutoArchiveEnabled}
              />
            </SettingRow>
            <SettingRow
              label="归档保留时长"
              desc="任务最后更新（或最近恢复）时间早于该时长后，才会进入自动归档候选。"
            >
              <Select
                value={String(autoArchive.retentionDays)}
                onValueChange={(v) =>
                  setAutoArchiveRetentionDays(Number(v))
                }
                disabled={!autoArchive.enabled}
                items={AUTO_ARCHIVE_RETENTION_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTO_ARCHIVE_RETENTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={String(o.value)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </section>

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
                      className="text-muted-foreground h-7 px-2 text-[13px] leading-5"
                      disabled={busy}
                      onClick={toggleAll}
                    >
                      {allSelected ? "取消全选" : "全选"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-[13px] leading-5"
                      disabled={busy}
                      onClick={exitSelectMode}
                    >
                      退出批量
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 px-2 text-[13px] leading-5"
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
                    className="text-muted-foreground h-7 gap-1.5 px-2 text-[13px] leading-5"
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
            <div className="flex flex-col rounded-2xl border border-border/50 ">
              {/* 固定上限高度 + 内部滚动，表头吸顶；配合分页，归档条目再多
                  页面高度也稳定。未用 ui/table：其内置 overflow-x-auto 包裹
                  层会截胡 sticky 表头，这里直接写同构表格。
                  table-fixed 显式列宽：标题列吃剩余宽度，归属/时间/操作贴内容
                  排布，中间不留随机空洞（auto 布局会把富余塞进列间距，很丑） */}
              <div className="max-h-[50vh] overflow-y-auto rounded-xl">
                <table className="w-full table-fixed caption-bottom text-sm">
                  <thead>
                    <tr className="border-b border-border/40">
                      {selectMode ? (
                        <th className="sticky top-0 z-10 w-10 bg-muted/95 backdrop-blur-sm" />
                      ) : null}
                      <th className="sticky top-0 z-10 h-9 bg-muted/95 px-3 text-left text-[13px] leading-5 font-medium text-muted-foreground backdrop-blur-sm">
                        会话
                      </th>
                      <th className="sticky top-0 z-10 w-40 bg-muted/95 px-2 text-left text-[13px] leading-5 font-medium text-muted-foreground backdrop-blur-sm">
                        归属
                      </th>
                      <th className="sticky top-0 z-10 w-28 bg-muted/95 px-2 text-right text-[13px] leading-5 font-medium text-muted-foreground backdrop-blur-sm">
                        最后更新
                      </th>
                      <th className="sticky top-0 z-10 w-44 bg-muted/95 py-2 pr-3 text-right text-[13px] leading-5 font-medium text-muted-foreground backdrop-blur-sm">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((item) => (
                      <ArchivedRow
                        key={item.id}
                        item={item}
                        selectMode={selectMode}
                        selected={selected.has(item.id)}
                        disabled={busy}
                        onToggle={() => toggleOne(item.id)}
                        onRestore={() => {
                          // 登记恢复时刻：自动归档的保留期从现在重新起算，
                          // 否则超期会话恢复后下一轮扫描立刻被收回
                          if (item.remoteId) recordSessionRestored(item.remoteId);
                          aui.threads.item({ id: item.id }).unarchive();
                        }}
                        onDelete={() =>
                          aui.threads.item({ id: item.id }).delete()
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 ? (
                <div className="text-muted-foreground mt-1 flex items-center justify-center gap-1 px-2 pt-1 text-[13px] leading-5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[13px] leading-5"
                    disabled={safePage === 0 || busy}
                    onClick={() => setPage(safePage - 1)}
                  >
                    <ChevronLeftIcon className="size-3.5" />
                    上一页
                  </Button>
                  <span className="min-w-16 px-2 text-center tabular-nums">
                    {safePage + 1} / {pageCount}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[13px] leading-5"
                    disabled={safePage >= pageCount - 1 || busy}
                    onClick={() => setPage(safePage + 1)}
                  >
                    下一页
                    <ChevronRightIcon className="size-3.5" />
                  </Button>
                </div>
              ) : null}
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
    <tr
      className={cn(
        "h-10 border-b border-border/30 transition-colors last:border-0 hover:bg-muted/40",
        selectMode && "cursor-pointer",
        selectMode && selected && "bg-muted/60",
      )}
      onClick={selectMode && !disabled ? onToggle : undefined}
    >
      {selectMode ? (
        <td className="w-10 py-0 pl-3 pr-0 align-middle">
          {/* 勾选框自己也要响应点击；包一层挡住冒泡，否则会连着行身 onClick 再 toggle 一次
              （两次抵消 = 点勾选框没反应，只有点行身才有反应） */}
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
        </td>
      ) : null}
      <td className={cn("truncate px-2 align-middle", !selectMode && "pl-3")}>
        <span className="block truncate" title={item.title}>
          {item.title}
        </span>
      </td>
      <td className="px-2 align-middle">
        {item.cwd ? (
          <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate" title={item.cwd}>
              {pathBasename(item.cwd)}
            </span>
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center gap-1.5 text-[13px] leading-5">
            <MessageSquareIcon className="size-3 shrink-0" />
            <span>任务</span>
          </div>
        )}
      </td>
      <td className="text-muted-foreground px-2 text-right align-middle text-[13px] leading-5 whitespace-nowrap tabular-nums">
        {item.lastMessageAt > 0 ? formatTime(item.lastMessageAt) : "—"}
      </td>
      <td className="py-0 pr-3 pl-2 align-middle">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[13px] leading-5"
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
              ? "h-6 gap-1 bg-destructive/10 px-1.5 text-[13px] leading-5 text-destructive hover:bg-destructive/15 hover:text-destructive"
              : "text-muted-foreground hover:text-destructive h-6 gap-1 px-1.5 text-[13px] leading-5 hover:bg-destructive/10"}
            onClick={(e) => {
              e.stopPropagation();
              del();
            }}
          >
            <Trash2Icon className="size-3.5" />
            {confirming ? "确认删除" : "删除"}
          </Button>
        </div>
      </td>
    </tr>
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
