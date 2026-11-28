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
import { getLocale, useT } from "@/lib/i18n";

type ArchivedItem = {
  id: string;
  /** pi sessionId；恢复登记（保留期重置）以此为准，未落盘会话不存在 */
  remoteId: string | undefined;
  title: string;
  /** 有 cwd = 项目会话；空 = 任务会话 */
  cwd: string;
  lastMessageAt: number;
};

/** 归档管理页：上方是自动归档设置卡片；下方列表卡片列出全部归档会话
 *  （版式对齐 SSH 主机/Webhooks 等设置页：muted 容器 + 行式条目；固定上限
 *  高度 + 内部滚动，防归档条目无限增长撑爆页面），
 *  恢复后侧栏列表实时同步（同一 aui 状态源）。
 *  支持多选批量删除：逐条顺序删（N 次 delete_session），带进度与失败保留选中。 */
export const ArchiveSettings: FC = () => {
  const t = useT();
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
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

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
        const cwd = (item.remoteId && piSessionCwdMap.get(item.remoteId)) || "";
        return {
          id,
          remoteId: item.remoteId,
          title: item.title || t("settings.archive.newSession"),
          cwd,
          lastMessageAt: item.lastMessageAt?.getTime() ?? 0,
        };
      })
      .filter((v): v is ArchivedItem => v !== null)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [archivedThreadIds, summariesVersion, threadItems, t]);

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
    setSelected(
      allSelected ? new Set() : new Set(items.map((item) => item.id)),
    );
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
      toast.success(t("settings.archive.deleted", { count: ok }));
      exitSelectMode();
    } else {
      // 失败项留在选中态，还在批量模式里，方便直接重试
      setSelected(failed);
      toast.error(
        t("settings.archive.deletePartial", {
          ok,
          total: targets.length,
          failed: failed.size,
        }),
      );
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.archive.title")}
          </h1>
        </div>

        {/* 自动归档：偏好存 localStorage（lib/pi/pi-auto-archive），执行器是
            侧栏常驻的 ThreadAutoArchiver（启动后 + 每 24h 静默一轮） */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.archive.autoArchive")}
          </h2>
          <div className="bg-muted/50 mt-1 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.archive.autoArchiveOldTasks")}
              desc={t("settings.archive.autoArchiveOldTasksDesc")}
            >
              <Switch
                checked={autoArchive.enabled}
                onCheckedChange={setAutoArchiveEnabled}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.archive.retention")}
              desc={t("settings.archive.retentionDesc")}
            >
              <Select
                value={String(autoArchive.retentionDays)}
                onValueChange={(v) => setAutoArchiveRetentionDays(Number(v))}
                disabled={!autoArchive.enabled}
                items={AUTO_ARCHIVE_RETENTION_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: t("settings.archive.retentionDays", { days: o.value }),
                }))}
              >
                <SelectTrigger size="sm" className="w-44 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTO_ARCHIVE_RETENTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={String(o.value)}>
                      {t("settings.archive.retentionDays", { days: o.value })}
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
              {items.length > 0
                ? t("settings.archive.archivedSessionsCount", {
                    count: items.length,
                  })
                : t("settings.archive.archivedSessions")}
            </h2>
            {items.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                {selectMode ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-ui leading-5"
                      disabled={busy}
                      onClick={toggleAll}
                    >
                      {allSelected
                        ? t("settings.archive.deselectAll")
                        : t("settings.archive.selectAll")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-7 px-2 text-ui leading-5"
                      disabled={busy}
                      onClick={exitSelectMode}
                    >
                      {t("settings.archive.exitBatch")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 px-2 text-ui leading-5"
                      disabled={busy || selectedItems.length === 0}
                      onClick={() => setConfirmOpen(true)}
                    >
                      {busy ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                      {busy
                        ? t("settings.archive.deletingProgress", {
                            done: progress?.done ?? 0,
                            total: progress?.total ?? 0,
                          })
                        : selectedItems.length > 0
                          ? t("settings.archive.batchDeleteCount", {
                              count: selectedItems.length,
                            })
                          : t("settings.archive.batchDelete")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-7 gap-1.5 px-2 text-ui leading-5"
                    onClick={() => setSelectMode(true)}
                  >
                    <ListChecksIcon className="size-3.5" />
                    {t("settings.archive.batchMode")}
                  </Button>
                )}
              </div>
            )}
          </div>

          {items.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed p-10 text-sm">
              <ArchiveIcon className="size-4" />
              {t("settings.archive.emptyHint")}
            </div>
          ) : (
            <div className="bg-muted/50 flex max-h-[49vh] flex-col gap-1 overflow-y-auto rounded-2xl p-2">
              {items.map((item) => (
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
            <AlertDialogTitle>
              {t("settings.archive.confirmTitle", {
                count: selectedItems.length,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.archive.confirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">
              {t("settings.archive.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                setConfirmOpen(false);
                void deleteSelected();
              }}
            >
              {t("settings.archive.delete")}
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
}> = ({
  item,
  selectMode,
  selected,
  disabled,
  onToggle,
  onRestore,
  onDelete,
}) => {
  const t = useT();
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
        "flex items-center justify-between gap-3 rounded-xl px-3 py-2 transition-colors",
        selectMode && "cursor-pointer hover:bg-background/60",
        selectMode && selected && "bg-background",
      )}
      onClick={selectMode && !disabled ? onToggle : undefined}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {selectMode ? (
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
              aria-label={t("settings.archive.selectAria", {
                title: item.title,
              })}
            />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium" title={item.title}>
              {item.title}
            </span>
            {item.cwd ? (
              <span
                className="text-muted-foreground flex shrink-0 items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-ui leading-5"
                title={item.cwd}
              >
                <FolderIcon className="size-3 shrink-0" />
                <span className="max-w-40 truncate">{pathBasename(item.cwd)}</span>
              </span>
            ) : (
              <span className="text-muted-foreground flex shrink-0 items-center gap-1 rounded-md bg-background px-1.5 py-0.5 text-ui leading-5">
                <MessageSquareIcon className="size-3 shrink-0" />
                {t("settings.archive.task")}
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 text-ui leading-5 tabular-nums">
            {item.lastMessageAt > 0 ? formatTime(item.lastMessageAt) : "—"}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
        >
          <ArchiveRestoreIcon className="size-3.5" />
          {t("settings.archive.restore")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            confirming &&
              "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          )}
          onClick={(e) => {
            e.stopPropagation();
            del();
          }}
        >
          <Trash2Icon className="size-3.5" />
          {confirming
            ? t("settings.archive.confirmDelete")
            : t("settings.archive.delete")}
        </Button>
      </div>
    </div>
  );
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const locale = getLocale() === "zh" ? "zh-CN" : "en-US";
  const date = d.toLocaleDateString(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
  });
  return `${date} ${d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};
